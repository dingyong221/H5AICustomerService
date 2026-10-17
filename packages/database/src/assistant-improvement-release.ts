import type { Connection } from 'mysql2/promise';

/** Called inside the lifecycle publish transaction, after its assistant lock. */
export async function bindVerifiedImprovementsToRelease(
  connection: Connection,
  input: {
    merchantId: Buffer;
    assistantId: Buffer;
    releaseId: Buffer;
    draftRevision: number;
    factsHash: Buffer;
    promptTemplateVersion: string;
    modelPolicyVersion: string;
    now: Date;
  },
): Promise<void> {
  await connection.execute(
    `UPDATE assistant_improvement i
       JOIN assistant_evaluation_run r
         ON r.merchant_id = i.merchant_id AND r.assistant_id = i.assistant_id
        AND r.improvement_id = i.id AND r.task_version = i.version
        SET i.published_release_id = ?, i.published_task_version = i.version, i.updated_at = ?
      WHERE i.merchant_id = ? AND i.assistant_id = ? AND i.applied_draft_revision IS NOT NULL
        AND r.draft_revision = ? AND r.facts_hash = ?
        AND r.prompt_template_version = ? AND r.model_policy_version = ?
        AND r.state = 'completed' AND r.verdict = 'pass'
        AND NOT EXISTS (
          SELECT 1 FROM assistant_evaluation_run newer
           WHERE newer.merchant_id = r.merchant_id AND newer.assistant_id = r.assistant_id
             AND newer.improvement_id = r.improvement_id
             AND (newer.created_at > r.created_at OR (newer.created_at = r.created_at AND newer.id > r.id))
        )`,
    [
      input.releaseId,
      input.now,
      input.merchantId,
      input.assistantId,
      input.draftRevision,
      input.factsHash,
      input.promptTemplateVersion,
      input.modelPolicyVersion,
    ],
  );
}
