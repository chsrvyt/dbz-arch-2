import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import {
  calculateMealPrice,
  calculateSubscriptionPrice,
  calculateStandardSubscriptionProduct,
  fetchAuthoritativePricingRules,
  fetchAuthoritativeItemsCatalog,
  fetchAuthoritativeMarginRules,
  DEFAULT_PRICING_RULES,
  DEFAULT_ITEM_CATALOG,
  DEFAULT_STANDARD_MEAL,
  PricingRules,
  ItemDefinition,
  MealPricingBreakdown,
  SubscriptionPricingBreakdown,
  SubscriptionMealSlotInput,
  PricingSnapshot,
  MarginRule,
  MarginRulesConfig,
  normalizeMarginRule,
  validateMarginRuleSet,
  applyMarginRulesToRules,
  resolveMarginRateForMeals,
  applyRounding,
} from './pricingEngine';
import { writeAuditLog } from './auditUtils';
import { publishEvent } from './utils/events';

export interface GetPricingConfigRequest {
  planType: 'weekly' | 'monthly';
}

export interface GetPricingConfigResponse {
  type: 'weekly' | 'monthly';
  pricePerMeal: number;
  vendorCostPerMeal: number;
  margin: number;
  deliveryCharge: number;
  paymentFee: number;
  subtotal: number;
  itemTotal: number;
  pricingRules: PricingRules;
  marginRules?: MarginRulesConfig | null;
  standardMeal: MealPricingBreakdown;
  itemsCatalog: ItemDefinition[];
  lastUpdatedAt: admin.firestore.Timestamp | any;
}

/**
 * Cloud Function: getPricingConfig
 *
 * Authoritatively fetches current meal pricing configuration derived from
 * the Central Pricing Engine.
 */
export const getPricingConfig = functions.https.onCall(
  async (data: any): Promise<GetPricingConfigResponse> => {
    const rawPlanType = data?.planType || data?.type;
    const normalizedPlanType =
      rawPlanType && typeof rawPlanType === 'string'
        ? (rawPlanType.trim().toLowerCase() as 'weekly' | 'monthly')
        : 'weekly';

    const db = admin.firestore();

    try {
      const [pricingRules, itemsCatalog, marginConfig] = await Promise.all([
        fetchAuthoritativePricingRules(db),
        fetchAuthoritativeItemsCatalog(db),
        fetchAuthoritativeMarginRules(db),
      ]);

      // Calculate the standard meal breakdown authoritatively (with weekly plan formula if weekly).
      // Dynamic margin tiers are applied to the standard single-meal preview (1 meal).
      const rawEffectiveRules: PricingRules =
        normalizedPlanType === 'weekly'
          ? { ...pricingRules, planType: 'weekly' }
          : pricingRules;
      const effectiveRules: PricingRules = marginConfig?.enabled
        ? applyMarginRulesToRules(rawEffectiveRules, marginConfig.rules, 1)
        : rawEffectiveRules;

      const standardMeal = calculateMealPrice(
        DEFAULT_STANDARD_MEAL.itemQuantities,
        itemsCatalog,
        effectiveRules
      );

      return {
        type: normalizedPlanType,
        pricePerMeal: standardMeal.finalPrice,
        vendorCostPerMeal: standardMeal.vendorCost,
        margin: standardMeal.margin,
        deliveryCharge: standardMeal.deliveryCharge,
        paymentFee: standardMeal.paymentFee,
        subtotal: standardMeal.subtotal,
        itemTotal: standardMeal.itemTotal,
        pricingRules: effectiveRules,
        marginRules: marginConfig,
        standardMeal,
        itemsCatalog,
        lastUpdatedAt: pricingRules.updatedAt || admin.firestore.Timestamp.now(),
      };
    } catch (error: any) {
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      console.error('[getPricingConfig] Internal error fetching pricing config:', error);
      throw new functions.https.HttpsError('internal', 'Failed to fetch pricing configuration.');
    }
  }
);

