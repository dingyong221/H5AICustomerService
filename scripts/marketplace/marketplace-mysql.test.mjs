import { randomBytes, randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadDatabaseConfig,
  MySqlMarketplaceRepository,
  MySqlMerchantAccessRepository,
  MySqlAssistantLifecycleRepository,
  MySqlPlatformProvisioningRepository,
} from '../../packages/database/dist/index.js';

// This file cannot target production, an inherited business URL or a generic local database.
const url = process.env.H5CS_A6_TEST_MYSQL_URL;
if (!url) throw new Error('Explicit dedicated A6 test URL required');
const target = new URL(url);
if (
  target.protocol !== 'mysql:' ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '33186' ||
  target.pathname !== '/h5cs_marketplace_a6_test' ||
  target.username !== 'h5cs_a6_test' ||
  target.search ||
  target.hash
)
  throw new Error('Refusing a non-A6 test database');
const environment = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  H5CS_MARKETPLACE_MODE: 'local-fixture',
  MYSQL_DATABASE_URL: url,
  MERCHANT_PUBLIC_ORIGIN: 'http://127.0.0.1:3186',
};
const loaded = loadDatabaseConfig(environment);
if (!loaded.configured) throw new Error('A6 database required');
const database = loaded.config,
  key = randomBytes(32).toString('base64url');
const repo = new MySqlMarketplaceRepository(database, key, environment);
const access = new MySqlMerchantAccessRepository(database, key);
const password = 'SYNTHETIC-a6-only-password-001';
const digest = (value) => createHash('sha256').update(value).digest();
let counter = 0;
const phone = () =>
  `138${String((Date.now() % 100000000) + counter++)
    .padStart(8, '0')
    .slice(-8)}`;
