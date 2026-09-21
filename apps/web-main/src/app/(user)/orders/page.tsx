'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { getUserSubscriptions, cancelSubscription } from '@/lib/queries/subscriptions';
import { cancelScheduledTiffin, undoSkipScheduledTiffin } from '@/lib/queries/delivery';
import { requestSwap, cancelSwapRequest } from '@/lib/queries/swaps';
import { getApprovedVendors } from '@/lib/queries/users';
import { SkeletonList } from '@/components/shared/Skeleton';
import { EmptyState } from '@/components/shared/EmptyState';
import { formatDate, formatMeal, toMillis } from '@/lib/utils';
import type { EnrichedSubscription } from '@/types';
import Link from 'next/link';
import { SwapVendorModal } from '@/components/shared/SwapVendorModal';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Box, History, CreditCard, Utensils, Calendar, ChevronRight, Navigation, ArrowLeftRight, SkipForward, Clock, XCircle, Sun, Moon, RefreshCw } from 'lucide-react';
import dynamic from 'next/dynamic';
import { generateBoxTag } from '@/lib/boxTag';
import { getErrorMessage } from '@dabzzo/shared-lib/errors';
import { isSubscriptionActive, isSubscriptionExpired } from '@dabzzo/shared-lib/subscriptionEntitlement';
import { LIVE_TRACKING_STATUSES, ACTIVE_ORDER_STATUSES } from '@dabzzo/shared-lib/orderLifecycle';

const DeliveryMap = dynamic(() => import('@/components/delivery/DeliveryMap'), { 
  ssr: false,
  loading: () => (
    <div className="w-full h-64 rounded-3xl bg-slate-50 border border-slate-100 flex items-center justify-center animate-pulse">
      <Navigation className="w-8 h-8 text-slate-300" />
    </div>
  )
});

// ─── Robust Date Extractor Helper ──────────────────────────────────────────
function parseDeliveryDate(delivery: any): { dateObj: Date; dateStr: string } {
  if (delivery?.date) {
    if (typeof delivery.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(delivery.date)) {
      const [y, m, day] = delivery.date.split('-').map(Number);
      return { dateObj: new Date(y, m - 1, day), dateStr: delivery.date };
    }
    if (delivery.date.toDate) {
      const d = delivery.date.toDate();
      return { dateObj: d, dateStr: d.toLocaleDateString('en-CA') };
    }
    const parsed = new Date(delivery.date);
    if (!isNaN(parsed.getTime())) {
      return { dateObj: parsed, dateStr: parsed.toLocaleDateString('en-CA') };
    }
  }
  if (delivery?.createdAt?.toDate) {
    const d = delivery.createdAt.toDate();
    return { dateObj: d, dateStr: d.toLocaleDateString('en-CA') };
  }
  if (delivery?.createdAt?.seconds) {
    const d = new Date(delivery.createdAt.seconds * 1000);
    return { dateObj: d, dateStr: d.toLocaleDateString('en-CA') };
  }
  if (delivery?.created_at?.toDate) {
    const d = delivery.created_at.toDate();
    return { dateObj: d, dateStr: d.toLocaleDateString('en-CA') };
  }
  if (delivery?.created_at?.seconds) {
    const d = new Date(delivery.created_at.seconds * 1000);
    return { dateObj: d, dateStr: d.toLocaleDateString('en-CA') };
  }
  const d = new Date();
  return { dateObj: d, dateStr: d.toLocaleDateString('en-CA') };
}

// ─── Memoized Countdown Timer Component ────────────────────────────────────
const CountdownTimer = React.memo(function CountdownTimer({ 
  delivery, 
  actionType 
}: { 
  delivery: any
  actionType: 'skip_swap' | 'undo_skip' 
}) {
  const [timeLeft, setTimeLeft] = useState<string>('');
  const [isExpired, setIsExpired] = useState(false);

  // Memoize cutoff calculation to prevent recalculations on every render
  const cutoffMoment = useMemo(() => {
    const { dateObj } = parseDeliveryDate(delivery);
    const deliveryMoment = new Date(dateObj);
    const slot = delivery.scheduledSlot || delivery.delivery_slot || (delivery.meal?.type === 'lunch' ? '11am' : '8pm');
    
    if (slot === '8am') deliveryMoment.setHours(8, 0, 0, 0);
    else if (slot === '11am' || slot === 'lunch') deliveryMoment.setHours(13, 0, 0, 0);
    else if (slot === '8pm' || slot === 'dinner') deliveryMoment.setHours(20, 0, 0, 0);
    else deliveryMoment.setHours(13, 0, 0, 0);

    // Skip/Swap has a 4-hour cutoff. Undo Skip has no 4-hour cutoff (can be done until delivery time).
    return actionType === 'skip_swap' 
      ? new Date(deliveryMoment.getTime() - 4 * 60 * 60 * 1000) 
      : deliveryMoment;
  }, [delivery, actionType]);

  useEffect(() => {
    const updateTimer = () => {
      const now = new Date();
      const diff = cutoffMoment.getTime() - now.getTime();
      if (diff <= 0) {
        setIsExpired(true);
        setTimeLeft('Time expired');
        return;
      }
      setIsExpired(false);
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diff % (1000 * 60)) / 1000);
      setTimeLeft(`${hours}h ${mins}m ${secs}s left to act`);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [cutoffMoment]);

  if (isExpired) {
    return (
      <div className="w-full text-center mt-2 text-[10px] font-bold text-red-400 flex items-center justify-center gap-1">
        <Clock className="w-3 h-3" /> Action Window Closed
      </div>
    );
  }

  return (
    <div className="w-full text-center mt-2 text-[10px] font-bold text-slate-400 flex items-center justify-center gap-1">
      <Clock className="w-3 h-3" /> {timeLeft}
    </div>
  );
});

