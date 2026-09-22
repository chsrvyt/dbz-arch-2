import { doc, getDoc, setDoc, Timestamp } from 'firebase/firestore';
import { db } from '@dabzzo/shared-auth';
import { MealPricingConfig, PlanPricingType } from '@dabzzo/shared-types';

export const PRICING_COLLECTION = 'pricingConfig';

export const DEFAULT_WEEKLY_PRICING: MealPricingConfig = {
  id: 'weekly_pricing',
  type: 'weekly',
  pricePerMeal: 50,
  vendorCostPerMeal: 30,
  margin: 20,
};

export const DEFAULT_MONTHLY_PRICING: MealPricingConfig = {
  id: 'monthly_pricing',
  type: 'monthly',
  pricePerMeal: 1400,
  vendorCostPerMeal: 900,
  margin: 500,
};

/**
 * Fetch a specific meal pricing configuration (weekly or monthly) from Firestore.
 * Falls back to default initial values if not yet configured in database.
 */
export async function getPricingConfig(type: PlanPricingType): Promise<MealPricingConfig> {
  const docId = `${type}_pricing`;
  try {
    const snap = await getDoc(doc(db, PRICING_COLLECTION, docId));
    if (snap.exists()) {
      const data = snap.data();
      const price = typeof data.pricePerMeal === 'number' ? data.pricePerMeal : (type === 'weekly' ? 50 : 1400);
      const vendorCost = typeof data.vendorCostPerMeal === 'number' ? data.vendorCostPerMeal : (type === 'weekly' ? 30 : 900);
      const margin = typeof data.margin === 'number' ? data.margin : Math.round((price - vendorCost) * 100) / 100;

      return {
        id: snap.id,
        type: data.type || type,
        pricePerMeal: price,
        vendorCostPerMeal: vendorCost,
        margin,
        updatedAt: data.updatedAt,
        updatedBy: data.updatedBy,
      };
    }
  } catch (err) {
    console.warn(`[getPricingConfig] Failed to fetch ${type} pricing:`, err);
  }

  return type === 'weekly' ? { ...DEFAULT_WEEKLY_PRICING } : { ...DEFAULT_MONTHLY_PRICING };
}

/**
 * Fetch all pricing configs (both weekly and monthly) in parallel.
 */
export async function getAllPricingConfigs(): Promise<{
  weekly: MealPricingConfig;
  monthly: MealPricingConfig;
}> {
  const [weekly, monthly] = await Promise.all([
    getPricingConfig('weekly'),
    getPricingConfig('monthly'),
  ]);
  return { weekly, monthly };
}

/**
 * Save pricing configuration to Firestore for either 'weekly' or 'monthly'.
 * Calculates margin: pricePerMeal - vendorCostPerMeal.
 */
export async function savePricingConfig(
  type: PlanPricingType,
  pricePerMeal: number,
  vendorCostPerMeal: number,
  updatedBy: string = 'admin'
): Promise<MealPricingConfig> {
  const docId = `${type}_pricing`;
  const sanitizedPrice = Math.max(0, Math.round(Number(pricePerMeal) * 100) / 100);
  const sanitizedVendorCost = Math.max(0, Math.round(Number(vendorCostPerMeal) * 100) / 100);
  const margin = Math.round((sanitizedPrice - sanitizedVendorCost) * 100) / 100;

  const payload: MealPricingConfig = {
    id: docId,
    type,
    pricePerMeal: sanitizedPrice,
    vendorCostPerMeal: sanitizedVendorCost,
    margin,
    updatedAt: Timestamp.now(),
    updatedBy: updatedBy || 'admin',
  };

  const docRef = doc(db, PRICING_COLLECTION, docId);
  await setDoc(docRef, payload, { merge: true });

  return payload;
}

export interface CloudPricingConfigResponse {
  type: 'weekly' | 'monthly';
  pricePerMeal: number;
  vendorCostPerMeal: number;
  margin: number;
  lastUpdatedAt: any;
}

/**
 * Calls the "getPricingConfig" Cloud Function directly.
 * Used whenever a customer or admin builds a custom meal plan to fetch live validated rates.
 */
export async function fetchPricingConfigViaFunction(
  planType: PlanPricingType
): Promise<CloudPricingConfigResponse> {
  const { httpsCallable } = await import('firebase/functions');
  const { functions } = await import('@dabzzo/shared-auth');

  const getPricingFn = httpsCallable<{ planType: string }, CloudPricingConfigResponse>(
    functions,
    'getPricingConfig'
  );

  const result = await getPricingFn({ planType });
  return result.data;
}

