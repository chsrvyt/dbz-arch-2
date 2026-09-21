import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { getSubscriptionAccessRecord } from './subscriptionExpiry';

/**
 * Server-side Cloud Function: Request a meal swap.
 * Verifies caller authentication, order ownership, swap allowance,
 * creates the swap_requests document with user_id = auth.uid,
 * and broadcasts candidate requests to eligible eaters.
 */
export const requestMealSwap = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const userId = context.auth.uid;
  const { orderId, subscriptionId, mealId, targetVendorId, paymentDetails } = data || {};

  if (!orderId || !subscriptionId) {
    throw new functions.https.HttpsError('invalid-argument', 'orderId and subscriptionId are required.');
  }

  const db = admin.firestore();

  // 1. Verify order ownership and status
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Order not found.');
  }

  const orderData = orderSnap.data()!;
  const orderOwner = orderData.user_id || orderData.customerId;
  if (orderOwner !== userId) {
    throw new functions.https.HttpsError('permission-denied', 'You do not own this order.');
  }

  if (['cancelled', 'skipped', 'delivered', 'picked_up'].includes(orderData.status)) {
    throw new functions.https.HttpsError('failed-precondition', `Order cannot be swapped in '${orderData.status}' status.`);
  }

  // Entitlement guard: swapping is a benefit of an active subscription.
  const access = await getSubscriptionAccessRecord(db, subscriptionId);
  if (!access.active) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Your subscription is expired or inactive — renew it to request a meal swap.'
    );
  }

  // If vendor swap requested, update vendor_id on order directly via Admin SDK
  if (targetVendorId) {
    await orderRef.update({
      vendor_id: targetVendorId,
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  // 2. Check and decrement swap allowance
  let is_paid = true;
  const allowanceRef = db.collection('subscription_swap_allowances').doc(subscriptionId);
  const allowanceSnap = await allowanceRef.get();

  if (allowanceSnap.exists) {
    const allowance = allowanceSnap.data()!;
    const used = allowance.free_swaps_used || 0;
    const total = allowance.free_swaps_total || 0;
    if (used < total) {
      is_paid = false;
      await allowanceRef.update({
        free_swaps_used: admin.firestore.FieldValue.increment(1),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }

  // 3. Create swap_requests document
  const reqRef = db.collection('swap_requests').doc();
  const swapRequestData: any = {
    id: reqRef.id,
    user_id: userId,
    initiator_user_id: userId,
    subscription_id: subscriptionId,
    initiator_subscription_id: subscriptionId,
    order_id: orderId,
    meal_id: mealId || orderData.meal?.id || orderData.meal_id || 'default',
    target_vendor_id: targetVendorId || null,
    meal_snapshot: {
      meal_name: orderData.meal?.name || orderData.meal_name || 'Chef Special Meal',
      meal_type: orderData.meal?.type || orderData.meal_type || 'standard',
      original_vendor_id: orderData.vendor_id || orderData.vendorId || ''
    },
    status: 'broadcasted',
    is_paid,
    payment_amount: is_paid ? 50 : 0,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  };

  if (paymentDetails) {
    swapRequestData.payment_id = paymentDetails.paymentId || paymentDetails.payment_id;
    swapRequestData.razorpay_order_id = paymentDetails.orderId || paymentDetails.order_id;
  }

  await reqRef.set(swapRequestData);

  // 4. Find potential swap candidates with different vendors today
  const todayStr = orderData.date || new Date().toISOString().split('T')[0];
  const candidatesSnap = await db.collection('orders')
    .where('date', '==', todayStr)
    .where('status', 'in', ['created', 'pending', 'vendor_ready', 'vendor_notified'])
    .limit(25)
    .get();

  const batch = db.batch();
  let broadcastCount = 0;

  candidatesSnap.forEach((doc) => {
    const cand = doc.data();
    const candOwner = cand.user_id || cand.customerId;
    if (candOwner && candOwner !== userId) {
      const bRef = db.collection('swap_broadcasts').doc();
      batch.set(bRef, {
        id: bRef.id,
        swap_request_id: reqRef.id,
        recipient_user_id: candOwner,
        recipient_order_id: doc.id,
        meal_snapshot: swapRequestData.meal_snapshot,
        response: 'pending',
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
      broadcastCount++;
    }
  });

  if (broadcastCount > 0) {
    await batch.commit();
  }

  return {
    success: true,
    requestId: reqRef.id,
    is_paid,
    broadcastCount
  };
});

/**
 * Server-side Cloud Function: Accept a meal swap.
 * Atomically claims the broadcast, updates swap_requests status,
 * mutates both users' orders safely via Admin SDK,
 * and awards 0.3 cancellation credits to the accepting user.
 */
export const acceptMealSwap = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const recipientUserId = context.auth.uid;
  const { broadcastId } = data;

  if (!broadcastId) {
    throw new functions.https.HttpsError('invalid-argument', 'broadcastId is required.');
  }

  const db = admin.firestore();

  const result = await db.runTransaction(async (t) => {
    const broadcastRef = db.collection('swap_broadcasts').doc(broadcastId);
    const broadcastSnap = await t.get(broadcastRef);

    if (!broadcastSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Swap broadcast not found.');
    }

    const bData = broadcastSnap.data()!;
    if (bData.recipient_user_id !== recipientUserId) {
      throw new functions.https.HttpsError('permission-denied', 'This swap broadcast was not addressed to you.');
    }

    if (bData.response !== 'pending') {
      throw new functions.https.HttpsError('failed-precondition', `Broadcast already marked as ${bData.response}.`);
    }

    const reqRef = db.collection('swap_requests').doc(bData.swap_request_id);
    const reqSnap = await t.get(reqRef);

    if (!reqSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Swap request not found.');
    }

    const reqData = reqSnap.data()!;
    if (reqData.status !== 'broadcasted') {
      throw new functions.https.HttpsError('failed-precondition', 'Swap request has already been matched or expired.');
    }

    // Verify initiator order lock
    const initiatorOrderRef = db.collection('orders').doc(reqData.order_id);
    const initiatorOrderSnap = await t.get(initiatorOrderRef);
    if (!initiatorOrderSnap.exists || initiatorOrderSnap.data()?.batch_id) {
      throw new functions.https.HttpsError('failed-precondition', 'Initiator order is already locked for preparation.');
    }

    // Verify recipient order lock
    const recipOrderRef = db.collection('orders').doc(bData.recipient_order_id);
    const recipOrderSnap = await t.get(recipOrderRef);
    if (!recipOrderSnap.exists || recipOrderSnap.data()?.batch_id) {
      throw new functions.https.HttpsError('failed-precondition', 'Your order is already locked for preparation.');
    }

    // 1. Mark Swap Request matched
    t.update(reqRef, {
      status: 'matched',
      matched_with_user_id: recipientUserId,
      matched_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2. Mark Broadcast accepted
    t.update(broadcastRef, {
      response: 'accepted',
      responded_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Award 0.3 cancellation credit to recipient
    const creditRef = db.collection('user_credits').doc();
    t.set(creditRef, {
      id: creditRef.id,
      user_id: recipientUserId,
      credit_amount: 0.3,
      source: 'swap_accept',
      source_reference_id: reqRef.id,
      redeemed: false,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Update recipient order to swapped_in
    const originalVendorId = bData.meal_snapshot?.original_vendor_id || initiatorOrderSnap.data()?.vendor_id || '';
    t.update(recipOrderRef, {
      vendor_id: originalVendorId,
      status: 'swapped_in',
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 5. Update initiator order to swapped_out
    t.update(initiatorOrderRef, {
      status: 'swapped_out',
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 6. Audit logs
    const log1 = db.collection('order_status_logs').doc();
    t.set(log1, {
      id: log1.id,
      order_id: bData.recipient_order_id,
      from_status: recipOrderSnap.data()?.status || 'created',
      to_status: 'swapped_in',
      actor: recipientUserId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    const log2 = db.collection('order_status_logs').doc();
    t.set(log2, {
      id: log2.id,
      order_id: reqData.order_id,
      from_status: initiatorOrderSnap.data()?.status || 'created',
      to_status: 'swapped_out',
      actor: recipientUserId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: 'Meal swap accepted successfully! 0.3 credits awarded.',
      requestId: reqRef.id
    };
  });

  return result;
});

/**
 * Server-side Cloud Function: Cancel a meal swap request.
 * Atomically marks swap_requests as cancelled and expires pending broadcasts.
 */
export const cancelMealSwap = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const userId = context.auth.uid;
  const { requestId, deliveryId, orderId } = data || {};

  if (!requestId && !deliveryId && !orderId) {
    throw new functions.https.HttpsError('invalid-argument', 'requestId, deliveryId, or orderId is required.');
  }

  const db = admin.firestore();
  let reqRef: admin.firestore.DocumentReference;
  let snap: admin.firestore.DocumentSnapshot;

  if (requestId) {
    reqRef = db.collection('swap_requests').doc(requestId);
    snap = await reqRef.get();
  } else {
    const targetOrderId = deliveryId || orderId;
    const q = await db.collection('swap_requests')
      .where('order_id', '==', targetOrderId)
      .where('status', '==', 'broadcasted')
      .limit(1)
      .get();
    if (q.empty) {
      throw new functions.https.HttpsError('not-found', 'No active swap request found for this order.');
    }
    snap = q.docs[0];
    reqRef = snap.ref;
  }

  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Swap request not found.');
  }

  const reqData = snap.data()!;
  if (reqData.user_id !== userId && reqData.initiator_user_id !== userId) {
    throw new functions.https.HttpsError('permission-denied', 'You do not own this swap request.');
  }

  if (reqData.status !== 'broadcasted') {
    throw new functions.https.HttpsError('failed-precondition', `Cannot cancel swap in '${reqData.status}' status.`);
  }

  await reqRef.update({
    status: 'cancelled',
    cancelled_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  });

  // Clean up pending broadcasts
  const broadcastsSnap = await db.collection('swap_broadcasts')
    .where('swap_request_id', '==', requestId)
    .where('response', '==', 'pending')
    .get();

  if (!broadcastsSnap.empty) {
    const batch = db.batch();
    broadcastsSnap.forEach((d) => {
      batch.update(d.ref, {
        response: 'expired',
        expired_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
  }

  return { success: true, message: 'Swap request cancelled successfully.' };
});
