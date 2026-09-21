'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Calendar,
  Utensils,
  Sparkles,
  RotateCcw,
  CreditCard,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Info,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  CalendarDays,
  Sun,
  Moon,
  Check,
  Clock
} from 'lucide-react';
import { getPricingConfig, DEFAULT_MONTHLY_PRICING } from '@/lib/queries/pricing';
import { calculateCustomPlanPrice } from '@/lib/pricing';
import { calculateSubscriptionPrice, DEFAULT_STANDARD_MEAL } from '@/lib/pricingEngine';
import { getUserSubscriptions } from '@/lib/queries/subscriptions';
import { isSubscriptionActive } from '@dabzzo/shared-lib/subscriptionEntitlement';
import { CustomPlanCheckoutModal } from './CustomPlanCheckoutModal';
import { ThaliCustomizer, ThaliCustomizerConfig } from './ThaliCustomizer';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/lib/utils';
import type { Subscription } from '@/types';

export type MealCount = 0 | 1 | 2; // 0 = Skip, 1 = 1 Meal, 2 = 2 Meals
export type MealSlotChoice = 'skip' | 'lunch' | 'dinner' | 'both';

export interface MonthlyPlanDateSelection {
  dayIndex: number; // 1..28
  dateKey: string; // 'YYYY-MM-DD'
  dayNumber: number; // 1..31
  monthName: string; // 'Sep', 'Oct', ...
  fullMonthName: string; // 'September', ...
  year: number;
  dayOfWeek: string; // 'Monday', 'Tuesday', ...
  shortDay: string; // 'Mon', 'Tue', ...
  date: Date;
  slot: MealSlotChoice;
  meals: MealCount;
  isToday: boolean;
}

export interface MonthlyPlanBuilderResult {
  startDate: Date;
  endDate: Date;
  dateRangeStr: string;
  year: number;
  month: number; // 0-indexed (0=Jan, 8=Sept)
  monthName: string; // e.g. 'September'
  pattern: Record<string, number>;
  slots: Record<string, MealSlotChoice>;
  selections: Record<string, MealCount>;
  dateDetails: MonthlyPlanDateSelection[];
  totalMeals: number;
  pricePerMeal: number;
  monthlyTotal: number;
  customMealConfig?: ThaliCustomizerConfig | null;
  vendorId?: string;
  slotCounts: {
    lunch: number;
    dinner: number;
    both: number;
    skip: number;
  };
}

export interface MonthlyCustomPlanBuilderProps {
  /**
   * Optional initial price per meal. Overridden once getPricingConfig("monthly") resolves.
   */
  initialPricePerMeal?: number;
  /**
   * Optional reference start date for the 28-day window (defaults to Tomorrow).
   */
  startDate?: Date;
  /**
   * Initial Year (kept for backward compatibility).
   */
  initialYear?: number;
  /**
   * Initial Month (0-indexed, kept for backward compatibility).
   */
  initialMonth?: number;
  /**
   * Pre-selected meal counts by dateKey ('YYYY-MM-DD').
   */
  initialSelections?: Record<string, MealCount>;
  /**
   * Pre-selected meal slots by dateKey ('YYYY-MM-DD').
   */
  initialSlots?: Record<string, MealSlotChoice>;
  /**
   * Selected vendor ID if scoping to a specific kitchen.
   */
  vendorId?: string;
  /**
   * Optional vendor custom component rates and overrides.
   */
  vendorOverrides?: Record<string, any>;
  /**
   * Optional custom kitchen margin override percentage (e.g. 40).
   */
  vendorMarginOverride?: number;
  /**
   * Callback fired whenever any date's meal selection changes.
   */
  onPlanChange?: (result: MonthlyPlanBuilderResult) => void;
  /**
   * Callback fired when [Confirm & Checkout] is clicked.
   */
  onConfirmCheckout?: (result: MonthlyPlanBuilderResult) => void;
  /**
   * Callback fired when [Reset] is clicked.
   */
  onReset?: () => void;
  /**
   * Additional wrapper CSS class names.
   */
  className?: string;
  /**
   * Whether to hide the top heading/subtitle.
   */
  hideHeader?: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatDateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Calculates 28 consecutive days starting from the given startDate.
 */
export function getNext28Days(startDate: Date): Array<{
  dayIndex: number;
  dateKey: string;
  dayNumber: number;
  monthName: string;
  fullMonthName: string;
  year: number;
  dayOfWeek: string;
  shortDay: string;
  date: Date;
  isToday: boolean;
}> {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const shortDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);

    const year = d.getFullYear();
    const month = d.getMonth();
    const dayNumber = d.getDate();
    const dateKey = formatDateKey(year, month, dayNumber);
    const isToday = d.getTime() === today.getTime();

    days.push({
      dayIndex: i + 1,
      dateKey,
      dayNumber,
      monthName: MONTH_NAMES_SHORT[month],
      fullMonthName: MONTH_NAMES[month],
      year,
      dayOfWeek: dayNames[d.getDay()],
      shortDay: shortDayNames[d.getDay()],
      date: d,
      isToday,
    });
  }
  return days;
}

