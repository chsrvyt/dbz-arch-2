/**
 * Firestore security rules tests.
 *
 * These exist because rules previously had no coverage at all, so the only way
 * to check a change was to deploy to production and click through the app.
 * That is how the partner-onboarding bug shipped: isValidUserWrite refused
 * every customer -> vendor role change, which silently broke kitchen and rider
 * registration for every user, and in turn the vendor dashboard.
 *
 * Run: npm run test:rules   (from the repo root)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));

const CUSTOMER = 'user_customer';
const VENDOR = 'user_vendor';
const RIDER = 'user_rider';
const ADMIN = 'user_admin';

// Realistic custom-claims tokens. authenticatedContext without extra claims
// leaves request.auth.token empty, which makes the rules engine log noisy
// "Property X is undefined" diagnostics while evaluating isAdmin()'s claim
// lookups (role/email/admin) and some list branches.
const ADMIN_CLAIMS = { admin: true, role: 'admin', email: 'admin@dabzzo.in' };
function customerClaims() { return { role: 'customer', email: 'cust@dabzzo.in', admin: false }; }
function vendorClaims() { return { role: 'vendor', email: 'vendor@dabzzo.in', admin: false }; }
function riderClaims() { return { role: 'delivery', email: 'rider@dabzzo.in', admin: false }; }

let testEnv;
const results = [];

/** Run one case, recording pass/fail rather than aborting the whole file. */
async function it(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: String(err?.message || err).split('\n')[0].slice(0, 130) });
  }
}

/** Seed documents with rules bypassed, so setup can't be blocked by the rules under test. */
async function seed(fn) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore()));
}