export default function OrdersPage() {
  const user = useAuthStore((s) => s.user);
  const addToast = useUiStore((s) => s.addToast);

  const [orders, setOrders] = useState<EnrichedSubscription[]>([]);
  const [upcomingDeliveries, setUpcomingDeliveries] = useState<any[]>([]);
  const [selectedDayIndex, setSelectedDayIndex] = useState<number>(0);
  const [vendorsList, setVendorsList] = useState<any[]>([]);
  const [realOrders, setRealOrders] = useState<any[]>([]);
  const [activeSubs, setActiveSubs] = useState<any[]>([]);
  const [expiredSubs, setExpiredSubs] = useState<any[]>([]);
  const [activeDelivery, setActiveDelivery] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'active' | 'history'>('active');
  const [skipping, setSkipping] = useState<string | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [skippedSlots, setSkippedSlots] = useState<string[]>([]);
  const [swappedIds, setSwappedIds] = useState<string[]>([]);

  // Modal state
  const [isSwapModalOpen, setIsSwapModalOpen] = useState(false);
  const [selectedDeliveryForSwap, setSelectedDeliveryForSwap] = useState<any>(null);

  // New state for test orders from the `orders` collection
  const [activeTestOrder, setActiveTestOrder] = useState<any>(null);

  // Custom confirmation dialog state
  const [confirmConfig, setConfirmConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    variant?: 'danger' | 'primary' | 'warning';
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  async function loadOrders() {
    if (!user) return;
    setLoading(true);
    try {
      // Fix 15: Use vendor-only query instead of getAllUsers() full collection scan
      const [subs, vendorList] = await Promise.all([
        getUserSubscriptions(user.id),
        getApprovedVendors(),
      ]);
      setVendorsList(vendorList);

      const vendorMap: Record<string, any> = {};
      vendorList.forEach((v) => { vendorMap[v.id] = v; });

      const enriched: EnrichedSubscription[] = subs.map((s) => {
        const vendor = vendorMap[s.vendor_id] ?? {};
        const mealType = s.meal_type;
        let price = s.paid_amount ?? s.total_price ?? 0;
        let title = 'Subscription';

        if (s.frequency === 'one-time') {
          price = price || (mealType === 'dinner' ? (vendor.rate_dinner || 0) : (vendor.rate_lunch || 0));
          title = `${mealType === 'both' ? 'Lunch + Dinner' : mealType === 'dinner' ? 'Dinner' : 'Lunch'} Single Meal`;
        } else if (mealType === 'lunch') {
          price = price || vendor.rate_lunch_weekly || vendor.rate_lunch || 0;
          title = 'Lunch Plan';
        } else if (mealType === 'dinner') {
          price = price || vendor.rate_dinner_weekly || vendor.rate_dinner || 0;
          title = 'Dinner Plan';
        } else if (mealType === 'both') {
          price = price || vendor.rate_both_weekly || vendor.rate_both || 0;
          title = 'Lunch + Dinner';
        }

        return {
          ...s,
          vendorName: vendor.kitchen_name || s.vendor_name || vendor.name || 'Vendor',
          vendorImage: vendor.image ?? '',
          planTitle: title,
          planPrice: price,
          planFrequency: s.frequency || 'weekly',
          createdMs: toMillis(s.created_at),
        };
      });

      const uniqueMap = new Map<string, EnrichedSubscription>();
      enriched.forEach((item) => {
        const key = `${item.vendor_id}-${item.meal_type}-${item.status}`;
        const existing = uniqueMap.get(key);
        if (!existing || (item.createdMs ?? 0) > (existing.createdMs ?? 0)) {
          uniqueMap.set(key, item);
        }
      });

      setOrders(Array.from(uniqueMap.values()).sort((a, b) => (b.createdMs ?? 0) - (a.createdMs ?? 0)));
    } catch (err) {
      addToast('Failed to load orders', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user?.id) return;

    let mounted = true;
    const unsubscribers: Array<() => void> = [];

    const setupListeners = async () => {
      try {
        loadOrders();

        // Real orders listener
        const qOrders = query(
          collection(db, 'orders'),
          where('user_id', '==', user.id)
        );

        const unsubUpcoming = onSnapshot(qOrders, (snap) => {
          if (!mounted) return;
          const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
          list.sort((a, b) => (toMillis(a.created_at || a.createdAt) ?? 0) - (toMillis(b.created_at || b.createdAt) ?? 0));
          setRealOrders(list);
        });
        unsubscribers.push(unsubUpcoming);

        // Active subscriptions listener
        const qSubs = query(
          collection(db, 'subscriptions'),
          where('user_id', '==', user.id)
        );
        const unsubSubs = onSnapshot(qSubs, async (snap) => {
          if (!mounted) return;
          const allUserSubs = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
          // Entitlement-aware: expired-but-stored-active subs must not show as
          // active (they surface under the RENEW state instead).
          const nowMs = Date.now();
          setActiveSubs(allUserSubs.filter((s) => isSubscriptionActive(s, nowMs)));
          setExpiredSubs(allUserSubs.filter((s) => isSubscriptionExpired(s, nowMs)));

          // Real-time enrich orders
          try {
            const vendorList = vendorsList.length > 0 ? vendorsList : await getApprovedVendors().catch(() => []);
            const vendorMap: Record<string, any> = {};
            vendorList.forEach((v) => { vendorMap[v.id] = v; });

            const enriched: EnrichedSubscription[] = allUserSubs.map((s) => {
              const vendor = vendorMap[s.vendor_id] ?? {};
              const mealType = s.meal_type;
              let price = s.paid_amount ?? s.price ?? 0;
              let title = 'Subscription';

              if (s.frequency === 'one-time') {
                price = s.paid_amount ?? s.total_price ?? (mealType === 'dinner' ? (vendor.rate_dinner || 0) : (vendor.rate_lunch || 0));
                title = `${mealType === 'both' ? 'Lunch + Dinner' : mealType === 'dinner' ? 'Dinner' : 'Lunch'} Single Meal`;
              } else if (mealType === 'lunch') {
                price = price || vendor.rate_lunch_weekly || vendor.rate_lunch || 0;
                title = 'Lunch Plan';
              } else if (mealType === 'dinner') {
                price = price || vendor.rate_dinner_weekly || vendor.rate_dinner || 0;
                title = 'Dinner Plan';
              } else if (mealType === 'both') {
                price = price || vendor.rate_both_weekly || vendor.rate_both || 0;
                title = 'Lunch + Dinner';
              }

              return {
                ...s,
                vendorName: vendor.kitchen_name || s.vendor_name || vendor.name || 'Vendor',
                vendorImage: vendor.image ?? '',
                planTitle: title,
                planPrice: price,
                planFrequency: s.frequency || 'weekly',
                createdMs: toMillis(s.created_at),
              };
            });

            setOrders(enriched.sort((a, b) => (b.createdMs ?? 0) - (a.createdMs ?? 0)));
          } catch (e) {
            console.warn('[OrdersPage] Real-time enrich warning:', e);
          }
        });
        unsubscribers.push(unsubSubs);

        // Test orders listener
        const LIVE_STATUSES = LIVE_TRACKING_STATUSES;
        const qTestOrders = query(
          collection(db, 'orders'),
          where('user_id', '==', user.id),
          where('status', 'in', [...LIVE_STATUSES])
        );
        const unsubTestOrders = onSnapshot(qTestOrders, (snap) => {
          if (!mounted) return;
          if (!snap.empty) {
            setActiveTestOrder({ id: snap.docs[0].id, ...snap.docs[0].data() });
          } else {
            setActiveTestOrder(null);
          }
        });
        unsubscribers.push(unsubTestOrders);

        // Legacy deliveries listener
        const { collection: col, query: q2, where: w, onSnapshot: ons, doc } = await import('firebase/firestore');
        const { db: firedb } = await import('@/lib/firebase');
        
        const qDel = q2(col(firedb, 'deliveries'), w('user_id', '==', user.id));
        const unsubDel = ons(qDel, (snap) => {
          if (!mounted) return;
          
          const deliveries = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
          const active = deliveries.find(d => d.status === 'picked_up');
          
          if (active?.assigned_to) {
            const partnerRef = doc(firedb, 'users', active.assigned_to);
            const unsubPartner = ons(partnerRef, (partnerSnap) => {
              if (!mounted) return;
              
              const partnerData = partnerSnap.data();
              if (partnerData?.location) {
                setActiveDelivery({
                  ...active,
                  partnerLocation: partnerData.location,
                  partnerName: partnerData.name || 'Delivery Partner',
                  partnerPhone: partnerData.phone
                });
              }
            });
            unsubscribers.push(unsubPartner);
          } else {
            setActiveDelivery(null);
          }
        });
        unsubscribers.push(unsubDel);
      } catch (error) {
        console.error('[OrdersPage] Listener setup error:', error);
      }
    };

    setupListeners();

    return () => {
      mounted = false;
      unsubscribers.forEach(unsub => {
        try {
          unsub();
        } catch (error) {
          console.warn('[OrdersPage] Cleanup error:', error);
        }
      });
    };
  }, [user?.id]);

  // Merge real delivery_orders with projected meals from subscriptions
  // Real orders take priority; projected ones fill in the gaps for future days
  useEffect(() => {
    // If no active subscriptions, only show real non-projected future orders (no dummies)
    // Deduplicate real orders: keep only the most recent per slot
    const slotMap = new Map<string, any>();
    for (const o of realOrders) {
      const { dateStr } = parseDeliveryDate(o);
      const mealType = o.meal?.type || o.meal_type || 'lunch';
      const slotKey = `${dateStr}_${mealType}`;
      const existing = slotMap.get(slotKey);
      // Keep the newest one (highest updatedAt or createdAt seconds)
      const oMs = o.updatedAt?.seconds ?? o.createdAt?.seconds ?? 0;
      const exMs = existing ? (existing.updatedAt?.seconds ?? existing.createdAt?.seconds ?? 0) : -1;
      if (!existing || oMs > exMs) {
        slotMap.set(slotKey, o);
      }
    }

    const dedupedRealOrders = Array.from(slotMap.values());
    const merged: any[] = [...dedupedRealOrders];
    const coveredKeys = new Set(slotMap.keys());

    // Also exclude manually skipped slots so they don't re-appear as "Generating..."
    skippedSlots.forEach(k => coveredKeys.add(k));

    // Only project future slots if there are active recurring subscriptions (never for one-time orders)
    const activeRecurringSubs = activeSubs.filter((s: any) => s.frequency !== 'one-time');
    if (activeRecurringSubs.length > 0) {
      const now = new Date();
      for (let dayOffset = 0; dayOffset <= 5; dayOffset++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
        const dateKey = targetDate.toLocaleDateString('en-CA');

        activeRecurringSubs.forEach((sub: any) => {
          const mealTypes = sub.meal_type === 'both' ? ['lunch', 'dinner'] : [sub.meal_type];
          mealTypes.forEach((mealType: string) => {
            const key = `${dateKey}_${mealType}`;
            if (coveredKeys.has(key)) return; // already have a real order for this slot

            const scheduledSlot = mealType === 'lunch' ? (user?.deliveryPreference || '11am') : '8pm';
            
            // Skip already-elapsed slots for today
            const slotHour = scheduledSlot === '8am' ? 8 : scheduledSlot === '11am' ? 11 : 20;
            const slotDate = new Date(targetDate);
            slotDate.setHours(slotHour, 0, 0, 0);
            if (slotDate.getTime() < now.getTime()) return;

            const vendorObj = vendorsList.find((v: any) => v.id === sub.vendor_id);
            const vendorName = vendorObj ? (vendorObj.kitchen_name || vendorObj.name) : 'Kitchen';

            coveredKeys.add(key);
            merged.push({
              id: `projected_${dateKey}_${mealType}_${sub.id}`,
              subscriptionId: sub.id,
              customerId: user?.id,
              vendorId: sub.vendor_id,
              vendorName,
              status: 'pending',
              isProjected: true,
              date: dateKey,
              meal: { type: mealType, name: `${vendorName}'s ${mealType === 'lunch' ? 'Lunch' : 'Dinner'}` },
              scheduledSlot,
              createdAt: { toDate: () => targetDate, seconds: targetDate.getTime() / 1000 },
            });
          });
        });
      }
    }

    // Filter: only show real skipped orders that:
    // 1. Belong to an active subscription
    // 2. Have a vendorId linked to an active sub (filters orphan/ghost docs that have no vendor)
    // 3. Have not yet reached their delivery slot time
    const activeSubIds = new Set(activeSubs.map((s: any) => s.id));
    const activeVendorIds = new Set(activeSubs.map((s: any) => s.vendor_id).filter(Boolean));
    const now2 = new Date();
    const todayStart = new Date(now2.getFullYear(), now2.getMonth(), now2.getDate());

    const filtered = merged.filter(o => {
      if (o.isProjected) return true;

      const { dateObj } = parseDeliveryDate(o);
      const slotTime = new Date(dateObj);
      if (o.scheduledSlot === '8am') slotTime.setHours(8, 0, 0, 0);
      else if (o.scheduledSlot === '11am') slotTime.setHours(11, 0, 0, 0);
      else if (o.scheduledSlot === '8pm') slotTime.setHours(20, 0, 0, 0);
      else if (o.meal?.type === 'lunch') slotTime.setHours(11, 0, 0, 0);
      else slotTime.setHours(20, 0, 0, 0);

      // 1. Filter out orders from past days
      if (dateObj.getTime() < todayStart.getTime()) return false;

      // 2. Filter out active/completed orders from the Upcoming Schedule list (they are tracked via Track button)
      if (['picked_up', 'out_for_delivery', 'delivered'].includes(o.status)) return false;

      if (o.status === 'skipped') {
        // Must belong to an active subscription
        if (!o.subscriptionId || !activeSubIds.has(o.subscriptionId)) return false;
        // Must have a vendor matching an active subscription (orphan docs won't pass this)
        if (!o.vendorId || !activeVendorIds.has(o.vendorId)) return false;
        // Must not be past delivery time
        if (slotTime.getTime() < now2.getTime()) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const getExactTime = (o: any) => {
        const { dateObj } = parseDeliveryDate(o);
        const moment = new Date(dateObj);
        if (o.scheduledSlot === '8am') moment.setHours(8, 0, 0, 0);
        else if (o.scheduledSlot === '11am') moment.setHours(11, 0, 0, 0);
        else if (o.scheduledSlot === '8pm') moment.setHours(20, 0, 0, 0);
        else if (o.meal?.type === 'lunch') moment.setHours(13, 0, 0, 0);
        else moment.setHours(20, 0, 0, 0);
        return moment.getTime();
      };
      return getExactTime(a) - getExactTime(b);
    });
    
    setUpcomingDeliveries(filtered);
  }, [realOrders, activeSubs, user, skippedSlots, vendorsList]);

  async function handleCancel(subId: string) {
    setConfirmConfig({
      isOpen: true,
      title: 'Cancel Subscription?',
      message: 'Are you sure you want to cancel this subscription? You will stop receiving your daily scheduled meals.',
      confirmLabel: 'Cancel Plan',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmConfig(prev => ({ ...prev, isOpen: false }));
        try {
          await cancelSubscription(subId);
          setOrders((prev) => prev.map((o) => o.id === subId ? { ...o, status: 'cancelled' } : o));
          addToast('Subscription cancelled', 'success');
        } catch {
          addToast('Failed to cancel', 'error');
        }
      }
    });
  }

  async function handleSkip(delivery: any) {
    if (!user) return;

    const now = new Date();
    let baseDate = delivery.date ? new Date(delivery.date) : now;
    if (delivery.createdAt?.toDate && !delivery.date) {
      baseDate = delivery.createdAt.toDate();
    }
    const deliveryMoment = new Date(baseDate);
    if (delivery.delivery_slot === '8am') deliveryMoment.setHours(8, 0, 0, 0);
    else if (delivery.delivery_slot === '11am') deliveryMoment.setHours(11, 0, 0, 0);
    else if (delivery.delivery_slot === '8pm') deliveryMoment.setHours(20, 0, 0, 0);
    else deliveryMoment.setHours(13, 0, 0, 0);
    
    const hoursRemaining = (deliveryMoment.getTime() - now.getTime()) / (1000 * 60 * 60);
    const expectedCredits = hoursRemaining >= 12 ? 0.5 : 0.2;

    setConfirmConfig({
      isOpen: true,
      title: 'Skip Delivery?',
      message: `Skip this meal? You'll earn ${expectedCredits} credits towards a free meal slot.`,
      confirmLabel: 'Skip Delivery',
      variant: 'warning',
      onConfirm: async () => {
        setConfirmConfig(prev => ({ ...prev, isOpen: false }));
        setSkipping(delivery.id);
        try {
          const result = await cancelScheduledTiffin(delivery, user.id);
          // Optimistically track this slot as skipped so projection doesn't re-add it
          const d = delivery.createdAt?.toDate ? delivery.createdAt.toDate() : new Date();
          const slotKey = `${d.toLocaleDateString('en-CA')}_${delivery.meal?.type || 'lunch'}`;
          setSkippedSlots(prev => [...new Set([...prev, slotKey])]);
          addToast(`Skipped! You earned ${result.creditsEarned} credits 🎉`, 'success');
        } catch (err: unknown) {
          addToast(getErrorMessage(err) || 'Cannot skip this delivery', 'error');
        } finally { setSkipping(null); }
      }
    });
  }

  async function handleUndoSkip(delivery: any) {
    if (!user) return;
    setSkipping(delivery.id);
    try {
      const result = await undoSkipScheduledTiffin(delivery, user.id);
      const d = delivery.createdAt?.toDate ? delivery.createdAt.toDate() : new Date();
      const slotKey = `${d.toLocaleDateString('en-CA')}_${delivery.meal?.type || 'lunch'}`;
      setSkippedSlots(prev => prev.filter(k => k !== slotKey));
      if (result.mode === 'credit') {
        addToast('Skip cancelled — credit used ✓', 'success');
      } else {
        addToast('Skip cancelled — 1 day deducted, remainder refunded ✓', 'success');
      }
    } catch (err: unknown) {
      addToast(getErrorMessage(err) || 'Cannot undo skip', 'error');
    } finally { setSkipping(null); }
  }

  async function handleSwap(delivery: any) {
    if (!user) return;
    if (!user.location) { addToast('Please update your location in Profile first', 'error'); return; }
    setSelectedDeliveryForSwap(delivery);
    setIsSwapModalOpen(true);
  }

  function handleSwapSuccess(deliveryId: string) {
    setSwappedIds(prev => [...new Set([...prev, deliveryId])]);
    addToast('Swap confirmed! Enjoy your new meal 🎉', 'success');
  }

  async function handleCancelSwap(delivery: any) {
    if (!user) return;
    setSwapping(delivery.id);
    try {
      await cancelSwapRequest(delivery.id, user.id);
      setSwappedIds(prev => prev.filter(id => id !== delivery.id));
      addToast('Swap request cancelled.', 'success');
    } catch (err: unknown) {
      addToast(getErrorMessage(err) || 'Cannot cancel swap request', 'error');
    } finally { setSwapping(null); }
  }

  function getSlotLabel(delivery: any): string {
    const slot = delivery.scheduledSlot;
    if (slot === '8am') return '8:00 AM';
    if (slot === '11am') return '11:00 AM';
    if (slot === '8pm') return '8:00 PM';
    return slot || 'Scheduled';
  }

  function formatDeliveryDate(delivery: any): string {
    const { dateObj, dateStr } = parseDeliveryDate(delivery);
    const todayStr = new Date().toLocaleDateString('en-CA');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString('en-CA');

    if (dateStr === todayStr) return 'Today';
    if (dateStr === tomorrowStr) return 'Tomorrow';
    return dateObj.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function isActionWindowOpen(delivery: any): boolean {
    const { dateObj } = parseDeliveryDate(delivery);
    const deliveryMoment = new Date(dateObj);
    if (delivery.scheduledSlot === '8am') deliveryMoment.setHours(8, 0, 0, 0);
    else if (delivery.scheduledSlot === '11am') deliveryMoment.setHours(11, 0, 0, 0);
    else if (delivery.scheduledSlot === '8pm') deliveryMoment.setHours(20, 0, 0, 0);
    else if (delivery.meal?.type === 'lunch') deliveryMoment.setHours(13, 0, 0, 0);
    else deliveryMoment.setHours(20, 0, 0, 0);

    const now = new Date();
    const cutoffMoment = new Date(deliveryMoment.getTime() - 4 * 60 * 60 * 1000); // 4 hours before
    return now.getTime() < cutoffMoment.getTime();
  }

  function canSwap(delivery: any): boolean { return isActionWindowOpen(delivery); }
  function canSkip(delivery: any): boolean { return isActionWindowOpen(delivery); }

  const uniqueDays = useMemo(() => {
    const daysMap = new Map<string, { date: Date; dateStr: string; label: string; weekday: string; dayNum: string; deliveries: any[] }>();
    upcomingDeliveries.forEach(d => {
      const { dateObj, dateStr } = parseDeliveryDate(d);
      const todayStr = new Date().toLocaleDateString('en-CA');
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString('en-CA');
      
      let label = dateObj.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
      if (dateStr === todayStr) label = 'Today';
      else if (dateStr === tomorrowStr) label = 'Tomorrow';

      const weekday = dateObj.toLocaleDateString('en-IN', { weekday: 'short' });
      const dayNum = dateObj.toLocaleDateString('en-IN', { day: 'numeric' });

      if (!daysMap.has(dateStr)) {
        daysMap.set(dateStr, {
          date: dateObj,
          dateStr,
          label,
          weekday,
          dayNum,
          deliveries: []
        });
      }
      daysMap.get(dateStr)!.deliveries.push(d);
    });
    return Array.from(daysMap.values()).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
  }, [upcomingDeliveries]);

  const activeDay = uniqueDays[selectedDayIndex] || uniqueDays[0] || null;

  const filtered = orders.filter((o) =>
    activeTab === 'active' ? o.status !== 'cancelled' : o.status === 'cancelled'
  );

  const hasRecurring = activeSubs.some((s: any) => s.frequency !== 'one-time');

  // Entitlement gate: live tracking is a benefit of an active subscription.
  const trackEligible = activeSubs.length > 0;
  const displayDelivery = trackEligible ? activeDelivery : null;
  const displayTestOrder = trackEligible ? activeTestOrder : null;
  const needsRenewal = !trackEligible && expiredSubs.length > 0;

  // Determine if there's a real order today to show the track button
  // Include 'created' and 'pending' so single-meal orders show Track banner immediately
  const todayStr = new Date().toLocaleDateString('en-CA');
  const hasTodayOrder = !!displayTestOrder || realOrders.some(o => {
    const { dateStr } = parseDeliveryDate(o);
    return dateStr === todayStr && (ACTIVE_ORDER_STATUSES as readonly string[]).includes(o.status);
  });
  const hasTrackableToday = trackEligible && hasTodayOrder;

  return (
    <div className="animate-fade-in pb-20 px-4 sm:px-5">
      {/* Header */}
      <div className="mt-4 mb-6 px-1">
        <h1 className="text-[30px] sm:text-[36px] font-black text-slate-900 tracking-tight leading-tight">
          My Orders
        </h1>
        <p className="text-sm font-medium text-slate-400 mt-1">
          Manage your active plans & tracking
        </p>
      </div>

      {/* Track Banner — green when a live/today delivery exists for an active sub;
          amber RENEW state when a subscription expired and no benefit remains */}
      {(displayDelivery || displayTestOrder || hasTrackableToday) && (
        <Link href="/track" className="block mb-6 animate-fade-in">
          <div className={`relative overflow-hidden rounded-3xl px-5 py-4 flex items-center gap-4 shadow-sm transition-all duration-200 active:scale-[0.98] ${
            (displayDelivery || displayTestOrder)
              ? 'bg-gradient-to-r from-emerald-500 to-teal-500'
              : 'bg-gradient-to-r from-brand to-indigo-500'
          }`}>
            {/* Subtle shine overlay */}
            <div className="absolute inset-0 bg-white/5 rounded-3xl pointer-events-none" />
            <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${
              (displayDelivery || displayTestOrder) ? 'bg-white/20' : 'bg-white/20'
            }`}>
              {(displayDelivery || displayTestOrder)
                ? <Navigation className="w-5 h-5 text-white animate-pulse" />
                : <Navigation className="w-5 h-5 text-white" />
              }
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-black text-white text-[14px] leading-tight">
                {(displayDelivery || displayTestOrder) ? '🚴 Your food is on the way!' : '📦 Track Today\'s Order'}
              </p>
              <p className="text-white/80 text-[11px] font-semibold mt-0.5">
                {activeDelivery ? `Partner: ${activeDelivery.partnerName}` : 'Tap to see live delivery status'}
              </p>
            </div>
            <ChevronRight className="w-5 h-5 text-white/70 shrink-0" />
          </div>
        </Link>
      )}

      {/* RENEW banner — subscription expired, no active benefits remain */}
      {needsRenewal && (
        <Link href="/track" className="block mb-6 animate-fade-in">
          <div className="relative overflow-hidden rounded-3xl px-5 py-4 flex items-center gap-4 bg-gradient-to-r from-amber-500 to-orange-500 shadow-sm transition-all duration-200 active:scale-[0.98]">
            <div className="absolute inset-0 bg-white/5 rounded-3xl pointer-events-none" />
            <div className="w-11 h-11 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
              <RefreshCw className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-black text-white text-[14px] leading-tight">⚠️ Your subscription has expired</p>
              <p className="text-white/80 text-[11px] font-semibold mt-0.5">
                Renew to keep tracking meals & new deliveries
              </p>
            </div>
            <ChevronRight className="w-5 h-5 text-white/70 shrink-0" />
          </div>
        </Link>
      )}

      {/* Active Delivery Tracking Map (inline, only shows when driver is live) */}
      {displayDelivery && (
        <div className="mb-10">
          <h3 className="font-bold text-slate-900 mb-3 px-1">Live Tracking</h3>
          <div className="bg-white rounded-3xl p-5 md:p-8 shadow-sm border border-slate-100">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-emerald-50 text-emerald-500 rounded-2xl flex items-center justify-center animate-pulse">
                  <Navigation className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-900 leading-tight">Your food is on the way!</h4>
                  <p className="text-xs text-slate-500 font-medium mt-0.5">Partner: {activeDelivery.partnerName} ({activeDelivery.partnerPhone})</p>
                </div>
              </div>
            </div>
            <DeliveryMap 
              markers={[{
                id: activeDelivery.id,
                lat: activeDelivery.partnerLocation.lat,
                lng: activeDelivery.partnerLocation.lng,
                title: activeDelivery.partnerName,
                subtitle: 'On the way'
              }]}
            />
          </div>
        </div>
      )}

      {/* Upcoming Schedule Planner */}
      {uniqueDays.length > 0 && (
        <div className="mb-10 animate-fade-in">
          <div className="flex items-center justify-between mb-4 px-1">
            <h3 className="font-bold text-slate-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-brand" />
              {(!hasRecurring && uniqueDays.length <= 1) ? (activeDay?.label === 'Today' ? "Today's Scheduled Meal" : "Scheduled Delivery") : "Weekly Planner"}
            </h3>
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              {(!hasRecurring && uniqueDays.length <= 1) ? activeDay?.label : "Select day to manage"}
            </span>
          </div>

          {/* Horizontal Calendar Stripe — only shown if there are multiple days or recurring subscription */}
          {(hasRecurring || uniqueDays.length > 1) && (
            <div className="flex gap-2 overflow-x-auto pb-3 -mx-4 px-4 scrollbar-none">
              {uniqueDays.map((day, idx) => {
                const isSelected = (activeDay?.dateStr === day.dateStr) || (idx === 0 && !activeDay);
                const hasLunch = day.deliveries.some(d => d.meal?.type === 'lunch' || d.scheduledSlot !== '8pm');
                const hasDinner = day.deliveries.some(d => d.meal?.type === 'dinner' || d.scheduledSlot === '8pm');
                
                return (
                  <button
                    key={day.dateStr}
                    onClick={() => setSelectedDayIndex(idx)}
                    className={`flex flex-col items-center justify-center shrink-0 rounded-2xl w-14 py-3 border transition-all duration-200 active:scale-95 ${
                      isSelected
                        ? 'bg-brand text-white border-transparent shadow-[0_8px_20px_rgba(230, 138, 0, 0.25)]'
                        : 'bg-white text-slate-700 border-slate-100 hover:border-slate-200'
                    }`}
                  >
                    <span className={`text-[9px] font-black uppercase tracking-wider ${isSelected ? 'text-white/60' : 'text-slate-400'}`}>
                      {day.weekday}
                    </span>
                    <span className="text-base font-black mt-0.5">
                      {day.dayNum}
                    </span>
                    {/* Indicators for meal types scheduled */}
                    <div className="flex gap-1 mt-1.5">
                      {hasLunch && <Sun className={`w-2.5 h-2.5 ${isSelected ? 'text-amber-300' : 'text-amber-500'}`} />}
                      {hasDinner && <Moon className={`w-2.5 h-2.5 ${isSelected ? 'text-indigo-200' : 'text-indigo-500'}`} />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Active Day Detail Card */}
          {activeDay && (
            <div className="bg-slate-50 border border-slate-100/50 rounded-3xl p-4 mt-2 space-y-3">
              <div className="flex items-center justify-between px-1 mb-1">
                <span className="text-xs font-black text-slate-900 uppercase tracking-widest">
                  {activeDay.label}
                </span>
                <span className="text-[10px] font-bold text-slate-400">
                  {activeDay.deliveries.length} meal{activeDay.deliveries.length > 1 ? 's' : ''} scheduled
                </span>
              </div>

              <div className="space-y-3">
                {activeDay.deliveries.map((delivery: any) => {
                  const isLunch = delivery.meal?.type === 'lunch' || delivery.scheduledSlot !== '8pm';
                  const isProjected = !!delivery.isProjected;
                  const isSwapRequested = swappedIds.includes(delivery.id);
                  const swapOk = !isSwapRequested && canSwap(delivery);
                  const skipOk = canSkip(delivery);
                  const isSkipping = skipping === delivery.id;
                  const isSwapping = swapping === delivery.id;
                  const isOneTimeDelivery = delivery.subscriptionId 
                    ? (activeSubs.find(s => s.id === delivery.subscriptionId)?.frequency === 'one-time') 
                    : !hasRecurring;

                  const now = new Date();
                  const { dateObj } = parseDeliveryDate(delivery);
                  const deliveryMoment = new Date(dateObj);
                  if (delivery.delivery_slot === '8am') deliveryMoment.setHours(8, 0, 0, 0);
                  else if (delivery.delivery_slot === '11am') deliveryMoment.setHours(11, 0, 0, 0);
                  else if (delivery.delivery_slot === '8pm') deliveryMoment.setHours(20, 0, 0, 0);
                  else deliveryMoment.setHours(13, 0, 0, 0);

                  const hoursRemaining = (deliveryMoment.getTime() - now.getTime()) / (1000 * 60 * 60);
                  const expectedCredits = hoursRemaining >= 12 ? 0.5 : 0.2;

                  return (
                    <div key={delivery.id} className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex flex-col gap-3">
                      {/* Top Row: Meal Icon, Name, status badge */}
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isLunch ? 'bg-amber-50 text-amber-500' : 'bg-indigo-50 text-indigo-500'}`}>
                          {isLunch ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-bold text-slate-900 text-sm truncate">
                            {delivery.meal?.name || (isLunch ? 'Lunch' : 'Dinner')}
                          </h4>
                          <p className="text-[11px] font-bold text-slate-400 mt-0.5 uppercase tracking-wider">
                            Slot: {getSlotLabel(delivery)}
                          </p>
                        </div>
                        <span className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full shrink-0 ${
                          isProjected
                            ? 'bg-slate-50 text-slate-400 border border-slate-200'
                            : isSwapRequested
                              ? 'bg-blue-50 text-blue-500 border border-blue-100'
                              : delivery.status === 'skipped'
                                ? 'bg-slate-100 text-slate-500 border border-slate-200'
                                : delivery.status === 'ready'
                                  ? 'bg-emerald-500 text-white'
                                  : delivery.status === 'preparing'
                                    ? 'bg-orange-400 text-white'
                                    : isLunch
                                      ? 'bg-amber-400 text-white'
                                      : 'bg-indigo-400 text-white'
                        }`}>
                          {isProjected ? 'Projected' : isSwapRequested ? 'Swap Out' : delivery.status === 'skipped' ? 'Skipped' : delivery.status === 'ready' ? 'Ready' : delivery.status === 'preparing' ? 'Preparing' : 'Scheduled'}
                        </span>
                      </div>

                      {/* Manifest summary if available */}
                      {(delivery.custom_meal_config?.manifestSummary || delivery.meal_components?.[0]) && (
                        <div className="text-[11px] font-medium text-slate-600 bg-slate-50 rounded-xl p-2.5 border border-slate-100">
                          🍱 {delivery.custom_meal_config?.manifestSummary || delivery.meal_components?.[0]}
                        </div>
                      )}

                      {/* Delivery Verification OTP banner for single/active orders */}
                      {(delivery.otp || delivery.delivery_otp) && (
                        <div className="flex items-center justify-between bg-amber-50/80 border border-amber-200/70 rounded-xl px-3 py-2">
                          <span className="font-bold text-amber-900 text-[11px] uppercase tracking-wider">Delivery OTP</span>
                          <span className="font-mono font-black text-amber-950 tracking-widest text-sm">{delivery.otp || delivery.delivery_otp}</span>
                        </div>
                      )}

                      {/* Divider */}
                      <div className="h-px bg-slate-100" />

                      {/* Action buttons */}
                      <div>
                        {isOneTimeDelivery ? (
                          <div className="flex gap-2">
                            <Link 
                              href="/track"
                              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all duration-200 bg-brand text-white hover:bg-amber-600 active:scale-95 shadow-sm shadow-brand/20"
                            >
                              <Navigation className="w-3.5 h-3.5" /> Track Live
                            </Link>
                            {swapOk && (
                              <button
                                disabled={isSwapping}
                                onClick={() => handleSwap(delivery)}
                                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all duration-200 bg-blue-50 text-blue-600 hover:bg-blue-100 active:scale-95"
                              >
                                <ArrowLeftRight className="w-3.5 h-3.5" />
                                {isSwapping ? 'Swapping...' : 'Swap Kitchen'}
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            {isSwapRequested ? (
                              <button
                                disabled={isSwapping}
                                onClick={() => handleCancelSwap(delivery)}
                                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all duration-200 bg-red-50 text-red-600 hover:bg-red-100 active:scale-95"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                                {isSwapping ? 'Cancelling...' : 'Cancel Swap'}
                              </button>
                            ) : delivery.status === 'skipped' ? (
                              <button
                                disabled={isSkipping}
                                onClick={() => handleUndoSkip(delivery)}
                                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all duration-200 bg-slate-100 text-slate-600 hover:bg-slate-200 active:scale-95"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                                {isSkipping ? 'Cancelling...' : 'Cancel Skip'}
                              </button>
                            ) : (
                              <>
                                <button
                                  disabled={!swapOk || isSwapping || isSkipping}
                                  onClick={() => handleSwap(delivery)}
                                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all duration-200 ${
                                    swapOk && !isSwapping && !isSkipping
                                      ? 'bg-blue-50 text-blue-600 hover:bg-blue-100 active:scale-95'
                                      : 'bg-slate-50 text-slate-300 border border-slate-100 cursor-not-allowed'
                                  }`}
                                >
                                  <ArrowLeftRight className="w-3.5 h-3.5" />
                                  {isSwapping ? 'Swapping...' : 'Swap'}
                                </button>
                                <button
                                  disabled={!skipOk || isSkipping || isSwapping}
                                  onClick={() => handleSkip(delivery)}
                                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all duration-200 ${
                                    skipOk && !isSkipping && !isSwapping
                                      ? 'bg-orange-50 text-orange-600 hover:bg-orange-100 active:scale-95'
                                      : 'bg-slate-50 text-slate-300 border border-slate-100 cursor-not-allowed'
                                  }`}
                                >
                                  <SkipForward className="w-3.5 h-3.5" />
                                  {isSkipping ? 'Processing...' : `Skip +${expectedCredits}CR`}
                                </button>
                              </>
                            )}
                          </div>
                        )}

                        {/* Countdown Timer below active day's buttons */}
                        <CountdownTimer 
                          delivery={delivery} 
                          actionType={(isSwapRequested || delivery.status === 'skipped') ? 'undo_skip' : 'skip_swap'} 
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white p-1.5 rounded-2xl border border-slate-200/80 shadow-xs flex mb-6">
        <button 
          className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${
            activeTab === 'active' 
              ? 'bg-slate-900 text-white shadow-xs' 
              : 'text-slate-500 hover:text-slate-900'
          }`} 
          onClick={() => setActiveTab('active')}
        >
          <Box className="w-4 h-4" />
          Active Plans
        </button>
        <button 
          className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${
            activeTab === 'history' 
              ? 'bg-slate-900 text-white shadow-xs' 
              : 'text-slate-500 hover:text-slate-900'
          }`} 
          onClick={() => setActiveTab('history')}
        >
          <History className="w-4 h-4" />
          Order History
        </button>
      </div>

      {loading ? (
        <SkeletonList count={3} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={activeTab === 'active' ? <Box className="w-8 h-8 text-brand" /> : <History className="w-8 h-8 text-brand" />}
          title={activeTab === 'active' ? 'No active subscriptions' : 'No cancelled plans'}
          description={activeTab === 'active' ? 'Browse curated home kitchens to start a daily lunch or dinner meal plan' : 'Cancelled meal plans will appear here'}
          action={activeTab === 'active' ? (
            <Link 
              href="/dashboard" 
              className="px-6 py-3.5 bg-brand hover:bg-amber-600 text-white text-xs font-black uppercase tracking-wider rounded-2xl inline-block shadow-md shadow-brand/20 transition-all active:scale-95"
            >
              Browse Kitchens & Plans
            </Link>
          ) : undefined}
        />
      ) : (
        <div className="space-y-5">
          {filtered.map((order) => {
            const isActive = order.status !== 'cancelled';
            return (
              <div key={order.id} className="card !p-0 overflow-hidden group">
                <div className="p-5">
                  <div className="flex items-start justify-between mb-5">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center group-hover:scale-105 transition-transform">
                        {isActive ? <Utensils className="w-6 h-6 text-brand" /> : <History className="w-6 h-6 text-slate-300" />}
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-900 text-[17px] leading-tight">{order.vendorName}</h4>
                        <p className="text-xs font-medium text-slate-400 mt-1">{order.planTitle}</p>
                      </div>
                    </div>
                    <span className={`text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-widest ${
                      order.planFrequency === 'one-time'
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : isActive 
                          ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' 
                          : 'bg-slate-100 text-slate-400'
                    }`}>
                      {order.planFrequency === 'one-time' ? 'One-Time Meal' : isActive ? 'Active' : 'Cancelled'}
                    </span>
                  </div>

                  {/* Tiffin Box Tag Banner for Customer Verification */}
                  {isActive && (
                    <div className="bg-slate-900 text-white rounded-2xl p-3.5 mb-4 flex items-center justify-between border border-slate-800 shadow-sm">
                      <div>
                        <span className="text-[9px] font-black uppercase tracking-wider text-amber-400">
                          🏷️ Your Tiffin Box Tag Code
                        </span>
                        <div className="text-xl font-mono font-black text-white tracking-widest mt-0.5">
                          {generateBoxTag({
                            customerName: user?.name,
                            vendorName: order.vendorName || 'Kitchen',
                            sequenceNumber: 1,
                            planType: order.planTitle || 'weekly',
                            cycleNumber: 1,
                            orderId: order.id
                          })}
                        </div>
                        <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                          Verify this code on your tiffin container when delivered
                        </p>
                      </div>
                      <span className="px-2.5 py-1 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-xl text-[10px] font-black uppercase tracking-wider">
                        Match Tag ✓
                      </span>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2 bg-slate-50/50 border border-slate-100 rounded-2xl p-4 mb-5">
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                        <CreditCard className="w-3 h-3" /> Rate
                      </p>
                      <p className="text-sm font-black text-slate-900">₹{order.planPrice}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                        <Utensils className="w-3 h-3" /> Meal
                      </p>
                      <p className="text-sm font-black text-slate-900 truncate">{formatMeal(order.meal_type)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                        <Calendar className="w-3 h-3" /> {order.planFrequency === 'one-time' ? 'Ordered' : 'Started'}
                      </p>
                      <p className="text-sm font-black text-slate-900">{formatDate(order.created_at)}</p>
                    </div>
                  </div>

                  {isActive && (
                    <div className="flex gap-3">
                      {order.planFrequency === 'one-time' ? (
                        <Link 
                          href="/track"
                          className="flex-1 bg-brand text-white py-3.5 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 shadow-sm shadow-brand/20 hover:bg-amber-600 transition-colors active:scale-95"
                        >
                          <Navigation className="w-3.5 h-3.5" /> Track Meal
                        </Link>
                      ) : (
                        <button 
                          className="flex-1 bg-rose-50 text-rose-500 py-3.5 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-rose-100 transition-colors" 
                          onClick={() => handleCancel(order.id)}
                        >
                          Cancel Plan
                        </button>
                      )}
                      <Link 
                        href={`/vendor/detail?id=${order.vendor_id}`} 
                        className="flex-1 bg-slate-900 text-white py-3.5 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2"
                      >
                        View Vendor <ChevronRight className="w-3.5 h-3.5" />
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Swap Modal */}
      {isSwapModalOpen && selectedDeliveryForSwap && user?.location && (
        <SwapVendorModal
          isOpen={isSwapModalOpen}
          onClose={() => {
            setIsSwapModalOpen(false);
            setSelectedDeliveryForSwap(null);
          }}
          userLocation={user.location}
          userId={user.id}
          delivery={selectedDeliveryForSwap}
          onSwapSuccess={handleSwapSuccess}
        />
      )}

      {/* Reusable Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmConfig.isOpen}
        title={confirmConfig.title}
        message={confirmConfig.message}
        confirmLabel={confirmConfig.confirmLabel}
        variant={confirmConfig.variant}
        onConfirm={confirmConfig.onConfirm}
        onCancel={() => setConfirmConfig(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}
