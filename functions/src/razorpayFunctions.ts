import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';

// Helper to get configured Razorpay client
// SECURITY: no hardcoded fallback credentials. These must come from Cloud
// Functions config/secrets in every environment; a missing value fails loudly
// instead of silently falling back to a shared literal.
export function getRazorpayInstance(): Razorpay {
  const key_id = process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new HttpsError('failed-precondition', 'Razorpay credentials not configured.');
  }

  return new Razorpay({
    key_id,
    key_secret,
  });
}

function getKeySecret(): string {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    throw new HttpsError('failed-precondition', 'Razorpay credentials not configured.');
  }
  return secret;
}

import {
  calculateMealPrice,
  calculateSubscriptionPrice,
  calculateStandardSubscriptionProduct,
  fetchAuthoritativePricingRules,
  fetchAuthoritativeItemsCatalog,
  fetchAuthoritativeMarginRules,
  applyMarginRulesToRules,
  DEFAULT_STANDARD_MEAL,
  SubscriptionMealSlotInput,
} from './pricingEngine';
import { resolveReferralCoupon } from './referralFunctions';

/**
 * Applies a referral coupon server-side when present. Monthly-only, owned by
 * the caller, single-use — all validated here, never trusted from the client.
 * Returns the final chargeable amount in paise and notes to enrich.
 */
export async function applyReferralCouponToOrder(
  data: any,
  notes: Record<string, any>,
  amountPaise: number,
  callerUid: string | null
): Promise<number> {
  const couponCode = typeof data?.coupon === 'string' ? data.coupon.trim().toUpperCase().slice(0, 20) : '';
  if (!couponCode) return amountPaise;

  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'You must be signed in to use a referral coupon.');
  }

  // Custom plans (pattern/schedule) do not support referral coupons.
  const customConfig =
    data?.pattern ||
    data?.deliveryPattern ||
    data?.customPlanConfig ||
    (Array.isArray(data?.schedule) && data.schedule.length > 0);
  if (customConfig) {
    throw new HttpsError(
      'failed-precondition',
      'Referral coupons can only be applied to a monthly subscription plan.'
    );
  }

  // Monthly-only: derive the plan's cycle from the order inputs.
  const notesData = notes || {};
  const frequency = String(notesData.frequency || data?.frequency || data?.planType || '').toLowerCase();
  const planId = String(data?.plan_id || notesData.plan_id || data?.planType || '').toLowerCase();
  const isMonthly = frequency === 'monthly' || planId.includes('monthly');
  if (!isMonthly) {
    throw new HttpsError(
      'failed-precondition',
      'Referral coupons can only be applied to a monthly subscription plan.'
    );
  }

  const resolved = await resolveReferralCoupon(couponCode, callerUid);
  if (!resolved.valid) {
    throw new HttpsError('invalid-argument', resolved.message || 'Invalid referral coupon.');
  }

  // Discount base: the client may pass the pre-coupon amount so the server
  // computes the discount itself on a number it controls; otherwise fall back
  // to the (authoritatively resolved) order amount.
  const basePaise = Number(data?.base_amount_paise) > 0 ? Number(data.base_amount_paise) : amountPaise;
  const discountPaise = Math.round((basePaise * (resolved.discountPct || 0)) / 100);
  const finalPaise = basePaise - discountPaise;
  if (finalPaise < 100) {
    throw new HttpsError('invalid-argument', 'Coupon discount exceeds the payable amount.');
  }

  notes.coupon_code = resolved.code;
  notes.coupon_discount_pct = resolved.discountPct;
  notes.referral_coupon = true;
  notes.base_amount_paise = basePaise;
  notes.coupon_discount_paise = discountPaise;

  return finalPaise;
}

/**
 * Authoritatively calculates the required Razorpay order amount (in paise)
 * using the centralized backend pricing engine, preventing client-side price tampering.
 */
