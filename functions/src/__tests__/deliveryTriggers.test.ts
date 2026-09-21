import * as admin from 'firebase-admin';
const functionsTest = require('firebase-functions-test');
import { updateDeliveryStatus, verifyDeliveryOTP } from '../deliveryTriggers';
import { onDeliveryCompletedPayout, onOrderCompletedPayout } from '../payoutTriggers';
import * as events from '../utils/events';
import * as notifications from '../utils/notifications';

let testEnv: any;

// 1. Setup Mocks
jest.mock('firebase-admin', () => {
  const mockTransaction = {
    get: jest.fn(),
    update: jest.fn(),
    set: jest.fn(),
  };

  const mockDoc = {
    get: jest.fn(),
    update: jest.fn(),
    set: jest.fn(),
  };

  const mockCollection: any = {
    doc: jest.fn(() => mockDoc),
    where: jest.fn(() => mockCollection),
    limit: jest.fn(() => mockCollection),
    get: jest.fn(() => Promise.resolve({ docs: [], empty: true })),
    add: jest.fn(() => Promise.resolve({ id: 'mock_doc_id' })),
  };

  const mockBatch = {
    set: jest.fn(),
    update: jest.fn(),
    commit: jest.fn(() => Promise.resolve()),
  };

  const mockFirestoreInstance = {
    collection: jest.fn(() => mockCollection),
    runTransaction: jest.fn((cb: any) => cb(mockTransaction)),
    batch: jest.fn(() => mockBatch),
  };

  const firestore: any = jest.fn(() => mockFirestoreInstance);

  firestore.FieldValue = {
    arrayUnion: jest.fn((val) => val),
    serverTimestamp: jest.fn(() => 'MOCK_TIMESTAMP'),
    increment: jest.fn((val) => `INCREMENT_${val}`),
  };
  
  firestore.Timestamp = {
    now: jest.fn(() => 'MOCK_TIMESTAMP'),
  };

  return {
    firestore,
    initializeApp: jest.fn(),
  };
});

jest.mock('../utils/events', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/notifications', () => ({
  sendPushNotification: jest.fn(),
  orderPickedUpPayload: jest.fn(),
  orderDeliveredPayload: jest.fn(),
  deliveryFailedPayload: jest.fn(),
  deliveryFailedAdminPayload: jest.fn(),
}));

