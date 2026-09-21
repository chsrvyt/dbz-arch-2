export {}; // module marker (see swapFunctions.test.ts)

const functionsTest = require('firebase-functions-test');

/**
 * Referral enforcement tests.
 *
 * These pin the security-critical paths of referralFunctions.ts:
 *   - milestone claims are threshold-guarded and one-time-atomic,
 *   - attribution rejects self-referral / existing customers / bad codes,
 *   - dashboard numbers come from the server, and
 *   - the coupon produced is a fresh REF<discount>-XXXXXX.
 */

// â”€â”€ Mockable Firestore helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const mockDocGet = jest.fn();
const mockDocSet = jest.fn();
const mockDocUpdate = jest.fn();
const mockQueryGet = jest.fn();
const mockBatchSet = jest.fn();
const mockBatchUpdate = jest.fn();
const mockBatchCommit = jest.fn(() => Promise.resolve());
const mockTxGet = jest.fn();
const mockTxSet = jest.fn();
const mockTxUpdate = jest.fn();

function snapObject(exists: boolean, data: any) {
  return { exists, data: () => data };
}

function makeQuerySnapshot(docs: { id: string; data: any }[]) {
  const d = docs.map((x) => ({ id: x.id, data: () => x.data }));
  return {
    docs: d,
    empty: d.length === 0,
    size: d.length,
    forEach: (f: any) => d.forEach(f),
  };
}

jest.mock('firebase-admin', () => {
  const collection: any = {
    doc: jest.fn((id: string) => ({
      id,
      get: () => mockDocGet(),
      set: (d: any, opts?: any) => mockDocSet(d, opts),
      update: (d: any) => mockDocUpdate(d),
    })),
    where: () => collection,
    limit: () => collection,
    get: () => mockQueryGet(),
  };
  return {
    firestore: Object.assign(
      jest.fn(() => ({
        collection: jest.fn(() => collection),
        runTransaction: jest.fn((cb: any) =>
          cb({
            get: mockTxGet,
            set: mockTxSet,
            update: mockTxUpdate,
          })
        ),
        batch: jest.fn(() => ({
          set: mockBatchSet,
          update: mockBatchUpdate,
          commit: mockBatchCommit,
        })),
      })),
      { FieldValue: { serverTimestamp: jest.fn(() => 'ts') } }
    ),
    initializeApp: jest.fn(),
    apps: [{}],
  };
});

let testEnv: any;
let mod: any;

beforeAll(() => {
  testEnv = functionsTest();
  mod = require('../referralFunctions');
});
afterAll(() => testEnv?.cleanup?.());
beforeEach(() => {
  jest.clearAllMocks();
  // default: no existing claim, no coupon collision, no subscriptions
  mockTxGet.mockResolvedValue(snapObject(false, null));
  mockQueryGet.mockResolvedValue(makeQuerySnapshot([]));
  mockDocSet.mockResolvedValue(undefined);
  mockDocUpdate.mockResolvedValue(undefined);
  mockBatchCommit.mockResolvedValue(undefined);
});

const OWNER = 'user_1';
const ownerCtx = { auth: { uid: OWNER, token: {} } };