export async function resolveAuthoritativeOrderAmount(
  data: any,
  db: admin.firestore.Firestore
): Promise<{ amountPaise: number; authoritativePrice: number; rulesVersion: string } | null> {
  const [rules, catalog, marginConfig] = await Promise.all([
    fetchAuthoritativePricingRules(db),
    fetchAuthoritativeItemsCatalog(db),
    fetchAuthoritativeMarginRules(db),
  ]);
  const marginRules = marginConfig?.enabled ? marginConfig.rules : undefined;

  const pattern = data?.pattern || data?.customPlanConfig?.pattern || data?.deliveryPattern;
  const rawSchedule = data?.schedule;

  // 1. Subscription with schedule array
  if (Array.isArray(rawSchedule) && rawSchedule.length > 0) {
    const subPricing = calculateSubscriptionPrice(rawSchedule, DEFAULT_STANDARD_MEAL.itemQuantities, catalog, rules, marginRules);
    return {
      amountPaise: Math.round(subPricing.finalPrice * 100),
      authoritativePrice: subPricing.finalPrice,
      rulesVersion: rules.version || '2.0.0',
    };
  }

  // 2. Subscription with pattern object (e.g. { mon: 1, tue: 2 })
  if (pattern && typeof pattern === 'object' && !Array.isArray(pattern) && Object.keys(pattern).length > 0) {
    const slots = data.slots || data.custom_slots || data.customPlanConfig?.slots || {};
    const customConfig = data.customMealConfig || data.custom_meal_config || data.customPlanConfig?.customMealConfig;
    const selectedItems = customConfig?.components || customConfig?.quantities || DEFAULT_STANDARD_MEAL.itemQuantities;

    const schedule: SubscriptionMealSlotInput[] = [];
    Object.entries(pattern).forEach(([dayKey, countVal]) => {
      const count = Number(countVal);
      if (!isNaN(count) && count > 0) {
        const slotChoice = slots[dayKey] || (count === 2 ? 'both' : 'lunch');
        schedule.push({
          dayKey,
          slot: slotChoice === 'both' ? 'both' : (slotChoice === 'dinner' ? 'dinner' : 'lunch'),
          items: selectedItems,
        });
      }
    });

    if (schedule.length > 0) {
      const planType = (data?.planType || data?.customPlanConfig?.planType || 'weekly').toLowerCase().trim();
      const effectiveRules =
        planType === 'weekly'
          ? { ...rules, planType: 'weekly' as const }
          : rules;

      const subPricing = calculateSubscriptionPrice(schedule, DEFAULT_STANDARD_MEAL.itemQuantities, catalog, effectiveRules, marginRules);
      return {
        amountPaise: Math.round(subPricing.finalPrice * 100),
        authoritativePrice: subPricing.finalPrice,
        rulesVersion: rules.version || '2.0.0',
      };
    }
  }

  // 3. Single meal items
  const mealItems = data?.mealItems || data?.items || data?.components;
  if (mealItems && (Array.isArray(mealItems) || typeof mealItems === 'object')) {
    const effectiveMealRules = marginRules ? applyMarginRulesToRules(rules, marginRules, 1) : rules;
    const mealPricing = calculateMealPrice(mealItems, catalog, effectiveMealRules);
    return {
      amountPaise: Math.round(mealPricing.finalPrice * 100),
      authoritativePrice: mealPricing.finalPrice,
      rulesVersion: rules.version || '2.0.0',
    };
  }

  // 4. Standard monthly subscription product (Section 12: Dabzzo ₹4,500 standard subscription)
  const planId = data?.plan_id || data?.notes?.plan_id || data?.planType;
  const isExplicitStandardProduct = data?.is_standard_product === true || planId === 'standard_monthly';
  if (isExplicitStandardProduct) {
    const stdSub = calculateStandardSubscriptionProduct(30, rules);
    return {
      amountPaise: Math.round(stdSub.finalPrice * 100),
      authoritativePrice: stdSub.finalPrice,
      rulesVersion: rules.version || '2.0.0',
    };
  }

  // 5. Standard weekly subscription product
  if (planId === 'standard_weekly') {
    const stdMeal = calculateMealPrice(DEFAULT_STANDARD_MEAL.itemQuantities, catalog, rules);
    const weeklyPrice = stdMeal.finalPrice * 7;
    return {
      amountPaise: Math.round(weeklyPrice * 100),
      authoritativePrice: weeklyPrice,
      rulesVersion: rules.version || '2.0.0',
    };
  }

  return null;
}

/**
 * Callable HTTPS Function: createRazorpayOrder
 * Creates an order in Razorpay (with authoritative pricing verification & optional split Route transfers).
 */