describe('Delivery Status Updates and Payouts', () => {
  let wrappedUpdateDeliveryStatus: any;
  let wrappedPayoutTrigger: any;

  beforeAll(() => {
    testEnv = functionsTest();
    // Wrap the functions
    wrappedUpdateDeliveryStatus = testEnv.wrap(updateDeliveryStatus);
    wrappedPayoutTrigger = (onDeliveryCompletedPayout as any).run;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    testEnv.cleanup();
  });

  const getMockTransaction = () => {
    const db = admin.firestore();
    let tx: any;
    db.runTransaction = jest.fn((cb) => {
      tx = {
        get: jest.fn(),
        update: jest.fn(),
        set: jest.fn(),
      };
      return cb(tx);
    }) as any;
    return () => tx;
  };

  it('1. Valid transition pending → picked_up succeeds', async () => {
    const getTx = getMockTransaction();

    // Mock the document snapshot returned by transaction.get()
    const db = admin.firestore();
    (db.runTransaction as jest.Mock).mockImplementationOnce(async (cb) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ status: 'pending', agentId: 'agent_123', customerId: 'cust_1' }),
        }),
        update: jest.fn(),
        set: jest.fn(),
      };
      return cb(tx);
    });

    const result = await wrappedUpdateDeliveryStatus({
      data: { orderId: 'order_1', status: 'picked_up' },
      auth: { uid: 'agent_123', token: { role: 'delivery_agent' } },
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe('picked_up');
    expect(events.publishEvent).toHaveBeenCalled();
  });

  it('2. Invalid transition pending → delivered throws FAILED_PRECONDITION', async () => {
    const db = admin.firestore();
    (db.runTransaction as jest.Mock).mockImplementationOnce(async (cb) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ status: 'pending', agentId: 'agent_123' }),
        }),
        update: jest.fn(),
        set: jest.fn(),
      };
      return cb(tx);
    });

    await expect(
      wrappedUpdateDeliveryStatus({
        data: { orderId: 'order_1', status: 'delivered' },
        auth: { uid: 'agent_123', token: { role: 'delivery_agent' } },
      })
    ).rejects.toThrow('Can only transition to delivered from picked_up');
  });

  it('3. Non-assigned agent calling the function throws PERMISSION_DENIED', async () => {
    const db = admin.firestore();
    (db.runTransaction as jest.Mock).mockImplementationOnce(async (cb) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ status: 'pending', agentId: 'agent_123' }), // assigned to agent_123
        }),
        update: jest.fn(),
        set: jest.fn(),
      };
      return cb(tx);
    });

    await expect(
      wrappedUpdateDeliveryStatus({
        data: { orderId: 'order_1', status: 'picked_up' },
        auth: { uid: 'wrong_agent', token: { role: 'delivery_agent' } }, // called by wrong_agent
      })
    ).rejects.toThrow('You are not assigned to this delivery');
  });

  it('4. failed_attempt without a reason string throws INVALID_ARGUMENT', async () => {
    const db = admin.firestore();
    (db.runTransaction as jest.Mock).mockImplementationOnce(async (cb) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ status: 'picked_up', agentId: 'agent_123' }),
        }),
        update: jest.fn(),
        set: jest.fn(),
      };
      return cb(tx);
    });

    await expect(
      wrappedUpdateDeliveryStatus({
        data: { orderId: 'order_1', status: 'failed_attempt', reason: '   ' }, // empty reason
        auth: { uid: 'agent_123', token: { role: 'delivery_agent' } },
      })
    ).rejects.toThrow('Must provide a non-empty reason');
  });

  it('9. Rejects canonical-but-non-delivery statuses (e.g. cancelled) via target whitelist', async () => {
    await expect(
      wrappedUpdateDeliveryStatus({
        data: { orderId: 'order_1', status: 'cancelled' },
        auth: { uid: 'agent_123', token: { role: 'delivery_agent' } },
      })
    ).rejects.toThrow('Cannot set delivery status to "cancelled"');
  });

  it('10. Rejects arbitrary status injection (e.g. rider_assigned) via target whitelist', async () => {
    await expect(
      wrappedUpdateDeliveryStatus({
        data: { orderId: 'order_1', status: 'rider_assigned' },
        auth: { uid: 'agent_123', token: { role: 'delivery_agent' } },
      })
    ).rejects.toThrow('Cannot set delivery status to "rider_assigned"');
  });

  it('11. Future/backdated canonical statuses are still rejected (delivered → ready regressions)', async () => {
    await expect(
      wrappedUpdateDeliveryStatus({
        data: { orderId: 'order_1', status: 'ready' },
        auth: { uid: 'agent_123', token: { role: 'delivery_agent' } },
      })
    ).rejects.toThrow('Cannot set delivery status to "ready"');
  });

  it('5. Successful delivered transition creates an agent_payout document', async () => {
    // This tests the payoutTrigger (onDeliveryCompletedPayout) which runs after the delivery status is updated to delivered.
    
    // Simulate the Firestore change event
    const beforeSnap = {
      data: () => ({ status: 'picked_up', agentId: 'agent_123' }),
    };
    const afterSnap = {
      data: () => ({ status: 'delivered', agentId: 'agent_123' }),
    };

    const event = {
      data: {
        before: beforeSnap,
        after: afterSnap,
      },
      params: {
        orderId: 'order_1',
      },
    };

    // Get the batch mock to assert it was used correctly
    const db = admin.firestore();
    const batchMock = {
      set: jest.fn(),
      update: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    (db.batch as jest.Mock).mockReturnValueOnce(batchMock);

    // Call the wrapped payout trigger
    await wrappedPayoutTrigger(event);

    // Verify batch was created and committed
    expect(db.batch).toHaveBeenCalled();
    expect(batchMock.set).toHaveBeenCalled(); // Payout doc creation
    expect(batchMock.update).toHaveBeenCalled(); // User earnings increment
    expect(batchMock.commit).toHaveBeenCalled();

    // Verify the payout arguments
    const payoutRecord = batchMock.set.mock.calls[0][1];
    expect(payoutRecord).toMatchObject({
      agentId: 'agent_123',
      deliveryId: 'order_1',
      amount: 40, // ₹40 fixed payout
      status: 'pending',
    });
  });

  it('6. verifyDeliveryOTP returns success: false and warning when invalid OTP is provided', async () => {
    const db = admin.firestore();
    const mockOrderData = {
      rider_id: 'rider_99',
      status: 'out_for_delivery',
      otp: '1234',
    };

    (db.runTransaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => mockOrderData,
        }),
        update: jest.fn(),
        set: jest.fn(),
      };
      return cb(tx);
    });

    const result = await (verifyDeliveryOTP as any).run({
      data: { orderId: 'order_test_otp', otp: '9999' }, // Wrong OTP
      auth: { uid: 'rider_99', token: { role: 'delivery_agent' } },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid OTP');
  });

  it('7. verifyDeliveryOTP returns success: true and transitions order when valid OTP is provided', async () => {
    const db = admin.firestore();
    const mockOrderData = {
      rider_id: 'rider_99',
      status: 'out_for_delivery',
      otp: '5678',
    };

    let updatedFields: any = null;
    (db.runTransaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => mockOrderData,
        }),
        update: jest.fn((ref, data) => {
          updatedFields = data;
        }),
        set: jest.fn(),
      };
      return cb(tx);
    });

    const result = await (verifyDeliveryOTP as any).run({
      data: { orderId: 'order_test_otp', otp: '5678' }, // Correct OTP
      auth: { uid: 'rider_99', token: { role: 'delivery_agent' } },
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('OTP verified successfully');
    expect(updatedFields).toMatchObject({
      status: 'delivered',
      otpVerified: true,
    });
  });

  it('8. onOrderCompletedPayout triggers payout on canonical orders collection', async () => {
    const beforeSnap = {
      data: () => ({ status: 'out_for_delivery', rider_id: 'rider_canonical_1' }),
    };
    const afterSnap = {
      data: () => ({ status: 'delivered', rider_id: 'rider_canonical_1' }),
    };

    const event = {
      data: {
        before: beforeSnap,
        after: afterSnap,
      },
      params: {
        orderId: 'order_canon_123',
      },
    };

    const db = admin.firestore();
    const batchMock = {
      set: jest.fn(),
      update: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    (db.batch as jest.Mock).mockReturnValueOnce(batchMock);

    await (onOrderCompletedPayout as any).run(event);

    expect(db.batch).toHaveBeenCalled();
    expect(batchMock.set).toHaveBeenCalled();
    expect(batchMock.update).toHaveBeenCalled();
    expect(batchMock.commit).toHaveBeenCalled();

    const payoutRecord = batchMock.set.mock.calls[0][1];
    expect(payoutRecord).toMatchObject({
      agentId: 'rider_canonical_1',
      deliveryId: 'order_canon_123',
      amount: 40,
      status: 'pending',
    });
  });
});