async function fixture(modelCallLimit = 0) {
  const subject = `synthetic-${randomBytes(12).toString('hex')}`;
  return {
    subject,
    code: await repo.createSyntheticGrant({ subject, modelCallLimit }),
    phone: phone(),
    password,
    requestId: randomUUID(),
  };
}
async function sql(statement, values = []) {
  const connection = await database.openConnection();
  try {
    return (await connection.execute(statement, values))[0];
  } finally {
    await connection.end();
  }
}
function interceptedDatabase(hooks) {
  return {
    ...database,
    openConnection: async () => {
      const connection = await database.openConnection();
      return new Proxy(connection, {
        get(target, property) {
          if (property === 'execute')
            return async (statement, values) => {
              if (hooks.failAudit && statement.includes('INSERT INTO audit_log'))
                throw new Error('A6 injected audit failure');
              return target.execute(statement, values);
            };
          if (property === 'commit' && hooks.loseCommit)
            return async () => {
              await target.commit();
              throw new Error('A6 injected lost COMMIT acknowledgement');
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

test('real MySQL: default-zero grant creates one unfilled unpublished assistant; retries and new request keys reuse IDs', async () => {
  const f = await fixture(),
    first = await repo.claimSynthetic(f);
  const next = await repo.claimSynthetic({ ...f, requestId: randomUUID() });
  assert.equal(next.merchantId, first.merchantId);
  assert.equal(next.assistantId, first.assistantId);
  assert.equal((await access.login({ phone: f.phone, password })).merchantId, first.merchantId);
  const row = (
    await sql('SELECT status, active_release_id FROM assistant WHERE id = ?', [
      Buffer.from(first.assistantId, 'hex'),
    ])
  )[0];
  assert.equal(row.status, 'draft_only');
  assert.equal(row.active_release_id, null);
  const snapshot = await new MySqlAssistantLifecycleRepository(database).findManagementSnapshot(
    first.merchantId,
    first.assistantId,
  );
  assert.equal(snapshot.draft.industry, '');
  assert.equal(snapshot.draft.pricingSummary, '');
  assert.equal(snapshot.knowledgeConfirmed, false);
  await assert.rejects(repo.reserveModelCall(first.merchantId, 'consumer'), {
    code: 'quota_exhausted',
  });
});

test('real MySQL: same subject with different codes and request IDs converges under concurrency', async () => {
  const f = await fixture(),
    code2 = await repo.createSyntheticGrant({ subject: f.subject });
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      repo.claimSynthetic({ ...f, code: index % 2 ? code2 : f.code, requestId: randomUUID() }),
    ),
  );
  assert.equal(new Set(results.map((x) => x.merchantId)).size, 1);
  assert.equal(new Set(results.map((x) => x.assistantId)).size, 1);
  const count = (
    await sql('SELECT COUNT(*) total FROM marketplace_allocation WHERE merchant_user_id = ?', [
      Buffer.from(results[0].merchantUserId, 'hex'),
    ])
  )[0];
  assert.equal(Number(count.total), 1);
});

test('real MySQL: wrong password, another subject on same account and cross-merchant session are denied', async () => {
  const a = await fixture(),
    b = await fixture(),
    first = await repo.claimSynthetic(a),
    second = await repo.claimSynthetic(b);
  await assert.rejects(repo.claimSynthetic({ ...a, password: password + 'wrong' }), {
    code: 'authentication_failed',
  });
  await assert.rejects(repo.claimSynthetic({ ...b, phone: a.phone }), { code: 'binding_conflict' });
  assert.equal(await access.resolveSession(first.sessionToken, second.merchantId), null);
  assert.equal(await access.resolveSessionIdentity(first.sessionToken, second.merchantId), null);
});

test('real MySQL: expired, future and revoked grants reject old sessions/claim; resume preserves allocation', async () => {
  const f = await fixture(),
    first = await repo.claimSynthetic(f);
  const parameters = [digest(f.code)];
  for (const change of [
    "e.status = 'revoked'",
    'e.expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 DAY)',
    'e.valid_from = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 DAY)',
  ]) {
    await sql(
      `UPDATE marketplace_entitlement e JOIN marketplace_claim_code c ON c.subject_digest = e.subject_digest AND c.product = e.product SET ${change} WHERE c.code_digest = ?`,
      parameters,
    );
    await assert.rejects(repo.claimSynthetic(f), { code: 'not_eligible' });
    await assert.rejects(repo.reserveModelCall(first.merchantId, 'preview'), {
      code: 'not_eligible',
    });
    assert.equal(await access.resolveSession(first.sessionToken, first.merchantId), null);
    assert.equal(
      (await access.resolveSessionIdentity(first.sessionToken, first.merchantId))?.merchantId,
      first.merchantId,
    );
    await sql(
      `UPDATE marketplace_entitlement e JOIN marketplace_claim_code c ON c.subject_digest = e.subject_digest AND c.product = e.product SET e.status = 'active', e.valid_from = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 MINUTE), e.expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 DAY) WHERE c.code_digest = ?`,
      parameters,
    );
  }
  assert.equal((await repo.claimSynthetic(f)).assistantId, first.assistantId);
});

test('real MySQL: audit failure rolls back all new resources; retry recovers without orphans', async () => {
  const f = await fixture(),
    before = (await sql('SELECT COUNT(*) total FROM merchant'))[0].total;
  const failing = new MySqlMarketplaceRepository(
    interceptedDatabase({ failAudit: true }),
    key,
    environment,
  );
  await assert.rejects(failing.claimSynthetic(f), /injected audit failure/);
  assert.equal((await sql('SELECT COUNT(*) total FROM merchant'))[0].total, before);
  const first = await repo.claimSynthetic(f),
    retry = await repo.claimSynthetic(f);
  assert.equal(first.merchantId, retry.merchantId);
});

test('real MySQL: a lost COMMIT acknowledgement is unknown; a later authenticated retry reads the committed allocation', async () => {
  const f = await fixture();
  const uncertain = new MySqlMarketplaceRepository(
    interceptedDatabase({ loseCommit: true }),
    key,
    environment,
  );
  await assert.rejects(uncertain.claimSynthetic(f), { code: 'state_unknown' });
  const first = await repo.claimSynthetic(f),
    next = await repo.claimSynthetic({ ...f, requestId: randomUUID() });
  assert.equal(first.merchantId, next.merchantId);
  assert.equal(
    Number(
      (
        await sql('SELECT COUNT(*) total FROM assistant WHERE merchant_id = ?', [
          Buffer.from(first.merchantId, 'hex'),
        ])
      )[0].total,
    ),
    1,
  );
});

test('real MySQL: lifetime fixture quota reserves at most two concurrent supplier attempts and is not reset by reissuing codes', async () => {
  const f = await fixture(2),
    first = await repo.claimSynthetic(f);
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => repo.reserveModelCall(first.merchantId, 'preview')),
  );
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 2);
  await repo.createSyntheticGrant({ subject: f.subject, modelCallLimit: 10 });
  await assert.rejects(repo.reserveModelCall(first.merchantId, 'writing'), {
    code: 'quota_exhausted',
  });
  const counters = (
    await sql(
      'SELECT model_calls_reserved FROM marketplace_entitlement e JOIN marketplace_claim_code c ON c.subject_digest = e.subject_digest AND c.product = e.product WHERE c.code_digest = ?',
      [digest(f.code)],
    )
  )[0];
  assert.equal(counters.model_calls_reserved, 2);
});

async function legacyFixture(assistantCount) {
  const f = await fixture(),
    provision = await new MySqlPlatformProvisioningRepository(database).provisionMerchant({
      name: 'A6 合成存量商家',
      operatorId: 'a6-synthetic',
      idempotencyKey: randomUUID(),
    });
  const session = await access.claimInvitation({
    setupToken: provision.setupToken,
    phone: f.phone,
    password,
  });
  const lifecycle = new MySqlAssistantLifecycleRepository(database),
    snapshots = [];
  for (let index = 0; index < assistantCount; index++)
    snapshots.push(
      await lifecycle.createManualDraft({
        merchantId: session.merchantId,
        merchantUserId: session.merchantUserId,
        displayName: `合成旧客服${index}`,
        draft: {
          industry: '合成测试',
          businessScope: '合成资料',
          materialsSummary: '合成商品',
          pricingSummary: '价格待核查',
          promotionSummary: '优惠待核查',
          welcomeMessage: '我是 AI 客服',
          insufficientInfoMessage: '请联系合成商家',
        },
        idempotency: {
          actorScopeDigest: digest(session.merchantUserId),
          keyDigest: digest(randomUUID()),
          requestHash: digest(String(index)),
          expiresAt: new Date(Date.now() + 60000),
        },
        now: new Date(),
      }),
    );
  return { f, session, snapshots };
}

test('real MySQL: authenticated existing owner explicitly reuses the same merchant and assistant without changing draft or slug', async () => {
  const { f, session, snapshots } = await legacyFixture(1);
  await assert.rejects(repo.claimSynthetic(f), { code: 'existing_resources_require_selection' });
  const result = await repo.claimSynthetic({ ...f, reuseExisting: true });
  assert.equal(result.merchantId, session.merchantId);
  assert.equal(result.assistantId, snapshots[0].assistantId);
  const after = await new MySqlAssistantLifecycleRepository(database).findManagementSnapshot(
    result.merchantId,
    result.assistantId,
  );
  assert.equal(after.publicSlug, snapshots[0].publicSlug);
  assert.deepEqual(after.draft, snapshots[0].draft);
});

test('real MySQL: the current binding is reused while an unissued historical row is preserved', async () => {
  const { f, session, snapshots } = await legacyFixture(1);
  const { insertAssistantDraftRecords } =
    await import('../../packages/database/dist/assistant-draft-records.js');
  const c = await database.openConnection();
  try {
    await insertAssistantDraftRecords(c, {
      assistantId: randomBytes(16),
      merchantId: Buffer.from(session.merchantId, 'hex'),
      merchantUserId: Buffer.from(session.merchantUserId, 'hex'),
      displayName: '合成历史未发布草稿',
      slug: 'a-' + randomBytes(18).toString('hex'),
      draft: snapshots[0].draft,
      now: new Date(),
    });
  } finally {
    await c.end();
  }
  const claimed = await repo.claimSynthetic({ ...f, reuseExisting: true });
  assert.equal(claimed.assistantId, snapshots[0].assistantId);
  const after = await new MySqlAssistantLifecycleRepository(database).listMerchantAssistants(
    session.merchantUserId,
    session.merchantId,
  );
  assert.deepEqual(
    after.map((x) => x.publicSlug).sort(),
    snapshots.map((x) => x.publicSlug).sort(),
  );
  assert.equal(
    (
      await sql('SELECT COUNT(*) n FROM assistant WHERE merchant_id=?', [
        Buffer.from(session.merchantId, 'hex'),
      ])
    )[0].n,
    2,
  );
});

test('real MySQL: grant eligibility uses the database clock despite application clock skew', async () => {
  const f = await fixture(1),
    ActualDate = globalThis.Date;
  // Only this isolated test process is skewed; do not alter Windows or MySQL time.
  class SkewedDate extends ActualDate {
    constructor(...args) {
      if (args.length === 0) super(ActualDate.now() + 10 * 86400000);
      else super(...args);
    }
    static now() {
      return ActualDate.now() + 10 * 86400000;
    }
  }
  try {
    globalThis.Date = SkewedDate;
    const result = await repo.claimSynthetic(f);
    assert.equal((await repo.quotaForMerchant(result.merchantId)).state, 'active');
    await repo.reserveModelCall(result.merchantId, 'preview');
  } finally {
    globalThis.Date = ActualDate;
  }
});