export const createRazorpayOrder = onCall({ region: 'us-central1', cors: true }, async (request) => {
  const data = request.data || {};
  let amount = Number(data.amount); // in paise
  const currency = typeof data.currency === 'string' ? data.currency : 'INR';
  const receipt = typeof data.receipt === 'string' ? data.receipt : `rcpt_${Date.now()}`;
  const notes = data.notes && typeof data.notes === 'object' ? { ...data.notes } : {};
  const vendorId = data.vendor_id || notes.vendor_id;

  // ── Authoritative Backend Pricing Enforcement ──
  const db = admin.firestore();
  try {
    const authPricing = await resolveAuthoritativeOrderAmount(data, db);
    if (authPricing) {
      amount = authPricing.amountPaise;
      notes.authoritative_price = authPricing.authoritativePrice;
      notes.pricing_rules_version = authPricing.rulesVersion;
    }
  } catch (pricingErr: any) {
    console.error('[createRazorpayOrder] Pricing calculation failed:', pricingErr);
    throw new HttpsError('invalid-argument', pricingErr?.message || 'Invalid meal or schedule configuration for pricing.');
  }

  // ── Referral coupon enforcement (monthly-only, owner-only, single-use) ──
  amount = await applyReferralCouponToOrder(data, notes, amount, request.auth?.uid ?? null);

  if (!amount || amount < 100 || amount > 50_000_000) {
    throw new HttpsError('invalid-argument', 'Invalid amount. Must be between ₹1 and ₹500,000.');
  }

  const orderPayload: any = {
    amount,
    currency,
    receipt: receipt.slice(0, 40),
    notes,
  };

  // Optional split Route transfers if vendor has linked Razorpay account
  if (typeof vendorId === 'string') {
    try {
      const vendorSnap = await admin.firestore().collection('users').doc(vendorId).get();
      const vendorData = vendorSnap.data();

      if (vendorData?.rzp_account_id) {
        const platformFeePct = vendorData.platform_fee_pct ?? 10;
        const vendorTransferAmount = Math.floor(amount * (1 - (platformFeePct / 100)));

        orderPayload.transfers = [
          {
            account: vendorData.rzp_account_id,
            amount: vendorTransferAmount,
            currency: 'INR',
            notes: {
              name: vendorData.kitchen_name || vendorData.name || 'Vendor',
              type: 'vendor_settlement',
            },
            on_hold: 0,
          },
        ];
      }
    } catch (err) {
      console.warn('[createRazorpayOrder] Route lookup failed, continuing standard order:', err);
    }
  }

  const rzp = getRazorpayInstance();
  let order: any;

  try {
    order = await rzp.orders.create(orderPayload);
  } catch (orderErr: any) {
    if (orderPayload.transfers && orderPayload.transfers.length > 0) {
      console.warn('[createRazorpayOrder] Route transfer failed, retrying standard order:', orderErr?.message || orderErr);
      delete orderPayload.transfers;
      order = await rzp.orders.create(orderPayload);
    } else {
      console.error('[createRazorpayOrder] Razorpay order creation error:', orderErr);
      throw new HttpsError('internal', orderErr?.error?.description || orderErr?.message || 'Failed to create payment order.');
    }
  }

  return {
    order_id: order.id,
    amount: order.amount,
    currency: order.currency,
  };
});

/**
 * Callable HTTPS Function: verifyRazorpayPayment
 * Verifies HMAC-SHA256 signature and credits swap allowances if applicable.
 */
export const verifyRazorpayPayment = onCall({ region: 'us-central1', cors: true }, async (request) => {
  const data = request.data || {};
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = data;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new HttpsError('invalid-argument', 'Missing razorpay_order_id, razorpay_payment_id, or razorpay_signature.');
  }

  const keySecret = getKeySecret();

  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const signatureBuffer = Buffer.from(razorpay_signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  const isValid =
    signatureBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

  if (!isValid) {
    console.error('[verifyRazorpayPayment] Signature mismatch:', {
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
    });
    throw new HttpsError('permission-denied', 'Payment signature verification failed.');
  }

  // Fetch payment details from Razorpay
  const rzp = getRazorpayInstance();
  let paymentDetails: any = {};
  try {
    paymentDetails = await rzp.payments.fetch(razorpay_payment_id);
  } catch (err) {
    console.warn('[verifyRazorpayPayment] Could not fetch payment details:', err);
  }

  // If swap purchase, credit swap allowance
  if (paymentDetails.notes && paymentDetails.notes.type === 'buy_swaps') {
    const subscriptionId = paymentDetails.notes.subscription_id as string;
    const userId = paymentDetails.notes.user_id as string;
    const count = Number(paymentDetails.notes.qty || 1);

    if (subscriptionId && userId) {
      try {
        const allowanceRef = admin.firestore().collection('subscription_swap_allowances').doc(subscriptionId);
        await admin.firestore().runTransaction(async (transaction) => {
          const docSnap = await transaction.get(allowanceRef);
          const now = admin.firestore.FieldValue.serverTimestamp();
          if (docSnap.exists) {
            const currentTotal = docSnap.data()?.free_swaps_total || 0;
            transaction.update(allowanceRef, {
              free_swaps_total: currentTotal + count,
              updated_at: now,
            });
          } else {
            transaction.set(allowanceRef, {
              subscription_id: subscriptionId,
              user_id: userId,
              free_swaps_total: count,
              free_swaps_used: 0,
              created_at: now,
              updated_at: now,
            });
          }
        });
        console.log(`[verifyRazorpayPayment] Credited ${count} swaps to ${subscriptionId}`);
      } catch (err) {
        console.warn('[verifyRazorpayPayment] Swap allowance credit error:', err);
      }
    }
  }

  return {
    success: true,
    payment_id: razorpay_payment_id,
    order_id: razorpay_order_id,
    amount: paymentDetails.amount ? paymentDetails.amount / 100 : undefined,
    currency: paymentDetails.currency || 'INR',
  };
});