/**
 * Cloud Function: calculatePricingPreview
 *
 * Allows User, Admin, and Vendor panels to query the Authoritative Backend Pricing Engine
 * for any meal or subscription schedule preview.
 *
 * Input:
 *   - mealItems?: Record<string, number> | Array<{ id: string; quantity: number }>
 *   - schedule?: SubscriptionMealSlotInput[]
 *   - pattern?: Record<string, number>
 *   - slots?: Record<string, 'lunch' | 'dinner' | 'both'>
 *   - customMealConfig?: { components?: Record<string, number> }
 */
export const calculatePricingPreview = functions.https.onCall(
  async (data: any) => {
    const db = admin.firestore();

    try {
      const [rules, catalog, marginConfig] = await Promise.all([
        fetchAuthoritativePricingRules(db),
        fetchAuthoritativeItemsCatalog(db),
        fetchAuthoritativeMarginRules(db),
      ]);

      const marginRules = marginConfig?.enabled ? marginConfig.rules : undefined;

      // 1. Single meal preview
      if (data?.mealItems || data?.items || data?.components) {
        const rawItems = data.mealItems || data.items || data.components;
        const effectiveMealRules = marginRules
          ? applyMarginRulesToRules(rules, marginRules, 1)
          : rules;
        const breakdown = calculateMealPrice(rawItems, catalog, effectiveMealRules);
        return {
          success: true,
          mode: 'meal',
          breakdown,
          rules: effectiveMealRules,
          marginRules: marginConfig,
        };
      }

      // 2. Subscription schedule preview
      const schedule: SubscriptionMealSlotInput[] = [];

      if (Array.isArray(data?.schedule)) {
        schedule.push(...data.schedule);
      } else if (data?.pattern && typeof data.pattern === 'object') {
        const pattern = data.pattern;
        const slots = data.slots || {};
        const mealItems =
          data.customMealConfig?.components ||
          data.customMealConfig?.quantities ||
          DEFAULT_STANDARD_MEAL.itemQuantities;

        Object.entries(pattern).forEach(([dayKey, countVal]) => {
          const count = Number(countVal);
          if (isNaN(count) || count <= 0) return;

          const slotChoice = slots[dayKey] || (count === 2 ? 'both' : 'lunch');
          schedule.push({
            dayKey,
            slot: slotChoice,
            items: mealItems,
          });
        });
      }

      if (schedule.length > 0) {
        const subPricing = calculateSubscriptionPrice(
          schedule,
          DEFAULT_STANDARD_MEAL.itemQuantities,
          catalog,
          rules,
          marginRules
        );
        return {
          success: true,
          mode: 'subscription',
          subPricing,
          rules,
          marginRules: marginConfig,
        };
      }

      // 3. Fallback: Standard meal preview
      const effectiveMealRules = marginRules
        ? applyMarginRulesToRules(rules, marginRules, 1)
        : rules;
      const standardBreakdown = calculateMealPrice(
        DEFAULT_STANDARD_MEAL.itemQuantities,
        catalog,
        effectiveMealRules
      );
      return {
        success: true,
        mode: 'standard',
        breakdown: standardBreakdown,
        rules: effectiveMealRules,
        marginRules: marginConfig,
      };
    } catch (err: any) {
      console.error('[calculatePricingPreview] Error:', err);
      throw new functions.https.HttpsError('invalid-argument', err?.message || 'Failed to calculate pricing preview.');
    }
  }
);

export interface CreateCustomPlanSubscriptionRequest {
  userId: string;
  planType: 'weekly' | 'monthly';
  pattern: Record<string, any>;
  totalMeals?: number;
  totalPrice?: number;
  planStartDate?: any;
  vendorId?: string;
  paymentId?: string;
  razorpayOrderId?: string;
  customMealConfig?: any;
  custom_meal_config?: any;
  custom_slots?: Record<string, string>;
  customSlots?: Record<string, string>;
  meal_components?: string[];
  metadata?: Record<string, any>;
}

