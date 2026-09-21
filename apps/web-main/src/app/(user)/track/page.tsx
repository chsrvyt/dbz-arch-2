'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { isSubscriptionActive, isSubscriptionExpired } from '@dabzzo/shared-lib/subscriptionEntitlement';
import { isLiveStatus, DELIVERED_STATUSES } from '@dabzzo/shared-lib/orderLifecycle';
import { db } from '@/lib/firebase';
import { isSuperadminEmail } from '@/lib/auth/auth-service';
import {
  collection, query, orderBy, onSnapshot, where, doc, getDoc, limit,
} from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { Loader2, Clock, Bell, AlertTriangle, Package, Navigation, MapPin, Crown, RotateCcw } from 'lucide-react';
import dynamic from 'next/dynamic';

const RiderTrackingCard = dynamic(
  () => import('@/components/delivery/RiderTrackingCard').then(m => ({ default: m.RiderTrackingCard })),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 bg-slate-100 rounded-3xl animate-pulse" />
        ))}
      </div>
    ),
  }
);
import { motion, AnimatePresence } from 'framer-motion';
import { DeliveryCompleteCard } from '@/components/delivery/DeliveryCompleteCard';
import { generateBoxTag } from '@/lib/boxTag';

/* ─── helpers ──────────────────────────────────────────────────────────────── */

const SLOT_HOURS: Record<string, number> = {
  '8am': 8,
  '11am': 11,
  '8pm': 20,
};

function getSlotTime(order: any): Date {
  let base: Date;
  if (order.date) {
    const [y, m, d] = order.date.split('-');
    base = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  } else {
    base = order.createdAt?.toDate
      ? order.createdAt.toDate()
      : order.createdAt?.seconds
      ? new Date(order.createdAt.seconds * 1000)
      : new Date();
  }

  const d = new Date(base);
  const slot = order.scheduledSlot as string | undefined;
  if (slot && SLOT_HOURS[slot] !== undefined) {
    d.setHours(SLOT_HOURS[slot], 0, 0, 0);
  } else if (order.meal?.type === 'lunch') {
    d.setHours(11, 0, 0, 0);
  } else {
    d.setHours(20, 0, 0, 0);
  }
  return d;
}

// Haversine distance in km
function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
}

function getOrderETA(order: any, riderTrip?: any, driverLocation?: {lat: number, lng: number}) {
  const status = order.status || 'pending';
  
  if (['delivered', 'completed'].includes(status)) {
    return { type: 'done', label: 'Delivered' };
  }
  if (['skipped', 'swapped_out', 'failed'].includes(status)) {
    return { type: 'inactive', label: status === 'skipped' ? 'Skipped' : status === 'failed' ? 'Failed' : 'Swapped' };
  }
  if (['rider_assigned', 'rider_en_route_pickup', 'picked_up'].includes(status)) {
    return { type: 'coarse', label: 'Rider assigned' };
  }
  if (status === 'out_for_delivery') {
    if (riderTrip?.dropStops && driverLocation) {
      const dropStop = riderTrip.dropStops.find((s: any) => s.orderId === order.id || s.orderId === order.legacy_order_id);
      if (dropStop?.location) {
        const distKm = getDistanceKm(driverLocation.lat, driverLocation.lng, dropStop.location.lat, dropStop.location.lng);
        // Assume ~20km/h average urban speed = 3 min per km
        const mins = Math.ceil(distKm * 3);
        if (mins <= 1) return { type: 'live', label: 'Arriving soon' };
        return { type: 'live', label: `~${mins}m away` };
      }
    }
    return { type: 'coarse', label: 'Out for delivery' };
  }
  
  // Default: 'created' | 'vendor_notified' | 'vendor_preparing' | 'vendor_ready' | 'pending'
  const slotTime = getSlotTime(order);
  const timeString = slotTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  return { type: 'scheduled', label: timeString };
}

/**
 * Live/done status sets come from the shared order-lifecycle source of truth
 * instead of a hand-rolled list. Formerly `created`/`ready`/`dispatched` etc.
 * were missing here, so a real today-dated order showed "No Active Delivery".
 */
const DONE_STATUSES = [...(DELIVERED_STATUSES as string[]), 'failed'];