export {
  calculateCustomPlanPrice,
  type CustomPlanType,
  type CustomPlanPattern,
  type CustomPlanPriceResult,
  type WeeklyPlanPattern,
  type MonthlyPlanPattern,
  type PricingAlgorithmSettings,
  DEFAULT_PRICING_ALGORITHM,
  calculateVendorPayout,
  calculateCustomerFoodRate,
  calculateCustomerMealPrice,
  computeAlgorithmicMealPricing,
  type AlgorithmicMealPricingResult,
} from '@dabzzo/shared-lib/pricing';

import {
  PricingAlgorithmSettings,
  DEFAULT_PRICING_ALGORITHM,
} from '@dabzzo/shared-lib/pricing';

export const PRICING_ALGORITHM_DOC = {
  collection: 'system_settings',
  docId: 'pricing_algorithm',
};

/**
 * Fetch pricing algorithm settings from system_settings/pricing_algorithm.
 */
export async function getPricingAlgorithmSettings(): Promise<PricingAlgorithmSettings> {
  try {
    const docRef = doc(db, PRICING_ALGORITHM_DOC.collection, PRICING_ALGORITHM_DOC.docId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data();
      return {
        deliveryChargePerMeal:
          typeof data.deliveryChargePerMeal === 'number'
            ? data.deliveryChargePerMeal
            : DEFAULT_PRICING_ALGORITHM.deliveryChargePerMeal,
        vendorMarginPercent:
          typeof data.vendorMarginPercent === 'number'
            ? data.vendorMarginPercent
            : DEFAULT_PRICING_ALGORITHM.vendorMarginPercent,
        platformMargins: {
          monthly:
            typeof data.platformMargins?.monthly === 'number'
              ? data.platformMargins.monthly
              : DEFAULT_PRICING_ALGORITHM.platformMargins.monthly,
          weekly:
            typeof data.platformMargins?.weekly === 'number'
              ? data.platformMargins.weekly
              : DEFAULT_PRICING_ALGORITHM.platformMargins.weekly,
          daily:
            typeof data.platformMargins?.daily === 'number'
              ? data.platformMargins.daily
              : DEFAULT_PRICING_ALGORITHM.platformMargins.daily,
        },
        roundingStrategy: data.roundingStrategy === 'ceil' ? 'ceil' : 'round',
        updatedAt: data.updatedAt,
        updatedBy: data.updatedBy,
      };
    }
  } catch (err) {
    console.warn('[getPricingAlgorithmSettings] Failed to fetch settings, using defaults:', err);
  }
  return { ...DEFAULT_PRICING_ALGORITHM };
}

/**
 * Save pricing algorithm settings to system_settings/pricing_algorithm.
 */
export async function savePricingAlgorithmSettings(
  settings: Partial<PricingAlgorithmSettings>,
  updatedBy: string = 'admin'
): Promise<PricingAlgorithmSettings> {
  const docRef = doc(db, PRICING_ALGORITHM_DOC.collection, PRICING_ALGORITHM_DOC.docId);
  const payload: PricingAlgorithmSettings = {
    deliveryChargePerMeal:
      typeof settings.deliveryChargePerMeal === 'number'
        ? settings.deliveryChargePerMeal
        : DEFAULT_PRICING_ALGORITHM.deliveryChargePerMeal,
    vendorMarginPercent:
      typeof settings.vendorMarginPercent === 'number'
        ? settings.vendorMarginPercent
        : DEFAULT_PRICING_ALGORITHM.vendorMarginPercent,
    platformMargins: {
      monthly:
        typeof settings.platformMargins?.monthly === 'number'
          ? settings.platformMargins.monthly
          : DEFAULT_PRICING_ALGORITHM.platformMargins.monthly,
      weekly:
        typeof settings.platformMargins?.weekly === 'number'
          ? settings.platformMargins.weekly
          : DEFAULT_PRICING_ALGORITHM.platformMargins.weekly,
      daily:
        typeof settings.platformMargins?.daily === 'number'
          ? settings.platformMargins.daily
          : DEFAULT_PRICING_ALGORITHM.platformMargins.daily,
    },
    roundingStrategy: settings.roundingStrategy === 'ceil' ? 'ceil' : 'round',
    updatedAt: Timestamp.now(),
    updatedBy: updatedBy || 'admin',
  };

  await setDoc(docRef, payload, { merge: true });
  return payload;
}

