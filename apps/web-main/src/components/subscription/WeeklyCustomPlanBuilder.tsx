'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Calendar,
  Utensils,
  Sparkles,
  RotateCcw,
  CreditCard,
  Check,
  ChevronRight,
  ShieldCheck,
  Info,
  Clock,
  ArrowRight,
  AlertCircle,
  Sun,
  Moon,
} from 'lucide-react';
import { getPricingConfig, DEFAULT_WEEKLY_PRICING } from '@/lib/queries/pricing';
import { calculateCustomPlanPrice } from '@/lib/pricing';
import { calculateSubscriptionPrice, calculateWeeklyPlanPrice, DEFAULT_STANDARD_MEAL } from '@/lib/pricingEngine';
import { CustomPlanCheckoutModal } from './CustomPlanCheckoutModal';
import { ThaliCustomizer, ThaliCustomizerConfig } from './ThaliCustomizer';
import { cn } from '@/lib/utils';

export type MealCount = 0 | 1 | 2; // 0 = Skip, 1 = 1 Meal, 2 = 2 Meals
export type MealSlotChoice = 'skip' | 'lunch' | 'dinner' | 'both';

export interface DayPlanInfo {
  id: string; // 'mon', 'tue', ...
  dayName: string; // 'Monday', 'Tuesday', ...
  shortDay: string; // 'Mon', 'Tue', ...
  dateStr: string; // 'Monday, 3 Sept'
  date: Date;
}

export interface DaySelection extends DayPlanInfo {
  slot: MealSlotChoice;
  meals: MealCount;
}

export interface PlanBuilderResult {
  pattern: Record<string, number>;
  slots: Record<string, MealSlotChoice>;
  selections: DaySelection[];
  totalMeals: number;
  pricePerMeal: number;
  weeklyTotal: number;
  customMealConfig?: ThaliCustomizerConfig | null;
  vendorId?: string;
  slotCounts: {
    lunch: number;
    dinner: number;
    both: number;
    skip: number;
  };
}

export interface WeeklyCustomPlanBuilderProps {
  /**
   * Optional initial price per meal. Overridden once getPricingConfig("weekly") resolves.
   */
  initialPricePerMeal?: number;
  /**
   * Reference start date for the week (defaults to Monday of current week).
   */
  startDate?: Date;
  /**
   * Pre-selected meal counts for each day by id (e.g. { mon: 1, tue: 2 }).
   */
  initialSelections?: Partial<Record<string, MealCount>>;
  /**
   * Pre-selected meal slots for each day by id (e.g. { mon: 'lunch', tue: 'both' }).
   */
  initialSlots?: Partial<Record<string, MealSlotChoice>>;
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
   * Callback fired immediately whenever any day's meal count changes.
   */
  onPlanChange?: (result: PlanBuilderResult) => void;
  /**
   * Callback fired when the user clicks [Confirm & Checkout].
   */
  onConfirmCheckout?: (result: PlanBuilderResult) => void;
  /**
   * Callback fired when [Reset] is clicked.
   */
  onReset?: () => void;
  /**
   * Additional wrapper CSS class names.
   */
  className?: string;
  /**
   * Whether to hide the top heading/subtitle (useful if rendered inside an existing modal).
   */
  hideHeader?: boolean;
}

/**
 * Calculates 7 days (Mon-Sun) starting from the Monday of the given reference date.
 */
export function getWeekDays(referenceDate?: Date): DayPlanInfo[] {
  const base = referenceDate ? new Date(referenceDate) : new Date();
  const dayOfWeek = base.getDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const monday = new Date(base);
  monday.setDate(base.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const shortDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const ids = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  return ids.map((id, index) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + index);
    const dayNum = d.getDate();
    // Use 'Sept' for September to match "Monday, 3 Sept" format specification
    const monthStr = d.getMonth() === 8 ? 'Sept' : d.toLocaleDateString('en-US', { month: 'short' });

    return {
      id,
      dayName: dayNames[index],
      shortDay: shortDays[index],
      dateStr: `${dayNames[index]}, ${dayNum} ${monthStr}`,
      date: d,
    };
  });
}

