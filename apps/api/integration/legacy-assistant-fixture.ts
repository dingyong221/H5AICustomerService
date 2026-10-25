import { randomBytes } from 'node:crypto';
import type { DatabaseConnectionConfig } from '@h5cs/database';
import { toAssistantId, toReleaseId } from '@h5cs/domain';

/** A retained pre-migration row, deliberately outside the merchant's current binding. */
export async function seedHistoricalSibling(
  database: DatabaseConnectionConfig,
  source: { merchantId: string; assistantId: string },
  sourceReleaseId?: string,
) {
  if (database.summary.host !== '127.0.0.1' || database.summary.database !== 'h5cs_integration_ci')
    throw new Error('Historical fixture requires the dedicated loopback integration target');
  const assistantId = toAssistantId(randomBytes(16).toString('hex'));
  const releaseId = toReleaseId(randomBytes(16).toString('hex'));
  const slug = 'a-' + randomBytes(18).toString('hex');
  const connection = await database.openConnection();
  try {
    await connection.execute(
      `INSERT INTO assistant (id,merchant_id,display_name,public_slug,public_slug_digest,status,draft_revision,created_at,updated_at)
      SELECT UNHEX(?),merchant_id,'保留的历史测试草稿',?,UNHEX(SHA2(?,256)),'draft_only',1,created_at,updated_at FROM assistant WHERE merchant_id=UNHEX(?) AND id=UNHEX(?)`,
      [assistantId, slug, slug, source.merchantId, source.assistantId],
    );
    await connection.execute(
      `INSERT INTO assistant_draft (assistant_id,merchant_id,revision,config,validation,updated_by,updated_at)
      SELECT UNHEX(?),merchant_id,1,config,validation,updated_by,updated_at FROM assistant_draft WHERE merchant_id=UNHEX(?) AND assistant_id=UNHEX(?)`,
      [assistantId, source.merchantId, source.assistantId],
    );
    if (sourceReleaseId)
      await connection.execute(
        `INSERT INTO assistant_release (id,merchant_id,assistant_id,release_no,draft_revision,status,config_snapshot,prompt_template_version,retrieval_policy_version,model_policy_version,created_by,created_at,activated_at)
        SELECT UNHEX(?),merchant_id,UNHEX(?),1,1,'retired',config_snapshot,prompt_template_version,retrieval_policy_version,model_policy_version,created_by,created_at,activated_at FROM assistant_release WHERE merchant_id=UNHEX(?) AND assistant_id=UNHEX(?) AND id=UNHEX(?)`,
        [releaseId, assistantId, source.merchantId, source.assistantId, sourceReleaseId],
      );
    return { assistantId, releaseId };
  } finally {
    await connection.end();
  }
}
