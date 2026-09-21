import {
  collection,
  doc,
  getDoc,
  getDocs,
  updateDoc,
  setDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  Timestamp,
  serverTimestamp,
  writeBatch,
  orderBy,
  runTransaction,
  limit,
  startAfter,
  type DocumentSnapshot,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@dabzzo/shared-auth';
import type { Delivery, DeliveryStatus as OldDeliveryStatus, StoredOrder } from '@dabzzo/shared-types';
import type { DeliveryOrder, DriverProfile, DeliveryStatus, RiderTrip, PickupStop, DropStop } from '@dabzzo/shared-types/delivery';
import { awardUserCredit, consumeUserCreditsTx } from './swaps';
import { createAuditLog } from './audit';
import { getErrorMessage } from '@dabzzo/shared-lib/errors';
import { readOrder } from './converters';

// ==========================================
// BACKWARD COMPATIBILITY LAYER FOR OLD FLIGHTS
// ==========================================

/**
 * Establishes a real-time Firestore listener for all active deliveries assigned to a specific delivery agent.
 * Excludes 'delivered' and 'failed_attempt' statuses.
 * @param deliveryBoyId The UID of the delivery agent.
 * @param callback Triggered with an array of active DeliveryOrders and a boolean indicating if the data is from the local cache.
 * @returns The unsubscribe function to tear down the listener.
 */
export function subscribeToAgentDeliveries(
  deliveryBoyId: string,
  callback: (orders: DeliveryOrder[], fromCache: boolean) => void
): () => void {
  // Simple query on a single field — no composite index required.
  const q = query(
    collection(db, 'orders'),
    where('driverId', '==', deliveryBoyId)
  );

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);

      const list = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            ...data,
            // Map canonical schema to legacy DeliveryOrder schema
            subscriptionId: data.subscription_id || data.subscriptionId,
            customerId: data.user_id || data.customerId,
            customerPhone: data.customer_phone || data.customerPhone || '',
            vendorId: data.vendor_id || data.vendorId,
            vendorPhone: data.vendor_phone || data.vendorPhone || '',
            driverId: data.driverId || data.rider_id || null,
            date: data.date || data.delivery_date,
            createdAt: data.created_at || data.createdAt,
            meal: data.meal || { type: data.meal_type || 'lunch', name: 'Tiffin' },
            address: data.address || data.delivery_address || { lat: 0, lng: 0, line1: '' },
            scheduledSlot: data.delivery_slot || data.scheduledSlot || '11am',
            status: data.status,
          } as unknown as DeliveryOrder;
        })
        .filter((order) => {
          // Filter to only include today's orders (by date string first, then fallback to createdAt)
          const orderDate = order.date || order.delivery_date;
          if (orderDate) {
            return orderDate === todayStr;
          }
          if (!order.createdAt) return false;
          const createdAt = order.createdAt as { seconds?: number } | string | Date;
          const timestamp = typeof createdAt === 'string'
            ? new Date(createdAt).getTime()
            : createdAt instanceof Date
              ? createdAt.getTime()
              : (createdAt?.seconds ?? 0) * 1000;
          return timestamp >= start.getTime() && timestamp <= end.getTime();
        })
        .sort((a, b) => {
          // Sort by createdAt ascending (oldest first)
          const aTime = a.createdAt?.seconds ?? 0;
          const bTime = b.createdAt?.seconds ?? 0;
          return aTime - bTime;
        });
      callback(list, snap.metadata.fromCache);
    }
  );
}


/**
 * Legacy update function to update location of a user.
 */
export async function updateDeliveryLocation(
  userId: string,
  lat: number,
  lng: number
): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    location: {
      lat,
      lng,
      updated_at: Date.now(),
    },
  });
}

/**
 * Legacy function to fetch deliveries for a vendor.
 */
export async function getVendorDeliveries(vendorId: string): Promise<Delivery[]> {
  const q = query(
    collection(db, 'deliveries'),
    where('vendor_id', '==', vendorId)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Delivery));
}

/**
 * Legacy function to fetch deliveries for a customer.
 */
export async function getUserDeliveries(userId: string): Promise<Delivery[]> {
  const q = query(
    collection(db, 'deliveries'),
    where('user_id', '==', userId)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Delivery));
}

// ==========================================
// MODERN DABZZO 2.0 DELIVERY ENGINE PIPELINE
// ==========================================

/**
 * Establishes a real-time Firestore listener on the customer's active delivery order for a specific date.
 * 
 * @param customerId - The customer's unique user identifier.
 * @param date - Target date string in 'YYYY-MM-DD' format.
 * @param callback - Triggered with the updated DeliveryOrder object or null if none found.
 * @returns The unsubscribe function to tear down the listener.
 */
export function subscribeToMyDelivery(
  customerId: string,
  date: string,
  callback: (order: DeliveryOrder | null) => void
): () => void {
  // Query by user_id and date string directly (canonical DBZ ARCH 2 schema)
  const q = query(
    collection(db, 'orders'),
    where('user_id', '==', customerId),
    where('date', '==', date)
  );

  return onSnapshot(q, (snap) => {
    if (snap.empty) {
      callback(null);
    } else {
      const d = snap.docs[0];
      const data = d.data();
      callback({
        id: d.id,
        ...data,
        subscriptionId: data.subscription_id || data.subscriptionId,
        customerId: data.user_id || data.customerId,
        customerPhone: data.customer_phone || data.customerPhone || '',
        vendorId: data.vendor_id || data.vendorId,
        vendorPhone: data.vendor_phone || data.vendorPhone || '',
        driverId: data.driverId || data.rider_id || null,
        createdAt: data.created_at || data.createdAt,
        meal: data.meal || { type: data.meal_type || 'lunch', name: 'Tiffin' },
        address: data.address || data.delivery_address || { lat: 0, lng: 0, line1: '' },
        scheduledSlot: data.delivery_slot || data.scheduledSlot || '11am',
        status: data.status,
      } as DeliveryOrder);
    }
  });
}

