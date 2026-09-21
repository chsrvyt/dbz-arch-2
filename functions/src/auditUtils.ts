/**
 * AUDIT LOGGING — server-side writes to `audit_logs`.
 *
 * Adds traceability for automated/system mutations (subscription expiry sweep,
 * scheduled jobs, administrative callables). The client app already writes its
 * own audit entries for user-visible actions; these helpers give the server
 * the same durable trail keyed on actor/target/timestamp.
 */
import * as admin from 'firebase-admin';

export interface AuditLogEntry {
  /** Machine-readable action id, e.g. `subscription.expiry.sweep`. */
  action: string;
  /** The authenticated user/system identity performing the action. */
  actorUid: string;
  /** The user record the action was performed against, if any. */
  targetUid?: string | null;
  /** Collection-ish label of the affected doc, if any (subscriptions, users). */
  targetType?: string | null;
  /** Id of the affected doc, if any. */
  targetId?: string | null;
  result: 'success' | 'error';
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Append an entry to `audit_logs`. Both snake_case (legacy server shape) and
 * camelCase (client shape) keys are written so any consumer can read it.
 * Returns the generated document id.
 */
export async function writeAuditLog(
  entry: AuditLogEntry,
  db?: admin.firestore.Firestore
): Promise<string> {
  const firestore = db ?? admin.firestore();
  const ref = firestore.collection('audit_logs').doc();
  const payload: Record<string, unknown> = {
    id: ref.id,
    action: entry.action,
    actor_uid: entry.actorUid,
    actorUid: entry.actorUid,
    target_uid: entry.targetUid ?? null,
    targetUid: entry.targetUid ?? null,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    result: entry.result,
    message: entry.message ?? null,
    metadata: entry.metadata ?? null,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  await ref.set(payload, { merge: true });
  return ref.id;
}