/**
 * REFERRALS — client query layer.
 *
 * These callable functions are the ONLY way the app reads or mutates referral
 * state. All counts, milestone unlocks and coupon values are computed on the
 * server (functions/src/referralFunctions.ts); the client never derives them.
 */
import { httpsCallable } from 'firebase/functions';
import { functions } from '@dabzzo/shared-auth';
import type { ReferralDashboardData } from '@dabzzo/shared-types';

export interface ReferralCouponCheck {
  valid: boolean;
  code: string;
  discountPct?: number;
  message?: string;
}

/** Server-side referral dashboard payload (code, progress, milestone states). */
export async function getReferralDashboardData(): Promise<ReferralDashboardData> {
  const fn = httpsCallable<Record<string, never>, ReferralDashboardData>(
    functions,
    'getReferralInfo'
  );
  const res = await fn({});
  return res.data;
}

/**
 * Attributes a sign-up to a referrer. Called once, after a brand-new user
 * completes phone onboarding. Idempotent + server-validated; safe to call for
 * existing users too (server ignores it).
 */
export async function applyReferralCode(
  code: string
): Promise<{ attributed: boolean }> {
  const fn = httpsCallable<{ code: string }, { attributed: boolean }>(
    functions,
    'applyReferralCode'
  );
  const res = await fn({ code });
  return res.data;
}

/** Claims a milestone reward (returns the unique coupon code). */
export async function claimReferralMilestone(
  milestoneId: string
): Promise<{ couponCode: string; discountPercentage: number }> {
  const fn = httpsCallable<
    { milestoneId: string },
    { couponCode: string; discountPercentage: number }
  >(functions, 'claimReferralMilestone');
  const res = await fn({ milestoneId });
  return res.data;
}

/**
 * Validates a coupon code before it reaches checkout. Also enforced
 * server-side in createRazorpayOrder — this is only for UI feedback.
 */
export async function validateReferralCoupon(code: string): Promise<ReferralCouponCheck> {
  const fn = httpsCallable<{ code: string }, ReferralCouponCheck>(
    functions,
    'validateReferralCoupon'
  );
  const res = await fn({ code });
  return res.data;
}