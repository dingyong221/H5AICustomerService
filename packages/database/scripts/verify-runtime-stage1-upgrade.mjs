import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import {
  database,
  publicSessions,
  publicSessionSigningSecret,
  seed,
  turn,
  sql,
  entitlement,
} from '../test/runtime-stage1-fixtures.mjs';
import {
  MySqlConversationTurnJobRepository,
  MySqlModelCallAttemptRepository,
} from '../dist/index.js';
import {
  snapshotTables,
  reviewedUpgradePlan,
  assertMigrationHistory,
} from './verify-ci-upgrade.mjs';

const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
const plan = await reviewedUpgradePlan();
const legacyReaderPath = process.env.H5CS_TEST_LEGACY_PUBLIC_READER;
if (!legacyReaderPath) throw new Error('Runner-extracted baseline public reader is required');
const legacyReaderModule = await import(pathToFileURL(legacyReaderPath).href);
const legacyPublicSessions = new legacyReaderModule.MySqlPublicSessionRepository(
  database,
  publicSessionSigningSecret,
);
const scratch = await mkdtemp(join(tmpdir(), 'h5cs-runtime-upgrade-'));
await mkdir(join(scratch, 'meta'));
const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
for (const entry of journal.entries.slice(0, 18))
  await copyFile(join(folder, `${entry.tag}.sql`), join(scratch, `${entry.tag}.sql`));