/**
 * Establishes a real-time tracking listener for all active/online delivery partners in the fleet.
 * Primarily designed for Admin dashboard overview maps.
 * 
 * @param callback - Triggered with an array of active DriverProfiles.
 * @returns The unsubscribe function to tear down the listener.
 */
export function subscribeToAllDriverLocations(
  callback: (drivers: DriverProfile[]) => void
): () => void {
  const q = query(
    collection(db, 'driver_profiles'),
    where('isActive', '==', true)
  );

  return onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => ({ uid: d.id, ...d.data() } as DriverProfile));
    callback(list);
  });
}

/**
 * Fetches all delivery orders registered for a specific vendor on a target day.
 * 
 * @param vendorId - The unique identifier of the vendor kitchen.
 * @param date - The target date string in 'YYYY-MM-DD' format.
 * @returns A promise resolving to an array of DeliveryOrders.
 */
export async function getVendorTodayOrders(
  vendorId: string,
  date: string
): Promise<DeliveryOrder[]> {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  // Query only by vendor_id (or vendorId) to avoid composite index requirement
  const q = query(
    collection(db, 'orders'),
    where('vendor_id', '==', vendorId)
  );

  const snap = await getDocs(q);
  
  let docs = snap.empty ? [] : snap.docs;
  
  // Try camelCase if snake_case is empty
  if (snap.empty) {
    const q2 = query(
      collection(db, 'orders'),
      where('vendorId', '==', vendorId)
    );
    const snap2 = await getDocs(q2);
    docs = snap2.docs;
  }
  
  const startTime = start.getTime();
  const endTime = end.getTime();
  
  return docs
    .map((d) => ({ id: d.id, ...d.data() } as DeliveryOrder))
    .filter((o: any) => {
      // In-memory date filtering: check canonical date string first
      const oDate = o.date || o.delivery_date;
      if (oDate) {
        return oDate === date;
      }
      const createdAt = o.createdAt || o.created_at;
      if (!createdAt) return false;
      
      let timeMs = 0;
      if (createdAt instanceof Date) timeMs = createdAt.getTime();
      else if (typeof createdAt === 'string') timeMs = new Date(createdAt).getTime();
      else if (createdAt.toDate && typeof createdAt.toDate === 'function') timeMs = createdAt.toDate().getTime();
      else if (createdAt.seconds) timeMs = createdAt.seconds * 1000;
      else if (createdAt._seconds) timeMs = createdAt._seconds * 1000;
      
      return timeMs >= startTime && timeMs <= endTime;
    });
}

// ─── Status buckets for preparation counting ─────────────────────────────────
const DISPATCHED_STATUSES = [
  'rider_assigned', 'rider_en_route_pickup', 'dispatched', 'picked_up', 'out_for_delivery',
];
const DELIVERED_STATUSES = ['delivered'];
const TERMINAL_EXCLUDED_STATUSES = ['completed', 'skipped', 'swapped_out', 'swapped_in', 'failed', 'cancelled'];

/**
 * "Today's Preparation" for a vendor — derived from REAL order documents.
 * Uses the composite index orders(vendor_id, date) instead of fetching every
 * historical order and filtering in memory.
 *
 * Because onSubscriptionCreated writes one document per tiffin (a 'both'
 * subscription emits a lunch doc and a dinner doc), count of documents == count
 * of tiffins. A document whose status is terminal (delivered/failed/cancelled/
 * skipped/swapped/completed) is excluded from "needs preparation".
 */
export async function getVendorPrepSummary(
  vendorId: string,
  date: string
): Promise<{
  total: number;            // today's tiffins after prep (non-terminal)
  needsPrep: number;        // not yet dispatched or delivered
  lunch: number;
  dinner: number;
  dispatched: number;
  delivered: number;
  cancelled: number;
  byStatus: Record<string, number>;
}> {
  const q = query(
    collection(db, 'orders'),
    where('vendor_id', '==', vendorId),
    where('date', '==', date)
  );

  const snap = await getDocs(q);

  if (snap.empty) {
    // Legacy camelCase fallback (same shape, non-indexed)
    const q2 = query(
      collection(db, 'orders'),
      where('vendorId', '==', vendorId),
      where('date', '==', date)
    );
    const snap2 = await getDocs(q2);
    return summarizeOrders(snap2.docs.map((d) => ({ id: d.id, ...d.data() })));
  }

  return summarizeOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}

function summarizeOrders(docs: any[]): ReturnType<typeof getVendorPrepSummary> extends Promise<infer T> ? T : never {
  const byStatus: Record<string, number> = {};
  let lunch = 0;
  let dinner = 0;
  let dispatched = 0;
  let delivered = 0;
  let cancelled = 0;

  for (const o of docs) {
    const status = String(o.status || 'created');
    byStatus[status] = (byStatus[status] || 0) + 1;

    const mealType = o.meal_type || o.mealType || o.meal?.type || o.scheduledSlot;
    if (mealType === 'both') {
      // A 'both' document represents one lunch + one dinner tiffin.
      lunch += 1;
      dinner += 1;
    } else if (mealType === 'dinner' || mealType === '8pm') {
      dinner += 1;
    } else {
      lunch += 1;
    }

    if (DISPATCHED_STATUSES.includes(status)) dispatched += 1;
    if (DELIVERED_STATUSES.includes(status)) delivered += 1;
    if (status === 'cancelled') cancelled += 1;
  }

  const needsPrep = docs.filter((o) =>
    !TERMINAL_EXCLUDED_STATUSES.includes(String(o.status || 'created'))
  ).length;

  return {
    total: docs.length,
    needsPrep,
    lunch,
    dinner,
    dispatched,
    delivered,
    cancelled,
    byStatus,
  };
}

