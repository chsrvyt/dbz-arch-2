export {}; // module marker: without a top-level import/export TypeScript
           // treats this file as a script, so its top-level consts collide
           // with the other test files' in one global scope.

const functionsTest = require('firebase-functions-test');

/**
 * requestMealSwap / acceptMealSwap move a meal (and credits) between customers.
 * They had no tests. These pin the guard paths — most importantly the two
 * ownership checks, which are what stop one customer swapping away another
 * customer's order or accepting a broadcast addressed to someone else.
 */

const mockOrderGet = jest.fn();
const mockOrderUpdate = jest.fn((..._a: any[]) => Promise.resolve());
const mockDocSet = jest.fn((..._a: any[]) => Promise.resolve());

jest.mock('firebase-admin', () => {
  const orderDoc = {
    id: 'mock_doc_id',
    get: () => mockOrderGet(),
    update: (d: any) => mockOrderUpdate(d),
    set: (d: any) => mockDocSet(d),
  };
  // Entitlement guard reads the subscription doc before allowing a swap; stub
  // it as a valid ACTIVE subscription with a far-future end date.
  const subDoc = {
    id: 's1',
    get: () =>
      Promise.resolve({
        exists: true,
        data: () => ({
          status: 'active',
          next_billing_date: { _seconds: 4102444800, _nanoseconds: 0 }, // way past today
        }),
      }),
    update: jest.fn(() => Promise.resolve()),
    set: jest.fn(() => Promise.resolve()),
  };
  const makeCollection: any = (name: string) => {
    if (name === 'subscriptions') {
      return {
        doc: jest.fn(() => subDoc),
        where: jest.fn(),
        get: jest.fn(() =>
          Promise.resolve({ docs: [], empty: true, size: 0, forEach: (_f: any) => undefined })
        ),
      };
    }
    return {
      doc: jest.fn(() => orderDoc),
      where: jest.fn(() => makeCollection(name)),
      limit: jest.fn(() => makeCollection(name)),
      get: jest.fn(() =>
        Promise.resolve({ docs: [], empty: true, size: 0, forEach: (_f: any) => undefined })
      ),
      add: jest.fn(() => Promise.resolve({ id: 'new_doc' })),
    };
  };
  return {
    firestore: Object.assign(
      jest.fn(() => ({
        collection: jest.fn((name: string) => makeCollection(name)),
        runTransaction: jest.fn((cb: any) =>
          cb({ get: jest.fn(), set: jest.fn(), update: jest.fn() })
        ),
        batch: jest.fn(() => ({
          set: jest.fn(),
          update: jest.fn(),
          commit: jest.fn(() => Promise.resolve()),
        })),
      })),
      { FieldValue: { serverTimestamp: jest.fn(() => 'ts'), increment: jest.fn((n: number) => n) } }
    ),
    initializeApp: jest.fn(),
    apps: [{}],
  };
});

let testEnv: any;
let mod: any;

beforeAll(() => {
  testEnv = functionsTest();
  mod = require('../swapFunctions');
});
afterAll(() => testEnv?.cleanup?.());
beforeEach(() => jest.clearAllMocks());

const OWNER = 'cust_1';
const ownerCtx = { auth: { uid: OWNER, token: {} } };
const strangerCtx = { auth: { uid: 'cust_2', token: {} } };

function orderSnap(over: Record<string, any> = {}) {
  return {
    exists: true,
    data: () => ({ user_id: OWNER, status: 'created', ...over }),
  };
}

async function expectError(p: Promise<any>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

describe('requestMealSwap', () => {
  const validArgs = { orderId: 'o1', subscriptionId: 's1' };

  test('rejects an unauthenticated caller', async () => {
    await expectError(testEnv.wrap(mod.requestMealSwap)(validArgs, {}), 'unauthenticated');
    expect(mockOrderGet).not.toHaveBeenCalled();
  });

  test('requires orderId and subscriptionId', async () => {
    await expectError(
      testEnv.wrap(mod.requestMealSwap)({ subscriptionId: 's1' }, ownerCtx),
      'invalid-argument'
    );
    await expectError(
      testEnv.wrap(mod.requestMealSwap)({ orderId: 'o1' }, ownerCtx),
      'invalid-argument'
    );
    expect(mockOrderGet).not.toHaveBeenCalled();
  });

  test('rejects an order that does not exist', async () => {
    mockOrderGet.mockResolvedValue({ exists: false, data: () => undefined });
    await expectError(testEnv.wrap(mod.requestMealSwap)(validArgs, ownerCtx), 'not-found');
  });

  // The security-critical one: you cannot swap away someone else's meal.
  test('rejects a caller who does not own the order', async () => {
    mockOrderGet.mockResolvedValue(orderSnap());
    await expectError(
      testEnv.wrap(mod.requestMealSwap)(validArgs, strangerCtx),
      'permission-denied'
    );
    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });

  test('accepts ownership recorded as customerId rather than user_id', async () => {
    mockOrderGet.mockResolvedValue({
      exists: true,
      data: () => ({ customerId: OWNER, status: 'created' }),
    });
    await expect(
      testEnv.wrap(mod.requestMealSwap)(validArgs, ownerCtx)
    ).resolves.toBeDefined();
  });

  test.each(['cancelled', 'skipped', 'delivered', 'picked_up'])(
    'refuses to swap an order already in %s',
    async (status) => {
      mockOrderGet.mockResolvedValue(orderSnap({ status }));
      await expectError(
        testEnv.wrap(mod.requestMealSwap)(validArgs, ownerCtx),
        'failed-precondition'
      );
      expect(mockOrderUpdate).not.toHaveBeenCalled();
    }
  );

  test('reassigns the vendor when targetVendorId is supplied', async () => {
    mockOrderGet.mockResolvedValue(orderSnap());
    await testEnv.wrap(mod.requestMealSwap)(
      { ...validArgs, targetVendorId: 'vendor_9' },
      ownerCtx
    );
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ vendor_id: 'vendor_9' })
    );
  });
});

describe('acceptMealSwap', () => {
  test('rejects an unauthenticated caller', async () => {
    await expectError(testEnv.wrap(mod.acceptMealSwap)({ broadcastId: 'b1' }, {}), 'unauthenticated');
  });

  test('requires broadcastId', async () => {
    await expectError(testEnv.wrap(mod.acceptMealSwap)({}, ownerCtx), 'invalid-argument');
  });
});
