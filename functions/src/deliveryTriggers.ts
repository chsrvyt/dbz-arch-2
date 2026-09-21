import { onDocumentUpdated, onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { publishEvent } from './utils/events';
import { getSubscriptionAccessRecord } from './subscriptionExpiry';

/**
 * Cloud Function triggered on every updates in a canonical order document.
 * Detects order status updates and dispatches system_events for push alerts.
 */
export const onOrderStatusChange = onDocumentUpdated('orders/{orderId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();

  if (!before || !after) return;
  if (before.status === after.status) return;

  const afterStatus = after.status;
  const customerId = after.user_id;
  const orderId = event.params.orderId;

  console.log(`[onOrderStatusChange] Order ${orderId} transitioned: ${before.status} -> ${afterStatus}`);

  try {
    if (afterStatus === 'vendor_notified') {
      await publishEvent('order_confirmed', customerId, 'customer', `confirmed_${orderId}`, {
        mealType: after.meal_type || 'meal',
        slot: after.delivery_slot || 'your requested time'
      });
    } else if (afterStatus === 'vendor_preparing' || afterStatus === 'vendor_ready') {
      // markBatchReady already publishes meal_prep_started when the batch is ready, 
      // but we add this specifically for vendor_preparing if the vendor triggers it manually.
      if (afterStatus === 'vendor_preparing') {
        await publishEvent('meal_prep_started', customerId, 'customer', `prep_${orderId}`, {
          mealType: after.meal_type || 'meal'
        });
      }
    } else if (afterStatus === 'picked_up') {
      await publishEvent('meal_picked_up', customerId, 'customer', `pickup_${orderId}`, {});
    } else if (afterStatus === 'out_for_delivery') {
      await publishEvent('rider_en_route', customerId, 'customer', `enroute_${orderId}`, {});
    } else if (afterStatus === 'delivered') {
      await publishEvent('meal_delivered', customerId, 'customer', `deliv_${orderId}`, {});
    } else if (afterStatus === 'failed') {
      await publishEvent('delivery_failed', customerId, 'customer', `fail_${orderId}`, {
        reason: after.failureReason || 'Unknown error'
      });
    }
  } catch (err) {
    console.error(`[onOrderStatusChange] Failed processing push trigger for ${orderId}:`, err);
  }
});

/**
 * Callable function to update the status of a delivery.
 * Enforces role checks, state machine transitions, and triggers customer notifications.
 */