/**
 * "Today's Preparation" — drill-down version of getVendorPrepSummary.
 * Returns the REAL order documents for the vendor's date so the vendor panel
 * can render a per-order breakdown (customer, meal, status, rider) instead of
 * only aggregate counts.
 */
export interface VendorPrepOrderRow {
  id: string;
  status: string;
  mealType: string | null;
  customerName: string | null;
  customerPhone: string | null;
  addressLine: string | null;
  vendorName: string | null;
  riderName: string | null;
  boxTag: string | null;
  createdAtMs: number | null;
}

export async function getVendorPrepDetails(
  vendorId: string,
  date: string
): Promise<{
  rows: VendorPrepOrderRow[];
  total: number;
  byStatus: Record<string, number>;
}> {
  const q = query(
    collection(db, 'orders'),
    where('vendor_id', '==', vendorId),
    where('date', '==', date)
  );

  const snap = await getDocs(q);
  if (snap.empty) {
    const q2 = query(
      collection(db, 'orders'),
      where('vendorId', '==', vendorId),
      where('date', '==', date)
    );
    const snap2 = await getDocs(q2);
    return buildPrepRows(snap2.docs.map((d) => ({ id: d.id, ...d.data() })));
  }

  return buildPrepRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}

function buildPrepRows(docs: any[]): ReturnType<typeof getVendorPrepDetails> extends Promise<infer T> ? T : never {
  const byStatus: Record<string, number> = {};
  const rows: VendorPrepOrderRow[] = docs.map((o) => {
    const status = String(o.status || 'created');
    byStatus[status] = (byStatus[status] || 0) + 1;

    let createdAtMs: number | null = null;
    const createdAt = o.created_at || o.createdAt;
    if (createdAt instanceof Date) createdAtMs = createdAt.getTime();
    else if (typeof createdAt?.toDate === 'function') createdAtMs = createdAt.toDate().getTime();
    else if (createdAt?.seconds) createdAtMs = createdAt.seconds * 1000;
    else if (createdAt?._seconds) createdAtMs = createdAt._seconds * 1000;
    else if (typeof createdAt === 'string' || typeof createdAt === 'number') {
      const t = new Date(createdAt).getTime();
      createdAtMs = Number.isNaN(t) ? null : t;
    }

    return {
      id: o.id,
      status,
      mealType: o.meal_type || o.mealType || o.meal?.type || o.scheduledSlot || null,
      customerName: o.customer_name || o.customerName || o.userName || null,
      customerPhone: o.customer_phone || o.customerPhone || o.phone || null,
      addressLine: o.address?.line1 || o.delivery_address?.line1 ||
        (typeof o.delivery_address === 'string' ? o.delivery_address : null) || null,
      vendorName: o.vendor_name || o.vendorName || null,
      riderName: o.rider_name || o.riderName || o.agentName || null,
      boxTag: o.box_tag || o.boxTag || null,
      createdAtMs,
    };
  });

  rows.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  return { rows, total: rows.length, byStatus };
}

/**
 * Dynamically updates the status of a delivery order and automatically logs corresponding event timestamps.
 * Also synchronizes the driver's current position to the order document once transit begins.
 * Supports backward compatibility for legacy 'deliveries' updates.
 * 
 * @param orderId - The target order identifier.
 * @param status - The new status state (compatible with new and legacy status structures).
 * @param driverId - Optional identifier of the assigned delivery partner.
 */
export async function updateDeliveryStatus(
  orderId: string,
  status: DeliveryStatus | OldDeliveryStatus,
  driverId: string | null = null
): Promise<void> {
  const orderRef = doc(db, 'orders', orderId);
  const orderSnap = await getDoc(orderRef);

  if (orderSnap.exists()) {
    let driverLocation = null;
    if (status === 'out_for_delivery' && driverId) {
      const driverDoc = await getDoc(doc(db, 'driver_profiles', driverId));
      if (driverDoc.exists()) {
        const driverData = driverDoc.data();
        if (driverData.currentLocation) {
          driverLocation = driverData.currentLocation;
        }
      }
    }

    const updateData: any = { status };

    // Set correct timeline audit stamps depending on the status transition
    if (status === 'preparing') updateData['timestamps.preparedAt'] = Timestamp.now();
    if (status === 'picked_up') updateData['timestamps.pickedAt'] = Timestamp.now();
    if (status === 'out_for_delivery') {
      updateData['timestamps.outAt'] = Timestamp.now();
      if (driverLocation) {
        updateData.driverLocation = driverLocation;
      }
    }
    if (status === 'delivered') updateData['timestamps.deliveredAt'] = Timestamp.now();

    await updateDoc(orderRef, updateData);
  } else {
    // Fallback to legacy deliveries collection
    await updateDoc(doc(db, 'deliveries', orderId), {
      status,
      updated_at: Timestamp.now(),
    });
  }
}

/**
 * Reassigns a delivery order to a new driver.
 * 
 * @param orderId - The target order identifier.
 * @param newDriverId - The unique identifier of the new delivery partner.
 */
export async function reassignDriver(
  orderId: string,
  newDriverId: string
): Promise<void> {
  const orderRef = doc(db, 'orders', orderId);
  await updateDoc(orderRef, {
    driverId: newDriverId,
    updatedAt: Timestamp.now()
  });
}

/**
 * Updates a driver's live GPS coordinates in their dedicated fleet profile.
 * 
 * @param driverId - The unique authentication identifier of the driver.
 * @param lat - Decimal latitude.
 * @param lng - Decimal longitude.
 */
