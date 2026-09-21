/**
 * SUBSCRIPTION ENTITLEMENT — client mirror of `functions/src/subscriptionExpiry.ts`.
 *
 * Semantics must stay identical to the server copy:
 *   - benefits while  now < next_billing_date
 *   - at  now >= next_billing_date  the subscription is EXPIRED
 *   - a subscription without a recorded end date can't be proven expired and
 *     keeps its stored status (legacy safety).
 *
 * The server sweep (`expireSubscriptions`) makes the stored DATA honest; these
 * helpers are defense-in-depth so the UI can never show an expired subscription
 * as active between sweeps.
 */

export type SubscriptionAccess =
  | 'active'
  | 'expired'
  | 'paused'
  | 'cancelled'
  | 'unknown';

/** Normalize a Firestore/JS Date/timestamp to epoch milliseconds, or null. */
export function getSubscriptionExpiryMs(sub: Record<string, any>): number | null {
  const nbd = sub?.next_billing_date ?? sub?.nextBillingDate ?? sub?.end_date ?? sub?.valid_until;
  if (!nbd) return null;
  if (typeof nbd === 'number') return nbd;
  if (nbd instanceof Date) return nbd.getTime();
  if (typeof nbd === 'string') {
    const t = Date.parse(nbd);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof nbd.toDate === 'function') return nbd.toDate().getTime();
  if (typeof nbd.seconds === 'number') return nbd.seconds * 1000;
  if (typeof nbd._seconds === 'number') return nbd._seconds * 1000;
  return null;
}

/** True only for a stored-active subscription whose end date is still ahead. */
export function isSubscriptionActive(
  sub: Record<string, any>,
  nowMs: number = Date.now()
): boolean {
  if ((sub?.status ?? '') !== 'active') return false;
  const expiryMs = getSubscriptionExpiryMs(sub);
  if (expiryMs == null) return true; // cannot prove expiry → keep stored status
  return nowMs < expiryMs;
}

/** True when a recorded end date has already passed (or equals) now. */
export function isSubscriptionExpired(
  sub: Record<string, any>,
  nowMs: number = Date.now()
): boolean {
  if ((sub?.status ?? '') !== 'active') return false;
  const expiryMs = getSubscriptionExpiryMs(sub);
  if (expiryMs == null) return false;
  return nowMs >= expiryMs;
}

/** Categorize a single subscription independent of its stored status string. */
export function getSubscriptionAccess(
  sub: Record<string, any>,
  nowMs: number = Date.now()
): SubscriptionAccess {
  const status = sub?.status ?? '';
  if (status === 'active') return isSubscriptionExpired(sub, nowMs) ? 'expired' : 'active';
  if (status === 'paused') return 'paused';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
}

export interface CustomerAccessState {
  /** Subscriptions currently granting full benefits. */
  activeSubscriptions: Record<string, any>[];
  /** Active subscriptions that have passed their end date. */
  expiredSubscriptions: Record<string, any>[];
  pausedSubscriptions: Record<string, any>[];
  cancelledSubscriptions: Record<string, any>[];
  hasActiveSubscription: boolean;
  /** Epoch ms of the nearest upcoming expiry among active subs, or null. */
  nextExpiryMs: number | null;
}

/** Aggregate entitlement for a customer's subscription collection. */
export function getCustomerAccessState(
  subscriptions: Record<string, any>[],
  nowMs: number = Date.now()
): CustomerAccessState {
  const activeSubscriptions: Record<string, any>[] = [];
  const expiredSubscriptions: Record<string, any>[] = [];
  const pausedSubscriptions: Record<string, any>[] = [];
  const cancelledSubscriptions: Record<string, any>[] = [];

  for (const sub of subscriptions ?? []) {
    switch (getSubscriptionAccess(sub, nowMs)) {
      case 'active':
        activeSubscriptions.push(sub);
        break;
      case 'expired':
        expiredSubscriptions.push(sub);
        break;
      case 'paused':
        pausedSubscriptions.push(sub);
        break;
      default:
        cancelledSubscriptions.push(sub);
    }
  }

  const nextExpiryMs = activeSubscriptions.reduce<number | null>((acc, s) => {
    const ms = getSubscriptionExpiryMs(s);
    if (ms == null) return acc;
    return acc == null || ms < acc ? ms : acc;
  }, null);

  return {
    activeSubscriptions,
    expiredSubscriptions,
    pausedSubscriptions,
    cancelledSubscriptions,
    hasActiveSubscription: activeSubscriptions.length > 0,
    nextExpiryMs,
  };
}