await writeFile(
  join(scratch, 'meta/_journal.json'),
  JSON.stringify({ ...journal, entries: journal.entries.slice(0, 18) }),
);
const connection = await database.openConnection();
try {
  const [empty] = await connection.query(
    `SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE()`,
  );
  assert.equal(Number(empty[0].n), 0, 'upgrade probe requires an empty, new isolated database');
  await migrate(drizzle({ client: connection }), { migrationsFolder: scratch });
  await assertMigrationHistory(connection, plan.entries.slice(0, 18));
  const jobs = new MySqlConversationTurnJobRepository(database),
    attempts = new MySqlModelCallAttemptRepository(database);
  // Even an empty old queue must fail schema readiness before any claim.
  await assert.rejects(
    () => jobs.listRunnableMerchantHeads(new Date()),
    (e) => e.code === 'ER_BAD_FIELD_ERROR',
  );
  await assert.rejects(
    () => attempts.unknownRiskCount(),
    (e) => e.code === 'ER_NO_SUCH_TABLE',
  );
  const pendingScope = await seed(),
    processingScope = await seed(),
    completedScope = await seed();
  const pending = await turn(pendingScope, { legacy: true });
  const processing = await turn(processingScope, { legacy: true });
  const completed = await turn(completedScope, { legacy: true });
  const oldHistory = await publicSessions.readHistory(
    pending.sessionHandle,
    pending.visitorNonce,
    new Date(),
  );
  const oldTurn = await publicSessions.readTurn(
    pending.sessionHandle,
    pending.visitorNonce,
    pending.turnId,
    new Date(),
  );
  assert.equal(oldTurn.state, 'accepted');
  assert.deepEqual(
    await legacyPublicSessions.readHistory(pending.sessionHandle, pending.visitorNonce, new Date()),
    oldHistory,
  );
  assert.deepEqual(
    await legacyPublicSessions.readTurn(
      pending.sessionHandle,
      pending.visitorNonce,
      pending.turnId,
      new Date(),
    ),
    oldTurn,
  );
  await sql(
    `UPDATE job SET state='processing',attempt=1,lease_owner='legacy_worker_owner',lease_until=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE id=UNHEX(?)`,
    [processing.jobId],
  );
  await sql(`UPDATE message SET state='processing' WHERE merchant_id=UNHEX(?)`, [
    processingScope.merchantId,
  ]);
  await sql(
    `UPDATE job SET state='completed',attempt=1,completed_at=UTC_TIMESTAMP(6) WHERE id=UNHEX(?)`,
    [completed.jobId],
  );
  await sql(
    `UPDATE message SET state='completed',completed_at=UTC_TIMESTAMP(6) WHERE merchant_id=UNHEX(?)`,
    [completedScope.merchantId],
  );
  await sql(`UPDATE conversation_session SET active_turn_id=NULL WHERE merchant_id=UNHEX(?)`, [
    completedScope.merchantId,
  ]);
  const subject = await entitlement(processingScope, 5);
  await sql(`UPDATE marketplace_entitlement SET model_calls_reserved=1 WHERE subject_digest=?`, [
    subject,
  ]);
  await sql(
    `INSERT INTO marketplace_model_attempt(id,subject_digest,product,operation,state,created_at) VALUES(?,?,'h5ai-self-service-v1','consumer','reserved_may_charge',UTC_TIMESTAMP(6))`,
    [randomBytes(16), subject],
  );
  const [tableRows] = await connection.query(
    `SELECT TABLE_NAME name FROM information_schema.tables WHERE table_schema=DATABASE() AND TABLE_NAME<>'__drizzle_migrations' ORDER BY TABLE_NAME`,
  );
  const oldTables = tableRows.map((row) => row.name);
  const before = await snapshotTables(connection, oldTables, { legacyJobProjection: true });
  await migrate(drizzle({ client: connection }), { migrationsFolder: folder });
  await assertMigrationHistory(connection, plan.entries);
  const after = await snapshotTables(connection, oldTables, { legacyJobProjection: true });
  assert.equal(
    after.sha256,
    before.sha256,
    'all old values and legacy schema are preserved outside the declared additive job columns',
  );
  assert.deepEqual(
    await publicSessions.readHistory(pending.sessionHandle, pending.visitorNonce, new Date()),
    oldHistory,
  );
  assert.deepEqual(
    await publicSessions.readTurn(
      pending.sessionHandle,
      pending.visitorNonce,
      pending.turnId,
      new Date(),
    ),
    oldTurn,
  );
  assert.deepEqual(
    await legacyPublicSessions.readHistory(pending.sessionHandle, pending.visitorNonce, new Date()),
    oldHistory,
  );
  assert.deepEqual(
    await legacyPublicSessions.readTurn(
      pending.sessionHandle,
      pending.visitorNonce,
      pending.turnId,
      new Date(),
    ),
    oldTurn,
  );
  const [receipts] = await connection.query(
    `SELECT LOWER(HEX(job_id)) job_id,state FROM model_call_attempt`,
  );
  assert.deepEqual(
    receipts.map((row) => ({ ...row })),
    [{ job_id: processing.jobId, state: 'unknown' }],
  );
  assert.equal(
    Number(
      (
        await sql(
          `SELECT model_calls_reserved n FROM marketplace_entitlement WHERE subject_digest=?`,
          [subject],
        )
      )[0].n,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await sql(`SELECT COUNT(*) n FROM marketplace_model_attempt WHERE subject_digest=?`, [
          subject,
        ])
      )[0].n,
    ),
    1,
  );
  assert.equal(await attempts.unknownRiskCount(), 1);
  assert.equal(
    await jobs.claimNext(new Date(), 'new_stage1_worker', {
      merchantId: processingScope.merchantId,
    }),
    null,
  );
  const pendingClaim = await jobs.claimNext(new Date(), 'new_stage1_worker', {
    merchantId: pendingScope.merchantId,
  });
  assert.equal(pendingClaim.jobId, pending.jobId);
  assert.equal(pendingClaim.payloadVersion, 0);
  assert.equal(pendingClaim.claimGeneration, '1');
  assert.equal(await jobs.complete(pendingClaim, '兼容旧发布资料：79元/台', new Date()), 'applied');
  const rollbackRead = await legacyPublicSessions.readTurn(
    pending.sessionHandle,
    pending.visitorNonce,
    pending.turnId,
    new Date(),
  );
  assert.equal(rollbackRead.state, 'completed');
  assert.equal(rollbackRead.messages.at(-1).content, '兼容旧发布资料：79元/台');
  const fullTables = [...oldTables, 'model_call_attempt'];
  const beforeReplay = await snapshotTables(connection, fullTables);
  await migrate(drizzle({ client: connection }), { migrationsFolder: folder });
  const afterReplay = await snapshotTables(connection, fullTables);
  assert.equal(afterReplay.sha256, beforeReplay.sha256);
  await assertMigrationHistory(connection, plan.entries);
  process.stdout.write(
    `${JSON.stringify(
      {
        kind: 'stage1-deployed-schema-upgrade',
        fromMigrations: 18,
        toMigrations: 19,
        legacyTables: oldTables.length,
        oldDataDigestBefore: before.sha256,
        oldDataDigestAfter: after.sha256,
        legacyProcessingUnknownReceipts: receipts.length,
        completedNotBackfilled: true,
        quotaNotReservedAgain: true,
        oldPendingPayloadDecoded: true,
        oldSchemaAdmissionRejected: true,
        publicReadAcrossUpgradeUnchanged: true,
        baselinePublicReaderAcrossUpgradeUnchanged: true,
        baselinePublicReaderSeesNewCompletedAnswer: true,
        replayDigest: afterReplay.sha256,
        replayUnchanged: true,
        scratchMigrationsPreserved: scratch,
        supplierCalled: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await connection.end();
}