export async function updateDriverLocation(
  driverId: string,
  lat: number,
  lng: number
): Promise<void> {
  await setDoc(doc(db, 'driver_profiles', driverId), {
    currentLocation: {
      lat,
      lng,
      updatedAt: Timestamp.now(),
    },
  }, { merge: true });
}

/**
 * Verifies a customer's delivery OTP. If correct, transitions the order status to 'delivered'
 * and records completion timestamps.
 * 
 * @param orderId - The target order identifier.
 * @param enteredOTP - The 4-digit code provided by the customer.
 * @returns Object indicating success status or error details.
 */
export async function verifyDeliveryOTP(
  orderId: string,
  enteredOTP: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const orderRef = doc(db, 'orders', orderId);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return { success: false, error: 'Order not found' };
    }

    const orderData = orderSnap.data() as DeliveryOrder;
    if (orderData.otp !== enteredOTP) {
      return { success: false, error: 'Incorrect OTP' };
    }

    await updateDoc(orderRef, {
      otpVerified: true,
      status: 'delivered',
      'timestamps.deliveredAt': Timestamp.now(),
    });

    return { success: true };
  } catch (e: unknown) {
    return { success: false, error: getErrorMessage(e) || 'OTP verification failed' };
  }
}

/**
 * Batch updates all active meal orders for a given vendor on a specific date to the "picked_up" state.
 * Usually executed when a vendor hands over a bulk batch of prepared boxes to a driver.
 * 
 * @param vendorId - The unique identifier of the vendor kitchen.
 * @param date - The target date string in 'YYYY-MM-DD' format.
 */
export async function markVendorOrdersReady(
  vendorId: string,
  date: string
): Promise<void> {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  let q = query(
    collection(db, 'orders'),
    where('vendor_id', '==', vendorId)
  );
  let snap = await getDocs(q);
  if (snap.empty) {
    q = query(
      collection(db, 'orders'),
      where('vendorId', '==', vendorId)
    );
    snap = await getDocs(q);
  }
  if (snap.empty) return;

  const batch = writeBatch(db);
  let count = 0;
  snap.docs.forEach((d) => {
    const data = d.data();
    const oDate = data.date || data.delivery_date;
    if (oDate) {
      if (oDate !== date) return;
    } else {
      const createdAt = data.createdAt || data.created_at;
      if (!createdAt) return;
      const timeMs = createdAt?.toDate ? createdAt.toDate().getTime() : (createdAt?.seconds ? createdAt.seconds * 1000 : new Date(createdAt).getTime());
      if (timeMs < start.getTime() || timeMs > end.getTime()) return;
    }

    if (['delivered', 'cancelled', 'failed', 'swapped_out'].includes(data.status)) return;

    batch.update(d.ref, {
      status: 'picked_up',
      'timestamps.pickedAt': Timestamp.now(),
    });

    // Add driver notification
    const notifRef = doc(collection(db, 'orders', d.id, 'notifications'));
    batch.set(notifRef, {
      orderId: d.id,
      type: 'ready_for_pickup',
      message: `Your assigned batch #${d.id.slice(-4).toUpperCase()} from the kitchen is ready for handover!`,
      createdAt: Timestamp.now(),
    });
    count++;
  });

  if (count > 0) {
    await batch.commit();
  }
}

/**
 * Retrieves aggregate delivery statistics filtered by status for administrative audit.
 * 
 * @param date - The target audit date in 'YYYY-MM-DD' format.
 * @returns An object matching status keys to daily item counts.
 */
export async function getAdminDeliveryOverview(
  date: string
): Promise<Record<string, number>> {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const overview: Record<string, number> = {
    preparing: 0,
    picked_up: 0,
    out_for_delivery: 0,
    delivered: 0,
    failed: 0,
  };

  const seenIds = new Set<string>();

  // Primary: query by canonical date
  try {
    const qDate = query(
      collection(db, 'orders'),
      where('date', '==', date)
    );
    const snapDate = await getDocs(qDate);
    snapDate.docs.forEach((d) => {
      seenIds.add(d.id);
      const status = d.data().status as string;
      if (status && status in overview) {
        overview[status]++;
      }
    });
  } catch (err) {
    console.warn('Error querying orders by date in getAdminDeliveryOverview:', err);
  }

  // Secondary fallback: query by createdAt for legacy orders without date field
  try {
    const qCreated = query(
      collection(db, 'orders'),
      where('createdAt', '>=', Timestamp.fromDate(start)),
      where('createdAt', '<=', Timestamp.fromDate(end))
    );
    const snapCreated = await getDocs(qCreated);
    snapCreated.docs.forEach((d) => {
      if (seenIds.has(d.id)) return;
      seenIds.add(d.id);
      const data = d.data();
      if (data.date && data.date !== date) return;
      const status = data.status as string;
      if (status && status in overview) {
        overview[status]++;
      }
    });
  } catch (err) {
    console.warn('Error querying orders by createdAt in getAdminDeliveryOverview:', err);
  }

  return overview;
}

interface DelayPayload {
  reason: string;
  message?: string;
  newETA: string;
}

/**
 * Broadcasts a delay notification to all subscribers who have active deliveries today.
 * Inserts a notification record into each active order's subcollection.
 * 
 * @param vendorId - The unique identifier of the vendor.
 * @param payload - The details of the delay including reason, optional custom text, and new ETA.
 */