async function expectError(p: Promise<any>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

describe('getReferralInfo', () => {
  test('rejects unauthenticated callers', async () => {
    await expectError(testEnv.wrap(mod.getReferralInfo)({}, {}), 'unauthenticated');
  });

  test('returns code, server-counted referrals and milestone states', async () => {
    // user doc has a code already â†’ no lazy allocation
    mockDocGet.mockResolvedValue(snapObject(true, { id: OWNER, referral_code: 'ABCDEF' }));
    // 3 completed referrals â†’ milestone 3 unlocked, 5/7 locked
    mockQueryGet.mockImplementation((field?: string) => {
      // count query etc. â€” any query returns 3 docs here for the referrals query
      return makeQuerySnapshot([
        { id: 'r1', data: {} },
        { id: 'r2', data: {} },
        { id: 'r3', data: {} },
      ]);
    });

    const res = await testEnv.wrap(mod.getReferralInfo)({}, ownerCtx);
    expect(res.referralCode).toBe('ABCDEF');
    expect(res.completedReferrals).toBe(3);
    const m3 = res.milestones.find((m: any) => m.id === '3');
    const m5 = res.milestones.find((m: any) => m.id === '5');
    expect(m3.unlocked).toBe(true);
    expect(m3.claimed).toBe(false);
    expect(m5.unlocked).toBe(false);
    expect(res.referralLink).toContain('ABCDEF');
  });
});

describe('applyReferralCode', () => {
  test('rejects unauthenticated callers', async () => {
    await expectError(testEnv.wrap(mod.applyReferralCode)({ code: 'ABCDEF' }, {}), 'unauthenticated');
  });

  test('rejects already-attributed users', async () => {
    mockDocGet.mockResolvedValueOnce(snapObject(true, { id: OWNER, referred_by: 'ZZZZZZ' }));
    const res = await testEnv.wrap(mod.applyReferralCode)({ code: 'ABCDEF' }, ownerCtx);
    expect(res.attributed).toBe(false);
    expect(res.reason).toBe('exists');
  });

  test('rejects a malformed code', async () => {
    mockDocGet.mockResolvedValueOnce(snapObject(true, { id: OWNER }));
    const res = await testEnv.wrap(mod.applyReferralCode)({ code: 'SHORT' }, ownerCtx);
    expect(res.reason).toBe('invalid');
  });

  test('rejects a code that does not exist', async () => {
    mockDocGet
      .mockResolvedValueOnce(snapObject(true, { id: OWNER })) // user doc
      .mockResolvedValueOnce(snapObject(false, null)); // referral_codes doc
    const res = await testEnv.wrap(mod.applyReferralCode)({ code: 'ZZZZZZ' }, ownerCtx);
    expect(res.reason).toBe('invalid');
  });

  test('rejects self-referral (using your own code)', async () => {
    mockDocGet
      .mockResolvedValueOnce(snapObject(true, { id: OWNER, referral_code: 'ABCDEF' })) // user doc
      .mockResolvedValueOnce(snapObject(true, { user_id: OWNER })); // referral code registry
    const res = await testEnv.wrap(mod.applyReferralCode)({ code: 'ABCDEF' }, ownerCtx);
    expect(res.reason).toBe('self');
  });

  test('rejects users who already have a subscription (customer farming)', async () => {
    mockDocGet
      .mockResolvedValueOnce(snapObject(true, { id: OWNER })) // user doc
      .mockResolvedValueOnce(snapObject(true, { user_id: 'referrer_9' })); // code registry
    mockQueryGet.mockResolvedValue(makeQuerySnapshot([{ id: 's1', data: { status: 'active' } }]));
    const res = await testEnv.wrap(mod.applyReferralCode)({ code: 'ABCDEF' }, ownerCtx);
    expect(res.reason).toBe('existing_customer');
  });

  test('attribution is idempotent once the referral doc exists', async () => {
    mockDocGet
      .mockResolvedValueOnce(snapObject(true, { id: OWNER })) // user
      .mockResolvedValueOnce(snapObject(true, { user_id: 'referrer_9' })) // code registry
      .mockResolvedValueOnce(snapObject(true, { referrer_user_id: 'referrer_9' })); // referral exists
    const res = await testEnv.wrap(mod.applyReferralCode)({ code: 'ABCDEF' }, ownerCtx);
    expect(res.attributed).toBe(true);
    expect(mockBatchCommit).not.toHaveBeenCalled();
  });

  test('valid attribution writes referral record + user.referred_by in one batch', async () => {
    mockDocGet
      .mockResolvedValueOnce(snapObject(true, { id: OWNER, phone: '9876543210' })) // user
      .mockResolvedValueOnce(snapObject(true, { user_id: 'referrer_9' })) // code registry
      .mockResolvedValueOnce(snapObject(false, null)); // referral doc absent
    const res = await testEnv.wrap(mod.applyReferralCode)({ code: 'ABCDEF' }, ownerCtx);
    expect(res.attributed).toBe(true);
    expect(mockBatchSet).toHaveBeenCalled();
    expect(mockBatchUpdate).toHaveBeenCalledWith(expect.anything(), { referred_by: 'ABCDEF' });
    expect(mockBatchCommit).toHaveBeenCalled();
  });
});

describe('claimReferralMilestone', () => {
  test('rejects unauthenticated callers', async () => {
    await expectError(testEnv.wrap(mod.claimReferralMilestone)({ milestoneId: '3' }, {}), 'unauthenticated');
  });

  test('rejects an unknown milestone id', async () => {
    await expectError(
      testEnv.wrap(mod.claimReferralMilestone)({ milestoneId: '9' }, ownerCtx),
      'invalid-argument'
    );
  });

  test('refuses to claim before the threshold is reached', async () => {
    mockQueryGet.mockResolvedValue(makeQuerySnapshot([{ id: 'r1', data: {} }, { id: 'r2', data: {} }]));
    await expectError(
      testEnv.wrap(mod.claimReferralMilestone)({ milestoneId: '3' }, ownerCtx),
      'failed-precondition'
    );
    expect(mockTxSet).not.toHaveBeenCalled();
  });

  test('issues a coupon once the milestone is unlocked', async () => {
    mockQueryGet.mockResolvedValue(makeQuerySnapshot([
      { id: 'r1', data: {} }, { id: 'r2', data: {} }, { id: 'r3', data: {} },
    ]));
    // transaction reads: claim doc (absent) then coupon doc (absent)
    mockTxGet
      .mockResolvedValueOnce(snapObject(false, null))
      .mockResolvedValueOnce(snapObject(false, null));

    const res = await testEnv.wrap(mod.claimReferralMilestone)({ milestoneId: '3' }, ownerCtx);
    expect(res.discountPercentage).toBe(10);
    expect(res.couponCode).toMatch(/^REF10-[A-Z0-9]{6}$/);
    expect(mockTxSet).toHaveBeenCalledTimes(2); // coupon + claim
  });

  test('a second claim for the same milestone fails with already-exists', async () => {
    mockQueryGet.mockResolvedValue(makeQuerySnapshot([
      { id: 'r1', data: {} }, { id: 'r2', data: {} }, { id: 'r3', data: {} },
    ]));
    mockTxGet.mockImplementation(() => Promise.resolve(snapObject(true, { coupon_code: 'REF10-AAAAAA' })));
    await expectError(
      testEnv.wrap(mod.claimReferralMilestone)({ milestoneId: '3' }, ownerCtx),
      'already-exists'
    );
    expect(mockTxSet).not.toHaveBeenCalled();
  });
});

describe('validateReferralCoupon', () => {
  test('rejects unauthenticated callers', async () => {
    await expectError(testEnv.wrap(mod.validateReferralCoupon)({ code: 'REF10-ABCDEF' }, {}), 'unauthenticated');
  });

  test('rejects a non-referral code', async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'vendor', code: 'SAVE10' }));
    const res = await testEnv.wrap(mod.validateReferralCoupon)({ code: 'SAVE10' }, ownerCtx);
    expect(res.valid).toBe(false);
  });

  test('rejects a used coupon', async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'referral', status: 'used', code: 'REF10-ABCDEF', user_id: OWNER, discount_pct: 10 }));
    const res = await testEnv.wrap(mod.validateReferralCoupon)({ code: 'REF10-ABCDEF' }, ownerCtx);
    expect(res.valid).toBe(false);
    expect(res.message).toContain('already been used');
  });

  test("rejects someone else's coupon", async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'referral', status: 'available', code: 'REF10-ABCDEF', user_id: 'someone_else', discount_pct: 10 }));
    const res = await testEnv.wrap(mod.validateReferralCoupon)({ code: 'REF10-ABCDEF' }, ownerCtx);
    expect(res.valid).toBe(false);
    expect(res.message).toContain('different account');
  });

  test("accepts the owner's valid monthly coupon", async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'referral', status: 'available', code: 'REF10-ABCDEF', user_id: OWNER, discount_pct: 10 }));
    const res = await testEnv.wrap(mod.validateReferralCoupon)({ code: 'REF10-ABCDEF' }, ownerCtx);
    expect(res.valid).toBe(true);
    expect(res.discountPct).toBe(10);
  });
});

