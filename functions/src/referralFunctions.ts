/**
 * REFERRAL SYSTEM — server side.
 *
 * All referral state is derived here or in referralTriggers.ts. The client
 * never sends counts, discount values or statuses; it only sends raw codes and
 * milestone ids, and the server decides everything.
 *
 * Milestone tiers are duplicated here (functions is a self-contained package;
 * it also duplicates pricingEngine). Keep in sync with
 * packages/shared-lib/src/referrals.ts (the client copy of the tiers).
 *
 * Collections:
 *   referral_codes/{code}                 UNIQUE code registry -> {user_id}
 *   referrals/ref_{code}_{userId}         one attribution record per referree
 *   referral_milestone_claims/{uid}_{id}  UNIQUE(user_id, milestone_id)
 *   discount_codes/{coupon}               coupon doc (doc id = coupon code)
 */
import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';

// ─── Milestone tiers (must mirror packages/shared-lib/src/referrals.ts) ────
interface FirmMilestone {
  id: string;
  threshold: number;
  discount: number;
}
const REFERRAL_MILESTONES: FirmMilestone[] = [
  { id: '3', threshold: 3, discount: 10 },
  { id: '5', threshold: 5, discount: 15 },
  { id: '7', threshold: 7, discount: 20 },
];

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function randomCode(length: number): string {
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

export function generateReferralCodeForFunctions(): string {
  return randomCode(CODE_LENGTH);
}

export function generateCouponCodeForFunctions(discount: number): string {
  return `REF${discount}-${randomCode(6)}`;
}

// ─── Shared read helpers (exported for triggers & tests) ───────────────────

function db(): admin.firestore.Firestore {
  return admin.firestore();
}

/** Server-side count of completed referrals credited to a user. */
export async function getCompletedReferralCount(userId: string): Promise<number> {
  const snap = await db()
    .collection('referrals')
    .where('referrer_user_id', '==', userId)
    .where('status', '==', 'completed')
    .get();
  return snap.size;
}

/** Looks up a referral coupon by code (doc id == code). */
export async function getReferralCouponDoc(code: string) {
  const snap = await db().collection('discount_codes').doc(code).get();
  return snap.exists ? snap : null;
}

/**
 * Validates a referral coupon for a given caller. Returns the discount percent
 * or a human-readable reason. Used by validateReferralCoupon (UI feedback) and
 * createRazorpayOrder (authoritative checkout gate).
 */
export async function resolveReferralCoupon(
  code: string,
  callerUid: string
): Promise<{ valid: boolean; code: string; discountPct?: number; message?: string }> {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) {
    return { valid: false, code: normalized, message: 'Please enter a coupon code.' };
  }
  const couponSnap = await getReferralCouponDoc(normalized);
  const data = couponSnap?.data?.();
  if (!couponSnap || !couponSnap.exists || data?.source !== 'referral') {
    return { valid: false, code: normalized, message: 'This is not a valid referral coupon.' };
  }
  if (data.status !== 'available') {
    return { valid: false, code: normalized, message: 'This coupon has already been used.' };
  }
  if (data.user_id && data.user_id !== callerUid) {
    return { valid: false, code: normalized, message: 'This coupon belongs to a different account.' };
  }
  const pct = Number(data.discount_pct);
  if (!pct || pct <= 0) {
    return { valid: false, code: normalized, message: 'This coupon has no discount value.' };
  }
  return { valid: true, code: normalized, discountPct: pct };
}

/** Ensures a user has a referral code (allocates one server-side if missing). */
export async function ensureReferralCodeForFunctions(userId: string): Promise<string> {
  const userSnap = await db().collection('users').doc(userId).get();
  const existing = userSnap.data()?.referral_code;
  if (existing) return existing;

  let code = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateReferralCodeForFunctions();
    try {
      // set without merge -> fails (throws) if the doc already exists, which
      // keeps the registry honest under concurrent allocation.
      await db().collection('referral_codes').doc(candidate).set({
        user_id: userId,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      code = candidate;
      break;
    } catch {
      // collision — try another code
    }
  }

  if (!code) {
    throw new functions.https.HttpsError('internal', 'Could not allocate a unique referral code.');
  }

  await db().collection('users').doc(userId).set({ referral_code: code }, { merge: true });
  return code;
}

// ─── Callables ──────────────────────────────────────────────────────────────

/**
 * getReferralInfo → ReferralDashboardData
 * Lazy-allocates the user's code, counts completed referrals and milestone
 * claims on the server, and returns everything the dashboard needs.
 */
export const getReferralInfo = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in.');
  }
  const uid = context.auth.uid;

  const referralCode = await ensureReferralCodeForFunctions(uid);
  const referralLink = `https://dabzzo.in/login?ref=${encodeURIComponent(referralCode)}`;

  const [completedReferrals, claimsSnap] = await Promise.all([
    getCompletedReferralCount(uid),
    db().collection('referral_milestone_claims').where('user_id', '==', uid).get(),
  ]);

  const claimsByMilestone = new Map<string, admin.firestore.DocumentData>();
  claimsSnap.forEach((d) => claimsByMilestone.set(String(d.data()?.milestone_id || ''), d.data()));

  const milestones = REFERRAL_MILESTONES.map((m) => {
    const claim = claimsByMilestone.get(m.id);
    return {
      id: m.id,
      threshold: m.threshold,
      discount: m.discount,
      unlocked: completedReferrals >= m.threshold,
      claimed: Boolean(claim),
      couponCode: claim?.coupon_code,
      couponStatus: claim?.status,
    };
  });

  return {
    referralCode,
    referralLink,
    completedReferrals,
    milestones,
  };
});

