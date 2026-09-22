'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  IndianRupee,
  Save,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Calendar,
  CalendarRange,
  Check,
  AlertCircle,
  Clock,
  Sparkles,
  Calculator,
  ShieldCheck,
  Utensils,
  Plus,
  Trash2,
  Sliders,
  Layers,
  Scale,
  Percent,
  CheckCircle2,
  X,
  Undo2,
} from 'lucide-react';
import {
  getAllPricingConfigs,
  savePricingConfig,
  getPricingAlgorithmSettings,
  savePricingAlgorithmSettings,
  getAuthoritativePricingRules,
  saveAuthoritativePricingRules,
  getMarginRules,
  saveMarginRulesAdmin,
  validateMarginRuleSet,
  resolveMarginRateForMeals,
  calculateMealPrice,
  calculateSubscriptionPrice,
  calculateStandardSubscriptionProduct,
  DEFAULT_PRICING_RULES,
  DEFAULT_WEEKLY_PRICING,
  DEFAULT_MONTHLY_PRICING,
  DEFAULT_PRICING_ALGORITHM,
  calculateVendorPayout,
  calculateCustomerFoodRate,
  calculateCustomerMealPrice,
  computeAlgorithmicMealPricing,
  PricingAlgorithmSettings,
  PricingRules,
  MarginRule,
} from '@/lib/queries/pricing';
import {
  getMealComponentsCatalog,
  saveMealComponentsCatalog,
  calculateComponentDeltas,
} from '@/lib/queries/mealComponents';
import type {
  MealPricingConfig as MealPricingConfigData,
  PlanPricingType,
  MealComponent,
  ComponentCategory,
  ComponentUnit,
} from '@/types';
import { DEFAULT_MEAL_COMPONENTS } from '@/types';
import { useUiStore } from '@/store/uiStore';
import { useAuthStore } from '@/store/authStore';
import { triggerHapticImpact, triggerHapticSelection, ImpactStyle } from '@/lib/haptics';
import { formatDate } from '@/lib/utils';
import { getErrorMessage } from '@dabzzo/shared-lib/errors';

interface MealPricingConfigProps {
  onSaved?: (type: PlanPricingType, updated: MealPricingConfigData) => void;
  className?: string;
}