// ─── CANONICAL AUTHORITATIVE PRICING RULES (v2.0) ───────────────────────────
import {
  PricingRules,
  DEFAULT_PRICING_RULES,
  calculateMealPrice,
  calculateSubscriptionPrice,
  calculateStandardSubscriptionProduct,
  DEFAULT_ITEM_CATALOG,
  DEFAULT_STANDARD_MEAL,
  ItemDefinition,
  MarginRule,
  MarginRulesConfig,
  normalizeMarginRule,
  validateMarginRuleSet,
  resolveMarginRateForMeals,
  applyMarginRulesToRules,
} from '@dabzzo/shared-lib/pricingEngine';

export {
  type PricingRules,
  DEFAULT_PRICING_RULES,
  calculateMealPrice,
  calculateSubscriptionPrice,
  calculateStandardSubscriptionProduct,
  DEFAULT_ITEM_CATALOG,
  DEFAULT_STANDARD_MEAL,
  type ItemDefinition,
  type MarginRule,
  type MarginRulesConfig,
  normalizeMarginRule,
  validateMarginRuleSet,
  resolveMarginRateForMeals,
  applyMarginRulesToRules,
};

export const MARGIN_RULES_DOC = {
  collection: 'system_settings',
  docId: 'margin_rules',
};

/**
 * Fetch the dynamic margin-rule configuration from `system_settings/margin_rules`.
 * Returns a safe default (enabled, no rules) when the document does not exist.
 */
export async function getMarginRules(): Promise<MarginRulesConfig> {
  try {
    const docRef = doc(db, MARGIN_RULES_DOC.collection, MARGIN_RULES_DOC.docId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data();
      const rawRules = Array.isArray(data.rules) ? data.rules : [];
      const rules: MarginRule[] = [];
      rawRules.forEach((raw: any) => {
        const rule = normalizeMarginRule(raw);
        if (rule) rules.push(rule);
      });
      return {
        enabled: data.enabled !== false,
        rules,
        version: typeof data.version === 'string' ? data.version : '1.0.0',
        updatedAt: data.updatedAt,
        updatedBy: data.updatedBy,
      };
    }
  } catch (err) {
    console.warn('[getMarginRules] Failed to fetch margin rules, using none:', err);
  }
  return { enabled: true, rules: [] };
}

/**
 * Save the dynamic margin-rule set through the admin-only Cloud Function.
 * The full set is validated server-side (overlaps, gaps, percentage bounds);
 * invalid configurations are rejected.
 */
export async function saveMarginRulesAdmin(
  input: { enabled?: boolean; rules: MarginRule[] },
  updatedBy: string = 'admin'
): Promise<{ success: boolean; enabled: boolean; rules: MarginRule[] }> {
  const { httpsCallable } = await import('firebase/functions');
  const { functions } = await import('@dabzzo/shared-auth');
  const fn = httpsCallable<{ enabled?: boolean; rules: MarginRule[]; updatedBy: string }, any>(
    functions,
    'saveMarginRulesAdmin'
  );
  const result = await fn({
    enabled: input?.enabled !== false,
    rules: Array.isArray(input?.rules) ? input.rules : [],
    updatedBy,
  });
  return result.data;
}

export const PRICING_RULES_DOC = {
  collection: 'system_settings',
  docId: 'pricing_rules',
};

/**
 * Fetch authoritative central pricing rules from system_settings/pricing_rules.
 * Falls back to system_settings/pricing_algorithm or DEFAULT_PRICING_RULES.
 */