export interface CreateCustomPlanSubscriptionResponse {
  success: boolean;
  subscriptionId: string;
  confirmation: boolean;
  message: string;
  finalPrice: number;
  pricingSnapshot: PricingSnapshot;
  subscription: {
    id: string;
    userId: string;
    subscriptionType: 'custom_weekly' | 'custom_monthly';
    totalMeals: number;
    totalPrice: number;
    pricePerMeal: number;
    status: string;
    billingCycle: 'weekly' | 'monthly';
    startDate: any;
    nextBillingDate: any;
    deliveryPattern: Record<string, any>;
    isCustomPlan: boolean;
    deliveryStatus: string;
  };
}

/**
 * Cloud Function: createCustomPlanSubscription
 *
 * Authoritatively calculates price on backend using PricingEngine,
 * records the complete auditable pricing snapshot, and provisions the subscription.
 */
export const createCustomPlanSubscription = functions.https.onCall(
  async (
    data: CreateCustomPlanSubscriptionRequest,
    context?: functions.https.CallableContext
  ): Promise<CreateCustomPlanSubscriptionResponse> => {
    const db = admin.firestore();

    // ── 1. Input Extraction & Validation ──────────────────────────────────────
    const rawUserId = data?.userId || context?.auth?.uid;
    if (!rawUserId || typeof rawUserId !== 'string' || !rawUserId.trim()) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'userId is required and must be a valid string.'
      );
    }
    const userId = rawUserId.trim();

    const rawPlanType = data?.planType;
    if (!rawPlanType || typeof rawPlanType !== 'string') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'planType is required and must be either "weekly" or "monthly".'
      );
    }
    const planType = rawPlanType.trim().toLowerCase() as 'weekly' | 'monthly';
    if (planType !== 'weekly' && planType !== 'monthly') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Invalid planType. Expected "weekly" or "monthly".'
      );
    }

    let pattern = data?.pattern;
    if (Array.isArray(pattern)) {
      const converted: Record<string, number> = {};
      pattern.forEach((item: any) => {
        const key = item?.id || item?.dateKey || item?.shortDay || item?.day || item?.dateStr;
        const count = Number(item?.meals ?? item?.count ?? item?.quantity ?? item?.mealCount ?? 0);
        if (key && !isNaN(count)) {
          converted[key] = count;
        }
      });
      pattern = converted;
    }

    if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'pattern is required and must be an object mapping days/dates to meal counts.'
      );
    }

    // Validation: userId must exist in users collection
    const userDocSnap = await db.collection('users').doc(userId).get();
    if (!userDocSnap.exists) {
      throw new functions.https.HttpsError('not-found', `User with ID "${userId}" does not exist.`);
    }
    const userData = userDocSnap.data() || {};

    // ── 2. Authoritative Pricing Engine Calculation ───────────────────────────
    const [rules, catalog, marginConfig] = await Promise.all([
      fetchAuthoritativePricingRules(db),
      fetchAuthoritativeItemsCatalog(db),
      fetchAuthoritativeMarginRules(db),
    ]);

    const slots = data?.custom_slots || data?.customSlots || {};
    const customConfig = data?.customMealConfig || data?.custom_meal_config || null;
    const selectedItemQuantities: Record<string, number> =
      customConfig?.components || customConfig?.quantities || DEFAULT_STANDARD_MEAL.itemQuantities;

    // Build schedule
    const schedule: SubscriptionMealSlotInput[] = [];
    Object.entries(pattern).forEach(([dayKey, countVal]) => {
      const count = Number(countVal);
      if (isNaN(count) || count <= 0) return;

      const slotChoice = slots[dayKey] || (count === 2 ? 'both' : 'lunch');
      schedule.push({
        dayKey,
        slot: slotChoice === 'both' ? 'both' : (slotChoice === 'dinner' ? 'dinner' : 'lunch'),
        items: selectedItemQuantities,
      });
    });

    if (schedule.length === 0) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'PricingEngine Error: Subscription schedule must contain at least 1 meal.'
      );
    }

    // Authoritative calculation from single backend pricing engine.
    // Configuration-driven margin: tiers resolve by the subscription's total meal
    // count; the flat `rules.margin` applies when no tiers are configured.
    const effectiveRules: PricingRules =
      planType === 'weekly'
        ? { ...rules, planType: 'weekly' }
        : rules;
    const marginRules = marginConfig?.enabled ? marginConfig.rules : undefined;

    let subPricing: SubscriptionPricingBreakdown;
    try {
      subPricing = calculateSubscriptionPrice(
        schedule,
        DEFAULT_STANDARD_MEAL.itemQuantities,
        catalog,
        effectiveRules,
        marginRules
      );
    } catch (calcErr: any) {
      console.error('[createCustomPlanSubscription] Pricing error:', calcErr);
      throw new functions.https.HttpsError('invalid-argument', calcErr?.message || 'Pricing calculation failed.');
    }

    const authoritativeFinalPrice = subPricing.finalPrice;
    const authoritativeTotalMeals = subPricing.totalMeals;

    if (planType === 'monthly' && authoritativeTotalMeals < 30) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        `Monthly plans require a minimum of 30 meals (received ${authoritativeTotalMeals}).`
      );
    }

    const authoritativeVendorCost = subPricing.vendorCost;
    const authoritativePricePerMeal = applyRounding(authoritativeFinalPrice / authoritativeTotalMeals);

    // ── 3. Vendor Metadata Lookup ─────────────────────────────────────────────
    const vendorId = data?.vendorId || userData?.default_vendor_id || 'default_vendor';
    let vendorData: any = null;
    if (vendorId && vendorId !== 'default_vendor') {
      try {
        const vendorSnap = await db.collection('users').doc(vendorId).get();
        if (vendorSnap.exists) {
          vendorData = vendorSnap.data();
        }
      } catch (vErr) {
        console.warn('[createCustomPlanSubscription] Failed fetching vendor data:', vErr);
      }
    }

    // ── 4. Dates Calculation ──────────────────────────────────────────────────
    let startTimestamp: admin.firestore.Timestamp;
    const rawStartDate = data?.planStartDate;
    if (rawStartDate instanceof admin.firestore.Timestamp) {
      startTimestamp = rawStartDate;
    } else if (typeof rawStartDate === 'number') {
      startTimestamp = admin.firestore.Timestamp.fromMillis(rawStartDate);
    } else if (rawStartDate) {
      const parsedDate = new Date(rawStartDate);
      startTimestamp = isNaN(parsedDate.getTime())
        ? admin.firestore.Timestamp.now()
        : admin.firestore.Timestamp.fromDate(parsedDate);
    } else {
      startTimestamp = admin.firestore.Timestamp.now();
    }

    const nextBillingDateObj = startTimestamp.toDate();
    if (planType === 'weekly') {
      nextBillingDateObj.setDate(nextBillingDateObj.getDate() + 7);
    } else {
      nextBillingDateObj.setMonth(nextBillingDateObj.getMonth() + 1);
    }
    const nextBillingDate = admin.firestore.Timestamp.fromDate(nextBillingDateObj);
    const now = admin.firestore.Timestamp.now();

    // ── 5. Create Subscription in Firestore with Pricing Snapshot ─────────────
    const batch = db.batch();
    const paymentId = data?.paymentId || null;
    const razorpayOrderId = data?.razorpayOrderId || null;

    // ── Payment Verification & Admin Price Change Detection ──
    const clientSuppliedPrice = Number(data?.totalPrice);
    if (!isNaN(clientSuppliedPrice) && clientSuppliedPrice > 0) {
      if (Math.abs(clientSuppliedPrice - authoritativeFinalPrice) > 1) {
        console.warn(
          `[createCustomPlanSubscription] Pricing discrepancy: client submitted ₹${clientSuppliedPrice}, authoritative is ₹${authoritativeFinalPrice}`
        );
      }
    }

    if (razorpayOrderId && !razorpayOrderId.startsWith('order_sim_') && !razorpayOrderId.startsWith('mock_')) {
      try {
        const { getRazorpayInstance } = await import('./razorpayFunctions');
        const rzp = getRazorpayInstance();
        const rzpOrder = await rzp.orders.fetch(razorpayOrderId);
        const expectedPaise = Math.round(authoritativeFinalPrice * 100);
        if (rzpOrder && typeof rzpOrder.amount === 'number' && Math.abs(rzpOrder.amount - expectedPaise) > 100) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `Payment amount mismatch: Razorpay order amount (₹${rzpOrder.amount / 100}) does not match authoritative price (₹${authoritativeFinalPrice}). Pricing configuration may have changed during checkout.`
          );
        }
      } catch (rzpErr: any) {
        if (rzpErr instanceof functions.https.HttpsError) throw rzpErr;
        console.warn('[createCustomPlanSubscription] Note on Razorpay order check:', rzpErr?.message || rzpErr);
      }
    }

    const manifestSummary = subPricing.snapshot.standardMealUnitSnapshot?.manifestSummary || 'Custom Thali';
    const subRef = db.collection('subscriptions').doc();
    const subscriptionType = planType === 'weekly' ? 'custom_weekly' : 'custom_monthly';

    const subscriptionDoc: Record<string, any> = {
      id: subRef.id,
      userId: userId,
      user_id: userId,
      vendor_id: vendorId,
      vendor_name: vendorData?.kitchen_name || vendorData?.name || '',
      subscriptionType: subscriptionType,
      plan_id: subscriptionType,
      customPlan: {
        pattern: pattern,
        totalMeals: authoritativeTotalMeals,
        totalPrice: authoritativeFinalPrice,
        pricePerMeal: authoritativePricePerMeal,
        createdAt: now,
      },
      status: 'active',
      billingCycle: planType,
      frequency: planType,
      nextBillingDate: nextBillingDate,
      next_billing_date: nextBillingDate,
      startDate: startTimestamp,
      start_date: startTimestamp,
      createdAt: now,
      created_at: now,

      // Authoritative Price Snapshot
      pricingSnapshot: subPricing.snapshot,
      pricing_snapshot: subPricing.snapshot,

      // Custom Meal Config & Manifest
      custom_meal_config: {
        components: selectedItemQuantities,
        manifestSummary,
        itemTotal: subPricing.itemTotal,
        vendorCost: subPricing.vendorCost,
        foodSellingPrice: subPricing.foodSellingPrice,
        deliveryCharge: subPricing.deliveryCharge,
        paymentFee: subPricing.paymentFee,
        finalPrice: authoritativeFinalPrice,
      },
      meal_components: [manifestSummary],
      effective_customer_price_per_meal: authoritativePricePerMeal,
      effective_vendor_cost_per_meal: applyRounding(authoritativeVendorCost / authoritativeTotalMeals),
      vendor_total_payable: authoritativeVendorCost,

      // Delivery pattern & status
      deliveryPattern: pattern,
      delivery_pattern: pattern,
      custom_schedule: pattern,
      custom_slots: slots,
      isCustomPlan: true,
      is_custom_plan: true,
      delivery_status: 'ready_for_delivery',
      ready_for_delivery: true,
      is_ready_for_delivery: true,

      // Payments
      total_price: authoritativeFinalPrice,
      paid_amount: authoritativeFinalPrice,
      price: authoritativeFinalPrice,
      payment_status: paymentId ? 'paid' : 'pending_payment',
      payment_id: paymentId,
      razorpay_order_id: razorpayOrderId,
    };

    if (data?.metadata && typeof data.metadata === 'object') {
      subscriptionDoc.metadata = data.metadata;
    }

    batch.set(subRef, subscriptionDoc);

    // ── 6. Link to Payments Record ────────────────────────────────────────────
    if (paymentId || razorpayOrderId) {
      const paymentDocRef = db.collection('payments').doc(paymentId || `pay_${subRef.id}`);
      batch.set(
        paymentDocRef,
        {
          subscription_id: subRef.id,
          user_id: userId,
          amount: authoritativeFinalPrice,
          currency: 'INR',
          status: paymentId ? 'captured' : 'created',
          razorpay_order_id: razorpayOrderId,
          razorpay_payment_id: paymentId,
          plan_type: subscriptionType,
          pricing_snapshot: subPricing.snapshot,
          created_at: now,
        },
        { merge: true }
      );
    }

    // ── 7. Vendor Payout Ledger Credit ────────────────────────────────────────
    if (vendorId && vendorId !== 'default_vendor') {
      const vendorPayoutRef = db.collection('vendor_payouts').doc();
      batch.set(vendorPayoutRef, {
        id: vendorPayoutRef.id,
        vendor_id: vendorId,
        vendor_name: vendorData?.kitchen_name || vendorData?.name || '',
        subscription_id: subRef.id,
        user_id: userId,
        user_name: userData?.name || '',
        amount: authoritativeVendorCost,
        cost_per_meal: applyRounding(authoritativeVendorCost / authoritativeTotalMeals),
        total_meals: authoritativeTotalMeals,
        source: 'custom_subscription',
        status: 'credited',
        reference_id: razorpayOrderId || paymentId || '',
        pricing_snapshot: subPricing.snapshot,
        manifest: manifestSummary,
        created_at: now,
      });

      // Increment vendor balance atomically
      const vendorDocRef = db.collection('users').doc(vendorId);
      batch.set(
        vendorDocRef,
        {
          total_earnings: admin.firestore.FieldValue.increment(authoritativeVendorCost),
          pending_payout: admin.firestore.FieldValue.increment(authoritativeVendorCost),
          last_payout_credit_at: now,
        },
        { merge: true }
      );
    }

    // ── 8. Customer Membership Update ─────────────────────────────────────────
    const customerDocRef = db.collection('users').doc(userId);
    batch.set(
      customerDocRef,
      {
        is_active_subscriber: true,
        membership_status: 'active',
        active_subscription_id: subRef.id,
        last_subscribed_at: now,
        updated_at: now,
      },
      { merge: true }
    );

    await batch.commit();

    // ── 9. Publish Order Event ────────────────────────────────────────────────
    try {
      await publishEvent(
        'order_confirmed',
        userId,
        'customer',
        `custom_plan_sub_${subRef.id}`,
        {
          subscriptionId: subRef.id,
          planType,
          totalMeals: authoritativeTotalMeals,
          totalPrice: authoritativeFinalPrice,
          deliveryStatus: 'ready_for_delivery',
          isCustomPlan: true,
        }
      );
    } catch (eventErr) {
      console.warn('[createCustomPlanSubscription] System event publish error (non-fatal):', eventErr);
    }

    return {
      success: true,
      subscriptionId: subRef.id,
      confirmation: true,
      message: `Custom ${planType} plan subscription created successfully with authoritative pricing snapshot.`,
      finalPrice: authoritativeFinalPrice,
      pricingSnapshot: subPricing.snapshot,
      subscription: {
        id: subRef.id,
        userId: userId,
        subscriptionType: subscriptionType,
        totalMeals: authoritativeTotalMeals,
        totalPrice: authoritativeFinalPrice,
        pricePerMeal: authoritativePricePerMeal,
        status: 'active',
        billingCycle: planType,
        startDate: startTimestamp,
        nextBillingDate: nextBillingDate,
        deliveryPattern: pattern,
        isCustomPlan: true,
        deliveryStatus: 'ready_for_delivery',
      },
    };
  }
);