// â”€â”€ Checkout enforcement (createRazorpayOrder coupon gate) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
describe('applyReferralCouponToOrder (checkout gate)', () => {
  let rzMod: any;

  beforeAll(() => {
    rzMod = require('../razorpayFunctions');
  });

  const monthlyNotes: Record<string, any> = { frequency: 'monthly', plan_id: 'monthly' };

  test('leaves the amount untouched when no coupon is present', async () => {
    mockDocGet.mockResolvedValue(snapObject(false, null));
    const amount = await rzMod.applyReferralCouponToOrder(
      { amount: 100000 },
      {},
      100000,
      OWNER
    );
    expect(amount).toBe(100000);
  });

  test('rejects unauthenticated callers', async () => {
    await expectError(
      rzMod.applyReferralCouponToOrder({ amount: 100000, coupon: 'REF10-ABCDEF' }, {}, 100000, null),
      'unauthenticated'
    );
  });

  test('rejects coupons on weekly plans', async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'referral', status: 'available', code: 'REF10-ABCDEF', user_id: OWNER, discount_pct: 10 }));
    await expectError(
      rzMod.applyReferralCouponToOrder(
        { amount: 100000, coupon: 'REF10-ABCDEF', frequency: 'weekly' },
        { frequency: 'weekly' },
        100000,
        OWNER
      ),
      'failed-precondition'
    );
  });

  test('rejects coupons on custom plans (pattern / schedule)', async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'referral', status: 'available', code: 'REF10-ABCDEF', user_id: OWNER, discount_pct: 10 }));
    await expectError(
      rzMod.applyReferralCouponToOrder(
        { amount: 100000, coupon: 'REF10-ABCDEF', frequency: 'monthly', pattern: { mon: 1 } },
        monthlyNotes,
        100000,
        OWNER
      ),
      'failed-precondition'
    );
  });

  test('rejects a used coupon', async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'referral', status: 'used', code: 'REF10-ABCDEF', user_id: OWNER, discount_pct: 10 }));
    await expectError(
      rzMod.applyReferralCouponToOrder(
        { amount: 100000, coupon: 'REF10-ABCDEF' },
        monthlyNotes,
        100000,
        OWNER
      ),
      'invalid-argument'
    );
  });

  test("rejects someone else's coupon", async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'referral', status: 'available', code: 'REF10-ABCDEF', user_id: 'not_owner', discount_pct: 10 }));
    await expectError(
      rzMod.applyReferralCouponToOrder(
        { amount: 100000, coupon: 'REF10-ABCDEF' },
        monthlyNotes,
        100000,
        OWNER
      ),
      'invalid-argument'
    );
  });

  test('applies the server-computed discount on a monthly plan', async () => {
    mockDocGet.mockResolvedValue(snapObject(true, { source: 'referral', status: 'available', code: 'REF10-ABCDEF', user_id: OWNER, discount_pct: 10 }));
    const amount = await rzMod.applyReferralCouponToOrder(
      { amount: 100000, coupon: 'REF10-ABCDEF', base_amount_paise: 100000 },
      monthlyNotes,
      100000,
      OWNER
    );
    expect(amount).toBe(90000);
    expect(monthlyNotes.coupon_code).toBe('REF10-ABCDEF');
    expect(monthlyNotes.coupon_discount_paise).toBe(10000);
  });
});