async function main() {
  testEnv = await initializeTestEnvironment({
    projectId: 'dabzofb-rules-test',
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readFileSync(join(here, 'firestore.rules'), 'utf8'),
    },
  });

  // ── The bug this suite was written for ────────────────────────────────────
  await it('a customer may apply to become a vendor (self-service onboarding)', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      // onUserCreate stamps 'customer' on every new sign-in.
      await setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', name: 'Cust' });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', CUSTOMER),
        { role: 'vendor', kitchen_name: 'SRV Kitchens', is_approved: false },
        { merge: true })
    );
  });

  await it('a customer may apply to become a rider', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', CUSTOMER), { role: 'delivery', is_approved: false }, { merge: true })
    );
  });

  // ── The guard that must survive that change ───────────────────────────────
  await it('an applicant may NOT approve themselves', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(
      setDoc(doc(db, 'users', CUSTOMER), { role: 'vendor', is_approved: true }, { merge: true })
    );
  });

  await it('a user may NOT make themselves admin via role', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(setDoc(doc(db, 'users', CUSTOMER), { role: 'admin' }, { merge: true }));
  });

  await it('a user may NOT make themselves admin via roles.admin', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(
      setDoc(doc(db, 'users', CUSTOMER), { roles: { admin: true } }, { merge: true })
    );
  });

  await it('a user may NOT make themselves admin via is_superadmin', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(
      setDoc(doc(db, 'users', CUSTOMER), { is_superadmin: true }, { merge: true })
    );
  });

  await it('a vendor may NOT demote or rewrite another user', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', VENDOR), { role: 'vendor' });
      await setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' });
    });
    const db = testEnv.authenticatedContext(VENDOR).firestore();
    await assertFails(setDoc(doc(db, 'users', CUSTOMER), { role: 'vendor' }, { merge: true }));
  });

  // ── The downstream chain that broke the vendor dashboard ──────────────────
  await it('an unregistered customer CANNOT list batches', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(getDocs(query(collection(db, 'batches'), where('vendor_id', '==', CUSTOMER))));
  });

  await it('a vendor CAN list batches once role is vendor (no approval needed)', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', VENDOR), { role: 'vendor', is_approved: false });
    });
    const db = testEnv.authenticatedContext(VENDOR).firestore();
    await assertSucceeds(getDocs(query(collection(db, 'batches'), where('vendor_id', '==', VENDOR))));
  });

  await it('a vendor CAN list rider_trips', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', VENDOR), { role: 'vendor' }));
    const db = testEnv.authenticatedContext(VENDOR).firestore();
    await assertSucceeds(getDocs(query(collection(db, 'rider_trips'), where('status', '==', 'active'))));
  });

  await it('an unauthenticated caller cannot read a user document', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' }));
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'users', CUSTOMER)));
  });

  // ── Brand-new signup: no users/{uid} document exists yet ──────────────────
  // This is the email/password path. With Google, returning users already have
  // a document; a first-time signup has none until onUserCreate writes one.
  await it('a brand-new user can READ their own not-yet-created doc', async () => {
    await testEnv.clearFirestore();
    const db = testEnv.authenticatedContext('brand_new_uid').firestore();
    await assertSucceeds(getDoc(doc(db, 'users', 'brand_new_uid')));
  });

  await it('a brand-new user can CREATE their own profile document', async () => {
    await testEnv.clearFirestore();
    const db = testEnv.authenticatedContext('brand_new_uid').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', 'brand_new_uid'), {
        id: 'brand_new_uid',
        email: 'new@example.com',
        name: 'New Person',
        role: 'user',
        phone: '',
      })
    );
  });

  await it('a brand-new user creating a profile with undefined-ish fields', async () => {
    // AuthProvider's optimistic write includes keys set to undefined; the SDK
    // strips those, but the shape is worth pinning.
    await testEnv.clearFirestore();
    const db = testEnv.authenticatedContext('brand_new_uid').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', 'brand_new_uid'), { role: 'user', name: 'X' }, { merge: true })
    );
  });

  await it("AuthProvider's exact new-user profile write is permitted", async () => {
    // Mirrors the object AuthProvider now writes on first sign-in, so a future
    // change to that shape fails here rather than in production.
    await testEnv.clearFirestore();
    const db = testEnv.authenticatedContext('brand_new_uid').firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', 'brand_new_uid'), {
        id: 'brand_new_uid',
        email: 'new@example.com',
        name: 'new',
        phone: '',
        role: 'user',
        is_approved: true,
        created_at: serverTimestamp(),
      }, { merge: true })
    );
  });

  // ── Subscription creation writes a payments doc client-side ───────────────
  // NOTE: the payments write lives in activateExternalSubscription, which is an
  // ADMIN function for recording offline payments -- not the customer path.
  // Keeping the case documents that a customer correctly CANNOT write payments.
  await it('a customer CANNOT write a payments doc (admin-only ledger)', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'user' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(
      setDoc(doc(db, 'payments', 'pay_1'), {
        id: 'pay_1',
        user_id: CUSTOMER,
        subscription_id: 'sub_1',
        amount: 4500,
      })
    );
  });

  await it('a customer can create their own subscription', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'user' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'subscriptions', 'sub_1'), {
        id: 'sub_1', user_id: CUSTOMER, vendor_id: 'v1', status: 'active',
      })
    );
  });

  // ── The ACTUAL customer subscribe path (createSubscription) ───────────────
  await it('a customer can create their swap allowance on subscribe', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'user' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'subscription_swap_allowances', 'sub_1'), {
        subscription_id: 'sub_1', user_id: CUSTOMER,
        free_swaps_total: 2, free_swaps_used: 0,
      }, { merge: true })
    );
  });

  await it('a customer CANNOT reset an existing allowance (anti free-swap abuse)', async () => {
    // This MUST stay denied: being able to set free_swaps_used back to 0 would
    // mean unlimited free swaps. Re-subscribe resets are done by the
    // onSubscriptionCreated Cloud Function with the Admin SDK instead.
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', CUSTOMER), { role: 'user' });
      await setDoc(doc(db, 'subscription_swap_allowances', 'sub_1'), {
        subscription_id: 'sub_1', user_id: CUSTOMER, free_swaps_used: 1,
      });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(
      setDoc(doc(db, 'subscription_swap_allowances', 'sub_1'), {
        subscription_id: 'sub_1', user_id: CUSTOMER, free_swaps_used: 0,
      }, { merge: true })
    );
  });

  // ── completeOnboarding: saving the phone number ───────────────────────────
  // The phone-capture screen reappears on every sign-in if this write does not
  // land, because resolveUserProfile treats a missing phone as isNewUser.
  await it("completeOnboarding's phone write lands for a customer", async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'user', phone: '' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', CUSTOMER), {
        name: 'srv',
        phone: '+919119565436',
        role: 'user',
        is_approved: true,
        verification_status: 'verified',
        is_rejected: false,
      }, { merge: true })
    );
  });

  await it("completeOnboarding works when AuthProvider already made the profile", async () => {
    // AuthProvider now creates {role:'user', phone:''} on first sign-in, so the
    // onboarding write is an UPDATE over that, not a create.
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), {
      id: CUSTOMER, email: 'a@b.c', name: 'srv', phone: '', role: 'user', is_approved: true,
    }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', CUSTOMER), {
        name: 'srv', phone: '+919119565436', role: 'user',
        is_approved: true, verification_status: 'verified', is_rejected: false,
      }, { merge: true })
    );
  });

  // ── phone_prompt_shown: the strictly-once flag ────────────────────────────
  await it('a user can set their own phone_prompt_shown flag', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => setDoc(doc(db, 'users', CUSTOMER), { role: 'user', phone: '' }));
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', CUSTOMER), { phone_prompt_shown: true }, { merge: true })
    );
  });

  await it('a user CANNOT set phone_prompt_shown on someone else', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', CUSTOMER), { role: 'user' });
      await setDoc(doc(db, 'users', VENDOR), { role: 'vendor' });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(
      setDoc(doc(db, 'users', VENDOR), { phone_prompt_shown: true }, { merge: true })
    );
  });

  // ── Referral system ─────────────────────────────────────────────────────
  const CODE = 'REF10-ABCDEF';
  const REFERRAL_ID = `ref_${CODE}_${CUSTOMER}`;

  await it('an authenticated user can read their own referral record', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'referral_codes', CODE), { user_id: VENDOR, created_at: serverTimestamp() });
      await setDoc(doc(db, 'referrals', REFERRAL_ID), {
        code: CODE, referred_user_id: CUSTOMER, status: 'pending', referred_phone: '+919119000000',
      });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(getDoc(doc(db, 'referrals', REFERRAL_ID)));
    await assertSucceeds(getDoc(doc(db, 'referral_codes', CODE)));
  });

  await it('a user CANNOT read someone else\'s referral record', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'referrals', REFERRAL_ID), {
        code: CODE, referred_user_id: VENDOR, status: 'pending', referred_phone: '+919119000000',
      });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(getDoc(doc(db, 'referrals', REFERRAL_ID)));
  });

  await it('a user CANNOT write a referral doc (server-only collection)', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', CUSTOMER), { role: 'user' });
      await setDoc(doc(db, 'users', VENDOR), { role: 'user' });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(
      setDoc(doc(db, 'referrals', REFERRAL_ID), {
        code: CODE, referred_user_id: CUSTOMER, status: 'pending', referred_phone: '+919119000000',
      })
    );
    await assertFails(setDoc(doc(db, 'referral_codes', CODE), { user_id: CUSTOMER }));
    await assertFails(setDoc(doc(db, 'referral_milestone_claims', `${CUSTOMER}_m3`), { status: 'claim' }));
  });

  await it('a user can read their own milestone claims (locked status disclosed)', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'referral_milestone_claims', `${CUSTOMER}_m3`), {
        user_id: CUSTOMER, milestone: 'm3', status: 'available', code: CODE,
      });
      await setDoc(doc(db, 'referral_milestone_claims', `${VENDOR}_m7`), {
        user_id: VENDOR, milestone: 'm7', status: 'available', code: CODE,
      });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(getDoc(doc(db, 'referral_milestone_claims', `${CUSTOMER}_m3`)));
    await assertSucceeds(getDoc(doc(db, 'referral_milestone_claims', `${CUSTOMER}_m5`))); // locked: doc absent
    await assertFails(getDoc(doc(db, 'referral_milestone_claims', `${VENDOR}_m7`)));
  });

  // ── Cross-tenant read scoping (orders / deliveries / subscriptions) ──────
  // Rule tightening: list/get on these collections are participant-only, so a
  // rider/vendor CANNOT enumerate every customer's orders, addresses and OTPs
  // and any authenticated user CANNOT list every subscription in the system.
  await it('an order-owning customer can get their own order', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'orders', 'o_me'), {
        user_id: CUSTOMER, vendor_id: VENDOR, status: 'created',
      });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertSucceeds(getDoc(doc(db, 'orders', 'o_me')));
  });

  await it('a customer CANNOT get another customer\'s order (IDOR)', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' });
      await setDoc(doc(db, 'orders', 'o_theirs'), {
        user_id: VENDOR, vendor_id: VENDOR, status: 'created',
      });
    });
    const db = testEnv.authenticatedContext(CUSTOMER).firestore();
    await assertFails(getDoc(doc(db, 'orders', 'o_theirs')));
  });

  await it('rider may only get orders assigned to them (not the whole collection)', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', RIDER), { role: 'delivery', is_approved: true });
      await setDoc(doc(db, 'orders', 'o_mine'), {
        user_id: CUSTOMER, vendor_id: VENDOR, rider_id: RIDER, status: 'dispatched',
      });
      await setDoc(doc(db, 'orders', 'o_other'), {
        user_id: CUSTOMER, vendor_id: VENDOR, rider_id: 'user_rider_2', status: 'dispatched',
      });
    });
    const db = testEnv.authenticatedContext(RIDER, riderClaims()).firestore();
    await assertSucceeds(getDoc(doc(db, 'orders', 'o_mine')));
    await assertFails(getDoc(doc(db, 'orders', 'o_other')));
  });

  await it('unscoped orders list is denied for a rider (no cross-tenant scan)', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', RIDER), { role: 'delivery', is_approved: true });
      await setDoc(doc(db, 'orders', 'o_mine'), {
        user_id: CUSTOMER, vendor_id: VENDOR, rider_id: RIDER, status: 'dispatched',
      });
    });
    const db = testEnv.authenticatedContext(RIDER, riderClaims()).firestore();
    // A rider querying rider_id == self must see their own orders...
    await assertSucceeds(getDocs(query(collection(db, 'orders'), where('rider_id', '==', RIDER))));
    // ...but the app must scope by rider_id; a bare scan is denied.
    await assertFails(getDocs(collection(db, 'orders')));
  });

  await it('a participant rider may list only deliveries they are on', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', RIDER), { role: 'delivery', is_approved: true });
      await setDoc(doc(db, 'deliveries', 'd_mine'), { agentId: RIDER, riderId: RIDER, status: 'active' });
      await setDoc(doc(db, 'deliveries', 'd_other'), { agentId: 'user_rider_2', riderId: 'user_rider_2', status: 'active' });
    });
    const db = testEnv.authenticatedContext(RIDER, riderClaims()).firestore();
    // The rider app scopes by riderId (see rider-panel lib/delivery/locationTracker).
    await assertSucceeds(getDocs(query(collection(db, 'deliveries'), where('riderId', '==', RIDER))));
    // A bare scan is denied: it would return deliveries not part of this rider.
    await assertFails(getDocs(collection(db, 'deliveries')));
  });

  await it('a customer may list their own deliveries only', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', CUSTOMER), { role: 'customer' });
      await setDoc(doc(db, 'users', VENDOR), { role: 'customer' });
      await setDoc(doc(db, 'deliveries', 'd_mine'), { customerId: CUSTOMER, vendorId: VENDOR });
      await setDoc(doc(db, 'deliveries', 'd_other'), { customerId: VENDOR, vendorId: VENDOR });
    });
    const db = testEnv.authenticatedContext(CUSTOMER, customerClaims()).firestore();
    await assertFails(getDocs(collection(db, 'deliveries')));
    await assertSucceeds(
      getDocs(query(collection(db, 'deliveries'), where('customerId', '==', CUSTOMER)))
    );
    await assertFails(getDoc(doc(db, 'deliveries', 'd_other')));
  });

await it('a vendor may not list subscriptions belonging to other customers', async () => {
    await testEnv.clearFirestore();
    await seed(async (db) => {
      await setDoc(doc(db, 'users', VENDOR), { role: 'vendor' });
      await setDoc(doc(db, 'users', 'user_other_customer'), { role: 'customer' });
      await setDoc(doc(db, 'subscriptions', 'mine'), { user_id: CUSTOMER, vendor_id: VENDOR, status: 'active' });
      await setDoc(doc(db, 'subscriptions', 'theirs'), { user_id: 'user_other_customer', vendor_id: 'v_other', status: 'active' });
    });
    const db = testEnv.authenticatedContext(VENDOR, vendorClaims()).firestore();
    const own = await getDocs(query(collection(db, 'subscriptions'), where('vendor_id', '==', VENDOR)));
    assert.strictEqual(own.size, 1, 'vendor lists only their own subscriptions');
    await assertFails(getDocs(collection(db, 'subscriptions')));
    await assertFails(getDoc(doc(db, 'subscriptions', 'theirs')));
  });

  await testEnv.cleanup();

  // ── Report ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (!r.ok) console.log(`        ${r.err}`);
  }
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