export async function sendDelayNotification(
  vendorId: string,
  payload: DelayPayload
): Promise<void> {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  // Get active delivery orders (where status is preparing, picked_up, or out_for_delivery)
  let q = query(
    collection(db, 'orders'),
    where('vendor_id', '==', vendorId),
    where('status', 'in', ['preparing', 'picked_up', 'out_for_delivery', 'vendor_ready', 'rider_assigned'])
  );
  let snap = await getDocs(q);
  if (snap.empty) {
    q = query(
      collection(db, 'orders'),
      where('vendorId', '==', vendorId),
      where('status', 'in', ['preparing', 'picked_up', 'out_for_delivery', 'vendor_ready', 'rider_assigned'])
    );
    snap = await getDocs(q);
  }
  if (snap.empty) return;

  const batch = writeBatch(db);
  let count = 0;
  snap.docs.forEach((docSnap) => {
    const data = docSnap.data();
    const orderDate = data.date || data.delivery_date;
    if (orderDate) {
      if (orderDate !== todayStr) return;
    } else {
      const createdAt = data.createdAt || data.created_at;
      if (!createdAt) return;
      const timeMs = createdAt?.toDate ? createdAt.toDate().getTime() : (createdAt?.seconds ? createdAt.seconds * 1000 : new Date(createdAt).getTime());
      if (timeMs < start.getTime() || timeMs > end.getTime()) return;
    }
    count++;
    // Generate a reference for the notifications subcollection
    const notifRef = doc(collection(db, 'orders', docSnap.id, 'notifications'));
    batch.set(notifRef, {
      orderId: docSnap.id,
      type: 'delay_alert',
      message: `Delay Alert (${payload.reason}): ${payload.message || 'Apologies for the delay.'} Estimated arrival: ${payload.newETA}`,
      createdAt: Timestamp.now(),
    });
  });

  if (count > 0) {
    await batch.commit();
  }
}

/**
 * Broadcasts a proximity notification to the customer when the driver is approaching.
 * 
 * @param orderId - The target order identifier.
 * @param etaMinutes - The estimated minutes until arrival.
 */
export async function sendProximityAlert(
  orderId: string,
  etaMinutes: number
): Promise<void> {
  const notifRef = doc(collection(db, 'orders', orderId, 'notifications'));
  await setDoc(notifRef, {
    orderId,
    type: 'driver_approaching',
    message: `Your driver is nearby! Arriving in approximately ${etaMinutes} minutes.`,
    createdAt: Timestamp.now(),
  });
}

/**
 * Triggers an alert to the admin/driver when a vendor is significantly delayed handing over meals.
 * 
 * @param vendorId - The unique identifier of the vendor.
 * @param batchId - The id of the delayed order.
 */
export async function sendVendorDelayAlert(
  vendorId: string,
  batchId: string
): Promise<void> {
  const notifRef = doc(collection(db, 'orders', batchId, 'notifications'));
  await setDoc(notifRef, {
    orderId: batchId,
    vendorId,
    type: 'vendor_delayed_handover',
    message: `Vendor handover is delayed for batch #${batchId.slice(-4).toUpperCase()}.`,
    createdAt: Timestamp.now(),
  });
}

/**
 * Reassigns an active delivery order to a new driver.
 * 
 * @param orderId - The unique identifier of the target delivery order.
 * @param newDriverId - The target driver UID.
 */
export async function reassignDelivery(orderId: string, newDriverId: string): Promise<void> {
  const orderRef = doc(db, 'orders', orderId);
  await updateDoc(orderRef, {
    driverId: newDriverId,
    rider_id: newDriverId,
    rider_trip_id: null,
    driverLocation: null, // Reset live marker tracking
  });
}

/**
 * Flags a delivery order as failed and registers a resolution explanation log.
 * 
 * @param orderId - The unique identifier of the target delivery order.
 * @param reason - Detailed cancellation/failure reason explanation text.
 */
export async function markDeliveryFailed(orderId: string, reason: string): Promise<void> {
  const orderRef = doc(db, 'orders', orderId);
  await updateDoc(orderRef, {
    status: 'failed',
    failureReason: reason,
    'timestamps.failedAt': Timestamp.now(),
  });
}

/**
 * Cancels a missed order and reschedules an identical shipment for tomorrow's dispatch session.
 * 
 * @param orderId - The unique identifier of the target delivery order.
 */
export async function rescheduleDelivery(orderId: string): Promise<void> {
  const orderRef = doc(db, 'orders', orderId);
  const orderSnap = await getDoc(orderRef);
  if (!orderSnap.exists()) {
    throw new Error('Delivery order does not exist in collection.');
  }

  const data = readOrder(orderSnap)!;

  // Calculate tomorrow's exact date bounds
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // Generate a clean transaction record in the orders stream with canonical fields
  const newOrderRef = doc(collection(db, 'orders'));
  await setDoc(newOrderRef, {
    ...data,
    id: newOrderRef.id,
    user_id: data.user_id || data.customerId || '',
    customerId: data.customerId || data.user_id || '',
    vendor_id: data.vendor_id || data.vendorId || '',
    vendorId: data.vendorId || data.vendor_id || '',
    date: tomorrowStr,
    driverId: null, // Reset driver allocation
    driverLocation: null,
    status: 'preparing',
    otp: Math.floor(1000 + Math.random() * 9000).toString(), // New fresh OTP for tomorrow
    otpVerified: false,
    timestamps: {
      preparedAt: null,
      pickedAt: null,
      outAt: null,
      deliveredAt: null,
    },
    createdAt: Timestamp.fromDate(tomorrow),
    created_at: Timestamp.fromDate(tomorrow),
  });
}

// ==========================================
// ADMIN: GENERATE TODAY'S DELIVERY BATCH
// ==========================================

export interface GenerateResult {
  created: number;
  skipped: number;
  errors: number;
  details: { subId: string; userName: string; status: 'created' | 'skipped' | 'error'; reason?: string }[];
}

/**
 * Reads all active subscriptions and creates a delivery_order for each one today
 * if one doesn't already exist.
 *
 * @param force - When true, bypasses the duplicate-order guard and creates fresh orders
 *                even if orders already exist for today. Useful for testing / re-generation.
 * @returns Summary object showing how many orders were created, skipped (already exist), or errored.
 */
