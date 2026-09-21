/**
 * REFERRALS — shared constants & code generation.
 *
 * Client-side copy of the milestone tiers. The Cloud Functions package keeps
 * its own copy in functions/src/referralFunctions.ts (functions is deliberately
 * self-contained — it shares the duplicate-pricingEngine precedent); keep the
 * two in sync. The SERVER is always authoritative: it computes counts,
 * thresholds and coupon values itself, and never trusts anything from here.
 */
import type { ReferralMilestone } from '@dabzzo/shared-types';

export const REFERRAL_MILESTONES: ReferralMilestone[] = [
  { id: '3', threshold: 3, discount: 10 },
  { id: '5', threshold: 5, discount: 15 },
  { id: '7', threshold: 7, discount: 20 },
];

/** Alphabet without visually ambiguous characters (no 0/O, 1/I/L). */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LENGTH = 6;

export const REFERRAL_CODE_PATTERN = /^[A-Z0-9]{6}$/;

function randomChars(length: number, alphabet: string): string {
  const out: string[] = [];
  // crypto.getRandomValues is available in browsers and Node 19+.
  const buf = new Uint32Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < length; i++) buf[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = 0; i < length; i++) {
    out.push(alphabet[buf[i] % alphabet.length]);
  }
  return out.join('');
}

/** Random unique 6-char referral code (e.g. "K7Q2XP"). */
export function generateReferralCode(): string {
  return randomChars(REFERRAL_CODE_LENGTH, REFERRAL_CODE_ALPHABET);
}

/** Coupon code for a milestone reward, e.g. "REF10-AB12CD". */
export function generateCouponCode(discount: number): string {
  return `REF${discount}-${randomChars(6, REFERRAL_CODE_ALPHABET)}`;
}

/** Full shareable sign-up link for a referral code. */
export function buildReferralLink(code: string): string {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://dabzzo.in';
  return `${origin}/login?ref=${encodeURIComponent(code)}`;
}

/** Reads the ?ref=CODE from the current URL (used at sign-up). */
export function getReferralCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('ref');
  return code ? code.trim().toUpperCase().slice(0, 6) : null;
}