export async function getAuthoritativePricingRules(): Promise<PricingRules> {
  try {
    // 1. Try canonical pricing_rules doc
    const rulesSnap = await getDoc(doc(db, PRICING_RULES_DOC.collection, PRICING_RULES_DOC.docId));
    if (rulesSnap.exists()) {
      const d = rulesSnap.data();
      return {
        vendorDeduction:
          typeof d.vendorDeduction === 'number'
            ? d.vendorDeduction
            : (typeof d.vendorMarginPercent === 'number' ? d.vendorMarginPercent / 100 : DEFAULT_PRICING_RULES.vendorDeduction),
        margin:
          typeof d.margin === 'number'
            ? d.margin
            : (typeof d.platformMargin === 'number' ? d.platformMargin / 100 : DEFAULT_PRICING_RULES.margin),
        deliveryCharge:
          typeof d.deliveryCharge === 'number'
            ? d.deliveryCharge
            : (typeof d.deliveryChargePerMeal === 'number' ? d.deliveryChargePerMeal : DEFAULT_PRICING_RULES.deliveryCharge),
        paymentFee:
          typeof d.paymentFee === 'number'
            ? d.paymentFee
            : DEFAULT_PRICING_RULES.paymentFee,
        roundingStrategy: d.roundingStrategy === 'ceil' ? 'ceil' : d.roundingStrategy === 'round_integer' ? 'round_integer' : 'round',
        updatedAt: d.updatedAt,
        updatedBy: d.updatedBy,
        version: d.version || '2.0.0',
      };
    }

    // 2. Fallback to pricing_algorithm
    const algoSnap = await getDoc(doc(db, PRICING_ALGORITHM_DOC.collection, PRICING_ALGORITHM_DOC.docId));
    if (algoSnap.exists()) {
      const d = algoSnap.data();
      return {
        vendorDeduction:
          typeof d.vendorDeduction === 'number'
            ? d.vendorDeduction
            : DEFAULT_PRICING_RULES.vendorDeduction,
        margin:
          typeof d.margin === 'number'
            ? d.margin
            : DEFAULT_PRICING_RULES.margin,
        deliveryCharge:
          typeof d.deliveryChargePerMeal === 'number'
            ? d.deliveryChargePerMeal
            : (typeof d.deliveryCharge === 'number' ? d.deliveryCharge : DEFAULT_PRICING_RULES.deliveryCharge),
        paymentFee:
          typeof d.paymentFee === 'number'
            ? d.paymentFee
            : DEFAULT_PRICING_RULES.paymentFee,
        roundingStrategy: d.roundingStrategy === 'ceil' ? 'ceil' : 'round',
        updatedAt: d.updatedAt,
        updatedBy: d.updatedBy,
        version: '2.0.0',
      };
    }
  } catch (err) {
    console.warn('[getAuthoritativePricingRules] Failed to load rules, using defaults:', err);
  }

  return { ...DEFAULT_PRICING_RULES };
}

/**
 * Save authoritative central pricing rules to system_settings/pricing_rules
 * and mirror to system_settings/pricing_algorithm for seamless backwards compatibility.
 */
export async function saveAuthoritativePricingRules(
  rules: Partial<PricingRules>,
  updatedBy: string = 'admin'
): Promise<PricingRules> {
  const canonicalPayload: PricingRules = {
    vendorDeduction:
      typeof rules.vendorDeduction === 'number'
        ? rules.vendorDeduction
        : DEFAULT_PRICING_RULES.vendorDeduction,
    margin:
      typeof rules.margin === 'number'
        ? rules.margin
        : DEFAULT_PRICING_RULES.margin,
    deliveryCharge:
      typeof rules.deliveryCharge === 'number'
        ? rules.deliveryCharge
        : DEFAULT_PRICING_RULES.deliveryCharge,
    paymentFee:
      typeof rules.paymentFee === 'number'
        ? rules.paymentFee
        : DEFAULT_PRICING_RULES.paymentFee,
    roundingStrategy:
      rules.roundingStrategy === 'ceil'
        ? 'ceil'
        : rules.roundingStrategy === 'round_integer'
        ? 'round_integer'
        : 'round',
    updatedAt: Timestamp.now(),
    updatedBy: updatedBy || 'admin',
    version: '2.0.0',
  };

  const rulesRef = doc(db, PRICING_RULES_DOC.collection, PRICING_RULES_DOC.docId);
  const algoRef = doc(db, PRICING_ALGORITHM_DOC.collection, PRICING_ALGORITHM_DOC.docId);

  await Promise.all([
    setDoc(rulesRef, canonicalPayload, { merge: true }),
    setDoc(
      algoRef,
      {
        deliveryChargePerMeal: canonicalPayload.deliveryCharge,
        vendorMarginPercent: Math.round(canonicalPayload.vendorDeduction * 100),
        vendorDeduction: canonicalPayload.vendorDeduction,
        margin: canonicalPayload.margin,
        paymentFee: canonicalPayload.paymentFee,
        roundingStrategy: canonicalPayload.roundingStrategy,
        updatedAt: canonicalPayload.updatedAt,
        updatedBy: canonicalPayload.updatedBy,
        version: '2.0.0',
      },
      { merge: true }
    ),
  ]);

  return canonicalPayload;
}