export async function generateTodayDeliveries(force = false): Promise<GenerateResult> {
  try {
    const generateFn = httpsCallable<{ force: boolean }, GenerateResult>(functions, 'generateTodayDeliveries');
    const result = await generateFn({ force });
    return result.data;
  } catch (err: unknown) {
    console.error('generateTodayDeliveries Error:', err);
    throw err;
  }
}

export async function generateTestDeliveryFn(): Promise<any> {
  try {
    const generateTest = httpsCallable<any, any>(functions, 'generateTestDelivery');
    const result = await generateTest({});
    return result.data;
  } catch (err: unknown) {
    console.error('generateTestDelivery Error:', err);
    throw err;
  }
}

export async function forceAssignRiders(vendorId?: string, slot?: string): Promise<any> {
  try {
    const assignFn = httpsCallable<any, any>(functions, 'assignRiderTrips');
    const result = await assignFn({ vendorId, slot });
    return result.data;
  } catch (err: unknown) {
    console.error('forceAssignRiders Error:', err);
    throw err;
  }
}

export async function forceFormBatches(): Promise<{ success: boolean; batchesCreated: number, debugStr?: string }> {
  try {
    const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0];
    
    // Instead of querying strictly by `date`, we fetch orders that need batching
    // (i.e. not delivered, not failed, and typically missing a batch_id).
    // We'll query orders that are 'created', 'preparing', or 'vendor_ready'
    const q1 = query(collection(db, 'orders'), where('status', '==', 'created'));
    const q2 = query(collection(db, 'orders'), where('status', '==', 'preparing'));
    const q3 = query(collection(db, 'orders'), where('status', '==', 'vendor_ready'));
    
    const [snap1, snap2, snap3] = await Promise.all([getDocs(q1), getDocs(q2), getDocs(q3)]);
    
    const allDocs = [...snap1.docs, ...snap2.docs, ...snap3.docs];
    
    if (allDocs.length === 0) {
      return { success: true, batchesCreated: 0, debugStr: `No eligible unbatched orders found for date ${todayStr}` };
    }

    const vendorOrders = new Map<string, any[]>();
    let unbatchedCount = 0;
    
    allDocs.forEach(doc => {
      const order = doc.data();
      // Only batch orders for today that don't already have a valid batch
      if (order.date && order.date !== todayStr) return;
      if (!order.batch_id || order.batch_id.trim() === '') {
        unbatchedCount++;
        const vId = order.vendor_id || order.vendorId;
        if (vId) {
          if (!vendorOrders.has(vId)) vendorOrders.set(vId, []);
          vendorOrders.get(vId)!.push({ id: doc.id, ...order });
        }
      }
    });

    if (unbatchedCount === 0) {
       return { success: true, batchesCreated: 0, debugStr: `Found ${allDocs.length} active orders, but all already have a batch_id!` };
    }

    const batch = writeBatch(db);
    let batchesCreated = 0;

    for (const [vendorId, orders] of Array.from(vendorOrders.entries())) {
      const slot = orders[0].delivery_slot || '11am';
      const batchId = `BATCH-${vendorId}-${todayStr}-${slot}-${Date.now()}`;
      const batchRef = doc(db, 'batches', batchId);
      
      const orderIds = orders.map(o => o.id);
      
      batch.set(batchRef, {
        id: batchId,
        vendor_id: vendorId,
        date: todayStr,
        slot: slot,
        order_ids: orderIds,
        status: 'notified',
        total_count: orderIds.length,
        last_notified_count: orderIds.length,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp()
      });

      orders.forEach(o => {
        const orderRef = doc(db, 'orders', o.id);
        batch.update(orderRef, {
          batch_id: batchId,
          // If they were already vendor_ready, keep them vendor_ready, otherwise vendor_notified
          status: o.status === 'vendor_ready' ? 'vendor_ready' : 'vendor_notified',
          updated_at: serverTimestamp()
        });
      });
      batchesCreated++;
    }

    await batch.commit();
    return { success: true, batchesCreated, debugStr: `Batched ${unbatchedCount} orders into ${batchesCreated} batches.` };
  } catch (err: unknown) {
    console.error('forceFormBatches Error:', err);
    throw err;
  }
}


