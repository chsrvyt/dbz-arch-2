'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Calendar,
  CalendarDays,
  Utensils,
  Sparkles,
  Pause,
  Play,
  RotateCcw,
  XCircle,
  Edit3,
  Eye,
  CheckCircle2,
  Clock,
  ShieldCheck,
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  ChevronRight,
  Plus
} from 'lucide-react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuthStore } from '@/store/authStore';
import {
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  getUserSubscriptions,
} from '@/lib/queries/subscriptions';
import { formatDate, cn } from '@/lib/utils';
import { isSubscriptionExpired } from '@dabzzo/shared-lib/subscriptionEntitlement';
import type { Subscription } from '@/types';

export interface SubscriptionManagerProps {
  /**
   * Optional user ID to filter by. Defaults to currently logged-in user from useAuthStore.
   */
  userId?: string;
  /**
   * Optional initial subscription data (useful for testing or server rendering).
   */
  initialSubscriptions?: Subscription[];
  /**
   * Callback fired when user clicks [Modify] on a custom plan.
   */
  onModifyPlan?: (subscription: Subscription) => void;
  /**
   * Callback fired when user wants to create a new custom plan.
   */
  onCreateNewPlan?: () => void;
  /**
   * Additional wrapper class names.
   */
  className?: string;
}

const WEEKDAY_NAMES = [
  { full: 'monday', short: 'Mon' },
  { full: 'tuesday', short: 'Tue' },
  { full: 'wednesday', short: 'Wed' },
  { full: 'thursday', short: 'Thu' },
  { full: 'friday', short: 'Fri' },
  { full: 'saturday', short: 'Sat' },
  { full: 'sunday', short: 'Sun' },
];

/**
 * Formats a readable pattern summary string (e.g. "Mon 1, Tue 1, Wed 2, ...")
 */
export function formatPatternSummary(
  pattern: Record<string, any> = {},
  isMonthly = false,
  slots?: Record<string, any>
): string {
  if (isMonthly) {
    const datesWithMeals = Object.entries(pattern)
      .map(([k, v]) => ({ key: k, meals: Number(v) || 0 }))
      .filter((item) => item.meals > 0);

    if (datesWithMeals.length === 0) return 'No meals scheduled';
    if (datesWithMeals.length > 5) {
      return `${datesWithMeals.length} planned dates this month`;
    }
    return datesWithMeals
      .map((d) => {
        const s = slots?.[d.key];
        const slotLabel = s === 'both' ? 'Both' : s === 'dinner' ? 'Dinner' : s === 'lunch' ? 'Lunch' : `${d.meals} ${d.meals === 1 ? 'meal' : 'meals'}`;
        return `Date ${d.key.split('-').pop()}: ${slotLabel}`;
      })
      .join(', ');
  }

  // Weekly pattern: "Mon Lunch, Tue Dinner, ..."
  const parts: string[] = [];
  WEEKDAY_NAMES.forEach(({ full, short }) => {
    const count = Number(pattern[full] ?? pattern[short.toLowerCase()] ?? pattern[short] ?? 0);
    const s = slots?.[short.toLowerCase()] ?? slots?.[full];
    if (count > 0) {
      const slotLabel = s === 'both' ? 'Both' : s === 'dinner' ? 'Dinner' : s === 'lunch' ? 'Lunch' : `${count}`;
      parts.push(`${short} ${slotLabel}`);
    } else {
      parts.push(`${short} Skip`);
    }
  });

  return parts.length > 0 ? parts.join(', ') : 'No schedule set';
}