export function MonthlyCustomPlanBuilder({
  initialPricePerMeal,
  startDate,
  initialYear,
  initialMonth,
  initialSelections,
  initialSlots,
  vendorId,
  vendorOverrides,
  vendorMarginOverride,
  onPlanChange,
  onConfirmCheckout,
  onReset,
  className,
  hideHeader = false,
}: MonthlyCustomPlanBuilderProps) {
  const user = useAuthStore((s) => s.user);

  // Default start date: tomorrow (can be switched to today or custom date)
  const defaultStartDate = useMemo(() => {
    if (startDate) return new Date(startDate);
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [startDate]);

  const [planStartDate, setPlanStartDate] = useState<Date>(defaultStartDate);

  // 28 days calculated from planStartDate
  const days28 = useMemo(() => getNext28Days(planStartDate), [planStartDate]);

  // Calendar grid alignment for MON-SUN header (Monday=0 ... Sunday=6)
  const startOffset = useMemo(() => (days28[0].date.getDay() + 6) % 7, [days28]);
  const endOffset = useMemo(() => (7 - ((startOffset + 28) % 7)) % 7, [startOffset]);

  // Date range formatted label
  const dateRangeFormatted = useMemo(() => {
    if (days28.length === 0) return '';
    const first = days28[0];
    const last = days28[27];
    return `${first.shortDay}, ${first.dayNumber} ${first.monthName} – ${last.shortDay}, ${last.dayNumber} ${last.monthName} ${last.year}`;
  }, [days28]);

  // Start-month options, so a plan can be booked for a coming month rather
  // than only the rolling window that begins today. The 28-day window is not
  // month-aligned, so "October" means "start the window on 1 October"; for the
  // current month it means today, since the 1st has already passed.
  const upcomingMonths = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 4 }, (_, i) => {
      const first = new Date(today.getFullYear(), today.getMonth() + i, 1);
      return {
        key: `${first.getFullYear()}-${first.getMonth()}`,
        label: first.toLocaleString('en-IN', { month: 'short' }),
        year: first.getFullYear(),
        month: first.getMonth(),
        start: i === 0 ? today : first,
      };
    });
  }, []);

  // Check if current start date is tomorrow or today
  const isStartTomorrow = useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return planStartDate.toDateString() === tomorrow.toDateString();
  }, [planStartDate]);

  const isStartToday = useMemo(() => {
    const today = new Date();
    return planStartDate.toDateString() === today.toDateString();
  }, [planStartDate]);

  // Slot selections keyed by 'YYYY-MM-DD' ('skip' | 'lunch' | 'dinner' | 'both')
  const [slots, setSlots] = useState<Record<string, MealSlotChoice>>(() => {
    if (initialSlots) return { ...initialSlots };
    if (initialSelections) {
      const converted: Record<string, MealSlotChoice> = {};
      Object.entries(initialSelections).forEach(([dateKey, count]) => {
        converted[dateKey] = count === 2 ? 'both' : count === 1 ? 'lunch' : 'skip';
      });
      return converted;
    }
    return {};
  });

  const [pricePerMeal, setPricePerMeal] = useState<number>(
    initialPricePerMeal ?? DEFAULT_MONTHLY_PRICING.pricePerMeal ?? 50
  );
  const [customMealConfig, setCustomMealConfig] = useState<ThaliCustomizerConfig | null>(null);

  // Memoised so ThaliCustomizer's notify-parent effect does not see a new
  // function identity on every render. That effect lists `onChange` in its deps,
  // so an inline arrow here re-ran it each render, which set state here, which
  // re-rendered -- "Maximum update depth exceeded". ThaliCustomizer also skips
  // propagating an unchanged payload; both halves are needed.
  const handleCustomMealChange = useCallback(
    (config: ThaliCustomizerConfig) => setCustomMealConfig(config),
    [],
  );
  const [isLoadingPricing, setIsLoadingPricing] = useState<boolean>(true);
  const [existingPlanLoaded, setExistingPlanLoaded] = useState<string | null>(null);
  const [checkoutWarning, setCheckoutWarning] = useState<string | null>(null);
  const [showConfirmationModal, setShowConfirmationModal] = useState<boolean>(false);

  // 1. Fetch current pricePerMeal on load using getPricingConfig("monthly")
  useEffect(() => {
    let isMounted = true;
    async function loadMonthlyPricing() {
      try {
        setIsLoadingPricing(true);
        const config = await getPricingConfig('monthly');
        if (isMounted && config && typeof config.pricePerMeal === 'number') {
          const resolvedPrice = config.pricePerMeal > 300 
            ? Math.round(config.pricePerMeal / 28) 
            : config.pricePerMeal;
          setPricePerMeal(resolvedPrice || 50);
        }
      } catch (err) {
        console.warn('[MonthlyCustomPlanBuilder] Failed to fetch monthly pricing:', err);
        if (isMounted) {
          setPricePerMeal(initialPricePerMeal ?? 50);
        }
      } finally {
        if (isMounted) {
          setIsLoadingPricing(false);
        }
      }
    }

    loadMonthlyPricing();
    return () => {
      isMounted = false;
    };
  }, [initialPricePerMeal]);

  // 2. Pre-populate if user has existing monthly plan (show their current selections)
  useEffect(() => {
    if ((initialSlots && Object.keys(initialSlots).length > 0) || (initialSelections && Object.keys(initialSelections).length > 0)) {
      return;
    }

    let isMounted = true;
    async function checkExistingMonthlySubscription() {
      if (!user?.id) return;

      try {
        const subs: Subscription[] = await getUserSubscriptions(user.id);
        const nowMs = Date.now();
        const activeMonthly = subs.find(
          (s) => s.status === 'active' && s.frequency === 'monthly' && isSubscriptionActive(s as any, nowMs)
        );

        if (!activeMonthly || !isMounted) return;

        // Check if existing subscription has custom schedule saved
        const customSlots = (activeMonthly as any).custom_slots as Record<string, MealSlotChoice> | undefined;
        const customSchedule = (activeMonthly as any).custom_schedule as Record<string, MealCount> | undefined;
        const populated: Record<string, MealSlotChoice> = {};

        if (customSlots && Object.keys(customSlots).length > 0) {
          Object.entries(customSlots).forEach(([k, v]) => {
            populated[k] = v;
          });
          setExistingPlanLoaded('Loaded custom slots from your active monthly plan');
        } else if (customSchedule && Object.keys(customSchedule).length > 0) {
          Object.entries(customSchedule).forEach(([k, v]) => {
            populated[k] = v === 2 ? 'both' : v === 1 ? 'lunch' : 'skip';
          });
          setExistingPlanLoaded('Loaded custom schedule from your active monthly plan');
        } else {
          // If standard monthly subscription, pre-populate days based on meal_type
          const defaultSlot: MealSlotChoice =
            activeMonthly.meal_type === 'both' ? 'both' :
            activeMonthly.meal_type === 'dinner' ? 'dinner' : 'lunch';

          days28.forEach((day) => {
            populated[day.dateKey] = defaultSlot;
          });
          setExistingPlanLoaded(
            `Pre-populated ${defaultSlot === 'both' ? 'Lunch + Dinner' : defaultSlot === 'dinner' ? 'Dinner' : 'Lunch'} from your active subscription`
          );
        }

        setSlots((prev) => ({
          ...populated,
          ...prev, // preserve any immediate manual edits
        }));
      } catch (err) {
        console.warn('[MonthlyCustomPlanBuilder] Error loading existing user subscription:', err);
      }
    }

    checkExistingMonthlySubscription();
    return () => {
      isMounted = false;
    };
  }, [user?.id, days28, initialSelections, initialSlots]);

  // 3. Derive numeric meal selections from slots
  const selections = useMemo(() => {
    const map: Record<string, MealCount> = {};
    days28.forEach((day) => {
      const s = slots[day.dateKey] || 'skip';
      map[day.dateKey] = s === 'both' ? 2 : (s === 'lunch' || s === 'dinner') ? 1 : 0;
    });
    return map;
  }, [days28, slots]);

  // Count slots
  const slotCounts = useMemo(() => {
    let lunch = 0;
    let dinner = 0;
    let both = 0;
    let skip = 0;
    days28.forEach((day) => {
      const s = slots[day.dateKey] || 'skip';
      if (s === 'lunch') lunch++;
      else if (s === 'dinner') dinner++;
      else if (s === 'both') both++;
      else skip++;
    });
    return { lunch, dinner, both, skip };
  }, [days28, slots]);

  // Build monthly schedule for Central Pricing Engine
  const centralSchedule = useMemo(() => {
    const list: Array<{ dayKey: string; slot: 'lunch' | 'dinner' | 'both'; items: Record<string, number> }> = [];
    const selectedItems = customMealConfig?.components || DEFAULT_STANDARD_MEAL.itemQuantities;
    days28.forEach((day) => {
      const s = slots[day.dateKey] || 'skip';
      if (s === 'lunch' || s === 'dinner' || s === 'both') {
        list.push({
          dayKey: day.dateKey,
          slot: s,
          items: selectedItems,
        });
      }
    });
    return list;
  }, [days28, slots, customMealConfig?.components]);

  const centralSubscriptionPricing = useMemo(() => {
    if (centralSchedule.length === 0) return null;
    try {
      return calculateSubscriptionPrice(centralSchedule, DEFAULT_STANDARD_MEAL.itemQuantities);
    } catch {
      return null;
    }
  }, [centralSchedule]);

  // 4. Real-time Calculation using Central Pricing Engine & Custom Meal Deltas
  const totalMeals = Object.values(selections).reduce((a: number, b: number) => a + b, 0);
  const deltaPerMeal = customMealConfig?.customerDeltaPerMeal || 0;
  const effectivePricePerMeal = Math.max(0, Math.round((pricePerMeal + deltaPerMeal) * 100) / 100);
  const monthlyTotal = Math.round(totalMeals * effectivePricePerMeal * 100) / 100;

  // Notify parent on changes
  useEffect(() => {
    if (onPlanChange && days28.length === 28) {
      const dateDetails: MonthlyPlanDateSelection[] = days28.map((day) => ({
        dayIndex: day.dayIndex,
        dateKey: day.dateKey,
        dayNumber: day.dayNumber,
        monthName: day.monthName,
        fullMonthName: day.fullMonthName,
        year: day.year,
        dayOfWeek: day.dayOfWeek,
        shortDay: day.shortDay,
        date: day.date,
        slot: slots[day.dateKey] || 'skip',
        meals: selections[day.dateKey] || 0,
        isToday: day.isToday,
      }));

      onPlanChange({
        startDate: days28[0].date,
        endDate: days28[27].date,
        dateRangeStr: dateRangeFormatted,
        year: days28[0].year,
        month: days28[0].date.getMonth(),
        monthName: days28[0].fullMonthName,
        pattern: selections,
        slots,
        selections,
        dateDetails,
        totalMeals,
        pricePerMeal: effectivePricePerMeal,
        monthlyTotal,
        customMealConfig: customMealConfig || undefined,
        vendorId,
        slotCounts,
      });
    }
  }, [slots, selections, totalMeals, effectivePricePerMeal, monthlyTotal, days28, dateRangeFormatted, customMealConfig, vendorId, slotCounts, onPlanChange]);

  // Start Date adjustments
  const handleShiftStartDate = (deltaDays: number) => {
    setCheckoutWarning(null);
    setPlanStartDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + deltaDays);
      // Clamp to today. The back arrow previously had no lower bound, so
      // holding it produced a plan starting in the past, with meals scheduled
      // for days that have already been and gone.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return next < today ? today : next;
    });
  };

  const handleSetStartMonth = (start: Date) => {
    setCheckoutWarning(null);
    const d = new Date(start);
    d.setHours(0, 0, 0, 0);
    setPlanStartDate(d);
  };

  const handleSetStartTomorrow = () => {
    setCheckoutWarning(null);
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    setPlanStartDate(d);
  };

  const handleSetStartToday = () => {
    setCheckoutWarning(null);
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setPlanStartDate(d);
  };

  // Slot selector handlers
  // Phone interaction for the 28-day grid.
  //
  // Seven columns on a ~375px screen leaves each day cell about 46px wide. The
  // cell also held four toggle buttons, so each rendered around 10px across --
  // unreadable, and far below the ~44px minimum touch target. On phones the whole
  // cell is now a single button that advances through the slot states, which needs
  // no horizontal room at all. The four-button row is kept from `sm` upwards,
  // where the cells are wide enough to earn it.
  const handleCycleSlot = useCallback((dateKey: string) => {
    const order: MealSlotChoice[] = ['skip', 'lunch', 'dinner', 'both'];
    setCheckoutWarning(null);
    setSlots((prev) => {
      const current = prev[dateKey] || 'skip';
      return { ...prev, [dateKey]: order[(order.indexOf(current) + 1) % order.length] };
    });
  }, []);

  const handleSetSlot = useCallback((dateKey: string, targetSlot: MealSlotChoice) => {
    setCheckoutWarning(null);
    setSlots((prev) => {
      const current = prev[dateKey] || 'skip';
      return {
        ...prev,
        [dateKey]: current === targetSlot ? 'skip' : targetSlot,
      };
    });
  }, []);

  // Quick Preset Handlers with Slots across 28 days
  const handleSelectWorkdaysSlot = useCallback((slot: 'lunch' | 'dinner' | 'both') => {
    setCheckoutWarning(null);
    setSlots((prev) => {
      const updated = { ...prev };
      days28.forEach((d) => {
        const dayOfWeek = d.date.getDay(); // 0 is Sun, 6 is Sat
        const isWeekday = dayOfWeek !== 0 && dayOfWeek !== 6;
        updated[d.dateKey] = isWeekday ? slot : 'skip';
      });
      return updated;
    });
  }, [days28]);

  const handleSelectAll28DaysSlot = useCallback((slot: 'lunch' | 'dinner' | 'both') => {
    setCheckoutWarning(null);
    setSlots((prev) => {
      const updated = { ...prev };
      days28.forEach((d) => {
        updated[d.dateKey] = slot;
      });
      return updated;
    });
  }, [days28]);

  // Bottom action: Clear All
  const handleClearAll = useCallback(() => {
    setCheckoutWarning(null);
    setSlots((prev) => {
      const cleared = { ...prev };
      days28.forEach((d) => {
        cleared[d.dateKey] = 'skip';
      });
      return cleared;
    });
    if (onReset) onReset();
  }, [days28, onReset]);

  // Bottom action: Confirm & Checkout with strict >= 30 meals rule
  const handleConfirmCheckout = useCallback(() => {
    if (totalMeals < 30) {
      setCheckoutWarning(
        `Monthly plans require a minimum of 30 meals. You currently have ${totalMeals} scheduled. Please add at least ${30 - totalMeals} more meal(s) to proceed, or switch to a Weekly Plan.`
      );
      return;
    }

    setCheckoutWarning(null);
    const dateDetails: MonthlyPlanDateSelection[] = days28.map((day) => ({
      dayIndex: day.dayIndex,
      dateKey: day.dateKey,
      dayNumber: day.dayNumber,
      monthName: day.monthName,
      fullMonthName: day.fullMonthName,
      year: day.year,
      dayOfWeek: day.dayOfWeek,
      shortDay: day.shortDay,
      date: day.date,
      slot: slots[day.dateKey] || 'skip',
      meals: selections[day.dateKey] || 0,
      isToday: day.isToday,
    }));

    const result: MonthlyPlanBuilderResult = {
      startDate: days28[0].date,
      endDate: days28[27].date,
      dateRangeStr: dateRangeFormatted,
      year: days28[0].year,
      month: days28[0].date.getMonth(),
      monthName: days28[0].fullMonthName,
      pattern: selections,
      slots,
      selections,
      dateDetails,
      totalMeals,
      pricePerMeal: effectivePricePerMeal,
      monthlyTotal,
      customMealConfig: customMealConfig || undefined,
      vendorId,
      slotCounts,
    };

    if (onConfirmCheckout) {
      onConfirmCheckout(result);
    } else {
      setShowConfirmationModal(true);
    }
  }, [totalMeals, days28, dateRangeFormatted, slots, selections, effectivePricePerMeal, monthlyTotal, customMealConfig, vendorId, slotCounts, onConfirmCheckout]);

  return (
    <div className={cn('w-full max-w-4xl mx-auto transition-all', className)}>
      {/* ── Heading & Brand Tag ────────────────────────────────────────────── */}
      {!hideHeader && (
        <div className="mb-6 text-left sm:text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100/80 border border-amber-300/80 text-amber-900 text-xs font-black tracking-wider uppercase mb-2 shadow-2xs">
            <CalendarDays className="w-3.5 h-3.5 text-amber-700" />
            Dabzzo 28-Day Monthly Plan Builder
          </div>
          <h2 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
            Design Your 28-Day Custom Meal Calendar
          </h2>
          <p className="text-slate-600 text-sm sm:text-base mt-1 font-medium">
            Pick your meals and delivery slots (<span className="text-amber-700 font-bold">☀️ Lunch</span> or <span className="text-indigo-700 font-bold">🌙 Dinner</span>) for the next 28 days
          </p>
        </div>
      )}

      {/* ── Active Subscription Banner ────────────────────────────────────── */}
      {existingPlanLoaded && (
        <div className="mb-5 p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs sm:text-sm font-semibold flex items-center justify-between gap-2 animate-fade-in shadow-2xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{existingPlanLoaded}</span>
          </div>
          <button
            type="button"
            onClick={() => setExistingPlanLoaded(null)}
            className="text-[11px] underline font-bold text-emerald-700 hover:text-emerald-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── 28-Day Plan Period & Start Date Bar ─────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 p-3.5 rounded-2xl bg-gradient-to-r from-amber-50/90 via-white to-orange-50/70 border border-amber-200 shadow-2xs">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleShiftStartDate(-1)}
              className="w-8 h-8 rounded-xl bg-white border border-amber-200 hover:bg-amber-50 flex items-center justify-center text-amber-900 active:scale-95 transition-all shadow-2xs"
              aria-label="Shift Start Date 1 Day Earlier"
              title="Start 1 day earlier"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => handleShiftStartDate(1)}
              className="w-8 h-8 rounded-xl bg-white border border-amber-200 hover:bg-amber-50 flex items-center justify-center text-amber-900 active:scale-95 transition-all shadow-2xs"
              aria-label="Shift Start Date 1 Day Later"
              title="Start 1 day later"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="ml-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-black uppercase tracking-wider text-amber-800 bg-amber-200/60 px-2 py-0.5 rounded-md">
                Next 28 Days
              </span>
              <span className="text-xs text-slate-500 font-bold hidden md:inline">
                (4 Full Weeks)
              </span>
            </div>
            <h3 className="text-base sm:text-lg font-black text-slate-900 tracking-tight mt-0.5">
              {dateRangeFormatted}
            </h3>
          </div>
        </div>

        {/* Start Date Quick Switchers & Counters */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleSetStartTomorrow}
              className={cn(
                'px-2.5 py-1.5 rounded-xl text-xs font-black transition-all active:scale-95 shadow-2xs',
                isStartTomorrow
                  ? 'bg-amber-500 text-white shadow-amber-500/20'
                  : 'bg-white border border-amber-200 hover:bg-amber-50 text-slate-700'
              )}
            >
              Start Tomorrow
            </button>
            <button
              type="button"
              onClick={handleSetStartToday}
              className={cn(
                'px-2.5 py-1.5 rounded-xl text-xs font-black transition-all active:scale-95 shadow-2xs',
                isStartToday
                  ? 'bg-amber-500 text-white shadow-amber-500/20'
                  : 'bg-white border border-amber-200 hover:bg-amber-50 text-slate-700'
              )}
            >
              Start Today
            </button>
          </div>

          {/* Live Slot Counters in Header */}
          <div className="inline-flex items-center gap-1 text-[11px] font-black text-amber-900 bg-amber-100/90 px-2.5 py-1.5 rounded-xl border border-amber-200">
            <span>☀️ {slotCounts.lunch}</span>
            <span className="text-amber-400">•</span>
            <span>🌙 {slotCounts.dinner}</span>
            <span className="text-amber-400">•</span>
            <span>🍱 {slotCounts.both}</span>
          </div>

          {/* Meals Status Pill */}
          <div
            className={cn(
              'inline-flex items-center gap-1 text-[11px] font-black px-2.5 py-1.5 rounded-xl border transition-colors shadow-2xs',
              totalMeals >= 30
                ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                : 'bg-amber-100 text-amber-950 border-amber-300'
            )}
          >
            {totalMeals >= 30 ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>{totalMeals} Meals</span>
              </>
            ) : (
              <>
                <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                <span>{totalMeals}/30 Meals</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Start month.
          The day arrows shift one day at a time, so reaching a future month took
          about thirty taps. These jump the 28-day window straight to a month. */}
      <div className="flex items-center gap-2 mb-3 overflow-x-auto">
        <span className="text-[11px] font-black uppercase tracking-wider text-slate-500 shrink-0">
          Start in
        </span>
        {upcomingMonths.map((m) => {
          const isActive =
            planStartDate.getFullYear() === m.start.getFullYear() &&
            planStartDate.getMonth() === m.start.getMonth();
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => handleSetStartMonth(m.start)}
              aria-pressed={isActive}
              className={cn(
                'px-3 py-1.5 rounded-xl text-xs font-black transition-all active:scale-95 shrink-0 shadow-2xs',
                isActive
                  ? 'bg-amber-500 text-white shadow-amber-500/20'
                  : 'bg-white border border-amber-200 hover:bg-amber-50 text-slate-700'
              )}
            >
              {m.label}
              {m.year !== upcomingMonths[0].year ? ` ${m.year}` : ''}
            </button>
          );
        })}
      </div>

      {/* ── Quick 28-Day Presets (Batch Selectors) ─────────────────────────── */}
      <div className="mb-4 pb-3 border-b border-amber-100 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1.5 min-w-max text-xs">
          <span className="text-slate-600 font-bold mr-1 flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5 text-brand" /> 28-Day Presets:
          </span>

          <button
            type="button"
            onClick={() => handleSelectWorkdaysSlot('lunch')}
            className="px-3 py-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold border border-amber-200 transition-all active:scale-95 shadow-2xs flex items-center gap-1"
          >
            <Sun className="w-3.5 h-3.5 text-amber-600" /> Mon–Fri Lunch (20)
          </button>

          <button
            type="button"
            onClick={() => handleSelectWorkdaysSlot('dinner')}
            className="px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-900 font-bold border border-indigo-200 transition-all active:scale-95 shadow-2xs flex items-center gap-1"
          >
            <Moon className="w-3.5 h-3.5 text-indigo-600" /> Mon–Fri Dinner (20)
          </button>

          <button
            type="button"
            onClick={() => handleSelectWorkdaysSlot('both')}
            className="px-3 py-1.5 rounded-xl bg-orange-50 hover:bg-orange-100 text-orange-900 font-bold border border-orange-200 transition-all active:scale-95 shadow-2xs flex items-center gap-1"
          >
            🍱 Mon–Fri Both (40)
          </button>

          <button
            type="button"
            onClick={() => handleSelectAll28DaysSlot('lunch')}
            className="px-3 py-1.5 rounded-xl bg-white hover:bg-amber-50 text-slate-800 font-bold border border-amber-200/80 transition-all active:scale-95 shadow-2xs"
          >
            ☀️ All 28 Days Lunch (28)
          </button>

          <button
            type="button"
            onClick={() => handleSelectAll28DaysSlot('dinner')}
            className="px-3 py-1.5 rounded-xl bg-white hover:bg-indigo-50 text-slate-800 font-bold border border-indigo-200/80 transition-all active:scale-95 shadow-2xs"
          >
            🌙 All 28 Days Dinner (28)
          </button>

          <button
            type="button"
            onClick={() => handleSelectAll28DaysSlot('both')}
            className="px-3 py-1.5 rounded-xl bg-white hover:bg-orange-50 text-slate-800 font-bold border border-orange-200/80 transition-all active:scale-95 shadow-2xs"
          >
            🍱 All 28 Days Both (56)
          </button>

          <button
            type="button"
            onClick={handleClearAll}
            className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold border border-slate-200 transition-all active:scale-95"
          >
            ✕ Clear All
          </button>
        </div>
      </div>

      {/* ── Calendar View: 28 Days in MON-SUN Grid ────────────────────────── */}
      <div className="mb-6 overflow-hidden rounded-3xl border border-amber-200/90 bg-amber-50/30 p-2 sm:p-3 shadow-inner">
        {/* Mon-Sun Grid Headers */}
        <div className="grid grid-cols-7 gap-1 sm:gap-2 mb-2 text-center">
          {WEEKDAY_HEADERS.map((h, i) => (
            <div
              key={h}
              className={cn(
                'py-1 text-[11px] sm:text-xs font-black tracking-wider uppercase',
                i >= 5 ? 'text-amber-800 font-black' : 'text-slate-600'
              )}
            >
              {h}
            </div>
          ))}
        </div>

        {/* 28-Day Calendar Day Cells */}
        <div className="grid grid-cols-7 gap-1 sm:gap-2">
          {/* Empty initial offset cells (alignment to start day's weekday) */}
          {Array.from({ length: startOffset }).map((_, idx) => (
            <div
              key={`empty-start-${idx}`}
              className="aspect-square sm:aspect-auto sm:min-h-[96px] rounded-lg sm:rounded-2xl bg-amber-50/40 border border-dashed border-amber-200/40 opacity-40 select-none"
            />
          ))}

          {/* Active 28 Days */}
          {days28.map((day, dayIdx) => {
            const slot = slots[day.dateKey] || 'skip';
            const isLunch = slot === 'lunch';
            const isDinner = slot === 'dinner';
            const isBoth = slot === 'both';
            const isSkipped = slot === 'skip';

            return (
              <div
                key={day.dateKey}
                className={cn(
                  // Phones get a square day box like a real calendar grid; sm+ keeps
                  // the taller card that has room for the four toggle buttons. The
                  // decorative gradients are sm-only too -- at 40px wide they read as
                  // smudges, so phones get a flat tint instead.
                  'relative flex flex-col p-0.5 sm:p-2 border transition-all duration-150 select-none',
                  'aspect-square sm:aspect-auto rounded-lg sm:rounded-2xl sm:shadow-2xs sm:min-h-0',
                  day.isToday && 'ring-1 sm:ring-2 ring-amber-500 border-amber-500 sm:shadow-md',
                  isLunch && 'bg-amber-50 border-amber-300 sm:bg-gradient-to-br sm:from-amber-50 sm:via-amber-100/60 sm:to-orange-50/40 sm:ring-1 sm:ring-amber-300/60',
                  isDinner && 'bg-indigo-50 border-indigo-300 sm:bg-gradient-to-br sm:from-indigo-50/90 sm:via-slate-50 sm:to-amber-50/40 sm:ring-1 sm:ring-indigo-300/60',
                  isBoth && 'bg-orange-50 border-orange-400 sm:bg-gradient-to-br sm:from-amber-100 sm:via-orange-100/70 sm:to-amber-50 sm:ring-1 sm:ring-orange-400/70 sm:shadow-sm',
                  isSkipped && 'bg-white border-slate-200/70 hover:border-amber-300'
                )}
              >
                {/* Phone: the whole cell is the control (see handleCycleSlot).
                    Absolutely positioned so it covers the cell without disturbing
                    the layout the sm+ breakpoint still relies on. */}
                <button
                  type="button"
                  onClick={() => handleCycleSlot(day.dateKey)}
                  aria-label={`${day.dayNumber} ${day.monthName}: ${slot === 'skip' ? 'skipped' : slot}. Tap to change.`}
                  className="sm:hidden absolute inset-0 z-10 rounded-lg active:scale-95 transition-transform"
                />

                {/* Phone: centred date with status dots underneath, the way a
                    calendar actually reads. Two dots means both meals. */}
                <div className="sm:hidden flex flex-col items-center justify-center gap-0.5 w-full h-full">
                  {/* The 28-day window straddles two months, so the grid has to say
                      which month a number belongs to. Calendar convention: label the
                      window's first cell and every 1st, not every cell. */}
                  {(dayIdx === 0 || day.dayNumber === 1) && (
                    <span className="text-[8px] font-black uppercase tracking-wide text-amber-700 leading-none">
                      {day.monthName}
                    </span>
                  )}
                  <span
                    className={cn(
                      'text-[13px] leading-none font-bold tabular-nums',
                      day.isToday
                        ? 'text-amber-700'
                        : isSkipped
                          ? 'text-slate-400'
                          : 'text-slate-900'
                    )}
                  >
                    {day.dayNumber}
                  </span>
                  <span className="flex items-center justify-center gap-0.5 h-1.5">
                    {(isLunch || isBoth) && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    )}
                    {(isDinner || isBoth) && (
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                    )}
                  </span>
                </div>

                {/* Top Row: Date with Month Name + Day Indicator */}
                <div className="hidden sm:flex items-center justify-between w-full mb-1">
                  <div className="flex items-center gap-1 min-w-0">
                    <span
                      className={cn(
                        'text-xs sm:text-sm font-black tracking-tight',
                        day.isToday ? 'text-amber-700 font-black' : isSkipped ? 'text-slate-600' : 'text-slate-900'
                      )}
                    >
                      {day.dayNumber}
                    </span>
                    <span className="hidden sm:inline text-[10px] font-bold text-slate-400 uppercase">
                      {day.monthName}
                    </span>
                  </div>

                  {/* Visual Slot Pill */}
                  {isLunch && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] sm:text-[10px] font-black text-amber-900 bg-amber-200/80 px-1 sm:px-1.5 py-0.5 rounded-md border border-amber-300/80 shadow-2xs">
                      ☀️ <span className="hidden sm:inline">Lunch</span>
                    </span>
                  )}
                  {isDinner && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] sm:text-[10px] font-black text-indigo-900 bg-indigo-100 px-1 sm:px-1.5 py-0.5 rounded-md border border-indigo-200 shadow-2xs">
                      🌙 <span className="hidden sm:inline">Dinner</span>
                    </span>
                  )}
                  {isBoth && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] sm:text-[10px] font-black text-orange-950 bg-orange-200/90 px-1 sm:px-1.5 py-0.5 rounded-md border border-orange-300 shadow-2xs">
                      🍱 <span className="hidden sm:inline">Both</span>
                    </span>
                  )}
                  {isSkipped && (
                    <span className="text-[9px] font-semibold text-slate-300">
                      Skip
                    </span>
                  )}
                </div>

                {/* Bottom Row: 4 Intuitive Slot Toggle Buttons */}
                <div className="hidden sm:grid grid-cols-4 gap-0.5 sm:gap-1 w-full mt-auto pt-1 border-t border-amber-100/60">
                  {/* Lunch Toggle */}
                  <button
                    type="button"
                    onClick={() => handleSetSlot(day.dateKey, 'lunch')}
                    aria-pressed={isLunch}
                    title="Select Lunch (1 Meal)"
                    className={cn(
                      'h-6 sm:h-7 rounded-lg text-[10px] sm:text-xs font-black transition-all flex items-center justify-center active:scale-90 select-none',
                      isLunch
                        ? 'bg-amber-500 text-white shadow-xs ring-1 ring-amber-400'
                        : 'bg-white/80 hover:bg-amber-50 text-slate-700 border border-slate-200/60'
                    )}
                  >
                    ☀️
                  </button>

                  {/* Dinner Toggle */}
                  <button
                    type="button"
                    onClick={() => handleSetSlot(day.dateKey, 'dinner')}
                    aria-pressed={isDinner}
                    title="Select Dinner (1 Meal)"
                    className={cn(
                      'h-6 sm:h-7 rounded-lg text-[10px] sm:text-xs font-black transition-all flex items-center justify-center active:scale-90 select-none',
                      isDinner
                        ? 'bg-indigo-600 text-white shadow-xs ring-1 ring-indigo-400'
                        : 'bg-white/80 hover:bg-indigo-50 text-slate-700 border border-slate-200/60'
                    )}
                  >
                    🌙
                  </button>

                  {/* Both (Lunch + Dinner) Toggle */}
                  <button
                    type="button"
                    onClick={() => handleSetSlot(day.dateKey, 'both')}
                    aria-pressed={isBoth}
                    title="Select Both Lunch & Dinner (2 Meals)"
                    className={cn(
                      'h-6 sm:h-7 rounded-lg text-[10px] sm:text-xs font-black transition-all flex items-center justify-center active:scale-90 select-none',
                      isBoth
                        ? 'bg-gradient-to-r from-amber-600 to-orange-500 text-white shadow-xs ring-1 ring-orange-400'
                        : 'bg-white/80 hover:bg-orange-50 text-slate-700 border border-slate-200/60'
                    )}
                  >
                    🍱
                  </button>

                  {/* Skip Toggle */}
                  <button
                    type="button"
                    onClick={() => handleSetSlot(day.dateKey, 'skip')}
                    aria-pressed={isSkipped}
                    title="Skip This Day"
                    className={cn(
                      'h-6 sm:h-7 rounded-lg text-[9px] sm:text-xs font-bold transition-all flex items-center justify-center active:scale-90 select-none',
                      isSkipped
                        ? 'bg-slate-200/80 text-slate-600 font-black'
                        : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                    )}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}

          {/* Empty trailing cells to finish the final week row */}
          {Array.from({ length: endOffset }).map((_, idx) => (
            <div
              key={`empty-end-${idx}`}
              className="aspect-square sm:aspect-auto sm:min-h-[96px] rounded-lg sm:rounded-2xl bg-amber-50/40 border border-dashed border-amber-200/40 opacity-40 select-none"
            />
          ))}
        </div>

        {/* Phones only: the dots need a key, and tap-to-cycle needs saying once.
            On sm+ each cell still carries labelled buttons, so neither is needed. */}
        <div className="sm:hidden mt-3 flex items-center justify-between gap-2 text-[11px] text-slate-500">
          <span className="flex items-center gap-2.5">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Lunch
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" /> Dinner
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 -ml-0.5" /> Both
            </span>
          </span>
          <span className="text-slate-400 shrink-0">Tap a day to change</span>
        </div>
      </div>

      {/* ── Thali Portions Customizer Section ────────────────────────────────
          ThaliCustomizer renders its own card, so no wrapper box here. */}
      <div className="mb-6">
        <ThaliCustomizer
          baseMealPrice={pricePerMeal}
          planType="monthly"
          vendorOverrides={vendorOverrides}
          vendorMarginOverride={vendorMarginOverride}
          onChange={handleCustomMealChange}
          compact
          title="Customize Your Daily Thali Portions (Optional)"
        />
      </div>

      {/* ── Real-Time Monthly Price Summary ───────────────────────────────── */}
      <div className="mb-6 rounded-2xl bg-gradient-to-br from-amber-50/70 via-white to-orange-50/50 border border-amber-200/80 shadow-sm">
        <div className="flex items-center justify-between px-5 pt-4">
          <span className="text-xs font-bold uppercase tracking-wider text-amber-800 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-amber-600" />
            Price Summary
          </span>
          {isLoadingPricing && (
            <span className="text-[11px] font-medium text-amber-700 animate-pulse">
              Updating rates...
            </span>
          )}
        </div>

        <div className="mt-1 divide-y divide-amber-100/70 px-5 py-1">
          <div className="py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-slate-600">Meals scheduled</span>
              <span className="text-sm font-semibold text-slate-900 tabular-nums">
                {totalMeals}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-400">
              {slotCounts.lunch > 0 && <span>{slotCounts.lunch} lunch</span>}
              {slotCounts.dinner > 0 && <span>{slotCounts.dinner} dinner</span>}
              {slotCounts.both > 0 && (
                <span>{slotCounts.both} full {slotCounts.both === 1 ? 'day' : 'days'}</span>
              )}
              {totalMeals > 0 &&
                (totalMeals >= 30 ? (
                  <span className="text-[11px] font-medium text-emerald-600">
                    ✓ Minimum met
                  </span>
                ) : (
                  <span className="text-[11px] font-medium text-amber-600">
                    Need {30 - totalMeals} more to reach 30
                  </span>
                ))}
            </div>
          </div>

          <div className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
            <span className="text-slate-600">Price per meal</span>
            <span className="font-semibold text-slate-900 tabular-nums">
              ₹{effectivePricePerMeal}
              {customMealConfig && (customMealConfig.customerDeltaPerMeal ?? 0) !== 0 && (
                <span className="ml-1.5 text-xs font-medium text-amber-700">
                  {((customMealConfig.customerDeltaPerMeal ?? 0) > 0
                    ? `+₹${customMealConfig.customerDeltaPerMeal}`
                    : `-₹${Math.abs(customMealConfig.customerDeltaPerMeal ?? 0)}`)}{' '}
                  adjusted
                </span>
              )}
            </span>
          </div>

          <div className="pt-3 pb-2.5 mt-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-bold text-slate-900">Total</span>
              <span className="text-2xl font-bold text-amber-800 tracking-tight tabular-nums">
                ₹{monthlyTotal}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              28-day cycle · doorstep delivery &amp; daily hot packaging
            </p>
          </div>
        </div>

        <p className="px-5 pb-4 text-[11px] leading-relaxed text-slate-400">
          Per meal: kitchen food rate + ₹11 delivery + 13% food margin.
        </p>

        {totalMeals === 0 && (
          <p className="mx-5 mb-4 text-xs text-amber-800/80 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 text-amber-600" />
            Pick meals for any days in the 28-day window ({dateRangeFormatted}).
            Monthly plans require a minimum of 30 meals.
          </p>
        )}
      </div>

      {/* ── Alert Banner: Minimum 30 Meals Rule ──────────────────────────────── */}
      {totalMeals > 0 && totalMeals < 30 && (
        <div className="mb-4 p-3.5 rounded-2xl bg-amber-50 border border-amber-300 text-amber-950 text-xs sm:text-sm font-semibold flex items-center justify-between gap-3 shadow-2xs animate-fade-in">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <span className="font-black text-amber-950 block">Monthly Plan Minimum: 30 Meals</span>
              <span className="text-amber-900 text-xs font-medium">
                You currently have {totalMeals} of 30 meals scheduled. Please add at least {30 - totalMeals} more meal{30 - totalMeals > 1 ? 's' : ''} to checkout, or switch to a Weekly Plan.
              </span>
            </div>
          </div>
          <span className="text-xs font-black bg-amber-200/90 text-amber-950 px-2.5 py-1 rounded-xl shrink-0 whitespace-nowrap">
            Need {30 - totalMeals} more
          </span>
        </div>
      )}

      {/* Warning message if checkout attempted with invalid meal count */}
      <AnimatePresence>
        {checkoutWarning && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-xs sm:text-sm font-semibold flex items-center gap-2 shadow-2xs"
          >
            <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{checkoutWarning}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Action Buttons at Bottom ───────────────────────────────────────── */}
      <div className="flex flex-col-reverse sm:flex-row items-center gap-3">
        {/* [Reset] Button */}
        <button
          type="button"
          onClick={handleClearAll}
          className="w-full sm:w-auto px-5 py-3.5 rounded-2xl border border-amber-200 bg-white hover:bg-amber-50 text-slate-700 hover:text-slate-900 font-bold text-sm transition-all duration-150 flex items-center justify-center gap-2 active:scale-95 shadow-2xs"
        >
          <RotateCcw className="w-4 h-4 text-amber-600" />
          Reset Plan
        </button>

        {/* [Confirm & Checkout] Button: Blocked when totalMeals < 30 */}
        <button
          type="button"
          onClick={handleConfirmCheckout}
          disabled={totalMeals < 30}
          className={cn(
            'w-full sm:flex-1 py-3.5 px-6 rounded-2xl font-black text-sm sm:text-base transition-all duration-150 flex items-center justify-center gap-2 active:scale-[0.98] shadow-lg select-none',
            totalMeals >= 30
              ? 'bg-gradient-to-r from-amber-500 via-amber-600 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white shadow-amber-500/25 cursor-pointer'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
          )}
        >
          {totalMeals === 0 ? (
            <span>Select Meals to Checkout</span>
          ) : totalMeals < 30 ? (
            <span>Add {30 - totalMeals} More Meal(s) to Checkout ({totalMeals}/30)</span>
          ) : (
            <>
              <span>Confirm & Checkout</span>
              <span className="font-normal opacity-90">• ₹{monthlyTotal}</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>

      {/* ── Built-in Custom Plan Checkout Screen & Payment Gateway ──────────── */}
      <CustomPlanCheckoutModal
        isOpen={showConfirmationModal}
        onClose={() => setShowConfirmationModal(false)}
        customPlanData={{
          planType: 'monthly',
          totalPrice: monthlyTotal,
          pattern: selections,
          slots,
          totalMeals,
          pricePerMeal: effectivePricePerMeal,
          planStartDate: days28[0]?.date || planStartDate,
          customMealConfig: customMealConfig || undefined,
          vendorId,
        }}
      />
    </div>
  );
}

export default MonthlyCustomPlanBuilder;