// ==========================================
// USER: CANCEL SCHEDULED TIFFIN (SKIP DAY)
// ==========================================
export async function cancelScheduledTiffin(delivery: any, userId: string): Promise<{ success: boolean; creditsEarned: number }> {
  // Canonical orders ref
  let deliveryRef = doc(db, 'orders', delivery.id);
  const snap = await getDoc(deliveryRef);
  const isLegacy = false;

  let data: any = {};
  let isNewProjected = false;

  if (!snap.exists()) {
    if (delivery.isProjected) {
      // It's a projected order that doesn't exist yet, so we create it as skipped.
      isNewProjected = true;
      deliveryRef = doc(collection(db, 'orders')); // Create in canonical collection
      data = {
        ...delivery,
        id: deliveryRef.id,
        user_id: userId,
        customerId: userId,
        status: 'pending',
        createdAt: delivery.createdAt || serverTimestamp(),
        created_at: delivery.createdAt || serverTimestamp(),
      };
    } else {
      throw new Error('Order not found.');
    }
  } else {
    data = readOrder(snap)!;
  }

  if (data.user_id && data.user_id !== userId) throw new Error('Unauthorized.');
  if (data.customerId && data.customerId !== userId) throw new Error('Unauthorized.');
  
  const currentStatus = data.status || 'scheduled';
  const batchId = data.batch_id;
  // Normalize scheduled slot (support both code paths: scheduledSlot or delivery_slot)
  const scheduledSlot = data.scheduledSlot || data.delivery_slot || delivery.scheduledSlot || delivery.delivery_slot;

  if (['swapped_out', 'swapped_in', 'skipped', 'picked_up', 'out_for_delivery', 'delivered', 'completed', 'failed'].includes(currentStatus)) {
    throw new Error(`Cannot skip delivery in status: ${currentStatus}`);
  }

  const now = new Date();
  let deliveryDate = new Date();
  
  // Extract delivery date robustly
  if (data.date) {
    // If it's a date string, handle timezone safely by appending time
    deliveryDate = typeof data.date === 'string' && data.date.length === 10 
      ? new Date(data.date + 'T00:00:00') 
      : new Date(data.date);
  } else if (data.createdAt?.toDate) {
    deliveryDate = data.createdAt.toDate();
  } else if (data.created_at?.toDate) {
    deliveryDate = data.created_at.toDate();
  } else if (delivery.createdAt?.toDate) {
    deliveryDate = delivery.createdAt.toDate();
  }
  
  if (scheduledSlot === '8am') {
    deliveryDate.setHours(8, 0, 0, 0);
  } else if (scheduledSlot === '11am') {
    deliveryDate.setHours(11, 0, 0, 0);
  } else if (scheduledSlot === '8pm') {
    deliveryDate.setHours(20, 0, 0, 0);
  } else if (scheduledSlot === '13' || scheduledSlot === '1pm' || scheduledSlot === 'lunch') {
    deliveryDate.setHours(13, 0, 0, 0);
  } else {
    // default to 13:00 for lunch-like slots
    deliveryDate.setHours(13, 0, 0, 0);
  }

  const hoursRemaining = (deliveryDate.getTime() - now.getTime()) / (1000 * 60 * 60);
  
  if (hoursRemaining < 4 && !batchId) {
    if (hoursRemaining < 0) {
      throw new Error('Delivery time has already passed.');
    }
  }

  // Tiered credit logic: 0.5 before 12hrs, 0.2 after, no hard cutoff (if batched, allowed up to delivery)
  const creditsEarned = hoursRemaining >= 12 ? 0.5 : 0.2;

  // Use the original delivery.id (projected ids) as the source_reference if available so undo/lookup can match UI-projected skips
  const sourceRefId = delivery?.id || deliveryRef.id;

  await awardUserCredit({
    user_id: userId,
    credit_amount: creditsEarned,
    source: 'cancellation',
    source_reference_id: sourceRefId,
  });

  // Handle Batch logic if order was locked
  if (batchId) {
    // 1. Decrement batch count
    const batchRef = doc(db, 'batches', batchId);
    try {
       const batchSnap = await getDoc(batchRef);
       if (batchSnap.exists()) {
         const currentCount = batchSnap.data().total_count || 0;
         await updateDoc(batchRef, {
           total_count: Math.max(0, currentCount - 1),
           updated_at: serverTimestamp()
         });
       }
    } catch (err) {
       console.error("Failed to decrement batch:", err);
    }
  }

  if (isNewProjected) {
    await setDoc(deliveryRef, {
      ...data,
      status: 'skipped',
      updatedAt: serverTimestamp(),
      date: delivery.date,
      // Store both naming conventions for compatibility with front-end and legacy code
      delivery_slot: scheduledSlot,
      scheduledSlot: scheduledSlot,
    });
  } else {
    await updateDoc(deliveryRef, {
      status: 'skipped',
      updatedAt: serverTimestamp()
    });
  }
  
  // Create OrderStatusLog
  const logRef = doc(collection(db, 'order_status_logs'));
  await setDoc(logRef, {
    id: logRef.id,
    order_id: deliveryRef.id,
    from_status: currentStatus,
    to_status: 'skipped',
    actor: userId,
    timestamp: serverTimestamp()
  });

  await createAuditLog('delivery_cancelled', userId, undefined, creditsEarned, { orderId: deliveryRef.id });

  return { success: true, creditsEarned };
}