/**
 * Cloud Function: savePricingRulesAdmin
 * Admin-only callable function to update global pricing rules in system_settings/pricing_rules.
 */
export const savePricingRulesAdmin = functions.https.onCall(
  async (data: any, context?: functions.https.CallableContext) => {
    // Admin check
    if (!context?.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated to save pricing rules.');
    }

    const db = admin.firestore();
    const userSnap = await db.collection('users').doc(context.auth.uid).get();
    const userRole = userSnap.data()?.role;
    if (context.auth.token?.role !== 'admin' && context.auth.token?.admin !== true && userRole !== 'admin') {
      throw new functions.https.HttpsError('permission-denied', 'Only administrators can modify pricing rules.');
    }

    const vendorDeduction = Number(data.vendorDeduction ?? 0.08);
    const margin = Number(data.margin ?? 0.13);
    const deliveryCharge = Math.max(0, Number(data.deliveryCharge ?? 11));
    const paymentFee = Number(data.paymentFee ?? 0.025);
    const roundingStrategy = data.roundingStrategy === 'ceil' ? 'ceil' : data.roundingStrategy === 'round_integer' ? 'round_integer' : 'round';

    if (vendorDeduction < 0 || vendorDeduction >= 1) {
      throw new functions.https.HttpsError('invalid-argument', 'Vendor deduction must be between 0% and 100%.');
    }
    if (margin < 0 || margin >= 1) {
      throw new functions.https.HttpsError('invalid-argument', 'Food margin must be between 0% and 100%.');
    }
    if (paymentFee < 0 || paymentFee >= 0.5) {
      throw new functions.https.HttpsError('invalid-argument', 'Payment fee must be between 0% and 50%.');
    }

    const updatedRules: PricingRules = {
      vendorDeduction,
      margin,
      deliveryCharge,
      paymentFee,
      roundingStrategy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: context.auth.uid,
      version: `2.${Date.now()}`,
    };

    const batch = db.batch();

    // Primary canonical document
    const rulesRef = db.collection('system_settings').doc('pricing_rules');
    batch.set(rulesRef, updatedRules, { merge: true });

    // Mirror to pricing_algorithm for backward compatibility
    const algoRef = db.collection('system_settings').doc('pricing_algorithm');
    batch.set(
      algoRef,
      {
        deliveryChargePerMeal: deliveryCharge,
        vendorMarginPercent: Math.round(vendorDeduction * 100),
        platformMargins: {
          daily: Math.round(margin * 100),
          weekly: Math.round(margin * 100),
          monthly: Math.round(margin * 100),
        },
        roundingStrategy,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: context.auth.uid,
      },
      { merge: true }
    );

    // Mirror to pricingConfig collection
    const weeklyConfigRef = db.collection('pricingConfig').doc('weekly_pricing');
    batch.set(weeklyConfigRef, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    // Append-only audit log
    const auditRef = db.collection('audit_logs').doc();
    batch.set(auditRef, {
      action: 'UPDATE_PRICING_RULES',
      actor: context.auth.uid,
      payload: updatedRules,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return {
      success: true,
      message: 'Global pricing rules updated successfully by Admin.',
      rules: updatedRules,
    };
  }
);

/**
 * Cloud Function: saveMarginRulesAdmin
 * Admin-only callable. Atomically replaces the dynamic margin-rule set stored at
 * `system_settings/margin_rules`. The whole set is validated (overlaps, gaps,
 * leading gap, unclosed tail, invalid percentages/ranges, duplicate ids) and
 * invalid configurations are rejected — the engine only ever reads a valid set.
 * Every successful change is recorded in the audit log.
 */
export const saveMarginRulesAdmin = functions.https.onCall(
  async (data: any, context?: functions.https.CallableContext) => {
    if (!context?.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated to save margin rules.');
    }

    const db = admin.firestore();
    const userSnap = await db.collection('users').doc(context.auth.uid).get();
    const userRole = userSnap.data()?.role;
    if (context.auth.token?.role !== 'admin' && context.auth.token?.admin !== true && userRole !== 'admin') {
      throw new functions.https.HttpsError('permission-denied', 'Only administrators can modify margin rules.');
    }

    const rawRules = data?.rules;
    if (!Array.isArray(rawRules)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'rules must be an array of margin rule objects.'
      );
    }

    const enabled = data?.enabled !== false;
    const normalized: MarginRule[] = [];
    const invalid: string[] = [];
    rawRules.forEach((raw: any, idx: number) => {
      const rule = normalizeMarginRule(raw);
      if (!rule) {
        invalid.push(`Rule at index ${idx} is malformed (minMeals/maxMeals/marginRate range invalid).`);
        return;
      }
      normalized.push(rule);
    });

    const validationErrors = validateMarginRuleSet(normalized);
    const allErrors = [...invalid, ...validationErrors];
    if (allErrors.length > 0) {
      throw new functions.https.HttpsError('invalid-argument', allErrors.join(' '));
    }

    const docRef = db.collection('system_settings').doc('margin_rules');
    await docRef.set(
      {
        enabled,
        rules: normalized,
        version: `1.${Date.now()}`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: context.auth.uid,
      },
      { merge: true }
    );

    await writeAuditLog(
      {
        action: 'UPDATE_MARGIN_RULES',
        actorUid: context.auth.uid,
        targetType: 'system_settings',
        targetId: 'margin_rules',
        result: 'success',
        message: `Saved ${normalized.length} dynamic margin rule(s)${enabled ? '' : ' (disabled)'}.`,
        metadata: {
          enabled,
          ruleIds: normalized.map((r) => r.id),
          rules: normalized,
        },
      },
      db
    );

    return {
      success: true,
      message: `Dynamic margin rules updated successfully by Admin (${normalized.length} tier${normalized.length === 1 ? '' : 's'}${enabled ? '' : ', disabled'}).`,
      enabled,
      rules: normalized,
    };
  }
);

/**
 * Cloud Function: saveMealItemsAdmin
 * Admin-only callable function to update item prices and catalog in system_settings/meal_components.
 */
export const saveMealItemsAdmin = functions.https.onCall(
  async (data: any, context?: functions.https.CallableContext) => {
    if (!context?.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated to save items.');
    }

    const db = admin.firestore();
    const userSnap = await db.collection('users').doc(context.auth.uid).get();
    const userRole = userSnap.data()?.role;
    if (context.auth.token?.role !== 'admin' && context.auth.token?.admin !== true && userRole !== 'admin') {
      throw new functions.https.HttpsError('permission-denied', 'Only administrators can modify items and item prices.');
    }

    const rawItems = data?.items || data?.components;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'items must be a non-empty array.');
    }

    const validatedItems: ItemDefinition[] = rawItems.map((item: any) => {
      if (!item.name || typeof item.name !== 'string' || !item.name.trim()) {
        throw new functions.https.HttpsError('invalid-argument', 'Each item must have a valid name.');
      }
      const price = Number(item.price ?? item.customerRate ?? 0);
      if (isNaN(price) || price < 0) {
        throw new functions.https.HttpsError('invalid-argument', `Item "${item.name}" has invalid price: ${item.price}`);
      }

      return {
        id: (item.id || item.name.toLowerCase().replace(/[^a-z0-9]/g, '_')).trim(),
        name: item.name.trim(),
        price,
        unit: item.unit || 'portion',
        category: item.category || 'staple',
        isActive: item.isActive !== false,
        minQuantity: Math.max(0, Number(item.minQuantity ?? 0)),
        maxQuantity: Math.max(1, Number(item.maxQuantity ?? 10)),
        baseQuantity: Math.max(0, Number(item.baseQuantity ?? 0)),
        rawCost: Math.max(0, Number(item.rawCost ?? 0)),
        description: item.description || '',
      };
    });

    const batch = db.batch();
    const catalogRef = db.collection('system_settings').doc('meal_components');
    batch.set(
      catalogRef,
      {
        components: validatedItems,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: context.auth.uid,
      },
      { merge: true }
    );

    const auditRef = db.collection('audit_logs').doc();
    batch.set(auditRef, {
      action: 'UPDATE_MEAL_ITEMS_CATALOG',
      actor: context.auth.uid,
      itemsCount: validatedItems.length,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return {
      success: true,
      message: 'Meal items and prices updated successfully by Admin.',
      items: validatedItems,
    };
  }
);

export * from './utils/pricingUtils';
export {
  getCustomPlanStats,
  activateExternalSubscriptionAdmin,
} from './pricingFunctionsLegacy';