/**
 * applyReferralCode
 * Attributes a sign-up to a referrer. Validates the code server-side, blocks
 * self-referral, blocks already-attributed users and blocks established
 * customers from farming a credit. Idempotent.
 */
export const applyReferralCode = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in.');
  }
  const callerUid = context.auth.uid;
  const provided = String(data?.code || '').trim().toUpperCase().slice(0, 6);
  const refDb = db();

  const userSnap = await refDb.collection('users').doc(callerUid).get();
  const userData = userSnap.data() || {};

  if (userData.referred_by) {
    return { attributed: false, reason: 'exists' };
  }

  if (!/^[A-Z0-9]{6}$/.test(provided)) {
    return { attributed: false, reason: 'invalid' };
  }

  const refCodeSnap = await refDb.collection('referral_codes').doc(provided).get();
  if (!refCodeSnap.exists) {
    return { attributed: false, reason: 'invalid' };
  }
  // Code belongs to the caller? That is a self-referral.
  if (refCodeSnap.data()?.user_id === callerUid) {
    return { attributed: false, reason: 'self' };
  }
  const referrerUid = String(refCodeSnap.data()?.user_id || '');

  // Users who are already paying customers (have a subscription) cannot claim
  // a late attribution to farm a completion credit.
  const existingSubs = await refDb
    .collection('subscriptions')
    .where('user_id', '==', callerUid)
    .limit(1)
    .get();
  if (!existingSubs.empty) {
    return { attributed: false, reason: 'existing_customer' };
  }

  const referralId = `ref_${provided}_${callerUid}`;
  const existingRef = await refDb.collection('referrals').doc(referralId).get();
  if (existingRef.exists) {
    return { attributed: true };
  }

  const batch = refDb.batch();
  batch.set(refDb.collection('referrals').doc(referralId), {
    referrer_user_id: referrerUid,
    referral_code: provided,
    referred_user_id: callerUid,
    referred_phone: userData.phone || '',
    status: 'pending',
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.update(refDb.collection('users').doc(callerUid), { referred_by: provided });
  await batch.commit();

  return { attributed: true };
});

/**
 * claimReferralMilestone
 * Issues the one-time coupon for a milestone. The discount value, threshold
 * check and coupon generation all happen server-side; the claim doc id
 * `{userId}_{milestoneId}` + Firestore transactions make double-claims atomic.
 */
export const claimReferralMilestone = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in.');
  }
  const uid = context.auth.uid;
  const milestoneId = String(data?.milestoneId || '');
  const milestone = REFERRAL_MILESTONES.find((m) => m.id === milestoneId);
  if (!milestone) {
    throw new functions.https.HttpsError('invalid-argument', 'Unknown reward milestone.');
  }

  const completedReferrals = await getCompletedReferralCount(uid);
  if (completedReferrals < milestone.threshold) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `This reward unlocks at ${milestone.threshold} successful referrals (you have ${completedReferrals}).`
    );
  }

  class CouponCollisionError extends Error {}
  const claimRef = db().collection('referral_milestone_claims').doc(`${uid}_${milestoneId}`);

  for (let attempt = 0; attempt < 5; attempt++) {
    const couponCode = generateCouponCodeForFunctions(milestone.discount);
    try {
      return await db().runTransaction(async (tx) => {
        const claimSnap = await tx.get(claimRef);
        if (claimSnap.exists) {
          throw new functions.https.HttpsError(
            'already-exists',
            'This reward has already been claimed.'
          );
        }

        const couponRef = db().collection('discount_codes').doc(couponCode);
        const couponSnap = await tx.get(couponRef);
        if (couponSnap.exists) {
          // Astronomically unlikely; regenerate the code and retry the txn.
          throw new CouponCollisionError();
        }

        const now = admin.firestore.FieldValue.serverTimestamp();
        tx.set(couponRef, {
          code: couponCode,
          discount_pct: milestone.discount,
          active: true,
          source: 'referral',
          plan_type: 'monthly',
          user_id: uid,
          milestone: milestoneId,
          status: 'available',
          created_at: now,
        });
        tx.set(claimRef, {
          user_id: uid,
          milestone_id: milestoneId,
          threshold: milestone.threshold,
          discount_percentage: milestone.discount,
          coupon_code: couponCode,
          status: 'available',
          claimed_at: now,
        });
        return { couponCode, discountPercentage: milestone.discount };
      });
    } catch (err) {
      if (err instanceof CouponCollisionError) continue;
      throw err;
    }
  }

  throw new functions.https.HttpsError('aborted', 'Could not allocate a unique coupon; please retry.');
});

/**
 * validateReferralCoupon
 * Pure UI-feedback validator for the checkout coupon field. It is NOT the
 * enforcement point — createRazorpayOrder re-validates before charging.
 */
export const validateReferralCoupon = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in.');
  }
  return resolveReferralCoupon(String(data?.code || ''), context.auth.uid);
});