export async function undoSkipScheduledTiffin(delivery: any, userId: string): Promise<{ success: boolean; mode: 'credit' | 'day' }> {
  // Canonical orders ref
  const deliveryRef = doc(db, 'orders', delivery.id);
  const snap = await getDoc(deliveryRef);

  if (!snap.exists()) {
    throw new Error('Order not found.');
  }
  
  const data = readOrder(snap)!;
  if (data.user_id && data.user_id !== userId) throw new Error('Unauthorized.');
  if (data.customerId && data.customerId !== userId) throw new Error('Unauthorized.');

  if (data.status !== 'skipped') {
    throw new Error(`Order is not skipped. Current status: ${data.status}`);
  }

  // ── Time constraint: only block if delivery time has already passed ────────
  const now = new Date();
  let deliveryMoment = new Date();
  
  if (data.date) {
    deliveryMoment = typeof data.date === 'string' && data.date.length === 10
      ? new Date(data.date + 'T00:00:00')
      : new Date(data.date);
  } else if (data.createdAt?.toDate) {
    deliveryMoment = data.createdAt.toDate();
  } else if (data.created_at?.toDate) {
    deliveryMoment = data.created_at.toDate();
  } else if (delivery.createdAt?.toDate) {
    deliveryMoment = delivery.createdAt.toDate();
  }
  
  const scheduledSlot = data.scheduledSlot || data.delivery_slot || delivery.scheduledSlot || delivery.delivery_slot;
  if (scheduledSlot === '8am') deliveryMoment.setHours(8, 0, 0, 0);
  else if (scheduledSlot === '11am') deliveryMoment.setHours(11, 0, 0, 0);
  else if (scheduledSlot === '8pm') deliveryMoment.setHours(20, 0, 0, 0);
  else if (scheduledSlot === '13' || scheduledSlot === '1pm' || scheduledSlot === 'lunch') deliveryMoment.setHours(13, 0, 0, 0);
  else deliveryMoment.setHours(13, 0, 0, 0);

  if (deliveryMoment.getTime() < now.getTime()) {
    throw new Error('Cannot undo a skip — the delivery time has already passed.');
  }

  // 1. Fetch unredeemed credits OUTSIDE transaction
  const q = query(
    collection(db, 'user_credits'),
    where('user_id', '==', userId),
    where('redeemed', '==', false)
  );
  const unredeemedSnap = await getDocs(q);
  const candidateRefs = unredeemedSnap.docs.map(d => d.ref);

  // 2. Fetch the specific credit awarded for this skip
  const allCreditsSnap = await getDocs(
    query(collection(db, 'user_credits'), where('user_id', '==', userId))
  );

  let skipCreditDoc = allCreditsSnap.docs.find(d => d.data().source_reference_id === delivery.id) ?? null;
  if (!skipCreditDoc) {
    const deliveryDateStr = deliveryMoment.toLocaleDateString('en-CA');
    skipCreditDoc = allCreditsSnap.docs.find(d => {
      const cData = d.data();
      if (cData.source !== 'cancellation') return false;
      const ca = cData.created_at?.toDate?.() ?? cData.createdAt?.toDate?.();
      if (!ca) return false;
      return ca.toLocaleDateString('en-CA') === deliveryDateStr;
    }) ?? null;
  }

  const creditsToRepay = skipCreditDoc ? (skipCreditDoc.data().credit_amount || 0.5) : 0.5;

  const subId = data.subscription_id ?? null;
  let subRef: ReturnType<typeof doc> | null = null;

  if (subId) {
    const directSnap = await getDocs(
      query(collection(db, 'subscriptions'),
        where('user_id', '==', userId),
        where('status', '==', 'active'))
    );
    const matchedDoc = directSnap.docs.find(d => d.id === subId) ?? directSnap.docs[0] ?? null;
    if (matchedDoc) subRef = matchedDoc.ref;
  }
  if (!subRef) {
    const subSnap = await getDocs(
      query(collection(db, 'subscriptions'),
        where('user_id', '==', userId),
        where('status', '==', 'active'))
    );
    if (!subSnap.empty) subRef = subSnap.docs[0].ref;
  }

  let mode: 'credit' | 'day' = 'credit';

  await runTransaction(db, async (transaction) => {
    // Fetch fresh data inside transaction
    const creditDocs = [];
    let totalUnredeemed = 0;
    
    for (const ref of candidateRefs) {
      const docSnap = await transaction.get(ref);
      if (docSnap.exists() && docSnap.data().redeemed === false) {
        const docData = docSnap.data();
        creditDocs.push({ ref, data: docData });
        totalUnredeemed += docData.credit_amount;
      }
    }

    const useCredit = totalUnredeemed >= creditsToRepay;
    mode = useCredit ? 'credit' : 'day';

    let subData: Record<string, any> | null = null;
    if (subRef) {
      const subSnap = await transaction.get(subRef);
      if (subSnap.exists()) subData = subSnap.data();
    }

    const newStatus = data.batch_id ? 'vendor_ready' : 'pending';
    transaction.update(deliveryRef, {
      status: newStatus,
      updatedAt: serverTimestamp(),
    });
    
    const logRef = doc(collection(db, 'order_status_logs'));
    transaction.set(logRef, {
      id: logRef.id,
      order_id: delivery.id,
      from_status: 'skipped',
      to_status: newStatus,
      actor: userId,
      timestamp: serverTimestamp()
    });

    if (useCredit) {
      const consumed = consumeUserCreditsTx(transaction, creditsToRepay, creditDocs);
      if (!consumed) throw new Error("Insufficient credits during transaction.");
    } else {
      if (subRef && subData) {
        let nextBilling: Date = subData.next_billing_date?.toDate?.() ?? null;
        if (!nextBilling) {
          const created = subData.created_at?.toDate?.() ?? new Date();
          nextBilling = new Date(created);
          nextBilling.setDate(nextBilling.getDate() + (subData.frequency === 'monthly' ? 30 : 7));
        }

        const adjusted = new Date(nextBilling);
        adjusted.setDate(adjusted.getDate() - 1);
        transaction.update(subRef, {
          next_billing_date: Timestamp.fromDate(adjusted),
          updated_at: serverTimestamp(),
        });

        if (1 - creditsToRepay > 0) {
          const refundRef = doc(collection(db, 'user_credits'));
          transaction.set(refundRef, {
            user_id: userId,
            source: 'cancel_skip_refund',
            credit_amount: 1 - creditsToRepay,
            redeemed: false,
            created_at: serverTimestamp(),
            source_reference_id: delivery.id,
          });
        }
      }
    }
  });

  await createAuditLog('undo_skip', userId, undefined, mode === 'credit' ? -creditsToRepay : (1 - creditsToRepay), { orderId: delivery.id });
  return { success: true, mode };
}

/**
 * Subscribes to the active RiderTrip for a specific driver.
 */
export function subscribeToActiveRiderTrip(
  driverId: string,
  callback: (trip: RiderTrip | null) => void
): () => void {
  const q = query(
    collection(db, 'rider_trips'),
    where('riderId', '==', driverId),
    where('status', 'in', ['pickup_pending', 'picking_up', 'pickup_complete', 'dropping'])
  );

  return onSnapshot(q, (snap) => {
    if (snap.empty) {
      callback(null);
    } else {
      const d = snap.docs[0];
      callback({ id: d.id, ...d.data() } as RiderTrip);
    }
  });
}

/**
 * Updates a RiderTrip document.
 */
export async function updateRiderTrip(
  tripId: string,
  updateData: Partial<RiderTrip>
): Promise<void> {
  const tripRef = doc(db, 'rider_trips', tripId);
  await updateDoc(tripRef, { ...updateData, updatedAt: serverTimestamp() });
}