export function WeeklyCustomPlanBuilder({
  initialPricePerMeal,
  startDate,
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
}: WeeklyCustomPlanBuilderProps) {
  const weekDays = useMemo(() => getWeekDays(startDate), [startDate]);

  // Slots state: map day id ('mon'..'sun') to 'skip' | 'lunch' | 'dinner' | 'both'
  const [slots, setSlots] = useState<Record<string, MealSlotChoice>>(() => {
    const initial: Record<string, MealSlotChoice> = {
      mon: 'skip',
      tue: 'skip',
      wed: 'skip',
      thu: 'skip',
      fri: 'skip',
      sat: 'skip',
      sun: 'skip',
    };
    if (initialSlots) {
      Object.entries(initialSlots).forEach(([k, v]) => {
        if (v) initial[k] = v;
      });
      return initial;
    }
    if (initialSelections) {
      Object.entries(initialSelections).forEach(([k, v]) => {
        if (v !== undefined) {
          initial[k] = v === 2 ? 'both' : v === 1 ? 'lunch' : 'skip';
        }
      });
    }
    return initial;
  });

  const [pricePerMeal, setPricePerMeal] = useState<number>(
    initialPricePerMeal ?? DEFAULT_WEEKLY_PRICING.pricePerMeal ?? 50
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
  const [checkoutWarning, setCheckoutWarning] = useState<string | null>(null);
  const [showConfirmationModal, setShowConfirmationModal] = useState<boolean>(false);

  // Fetch current pricePerMeal on load using getPricingConfig("weekly")
  useEffect(() => {
    let isMounted = true;
    async function loadPricing() {
      try {
        setIsLoadingPricing(true);
        const config = await getPricingConfig('weekly');
        if (isMounted && config && typeof config.pricePerMeal === 'number') {
          setPricePerMeal(config.pricePerMeal);
        }
      } catch (err) {
        console.warn('[WeeklyCustomPlanBuilder] Failed to fetch weekly pricing, using fallback:', err);
        if (isMounted) {
          setPricePerMeal(initialPricePerMeal ?? DEFAULT_WEEKLY_PRICING.pricePerMeal ?? 50);
        }
      } finally {
        if (isMounted) {
          setIsLoadingPricing(false);
        }
      }
    }

    loadPricing();
    return () => {
      isMounted = false;
    };
  }, [initialPricePerMeal]);

  // Derive numeric selections from slots
  const selections = useMemo(() => {
    const map: Record<string, MealCount> = {};
    weekDays.forEach((d) => {
      const s = slots[d.id] || 'skip';
      map[d.id] = s === 'both' ? 2 : (s === 'lunch' || s === 'dinner') ? 1 : 0;
    });
    return map;
  }, [weekDays, slots]);

  const slotCounts = useMemo(() => {
    let lunch = 0;
    let dinner = 0;
    let both = 0;
    let skip = 0;
    weekDays.forEach((d) => {
      const s = slots[d.id] || 'skip';
      if (s === 'lunch') lunch++;
      else if (s === 'dinner') dinner++;
      else if (s === 'both') both++;
      else skip++;
    });
    return { lunch, dinner, both, skip };
  }, [weekDays, slots]);

  // Build subscription schedule for Central Pricing Engine
  const centralSchedule = useMemo(() => {
    const list: Array<{ dayKey: string; slot: 'lunch' | 'dinner' | 'both'; items: Record<string, number> }> = [];
    const selectedItems = customMealConfig?.components || DEFAULT_STANDARD_MEAL.itemQuantities;
    weekDays.forEach((d) => {
      const s = slots[d.id] || 'skip';
      if (s === 'lunch' || s === 'dinner' || s === 'both') {
        list.push({
          dayKey: d.id,
          slot: s,
          items: selectedItems,
        });
      }
    });
    return list;
  }, [weekDays, slots, customMealConfig?.components]);

  const centralSubscriptionPricing = useMemo(() => {
    if (centralSchedule.length === 0) return null;
    try {
      return calculateSubscriptionPrice(centralSchedule, DEFAULT_STANDARD_MEAL.itemQuantities);
    } catch {
      return null;
    }
  }, [centralSchedule]);

  // Real-time calculation: Total meals count and Weekly total price using Canonical Weekly Formula & Central Engine
  const totalMeals = Object.values(selections).reduce((a: number, b: number) => a + b, 0);

  // Authoritative Weekly Plan Pricing Calculation:
  // (Vendor Cost + ₹11 Delivery Fee) * 1.12 Weekly Margin * 1.02 Razorpay
  const weeklyPricingResult = useMemo(() => {
    if (totalMeals === 0) return null;

    // 1. If customMealConfig provides vendorPayout or effectiveVendorCostPerMeal:
    const vendorPayout = customMealConfig?.vendorPayout ?? customMealConfig?.effectiveVendorCostPerMeal;
    if (typeof vendorPayout === 'number' && vendorPayout > 0) {
      return calculateWeeklyPlanPrice(totalMeals, vendorPayout, 11, 0.12, 0.02);
    }

    // 2. Base rate + customer delta fallback
    const delta = customMealConfig?.customerDeltaPerMeal || 0;
    const effRate = Math.max(10, Math.round((pricePerMeal + delta) * 100) / 100);
    const subtotal = Math.round(totalMeals * effRate * 100) / 100;
    const finalPrice = Math.round(subtotal * 1.02 * 1000) / 1000;
    return {
      totalMeals,
      vendorCostPerMeal: 65,
      deliveryFeePerMeal: 11,
      subtotalPerMeal: 76,
      weeklyMarginRate: 0.12,
      ratePerMealWithMargin: effRate,
      mealsSubtotal: subtotal,
      razorpayRate: 0.02,
      razorpayFee: Math.round((finalPrice - subtotal) * 1000) / 1000,
      finalPrice,
      effectivePricePerMeal: effRate,
    };
  }, [totalMeals, customMealConfig?.vendorPayout, customMealConfig?.effectiveVendorCostPerMeal, customMealConfig?.customerDeltaPerMeal, pricePerMeal]);

  const weeklyTotal = weeklyPricingResult
    ? Math.round(weeklyPricingResult.finalPrice * 100) / 100
    : Math.round(totalMeals * Math.max(0, pricePerMeal + (customMealConfig?.customerDeltaPerMeal || 0)) * 100) / 100;

  const effectivePricePerMeal = weeklyPricingResult
    ? weeklyPricingResult.ratePerMealWithMargin
    : Math.max(0, Math.round((pricePerMeal + (customMealConfig?.customerDeltaPerMeal || 0)) * 100) / 100);

  // Notify parent component whenever selections or pricing change
  useEffect(() => {
    if (onPlanChange) {
      const fullSelections: DaySelection[] = weekDays.map((day) => ({
        ...day,
        slot: slots[day.id] || 'skip',
        meals: selections[day.id] || 0,
      }));
      onPlanChange({
        pattern: selections,
        slots,
        selections: fullSelections,
        totalMeals,
        pricePerMeal: effectivePricePerMeal,
        weeklyTotal,
        customMealConfig: customMealConfig || undefined,
        vendorId,
        slotCounts,
      });
    }
  }, [slots, selections, totalMeals, effectivePricePerMeal, weeklyTotal, weekDays, customMealConfig, vendorId, slotCounts, onPlanChange]);

  // Slot handlers
  const handleSetSlot = useCallback((dayId: string, targetSlot: MealSlotChoice) => {
    setCheckoutWarning(null);
    setSlots((prev) => {
      const nextSlot = prev[dayId] === targetSlot ? 'skip' : targetSlot;
      return {
        ...prev,
        [dayId]: nextSlot,
      };
    });
  }, []);

  // Quick preset actions
  const handleSelectWorkdaysSlot = useCallback((targetSlot: 'lunch' | 'dinner' | 'both') => {
    setCheckoutWarning(null);
    setSlots({
      mon: targetSlot,
      tue: targetSlot,
      wed: targetSlot,
      thu: targetSlot,
      fri: targetSlot,
      sat: 'skip',
      sun: 'skip',
    });
  }, []);

  const handleSelectAllDaysSlot = useCallback((targetSlot: 'lunch' | 'dinner' | 'both') => {
    setCheckoutWarning(null);
    setSlots({
      mon: targetSlot,
      tue: targetSlot,
      wed: targetSlot,
      thu: targetSlot,
      fri: targetSlot,
      sat: targetSlot,
      sun: targetSlot,
    });
  }, []);

  // Bottom action: Reset
  const handleReset = useCallback(() => {
    setCheckoutWarning(null);
    setSlots({
      mon: 'skip',
      tue: 'skip',
      wed: 'skip',
      thu: 'skip',
      fri: 'skip',
      sat: 'skip',
      sun: 'skip',
    });
    if (onReset) onReset();
  }, [onReset]);

  // Bottom action: Confirm & Checkout
  const handleConfirmCheckout = useCallback(() => {
    if (totalMeals === 0) {
      setCheckoutWarning('Please select at least 1 meal for the week to proceed.');
      return;
    }

    setCheckoutWarning(null);
    const fullSelections: DaySelection[] = weekDays.map((day) => ({
      ...day,
      slot: slots[day.id] || 'skip',
      meals: selections[day.id] || 0,
    }));

    const result: PlanBuilderResult = {
      pattern: selections,
      slots,
      selections: fullSelections,
      totalMeals,
      pricePerMeal: effectivePricePerMeal,
      weeklyTotal,
      customMealConfig: customMealConfig || undefined,
      vendorId,
      slotCounts,
    };

    if (onConfirmCheckout) {
      onConfirmCheckout(result);
    } else {
      setShowConfirmationModal(true);
    }
  }, [totalMeals, weekDays, slots, selections, effectivePricePerMeal, weeklyTotal, customMealConfig, vendorId, slotCounts, onConfirmCheckout]);

  return (
    <div className={cn('w-full max-w-2xl mx-auto transition-all', className)}>
      {/* ── Heading & Subtitle ────────────────────────────────────────────── */}
      {!hideHeader && (
        <div className="mb-6 text-left sm:text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100/80 border border-amber-300/80 text-amber-900 text-xs font-black tracking-wider uppercase mb-2 shadow-2xs">
            <Calendar className="w-3.5 h-3.5 text-amber-700" />
            Dabzzo Weekly Custom Plan
          </div>
          <h2 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
            Customize Your Weekly Meals & Slots
          </h2>
          <p className="text-slate-600 text-sm sm:text-base mt-1 font-medium">
            Choose your daily meal slot (<span className="text-amber-700 font-bold">☀️ Lunch</span> or <span className="text-indigo-700 font-bold">🌙 Dinner</span>) for each day of the week
          </p>
        </div>
      )}

      {/* ── Quick Presets ─────────────────────────────────────────────────── */}
      <div className="mb-5 pb-3 border-b border-amber-100 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1.5 min-w-max text-xs">
          <span className="text-slate-600 font-bold mr-1 flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5 text-brand" /> Quick Select:
          </span>

          <button
            type="button"
            onClick={() => handleSelectWorkdaysSlot('lunch')}
            className="px-3 py-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold border border-amber-200 transition-all active:scale-95 shadow-2xs flex items-center gap-1"
          >
            <Sun className="w-3.5 h-3.5 text-amber-600" /> Mon–Fri Lunch
          </button>

          <button
            type="button"
            onClick={() => handleSelectWorkdaysSlot('dinner')}
            className="px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-900 font-bold border border-indigo-200 transition-all active:scale-95 shadow-2xs flex items-center gap-1"
          >
            <Moon className="w-3.5 h-3.5 text-indigo-600" /> Mon–Fri Dinner
          </button>

          <button
            type="button"
            onClick={() => handleSelectWorkdaysSlot('both')}
            className="px-3 py-1.5 rounded-xl bg-orange-50 hover:bg-orange-100 text-orange-900 font-bold border border-orange-200 transition-all active:scale-95 shadow-2xs flex items-center gap-1"
          >
            🍱 Mon–Fri Both
          </button>

          <button
            type="button"
            onClick={() => handleSelectAllDaysSlot('both')}
            className="px-3 py-1.5 rounded-xl bg-white hover:bg-orange-50 text-slate-800 font-bold border border-orange-200/80 transition-all active:scale-95 shadow-2xs"
          >
            🍱 All 7 Days Both
          </button>

          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold border border-slate-200 transition-all active:scale-95"
          >
            ✕ Clear All
          </button>
        </div>
      </div>

      {/* ── 7 Day Cards (Mon-Sun) with Slot Selectors ─────────────────────── */}
      <div className="space-y-3 mb-6" role="group" aria-label="7 Day Meal Slot Selection">
        {weekDays.map((day, index) => {
          const selectedMeal = selections[day.id] || 0;
          const slot = slots[day.id] || 'skip';
          const isLunch = slot === 'lunch';
          const isDinner = slot === 'dinner';
          const isBoth = slot === 'both';
          const isSkipped = slot === 'skip';

          return (
            <motion.div
              key={day.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: index * 0.03 }}
              className={cn(
                'relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:p-4 rounded-2xl border transition-all duration-150 shadow-2xs select-none',
                isLunch && 'bg-gradient-to-r from-amber-50 via-white to-orange-50/30 border-amber-300 ring-1 ring-amber-300/60 shadow-sm',
                isDinner && 'bg-gradient-to-r from-indigo-50/90 via-white to-amber-50/30 border-indigo-300 ring-1 ring-indigo-300/60 shadow-sm',
                isBoth && 'bg-gradient-to-r from-amber-100/90 via-orange-100/60 to-amber-50 border-orange-400 ring-1 ring-orange-400/70 shadow-sm',
                isSkipped && 'bg-white/90 border-amber-100/80 hover:border-amber-300'
              )}
            >
              {/* Day Name + Date */}
              <div className="flex items-center justify-between sm:justify-start gap-2.5 min-w-[160px]">
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'text-base font-black tracking-tight transition-colors',
                        !isSkipped ? 'text-slate-900' : 'text-slate-700'
                      )}
                    >
                      {day.dateStr}
                    </span>
                  </div>
                  <span className="text-xs font-semibold text-slate-500">
                    {day.dayName}
                  </span>
                </div>

                {/* Visual Status Pill */}
                <div>
                  {isLunch && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-black px-2.5 py-1 rounded-lg bg-amber-100 text-amber-900 border border-amber-300 shadow-2xs">
                      ☀️ Lunch (1)
                    </span>
                  )}
                  {isDinner && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-black px-2.5 py-1 rounded-lg bg-indigo-100 text-indigo-900 border border-indigo-300 shadow-2xs">
                      🌙 Dinner (1)
                    </span>
                  )}
                  {isBoth && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-black px-2.5 py-1 rounded-lg bg-orange-200 text-orange-950 border border-orange-300 shadow-2xs">
                      🍱 Both (2)
                    </span>
                  )}
                  {isSkipped && (
                    <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-lg bg-slate-100 text-slate-400">
                      Skipped
                    </span>
                  )}
                </div>
              </div>

              {/* Action Buttons: [☀️ Lunch] [🌙 Dinner] [🍱 Both] [✕ Skip] */}
              <div className="flex items-center gap-1.5 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => handleSetSlot(day.id, 'lunch')}
                  aria-pressed={isLunch}
                  title="Schedule Lunch (12:30 PM - 1:30 PM)"
                  className={cn(
                    'flex-1 sm:flex-initial h-9 px-3 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1 active:scale-95 select-none',
                    isLunch
                      ? 'bg-amber-500 text-white shadow-xs ring-1 ring-amber-400'
                      : 'bg-white hover:bg-amber-50 text-slate-700 border border-amber-200/80 shadow-2xs'
                  )}
                >
                  <Sun className="w-3.5 h-3.5" />
                  <span>Lunch</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleSetSlot(day.id, 'dinner')}
                  aria-pressed={isDinner}
                  title="Schedule Dinner (7:30 PM - 8:30 PM)"
                  className={cn(
                    'flex-1 sm:flex-initial h-9 px-3 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1 active:scale-95 select-none',
                    isDinner
                      ? 'bg-indigo-600 text-white shadow-xs ring-1 ring-indigo-400'
                      : 'bg-white hover:bg-indigo-50 text-slate-700 border border-indigo-200/80 shadow-2xs'
                  )}
                >
                  <Moon className="w-3.5 h-3.5" />
                  <span>Dinner</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleSetSlot(day.id, 'both')}
                  aria-pressed={isBoth}
                  title="Schedule Both Lunch & Dinner"
                  className={cn(
                    'flex-1 sm:flex-initial h-9 px-3 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1 active:scale-95 select-none',
                    isBoth
                      ? 'bg-gradient-to-r from-amber-600 to-orange-500 text-white shadow-xs ring-1 ring-orange-400'
                      : 'bg-white hover:bg-orange-50 text-slate-700 border border-orange-200/80 shadow-2xs'
                  )}
                >
                  <span>🍱 Both</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleSetSlot(day.id, 'skip')}
                  aria-pressed={isSkipped}
                  title="Skip this day"
                  className={cn(
                    'h-9 px-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center active:scale-95 select-none',
                    isSkipped
                      ? 'bg-slate-200/80 text-slate-600 font-black'
                      : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                  )}
                >
                  ✕
                </button>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* ── Thali Portions Customizer Section ────────────────────────────────
          ThaliCustomizer renders its own card, so no wrapper box here. */}
      <div className="mb-6">
        <ThaliCustomizer
          baseMealPrice={pricePerMeal}
          planType="weekly"
          vendorOverrides={vendorOverrides}
          vendorMarginOverride={vendorMarginOverride}
          onChange={handleCustomMealChange}
          compact
          title="Customize Your Daily Thali Portions (Optional)"
        />
      </div>

      {/* ── Real-Time Weekly Price Breakdown Receipt ──────────────────────── */}
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

        <div className="mt-1 divide-y divide-amber-100/70 px-5 py-1 text-sm">
          <div className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="text-slate-600">Meals scheduled</span>
            <span className="font-semibold text-slate-900 tabular-nums">{totalMeals}</span>
          </div>

          {totalMeals > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 py-1.5 text-xs text-slate-400">
              {slotCounts.lunch > 0 && <span>{slotCounts.lunch} lunch</span>}
              {slotCounts.dinner > 0 && <span>{slotCounts.dinner} dinner</span>}
              {slotCounts.both > 0 && (
                <span>{slotCounts.both} full {slotCounts.both === 1 ? 'day' : 'days'}</span>
              )}
            </div>
          )}

          <div className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="text-slate-600">Price per meal</span>
            <span className="font-semibold text-slate-900 tabular-nums">₹{effectivePricePerMeal}</span>
          </div>

          {customMealConfig && (customMealConfig.customerDeltaPerMeal ?? 0) !== 0 && (
            <div className="flex items-baseline justify-between gap-3 py-2.5 text-xs text-amber-700">
              <span>Thali portion adjustment</span>
              <span className="font-medium tabular-nums">
                {(customMealConfig.customerDeltaPerMeal ?? 0) > 0 ? '+' : '−'}₹{Math.abs(customMealConfig.customerDeltaPerMeal ?? 0)}
              </span>
            </div>
          )}

          {totalMeals > 0 && weeklyPricingResult && (
            <>
              <div className="flex items-baseline justify-between gap-3 py-2.5 text-slate-600">
                <span>Subtotal</span>
                <span className="font-medium text-slate-800 tabular-nums">₹{weeklyPricingResult.mealsSubtotal}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-2.5 text-slate-600">
                <span className="flex items-center gap-1.5">
                  <CreditCard className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  Payment gateway
                </span>
                <span className="font-medium text-slate-800 tabular-nums">+₹{weeklyPricingResult.razorpayFee}</span>
              </div>
            </>
          )}

          <div className="flex items-baseline justify-between gap-3 pt-3 pb-2 mt-1">
            <span className="font-bold text-slate-900">Total</span>
            <span className="text-2xl font-bold text-amber-800 tracking-tight tabular-nums">
              ₹{weeklyTotal}
            </span>
          </div>
        </div>

        <p className="px-5 pb-4 text-[11px] leading-relaxed text-slate-400">
          Includes ₹11 delivery and a 12% platform margin, plus 2% payment gateway.
          Doorstep delivery and hot packing included.
        </p>

        {totalMeals === 0 && (
          <p className="mx-5 mb-4 text-xs text-amber-800/80 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 text-amber-600" />
            Pick at least 1 meal slot this week to calculate your customized plan.
          </p>
        )}
      </div>

      {/* Warning message if checkout attempted with 0 meals */}
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
          onClick={handleReset}
          className="w-full sm:w-auto px-5 py-3.5 rounded-2xl border border-amber-200 bg-white hover:bg-amber-50 text-slate-700 hover:text-slate-900 font-bold text-sm transition-all duration-150 flex items-center justify-center gap-2 active:scale-95 shadow-2xs"
        >
          <RotateCcw className="w-4 h-4 text-amber-600" />
          Reset Plan
        </button>

        {/* [Confirm & Checkout] Button */}
        <button
          type="button"
          onClick={handleConfirmCheckout}
          className={cn(
            'w-full sm:flex-1 py-3.5 px-6 rounded-2xl font-black text-sm sm:text-base transition-all duration-150 flex items-center justify-center gap-2 active:scale-[0.98] shadow-lg',
            totalMeals > 0
              ? 'bg-gradient-to-r from-amber-500 via-amber-600 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white shadow-amber-500/25 cursor-pointer'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
          )}
        >
          <span>Confirm & Checkout</span>
          {totalMeals > 0 && <span className="font-normal opacity-90">• ₹{weeklyTotal}</span>}
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {/* ── Built-in Custom Plan Checkout Screen & Payment Gateway ──────────── */}
      <CustomPlanCheckoutModal
        isOpen={showConfirmationModal}
        onClose={() => setShowConfirmationModal(false)}
        customPlanData={{
          planType: 'weekly',
          totalPrice: weeklyTotal,
          pattern: selections,
          slots,
          totalMeals,
          pricePerMeal: effectivePricePerMeal,
          planStartDate: weekDays[0]?.date || new Date(),
          customMealConfig: customMealConfig || undefined,
          vendorId,
        }}
      />
    </div>
  );
}

export default WeeklyCustomPlanBuilder;