export function SubscriptionManager({
  userId: propUserId,
  initialSubscriptions,
  onModifyPlan,
  onCreateNewPlan,
  className,
}: SubscriptionManagerProps) {
  const authUser = useAuthStore((s) => s.user);
  const targetUserId = propUserId || authUser?.id;

  const [subscriptions, setSubscriptions] = useState<Subscription[]>(
    initialSubscriptions || []
  );
  const [loading, setLoading] = useState<boolean>(!initialSubscriptions);
  const [selectedSubForDetails, setSelectedSubForDetails] = useState<Subscription | null>(null);
  const [subToPause, setSubToPause] = useState<Subscription | null>(null);
  const [subToCancel, setSubToCancel] = useState<Subscription | null>(null);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [notification, setNotification] = useState<string | null>(null);

  // ── 1. Fetch & Listen to Subscriptions ────────────────────────────────────────
  useEffect(() => {
    if (!targetUserId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const q = query(
      collection(db, 'subscriptions'),
      where('user_id', '==', targetUserId)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Subscription[];

        // Filter: Active or Paused, and MUST be a custom plan (isCustomPlan = true)
        const customPlans = list.filter((sub: any) => {
          const isCustom =
            sub.isCustomPlan === true ||
            sub.is_custom_plan === true ||
            sub.subscriptionType === 'custom_weekly' ||
            sub.subscriptionType === 'custom_monthly' ||
            sub.plan_id === 'custom_weekly' ||
            sub.plan_id === 'custom_monthly';

          const isActiveOrPaused = sub.status === 'active' || sub.status === 'paused';
          return isCustom && isActiveOrPaused;
        });

        setSubscriptions(customPlans);
        setLoading(false);
      },
      (err) => {
        console.warn('[SubscriptionManager] onSnapshot error, falling back to query:', err);
        getUserSubscriptions(targetUserId).then((allSubs) => {
          const customPlans = allSubs.filter((sub: any) => {
            const isCustom =
              sub.isCustomPlan === true ||
              sub.is_custom_plan === true ||
              sub.subscriptionType === 'custom_weekly' ||
              sub.subscriptionType === 'custom_monthly' ||
              sub.plan_id === 'custom_weekly' ||
              sub.plan_id === 'custom_monthly';
            const isActiveOrPaused = sub.status === 'active' || sub.status === 'paused';
            return isCustom && isActiveOrPaused;
          });
          setSubscriptions(customPlans);
          setLoading(false);
        });
      }
    );

    return () => unsubscribe();
  }, [targetUserId]);

  // ── 2. Action Handlers ────────────────────────────────────────────────────────
  const handlePause = async (sub: Subscription) => {
    setActionLoading(true);
    try {
      await pauseSubscription(sub.id, targetUserId);
      setNotification(`Subscription ${sub.id} paused temporarily.`);
      setSubToPause(null);
    } catch (err) {
      console.error('Failed to pause subscription:', err);
      alert('Could not pause subscription. Please try again.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async (sub: Subscription) => {
    setActionLoading(true);
    try {
      await resumeSubscription(sub.id, targetUserId);
      setNotification(`Subscription ${sub.id} is now active again!`);
    } catch (err) {
      console.error('Failed to resume subscription:', err);
      alert('Could not resume subscription. Please try again.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async (sub: Subscription) => {
    setActionLoading(true);
    try {
      await cancelSubscription(sub.id, 'user', targetUserId);
      setNotification(`Subscription ${sub.id} has been cancelled.`);
      setSubToCancel(null);
      if (selectedSubForDetails?.id === sub.id) {
        setSelectedSubForDetails(null);
      }
    } catch (err) {
      console.error('Failed to cancel subscription:', err);
      alert('Could not cancel subscription. Please try again.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleModify = (sub: Subscription) => {
    if (onModifyPlan) {
      onModifyPlan(sub);
    } else {
      // Default navigation to builder. Runs inside the handleModify click
      // handler, not render. (Note: this is a full page load rather than a
      // client-side router.push, which is a deliberate fallback here.)
      // eslint-disable-next-line react-hooks/immutability
      window.location.href = `/custom-plan?modifySubId=${sub.id}`;
    }
  };

  return (
    <div className={cn('w-full max-w-4xl mx-auto space-y-6', className)}>
      {/* ── Top Header & Title ────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-6 rounded-3xl bg-white/90 backdrop-blur-md border border-amber-100 shadow-lg shadow-amber-900/5">
        <div>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/80 text-amber-800 text-xs font-bold tracking-wide uppercase mb-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-amber-600" />
            Custom Meal Subscriptions
          </div>
          <h2 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
            Manage Your Custom Plans
          </h2>
          <p className="text-slate-500 text-xs sm:text-sm font-medium mt-0.5">
            View schedules, pause deliveries, or modify your weekly & monthly patterns
          </p>
        </div>

        {onCreateNewPlan && (
          <button
            type="button"
            onClick={onCreateNewPlan}
            className="self-start sm:self-center px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold text-xs sm:text-sm shadow-md shadow-amber-500/20 active:scale-95 transition-all flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            New Custom Plan
          </button>
        )}
      </div>

      {/* ── Status Notification Toast Banner ───────────────────────────────── */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs sm:text-sm font-semibold flex items-center justify-between shadow-xs"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{notification}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotification(null)}
              className="text-xs font-bold underline text-emerald-700 hover:text-emerald-900"
            >
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Loading Skeleton State ────────────────────────────────────────── */}
      {loading && (
        <div className="space-y-4">
          {[1, 2].map((n) => (
            <div
              key={n}
              className="h-48 rounded-3xl bg-white border border-slate-100 animate-pulse p-6"
            />
          ))}
        </div>
      )}

      {/* ── Empty State ───────────────────────────────────────────────────── */}
      {!loading && subscriptions.length === 0 && (
        <div className="text-center p-8 sm:p-12 rounded-3xl bg-white/90 border border-amber-100 shadow-sm">
          <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-3">
            <Calendar className="w-7 h-7" />
          </div>
          <h3 className="text-lg font-black text-slate-900">No Active Custom Plans Found</h3>
          <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto mt-1 mb-5">
            You haven't customized a meal subscription yet. Tailor your days and meal counts with our weekly or monthly plan builder.
          </p>
          {onCreateNewPlan ? (
            <button
              type="button"
              onClick={onCreateNewPlan}
              className="px-5 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold text-sm shadow-md shadow-amber-500/25 active:scale-95 transition-all"
            >
              Build a Custom Plan
            </button>
          ) : (
            <a
              href="/custom-plan"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold text-sm shadow-md shadow-amber-500/25 active:scale-95 transition-all"
            >
              <span>Build a Custom Plan</span>
              <ArrowRight className="w-4 h-4" />
            </a>
          )}
        </div>
      )}

      {/* ── Active Subscriptions List ──────────────────────────────────────── */}
      <div className="space-y-5">
        {subscriptions.map((sub: any) => {
          const isWeekly =
            sub.billingCycle === 'weekly' ||
            sub.frequency === 'weekly' ||
            sub.subscriptionType === 'custom_weekly';

          const pattern =
            sub.customPlan?.pattern || sub.deliveryPattern || sub.delivery_pattern || {};
          const totalMeals =
            sub.customPlan?.totalMeals || sub.totalMeals || Object.values(pattern).reduce<number>((a, b) => a + (Number(b) || 0), 0);
          const totalPrice =
            sub.customPlan?.totalPrice || sub.total_price || sub.price || 0;

          const isActive = sub.status === 'active' && !isSubscriptionExpired(sub as any);
          const isPaused = sub.status === 'paused';

          const patternSummary = formatPatternSummary(
            pattern,
            !isWeekly,
            (sub as any).custom_slots || (sub as any).customSlots
          );

          return (
            <div
              key={sub.id}
              className={cn(
                'rounded-3xl bg-white/95 backdrop-blur-md border p-4 sm:p-6 shadow-md transition-all',
                isActive ? 'border-amber-200/90 shadow-amber-900/5' : 'border-slate-200 opacity-90'
              )}
            >
              {/* Card Header: Plan Type Badge, Status, ID */}
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3.5 border-b border-slate-100">
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      'px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider',
                      isWeekly
                        ? 'bg-amber-100 text-amber-900 border border-amber-200'
                        : 'bg-orange-100 text-orange-900 border border-orange-200'
                    )}
                  >
                    {isWeekly ? 'Weekly Custom' : 'Monthly Custom'}
                  </span>

                  <span
                    className={cn(
                      'px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5',
                      isActive
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                        : 'bg-amber-100 text-amber-800 border border-amber-200'
                    )}
                  >
                    <span
                      className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        isActive ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                      )}
                    />
                    {isActive ? 'Active' : 'Paused'}
                  </span>
                </div>

                <div className="text-[11px] font-mono text-slate-500">
                  ID: {sub.id.slice(0, 16)}...
                </div>
              </div>

              {/* Main Info Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 py-4 text-xs sm:text-sm">
                <div>
                  <span className="text-[11px] uppercase font-bold text-slate-500 block">
                    Total Meals
                  </span>
                  <span className="font-extrabold text-slate-900 text-base">
                    {totalMeals} {isWeekly ? 'meals/week' : 'meals/month'}
                  </span>
                </div>

                <div>
                  <span className="text-[11px] uppercase font-bold text-slate-500 block">
                    Total Price
                  </span>
                  <span className="font-extrabold text-amber-600 text-base">
                    ₹{totalPrice} {isWeekly ? '/week' : '/month'}
                  </span>
                </div>

                <div>
                  <span className="text-[11px] uppercase font-bold text-slate-500 block">
                    Start Date
                  </span>
                  <span className="font-bold text-slate-800">
                    {formatDate(sub.startDate || sub.start_date || sub.createdAt || sub.created_at)}
                  </span>
                </div>

                <div>
                  <span className="text-[11px] uppercase font-bold text-slate-500 block">
                    Next Billing Date
                  </span>
                  <span className="font-bold text-slate-800">
                    {formatDate(sub.nextBillingDate || sub.next_billing_date) || 'Auto-renews'}
                  </span>
                </div>
              </div>

              {/* Pattern Summary Banner */}
              <div className="p-3 rounded-2xl bg-amber-50/70 border border-amber-100 text-xs font-semibold text-slate-700 mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 overflow-hidden">
                  <Utensils className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  <span className="truncate">
                    <span className="font-bold text-slate-900 mr-1">Pattern:</span>
                    {patternSummary}
                  </span>
                </div>
              </div>

              {/* Custom Thali Manifest Banner */}
              {Boolean(sub.custom_meal_config?.manifestSummary || sub.meal_components?.length) && (
                <div className="p-3 rounded-2xl bg-orange-50/70 border border-orange-200/80 text-xs font-semibold text-slate-700 mb-4 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <span className="text-sm shrink-0">🍱</span>
                    <span className="truncate">
                      <span className="font-bold text-orange-950 mr-1">Custom Portions:</span>
                      <span className="text-orange-900 font-medium">
                        {sub.custom_meal_config?.manifestSummary || sub.meal_components?.join(', ')}
                      </span>
                    </span>
                  </div>
                  {Boolean(sub.custom_meal_config?.customerDeltaPerMeal) && (
                    <span className="shrink-0 text-[10px] font-black px-2 py-0.5 rounded-full bg-orange-200/70 text-orange-900">
                      {sub.custom_meal_config.customerDeltaPerMeal > 0 ? `+₹${sub.custom_meal_config.customerDeltaPerMeal}` : `-₹${Math.abs(sub.custom_meal_config.customerDeltaPerMeal)}`}/meal
                    </span>
                  )}
                </div>
              )}

              {/* Dedicated Pattern Visualizer */}
              <div className="mb-5">
                {isWeekly ? (
                  /* ── Weekly Pattern Preview (Mon-Sun View) ── */
                  <div>
                    <span className="text-[11px] uppercase font-bold text-slate-500 mb-2 block">
                      Week Schedule Pattern
                    </span>
                    <div className="grid grid-cols-7 gap-1 sm:gap-2">
                      {WEEKDAY_NAMES.map(({ full, short }) => {
                        const count = Number(
                          pattern[full] ?? pattern[short.toLowerCase()] ?? pattern[short] ?? 0
                        );
                        const is1 = count === 1;
                        const is2 = count === 2;

                        return (
                          <div
                            key={short}
                            className={cn(
                              'flex flex-col items-center justify-center p-2 rounded-xl text-center border transition-all',
                              is2
                                ? 'bg-gradient-to-b from-amber-50 to-orange-50 border-orange-300 ring-1 ring-orange-300/40'
                                : is1
                                ? 'bg-amber-50/80 border-amber-300 ring-1 ring-amber-300/40'
                                : 'bg-slate-50 border-slate-200/80'
                            )}
                          >
                            <span className="text-[11px] font-bold text-slate-600">
                              {short}
                            </span>
                            <span
                              className={cn(
                                'text-xs font-black mt-0.5',
                                is2
                                  ? 'text-orange-600'
                                  : is1
                                  ? 'text-amber-600'
                                  : 'text-slate-400'
                              )}
                            >
                              {is2 ? '2' : is1 ? '1' : 'Skip'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  /* ── Monthly Mini Calendar Preview ── */
                  <div>
                    <span className="text-[11px] uppercase font-bold text-slate-500 mb-2 block">
                      Month Calendar Preview (Active Dates)
                    </span>
                    <MiniMonthCalendar pattern={pattern} />
                  </div>
                )}
              </div>

              {/* ── Action Buttons ───────────────────────────────────────── */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-3.5 border-t border-slate-100">
                <div className="flex items-center gap-2">
                  {/* [View Details] Button */}
                  <button
                    type="button"
                    onClick={() => setSelectedSubForDetails(sub)}
                    className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs transition-colors flex items-center gap-1.5 active:scale-95"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    View Details
                  </button>

                  {/* [Modify] Button */}
                  <button
                    type="button"
                    onClick={() => handleModify(sub)}
                    className="px-3.5 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 font-bold text-xs transition-colors flex items-center gap-1.5 active:scale-95"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Modify
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {/* [Pause / Resume] Button */}
                  {isActive ? (
                    <button
                      type="button"
                      onClick={() => setSubToPause(sub)}
                      className="px-3.5 py-2 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-700 font-bold text-xs transition-colors flex items-center gap-1.5 active:scale-95"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleResume(sub)}
                      className="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-xs transition-colors flex items-center gap-1.5 active:scale-95 shadow-sm"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Resume
                    </button>
                  )}

                  {/* [Cancel] Button */}
                  <button
                    type="button"
                    onClick={() => setSubToCancel(sub)}
                    className="px-3.5 py-2 rounded-xl text-red-600 hover:bg-red-50 border border-red-200 font-bold text-xs transition-colors flex items-center gap-1.5 active:scale-95"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── View Details Modal (Full Calendar & Specs) ──────────────────────── */}
      <AnimatePresence>
        {selectedSubForDetails && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-lg bg-white rounded-3xl p-6 shadow-2xl border border-slate-100 text-left max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
                <div>
                  <h3 className="text-xl font-black text-slate-900">Subscription Details</h3>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">
                    {selectedSubForDetails.id}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedSubForDetails(null)}
                  className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold flex items-center justify-center"
                >
                  ✕
                </button>
              </div>

              {/* Status & Plan Info */}
              <div className="p-4 rounded-2xl bg-amber-50/70 border border-amber-200 mb-4 space-y-2 text-xs sm:text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-600">Plan Type:</span>
                  <span className="font-bold text-slate-900">
                    {selectedSubForDetails.subscriptionType === 'custom_monthly'
                      ? 'Monthly Custom Plan'
                      : 'Weekly Custom Plan'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Status:</span>
                  <span className="font-bold capitalize text-emerald-700">
                    {selectedSubForDetails.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Total Price:</span>
                  <span className="font-black text-amber-600">
                    ₹{selectedSubForDetails.customPlan?.totalPrice || selectedSubForDetails.price}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Start Date:</span>
                  <span className="font-bold text-slate-800">
                    {formatDate((selectedSubForDetails as any).startDate || selectedSubForDetails.created_at)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Next Billing:</span>
                  <span className="font-bold text-slate-800">
                    {formatDate(selectedSubForDetails.next_billing_date) || 'Auto-renewal active'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Delivery Status:</span>
                  <span className="font-bold text-slate-800">
                    {(selectedSubForDetails as any).delivery_status || 'Ready for Delivery'}
                  </span>
                </div>
              </div>

              {/* Full Pattern View */}
              <div className="mb-5">
                <h4 className="text-xs font-black uppercase text-slate-500 mb-2">
                  Full Meal Schedule Breakdown
                </h4>
                {selectedSubForDetails.subscriptionType === 'custom_monthly' ? (
                  <MiniMonthCalendar
                    pattern={
                      selectedSubForDetails.customPlan?.pattern ||
                      selectedSubForDetails.deliveryPattern ||
                      {}
                    }
                  />
                ) : (
                  <div className="grid grid-cols-7 gap-1.5 p-2 rounded-xl bg-slate-50 border border-slate-200">
                    {WEEKDAY_NAMES.map(({ full, short }) => {
                      const pattern =
                        selectedSubForDetails.customPlan?.pattern ||
                        selectedSubForDetails.deliveryPattern ||
                        {};
                      const count = Number(
                        pattern[full] ?? pattern[short.toLowerCase()] ?? pattern[short] ?? 0
                      );
                      return (
                        <div key={short} className="text-center p-2 rounded-lg bg-white shadow-xs">
                          <div className="text-[10px] font-bold text-slate-500">{short}</div>
                          <div
                            className={cn(
                              'text-sm font-black mt-1',
                              count === 2
                                ? 'text-orange-600'
                                : count === 1
                                ? 'text-amber-600'
                                : 'text-slate-300'
                            )}
                          >
                            {count || 'Skip'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const sub = selectedSubForDetails;
                    setSelectedSubForDetails(null);
                    handleModify(sub);
                  }}
                  className="flex-1 py-3 rounded-xl bg-amber-500 text-white font-bold text-sm hover:bg-amber-600"
                >
                  Modify Pattern
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedSubForDetails(null)}
                  className="px-5 py-3 rounded-xl border border-slate-200 text-slate-700 font-bold text-sm hover:bg-slate-50"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Pause Confirmation Dialog ─────────────────────────────────────── */}
      <AnimatePresence>
        {subToPause && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md bg-white rounded-3xl p-6 shadow-2xl border border-slate-100 text-left"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-100 flex items-center justify-center text-amber-600">
                  <Pause className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-slate-900">Pause Subscription?</h3>
                  <p className="text-xs text-slate-500">Temporarily halt upcoming meal deliveries</p>
                </div>
              </div>

              <p className="text-xs text-slate-600 mb-5 leading-relaxed">
                Your subscription deliveries will be paused starting tomorrow. You can resume at any time from this dashboard.
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSubToPause(null)}
                  className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-700 font-bold text-xs sm:text-sm hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => handlePause(subToPause)}
                  className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs sm:text-sm shadow-md shadow-amber-500/20"
                >
                  {actionLoading ? 'Pausing...' : 'Confirm Pause'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Cancel Confirmation Dialog ────────────────────────────────────── */}
      <AnimatePresence>
        {subToCancel && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md bg-white rounded-3xl p-6 shadow-2xl border border-slate-100 text-left"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-2xl bg-red-100 flex items-center justify-center text-red-600">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-slate-900">Cancel Subscription?</h3>
                  <p className="text-xs text-slate-500">This action cannot be undone</p>
                </div>
              </div>

              <p className="text-xs text-slate-600 mb-5 leading-relaxed">
                Are you sure you want to cancel this custom plan? Your automatic renewals and deliveries will terminate immediately.
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSubToCancel(null)}
                  className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-700 font-bold text-xs sm:text-sm hover:bg-slate-50"
                >
                  Keep Subscription
                </button>
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => handleCancel(subToCancel)}
                  className="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs sm:text-sm shadow-md shadow-red-600/20"
                >
                  {actionLoading ? 'Cancelling...' : 'Confirm Cancel'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Mini Month Calendar component displaying active dates for Monthly Custom Plans
 */
function MiniMonthCalendar({ pattern = {} }: { pattern: Record<string, any> }) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;

  return (
    <div className="p-3 rounded-2xl bg-slate-50/80 border border-slate-200 text-center">
      <div className="grid grid-cols-7 gap-1 mb-1.5 text-[10px] font-bold text-slate-400 uppercase">
        <span>Mon</span>
        <span>Tue</span>
        <span>Wed</span>
        <span>Thu</span>
        <span>Fri</span>
        <span>Sat</span>
        <span>Sun</span>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: startOffset }).map((_, idx) => (
          <div key={`empty-${idx}`} className="h-6 rounded-md bg-slate-100/40" />
        ))}

        {Array.from({ length: daysInMonth }).map((_, idx) => {
          const dayNum = idx + 1;
          const dayKey = String(dayNum);
          const fullKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
          const meals = Number(pattern[dayKey] ?? pattern[fullKey] ?? 0);

          return (
            <div
              key={dayNum}
              className={cn(
                'h-6 rounded-md text-[10px] font-bold flex items-center justify-center transition-all',
                meals === 2
                  ? 'bg-orange-500 text-white shadow-xs'
                  : meals === 1
                  ? 'bg-amber-400 text-white shadow-xs'
                  : 'bg-white text-slate-500 border border-slate-100'
              )}
              title={`Day ${dayNum}: ${meals} meals`}
            >
              {dayNum}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-3 mt-2.5 pt-2 border-t border-slate-200/60 text-[10px] text-slate-600 font-semibold">
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm bg-amber-400 inline-block" /> 1 Meal
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm bg-orange-500 inline-block" /> 2 Meals
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm bg-white border border-slate-200 inline-block" /> Skip
        </span>
      </div>
    </div>
  );
}

export default SubscriptionManager;