export const updateDeliveryStatus = onCall(async (request) => {
  const { data, auth } = request;
  
  // 1. Authorization
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Must be authenticated');
  }
  
  if (auth.token.role !== 'delivery_agent' && auth.token.role !== 'delivery') {
    throw new HttpsError('permission-denied', 'Must be a delivery agent to update status');
  }

  const { orderId, status, reason } = data;
  if (!orderId || !status) {
    throw new HttpsError('invalid-argument', 'Missing orderId or status');
  }

  // Whitelist the ONLY statuses a rider callable may ever set. Without this,
  // any caller could request arbitrary/canonical-but-invalid transitions
  // (e.g. DELIVERED -> ASSIGNED, or non-delivery statuses like 'cancelled').
  // The `picked_up` transition guard permits starts from 'pending'/'created',
  // which AdmissionBar's direct mark-picked-up flow relies on.
  const DELIVERY_TARGET_STATUSES = ['picked_up', 'out_for_delivery', 'delivered', 'failed_attempt'];
  if (!DELIVERY_TARGET_STATUSES.includes(String(status))) {
    throw new HttpsError(
      'invalid-argument',
      `Cannot set delivery status to "${status}" — only rider delivery statuses are allowed`
    );
  }

  const db = admin.firestore();
  const orderRef = db.collection('orders').doc(orderId);
  const deliveryRef = db.collection('deliveries').doc(orderId);
  
  // 2. State Machine Enforcement within a Transaction
  const transitionResult = await db.runTransaction(async (transaction) => {
    let docSnap = await transaction.get(orderRef);
    let isCanonicalOrder = true;
    if (!docSnap.exists) {
      docSnap = await transaction.get(deliveryRef);
      isCanonicalOrder = false;
    }
    if (!docSnap.exists) {
      throw new HttpsError('not-found', 'Delivery order not found');
    }

    const orderData = docSnap.data()!;
    
    // Validate matching agent or admin
    const isAssignedRider =
      orderData.rider_id === auth.uid ||
      orderData.driverId === auth.uid ||
      orderData.agentId === auth.uid ||
      orderData.agent_id === auth.uid ||
      auth.token?.role === 'admin' ||
      auth.token?.admin === true ||
      auth.token?.email === 'closeon.st@gmail.com';

    if (!isAssignedRider) {
      throw new HttpsError('permission-denied', 'You are not assigned to this delivery');
    }

    const currentStatus = orderData.status;

    // Validate transitions
    if (status === 'picked_up' && !['pending', 'created', 'vendor_ready', 'rider_assigned'].includes(currentStatus)) {
      throw new HttpsError('failed-precondition', `Cannot transition to picked_up from ${currentStatus}`);
    }
    if (status === 'out_for_delivery' && !['picked_up', 'vendor_ready', 'rider_assigned'].includes(currentStatus)) {
      throw new HttpsError('failed-precondition', `Cannot transition to out_for_delivery from ${currentStatus}`);
    }
    if (status === 'delivered' && !['picked_up', 'out_for_delivery'].includes(currentStatus)) {
      throw new HttpsError('failed-precondition', `Can only transition to delivered from picked_up or out_for_delivery`);
    }
    if (status === 'failed_attempt' && !['picked_up', 'out_for_delivery'].includes(currentStatus)) {
      throw new HttpsError('failed-precondition', `Can only transition to failed_attempt from picked_up or out_for_delivery`);
    }
    if (status === 'failed_attempt' && (!reason || reason.trim() === '')) {
      throw new HttpsError('invalid-argument', 'Must provide a non-empty reason when setting status to failed_attempt');
    }

    // 3. Build Update Payload
    const updatePayload: any = {
      status,
      statusHistory: admin.firestore.FieldValue.arrayUnion({
        status,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        agentId: auth.uid
      }),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (status === 'delivered') {
      updatePayload.delivered_at = admin.firestore.FieldValue.serverTimestamp();
      updatePayload.otpVerified = true;
    } else if (status === 'failed_attempt') {
      updatePayload.failedReason = reason;
      updatePayload.failure_reason = reason;
    }

    if (isCanonicalOrder) {
      transaction.update(orderRef, updatePayload);
      const logRef = db.collection('order_status_logs').doc();
      transaction.set(logRef, {
        id: logRef.id,
        order_id: orderId,
        from_status: currentStatus,
        to_status: status,
        actor: auth.uid,
        reason: reason || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      transaction.update(deliveryRef, updatePayload);
    }

    return {
      customerId: orderData.user_id || orderData.customerId,
      vendorId: orderData.vendor_id || orderData.vendorId,
      oldStatus: currentStatus,
      newStatus: status,
      reason: reason
    };
  });

  // 4. Trigger typed push notifications (outside transaction to avoid duplicate dispatches on retry)
  try {
    const { customerId, newStatus, reason } = transitionResult;

    if (newStatus === 'picked_up') {
      // Customer: meal is on its way
      await publishEvent(
        'meal_picked_up',
        customerId,
        'customer',
        `meal_picked_up_${orderId}`,
        { orderId }
      );

    } else if (newStatus === 'delivered') {
      // Customer: order delivered
      await publishEvent(
        'meal_delivered',
        customerId,
        'customer',
        `meal_delivered_${orderId}`,
        { orderId }
      );

    } else if (newStatus === 'failed_attempt') {
      // Customer: delivery attempt failed
      await publishEvent(
        'delivery_failed',
        customerId,
        'customer',
        `delivery_failed_${orderId}`,
        { orderId, reason: reason ?? '' }
      );

      // All admins: alert for manual follow-up
      const adminSnap = await db.collection('users').where('role', '==', 'admin').get();
      await Promise.all(
        adminSnap.docs.map((adminDoc) =>
          publishEvent(
            'delivery_failed',
            adminDoc.id,
            'admin',
            `delivery_failed_admin_${orderId}_${adminDoc.id}`,
            { orderId, reason: reason ?? '' }
          )
        )
      );
    }
  } catch (error) {
    // Non-fatal — a notification failure must never fail the status update
    console.error(`[updateDeliveryStatus] Push notification error for order ${orderId}:`, error);
  }
  
  // 5. Return Typed Response
  return { 
    success: true, 
    newStatus: transitionResult.newStatus, 
    message: `Successfully updated order status to ${transitionResult.newStatus}` 
  };
});

/**
 * Callable function to generate today's deliveries from active subscriptions.
 * Enforces admin role check.
 */
async function processDailyDeliveries(force: boolean = false) {
  const db = admin.firestore();
  const result = { created: 0, skipped: 0, errors: 0, details: [] as any[] };

  // Fetch active drivers to assign orders to
  const driversSnap = await db.collection('users').where('role', 'in', ['delivery', 'delivery_agent']).get();
  const driverIds = driversSnap.docs.map(d => d.id);
  let currentDriverIndex = 0;

  // 1. Fetch all active subscriptions
  const subsSnap = await db.collection('subscriptions').where('status', '==', 'active').get();

  if (subsSnap.empty) return result;

  // 2. Fetch today's already-existing delivery_orders (skipped when force=true)
  const existingSubIds = new Set<string>();
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayStr = istNow.toISOString().split('T')[0];
  const todayDayName = istNow.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

  // 2. Fetch today's already-existing delivery_orders by date (skipped when force=true)
  const existingSubOrderKeys = new Set<string>();
  if (!force) {
    const existingSnap = await db.collection('orders')
      .where('date', '==', todayStr)
      .get();

    existingSnap.forEach((d: FirebaseFirestore.QueryDocumentSnapshot) => {
      const docData = d.data();
      const sId = docData.subscription_id || docData.subscriptionId;
      if (sId) {
        existingSubIds.add(sId);
        existingSubOrderKeys.add(`${sId}_${docData.meal_type}`);
      }
    });
  }

  // 3. Process each subscription
  let batch = db.batch();
  let batchCount = 0;

  for (const subDoc of subsSnap.docs) {
    const sub = subDoc.data();
    const subId = subDoc.id;

    if (existingSubIds.has(subId) && !sub.deliveryPattern && !sub.customPlan && sub.meal_type !== 'both') {
      result.skipped++;
      result.details.push({ subId, userName: sub.user_id, status: 'skipped', reason: 'Order already exists today' });
      continue;
    }

    // Check if subscription already has all scheduled meals
    const maxMeals = Number(sub.total_meals || sub.totalMeals || (sub.isCustomPlan ? 9 : 14));
    const currentOrdersSnap = await db.collection('orders')
      .where('subscription_id', '==', subId)
      .where('status', 'in', ['created', 'vendor_notified', 'vendor_ready', 'picked_up', 'dispatched', 'delivered', 'completed', 'pending'])
      .get();

    if (currentOrdersSnap.size >= maxMeals) {
      result.skipped++;
      result.details.push({ subId, userName: sub.user_id, status: 'skipped', reason: `All ${maxMeals} meals already scheduled` });
      continue;
    }

    // If sub specifies exact dates in selected_dates array, honor them
    if (Array.isArray(sub.selected_dates) && sub.selected_dates.length > 0) {
      if (!sub.selected_dates.includes(todayStr)) {
        continue;
      }
    }

    try {
      const [userSnap, vendorSnap] = await Promise.all([
        db.collection('users').doc(sub.user_id).get(),
        db.collection('users').doc(sub.vendor_id).get(),
      ]);

      const user = userSnap.exists ? userSnap.data() : null;
      const vendor = vendorSnap.exists ? vendorSnap.data() : null;

      if (!user || !vendor) {
        result.errors++;
        result.details.push({ subId, userName: sub.user_id, status: 'error', reason: 'User or vendor profile not found' });
        continue;
      }

      const customPattern = sub.deliveryPattern || sub.delivery_pattern || sub.customPlan?.pattern || sub.custom_schedule || null;
      let mealTypesToGenerate: string[] = [];

      // Check day-specific slot overrides first
      const daySlotConfig = sub.slots?.[todayStr] ?? 
                            sub.custom_slots?.[todayStr] ?? 
                            sub.day_slots?.[todayStr] ?? 
                            sub.slots?.[todayDayName] ?? 
                            sub.custom_slots?.[todayDayName];
      if (daySlotConfig !== undefined && daySlotConfig !== null) {
        if (typeof daySlotConfig === 'string') {
          const lower = daySlotConfig.toLowerCase().trim();
          mealTypesToGenerate = lower === 'both' ? ['lunch', 'dinner'] : [lower === 'dinner' || lower === '8pm' ? 'dinner' : 'lunch'];
        } else if (Array.isArray(daySlotConfig)) {
          mealTypesToGenerate = daySlotConfig.map(v => String(v).toLowerCase().trim()).filter(v => v === 'lunch' || v === 'dinner');
        } else if (typeof daySlotConfig === 'object') {
          if (daySlotConfig.lunch) mealTypesToGenerate.push('lunch');
          if (daySlotConfig.dinner) mealTypesToGenerate.push('dinner');
        }
      } else if (customPattern) {
        const patternEntry = customPattern[todayStr] ?? customPattern[todayDayName] ?? customPattern[todayDayName.slice(0, 3)];
        if (patternEntry !== undefined && patternEntry !== null) {
          if (typeof patternEntry === 'string') {
            const lower = patternEntry.toLowerCase().trim();
            mealTypesToGenerate = lower === 'both' ? ['lunch', 'dinner'] : [lower === 'dinner' || lower === '8pm' ? 'dinner' : 'lunch'];
          } else if (typeof patternEntry === 'object') {
            if (patternEntry.lunch) mealTypesToGenerate.push('lunch');
            if (patternEntry.dinner) mealTypesToGenerate.push('dinner');
          } else if (typeof patternEntry === 'number' || !isNaN(Number(patternEntry))) {
            const mealsToday = Number(patternEntry);
            if (mealsToday === 1) {
              mealTypesToGenerate = [sub.delivery_slot === 'dinner' || sub.deliverySlot === 'dinner' ? 'dinner' : 'lunch'];
            } else if (mealsToday >= 2) {
              mealTypesToGenerate = ['lunch', 'dinner'];
            }
          }
        }
      } else {
        mealTypesToGenerate = sub.meal_type === 'both' ? ['lunch', 'dinner'] : [sub.meal_type || 'lunch'];
      }

      if (mealTypesToGenerate.length === 0) continue;

      const userLat = user.location?.lat ?? vendor.location?.lat ?? 21.1458;
      const userLng = user.location?.lng ?? vendor.location?.lng ?? 79.0882;
      const pricePerMeal = Number(sub.customPlan?.pricePerMeal || (sub.total_price ? Math.round(sub.total_price / maxMeals) : 91));

      for (const mealType of mealTypesToGenerate) {
        if (!force && existingSubOrderKeys.has(`${subId}_${mealType}`)) {
          result.skipped++;
          result.details.push({ subId, status: 'skipped', reason: `Order already exists today for ${mealType}` });
          continue;
        }

        const mealName = mealType === 'dinner' ? 'Dinner' : 'Lunch';
        const otp = String(Math.floor(1000 + Math.random() * 9000));
        const assignedDriverId = driverIds.length > 0 ? driverIds[currentDriverIndex++ % driverIds.length] : null;

        const scheduledSlot = mealType === 'lunch' ? (user.deliveryPreference || '11am') : '8pm';

        const newOrderRef = db.collection('orders').doc();
        
        batch.set(newOrderRef, {
          order_id: newOrderRef.id,
          user_id: sub.user_id,
          customer_phone: user.phone || user.phoneNumber || '',
          subscription_id: subId,
          date: todayStr,
          meal_type: mealType,
          delivery_slot: scheduledSlot,
          vendor_id: sub.vendor_id,
          vendor_phone: vendor.phone || vendor.phoneNumber || '',
          batch_id: null,
          delivery_address: {
            line1: user.address || `${user.name}'s Location`,
            lat: userLat,
            lng: userLng,
          },
          status: 'created',
          otp: otp,
          delivery_otp: otp,
          box_tag: `${mealType === 'dinner' ? 'D' : 'L'}-${((sub.dietary || sub.category || 'veg') + '').toLowerCase().includes('non') ? 'NONVEG' : 'VEG'}-${String(result.created + 1).padStart(3, '0')}`,
          total_amount: pricePerMeal,
          amount: pricePerMeal,
          custom_meal_config: sub.custom_meal_config || null,
          meal_components: sub.meal_components || (sub.custom_meal_config?.manifestSummary ? [sub.custom_meal_config.manifestSummary] : null),
          pricingSnapshot: sub.pricingSnapshot || sub.pricing_snapshot || null,
          rider_trip_id: null,
          swap_ref: null,
          skip_ref: null,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
          updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        // Customer: Order Confirmed
        publishEvent(
          'order_confirmed',
          sub.user_id,
          'customer',
          `order_confirmed_${newOrderRef.id}`,
          { 
            mealType: mealName,
            slot: scheduledSlot
          }
        ).catch(err => console.error('Error publishing order_confirmed:', err));

        batchCount++;
      }

      result.created += mealTypesToGenerate.length;
      result.details.push({ subId, userName: user.name || sub.user_id, status: 'created', generatedOrders: mealTypesToGenerate.length });

      if (batchCount >= 490) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    } catch (err: any) {
      result.errors++;
      result.details.push({ subId, userName: sub.user_id, status: 'error', reason: err.message || 'Unknown error' });
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  return result;
}

/**
 * Callable function to generate today's deliveries from active subscriptions.
 * Enforces admin role check.
 */
export const generateTodayDeliveries = onCall(async (request) => {
  const { auth, data } = request;
  
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Must be authenticated');
  }
  
  if (auth.token.role !== 'admin') {
    const userDoc = await admin.firestore().collection('users').doc(auth.uid).get();
    if (!userDoc.exists || userDoc.data()?.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Must be an admin to generate orders');
    }
  }

  const force = (data as any)?.force === true;
  return await processDailyDeliveries(force);
});

/**
 * Automated daily background job to generate delivery orders from active subscriptions.
 * Runs every day at 1:00 AM IST.
 */
export const autoGenerateDailyDeliveries = onSchedule({
  schedule: '0 1 * * *',
  timeZone: 'Asia/Kolkata'
}, async (event) => {
  console.log('[autoGenerateDailyDeliveries] Starting scheduled order generation...');
  const result = await processDailyDeliveries(false);
  console.log(`[autoGenerateDailyDeliveries] Completed. Created: ${result.created}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
});

/**
 * Marks a specific vendor's batch of orders for a given date/slot as 'ready'.
 * Uses a transaction to ensure idempotency.
 */
export const markBatchReady = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Must be authenticated');
  }
  
  const callerUid = auth.uid;
  const { batch_id } = data as any;
  if (!batch_id) {
    throw new HttpsError('invalid-argument', 'Missing batch_id');
  }

  const db = admin.firestore();
  const batchRef = db.collection('batches').doc(batch_id);

  // Admin / Superadmin check
  const callerEmail = (auth.token?.email || '').toLowerCase().trim();
  let isAdmin = callerEmail === 'closeon.st@gmail.com' || (auth.token as any)?.admin === true || (auth.token as any)?.role === 'admin';
  if (!isAdmin) {
    const callerDoc = await db.collection('users').doc(callerUid).get();
    if (callerDoc.exists) {
      const udata = callerDoc.data() || {};
      isAdmin = udata.role === 'admin' || udata.is_superadmin === true || udata.roles?.admin === true;
    }
  }

  let actualVendorId = '';

  const result = await db.runTransaction(async (t) => {
    const batchDoc = await t.get(batchRef);
    if (!batchDoc.exists) {
      throw new HttpsError('not-found', `Batch ${batch_id} not found`);
    }

    const batch = batchDoc.data()!;
    actualVendorId = batch.vendor_id;

    // Auth check: ensure the calling vendor owns this batch (or is admin/superadmin)
    if (!isAdmin && batch.vendor_id !== callerUid) {
      throw new HttpsError('permission-denied', 'This batch does not belong to you');
    }
    
    if (batch.status === 'ready' || batch.status === 'completed') {
      return { success: false, message: `Batch is already in status: ${batch.status}` };
    }

    // Fetch all order documents first to satisfy Firestore read-before-write rules
    const orderIds: string[] = batch.order_ids || [];
    const orderDocs: FirebaseFirestore.DocumentSnapshot[] = [];
    
    for (const orderId of orderIds) {
      const orderRef = db.collection('orders').doc(orderId);
      const orderDoc = await t.get(orderRef);
      orderDocs.push(orderDoc);
    }

    // 1. Generate Pickup OTP and Transition Batch to ready
    const pickupOTP = Math.floor(1000 + Math.random() * 9000).toString();

    t.update(batchRef, {
      status: 'ready',
      pickup_otp: pickupOTP,
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2. Cascade to every non-skipped order in the batch
    let cascadeCount = 0;

    // Collect customer notification events to dispatch after transaction commits
    const pendingEvents: { customerId: string; orderId: string; mealType: string }[] = [];

    for (const orderDoc of orderDocs) {
      if (!orderDoc.exists) continue;

      const order = orderDoc.data()!;
      // Only update orders that are in an active state (not skipped/failed/completed)
      const skipStatuses = ['skipped', 'swapped_out', 'failed', 'completed'];
      if (skipStatuses.includes(order.status)) continue;

      t.update(orderDoc.ref, {
        status: 'vendor_ready',
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });

      // 3. Write OrderStatusLog for each order
      const logRef = db.collection('order_status_logs').doc();
      t.set(logRef, {
        id: logRef.id,
        order_id: orderDoc.id,
        from_status: order.status,
        to_status: 'vendor_ready',
        actor: callerUid,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      if (order.user_id) {
        pendingEvents.push({
          customerId: order.user_id,
          orderId: orderDoc.id,
          mealType: order.meal_type || 'meal'
        });
      }

      cascadeCount++;
    }

    return {
      success: true,
      message: `Batch marked ready. ${cascadeCount} orders updated to vendor_ready.`,
      pendingEvents
    };
  });

  if (!result.success) {
    return result;
  }

  // Publish customer events after transaction commits
  if (result.pendingEvents && Array.isArray(result.pendingEvents)) {
    for (const evt of result.pendingEvents) {
      publishEvent(
        'meal_prep_started',
        evt.customerId,
        'customer',
        `meal_prep_${evt.orderId}`,
        { mealType: evt.mealType }
      ).catch(e => console.error('[markBatchReady] Failed to publish customer event:', e));
    }
  }

  // Automatically trigger rider assignment for this vendor now that the batch is ready
  // MUST BE AWAITED so the Cloud Function doesn't suspend before assignment finishes
  try {
    const m = await import('./matchingTriggers');
    await m.coreAssignRiderTrips(actualVendorId || callerUid, undefined, 10.0, batch_id);
  } catch (e) {
    console.error('[markBatchReady] Auto-assign failed:', e);
  }

  return { success: true, message: result.message };
});

export const verifyDeliveryOTP = onCall(async (request) => {
  const { data, auth } = request;

  if (!auth) {
    throw new HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { orderId, otp } = data || {};
  if (!orderId || !otp) {
    throw new HttpsError('invalid-argument', 'Missing orderId or otp');
  }

  const db = admin.firestore();
  const orderRef = db.collection('orders').doc(orderId);

  // 1. Transactionally verify OTP and update order to 'delivered'
  const txResult = await db.runTransaction(async (transaction) => {
    const orderDoc = await transaction.get(orderRef);

    if (!orderDoc.exists) {
      throw new HttpsError('not-found', 'Order not found');
    }

    const data = orderDoc.data()!;

    // Auth check — cover all rider ID field names used across the platform
    const isAssignedRider =
      data.rider_id === auth.uid ||
      data.driverId === auth.uid ||
      data.agentId === auth.uid ||
      data.agent_id === auth.uid ||
      data.riderId === auth.uid;
    const isAdmin = auth.token?.role === 'admin' || auth.token?.admin === true || auth.token?.email === 'closeon.st@gmail.com';

    if (!isAssignedRider && !isAdmin) {
      throw new HttpsError('permission-denied', 'Only the assigned rider or an admin can verify this delivery OTP.');
    }

    if (data.status === 'delivered') {
      return { success: false, message: 'Order is already delivered', orderData: data };
    }

    // Check both possible OTP field names
    const storedOtp = data.otp ?? data.delivery_otp;
    if (storedOtp === undefined || storedOtp === null) {
      throw new HttpsError('failed-precondition', 'No OTP is set for this order. Contact support.');
    }

    if (String(storedOtp).trim() !== String(otp).trim()) {
      return { success: false, message: 'Invalid OTP. Please ask the customer for the PIN shown on their screen.', orderData: data };
    }

    // Update order status to 'delivered'
    transaction.update(orderRef, {
      status: 'delivered',
      otpVerified: true,
      delivered_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    const logRef = db.collection('order_status_logs').doc();
    transaction.set(logRef, {
      id: logRef.id,
      order_id: orderId,
      from_status: data.status,
      to_status: 'delivered',
      actor: auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: 'OTP verified successfully. Order delivered.', orderData: data };
  });

  if (!txResult.success) {
    return { success: false, message: txResult.message };
  }

  const orderData = txResult.orderData;

  // 2. Synchronize trip status if order is linked to a rider_trip
  const tripId = orderData?.rider_trip_id || orderData?.riderTripId || orderData?.tripId || orderData?.trip_id;
  if (tripId) {
    try {
      const tripRef = db.collection('rider_trips').doc(tripId);
      const tripSnap = await tripRef.get();

      if (tripSnap.exists) {
        const tripData = tripSnap.data()!;
        const dropStops = (tripData.dropStops || []).map((s: any) => {
          if (s.orderId === orderId || s.order_id === orderId) {
            return {
              ...s,
              status: 'completed',
              deliveredAt: admin.firestore.Timestamp.now()
            };
          }
          return s;
        });

        const remainingOrdersSnap = await db.collection('orders')
          .where('rider_trip_id', '==', tripId)
          .where('status', 'in', ['picked_up', 'out_for_delivery', 'rider_assigned', 'vendor_ready', 'preparing', 'created', 'pending'])
          .get();

        const stillActive = remainingOrdersSnap.docs.filter(d => d.id !== orderId);
        const allDropStopsTerminal = dropStops.length > 0 && dropStops.every((s: any) => s.status === 'completed' || s.status === 'failed');

        const tripUpdatePayload: any = {
          dropStops,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (allDropStopsTerminal && stillActive.length === 0) {
          tripUpdatePayload.status = 'completed';
          tripUpdatePayload.completedAt = admin.firestore.FieldValue.serverTimestamp();
        }

        await tripRef.update(tripUpdatePayload);
      }
    } catch (tripSyncErr) {
      console.warn('[verifyDeliveryOTP] Trip sync check failed:', tripSyncErr);
    }
  }

  // 3. Synchronize batch status if order belongs to a batch
  const batchId = orderData?.batch_id || orderData?.batchId;
  if (batchId) {
    try {
      const batchRef = db.collection('batches').doc(batchId);
      const batchSnap = await batchRef.get();
      if (batchSnap.exists) {
        const remainingBatchOrders = await db.collection('orders')
          .where('batch_id', '==', batchId)
          .where('status', 'in', ['picked_up', 'out_for_delivery', 'rider_assigned', 'vendor_ready', 'preparing', 'created', 'pending'])
          .get();

        const activeBatchOrders = remainingBatchOrders.docs.filter(d => d.id !== orderId);
        if (activeBatchOrders.length === 0) {
          await batchRef.update({
            status: 'completed',
            delivered_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
    } catch (batchSyncErr) {
      console.warn('[verifyDeliveryOTP] Batch sync check failed:', batchSyncErr);
    }
  }

  return { success: true, message: 'OTP verified successfully. Order delivered.' };
});

/**
 * Callable function for a rider to initiate the 10-minute customer unavailability countdown.
 * Stamps unavailability_started_at on the order and alerts the customer.
 */
export const startCustomerUnavailability = onCall(async (request) => {
  const { data, auth } = request;
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { orderId, tripId } = data || {};
  if (!orderId) {
    throw new HttpsError('invalid-argument', 'Missing orderId');
  }

  const db = admin.firestore();
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    throw new HttpsError('not-found', 'Order not found');
  }

  const order = orderSnap.data()!;
  const isAssigned = order.rider_id === auth.uid || 
                     order.driverId === auth.uid || 
                     order.agentId === auth.uid || 
                     order.agent_id === auth.uid || 
                     order.riderId === auth.uid;
  const isAdmin = auth.token?.role === 'admin' || auth.token?.admin === true || auth.token?.email === 'closeon.st@gmail.com';

  if (!isAssigned && !isAdmin) {
    throw new HttpsError('permission-denied', 'Only the assigned rider or admin can report unavailability.');
  }

  if (order.status === 'delivered') {
    throw new HttpsError('failed-precondition', 'Order is already delivered.');
  }
  if (order.status === 'failed' || order.status === 'cancelled') {
    throw new HttpsError('failed-precondition', 'Order is already in a terminal state.');
  }

  const now = admin.firestore.Timestamp.now();
  const existingStart = order.unavailability_started_at;
  const startTime = existingStart || now;

  if (!existingStart) {
    await orderRef.update({
      unavailability_started_at: startTime,
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  if (order.user_id) {
    publishEvent(
      'delivery_failed',
      order.user_id,
      'customer',
      `unavail_alert_${orderId}_${now.toMillis()}`,
      {
        orderId,
        message: 'Your rider has arrived at your doorstep! Please share your Delivery PIN within 10 minutes.'
      }
    ).catch(e => console.error('[startCustomerUnavailability] Alert error:', e));
  }

  const startMs = startTime.toMillis 
    ? startTime.toMillis() 
    : startTime.toDate 
    ? startTime.toDate().getTime() 
    : startTime.seconds 
    ? startTime.seconds * 1000 
    : Date.now();

  return {
    success: true,
    unavailability_started_at: startMs,
    startedAt: startTime.toDate ? startTime.toDate().toISOString() : new Date(startMs).toISOString(),
    message: 'Customer unavailability timer started.'
  };
});

/**
 * Callable function for a rider to confirm customer unavailability after the 10-minute wait.
 * Server verifies that >= 10 minutes have elapsed before allowing transition to 'failed'.
 */
export const confirmCustomerUnavailable = onCall(async (request) => {
  const { data, auth } = request;
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { orderId, tripId } = data || {};
  if (!orderId) {
    throw new HttpsError('invalid-argument', 'Missing orderId');
  }

  const db = admin.firestore();
  const orderRef = db.collection('orders').doc(orderId);

  const txResult = await db.runTransaction(async (t) => {
    const orderDoc = await t.get(orderRef);
    if (!orderDoc.exists) {
      throw new HttpsError('not-found', 'Order not found');
    }

    const order = orderDoc.data()!;
    const isAssigned = order.rider_id === auth.uid || 
                       order.driverId === auth.uid || 
                       order.agentId === auth.uid || 
                       order.agent_id === auth.uid || 
                       order.riderId === auth.uid;
    const isAdmin = auth.token?.role === 'admin' || auth.token?.admin === true || auth.token?.email === 'closeon.st@gmail.com';

    if (!isAssigned && !isAdmin) {
      throw new HttpsError('permission-denied', 'Only the assigned rider or admin can confirm unavailability.');
    }

    if (order.status === 'delivered') {
      throw new HttpsError('failed-precondition', 'Order is already delivered.');
    }
    if (order.status === 'failed' || order.status === 'cancelled') {
      throw new HttpsError('failed-precondition', 'Order is already in a terminal state.');
    }

    if (!order.unavailability_started_at) {
      throw new HttpsError('failed-precondition', 'Unavailability timer has not been started for this order.');
    }

    const startMs = order.unavailability_started_at.toMillis 
      ? order.unavailability_started_at.toMillis() 
      : order.unavailability_started_at.toDate
      ? order.unavailability_started_at.toDate().getTime()
      : order.unavailability_started_at.seconds
      ? order.unavailability_started_at.seconds * 1000
      : new Date(order.unavailability_started_at).getTime();
    const elapsedMinutes = (Date.now() - startMs) / (60 * 1000);

    // Validate that at least 10 minutes have elapsed (with a 5s clock-skew margin)
    if (elapsedMinutes < 9.9 && !isAdmin) {
      const remainingSeconds = Math.ceil((10 * 60) - ((Date.now() - startMs) / 1000));
      throw new HttpsError('failed-precondition', `10-minute wait is required. ${remainingSeconds}s remaining.`);
    }

    t.update(orderRef, {
      status: 'failed',
      failure_reason: 'customer_unavailable',
      failedReason: 'customer_unavailable',
      unavailability_confirmed_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    const reviewRef = db.collection('failed_delivery_reviews').doc();
    t.set(reviewRef, {
      id: reviewRef.id,
      order_id: orderId,
      batch_id: order.batch_id || null,
      rider_id: auth.uid,
      failed_at: admin.firestore.FieldValue.serverTimestamp(),
      failure_reason: 'customer_unavailable',
      reviewed: false
    });

    const logRef = db.collection('order_status_logs').doc();
    t.set(logRef, {
      id: logRef.id,
      order_id: orderId,
      from_status: order.status,
      to_status: 'failed',
      actor: auth.uid,
      reason: 'customer_unavailable',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return { order, tripId: tripId || order.rider_trip_id || order.riderTripId || order.tripId || order.trip_id };
  });

  const effectiveTripId = txResult.tripId;
  if (effectiveTripId) {
    try {
      const tripRef = db.collection('rider_trips').doc(effectiveTripId);
      const tripSnap = await tripRef.get();
      if (tripSnap.exists) {
        const tripData = tripSnap.data()!;
        const dropStops = (tripData.dropStops || []).map((s: any) => {
          if (s.orderId === orderId || s.order_id === orderId) {
            return { ...s, status: 'failed', failureReason: 'customer_unavailable' };
          }
          return s;
        });

        const remainingOrdersSnap = await db.collection('orders')
          .where('rider_trip_id', '==', effectiveTripId)
          .where('status', 'in', ['picked_up', 'out_for_delivery', 'rider_assigned', 'vendor_ready', 'preparing', 'created', 'pending'])
          .get();

        const stillActive = remainingOrdersSnap.docs.filter(d => d.id !== orderId);
        const allDropStopsTerminal = dropStops.length > 0 && dropStops.every((s: any) => s.status === 'completed' || s.status === 'failed');

        const tripUpdatePayload: any = {
          dropStops,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (allDropStopsTerminal && stillActive.length === 0) {
          tripUpdatePayload.status = 'completed';
          tripUpdatePayload.completedAt = admin.firestore.FieldValue.serverTimestamp();
        }

        await tripRef.update(tripUpdatePayload);
      }
    } catch (tripErr) {
      console.warn('[confirmCustomerUnavailable] Failed syncing trip:', tripErr);
    }
  }

  if (txResult.order?.user_id) {
    publishEvent(
      'delivery_failed',
      txResult.order.user_id,
      'customer',
      `delivery_failed_${orderId}`,
      { orderId, reason: 'Customer unavailable after 10-minute wait' }
    ).catch(e => console.error('[confirmCustomerUnavailable] Notification error:', e));
  }

  return { success: true, message: 'Delivery marked as failed (customer unavailable).' };
});

/**
 * Triggers when a subscription document is created OR re-activated.
 * Uses onDocumentWritten because setDoc with a deterministic ID overwrites
 * existing docs (no create event fires on resubscription).
 * Generates canonical daily delivery orders for the full plan duration (up to 28 days for monthly).
 */
export const onSubscriptionCreated = onDocumentWritten('subscriptions/{subId}', async (event) => {
  const before = event.data?.before;
  const after = event.data?.after;

  if (!after?.exists) return;

  const afterData = after.data();
  if (!afterData || afterData.status !== 'active') return;

  // Only act when status becomes active (new doc or re-activation)
  const beforeData = before?.exists ? before.data() : null;
  if (beforeData && beforeData.status === 'active') return; // Was already active, skip
  const db = admin.firestore();

  const sub = afterData;
  const subId = event.params.subId;

  // ── Swap allowance ────────────────────────────────────────────────────────
  // Initialised/reset here rather than by the client. The rules allow a user to
  // CREATE their own allowance but not UPDATE it -- deliberately, since being
  // able to reset free_swaps_used to 0 would mean unlimited free swaps. That
  // left re-subscribing unable to reset the allowance: the client's setDoc with
  // merge is an update on an existing doc, it was denied, and because the call
  // was .catch()-ed to a console.warn nobody ever saw it. Renewing customers
  // silently did not get their free swaps back.
  //
  // Doing it here keeps the client-side restriction intact and makes the reset
  // a privileged operation, which is what it is.
  try {
    const freeSwapsTotal = sub.meal_type === 'both' ? 2 : 1;
    await admin.firestore().collection('subscription_swap_allowances').doc(subId).set(
      {
        subscription_id: subId,
        user_id: sub.user_id,
        free_swaps_total: freeSwapsTotal,
        free_swaps_used: 0,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error(`[onSubscriptionCreated] Could not set swap allowance for ${subId}:`, err);
  }

  const [userSnap, vendorSnap] = await Promise.all([
    db.collection('users').doc(sub.user_id).get(),
    db.collection('users').doc(sub.vendor_id).get(),
  ]);

  const user = userSnap.exists ? userSnap.data() : null;
  const vendor = vendorSnap.exists ? vendorSnap.data() : null;

  if (!user || !vendor) {
    console.error(`[onSubscriptionCreated] User or vendor not found for sub ${subId}`);
    return;
  }

  const isCustom = sub.isCustomPlan || sub.is_custom_plan || sub.plan_id === 'custom_weekly' || sub.plan_id === 'custom_monthly';
  const customPattern = sub.deliveryPattern || sub.delivery_pattern || sub.customPlan?.pattern || sub.custom_schedule || null;

  const isOneTime = sub.frequency === 'one-time' || sub.plan_duration === 'one-time' || sub.plan_id === 'one-time';
  const isWeekly = sub.frequency === 'weekly' || sub.plan_duration === 'weekly';
  const isMonthly = sub.plan_duration === 'monthly' || 
                    sub.frequency === 'monthly' || 
                    sub.plan_id === 'custom_monthly' || 
                    (typeof sub.plan_id === 'string' && sub.plan_id.includes('month')) ||
                    (!isOneTime && Array.isArray(sub.selected_dates) && sub.selected_dates.length > 7);

  const defaultMealsForPlan = isOneTime
    ? (sub.meal_type === 'both' ? 2 : 1)
    : isWeekly
      ? (sub.meal_type === 'both' ? 14 : 7)
      : isMonthly
        ? (sub.meal_type === 'both' ? 60 : 30)
        : (isCustom ? 9 : (sub.meal_type === 'both' ? 14 : 7));

  const maxMealsTotal = Number(sub.total_meals || sub.totalMeals || defaultMealsForPlan);
  const userLat = user.location?.lat ?? vendor.location?.lat ?? 21.1458;
  const userLng = user.location?.lng ?? vendor.location?.lng ?? 79.0882;
  const pricePerMeal = Number(sub.customPlan?.pricePerMeal || (sub.total_price ? Math.round(sub.total_price / maxMealsTotal) : 91));

  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istHour = istNow.getUTCHours();
  const istYear = istNow.getUTCFullYear();
  const istMonth = istNow.getUTCMonth();
  const istDate = istNow.getUTCDate();

  let maxDays = isOneTime
    ? 2
    : isMonthly 
      ? Math.max(60, Math.ceil(maxMealsTotal * 2.5)) 
      : Math.max(14, maxMealsTotal * 2);
  if (Array.isArray(sub.selected_dates) && sub.selected_dates.length > 0) {
    const validDates = sub.selected_dates
      .filter((d: any) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    if (validDates.length > 0) {
      const lastDate = new Date(validDates[validDates.length - 1]);
      const diffMs = lastDate.getTime() - new Date(Date.UTC(istYear, istMonth, istDate)).getTime();
      const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000)) + 1;
      maxDays = Math.max(maxDays, diffDays);
    }
  }
  maxDays = Math.min(maxDays, 90);

  // Helper to parse slot entries into clean string[] of meal types
  const parseSlotEntry = (val: any): string[] => {
    if (!val) return [];
    if (typeof val === 'string') {
      const lower = val.toLowerCase().trim();
      if (lower === 'both') return ['lunch', 'dinner'];
      if (lower === 'dinner' || lower === '8pm') return ['dinner'];
      if (lower === 'lunch' || lower === '11am' || lower === '1pm') return ['lunch'];
      return [lower];
    }
    if (Array.isArray(val)) {
      return val.map(v => String(v).toLowerCase().trim()).filter(v => v === 'lunch' || v === 'dinner');
    }
    if (typeof val === 'object') {
      const slots: string[] = [];
      if (val.lunch) slots.push('lunch');
      if (val.dinner) slots.push('dinner');
      return slots;
    }
    return [];
  };

  // Helper to resolve day meal types respecting day-specific slots & patterns
  const resolveDayMealTypes = (dateStr: string, dayName: string, shortDay: string): string[] => {
    const daySlotConfig = sub.slots?.[dateStr] ?? 
                          sub.custom_slots?.[dateStr] ?? 
                          sub.day_slots?.[dateStr] ?? 
                          sub.slots?.[dayName] ?? 
                          sub.custom_slots?.[dayName];
    if (daySlotConfig !== undefined && daySlotConfig !== null) {
      const parsed = parseSlotEntry(daySlotConfig);
      if (parsed.length > 0) return parsed;
    }

    if (customPattern) {
      const patternEntry = customPattern[dateStr] ?? customPattern[dayName] ?? customPattern[shortDay];
      if (patternEntry !== undefined && patternEntry !== null) {
        if (typeof patternEntry === 'string' || typeof patternEntry === 'object') {
          const parsed = parseSlotEntry(patternEntry);
          if (parsed.length > 0) return parsed;
        }
        if (typeof patternEntry === 'number' || !isNaN(Number(patternEntry))) {
          const count = Number(patternEntry);
          if (count <= 0) return [];
          if (count >= 2) return ['lunch', 'dinner'];
          const pref = (sub.delivery_slot || sub.deliverySlot || '').toLowerCase();
          return [pref === 'dinner' || pref === '8pm' ? 'dinner' : 'lunch'];
        }
      }
      return [];
    }

    if (sub.meal_type === 'both') return ['lunch', 'dinner'];
    const pref = (sub.delivery_slot || sub.deliverySlot || sub.meal_type || 'lunch').toLowerCase();
    return [pref === 'dinner' || pref === '8pm' ? 'dinner' : 'lunch'];
  };

  // First, cancel any existing pending orders for this sub (clean slate on reactivation)
  const existingSnap = await db.collection('orders')
    .where('subscription_id', '==', subId)
    .where('status', 'in', ['created', 'pending'])
    .get();
  const cleanBatch = db.batch();
  existingSnap.docs.forEach(d => cleanBatch.delete(d.ref));
  if (!existingSnap.empty) await cleanBatch.commit();

  let batch = db.batch();
  let batchCount = 0;
  let ordersCreated = 0;

  for (let dayOffset = 0; dayOffset < maxDays; dayOffset++) {
    if (ordersCreated >= maxMealsTotal) break;

    const orderDate = new Date(Date.UTC(istYear, istMonth, istDate + dayOffset));
    const dateStr = orderDate.toISOString().split('T')[0];
    const dayName = orderDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
    const shortDay = orderDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toLowerCase();

    // If sub specifies exact dates in selected_dates array, honor them
    if (Array.isArray(sub.selected_dates) && sub.selected_dates.length > 0) {
      if (!sub.selected_dates.includes(dateStr)) continue;
    }

    const dayMealTypes = resolveDayMealTypes(dateStr, dayName, shortDay);

    for (const mealType of dayMealTypes) {
      if (ordersCreated >= maxMealsTotal) break;
      if (dayOffset === 0) {
        if (mealType === 'lunch' && istHour >= 10) continue;
        if (mealType === 'dinner' && istHour >= 19) continue;
      }

      const scheduledSlot = mealType === 'lunch' ? (user.deliveryPreference || '11am') : '8pm';
      const otp = String(Math.floor(1000 + Math.random() * 9000));
      const slotInitial = mealType === 'dinner' ? 'D' : 'L';
      const dietaryCode = ((sub.dietary || sub.category || user.dietary || 'veg') + '').toLowerCase().includes('non') ? 'NONVEG' : 'VEG';
      const seqStr = String(ordersCreated + 1).padStart(3, '0');
      const boxTag = `${slotInitial}-${dietaryCode}-${seqStr}`;

      const newOrderRef = db.collection('orders').doc();
      batch.set(newOrderRef, {
        order_id: newOrderRef.id,
        user_id: sub.user_id,
        customerId: sub.user_id,
        customer_phone: user.phone || user.phoneNumber || '',
        subscription_id: subId,
        date: dateStr,
        meal_type: mealType,
        delivery_slot: scheduledSlot,
        scheduledSlot: scheduledSlot,
        vendor_id: sub.vendor_id,
        vendorId: sub.vendor_id,
        vendor_phone: vendor.phone || vendor.phoneNumber || '',
        batch_id: null,
        delivery_address: {
          line1: user.address || `${user.name || 'Customer'}'s Location`,
          lat: userLat,
          lng: userLng,
        },
        address: {
          line1: user.address || `${user.name || 'Customer'}'s Location`,
          lat: userLat,
          lng: userLng,
        },
        status: 'created',
        otp,
        delivery_otp: otp,
        box_tag: boxTag,
        total_amount: pricePerMeal,
        amount: pricePerMeal,
        custom_meal_config: sub.custom_meal_config || null,
        meal_components: sub.meal_components || (sub.custom_meal_config?.manifestSummary ? [sub.custom_meal_config.manifestSummary] : null),
        pricingSnapshot: sub.pricingSnapshot || sub.pricing_snapshot || null,
        rider_trip_id: null,
        swap_ref: null,
        skip_ref: null,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });
      ordersCreated++;
      batchCount++;

      if (batchCount >= 450) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }
  console.log(`[onSubscriptionCreated] Generated ${ordersCreated} canonical orders for sub ${subId} (maxDays: ${maxDays})`);
});

/**
 * Triggers when a subscription is updated.
 * If status changes to 'cancelled' → immediately cancel all pending/preparing orders.
 */
export const onSubscriptionCancelled = onDocumentUpdated('subscriptions/{subId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();

  if (!before || !after) return;

  // Only act when status transitions to cancelled
  if (before.status === after.status || after.status !== 'cancelled') return;

  const subId = event.params.subId;
  const db = admin.firestore();

  console.log(`[onSubscriptionCancelled] Cancelling future orders for sub ${subId}`);

  // Find all pending/preparing orders for this subscription
  // All non-terminal statuses except in-flight deliveries (picked_up /
  // out_for_delivery are left to finish; they were dispatched inside the
  // paid window). `completed`/`delivered`/`failed`/`skipped`/`swapped_*` are
  // terminal-sentinel and must keep their record.
  const ordersSnap = await db.collection('orders')
    .where('subscription_id', '==', subId)
    .where('status', 'in', [
      'created', 'pending', 'preparing', 'vendor_notified', 'vendor_preparing',
      'vendor_ready', 'rider_assigned', 'rider_en_route_pickup', 'ready', 'cooking',
      'dispatched'
    ])
    .get();

  if (ordersSnap.empty) {
    console.log(`[onSubscriptionCancelled] No pending orders found for sub ${subId}`);
    return;
  }

  const batch = db.batch();
  ordersSnap.docs.forEach(doc => {
    batch.update(doc.ref, {
      status: 'cancelled',
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();
  console.log(`[onSubscriptionCancelled] Cancelled ${ordersSnap.size} orders for sub ${subId}`);
});

/**
 * Generates a mock delivery flow for testing purposes.
 * Hardcodes user, vendor, and rider assignments using specified phone numbers.
 */
export const generateTestDelivery = onCall(async (request) => {
  const { auth } = request;
  if (!auth) throw new HttpsError('unauthenticated', 'Must be authenticated');
  
  // Verify Admin role
  if (auth.token.role !== 'admin') {
    const callerDoc = await admin.firestore().collection('users').doc(auth.uid).get();
    if (!callerDoc.exists || callerDoc.data()?.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Must be an admin to run test delivery flow');
    }
  }

  const db = admin.firestore();

  // Find the required users by phone number
  const findUser = async (phone: string, role: string) => {
    const snap = await db.collection('users').where('phone', '==', phone).limit(1).get();
    if (snap.empty) {
      throw new HttpsError('not-found', `Could not find ${role} with phone ${phone}`);
    }
    return snap.docs[0];
  };

  const [userDoc, vendorDoc, riderDoc] = await Promise.all([
    findUser('+919900990011', 'customer'),
    findUser('+919900990022', 'vendor'),
    findUser('+919900990044', 'rider')
  ]);

  const customerId = userDoc.id;
  const vendorId = vendorDoc.id;
  const riderId = riderDoc.id;

  // Use local timezone string to match the vendor dashboard
  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0];

  // Optional: clear existing test trips for today for this vendor/rider to keep it clean
  const existingOrders = await db.collection('orders')
    .where('user_id', '==', customerId)
    .where('date', '==', todayStr)
    .get();
  
  for (const doc of existingOrders.docs) {
    await doc.ref.delete();
  }
  
  // Clear any existing test batches for this vendor to remove stuck ghosts
  const existingBatches = await db.collection('batches')
    .where('vendor_id', '==', vendorId)
    .get();
  
  for (const doc of existingBatches.docs) {
    await doc.ref.delete();
  }

  // Clear any existing test trips for this rider to remove stuck ghosts
  const existingTrips = await db.collection('rider_trips')
    .where('riderId', '==', riderId)
    .get();
  
  for (const doc of existingTrips.docs) {
    await doc.ref.delete();
  }

  const batchId = `TEST_BATCH_${vendorId}_${todayStr}`;
  const tripId = `TEST_TRIP_${riderId}_${todayStr}`;

  const vendorLocation = vendorDoc.data()?.location || { lat: 0, lng: 0 };
  const customerLocation = userDoc.data()?.location || { lat: 0, lng: 0 };
  const customerAddress = userDoc.data()?.address || { line1: 'Test Address' };

  // 1. Create a Pending Order
  const orderRef = db.collection('orders').doc();
  const orderData = {
    id: orderRef.id,
    user_id: customerId,
    vendor_id: vendorId,
    agent_id: riderId,
    rider_trip_id: tripId,
    // Add camelCase variants for frontend components that expect DeliveryOrder format
    driverId: riderId,
    customerId: customerId,
    vendorId: vendorId,
    address: customerAddress,
    date: todayStr,
    status: 'vendor_ready', // Let's skip directly to ready for pickup
    delivery_slot: '11am',
    meal_type: 'lunch',
    otp: Math.floor(1000 + Math.random() * 9000).toString(),
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  };
  await orderRef.set(orderData);

  // 2. Create the Batch
  const batchRef = db.collection('batches').doc(batchId);
  const pickupOTP = Math.floor(1000 + Math.random() * 9000).toString();

  const batchData = {
    id: batchId,
    vendor_id: vendorId,
    date: todayStr,
    slot: '11am',
    order_ids: [orderRef.id],
    status: 'ready',
    pickup_otp: pickupOTP,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  };
  await batchRef.set(batchData);

  // 3. Create the Rider Trip assignment
  const tripRef = db.collection('rider_trips').doc(tripId);

  const tripData = {
    id: tripId,
    riderId: riderId,
    batch_ids: [batchId],
    assignedOrderIds: [orderRef.id],
    vendorIds: [vendorId],
    status: 'pickup_pending',
    pickupStops: [
      {
        vendorId: vendorId,
        vendorPhone: vendorDoc.data()?.phone,
        location: vendorLocation,
        sequence: 1,
        distanceKm: 0,
        status: 'pending',
        pickupOTP: pickupOTP
      }
    ],
    dropoffStops: [
      {
        orderId: orderRef.id,
        customerId: customerId,
        address: 'Test Customer Address',
        status: 'pending',
        lat: 21.1500,
        lng: 79.0900
      }
    ],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await tripRef.set(tripData);

  // 4. Update the Batch to show it's assigned
  await batchRef.update({
    status: 'ready', // vendor is waiting for rider to pick up
    agent_id: riderId
  });

  return { 
    success: true, 
    orderId: orderRef.id, 
    batchId: batchId, 
    tripId: tripId,
    message: 'Test delivery flow successfully generated!'
  };
});

/**
 * Server-side Cloud Function: Skip Meal Order
 * Safely executes cutoff validation, batch decrement, credit award,
 * and order state mutation via Firebase Admin SDK.
 */
export const skipMealOrder = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const userId = auth.uid;
  const { orderId, date, scheduledSlot, subscriptionId } = (data || {}) as any;

  if (!orderId) {
    throw new HttpsError('invalid-argument', 'orderId is required.');
  }

  const db = admin.firestore();
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();

  let orderData: any;
  let isNewProjected = false;

  if (!orderSnap.exists) {
    // If order was a projected virtual order, instantiate it as skipped
    isNewProjected = true;
    orderData = {
      id: orderId,
      user_id: userId,
      customerId: userId,
      subscription_id: subscriptionId || '',
      date: date || new Date().toISOString().split('T')[0],
      scheduledSlot: scheduledSlot || 'lunch',
      delivery_slot: scheduledSlot || 'lunch',
      status: 'pending',
      created_at: admin.firestore.FieldValue.serverTimestamp()
    };
  } else {
    orderData = orderSnap.data()!;
    const owner = orderData.user_id || orderData.customerId;
    if (owner !== userId) {
      throw new HttpsError('permission-denied', 'You do not own this order.');
    }
  }

  // Check if order is already past skippable stages
  if (['out_for_delivery', 'picked_up', 'delivered', 'vendor_ready', 'rider_assigned'].includes(orderData.status)) {
    throw new HttpsError('failed-precondition', `Cannot skip order that is ${orderData.status}.`);
  }

  // Entitlement guard: a skipped meal is a benefit of an active subscription.
  const skipSubId = (subscriptionId as string) || orderData.subscription_id || orderData.subscriptionId || '';
  if (skipSubId) {
    const access = await getSubscriptionAccessRecord(db, skipSubId);
    if (!access.active) {
      throw new HttpsError(
        'failed-precondition',
        'Your subscription is expired or inactive — renew it to skip meals.'
      );
    }
  }

  // Calculate cutoff & credit amount
  const creditsEarned = 1.0;

  // Execute atomic update
  const batch = db.batch();

  // 1. Decrement batch count if locked into a batch
  if (orderData.batch_id) {
    const batchRef = db.collection('batches').doc(orderData.batch_id);
    batch.update(batchRef, {
      total_count: admin.firestore.FieldValue.increment(-1),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  // 2. Award credit in user_credits
  const creditRef = db.collection('user_credits').doc();
  batch.set(creditRef, {
    id: creditRef.id,
    user_id: userId,
    credit_amount: creditsEarned,
    source: 'cancellation',
    source_reference_id: orderId,
    redeemed: false,
    created_at: admin.firestore.FieldValue.serverTimestamp()
  });

  // 3. Mark order as skipped
  if (isNewProjected) {
    batch.set(orderRef, {
      ...orderData,
      status: 'skipped',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });
  } else {
    batch.update(orderRef, {
      status: 'skipped',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  // 4. Record order status log
  const logRef = db.collection('order_status_logs').doc();
  batch.set(logRef, {
    id: logRef.id,
    order_id: orderId,
    from_status: orderData.status || 'created',
    to_status: 'skipped',
    actor: userId,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  await batch.commit();

  return {
    success: true,
    creditsEarned,
    message: 'Tiffin skipped successfully. Credit added to your account.'
  };
});

/**
 * Server-side Cloud Function: Undo Skip Meal Order
 * Re-activates a skipped order and reverses credit adjustments.
 */
export const undoSkipMealOrder = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const userId = auth.uid;
  const { orderId } = (data || {}) as any;

  if (!orderId) {
    throw new HttpsError('invalid-argument', 'orderId is required.');
  }

  const db = admin.firestore();
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    throw new HttpsError('not-found', 'Order not found.');
  }

  const orderData = orderSnap.data()!;
  const owner = orderData.user_id || orderData.customerId;
  if (owner !== userId) {
    throw new HttpsError('permission-denied', 'You do not own this order.');
  }

  if (orderData.status !== 'skipped') {
    throw new HttpsError('failed-precondition', 'Order is not in skipped status.');
  }

  // Entitlement guard — undo-skip is a benefit of an active subscription.
  const undoSubId = orderData.subscription_id || orderData.subscriptionId || '';
  if (undoSubId) {
    const access = await getSubscriptionAccessRecord(db, undoSubId);
    if (!access.active) {
      throw new HttpsError(
        'failed-precondition',
        'Your subscription is expired or inactive — renew it to restore skipped meals.'
      );
    }
  }

  const batch = db.batch();
  const restoredStatus = orderData.batch_id ? 'vendor_notified' : 'created';

  // 1. Re-activate order to created / vendor_notified
  batch.update(orderRef, {
    status: restoredStatus,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  });

  // 2. Increment batch count if previously assigned to a batch
  if (orderData.batch_id) {
    const batchRef = db.collection('batches').doc(orderData.batch_id);
    batch.update(batchRef, {
      total_count: admin.firestore.FieldValue.increment(1),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  // 3. Mark previously awarded skip credit as redeemed/reversed
  const creditsSnap = await db.collection('user_credits')
    .where('user_id', '==', userId)
    .where('source_reference_id', '==', orderId)
    .where('redeemed', '==', false)
    .limit(1)
    .get();

  if (!creditsSnap.empty) {
    batch.update(creditsSnap.docs[0].ref, {
      redeemed: true,
      redeemed_at: admin.firestore.FieldValue.serverTimestamp(),
      reversal_reason: 'undo_skip'
    });
  }

  // 4. Log status change
  const logRef = db.collection('order_status_logs').doc();
  batch.set(logRef, {
    id: logRef.id,
    order_id: orderId,
    from_status: 'skipped',
    to_status: restoredStatus,
    actor: userId,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  await batch.commit();

  return {
    success: true,
    mode: 'credit',
    message: 'Tiffin restored successfully.'
  };
});