function resolveDeliveredAt(order: any): Date | null {
  const ts = order?.deliveredAt || order?.delivered_at || order?.timestamps?.deliveredAt;
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof ts === 'object' && 'seconds' in ts) return new Date(ts.seconds * 1000);
  if (typeof ts === 'string' || typeof ts === 'number') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function getMealName(order: any): string {
  const type = order?.meal?.type || order?.meal_type;
  const name = order?.meal?.name;
  const label = type ? `${type.charAt(0).toUpperCase()}${type.slice(1)}` : '';
  return name && name !== 'Tiffin' ? name : label ? `${label} Tiffin` : 'Tiffin';
}

/* ─── component ─────────────────────────────────────────────────────────────── */

function CustomerTrackContent() {
  const searchParams = useSearchParams();
  const urlOrderId = searchParams.get('orderId');
  const urlUserId = searchParams.get('userId');

  const user = useAuthStore((s) => s.user);
  const isSuper = isSuperadminEmail(user?.email) || user?.is_superadmin || user?.role === 'admin';

  // Superadmin switcher states
  const [superadminOrders, setSuperadminOrders] = useState<any[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(urlOrderId || null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(urlUserId || null);
  const [impersonatedCustomer, setImpersonatedCustomer] = useState<any | null>(null);

  const [allOrders, setAllOrders] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [riderLocation, setRiderLocation] = useState<{lat: number, lng: number} | null>(null);
  const [riderTrip, setRiderTrip] = useState<any>(null);

  const [activeSubs, setActiveSubs] = useState<any[]>([]);
  const [expiredSubs, setExpiredSubs] = useState<any[]>([]);

  const [showUpdates, setShowUpdates] = useState(false);

  // 1. Fetch active platform orders for superadmin switcher
  useEffect(() => {
    if (!isSuper) return;
    const qAll = query(
      collection(db, 'orders'),
      where('status', 'in', [
        'out_for_delivery',
        'picked_up',
        'rider_assigned',
        'vendor_ready',
        'preparing',
        'delivered',
        'created',
      ]),
      limit(30)
    );

    const unsub = onSnapshot(
      qAll,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const orderWeight: Record<string, number> = {
          out_for_delivery: 1,
          picked_up: 2,
          rider_assigned: 3,
          vendor_ready: 4,
          preparing: 5,
          created: 6,
          delivered: 7,
        };
        list.sort((a: any, b: any) => (orderWeight[a.status] || 99) - (orderWeight[b.status] || 99));
        setSuperadminOrders(list);
      },
      (err) => console.warn('Superadmin active orders listener error:', err.message)
    );

    return () => unsub();
  }, [isSuper]);

  // 2. Superadmin auto-selection of active delivery
  useEffect(() => {
    if (!isSuper) return;
    if (urlOrderId && selectedOrderId !== urlOrderId) {
      setSelectedOrderId(urlOrderId);
      return;
    }
    if (urlUserId && selectedCustomerId !== urlUserId) {
      setSelectedCustomerId(urlUserId);
      return;
    }
    // If no order/customer selected yet and we have active platform deliveries, auto-select the first in-flight order!
    if (!selectedOrderId && !selectedCustomerId && superadminOrders.length > 0) {
      const inFlight = superadminOrders.find((o) =>
        ['out_for_delivery', 'picked_up', 'rider_assigned'].includes(o.status)
      );
      if (inFlight) {
        setSelectedOrderId(inFlight.id);
        const custId = inFlight.user_id || inFlight.customerId;
        if (custId) setSelectedCustomerId(custId);
      }
    }
  }, [isSuper, superadminOrders, selectedOrderId, selectedCustomerId, urlOrderId, urlUserId]);

  // 3. Customer metadata hydration for selected customer
  useEffect(() => {
    if (!isSuper || !selectedCustomerId) {
      setImpersonatedCustomer(null);
      return;
    }
    getDoc(doc(db, 'users', selectedCustomerId))
      .then((snap) => {
        if (snap.exists()) {
          setImpersonatedCustomer({ id: snap.id, ...snap.data() });
        }
      })
      .catch((err) => console.warn('Fetch customer metadata error:', err.message));
  }, [isSuper, selectedCustomerId]);

  const effectiveUserId = (isSuper && selectedCustomerId) ? selectedCustomerId : user?.id;

  /* Fetch all today's delivery_orders and active subscriptions */
  useEffect(() => {
    if (!user?.id) return;
    if (!effectiveUserId && !selectedOrderId) {
      setLoading(false);
      return;
    }
    setLoading(true);

    let fromOrders: any[] = [];
    const fromDeliveryOrders: any[] = [];

    const mapOrderDoc = (d: any) => {
      const data = d.data ? d.data() : d;
      return {
        id: d.id,
        ...data,
        // Map canonical fields to expected legacy fields
        customerId: data.user_id || data.customerId,
        customerName: data.customer_name || data.userName || data.user_name || impersonatedCustomer?.name || 'Customer',
        customerPhone: data.customer_phone || data.phone || impersonatedCustomer?.phone || '',
        vendorId: data.vendor_id || data.vendorId,
        driverId: data.driverId || data.rider_id || data.agentId || null,
        riderTripId: data.rider_trip_id || data.riderTripId || null,
        date: data.date || null,
        createdAt: data.created_at || data.createdAt,
        meal: data.meal || { type: data.meal_type || 'lunch', name: 'Tiffin' },
        address: data.address || data.delivery_address || { lat: 0, lng: 0, line1: '' },
        scheduledSlot: data.delivery_slot || data.scheduledSlot || '11am',
        status: data.status,
        delivery_otp: data.delivery_otp || data.otp || null,
        otp: data.delivery_otp || data.otp || null,
        deliveredAt: data.timestamps?.deliveredAt || data.delivered_at || data.deliveredAt || null,
        timestamps: data.timestamps || {
          preparedAt: null,
          pickedAt: null,
          outAt: null,
          deliveredAt: null,
        }
      };
    };

    const mergeAndSortOrders = () => {
      const byId = new Map<string, any>();
      [...fromOrders, ...fromDeliveryOrders].forEach(d => byId.set(d.id, d));
      const merged = Array.from(byId.values());
      merged.sort((a, b) => {
        const aT = a.createdAt?.seconds ?? 0;
        const bT = b.createdAt?.seconds ?? 0;
        return bT - aT; // newest first
      });
      setAllOrders(merged);
      setLoading(false);
    };

    let unsubOrders = () => {};
    let unsubSubs = () => {};

    if (effectiveUserId) {
      const qOrders = query(
        collection(db, 'orders'),
        where('user_id', '==', effectiveUserId)
      );

      const qSubs = query(
        collection(db, 'subscriptions'),
        where('user_id', '==', effectiveUserId),
        where('status', '==', 'active')
      );

      unsubOrders = onSnapshot(qOrders, (snap) => {
        fromOrders = snap.docs.map(mapOrderDoc);
        mergeAndSortOrders();
      }, (err) => {
        console.warn("Track Orders listener error:", err.message);
        // A failed listener permanently leaves `loading=true` (infinite spinner).
        // Drop through to whatever data we have so the page still renders.
        if (fromOrders.length > 0 || fromDeliveryOrders.length > 0) mergeAndSortOrders();
        else setLoading(false);
      });

      unsubSubs = onSnapshot(qSubs, (snap) => {
        // Entitlement-aware: a stored-'active' sub whose end date passed is
        // EXPIRED — it must not enable live tracking or order actions.
        const nowMs = Date.now();
        const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setExpiredSubs(raw.filter((s: any) => isSubscriptionExpired(s, nowMs)));
        setActiveSubs(raw.filter((s: any) => isSubscriptionActive(s, nowMs)));
      }, (err) => {
        console.warn("Track Subs listener error:", err.message);
        setLoading(false);
      });
    }

    let unsubDirectOrder = () => {};
    if (selectedOrderId) {
      unsubDirectOrder = onSnapshot(doc(db, 'orders', selectedOrderId), (docSnap) => {
        if (docSnap.exists()) {
          const directMapped = mapOrderDoc(docSnap);
          setAllOrders((prev) => {
            const map = new Map<string, any>();
            map.set(directMapped.id, directMapped);
            prev.forEach((p) => map.set(p.id, p));
            return Array.from(map.values());
          });
          if ((directMapped.customerId || (directMapped as any).user_id) && !selectedCustomerId) {
            setSelectedCustomerId(directMapped.customerId || (directMapped as any).user_id);
          }
          setLoading(false);
        }
      }, (err) => {
        console.warn("Direct Order listener error:", err.message);
        setLoading(false);
      });
    }

    return () => {
      unsubOrders();
      unsubSubs();
      unsubDirectOrder();
    };
  }, [effectiveUserId, selectedOrderId, impersonatedCustomer?.name]);

  /* Derive current order */
  const liveOrder = allOrders.find((o) => isLiveStatus(o.status)) ?? null;

  // No active entitlement but an expired subscription exists → force RENEW state.
  const needsRenewal = activeSubs.length === 0 && expiredSubs.length > 0;

  /* Subscribe to Rider location and trip if there is a live order and driverId */
  useEffect(() => {
    if (liveOrder?.driverId) {
      // Listen on driver_profiles (written by Rider app's watchPosition)
      const unsubProfile = onSnapshot(doc(db, 'driver_profiles', liveOrder.driverId), (docSnap) => {
        if (docSnap.exists()) {
          const loc = docSnap.data().currentLocation;
          if (loc?.lat && loc?.lng) {
            setRiderLocation({ lat: loc.lat, lng: loc.lng });
          }
        }
      }, err => console.warn("Track RiderLocation listener error:", err.message));

      let unsubTrip = () => {};
      if (liveOrder.riderTripId) {
        unsubTrip = onSnapshot(doc(db, 'rider_trips', liveOrder.riderTripId), (docSnap) => {
          if (docSnap.exists()) {
            setRiderTrip({ id: docSnap.id, ...docSnap.data() });
          }
        });
      }

      return () => {
        unsubProfile();
        unsubTrip();
      };
    } else {
      setRiderLocation(null);
      setRiderTrip(null);
    }
  }, [liveOrder?.driverId, liveOrder?.riderTripId]);

  const latestDelivered = allOrders
    .filter((o) => DONE_STATUSES.includes(o.status))
    .sort((a, b) => (resolveDeliveredAt(b)?.getTime() ?? 0) - (resolveDeliveredAt(a)?.getTime() ?? 0))[0] ?? null;

  const currentOrder: any | null = liveOrder ?? latestDelivered;

  /* Derive next order (real or projected) */
  const now = new Date();
  
  // 1. Build a map of existing real orders by slot to avoid projecting over them
  const slotMap = new Set<string>();
  allOrders.forEach(o => {
    const dateKey = o.date || o.delivery_date || (o.createdAt?.toDate ? o.createdAt.toDate() : (o.createdAt?.seconds ? new Date(o.createdAt.seconds * 1000) : new Date())).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    slotMap.add(`${dateKey}_${o.meal?.type || 'lunch'}`);
  });

  // 2. Project future orders from active subscriptions for the next 2 days
  const projectedOrders: any[] = [];
  for (let dayOffset = 0; dayOffset <= 5; dayOffset++) {
    const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    const dateKey = targetDate.toLocaleDateString('en-CA');
    
    activeSubs.forEach((sub) => {
      const mealTypes = sub.meal_type === 'both' ? ['lunch', 'dinner'] : [sub.meal_type];
      mealTypes.forEach((mealType) => {
        if (slotMap.has(`${dateKey}_${mealType}`)) return; // Already exists as a real order
        
        const scheduledSlot = mealType === 'lunch' ? (user?.deliveryPreference || '11am') : '8pm';
        const slotHour = scheduledSlot === '8am' ? 8 : scheduledSlot === '11am' ? 11 : 20;
        const slotDate = new Date(targetDate);
        slotDate.setHours(slotHour, 0, 0, 0);
        
        if (slotDate.getTime() < now.getTime()) return; // Skip past slots

        projectedOrders.push({
          id: `projected_${dateKey}_${mealType}_${sub.id}`,
          status: 'pending',
          meal: { type: mealType, name: mealType === 'lunch' ? 'Lunch' : 'Dinner' },
          scheduledSlot,
          vendorName: sub.vendor_name || sub.kitchen_name,
          vendorId: sub.vendor_id,
          address:
            sub.delivery_address
              ? typeof sub.delivery_address === 'string'
                ? { line1: sub.delivery_address }
                : sub.delivery_address
              : undefined,
          createdAt: { toDate: () => targetDate, seconds: targetDate.getTime() / 1000 },
          isProjected: true
        });
      });
    });
  }

  // 3. Combine real pending orders and projected orders, and pick the soonest one
  const combinedFutureOrders = [
    ...allOrders.filter((o) => ['pending', 'preparing'].includes(o.status) && o !== currentOrder),
    ...projectedOrders
  ];

  const nextOrder: any | null = combinedFutureOrders
    .sort((a, b) => getSlotTime(a).getTime() - getSlotTime(b).getTime())
    .find((o) => getSlotTime(o).getTime() > now.getTime()) ?? null;

  /* Notifications for current order */
  useEffect(() => {
    if (!currentOrder?.id || currentOrder.isProjected) return;
    const q = query(
      collection(db, 'orders', currentOrder.id, 'notifications'),
      orderBy('createdAt', 'desc'),
    );
    const unsub = onSnapshot(q, (snap) => {
      setNotifications(snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          timeString: data.createdAt
            ? new Date(data.createdAt.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : 'Just now',
        };
      }));
    }, err => console.warn("Track Notifications listener error:", err.message));
    return () => unsub();
  }, [currentOrder?.id]);

  /* Auto-expand Updates when a delay alert arrives */
  useEffect(() => {
    if (notifications.some((n) => n.type === 'delay_alert')) {
      setShowUpdates(true);
    }
  }, [notifications]);

  function handleCallRider(phone: string) {
    try {
      if (Capacitor.isNativePlatform() && (Capacitor as any).Plugins?.Phone) {
        (Capacitor as any).Plugins.Phone.call({ number: phone });
      } else {
        window.open(`tel:${phone}`, '_self');
      }
    } catch {
      window.open(`tel:${phone}`, '_self');
    }
  }

  function getVendorName(order: any): string {
    if (!order) return '';
    return order.vendor_name
      || order.vendorName
      || order.vendor?.kitchen_name
      || order.vendor?.name
      || activeSubs.find((s) =>
          (s.id === (order.subscription_id || order.subscriptionId)) ||
          (s.vendor_id === (order.vendor_id || order.vendorId))
        )?.vendor_name
      || activeSubs.find((s) => s.vendor_id === (order.vendor_id || order.vendorId))?.kitchen_name
      || '';
  }

  const renderSuperadminBanner = () => {
    if (!isSuper) return null;
    return (
      <div className="mb-6 rounded-3xl bg-gradient-to-br from-amber-500/15 via-amber-500/5 to-orange-500/10 border-2 border-amber-500/30 p-4 shadow-lg shadow-amber-500/5 backdrop-blur-md animate-fade-in">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
            </span>
            <div>
              <div className="flex items-center gap-1.5">
                <Crown className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span className="text-xs font-black uppercase tracking-wider text-amber-700 dark:text-amber-300">
                  Superadmin Live Customer Tracker
                </span>
              </div>
              <p className="text-[10px] text-amber-700/80 dark:text-amber-300/80 font-medium mt-0.5">
                Inspect any customer&apos;s real-time tracking screen, rider GPS &amp; doorstep PIN
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto flex-1 sm:max-w-xs">
            <select
              value={selectedOrderId || ''}
              onChange={(e) => {
                const ordId = e.target.value;
                if (!ordId) {
                  setSelectedOrderId(null);
                  setSelectedCustomerId(null);
                  setImpersonatedCustomer(null);
                  return;
                }
                setSelectedOrderId(ordId);
                const found = superadminOrders.find((o) => o.id === ordId);
                if (found) {
                  setSelectedCustomerId(found.user_id || found.customerId || null);
                }
              }}
              className="w-full text-xs font-bold bg-white dark:bg-slate-900 border-2 border-amber-400/60 rounded-2xl px-3 py-2 text-slate-900 dark:text-slate-100 shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              <option value="">-- Switch Active Customer / Delivery --</option>
              {superadminOrders.map((o) => {
                const custName = o.customer_name || o.userName || o.user_name || 'Customer';
                const mType = (o.meal?.type || o.meal_type || 'meal').toUpperCase();
                const st = (o.status || 'pending').replace(/_/g, ' ').toUpperCase();
                return (
                  <option key={o.id} value={o.id}>
                    {custName} • {mType} • {st} ({o.id.slice(-6)})
                  </option>
                );
              })}
            </select>
            {(selectedOrderId || selectedCustomerId) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedOrderId(null);
                  setSelectedCustomerId(null);
                  setImpersonatedCustomer(null);
                }}
                className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-amber-800 dark:text-amber-200 bg-amber-500/20 hover:bg-amber-500/30 px-2.5 py-2 rounded-xl transition-colors shrink-0"
                title="Reset to your personal account view"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            )}
          </div>
        </div>

        {(impersonatedCustomer || currentOrder) && (
          <div className="mt-3 pt-3 border-t border-amber-500/20 flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-lg">
                Viewing
              </span>
              <strong className="font-black text-slate-900 dark:text-white text-sm">
                {impersonatedCustomer?.name || currentOrder?.customer_name || currentOrder?.customerName || currentOrder?.userName || 'Customer'}
              </strong>
              {(impersonatedCustomer?.phone || currentOrder?.customer_phone || currentOrder?.customerPhone || currentOrder?.phone) && (
                <a
                  href={`tel:${impersonatedCustomer?.phone || currentOrder?.customer_phone || currentOrder?.customerPhone || currentOrder?.phone}`}
                  className="text-xs font-mono font-bold text-amber-800 dark:text-amber-300 underline"
                >
                  {impersonatedCustomer?.phone || currentOrder?.customer_phone || currentOrder?.customerPhone || currentOrder?.phone}
                </a>
              )}
            </div>

            {currentOrder && (
              <div className="flex items-center gap-2 bg-emerald-500/15 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 px-3 py-1 rounded-xl">
                <span className="text-[10px] font-black uppercase tracking-wider">Doorstep PIN:</span>
                <span className="font-mono text-sm font-black tracking-widest text-emerald-700 dark:text-emerald-300">
                  {currentOrder.delivery_otp || currentOrder.otp || '----'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderRenewBanner = () => (
    <Link
      href="/profile"
      className="flex items-center gap-3 mb-5 rounded-3xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-4 shadow-sm active:scale-[0.98] transition-all duration-200"
    >
      <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
        <Crown className="w-5 h-5 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-black text-white text-[13px] leading-tight">Your subscription has expired</p>
        <p className="text-white/80 text-[11px] font-semibold mt-0.5">
          Renew to keep tracking meals &amp; new deliveries
        </p>
      </div>
      <RotateCcw className="w-5 h-5 text-white/80 shrink-0" />
    </Link>
  );

  /* ── loading ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center py-32 animate-fade-in">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="w-8 h-8 text-brand animate-spin" />
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Connecting live GPS…</p>
        </div>
      </div>
    );
  }

  /* ── empty state ── */
  if (!currentOrder && !nextOrder) {
    return (
      <div className="pt-8 pb-24 px-6 max-w-md mx-auto animate-fade-in">
        {isSuper && renderSuperadminBanner()}
        {needsRenewal && renderRenewBanner()}
        <div className="bg-white rounded-[2rem] p-10 text-center border border-slate-100 shadow-sm flex flex-col items-center gap-4 mt-2">
          <div className="text-5xl">🍱</div>
          <div>
            <h2 className="font-black text-slate-900 text-lg">No Active Delivery</h2>
            <p className="text-xs text-slate-400 mt-2 max-w-[220px] mx-auto leading-relaxed">
              {isSuper
                ? 'Select an active delivery or customer from the Superadmin selector above to inspect their live tracking screen.'
                : 'Your tiffin hasn\'t been dispatched yet for today. Check back closer to meal time!'}
            </p>
          </div>
          <div className="flex gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
            <Clock className="w-3.5 h-3.5" />
            <span>Lunch ~11 AM · Dinner ~8 PM</span>
          </div>
        </div>
      </div>
    );
  }

  const isLive = currentOrder && isLiveStatus(currentOrder.status);
  const isDelivered = currentOrder && DONE_STATUSES.includes(currentOrder.status) && currentOrder.status === 'delivered';
  const isFailed = currentOrder && currentOrder.status === 'failed';

  const headerTitle = currentOrder ? getMealName(currentOrder) : nextOrder ? getMealName(nextOrder) : 'Today\'s Tiffin';
  const headerSubtitle = [
    ...(currentOrder?.meal?.type || nextOrder?.meal?.type ? [currentOrder?.meal?.type || nextOrder?.meal?.type] : []),
    ...(getVendorName(currentOrder || nextOrder) ? [getVendorName(currentOrder || nextOrder)] : []),
    ...(currentOrder?.address?.line1 || nextOrder?.address?.line1 ? [currentOrder?.address?.line1 || nextOrder?.address?.line1] : []),
  ].join(' · ');

  const failureReason = currentOrder?.failure_reason || currentOrder?.failedReason;

  return (
    <div className="pb-28 animate-fade-in">
      {/* Header */}
      <div className="pt-6 pb-4 px-6 max-w-md mx-auto">
        {isSuper && renderSuperadminBanner()}
        {needsRenewal && renderRenewBanner()}

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-brand bg-brand/10 px-3 py-1 rounded-full">
            {isLive && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
              </span>
            )}
            {isLive ? 'Live Tracking' : isFailed ? 'Delivery Unsuccessful' : isDelivered ? 'Delivery Complete' : 'Delivery Status'}
          </span>
        </div>
        <h1 className="text-[28px] font-black text-slate-900 tracking-tight leading-tight mt-2.5">
          {headerTitle}
        </h1>
        {headerSubtitle && (
          <p className="text-sm text-slate-400 font-medium capitalize mt-1 truncate">
            {impersonatedCustomer?.name ? `${impersonatedCustomer.name} · ` : ''}{headerSubtitle}
          </p>
        )}
      </div>

      <div className="px-6 max-w-md mx-auto space-y-5">

        {/* ── Card 1: Current order (live / delivered / failed) ─────────────── */}
        {currentOrder && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            {isLive && (
              <RiderTrackingCard
                status={currentOrder.status as any}
                mealName={getMealName(currentOrder)}
                mealType={currentOrder.meal?.type as any}
                scheduledSlot={currentOrder.scheduledSlot}
                riderName={currentOrder.agentName ?? 'Dabzzo Rider'}
                riderPhone={currentOrder.agentPhone}
                riderRating={4.8}
                vehicleNumber={currentOrder.vehicleNumber}
                otp={currentOrder.delivery_otp || currentOrder.otp || undefined}
                boxTag={generateBoxTag({
                  customerName: impersonatedCustomer?.name || currentOrder.customer_name || currentOrder.customerName || currentOrder.userName || user?.name || 'Customer',
                  vendorName: getVendorName(currentOrder) || 'Kitchen',
                  sequenceNumber: 1,
                  planType: currentOrder.plan_type || currentOrder.planType || 'weekly',
                  cycleNumber: currentOrder.cycle_number || 1,
                  orderId: currentOrder.id
                })}
                driverLocation={riderLocation || currentOrder.driverLocation || undefined}
                destLocation={currentOrder.address}
                onCallRider={handleCallRider}
              />
            )}

            {isDelivered && (
              <DeliveryCompleteCard
                order={currentOrder}
                vendorName={getVendorName(currentOrder)}
              />
            )}

            {isFailed && (
              <motion.div
                initial={{ scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', bounce: 0.25, duration: 0.5 }}
                className="bg-white rounded-[28px] border border-slate-100 shadow-sm overflow-hidden"
              >
                <div className="bg-gradient-to-br from-rose-500 to-red-600 px-6 py-7 text-white relative overflow-hidden">
                  <div className="absolute inset-0 opacity-[0.06] pointer-events-none">
                    <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full border-2 border-white" />
                    <div className="absolute -right-4 -top-4 w-28 h-28 rounded-full border border-white" />
                  </div>
                  <div className="relative z-10 flex items-start gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center shrink-0">
                      <AlertTriangle className="w-6 h-6 text-white" strokeWidth={2.5} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-[0.15em] text-rose-100/80">
                        Delivery Unsuccessful
                      </p>
                      <p className="text-2xl font-black leading-tight mt-0.5">NOT DELIVERED</p>
                    </div>
                  </div>
                </div>

                <div className="px-6 py-5 space-y-3">
                  <p className="text-xs text-slate-600 font-medium leading-relaxed">
                    {failureReason === 'customer_unavailable'
                      ? 'Your rider arrived but could not reach you this time. Your delivery was not completed.'
                      : 'Your delivery could not be completed. Our team has been notified and will follow up shortly.'}
                  </p>
                  <Link
                    href="/support"
                    className="flex items-center justify-center w-full py-3 rounded-2xl bg-slate-900 text-white text-xs font-black uppercase tracking-wider hover:bg-slate-800 active:scale-[0.98] transition-all"
                  >
                    Contact Support
                  </Link>
                </div>
              </motion.div>
            )}
          </motion.div>
        )}

        {/* ── Card 2: Next order (upcoming) ─────────────────────────────────── */}
        {nextOrder && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.1 }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Navigation className="w-4 h-4 text-slate-400" />
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Next Delivery</span>
            </div>

            <div className="bg-white rounded-[1.5rem] border border-slate-100 shadow-sm overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-brand/60 via-brand to-brand/60" />

              <div className="p-5 space-y-4">
                {/* Meal info row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-brand/10 flex items-center justify-center shrink-0 text-xl">
                      {nextOrder.meal?.type === 'lunch' ? '🍛' : '🍽️'}
                    </div>
                    <div>
                      <p className="font-black text-slate-900 text-sm leading-tight truncate">{getMealName(nextOrder)}</p>
                      <p className="text-[10px] font-semibold text-slate-400 capitalize mt-0.5">{nextOrder.meal?.type}</p>
                    </div>
                  </div>

                  {/* Status / ETA pill */}
                  {(() => {
                    if (nextOrder.status === 'failed') {
                      return (
                        <div className="shrink-0 rounded-full px-3 py-1.5 text-center bg-red-100">
                          <p className="text-[10px] font-black uppercase tracking-wider text-red-600">
                            Unsuccessful
                          </p>
                        </div>
                      );
                    }
                    const eta = getOrderETA(nextOrder, riderTrip, riderLocation || undefined);
                    const isLive = eta.type === 'live';
                    return (
                      <div className={`shrink-0 rounded-full px-3 py-1.5 text-center ${isLive ? 'bg-emerald-100' : 'bg-brand/10'}`}>
                        <p className={`text-[10px] font-black uppercase tracking-wider ${isLive ? 'text-emerald-700' : 'text-brand'}`}>
                          {isLive ? 'Live ETA' : eta.type === 'coarse' ? 'Status' : 'ETA'}
                        </p>
                        <p className={`text-sm font-black mt-0.5 ${isLive ? 'text-emerald-700 animate-pulse' : 'text-brand'}`}>
                          {eta.label}
                        </p>
                      </div>
                    );
                  })()}
                </div>

                {nextOrder.status === 'failed' && (
                  <div className="bg-red-50 text-red-600 border border-red-100 p-4 rounded-xl text-center text-sm font-bold">
                    Delivery unsuccessful — customer unavailable
                  </div>
                )}

                {/* Delivery address */}
                {nextOrder.address?.line1 && (
                  <div className="flex items-start gap-2.5 bg-slate-50 rounded-xl p-3">
                    <MapPin className="w-3.5 h-3.5 text-brand shrink-0 mt-0.5" />
                    <p className="text-xs font-semibold text-slate-700 leading-relaxed truncate">{nextOrder.address.line1}</p>
                  </div>
                )}

                {/* Rider status */}
                {!nextOrder.agentName && (
                  <div className="flex items-center gap-2 text-[10px] text-slate-400 bg-slate-50 rounded-xl px-3 py-2.5">
                    <Package className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-semibold">Rider will be assigned closer to delivery time</span>
                  </div>
                )}

                {nextOrder.agentName && (
                  <div className="flex items-center gap-3 bg-slate-50 rounded-xl p-3">
                    <div className="w-8 h-8 rounded-xl bg-brand/20 flex items-center justify-center shrink-0">
                      <span className="text-sm">🛵</span>
                    </div>
                    <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Rider Assigned</p>
                      <p className="text-xs font-black text-slate-800 mt-0.5">{nextOrder.agentName}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Notification feed (progressive disclosure) ───────────────────── */}
        {notifications.length > 0 && (
          <motion.div
            className="space-y-3 mt-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
          >
            <button
              type="button"
              onClick={() => setShowUpdates((v) => !v)}
              className="w-full flex items-center justify-between gap-2 bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3 transition-all active:scale-[0.99]"
            >
              <span className="flex items-center gap-2">
                <Bell className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Updates</span>
                {notifications.some((n) => n.type === 'delay_alert') && (
                  <span className="text-[9px] font-black uppercase tracking-wider text-white bg-amber-500 rounded-full px-2 py-0.5">
                    Delay
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-slate-400">{notifications.length}</span>
                <span
                  className={`w-2 h-2 border-b-2 border-r-2 border-slate-400 rotate-45 origin-center transition-transform ${showUpdates ? '-rotate-135 translate-y-[1px]' : ''}`}
                />
              </span>
            </button>

            <AnimatePresence initial={false}>
              {showUpdates && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="space-y-2.5 pt-0.5">
                    {notifications.map((notif, i) => (
                      <motion.div
                        key={notif.id}
                        initial={{ opacity: 0, x: 12 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.04 }}
                        className={`rounded-2xl p-4 border flex items-start gap-3 shadow-sm ${
                          notif.type === 'delay_alert'
                            ? 'bg-amber-50 border-amber-100'
                            : 'bg-white border-slate-100'
                        }`}
                      >
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-sm ${
                          notif.type === 'delay_alert' ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {notif.type === 'delay_alert' ? <AlertTriangle className="w-4 h-4" /> : '📋'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-start gap-2">
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                              {notif.type === 'delay_alert' ? 'Delay Alert' : 'Update'}
                            </span>
                            <span className="text-[9px] font-bold text-slate-400 shrink-0">{notif.timeString}</span>
                          </div>
                          <p className="text-xs font-medium text-slate-700 leading-relaxed mt-0.5">{notif.message}</p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </div>
  );
}

export default function CustomerTrackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-32 animate-fade-in">
          <div className="flex flex-col items-center gap-3 text-center">
            <Loader2 className="w-8 h-8 text-brand animate-spin" />
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Connecting live GPS…</p>
          </div>
        </div>
      }
    >
      <CustomerTrackContent />
    </Suspense>
  );
}