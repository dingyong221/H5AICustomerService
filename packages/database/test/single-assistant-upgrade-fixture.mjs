import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertSingleAssistantUpgrade } from '../scripts/migrate-managed.mjs';

// Called only by the isolated, empty-on-start, loopback integration runner.
export async function seedLegacySelectionProbe(connection) {
  const [rows] =
    await connection.query(`SELECT HEX(a.merchant_id) merchantId, HEX(a.id) assistantId,
    HEX(a.active_release_id) releaseId FROM assistant a WHERE a.active_release_id IS NOT NULL LIMIT 1`);
  assert.equal(rows.length, 1);
  const scope = rows[0];
  const draftId = randomBytes(16).toString('hex');
  const releaseId = randomBytes(16).toString('hex');
  const slug = 'a-' + randomBytes(18).toString('hex');
  await connection.execute(
    `INSERT INTO assistant (id,merchant_id,display_name,public_slug,public_slug_digest,status,draft_revision,created_at,updated_at)
    SELECT UNHEX(?),merchant_id,'合成旧草稿',?,UNHEX(SHA2(?,256)),'draft_only',1,DATE_SUB(created_at,INTERVAL 1 DAY),updated_at
    FROM assistant WHERE id=UNHEX(?)`,
    [draftId, slug, slug, scope.assistantId],
  );
  await connection.execute(
    `INSERT INTO assistant_draft (assistant_id,merchant_id,revision,config,validation,updated_by,updated_at)
    SELECT UNHEX(?),merchant_id,1,config,validation,updated_by,updated_at FROM assistant_draft WHERE assistant_id=UNHEX(?)`,
    [draftId, scope.assistantId],
  );
  await assertSingleAssistantUpgrade(connection);
  await connection.execute(
    `INSERT INTO assistant_release (id,merchant_id,assistant_id,release_no,draft_revision,status,config_snapshot,prompt_template_version,retrieval_policy_version,model_policy_version,created_by,created_at,activated_at)
    SELECT UNHEX(?),merchant_id,UNHEX(?),1,1,'retired',config_snapshot,prompt_template_version,retrieval_policy_version,model_policy_version,created_by,created_at,activated_at
    FROM assistant_release WHERE id=UNHEX(?)`,
    [releaseId, draftId, scope.releaseId],
  );
  await assert.rejects(
    () => assertSingleAssistantUpgrade(connection),
    /Multiple published assistants/u,
  );
  const [tables] = await connection.query("SHOW TABLES LIKE 'merchant_assistant'");
  assert.equal(tables.length, 0, 'ambiguous preflight must stop before new DDL');
  // Remove only this probe's synthetic release, never legacy rows or real data.
  await connection.execute(
    'DELETE FROM assistant_release WHERE id=UNHEX(?) AND assistant_id=UNHEX(?)',
    [releaseId, draftId],
  );
  await assertSingleAssistantUpgrade(connection);
  return { ...scope, draftId, slug, ambiguousStoppedBeforeDdl: true };
}

export async function assertLegacySelection(connection, probe) {
  const [rows] = await connection.execute(
    'SELECT HEX(assistant_id) assistantId FROM merchant_assistant WHERE merchant_id=UNHEX(?)',
    [probe.merchantId],
  );
  assert.equal(rows[0].assistantId, probe.assistantId);
  const [legacy] = await connection.execute(
    'SELECT COUNT(*) total FROM assistant WHERE merchant_id=UNHEX(?)',
    [probe.merchantId],
  );
  assert.equal(Number(legacy[0].total), 3, 'unissued legacy draft must remain intact');
  return { publishedChosen: true, legacyDraftRetained: true, ambiguousStoppedBeforeDdl: true };
}
