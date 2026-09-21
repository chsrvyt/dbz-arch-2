/**
 * REFERRAL TRIGGERS.
 *
 * 1. onSubscriptionWrite → completes a referral attribution when the referred
 *    user activates a subscription (server event = subscription becomes active,
 *    which only happens after a successful payment). Rejects duplicate-phone
 *    multi-account farming.
 * 2. onSubscriptionWrite (coupon) → marks a referral coupon 'used' only after a
 *    successful payment on a MONTHLY subscription (defense in depth; order
 *    creation already blocks non-monthly usage).
 */
import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';

function db(): admin.firestore.Firestore {
  return admin.firestore();
}

/** Completes the referral when a referred user's subscription activates. */
export const onReferralCompletedBySubscription = functions.firestore
  .document('subscriptions/{subId}')
  .onWrite(async (change) => {
    const after = change.after;
    if (!after.exists) return;
    const sub = after.data() || {};
    const userId = String(sub.user_id || '');
    // Only an activated subscription counts. ('active' is written only after a
    // successful payment; paused/resumed re-fire onWrite but stay no-ops.)
    if (!userId || sub.status !== 'active') return;

    const userSnap = await db().collection('users').doc(userId).get();
    const userData = userSnap.data() || {};
    const code = String(userData.referred_by || '');
    if (!code) return; // user was not referred

    const referralRef = db().collection('referrals').doc(`ref_${code}_${userId}`);
    const referralSnap = await referralRef.get();
    if (!referralSnap.exists) return; // attribution never recorded
    if (referralSnap.data()?.status === 'completed') return;

    // Same-phone multi-account prevention: if the referred phone number is
    // already linked to a completed referral under a different user, reject.
    const phone = String(referralSnap.data()?.referred_phone || userData.phone || '');
    if (phone) {
      const dupSnap = await db()
        .collection('referrals')
        .where('referred_phone', '==', phone)
        .where('status', '==', 'completed')
        .get();
      for (const d of dupSnap.docs) {
        if (d.id !== referralRef.id && String(d.data()?.referred_user_id || '') !== userId) {
          await referralRef.update({
            status: 'rejected',
            rejected_reason: 'duplicate_phone',
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          functions.logger.warn(
            `[referral] Rejected referral ${referralRef.id}: phone ${phone} already counted.`
          );
          return;
        }
      }
    }

    await db().runTransaction(async (tx) => {
      const snap = await tx.get(referralRef);
      if (!snap.exists || snap.data()?.status === 'completed') return;
      tx.update(referralRef, {
        status: 'completed',
        completed_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(db().collection('users').doc(userId), { referral_completed: true });
    });
    functions.logger.info(
      `[referral] Referral ${referralRef.id} completed for referrer via subscription.`
    );
  });

/** Marks a referral coupon used after the subscribing user pays for a MONTHLY plan. */
export const onReferralCouponRedeemedBySubscription = functions.firestore
  .document('subscriptions/{subId}')
  .onWrite(async (change) => {
    const after = change.after;
    if (!after.exists) return;
    const sub = after.data() || {};
    const code = String(sub.promo_code || '');
    if (!code) return;

    // Monthly-only enforcement (defense in depth).
    const frequency = String(sub.frequency || sub.billingCycle || '').toLowerCase();
    const subType = String(sub.subscriptionType || sub.plan_id || '').toLowerCase();
    const isMonthly = frequency === 'monthly' || subType.includes('monthly');
    if (!isMonthly) return;

    const couponRef = db().collection('discount_codes').doc(code);
    const couponSnap = await couponRef.get();
    if (!couponSnap.exists) return;
    const couponData = couponSnap.data() || {};
    if (couponData.source !== 'referral' || couponData.status === 'used') return;

    await db().runTransaction(async (tx) => {
      const snap = await tx.get(couponRef);
      if (!snap.exists || snap.data()?.status === 'used') return;
      tx.update(couponRef, {
        status: 'used',
        used_at: admin.firestore.FieldValue.serverTimestamp(),
        subscription_id: after.id,
        used_by: String(sub.user_id || ''),
      });
      // Mark the matching milestone claim used so the dashboard reflects it.
      if (couponData.user_id && couponData.milestone) {
        const claimRef = db()
          .collection('referral_milestone_claims')
          .doc(`${couponData.user_id}_${couponData.milestone}`);
        const claimSnap = await tx.get(claimRef);
        if (claimSnap.exists && claimSnap.data()?.status === 'available') {
          tx.update(claimRef, {
            status: 'used',
            used_at: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    });
    functions.logger.info(`[referral] Coupon ${code} marked used on subscription ${after.id}.`);
  });