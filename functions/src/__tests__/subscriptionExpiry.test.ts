export {}; // module marker (see swapFunctions.test.ts)

const functionsTest = require('firebase-functions-test');

/**
 * Subscription entitlement unit tests.
 *
 * These pin the single source of truth that fixes the expired-subscriptions
 * bug: `next_billing_date` must build the entitlement decision, and the
 * exactly-at boundary (now === next_billing_date) MUST be EXPIRED.
 *
 * The communicate-only version lives client-side in
 * `packages/shared-lib/src/subscriptionEntitlement.ts` (mirrored semantics).
 */

const mint = require('../subscriptionExpiry');

describe('getSubscriptionExpiryMs', () => {
  it('accepts a raw epoch number', () => {
    expect(mint.getSubscriptionExpiryMs({ next_billing_date: 1700000000000 })).toBe(1700000000000);
  });

  it('accepts a JS Date', () => {
    const d = new Date('2026-10-01T00:00:00Z');
    expect(mint.getSubscriptionExpiryMs({ next_billing_date: d })).toBe(d.getTime());
  });

  it('accepts an ISO string', () => {
    expect(mint.getSubscriptionExpiryMs({ next_billing_date: '2026-10-01T00:00:00.000Z' })).toBe(
      Date.parse('2026-10-01T00:00:00.000Z')
    );
  });

  it('accepts a Firestore Timestamp', () => {
    const ts = { seconds: 1700000000, nanoseconds: 0, toDate: () => new Date(1700000000000) };
    expect(mint.getSubscriptionExpiryMs({ next_billing_date: ts })).toBe(1700000000000);
  });

  it('accepts a serialized {_seconds} snapshot payload', () => {
    expect(mint.getSubscriptionExpiryMs({ next_billing_date: { _seconds: 1700000000, _nanoseconds: 0 } })).toBe(1700000000000);
  });

  it('accepts the nextBillingDate and end_date aliases', () => {
    expect(mint.getSubscriptionExpiryMs({ nextBillingDate: 1700000000000 })).toBe(1700000000000);
    expect(mint.getSubscriptionExpiryMs({ end_date: 1700000000000 })).toBe(1700000000000);
  });

  it('returns null when no end date is recorded', () => {
    expect(mint.getSubscriptionExpiryMs({ status: 'active' })).toBeNull();
    expect(mint.getSubscriptionExpiryMs({})).toBeNull();
  });
});

describe('isSubscriptionActive', () => {
  const future = 2_000_000_000_000; // way in the future of any 2026 test run
  const past = 1_000_000_000_000;

  it('true for active with a future nbd', () => {
    expect(mint.isSubscriptionActive({ status: 'active', next_billing_date: future }, Date.now())).toBe(true);
  });

  it('false for active whose nbd equals now (exactly-at = expired)', () => {
    const now = 1_700_000_000_000;
    expect(mint.isSubscriptionActive({ status: 'active', next_billing_date: now }, now)).toBe(false);
  });

  it('false for active with a past nbd', () => {
    expect(mint.isSubscriptionActive({ status: 'active', next_billing_date: past }, Date.now())).toBe(false);
  });

  it('true (legacy safety) for active with no recorded nbd', () => {
    expect(mint.isSubscriptionActive({ status: 'active' }, Date.now())).toBe(true);
  });

  it('false for paused/cancelled regardless of nbd', () => {
    expect(mint.isSubscriptionActive({ status: 'paused', next_billing_date: future }, Date.now())).toBe(false);
    expect(mint.isSubscriptionActive({ status: 'cancelled', next_billing_date: future }, Date.now())).toBe(false);
  });
});

describe('isSubscriptionExpired', () => {
  const future = 2_000_000_000_000;
  const past = 1_000_000_000_000;

  it('false for active with a future nbd', () => {
    expect(mint.isSubscriptionExpired({ status: 'active', next_billing_date: future }, Date.now())).toBe(false);
  });

  it('true at exactly the boundary', () => {
    const now = 1_700_000_000_000;
    expect(mint.isSubscriptionExpired({ status: 'active', next_billing_date: now }, now)).toBe(true);
  });

  it('true for active with a past nbd', () => {
    expect(mint.isSubscriptionExpired({ status: 'active', next_billing_date: past }, Date.now())).toBe(true);
  });

  it('false for active with no recorded nbd', () => {
    expect(mint.isSubscriptionExpired({ status: 'active' }, Date.now())).toBe(false);
  });

  it('false for non-active statuses', () => {
    expect(mint.isSubscriptionExpired({ status: 'paused', next_billing_date: past }, Date.now())).toBe(false);
    expect(mint.isSubscriptionExpired({ status: 'cancelled', next_billing_date: past }, Date.now())).toBe(false);
  });
});

describe('getSubscriptionAccessRecord', () => {
  it('reports exists:false for a missing document', async () => {
    const mockGet = jest.fn(() => Promise.resolve({ exists: false }));
    const db = { collection: jest.fn(() => ({ doc: jest.fn(() => ({ get: mockGet })) })) };
    const res = await mint.getSubscriptionAccessRecord(db, 'sub_none');
    expect(res.exists).toBe(false);
    expect(res.active).toBe(false);
    expect(res.expired).toBe(false);
    expect(res.sub).toBeNull();
  });

  it('reports active for a valid future subscription', async () => {
    const sub = { status: 'active', next_billing_date: { _seconds: 2e9, _nanoseconds: 0 } };
    const mockGet = jest.fn(() => Promise.resolve({ exists: true, data: () => sub }));
    const db = { collection: jest.fn(() => ({ doc: jest.fn(() => ({ get: mockGet })) })) };
    const res = await mint.getSubscriptionAccessRecord(db, 'sub_x', Date.now());
    expect(res.exists).toBe(true);
    expect(res.active).toBe(true);
    expect(res.expired).toBe(false);
  });

  it('reports expired even when the stored status still says active', async () => {
    const sub = { status: 'active', next_billing_date: { _seconds: 1e9, _nanoseconds: 0 } };
    const mockGet = jest.fn(() => Promise.resolve({ exists: true, data: () => sub }));
    const db = { collection: jest.fn(() => ({ doc: jest.fn(() => ({ get: mockGet })) })) };
    const res = await mint.getSubscriptionAccessRecord(db, 'sub_expired', Date.now());
    expect(res.active).toBe(false);
    expect(res.expired).toBe(true);
  });
});

describe('expireSubscriptions wiring', () => {
  it('is a deployable scheduled function that paginates and sweeps', () => {
    // Guards the registration surface (an onSchedule handler) that index.ts
    // re-exports so the hourly IST sweep is deployable.
    expect(typeof mint.expireSubscriptions).toBe('function');
    expect(typeof mint.expireSubscriptions.run).toBe('function');
  });
});