export function MealPricingConfig({ onSaved, className = '' }: MealPricingConfigProps) {
  const addToast = useUiStore((s) => s.addToast);
  const user = useAuthStore((s) => s.user);

  // Firestore Saved Configurations
  const [weeklyConfig, setWeeklyConfig] = useState<MealPricingConfigData>(DEFAULT_WEEKLY_PRICING);
  const [monthlyConfig, setMonthlyConfig] = useState<MealPricingConfigData>(DEFAULT_MONTHLY_PRICING);
  const [loading, setLoading] = useState(true);

  // ── Authoritative Pricing Rules State (system_settings/pricing_rules) ─────────
  const [authoritativeRules, setAuthoritativeRules] = useState<PricingRules>(DEFAULT_PRICING_RULES);
  const [initialAuthoritativeRules, setInitialAuthoritativeRules] = useState<PricingRules>(DEFAULT_PRICING_RULES);
  const [vendorDeductionPct, setVendorDeductionPct] = useState<number>(8); // default 8% (0.08)
  const [marginPct, setMarginPct] = useState<number>(13); // default 13% (0.13)
  const [deliveryCharge, setDeliveryCharge] = useState<string>('11'); // default ₹11
  const [paymentFeePct, setPaymentFeePct] = useState<number>(2.5); // default 2.5% (0.025)
  const [roundingStrategy, setRoundingStrategy] = useState<'round' | 'ceil'>('round');
  const [savingRules, setSavingRules] = useState(false);

  // ── Dynamic Margin Rules State (system_settings/margin_rules) ────────────────
  interface MarginRuleDraft {
    id: string;
    minMeals: string;
    maxMeals: string; // '' => open-ended (final tier only)
    marginPct: string; // percent, e.g. 12.5
    isActive: boolean;
  }

  const draftFromRule = (r: MarginRule): MarginRuleDraft => ({
    id: r.id,
    minMeals: String(r.minMeals),
    maxMeals: r.maxMeals == null ? '' : String(r.maxMeals),
    marginPct: String(Math.round(r.marginRate * 1000) / 10),
    isActive: r.isActive !== false,
  });

  const [marginEnabled, setMarginEnabled] = useState(true);
  const [marginDrafts, setMarginDrafts] = useState<MarginRuleDraft[]>([]);
  const [initialMarginEnabled, setInitialMarginEnabled] = useState(true);
  const [initialMarginDrafts, setInitialMarginDrafts] = useState<MarginRuleDraft[]>([]);
  const [savingMarginRules, setSavingMarginRules] = useState(false);
  const [marginPreviewMeals, setMarginPreviewMeals] = useState<number>(12);

  const buildMarginRulesFromDrafts = (drafts: MarginRuleDraft[]): MarginRule[] => {
    return drafts.map((d) => ({
      id: d.id.trim() || `tier_${Math.random().toString(36).slice(2, 8)}`,
      minMeals: Number(d.minMeals),
      maxMeals: d.maxMeals.trim() === '' ? null : Number(d.maxMeals),
      marginRate: (Number(d.marginPct) || 0) / 100,
      isActive: d.isActive,
    }));
  };

  const marginValidationErrors = useMemo(() => {
    return validateMarginRuleSet(buildMarginRulesFromDrafts(marginDrafts).filter((r) => r.isActive !== false));
  }, [marginDrafts]);

  const isMarginChanged = useMemo(() => {
    return (
      marginEnabled !== initialMarginEnabled ||
      JSON.stringify(marginDrafts) !== JSON.stringify(initialMarginDrafts)
    );
  }, [marginEnabled, marginDrafts, initialMarginEnabled, initialMarginDrafts]);

  const resolvedPreviewMargin = useMemo(() => {
    const tiers = buildMarginRulesFromDrafts(marginDrafts).filter((r) => r.isActive !== false);
    return resolveMarginRateForMeals(tiers, marginPreviewMeals, Number(marginPct) / 100);
  }, [marginDrafts, marginPreviewMeals, marginPct]);

  const handleUpdateMarginDraft = (index: number, patch: Partial<MarginRuleDraft>) => {
    setMarginDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const handleAddMarginTier = () => {
    const nextMin =
      marginDrafts.length === 0
        ? '1'
        : String(
            (Math.max(
              ...marginDrafts.map((d) => (d.maxMeals.trim() === '' ? Number(d.minMeals) : Number(d.maxMeals) || Number(d.minMeals)))
            ) || 0) + 1
          );
    setMarginDrafts((prev) => [
      ...prev,
      { id: '', minMeals: nextMin, maxMeals: '', marginPct: String(Math.round((Number(marginPct) || 0) * 10) / 10), isActive: true },
    ]);
  };

  const handleSaveMarginRules = async () => {
    const rules = buildMarginRulesFromDrafts(marginDrafts);

    const hasMemberError = rules.some(
      (r) => !Number.isInteger(r.minMeals) || r.minMeals < 1 || !Number.isFinite(r.marginRate) || r.marginRate < 0 || r.marginRate >= 1
    );
    if (hasMemberError) {
      addToast('Every tier needs valid integer meal counts and a margin rate between 0% and 100%', 'error');
      return;
    }
    const errors = validateMarginRuleSet(rules);
    if (errors.length > 0) {
      addToast(errors[0], 'error');
      return;
    }

    setSavingMarginRules(true);
    triggerHapticImpact(ImpactStyle.Medium);
    try {
      const updatedBy = user?.id || user?.email || 'admin';
      const res = await saveMarginRulesAdmin({ enabled: marginEnabled, rules }, updatedBy);
      setMarginEnabled(res.enabled);
      setMarginDrafts(res.rules.map(draftFromRule));
      setInitialMarginEnabled(res.enabled);
      setInitialMarginDrafts(res.rules.map(draftFromRule));
      addToast(
        res.rules.length > 0
          ? `Dynamic margin rules saved: ${res.rules.length} tier(s) active for meal counts 🎯`
          : 'Dynamic margin rules saved — flat margin applies to all meal counts 🎯',
        'success'
      );
    } catch (err: unknown) {
      console.error('[MealPricingConfig] Error saving margin rules:', err);
      addToast(getErrorMessage(err) || 'Failed to save margin rules', 'error');
    } finally {
      setSavingMarginRules(false);
    }
  };

  // Single meal interactive simulator item quantities (Default formula example = ₹78 Item Total)
  // Rice(15) + Dal(20) + Roti(8) + Sabji(25) + Salad(10) = 78
  const [simMealQuantities, setSimMealQuantities] = useState<Record<string, number>>({
    rice: 1,
    dal: 1,
    roti: 1,
    sabji: 1,
    salad: 1,
  });

  // Legacy algo fallback state
  const [algoConfig, setAlgoConfig] = useState<PricingAlgorithmSettings>(DEFAULT_PRICING_ALGORITHM);

  // Editable Form Inputs (strings for smooth typing)
  const [weeklyPrice, setWeeklyPrice] = useState<string>('50');
  const [weeklyVendorCost, setWeeklyVendorCost] = useState<string>('30');

  const [monthlyPrice, setMonthlyPrice] = useState<string>('1400');
  const [monthlyVendorCost, setMonthlyVendorCost] = useState<string>('900');

  // Interactive Meal Multiplier for weekly calculation preview
  const [previewMealsPerWeek, setPreviewMealsPerWeek] = useState<number>(9);

  // Saving states
  const [savingWeekly, setSavingWeekly] = useState(false);
  const [savingMonthly, setSavingMonthly] = useState(false);

  // Check if Authoritative Pricing Rules changed
  const isRulesChanged = useMemo(() => {
    const origDeduction = Math.round((initialAuthoritativeRules.vendorDeduction ?? 0.08) * 1000) / 10;
    const origMargin = Math.round((initialAuthoritativeRules.margin ?? 0.13) * 1000) / 10;
    const origDelivery = initialAuthoritativeRules.deliveryCharge ?? 11;
    const origPayment = Math.round((initialAuthoritativeRules.paymentFee ?? 0.025) * 1000) / 10;
    const origRounding = initialAuthoritativeRules.roundingStrategy ?? 'round';

    return (
      vendorDeductionPct !== origDeduction ||
      marginPct !== origMargin ||
      Number(deliveryCharge) !== origDelivery ||
      paymentFeePct !== origPayment ||
      roundingStrategy !== origRounding
    );
  }, [vendorDeductionPct, marginPct, deliveryCharge, paymentFeePct, roundingStrategy, initialAuthoritativeRules]);

  // Load live pricing configs from Firestore
  const loadPricing = useCallback(async () => {
    setLoading(true);
    try {
      const [{ weekly, monthly }, algo, rules, marginConfig] = await Promise.all([
        getAllPricingConfigs(),
        getPricingAlgorithmSettings(),
        getAuthoritativePricingRules(),
        getMarginRules(),
      ]);
      setWeeklyConfig(weekly);
      setMonthlyConfig(monthly);
      setAlgoConfig(algo);
      setAuthoritativeRules(rules);
      setInitialAuthoritativeRules(rules);

      const drafts = marginConfig.rules.map(draftFromRule);
      setMarginEnabled(marginConfig.enabled !== false);
      setMarginDrafts(drafts);
      setInitialMarginEnabled(marginConfig.enabled !== false);
      setInitialMarginDrafts(drafts);

      setWeeklyPrice(String(weekly.pricePerMeal ?? 50));
      setWeeklyVendorCost(String(weekly.vendorCostPerMeal ?? 30));

      setMonthlyPrice(String(monthly.pricePerMeal ?? 1400));
      setMonthlyVendorCost(String(monthly.vendorCostPerMeal ?? 900));

      setVendorDeductionPct(Math.round((rules.vendorDeduction ?? 0.08) * 1000) / 10);
      setMarginPct(Math.round((rules.margin ?? 0.13) * 1000) / 10);
      setDeliveryCharge(String(rules.deliveryCharge ?? 11));
      setPaymentFeePct(Math.round((rules.paymentFee ?? 0.025) * 1000) / 10);
      setRoundingStrategy(rules.roundingStrategy === 'ceil' ? 'ceil' : 'round');
    } catch (err) {
      console.error('[MealPricingConfig] Error loading pricing config:', err);
      addToast('Failed to load meal pricing configuration', 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void loadPricing();
  }, [loadPricing]);

  // Save Authoritative Pricing Rules handler
  const handleSaveRules = async () => {
    setSavingRules(true);
    triggerHapticImpact(ImpactStyle.Medium);
    try {
      const updatedBy = user?.id || user?.email || 'admin';
      const updated = await saveAuthoritativePricingRules(
        {
          vendorDeduction: Number(vendorDeductionPct) / 100,
          margin: Number(marginPct) / 100,
          deliveryCharge: Math.max(0, Number(deliveryCharge) || 0),
          paymentFee: Number(paymentFeePct) / 100,
          roundingStrategy,
        },
        updatedBy
      );
      setAuthoritativeRules(updated);
      setInitialAuthoritativeRules(updated);
      addToast('Authoritative Central Pricing Rules saved successfully! 🚀', 'success');
    } catch (err: unknown) {
      console.error('[MealPricingConfig] Error saving pricing rules:', err);
      addToast(getErrorMessage(err) || 'Failed to save pricing rules', 'error');
    } finally {
      setSavingRules(false);
    }
  };

  // ── Component Catalog State ──────────────────────────────────────────────────
  const [components, setComponents] = useState<MealComponent[]>(DEFAULT_MEAL_COMPONENTS);
  const [initialComponents, setInitialComponents] = useState<MealComponent[]>(DEFAULT_MEAL_COMPONENTS);
  const [loadingComponents, setLoadingComponents] = useState(true);
  const [savingComponents, setSavingComponents] = useState(false);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newComp, setNewComp] = useState<Partial<MealComponent>>({
    id: '',
    name: '',
    unit: 'piece',
    category: 'staple',
    baseQuantity: 1,
    minQuantity: 0,
    maxQuantity: 5,
    rawCost: 2.5,
    customerRate: 5,
    vendorRate: 4,
    isActive: true,
  });

  // Simulated Customization Delta for preview
  const [simulatedQuantities, setSimulatedQuantities] = useState<Record<string, number>>({});

  const loadCatalog = useCallback(async () => {
    setLoadingComponents(true);
    try {
      const data = await getMealComponentsCatalog();
      setComponents(data);
      setInitialComponents(data);
      const initialSim: Record<string, number> = {};
      data.forEach((c) => {
        initialSim[c.id] = c.baseQuantity;
      });
      setSimulatedQuantities(initialSim);
    } catch (err) {
      console.error('[MealPricingConfig] Error loading component catalog:', err);
      addToast('Failed to load meal components catalog', 'error');
    } finally {
      setLoadingComponents(false);
    }
  }, [addToast]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const isCatalogChanged = useMemo(() => {
    return JSON.stringify(components) !== JSON.stringify(initialComponents);
  }, [components, initialComponents]);

  const handleUpdateComponent = (id: string, field: keyof MealComponent, value: any) => {
    setComponents((prev) =>
      prev.map((c) => {
        if (c.id === id) {
          return { ...c, [field]: value };
        }
        return c;
      })
    );
  };

  const handleToggleActive = (id: string) => {
    setComponents((prev) =>
      prev.map((c) => {
        if (c.id === id) {
          return { ...c, isActive: !c.isActive };
        }
        return c;
      })
    );
  };

  const handleDeleteComponent = (id: string) => {
    setComponents((prev) => prev.filter((c) => c.id !== id));
  };

  const handleResetDefaults = () => {
    setComponents([...DEFAULT_MEAL_COMPONENTS]);
    const sim: Record<string, number> = {};
    DEFAULT_MEAL_COMPONENTS.forEach((c) => {
      sim[c.id] = c.baseQuantity;
    });
    setSimulatedQuantities(sim);
    addToast('Reset to standard pre-populated defaults', 'success');
  };

  const handleAddNewComponent = () => {
    if (!newComp.name?.trim()) {
      addToast('Component name is required', 'error');
      return;
    }
    const id = (newComp.id?.trim() || newComp.name.toLowerCase().replace(/[^a-z0-9]/g, '_'));
    if (components.some((c) => c.id === id)) {
      addToast(`Component ID "${id}" already exists`, 'error');
      return;
    }
    const custRate = Math.max(0, Number(newComp.customerRate ?? 10));
    const vendRate = Math.max(0, Number(newComp.vendorRate ?? 7));
    const minQ = Math.max(0, Number(newComp.minQuantity ?? 0));
    const maxQ = Math.max(1, Number(newComp.maxQuantity ?? 5));
    const baseQ = Math.max(0, Number(newComp.baseQuantity ?? 0));

    if (custRate < vendRate) {
      addToast('Customer rate cannot be lower than vendor rate (negative platform margin)', 'error');
      return;
    }
    if (minQ > maxQ) {
      addToast('Minimum quantity cannot exceed maximum quantity', 'error');
      return;
    }
    if (baseQ < minQ || baseQ > maxQ) {
      addToast('Base quantity must be between minimum and maximum quantity', 'error');
      return;
    }

    const rawCost = typeof newComp.rawCost === 'number' ? Math.max(0, newComp.rawCost) : 0;

    const created: MealComponent = {
      id,
      name: newComp.name.trim(),
      price: custRate,
      unit: (newComp.unit as ComponentUnit) || 'piece',
      category: (newComp.category as ComponentCategory) || 'staple',
      baseQuantity: baseQ,
      minQuantity: minQ,
      maxQuantity: maxQ,
      rawCost,
      customerRate: custRate,
      vendorRate: vendRate,
      isActive: true,
    };
    setComponents((prev) => [...prev, created]);
    setSimulatedQuantities((prev) => ({ ...prev, [created.id]: created.baseQuantity }));
    setNewComp({
      id: '',
      name: '',
      unit: 'piece',
      category: 'staple',
      baseQuantity: 1,
      minQuantity: 0,
      maxQuantity: 5,
      rawCost: 2.5,
      customerRate: 5,
      vendorRate: 4,
      isActive: true,
    });
    setIsAddingNew(false);
    addToast(`Added ${created.name} to catalog`, 'success');
  };

  const handleSaveCatalog = async () => {
    for (const comp of components) {
      if (!comp.name.trim()) {
        addToast('All components must have a valid name', 'error');
        return;
      }
      if (comp.customerRate < comp.vendorRate) {
        addToast(`Component "${comp.name}": customer rate (₹${comp.customerRate}) is lower than vendor rate (₹${comp.vendorRate})`, 'error');
        return;
      }
      if (comp.minQuantity > comp.maxQuantity) {
        addToast(`Component "${comp.name}": min quantity cannot exceed max quantity`, 'error');
        return;
      }
    }

    setSavingComponents(true);
    triggerHapticImpact(ImpactStyle.Medium);
    try {
      const updatedBy = user?.id || user?.email || 'admin';
      await saveMealComponentsCatalog(components, updatedBy);
      setInitialComponents([...components]);
      addToast('Meal components catalog saved successfully! 🍱', 'success');
    } catch (err: unknown) {
      console.error('[MealPricingConfig] Error saving catalog:', err);
      addToast(getErrorMessage(err) || 'Failed to save component catalog', 'error');
    } finally {
      setSavingComponents(false);
    }
  };

  const simulationDeltas = useMemo(() => {
    return calculateComponentDeltas(simulatedQuantities, components);
  }, [simulatedQuantities, components]);

  // ─── Parsed Numeric Values & Margins ──────────────────────────────────────────
  const parsedWeeklyPrice = Math.max(0, Number(weeklyPrice) || 0);
  const parsedWeeklyVendorCost = Math.max(0, Number(weeklyVendorCost) || 0);
  const weeklyMargin = Math.round((parsedWeeklyPrice - parsedWeeklyVendorCost) * 100) / 100;
  const weeklyMarginPercent =
    parsedWeeklyPrice > 0 ? ((weeklyMargin / parsedWeeklyPrice) * 100).toFixed(1) : '0';

  const parsedMonthlyPrice = Math.max(0, Number(monthlyPrice) || 0);
  const parsedMonthlyVendorCost = Math.max(0, Number(monthlyVendorCost) || 0);
  const monthlyMargin = Math.round((parsedMonthlyPrice - parsedMonthlyVendorCost) * 100) / 100;
  const monthlyMarginPercent =
    parsedMonthlyPrice > 0 ? ((monthlyMargin / parsedMonthlyPrice) * 100).toFixed(1) : '0';

  // ─── Change Detection ───────────────────────────────────────────────────────
  const isWeeklyChanged = useMemo(() => {
    return (
      parsedWeeklyPrice !== weeklyConfig.pricePerMeal ||
      parsedWeeklyVendorCost !== weeklyConfig.vendorCostPerMeal
    );
  }, [parsedWeeklyPrice, parsedWeeklyVendorCost, weeklyConfig]);

  const isMonthlyChanged = useMemo(() => {
    return (
      parsedMonthlyPrice !== monthlyConfig.pricePerMeal ||
      parsedMonthlyVendorCost !== monthlyConfig.vendorCostPerMeal
    );
  }, [parsedMonthlyPrice, parsedMonthlyVendorCost, monthlyConfig]);

  // ─── Save Handlers ─────────────────────────────────────────────────────────
  const handleSaveWeekly = async () => {
    if (parsedWeeklyPrice <= 0) {
      addToast('Weekly price per meal must be greater than ₹0', 'error');
      return;
    }
    setSavingWeekly(true);
    triggerHapticImpact(ImpactStyle.Light);
    try {
      const updatedBy = user?.id || user?.email || 'admin';
      const updated = await savePricingConfig(
        'weekly',
        parsedWeeklyPrice,
        parsedWeeklyVendorCost,
        updatedBy
      );
      setWeeklyConfig(updated);
      addToast(`Weekly pricing saved: ₹${updated.pricePerMeal}/meal (Margin: ₹${updated.margin})`, 'success');
      onSaved?.('weekly', updated);
    } catch (err: unknown) {
      console.error('[MealPricingConfig] Error saving weekly pricing:', err);
      addToast(getErrorMessage(err) || 'Failed to save weekly pricing', 'error');
    } finally {
      setSavingWeekly(false);
    }
  };

  const handleSaveMonthly = async () => {
    if (parsedMonthlyPrice <= 0) {
      addToast('Monthly price per meal must be greater than ₹0', 'error');
      return;
    }
    setSavingMonthly(true);
    triggerHapticImpact(ImpactStyle.Light);
    try {
      const updatedBy = user?.id || user?.email || 'admin';
      const updated = await savePricingConfig(
        'monthly',
        parsedMonthlyPrice,
        parsedMonthlyVendorCost,
        updatedBy
      );
      setMonthlyConfig(updated);
      addToast(`Monthly pricing saved: ₹${updated.pricePerMeal}/meal (Margin: ₹${updated.margin})`, 'success');
      onSaved?.('monthly', updated);
    } catch (err: unknown) {
      console.error('[MealPricingConfig] Error saving monthly pricing:', err);
      addToast(getErrorMessage(err) || 'Failed to save monthly pricing', 'error');
    } finally {
      setSavingMonthly(false);
    }
  };

  // Active authoritative pricing rules for live preview calculations
  const activePricingRules: PricingRules = useMemo(() => ({
    vendorDeduction: Number(vendorDeductionPct) / 100,
    margin: Number(marginPct) / 100,
    deliveryCharge: Math.max(0, Number(deliveryCharge) || 0),
    paymentFee: Number(paymentFeePct) / 100,
    roundingStrategy,
    version: '2.0.0',
  }), [vendorDeductionPct, marginPct, deliveryCharge, paymentFeePct, roundingStrategy]);

  // Catalog normalized for calculation engine
  const itemCatalogForEngine = useMemo(() => {
    return components.map((c) => ({
      id: c.id,
      name: c.name,
      price: typeof (c as any).price === 'number' ? (c as any).price : (c.customerRate ?? 10),
      customerRate: typeof (c as any).price === 'number' ? (c as any).price : (c.customerRate ?? 10),
      unit: c.unit,
      category: c.category,
      isActive: c.isActive,
      minQuantity: c.minQuantity,
      maxQuantity: c.maxQuantity,
      baseQuantity: c.baseQuantity,
      rawCost: c.rawCost,
    }));
  }, [components]);

  // Live single meal breakdown computed authoritatively
  const liveMealBreakdown = useMemo(() => {
    try {
      return calculateMealPrice(simMealQuantities, itemCatalogForEngine, activePricingRules);
    } catch {
      return null;
    }
  }, [simMealQuantities, itemCatalogForEngine, activePricingRules]);

  // Standard ₹4,500 monthly product breakdown
  const standardProductBreakdown = useMemo(() => {
    return calculateStandardSubscriptionProduct(30, activePricingRules);
  }, [activePricingRules]);

  // Helper to format timestamps gracefully
  const renderTimestamp = (ts?: any) => {
    if (!ts) return null;
    try {
      const date = ts?.toDate ? ts.toDate() : new Date(ts);
      return formatDate(date);
    } catch {
      return null;
    }
  };

  return (
    <div className={`space-y-6 ${className}`}>
      {/* ── Header Bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 bg-white rounded-2xl border border-slate-200/80 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20 text-brand">
            <IndianRupee className="w-6 h-6" strokeWidth={2.4} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black text-slate-900 tracking-tight">
                Meal Pricing Configuration
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
                Live Engine
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Configure base customer rates, kitchen vendor costs, and live profit margins on-the-fly.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void loadPricing()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-600 text-xs font-bold transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh Rates</span>
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          SECTION: AUTHORITATIVE CENTRAL PRICING ENGINE (system_settings/pricing_rules)
      ══════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-3xl border border-slate-200/85 shadow-xs p-5 sm:p-7 space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand/10 text-brand font-black shrink-0">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-black text-slate-900 leading-tight">
                  Authoritative Central Pricing Engine (v2.0)
                </h3>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-100 text-slate-700 border border-slate-200">
                  system_settings/pricing_rules
                </span>
                {isRulesChanged && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">
                    Unsaved Pricing Rule Edits
                  </span>
                )}
              </div>
              <p className="text-xs font-medium text-slate-500 mt-1">
                Single source of truth for meal pricing formulas. Enforces deterministic math across all 4 panels:
                <span className="font-mono text-slate-700 font-bold ml-1">
                  ItemTotal ➔ VendorCost (-8%) ➔ FoodSellingPrice (+13%) ➔ Subtotal (+₹11) ➔ CustomerPrice (/ 0.975)
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSaveRules}
            disabled={savingRules || !isRulesChanged}
            className={`px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all active:scale-95 flex items-center gap-2 shadow-xs ${
              isRulesChanged
                ? 'bg-brand hover:bg-amber-600 text-white shadow-brand/20'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            }`}
          >
            {savingRules ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Saving Rules…</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                <span>Save Authoritative Rules</span>
              </>
            )}
          </button>
        </div>

        {/* Algorithm Controls Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* 1. Vendor Deduction % */}
          <div className="p-4 bg-amber-50/50 rounded-2xl border border-amber-200/70 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-extrabold text-slate-800">
                Vendor Deduction
              </label>
              <span className="text-xs font-black text-brand bg-white px-2 py-0.5 rounded-md border border-amber-200">
                {vendorDeductionPct}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="30"
                step="0.5"
                value={vendorDeductionPct}
                onChange={(e) => setVendorDeductionPct(Number(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer"
              />
              <input
                type="number"
                min="0"
                max="50"
                step="0.5"
                value={vendorDeductionPct}
                onChange={(e) => setVendorDeductionPct(Number(e.target.value))}
                className="w-14 px-1.5 py-1 bg-white border border-amber-200 rounded-lg text-xs font-black text-slate-900 text-center"
              />
            </div>
            <p className="text-[10px] text-slate-500 font-mono">
              VendorCost = ItemTotal × (1 − {vendorDeductionPct}%)
            </p>
          </div>

          {/* 2. Platform Food Margin % */}
          <div className="p-4 bg-orange-50/50 rounded-2xl border border-orange-200/70 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-extrabold text-slate-800">
                Platform Margin
              </label>
              <span className="text-xs font-black text-orange-700 bg-white px-2 py-0.5 rounded-md border border-orange-200">
                {marginPct}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="40"
                step="0.5"
                value={marginPct}
                onChange={(e) => setMarginPct(Number(e.target.value))}
                className="w-full accent-orange-500 cursor-pointer"
              />
              <input
                type="number"
                min="0"
                max="50"
                step="0.5"
                value={marginPct}
                onChange={(e) => setMarginPct(Number(e.target.value))}
                className="w-14 px-1.5 py-1 bg-white border border-orange-200 rounded-lg text-xs font-black text-slate-900 text-center"
              />
            </div>
            <p className="text-[10px] text-slate-500 font-mono">
              FoodSelling = VendorCost × (1 + {marginPct}%)
            </p>
          </div>

          {/* 3. Delivery Charge */}
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/70 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-extrabold text-slate-800">
                Delivery Charge
              </label>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                Fixed / Meal
              </span>
            </div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">₹</span>
              <input
                type="number"
                min="0"
                step="1"
                value={deliveryCharge}
                onChange={(e) => setDeliveryCharge(e.target.value)}
                className="w-full pl-7 pr-14 py-2 bg-white border border-slate-200 rounded-xl text-slate-900 font-extrabold text-sm focus:border-brand focus:ring-2 focus:ring-brand/10 outline-none"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-slate-400">/ meal</span>
            </div>
            <p className="text-[10px] text-slate-500 font-mono">
              Subtotal = FoodSelling + ₹{deliveryCharge}
            </p>
          </div>

          {/* 4. Payment Fee Gross-up % */}
          <div className="p-4 bg-indigo-50/50 rounded-2xl border border-indigo-200/70 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-extrabold text-slate-800">
                Payment Fee Rate
              </label>
              <span className="text-xs font-black text-indigo-700 bg-white px-2 py-0.5 rounded-md border border-indigo-200">
                {paymentFeePct}%
              </span>
            </div>
            <div className="relative">
              <input
                type="number"
                min="0"
                max="10"
                step="0.1"
                value={paymentFeePct}
                onChange={(e) => setPaymentFeePct(Number(e.target.value))}
                className="w-full pl-3 pr-10 py-2 bg-white border border-indigo-200 rounded-xl text-slate-900 font-extrabold text-sm focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 outline-none"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-indigo-400">%</span>
            </div>
            <p className="text-[10px] text-slate-500 font-mono">
              Customer = Subtotal / (1 − {paymentFeePct / 100})
            </p>
          </div>

          {/* 5. Rounding Strategy & Version */}
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/70 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-extrabold text-slate-800">
                Rounding Strategy
              </label>
              <select
                value={roundingStrategy}
                onChange={(e) => setRoundingStrategy(e.target.value as 'round' | 'ceil')}
                className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 outline-none"
              >
                <option value="round">Math.round (Standard)</option>
                <option value="ceil">Math.ceil (Ceiling)</option>
              </select>
            </div>
            <div className="pt-2 text-[10px] text-slate-400 flex items-center justify-between">
              <span>Engine Version:</span>
              <span className="font-mono font-bold text-emerald-700">v2.0.0 (Authoritative)</span>
            </div>
          </div>
        </div>

        {/* ── Walkthrough / Prompt Example Sandbox ── */}
        <div className="p-4 sm:p-5 bg-gradient-to-br from-amber-500/10 via-orange-500/5 to-emerald-500/10 rounded-2xl border border-amber-200/90 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-amber-200/60">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-brand" />
              <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider">
                Live Single Meal Walkthrough & Prompt Formula Verification
              </h4>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setSimMealQuantities({
                    rice: 1,
                    dal: 1,
                    roti: 1,
                    sabji: 1,
                    salad: 1,
                  });
                  addToast('Loaded canonical formula example: 1 Rice, 1 Dal, 1 Roti, 1 Sabji, 1 Salad (ItemTotal = ₹78)', 'info');
                }}
                className="text-[11px] font-black px-2.5 py-1 rounded-lg bg-white border border-amber-300 text-amber-900 hover:bg-amber-50 active:scale-95 shadow-2xs"
              >
                Reset to Prompt Example (₹78 ItemTotal)
              </button>
            </div>
          </div>

          {/* Interactive Steppers for Items in Simulation */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
            {[
              { id: 'rice', name: 'Rice', unitPrice: 15 },
              { id: 'dal', name: 'Dal', unitPrice: 20 },
              { id: 'roti', name: 'Roti', unitPrice: 8 },
              { id: 'sabji', name: 'Sabji', unitPrice: 25 },
              { id: 'salad', name: 'Salad', unitPrice: 10 },
            ].map((item) => {
              const qty = simMealQuantities[item.id] ?? 0;
              return (
                <div key={item.id} className="bg-white p-2 rounded-xl border border-amber-200/70 text-center space-y-1">
                  <div className="text-xs font-black text-slate-800">{item.name}</div>
                  <div className="text-[10px] text-slate-400 font-medium">₹{item.unitPrice} each</div>
                  <div className="flex items-center justify-center gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={() => setSimMealQuantities((prev) => ({ ...prev, [item.id]: Math.max(0, (prev[item.id] ?? 0) - 1) }))}
                      className="w-5 h-5 rounded bg-slate-100 hover:bg-slate-200 text-slate-800 font-black text-xs flex items-center justify-center"
                    >
                      –
                    </button>
                    <span className="font-mono font-black text-xs w-4">{qty}</span>
                    <button
                      type="button"
                      onClick={() => setSimMealQuantities((prev) => ({ ...prev, [item.id]: (prev[item.id] ?? 0) + 1 }))}
                      className="w-5 h-5 rounded bg-slate-100 hover:bg-slate-200 text-slate-800 font-black text-xs flex items-center justify-center"
                    >
                      +
                    </button>
                  </div>
                  <div className="text-[10px] font-bold text-amber-900">
                    = ₹{qty * item.unitPrice}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Step-by-Step Mathematical Flow */}
          {liveMealBreakdown && (
            <div className="space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 text-xs">
                {/* 1. Item Total */}
                <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">1. Item Total</span>
                  <div className="text-lg font-black text-slate-900 mt-0.5">
                    ₹{liveMealBreakdown.itemTotal.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    SUM(item prices × quantities)
                  </div>
                </div>

                {/* 2. Vendor Cost */}
                <div className="bg-white p-3 rounded-xl border border-amber-200 shadow-2xs">
                  <span className="text-[10px] font-bold text-amber-800 uppercase tracking-wider block">
                    2. Vendor Cost (-{vendorDeductionPct}%)
                  </span>
                  <div className="text-lg font-black text-amber-900 mt-0.5">
                    ₹{liveMealBreakdown.vendorCost.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    Vendor receives payout: ₹{liveMealBreakdown.vendorCost.toFixed(2)}
                  </div>
                </div>

                {/* 3. Food Selling Price */}
                <div className="bg-white p-3 rounded-xl border border-orange-200 shadow-2xs">
                  <span className="text-[10px] font-bold text-orange-700 uppercase tracking-wider block">
                    3. Food Selling (+{marginPct}%)
                  </span>
                  <div className="text-lg font-black text-orange-800 mt-0.5">
                    ₹{liveMealBreakdown.foodSellingPrice.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    Dabzzo margin: ₹{liveMealBreakdown.margin.toFixed(2)}
                  </div>
                </div>

                {/* 4. Subtotal */}
                <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    4. Subtotal (+₹{deliveryCharge})
                  </span>
                  <div className="text-lg font-black text-slate-900 mt-0.5">
                    ₹{liveMealBreakdown.subtotal.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    Food ₹{liveMealBreakdown.foodSellingPrice.toFixed(2)} + Del ₹{deliveryCharge}
                  </div>
                </div>

                {/* 5. Customer Final Price */}
                <div className="bg-white p-3 rounded-xl border border-emerald-300 ring-2 ring-emerald-400/30 shadow-2xs">
                  <span className="text-[10px] font-black text-emerald-800 uppercase tracking-wider block">
                    5. Customer Price (/ {1 - (paymentFeePct / 100)})
                  </span>
                  <div className="text-xl font-black text-emerald-700 mt-0.5">
                    ₹{liveMealBreakdown.finalPrice.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    Razorpay gross-up fee: ₹{liveMealBreakdown.paymentFee.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* Exact Prompt Example Sequence Callout Banner */}
              <div className="p-3 bg-white/95 rounded-xl border border-amber-300 flex flex-col md:flex-row md:items-center justify-between gap-2 shadow-xs">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded text-[10px] font-black bg-amber-100 text-amber-900 uppercase tracking-wider">
                    Authoritative Flow
                  </span>
                  <span className="text-xs font-black text-slate-800">
                    Step-by-step calculation output for this meal:
                  </span>
                </div>
                <div className="font-mono text-sm font-black text-slate-900 bg-amber-50/80 px-3 py-1 rounded-lg border border-amber-200">
                  <span className="text-slate-700">₹{liveMealBreakdown.itemTotal.toFixed(2)}</span>
                  <span className="text-amber-500 mx-1.5">➔</span>
                  <span className="text-amber-900">₹{liveMealBreakdown.vendorCost.toFixed(2)}</span>
                  <span className="text-amber-500 mx-1.5">➔</span>
                  <span className="text-orange-800">₹{liveMealBreakdown.foodSellingPrice.toFixed(2)}</span>
                  <span className="text-amber-500 mx-1.5">➔</span>
                  <span className="text-slate-800">₹{liveMealBreakdown.subtotal.toFixed(2)}</span>
                  <span className="text-amber-500 mx-1.5">➔</span>
                  <span className="text-emerald-700 font-extrabold text-base">₹{liveMealBreakdown.finalPrice.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Standard ₹4,500 Subscription Product Preservation Card ── */}
        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/80 space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-brand" />
              <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider">
                Standard ₹4,500 Monthly Subscription Product (Fixed Architecture Preservation)
              </h4>
            </div>
            <span className="text-[10px] font-black px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
              Preserved & Enforced
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 text-xs pt-1">
            <div className="bg-white p-2.5 rounded-xl border border-slate-200">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Customer Pays</span>
              <div className="text-base font-black text-slate-900 mt-0.5">₹4,500</div>
              <div className="text-[10px] text-slate-500">30 Meals committed monthly</div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Vendor Base & Deduction</span>
              <div className="text-base font-black text-amber-900 mt-0.5">₹4,000 − 8%</div>
              <div className="text-[10px] text-emerald-700 font-bold">Vendor gets ₹3,680</div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Delivery Allocation</span>
              <div className="text-base font-black text-slate-800 mt-0.5">₹330</div>
              <div className="text-[10px] text-slate-500">30 deliveries × ₹11</div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Dabzzo Gross Margin</span>
              <div className="text-base font-black text-emerald-700 mt-0.5">₹490</div>
              <div className="text-[10px] text-slate-500">Food margin + delivery recovery</div>
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          SECTION: DYNAMIC MARGIN RULES (system_settings/margin_rules)
      ══════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-3xl border border-slate-200/85 shadow-xs p-5 sm:p-7 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-700 font-black shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-black text-slate-900 leading-tight">
                  Dynamic Margin Rules (Quantity Tiers)
                </h3>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-100 text-slate-700 border border-slate-200">
                  system_settings/margin_rules
                </span>
                {isMarginChanged && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">
                    Unsaved Margin Rule Edits
                  </span>
                )}
              </div>
              <p className="text-xs font-medium text-slate-500 mt-1">
                Sliding platform margin by subscription meal count — the configuration-driven margin override.
                Active tiers must cover <span className="font-mono font-bold text-slate-700">[1 meal → ∞)</span>{' '}
                contiguously, and the final tier is open-ended. When no tier matches, the flat{' '}
                <span className="font-mono font-bold text-orange-700">{marginPct}%</span> Platform Margin is used.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              type="button"
              onClick={() => setMarginEnabled((v) => !v)}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all active:scale-95 ${
                marginEnabled
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : 'bg-slate-100 text-slate-500 border border-slate-200'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${marginEnabled ? 'bg-emerald-600' : 'bg-slate-400'}`} />
              {marginEnabled ? 'Enabled' : 'Disabled'}
            </button>

            <button
              type="button"
              onClick={() => void handleSaveMarginRules()}
              disabled={savingMarginRules || !isMarginChanged}
              className={`px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all active:scale-95 flex items-center gap-2 shadow-xs ${
                isMarginChanged
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-500/20'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              {savingMarginRules ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Margin Rules</span>
                </>
              )}
            </button>
          </div>
        </div>

        {!marginEnabled && (
          <div className="p-3 rounded-xl border border-amber-200 bg-amber-50/70 text-xs font-medium text-amber-900 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
            Margin tiers are currently disabled — the flat {marginPct}% Platform Margin is applied to every meal count.
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-12 gap-2 px-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
            <div className="col-span-2 sm:col-span-1">Active</div>
            <div className="col-span-3 sm:col-span-2">Tier ID</div>
            <div className="col-span-2 text-center">Min Meals</div>
            <div className="col-span-2 text-center">Max Meals</div>
            <div className="col-span-2 text-center">Margin</div>
            <div className="col-span-1" />
          </div>

          {marginDrafts.length === 0 && (
            <div className="p-4 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 text-center text-xs font-medium text-slate-500">
              No tiers configured — the flat {marginPct}% platform margin applies to all meal counts. Add a tier to
              enable quantity-based margins.
            </div>
          )}

          {marginDrafts.map((d, i) => (
            <div
              key={i}
              className="grid grid-cols-12 gap-2 items-center bg-slate-50/70 border border-slate-200 rounded-xl px-3 py-2.5"
            >
              <div className="col-span-2 sm:col-span-1">
                <button
                  type="button"
                  onClick={() => handleUpdateMarginDraft(i, { isActive: !d.isActive })}
                  className={`w-7 h-7 rounded-lg flex items-center justify-center border transition-all active:scale-95 ${
                    d.isActive
                      ? 'bg-emerald-600 border-emerald-600 text-white'
                      : 'bg-white border-slate-300 text-transparent'
                  }`}
                  title={d.isActive ? 'Active' : 'Disabled'}
                >
                  <CheckCircle2 className="w-4 h-4" />
                </button>
              </div>
              <div className="col-span-3 sm:col-span-2">
                <input
                  type="text"
                  value={d.id}
                  onChange={(e) => handleUpdateMarginDraft(i, { id: e.target.value })}
                  placeholder="tier_id"
                  className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 outline-none focus:border-emerald-600"
                />
              </div>
              <div className="col-span-2 text-center">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={d.minMeals}
                  onChange={(e) => handleUpdateMarginDraft(i, { minMeals: e.target.value })}
                  className="w-20 mx-auto px-1.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 text-center outline-none focus:border-emerald-600"
                />
              </div>
              <div className="col-span-2 text-center">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={d.maxMeals}
                  onChange={(e) => handleUpdateMarginDraft(i, { maxMeals: e.target.value })}
                  placeholder="∞"
                  className="w-20 mx-auto px-1.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 text-center outline-none focus:border-emerald-600"
                />
                {d.maxMeals.trim() === '' && (
                  <span className="block text-[9px] font-bold text-emerald-700 mt-0.5">open-ended (final tier)</span>
                )}
              </div>
              <div className="col-span-2 text-center relative">
                <input
                  type="number"
                  min="0"
                  max="99"
                  step="0.5"
                  value={d.marginPct}
                  onChange={(e) => handleUpdateMarginDraft(i, { marginPct: e.target.value })}
                  className="w-20 mx-auto pl-2 pr-5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 text-right outline-none focus:border-emerald-600"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400">%</span>
              </div>
              <div className="col-span-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => setMarginDrafts((prev) => prev.filter((_, idx) => idx !== i))}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                  title="Remove tier"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={handleAddMarginTier}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-emerald-400 text-emerald-700 hover:bg-emerald-50 text-xs font-black transition-all active:scale-95"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Margin Tier
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pt-1">
          <div
            className={`p-3.5 rounded-xl border text-xs ${
              marginValidationErrors.length === 0
                ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-900'
            }`}
          >
            <div className="flex items-center gap-1.5 font-black uppercase tracking-wider text-[10px]">
              {marginValidationErrors.length === 0 ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <X className="w-3.5 h-3.5 text-rose-600" />
              )}
              Config Validation
            </div>
            <div className="mt-1.5 font-medium">
              {marginValidationErrors.length === 0 ? (
                'Tiers tile [1 meal → ∞) contiguously — all meal counts covered.'
              ) : (
                marginValidationErrors.map((e, idx) => (
                  <div key={idx} className="flex items-start gap-1.5">
                    <span>•</span>
                    <span>{e}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-black uppercase tracking-wider text-[10px] text-slate-500 flex items-center gap-1.5">
                <Percent className="w-3.5 h-3.5" />
                Resolved Margin Preview
              </span>
              <select
                value={marginPreviewMeals}
                onChange={(e) => setMarginPreviewMeals(Number(e.target.value))}
                className="bg-white border border-slate-200 rounded px-1.5 py-0.5 font-black text-xs text-slate-800 outline-none"
              >
                {[1, 5, 7, 10, 12, 14, 20, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    {m} meals
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-1.5 font-black text-slate-900">
              {marginEnabled && marginValidationErrors.length === 0 && resolvedPreviewMargin.ruleId
                ? `${marginPreviewMeals} meals → ${(resolvedPreviewMargin.rate * 100).toFixed(1)}% margin (tier "${resolvedPreviewMargin.ruleId}")`
                : `${marginPreviewMeals} meals → ${marginPct}% margin (flat Platform Margin)`}
            </div>
          </div>
        </div>
      </div>

      {/* ── Main Two-Column Pricing Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ══════════════════════════════════════════════════════════════
            CARD 1: WEEKLY PLANS PRICING
        ══════════════════════════════════════════════════════════════ */}
        <div className="flex flex-col justify-between bg-white rounded-2xl border border-slate-200/85 shadow-xs p-5 sm:p-6 transition-all hover:border-slate-300">
          <div className="space-y-5">
            {/* Title & Plan Badge */}
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100 text-brand font-black">
                  <Calendar className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900 leading-tight">
                    Weekly Plans
                  </h3>
                  <span className="text-[11px] font-medium text-slate-400">
                    Flexible recurring weekly tiffins
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                {isWeeklyChanged && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">
                    Unsaved Edits
                  </span>
                )}
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-orange-50 text-brand border border-orange-200">
                  Weekly
                </span>
              </div>
            </div>

            {/* Inputs Group */}
            <div className="space-y-4">
              {/* 1. Price Per Meal */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Price per meal (₹)
                  <span className="ml-1 text-[11px] font-normal text-slate-400">
                    — Single input field (e.g. ₹50/meal)
                  </span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 font-bold text-sm">
                    ₹
                  </div>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={weeklyPrice}
                    onChange={(e) => setWeeklyPrice(e.target.value)}
                    placeholder="50"
                    className="w-full pl-8 pr-16 py-2.5 bg-slate-50/70 border border-slate-200 rounded-xl text-slate-900 font-extrabold text-base focus:bg-white focus:border-brand focus:ring-2 focus:ring-brand/10 outline-none transition-all"
                  />
                  <div className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-xs font-semibold text-slate-400">
                    / meal
                  </div>
                </div>
              </div>

              {/* 2. Vendor Cost Per Meal */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Vendor cost per meal (₹)
                  <span className="ml-1 text-[11px] font-normal text-slate-400">
                    — for margin calculation (e.g. ₹30/meal)
                  </span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 font-bold text-sm">
                    ₹
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={weeklyVendorCost}
                    onChange={(e) => setWeeklyVendorCost(e.target.value)}
                    placeholder="30"
                    className="w-full pl-8 pr-16 py-2.5 bg-slate-50/70 border border-slate-200 rounded-xl text-slate-900 font-extrabold text-base focus:bg-white focus:border-brand focus:ring-2 focus:ring-brand/10 outline-none transition-all"
                  />
                  <div className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-xs font-semibold text-slate-400">
                    / meal
                  </div>
                </div>
              </div>
            </div>

            {/* 3. Profit Margin Display */}
            <div
              className={`p-4 rounded-xl border transition-all ${
                weeklyMargin >= 0
                  ? 'bg-emerald-50/60 border-emerald-200/80 text-emerald-900'
                  : 'bg-rose-50 border-rose-200 text-rose-900'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {weeklyMargin >= 0 ? (
                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-rose-600" />
                  )}
                  <span className="text-xs font-bold uppercase tracking-wider">
                    Profit Margin per meal
                  </span>
                </div>
                <span
                  className={`text-[11px] font-black px-2 py-0.5 rounded-full ${
                    weeklyMargin >= 0
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  {weeklyMarginPercent}%
                </span>
              </div>

              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-2xl font-black tracking-tight">
                  ₹{weeklyMargin}
                  <span className="text-xs font-semibold text-slate-500 ml-1">
                    profit / meal
                  </span>
                </span>
                <span className="text-xs text-slate-500 font-medium">
                  ₹{parsedWeeklyPrice} − ₹{parsedWeeklyVendorCost}
                </span>
              </div>
            </div>

            {/* 4. Live Calculation Output Pill (Mandatory User Requirement) */}
            <div className="p-3.5 bg-amber-50/80 border border-amber-200/80 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-black text-amber-900">
                  <Calculator className="w-4 h-4 text-amber-700" />
                  <span>Calculation Preview:</span>
                </div>

                <div className="flex items-center gap-1 text-[11px] font-bold text-amber-800">
                  <span>Meals:</span>
                  <select
                    value={previewMealsPerWeek}
                    onChange={(e) => setPreviewMealsPerWeek(Number(e.target.value))}
                    className="bg-white border border-amber-300 rounded px-1.5 py-0.5 font-black text-xs text-amber-950 outline-none"
                  >
                    {[5, 7, 9, 12, 14].map((m) => (
                      <option key={m} value={m}>
                        {m} meals/week
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Exact required text format */}
              <div className="bg-white/80 p-2.5 rounded-lg border border-amber-200/60">
                <p className="text-xs font-black text-slate-800">
                  If customer orders {previewMealsPerWeek} meals/week, total:{' '}
                  <span className="text-brand font-black text-sm">
                    ₹{previewMealsPerWeek * parsedWeeklyPrice}
                  </span>
                </p>
                <p className="text-[11px] font-medium text-slate-500 mt-1 flex items-center justify-between">
                  <span>Vendor payout: ₹{previewMealsPerWeek * parsedWeeklyVendorCost}</span>
                  <span className="text-emerald-700 font-bold">
                    Dabzzo gross profit: ₹{previewMealsPerWeek * weeklyMargin}
                  </span>
                </p>
              </div>
            </div>

            {/* Current Pricing in Database */}
            <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 flex items-center justify-between">
              <div>
                <span className="font-semibold text-slate-700">Database Rate:</span>{' '}
                ₹{weeklyConfig.pricePerMeal}/meal • Vendor: ₹{weeklyConfig.vendorCostPerMeal}
              </div>
              {weeklyConfig.updatedAt && (
                <div className="text-[10px] text-slate-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  <span>{renderTimestamp(weeklyConfig.updatedAt)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Save Button */}
          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveWeekly}
              disabled={savingWeekly || !isWeeklyChanged}
              className={`w-full py-2.5 px-4 rounded-xl font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all active:scale-[0.98] shadow-xs ${
                isWeeklyChanged
                  ? 'bg-brand hover:bg-amber-600 text-white shadow-brand/20'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              {savingWeekly ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Saving Weekly Pricing…</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>Save Weekly Pricing</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════
            CARD 2: MONTHLY PLANS PRICING
        ══════════════════════════════════════════════════════════════ */}
        <div className="flex flex-col justify-between bg-white rounded-2xl border border-slate-200/85 shadow-xs p-5 sm:p-6 transition-all hover:border-slate-300">
          <div className="space-y-5">
            {/* Title & Plan Badge */}
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 font-black">
                  <CalendarRange className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900 leading-tight">
                    Monthly Plans
                  </h3>
                  <span className="text-[11px] font-medium text-slate-400">
                    Full calendar month committed subscriptions
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                {isMonthlyChanged && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">
                    Unsaved Edits
                  </span>
                )}
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-indigo-50 text-indigo-700 border border-indigo-200">
                  Monthly
                </span>
              </div>
            </div>

            {/* Inputs Group */}
            <div className="space-y-4">
              {/* 1. Price Per Meal / Rate */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Price per meal (₹)
                  <span className="ml-1 text-[11px] font-normal text-slate-400">
                    — Monthly rate (e.g. ₹1400/meal)
                  </span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 font-bold text-sm">
                    ₹
                  </div>
                  <input
                    type="number"
                    min="1"
                    step="10"
                    value={monthlyPrice}
                    onChange={(e) => setMonthlyPrice(e.target.value)}
                    placeholder="1400"
                    className="w-full pl-8 pr-16 py-2.5 bg-slate-50/70 border border-slate-200 rounded-xl text-slate-900 font-extrabold text-base focus:bg-white focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 outline-none transition-all"
                  />
                  <div className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-xs font-semibold text-slate-400">
                    / meal
                  </div>
                </div>
              </div>

              {/* 2. Vendor Cost Per Meal */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Vendor cost per meal (₹)
                  <span className="ml-1 text-[11px] font-normal text-slate-400">
                    — for margin calculation (e.g. ₹900/meal)
                  </span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 font-bold text-sm">
                    ₹
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="10"
                    value={monthlyVendorCost}
                    onChange={(e) => setMonthlyVendorCost(e.target.value)}
                    placeholder="900"
                    className="w-full pl-8 pr-16 py-2.5 bg-slate-50/70 border border-slate-200 rounded-xl text-slate-900 font-extrabold text-base focus:bg-white focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 outline-none transition-all"
                  />
                  <div className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-xs font-semibold text-slate-400">
                    / meal
                  </div>
                </div>
              </div>
            </div>

            {/* 3. Profit Margin Display */}
            <div
              className={`p-4 rounded-xl border transition-all ${
                monthlyMargin >= 0
                  ? 'bg-emerald-50/60 border-emerald-200/80 text-emerald-900'
                  : 'bg-rose-50 border-rose-200 text-rose-900'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {monthlyMargin >= 0 ? (
                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-rose-600" />
                  )}
                  <span className="text-xs font-bold uppercase tracking-wider">
                    Profit Margin per meal
                  </span>
                </div>
                <span
                  className={`text-[11px] font-black px-2 py-0.5 rounded-full ${
                    monthlyMargin >= 0
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  {monthlyMarginPercent}%
                </span>
              </div>

              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-2xl font-black tracking-tight">
                  ₹{monthlyMargin}
                  <span className="text-xs font-semibold text-slate-500 ml-1">
                    profit / meal
                  </span>
                </span>
                <span className="text-xs text-slate-500 font-medium">
                  ₹{parsedMonthlyPrice} − ₹{parsedMonthlyVendorCost}
                </span>
              </div>
            </div>

            {/* 4. Live Calculation Output Pill (Mandatory User Requirement) */}
            <div className="p-3.5 bg-indigo-50/70 border border-indigo-200/70 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-black text-indigo-900">
                  <Calculator className="w-4 h-4 text-indigo-700" />
                  <span>Calculation Preview:</span>
                </div>
                <span className="text-[11px] font-bold text-indigo-600">Standard 9 meals/week</span>
              </div>

              {/* Exact required text format */}
              <div className="bg-white/80 p-2.5 rounded-lg border border-indigo-200/60">
                <p className="text-xs font-black text-slate-800">
                  If customer orders 9 meals/week, total:{' '}
                  <span className="text-indigo-700 font-black text-sm">
                    ₹{9 * parsedMonthlyPrice}
                  </span>
                </p>
                <p className="text-[11px] font-medium text-slate-500 mt-1 flex items-center justify-between">
                  <span>Vendor payout: ₹{9 * parsedMonthlyVendorCost}</span>
                  <span className="text-emerald-700 font-bold">
                    Dabzzo gross profit: ₹{9 * monthlyMargin}
                  </span>
                </p>
              </div>
            </div>

            {/* Current Pricing in Database */}
            <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 flex items-center justify-between">
              <div>
                <span className="font-semibold text-slate-700">Database Rate:</span>{' '}
                ₹{monthlyConfig.pricePerMeal}/meal • Vendor: ₹{monthlyConfig.vendorCostPerMeal}
              </div>
              {monthlyConfig.updatedAt && (
                <div className="text-[10px] text-slate-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  <span>{renderTimestamp(monthlyConfig.updatedAt)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Save Button */}
          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveMonthly}
              disabled={savingMonthly || !isMonthlyChanged}
              className={`w-full py-2.5 px-4 rounded-xl font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all active:scale-[0.98] shadow-xs ${
                isMonthlyChanged
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-200'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              {savingMonthly ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Saving Monthly Pricing…</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>Save Monthly Pricing</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          SECTION 3: GLOBAL MEAL COMPONENT CATALOG & CUSTOMIZATION RATES
          Firestore Document: system_settings/meal_components
      ══════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-3xl border border-slate-200/85 shadow-xs p-5 sm:p-7 space-y-6 transition-all">
        {/* Section Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/10 text-brand font-black shrink-0">
              <Utensils className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-black text-slate-900 leading-tight">
                  Global Meal Component Catalog & Customization Rates
                </h3>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-100 text-slate-700 border border-slate-200">
                  system_settings/meal_components
                </span>
                {isCatalogChanged && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">
                    Unsaved Catalog Edits
                  </span>
                )}
              </div>
              <p className="text-xs font-medium text-slate-500 mt-1">
                Manage base thali items, default quantities, min/max bounds, customer rates, vendor payout rates, and component margins.
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-bold transition-all active:scale-95 flex items-center gap-1.5"
            >
              <Undo2 className="w-3.5 h-3.5 text-slate-500" />
              <span>Reset Defaults</span>
            </button>

            <button
              type="button"
              onClick={() => setIsAddingNew(true)}
              className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-all active:scale-95 flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5 text-amber-400" />
              <span>Add Component</span>
            </button>

            <button
              type="button"
              onClick={handleSaveCatalog}
              disabled={savingComponents || !isCatalogChanged}
              className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all active:scale-95 flex items-center gap-1.5 shadow-xs ${
                isCatalogChanged
                  ? 'bg-brand hover:bg-amber-600 text-white shadow-brand/20'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              {savingComponents ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Catalog</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Add New Component Drawer/Form */}
        {isAddingNew && (
          <div className="p-4 bg-amber-50/50 rounded-2xl border border-amber-200/80 space-y-4 animate-fade-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-black text-amber-900">
                <Plus className="w-4 h-4 text-brand" />
                <span>Add New Meal Component to Catalog</span>
              </div>
              <button
                type="button"
                onClick={() => setIsAddingNew(false)}
                className="w-7 h-7 rounded-full bg-white text-slate-400 hover:text-slate-700 flex items-center justify-center border border-amber-200/60"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Item Name</label>
                <input
                  type="text"
                  placeholder="e.g. Paratha"
                  value={newComp.name || ''}
                  onChange={(e) => setNewComp({ ...newComp, name: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Category</label>
                <select
                  value={newComp.category || 'staple'}
                  onChange={(e) => setNewComp({ ...newComp, category: e.target.value as ComponentCategory })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:border-brand"
                >
                  <option value="staple">Staple (Roti, Rice)</option>
                  <option value="curry">Curry (Dal, Sabzi)</option>
                  <option value="side">Side (Salad, Curd)</option>
                  <option value="dessert">Dessert (Sweet)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Unit</label>
                <select
                  value={newComp.unit || 'piece'}
                  onChange={(e) => setNewComp({ ...newComp, unit: e.target.value as ComponentUnit })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:border-brand"
                >
                  <option value="piece">Piece (Roti, Sweet)</option>
                  <option value="bowl">Bowl (Dal, Sabzi, Rice)</option>
                  <option value="portion">Portion (Curd, Salad)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Base Quantity</label>
                <input
                  type="number"
                  min="0"
                  value={newComp.baseQuantity ?? 0}
                  onChange={(e) => setNewComp({ ...newComp, baseQuantity: Number(e.target.value) })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Min Quantity</label>
                <input
                  type="number"
                  min="0"
                  value={newComp.minQuantity ?? 0}
                  onChange={(e) => setNewComp({ ...newComp, minQuantity: Number(e.target.value) })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Max Quantity</label>
                <input
                  type="number"
                  min="1"
                  value={newComp.maxQuantity ?? 5}
                  onChange={(e) => setNewComp({ ...newComp, maxQuantity: Number(e.target.value) })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Customer Rate (₹)</label>
                <input
                  type="number"
                  min="0"
                  value={newComp.customerRate ?? 10}
                  onChange={(e) => setNewComp({ ...newComp, customerRate: Number(e.target.value) })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Vendor Rate (₹)</label>
                <input
                  type="number"
                  min="0"
                  value={newComp.vendorRate ?? 7}
                  onChange={(e) => setNewComp({ ...newComp, vendorRate: Number(e.target.value) })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl font-bold text-slate-900 focus:outline-none focus:border-brand"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsAddingNew(false)}
                className="px-3.5 py-2 text-xs font-bold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddNewComponent}
                className="px-4 py-2 text-xs font-black uppercase tracking-wider bg-brand text-white rounded-xl hover:bg-amber-600"
              >
                Add Component
              </button>
            </div>
          </div>
        )}

        {/* Components Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] font-black uppercase tracking-wider text-slate-400">
                <th className="pb-3 pl-2">Component</th>
                <th className="pb-3">Category</th>
                <th className="pb-3">Unit</th>
                <th className="pb-3">Base Qty</th>
                <th className="pb-3">Min / Max</th>
                <th className="pb-3">Admin Item Price (₹)</th>
                <th className="pb-3">Derived Vendor Cost (-{vendorDeductionPct}%)</th>
                <th className="pb-3 text-center">Active</th>
                <th className="pb-3 pr-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {components.map((comp) => {
                const itemPrice = typeof (comp as any).price === 'number' ? (comp as any).price : (comp.customerRate ?? 10);
                const derivedVendorCost = Math.round(itemPrice * (1 - (vendorDeductionPct / 100)) * 100) / 100;

                const categoryColors: Record<ComponentCategory, { bg: string; text: string; border: string }> = {
                  staple: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
                  curry: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
                  side: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
                  dessert: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
                };
                const catStyle = categoryColors[comp.category] || categoryColors.staple;

                return (
                  <tr key={comp.id} className={`hover:bg-slate-50/70 transition-colors ${!comp.isActive ? 'opacity-50' : ''}`}>
                    {/* Component Name & ID */}
                    <td className="py-3 pl-2">
                      <div className="font-extrabold text-sm text-slate-900">{comp.name}</div>
                      <div className="text-[10px] font-mono text-slate-400">id: {comp.id}</div>
                    </td>

                    {/* Category Badge */}
                    <td className="py-3">
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider border ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}>
                        {comp.category}
                      </span>
                    </td>

                    {/* Unit */}
                    <td className="py-3">
                      <span className="text-xs font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md">
                        {comp.unit}
                      </span>
                    </td>

                    {/* Base Quantity */}
                    <td className="py-3">
                      <div className="w-16">
                        <input
                          type="number"
                          min="0"
                          value={comp.baseQuantity}
                          onChange={(e) => handleUpdateComponent(comp.id, 'baseQuantity', Math.max(0, Number(e.target.value)))}
                          className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs font-black text-slate-900 focus:bg-white focus:outline-none focus:border-brand"
                        />
                      </div>
                    </td>

                    {/* Min / Max */}
                    <td className="py-3">
                      <div className="flex items-center gap-1 text-xs text-slate-500 font-semibold">
                        <input
                          type="number"
                          min="0"
                          value={comp.minQuantity}
                          onChange={(e) => handleUpdateComponent(comp.id, 'minQuantity', Math.max(0, Number(e.target.value)))}
                          className="w-11 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-900 focus:bg-white focus:outline-none"
                        />
                        <span>–</span>
                        <input
                          type="number"
                          min="1"
                          value={comp.maxQuantity}
                          onChange={(e) => handleUpdateComponent(comp.id, 'maxQuantity', Math.max(1, Number(e.target.value)))}
                          className="w-11 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-900 focus:bg-white focus:outline-none"
                        />
                      </div>
                    </td>

                    {/* Admin Item Price (Authoritative Single Source) */}
                    <td className="py-3">
                      <div className="relative w-24">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-emerald-700">₹</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={itemPrice}
                          onChange={(e) => {
                            const newPrice = Math.max(0, Number(e.target.value) || 0);
                            handleUpdateComponent(comp.id, 'price' as any, newPrice);
                            handleUpdateComponent(comp.id, 'customerRate', newPrice);
                            handleUpdateComponent(
                              comp.id,
                              'vendorRate',
                              Math.round(newPrice * (1 - (vendorDeductionPct / 100)) * 100) / 100
                            );
                          }}
                          className="w-full pl-6 pr-2 py-1 bg-emerald-50/60 border border-emerald-300 rounded-lg text-xs font-black text-emerald-950 focus:bg-white focus:outline-none focus:border-emerald-600 shadow-2xs"
                        />
                      </div>
                    </td>

                    {/* Derived Vendor Cost */}
                    <td className="py-3">
                      <div>
                        <div className="text-xs font-black text-slate-900">
                          ₹{derivedVendorCost.toFixed(2)}
                        </div>
                        <span className="inline-block mt-0.5 text-[9px] font-black px-1.5 py-0.2 rounded-full bg-amber-100 text-amber-800">
                          {100 - vendorDeductionPct}% payout
                        </span>
                      </div>
                    </td>

                    {/* Active Toggle */}
                    <td className="py-3 text-center">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(comp.id)}
                        className={`w-9 h-5 rounded-full p-0.5 transition-colors inline-flex items-center ${
                          comp.isActive ? 'bg-emerald-600 justify-end' : 'bg-slate-200 justify-start'
                        }`}
                      >
                        <span className="w-4 h-4 rounded-full bg-white shadow-xs" />
                      </button>
                    </td>

                    {/* Actions */}
                    <td className="py-3 pr-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleDeleteComponent(comp.id)}
                        title="Delete component"
                        className="w-7 h-7 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 inline-flex items-center justify-center transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Live Customization Simulator & Delta Preview ── */}
        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/80 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calculator className="w-4 h-4 text-brand" />
              <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider">
                Live Component Customization Simulator & Two-Way Delta Preview
              </h4>
            </div>
            <span className="text-[11px] font-bold text-slate-400">
              Simulating customer +/- thali choices
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {components.map((c) => {
              const qty = simulatedQuantities[c.id] ?? c.baseQuantity;
              const delta = qty - c.baseQuantity;

              return (
                <div key={c.id} className="bg-white p-2.5 rounded-xl border border-slate-200/70 space-y-1.5 text-center">
                  <div className="text-[11px] font-black text-slate-800 truncate">{c.name}</div>
                  <div className="text-[10px] text-slate-400 font-semibold">
                    Base: {c.baseQuantity} {c.unit}s
                  </div>
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setSimulatedQuantities((prev) => ({
                        ...prev,
                        [c.id]: Math.max(c.minQuantity, (prev[c.id] ?? c.baseQuantity) - 1),
                      }))}
                      className="w-6 h-6 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-800 font-black text-xs flex items-center justify-center"
                    >
                      –
                    </button>
                    <span className="text-sm font-black font-mono w-5">{qty}</span>
                    <button
                      type="button"
                      onClick={() => setSimulatedQuantities((prev) => ({
                        ...prev,
                        [c.id]: Math.min(c.maxQuantity, (prev[c.id] ?? c.baseQuantity) + 1),
                      }))}
                      className="w-6 h-6 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-800 font-black text-xs flex items-center justify-center"
                    >
                      +
                    </button>
                  </div>
                  <div className="text-[10px] font-bold">
                    {delta > 0 && <span className="text-emerald-700">+{delta} item</span>}
                    {delta < 0 && <span className="text-rose-600">{delta} item</span>}
                    {delta === 0 && <span className="text-slate-400">Default</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Simulation Output Pill */}
          <div className="bg-white p-3.5 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div>
              <span className="font-bold text-slate-500">Simulated Delta / Meal: </span>
              <span className={`font-black ${simulationDeltas.customerDeltaPerMeal >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                {simulationDeltas.customerDeltaPerMeal >= 0 ? `+₹${simulationDeltas.customerDeltaPerMeal}` : `−₹${Math.abs(simulationDeltas.customerDeltaPerMeal)}`}
              </span>
              <span className="text-slate-400 mx-1.5">•</span>
              <span className="font-bold text-slate-500">Vendor Payout Delta: </span>
              <span className="font-black text-slate-800">
                {simulationDeltas.vendorDeltaPerMeal >= 0 ? `+₹${simulationDeltas.vendorDeltaPerMeal}` : `−₹${Math.abs(simulationDeltas.vendorDeltaPerMeal)}`}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-500">Dabzzo Net Margin Delta:</span>
              <span className="text-xs font-black px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-800">
                ₹{simulationDeltas.customerDeltaPerMeal - simulationDeltas.vendorDeltaPerMeal} / meal
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
