/**
 * SUBSCRIPTION ENTITLEMENT â€” single source of truth.
 *
 * Root-cause fix for "expired subscriptions still treated as active":
 * nothing ever compared `next_billing_date` against now, so an expired-but-
 * still-`active` subscription kept showing `active` to every panel.
 *
 * Two mechanisms, mirrored semantics:
 *   1. `isSubscriptionActive(sub, nowMs)` â€” pure predicate used defensively
 *      by client callables so no consumer can treat an expired sub as active
 *      even between cron runs.
 *   2. `expireSubscriptions` â€” hourly IST scheduled sweep that makes the
 *      stored DATA honest: flips expired `subscriptions` to `cancelled`
 *      (`cancelled_by: 'system_expiry'`, which cascades through
 *      `onSubscriptionCancelled` to cancel the customer's future orders) and
 *      clears the user's entitlement flags when no other valid sub remains.
 *
 * Semantics (instant-based, timezone-agnostic, identical on server + client):
 *   - a subscription grants benefits while  now < next_billing_date
 *   - at  now >= next_billing_date  the subscription is EXPIRED
 *   - a subscription without a recorded end date cannot be proven expired and
 *     keeps its stored status (legacy docs are not mass-cancelled).
 */
import * as admin from 'firebase-admin';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { writeAuditLog } from './auditUtils';

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

/**
 * The single entitlement predicate. A subscription is ACTIVE only when its
 * stored status is `active` AND the current instant is before its end date.
 * A missing end date is treated as unknown/not-expired (legacy safety).
 */
export function isSubscriptionActive(
  sub: Record<string, any>,
  nowMs: number = Date.now()
): boolean {
  if ((sub?.status ?? '') !== 'active') return false;
  const expiryMs = getSubscriptionExpiryMs(sub);
  if (expiryMs == null) return true; // cannot prove expiry â†’ keep stored status
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

/**
 * Load a subscription and report its entitlement status. Use in customer
 * callables so subscription-protected operations are rejected server-side
 * the moment a subscription expires â€” never just hidden in the UI.
 */
export async function getSubscriptionAccessRecord(
  db: admin.firestore.Firestore,
  subId: string,
  nowMs: number = Date.now()
): Promise<{
  exists: boolean;
  active: boolean;
  expired: boolean;
  sub: Record<string, any> | null;
}> {
  const snap = await db.collection('subscriptions').doc(subId).get();
  if (!snap.exists) return { exists: false, active: false, expired: false, sub: null };
  const sub = snap.data() as Record<string, any>;
  return {
    exists: true,
    active: isSubscriptionActive(sub, nowMs),
    expired: isSubscriptionExpired(sub, nowMs),
    sub,
  };
}

/**
 * Hourly IST sweep that transitions expired subscriptions to `cancelled`.
 * The `onSubscriptionCancelled` document-update trigger owns the order
 * cancellation cascade; this sweep owns the status flip + user-flag cleanup.
 */
export const expireSubscriptions = onSchedule(
  { schedule: '30 * * * *', timeZone: 'Asia/Kolkata' },
  async () => {
    const db = admin.firestore();
    const nowMs = Date.now();
    const affectedUsers = new Set<string>();
    let expired = 0;
    const sweepRunId = `sweep_${Date.now()}`;

    const PAGE = 500;
    let query = db.collection('subscriptions').where('status', '==', 'active').limit(PAGE);

    for (;;) {
      const snap = await query.get();
      let last: admin.firestore.QueryDocumentSnapshot | null = null;

      for (const doc of snap.docs) {
        last = doc;
        const sub = doc.data();
        if (!isSubscriptionExpired(sub, nowMs)) continue;

        const userId = String(sub.user_id || '');
        const write = {
          status: 'cancelled',
          cancelled_at: admin.firestore.FieldValue.serverTimestamp(),
          cancelled_by: 'system_expiry',
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Nested writes are fine; the deterministic sub ids are unique per
        // (user, vendor, meal_type), so colliding writes within one run are
        // impossible.
        await db.collection('subscriptions').doc(doc.id).update(write);

        if (userId) affectedUsers.add(userId);
        expired += 1;
        console.info(`[expireSubscriptions] Expired subscription ${doc.id} (user ${userId})`);
      }

      if (snap.size < PAGE || !last) break;
      query = query.startAfter(last);
    }

    // Clear entitlement flags on users who no longer hold any valid sub.
    for (const userId of affectedUsers) {
      const stillActive = await db
        .collection('subscriptions')
        .where('user_id', '==', userId)
        .where('status', '==', 'active')
        .get();

      let hasValid = false;
      for (const d of stillActive.docs) {
        if (isSubscriptionActive(d.data(), nowMs)) {
          hasValid = true;
          break;
        }
      }
      if (hasValid) continue;

      await db.collection('users').doc(userId).update({
        is_active_subscriber: false,
        membership_status: 'inactive',
        active_subscription_id: admin.firestore.FieldValue.delete(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      await writeAuditLog(
        {
          action: 'subscription.expiry.user_clear',
          actorUid: 'system:expireSubscriptions',
          targetUid: userId,
          targetType: 'users',
          targetId: userId,
          result: 'success',
          message: `Cleared entitlement flags for user ${userId} (no valid sub remains)`,
          metadata: { sweepRunId },
        },
        db
      );
      console.info(
        `[expireSubscriptions] Cleared entitlement flags for user ${userId} (no valid sub remains)`
      );
    }

    await writeAuditLog(
      {
        action: 'subscription.expiry.sweep',
        actorUid: 'system:expireSubscriptions',
        result: 'success',
        message: `Sweep complete: ${expired} subscriptions expired.`,
        metadata: {
          sweepRunId,
          expired,
          affectedUserCount: affectedUsers.size,
          affectedUsers: [...affectedUsers],
        },
      },
      db
    );

    console.info(`[expireSubscriptions] Sweep complete: ${expired} subscriptions expired.`);
  }
);