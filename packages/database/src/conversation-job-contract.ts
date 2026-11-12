import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { ConversationTurnClaim } from './conversation-turn-job-repository.js';

export type ClaimMutationResult = 'applied' | 'stale';
export type ModelCallOutcome = 'none' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'not_dispatched';
export class ConversationTurnJobError extends Error {
  public constructor(message = 'Conversation turn job is unavailable', public readonly code = 'INVALID_JOB') {
    super(message);
    this.name = 'ConversationTurnJobError';
  }
}
export const jobBytes = (value: string): Buffer => {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new ConversationTurnJobError();
  return Buffer.from(value, 'hex');
};
export const jobObject = (value: string | Record<string, unknown>): Record<string, unknown> => {
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new ConversationTurnJobError(); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConversationTurnJobError();
  return parsed as Record<string, unknown>;
};
export const decodeConversationTaskPayload = (value: string | Record<string, unknown>) => {
  const payload = jobObject(value);
  const version = payload['schemaVersion'];
  if (version !== undefined && (version !== 1 || payload['handlerVersion'] !== 'conversation-v1')) {
    throw new ConversationTurnJobError('Unsupported conversation task version', 'UNSUPPORTED_JOB_VERSION');
  }
  for (const name of ['merchantId', 'assistantId', 'sessionId', 'releaseId'] as const) {
    if (typeof payload[name] !== 'string') throw new ConversationTurnJobError();
  }
  if (typeof payload['turnId'] !== 'string' || !/^t_[0-9a-f]{32}$/u.test(payload['turnId'])) throw new ConversationTurnJobError();
  return {
    merchantId: jobBytes(payload['merchantId'] as string),
    assistantId: jobBytes(payload['assistantId'] as string),
    sessionId: jobBytes(payload['sessionId'] as string),
    releaseId: jobBytes(payload['releaseId'] as string),
    turnId: jobBytes(payload['turnId'].slice(2)),
    payloadVersion: (version === undefined ? 0 : 1) as 0 | 1,
  };
};
export const conversationClaimIds = (claim: ConversationTurnClaim) => {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(claim.leaseOwner) ||
      !/^[1-9][0-9]{0,19}$/u.test(claim.claimGeneration) ||
      BigInt(claim.claimGeneration) > 18_446_744_073_709_551_615n) throw new ConversationTurnJobError();
  return {
    jobId: jobBytes(claim.jobId), merchantId: jobBytes(claim.merchantId),
    assistantId: jobBytes(claim.assistantId), sessionId: jobBytes(claim.sessionId),
    releaseId: jobBytes(claim.releaseId), turnId: jobBytes(claim.turnId),
    visitorMessageId: jobBytes(claim.visitorMessageId),
  };
};
export type LockedConversationJob = RowDataPacket & {
  id: Buffer; merchant_id: Buffer | null; payload: string | Record<string, unknown>;
  state: string; lease_owner: string | null; lease_until: Date | null;
  claim_generation: string; model_outcome: ModelCallOutcome; model_attempt_id: Buffer | null;
};
export async function lockValidConversationClaim(connection: Connection, claim: ConversationTurnClaim, now: Date) {
  if (!Number.isFinite(now.getTime())) throw new ConversationTurnJobError();
  const ids = conversationClaimIds(claim);
  const [rows] = await connection.execute<LockedConversationJob[]>(
    `SELECT id, merchant_id, payload, state, lease_owner, lease_until,
            CAST(claim_generation AS CHAR) claim_generation, model_outcome, model_attempt_id
       FROM job WHERE id = ? AND type = 'conversation.turn' LIMIT 1 FOR UPDATE`, [ids.jobId]);
  const job = rows[0];
  if (!job || job.state !== 'processing' || job.lease_owner !== claim.leaseOwner ||
      String(job.claim_generation) !== claim.claimGeneration || !job.lease_until || job.lease_until <= now ||
      !job.merchant_id?.equals(ids.merchantId)) return null;
  let stored: ReturnType<typeof decodeConversationTaskPayload>;
  try { stored = decodeConversationTaskPayload(job.payload); } catch { return null; }
  if (stored.payloadVersion !== claim.payloadVersion ||
      !stored.merchantId.equals(ids.merchantId) || !stored.assistantId.equals(ids.assistantId) ||
      !stored.sessionId.equals(ids.sessionId) || !stored.releaseId.equals(ids.releaseId) || !stored.turnId.equals(ids.turnId)) return null;
  const [messages] = await connection.execute<(RowDataPacket & { id: Buffer })[]>(
    `SELECT id FROM message WHERE id = ? AND merchant_id = ? AND assistant_id = ?
       AND session_id = ? AND turn_id = ? AND role = 'visitor' AND state = 'processing' LIMIT 1 FOR UPDATE`,
    [ids.visitorMessageId, ids.merchantId, ids.assistantId, ids.sessionId, ids.turnId]);
  return messages[0] ? { job, ids } : null;
}
