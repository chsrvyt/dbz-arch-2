export {}; // module marker (see swapFunctions.test.ts)

jest.mock('firebase-admin', () => {
  const firestore: any = jest.fn();
  firestore.FieldValue = {
    serverTimestamp: jest.fn(() => 'MOCK_TIMESTAMP'),
    arrayUnion: jest.fn((v) => v),
    increment: jest.fn((v) => v),
  };
  return { firestore, initializeApp: jest.fn() };
});

const { writeAuditLog } = require('../auditUtils');

function mockDb() {
  const set = jest.fn().mockResolvedValue(undefined);
  const doc = jest.fn(() => ({ id: 'audit_123', set }));
  const collection = jest.fn(() => ({ doc }));
  return { db: { collection }, set, collection, doc };
}

describe('writeAuditLog', () => {
  it('writes a server-shaped audit entry (snake + camel keys) to audit_logs', async () => {
    const { db, set, collection } = mockDb();
    const id = await writeAuditLog(
      {
        action: 'subscription.expiry.user_clear',
        actorUid: 'system:expireSubscriptions',
        targetUid: 'user_1',
        targetType: 'users',
        targetId: 'user_1',
        result: 'success',
        message: 'cleared flags',
        metadata: { sweepRunId: 'sweep_123' },
      },
      db as any
    );

    expect(collection).toHaveBeenCalledWith('audit_logs');
    expect(id).toBe('audit_123');
    expect(set).toHaveBeenCalledTimes(1);
    const [payload, opts] = set.mock.calls[0];
    expect(opts).toEqual({ merge: true });
    expect(payload).toMatchObject({
      action: 'subscription.expiry.user_clear',
      actor_uid: 'system:expireSubscriptions',
      actorUid: 'system:expireSubscriptions',
      target_uid: 'user_1',
      targetUid: 'user_1',
      target_type: 'users',
      target_id: 'user_1',
      result: 'success',
      metadata: { sweepRunId: 'sweep_123' },
      timestamp: 'MOCK_TIMESTAMP',
      created_at: 'MOCK_TIMESTAMP',
    });
  });

  it('nulls out omitted optional fields so queries stay consistent', async () => {
    const { db, set } = mockDb();
    await writeAuditLog(
      { action: 'subscription.expiry.sweep', actorUid: 'system:expireSubscriptions', result: 'success' },
      db as any
    );
    const [payload] = set.mock.calls[0];
    expect(payload.target_uid).toBeNull();
    expect(payload.target_type).toBeNull();
    expect(payload.target_id).toBeNull();
    expect(payload.message).toBeNull();
    expect(payload.metadata).toBeNull();
  });
});