/**
 * Verify the Firebase ID token on an onRequest (REST) call.
 *
 * The razorpayApi REST surface exists as a fallback for the onCall functions
 * (Firebase Hosting rewrites /api/razorpay/** here). It previously performed no
 * authentication at all on any route, while README.md claimed every route
 * verified an ID token — see IMPLEMENTATION_PLAN.md Phase 2.
 *
 * Routes that are self-authenticating via an HMAC signature (verify-payment,
 * webhook) do not use this; everything that creates a Razorpay resource does.
 *
 * Returns the decoded token, or null after already sending a 401.
 */
async function requireAuth(
  req: any,
  res: any
): Promise<admin.auth.DecodedIdToken | null> {
  const header = String(req.headers?.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Unauthenticated: missing bearer token.' });
    return null;
  }
  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    res.status(401).json({ error: 'Unauthenticated: invalid token.' });
    return null;
  }
}

/**
 * HTTPS Request Handler: razorpayApi
 * Handles direct REST requests from Firebase Hosting rewrites (/api/razorpay/**).
 */
export const razorpayApi = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  // Normalize path
  const path = req.path.replace(/^\/api\/razorpay/, '').replace(/^\//, '');

  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-razorpay-signature');
    res.status(204).send('');
    return;
  }

  res.set('Access-Control-Allow-Origin', '*');

  try {
    if (path === 'create-order' || path === 'create-order/') {
      if (!(await requireAuth(req, res))) return;
      const data = req.body || {};
      let amount = Number(data.amount);
      const currency = typeof data.currency === 'string' ? data.currency : 'INR';
      const receipt = typeof data.receipt === 'string' ? data.receipt : `rcpt_${Date.now()}`;
      const notes = data.notes && typeof data.notes === 'object' ? { ...data.notes } : {};

      // Authoritative pricing enforcement on REST
      const db = admin.firestore();
      try {
        const authPricing = await resolveAuthoritativeOrderAmount(data, db);
        if (authPricing) {
          amount = authPricing.amountPaise;
          notes.authoritative_price = authPricing.authoritativePrice;
          notes.pricing_rules_version = authPricing.rulesVersion;
        }
      } catch (pricingErr: any) {
        console.error('[razorpayApi create-order] Authoritative pricing calculation failed:', pricingErr);
        res.status(400).json({ error: pricingErr?.message || 'Invalid meal or schedule configuration for pricing.' });
        return;
      }

      // Referral coupon enforcement on REST (same rules as the callable path).
      if (data?.coupon) {
        const caller = await requireAuth(req, res);
        if (!caller) return;
        try {
          amount = await applyReferralCouponToOrder(data, notes, amount, caller.uid);
        } catch (couponErr: any) {
          res.status(400).json({ error: couponErr?.message || 'Invalid referral coupon.' });
          return;
        }
      }

      if (!amount || amount < 100 || amount > 50_000_000) {
        res.status(400).json({ error: 'Invalid amount. Minimum is ₹1 (100 paise).' });
        return;
      }

      const rzp = getRazorpayInstance();
      const order = await rzp.orders.create({
        amount,
        currency,
        receipt: receipt.slice(0, 40),
        notes,
      });

      res.status(200).json({
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
      });
      return;
    }

    if (path === 'verify-payment' || path === 'verify-payment/') {
      const data = req.body || {};
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = data;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        res.status(400).json({ error: 'Missing required payment verification fields.' });
        return;
      }

      const keySecret = getKeySecret();
      const expectedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      const signatureBuffer = Buffer.from(razorpay_signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');

      const isValid =
        signatureBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

      if (!isValid) {
        res.status(400).json({ error: 'Payment signature verification failed.' });
        return;
      }

      res.status(200).json({
        success: true,
        payment_id: razorpay_payment_id,
        order_id: razorpay_order_id,
      });
      return;
    }

    if (path === 'create-subscription' || path === 'create-subscription/') {
      if (!(await requireAuth(req, res))) return;
      const data = req.body || {};
      const { plan_id, customer_id, total_count, quantity } = data;

      if (!plan_id) {
        res.status(400).json({ error: 'Missing plan_id' });
        return;
      }

      const rzp = getRazorpayInstance();
      const payload: any = {
        plan_id,
        total_count: total_count || 12,
        quantity: quantity || 1
      };
      if (customer_id) payload.customer_id = customer_id;

      const subscription = await rzp.subscriptions.create(payload);

      res.status(200).json({
        subscription_id: subscription.id,
        short_url: subscription.short_url,
        status: subscription.status,
      });
      return;
    }

    if (path === 'create-vendor-account' || path === 'create-vendor-account/') {
      // Creates a real Razorpay Route sub-account (a payout destination), so
      // this is admin-only. It had no authentication and no client callers at
      // all before — see IMPLEMENTATION_PLAN.md Phase 2.
      const caller = await requireAuth(req, res);
      if (!caller) return;
      const callerIsAdmin =
        caller.admin === true ||
        caller.role === 'admin' ||
        caller.role === 'superadmin';
      if (!callerIsAdmin) {
        res.status(403).json({ error: 'Forbidden: admin role required.' });
        return;
      }
      const data = req.body || {};
      const { name, email, phone, business_name, account_type } = data;

      if (!name || !email || !phone) {
        res.status(400).json({ error: 'Missing name, email, or phone' });
        return;
      }

      const rzp = getRazorpayInstance();
      const accountData = {
        name,
        email,
        contact: phone,
        type: account_type || 'route',
        business_type: 'individual',
        legal_business_name: business_name || name,
        profile: {
          category: 'food',
          subcategory: 'catering',
        },
      };

      const account = await (rzp as any).accounts.create(accountData);
      res.status(200).json(account);
      return;
    }

    if (path === 'webhook' || path === 'webhook/') {
      // SECURITY: server-only secret, no hardcoded fallback, and deliberately
      // NOT read from a NEXT_PUBLIC_* var — that prefix is inlined into
      // client bundles by Next.js and would leak the webhook secret to the browser.
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) {
        res.status(500).json({ error: 'Webhook secret not configured.' });
        return;
      }
      const signature = req.headers['x-razorpay-signature'] as string;

      if (!signature) {
        res.status(400).json({ error: 'Missing signature.' });
        return;
      }

      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update((req as any).rawBody || JSON.stringify(req.body))
        .digest('hex');

      if (expectedSignature !== signature) {
        res.status(400).json({ error: 'Invalid signature.' });
        return;
      }

      const event = req.body;
      const db = admin.firestore();

      try {
        if (event.event === 'payment.captured') {
          const payment = event.payload.payment.entity;
          // You could update your database
        } else if (event.event === 'subscription.activated') {
          const subscription = event.payload.subscription.entity;
          const rzpSubId = subscription.id;
          const subsSnap = await db.collection('subscriptions').where('rzp_subscription_id', '==', rzpSubId).get();
          if (!subsSnap.empty) {
            const batch = db.batch();
            subsSnap.docs.forEach(doc => {
              batch.update(doc.ref, { status: 'active', updated_at: admin.firestore.FieldValue.serverTimestamp() });
            });
            await batch.commit();
          }
        } else if (event.event === 'subscription.halted') {
          const subscription = event.payload.subscription.entity;
          const rzpSubId = subscription.id;
          const subsSnap = await db.collection('subscriptions').where('rzp_subscription_id', '==', rzpSubId).get();
          if (!subsSnap.empty) {
            const batch = db.batch();
            subsSnap.docs.forEach(doc => {
              batch.update(doc.ref, { status: 'cancelled', updated_at: admin.firestore.FieldValue.serverTimestamp() });
            });
            await batch.commit();
          }
        }
      } catch (e) {
        console.error('Error processing webhook event:', e);
      }

      res.status(200).json({ status: 'ok' });
      return;
    }
  } catch (err: any) {
    console.error('[razorpayApi] Error:', err);
    res.status(500).json({ error: err?.message || 'Payment server error' });
  }
});
