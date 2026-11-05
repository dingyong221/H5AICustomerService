import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  loadDatabaseConfig,
  MySqlMarketplaceRepository,
  MySqlMerchantAccessRepository,
  MySqlAssistantLifecycleRepository,
  MySqlPlatformProvisioningRepository,
} from '../../packages/database/dist/index.js';
const url = new URL(process.env.H5CS_A6_TEST_MYSQL_URL ?? '');
if (
  url.hostname !== '127.0.0.1' ||
  url.port !== '33186' ||
  url.pathname !== '/h5cs_marketplace_a6_test' ||
  url.username !== 'h5cs_a6_test'
)
  throw Error('Dedicated test instance only');
const env = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  H5CS_MARKETPLACE_MODE: 'public-free',
  MYSQL_DATABASE_URL: url.href,
  MERCHANT_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
  H5CS_FREE_CAMPAIGN: 'test-' + randomBytes(8).toString('hex'),
  H5CS_FREE_DAYS: '30',
  H5CS_FREE_MODEL_CALLS: '3',
  H5CS_FREE_MAX_CLAIMS: '100',
};
const loaded = loadDatabaseConfig(env);
if (!loaded.configured) throw Error('Test database required');
const database = loaded.config,
  key = randomBytes(32).toString('base64url');
const repo = new MySqlMarketplaceRepository(database, key, env),
  access = new MySqlMerchantAccessRepository(database, key);
let counter = 0;
const input = () => ({
  merchantName: '合成自助开通测试',
  phone: '137' + String((Date.now() + counter++) % 100000000).padStart(8, '0'),
  password: randomBytes(24).toString('base64url'),
  requestId: randomUUID(),
});
async function sql(statement, values = []) {
  const c = await database.openConnection();
  try {
    return (await c.execute(statement, values))[0];
  } finally {
    await c.end();
  }
}
const hex = (value) => Buffer.from(value, 'hex');
const status = (id) =>
  sql(
    'SELECT e.* FROM marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product WHERE a.merchant_id=?',
    [hex(id)],
  );
function intercepted(hook) {
  return {
    ...database,
    openConnection: async () => {
      const c = await database.openConnection();
      return new Proxy(c, {
        get(target, property) {
          if (property === 'execute')
            return async (statement, values) => {
              if (hook === 'audit' && statement.includes('INSERT INTO audit_log'))
                throw Error('injected audit rollback');
              return target.execute(statement, values);
            };
          if (property === 'commit' && hook === 'lost-commit')
            return async () => {
              await target.commit();
              throw Error('injected acknowledgement loss');
            };
          const v = Reflect.get(target, property);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
}

test('public free registration creates exactly one managed unpublished assistant; repeat scan/password login preserves IDs and grant', async () => {
  const f = input(),
    a = await repo.claimFree(f),
    before = (await status(a.merchantId))[0];
  const b = await repo.claimFree({
    ...f,
    requestId: randomUUID(),
    merchantName: '不应覆盖原商家名称',
  });
  assert.equal(a.merchantId, b.merchantId);
  assert.equal(a.assistantId, b.assistantId);
  assert.equal(
    (await access.login({ phone: f.phone, password: f.password })).merchantId,
    a.merchantId,
  );
  const rows = await new MySqlAssistantLifecycleRepository(database).listMerchantAssistants(
    a.merchantUserId,
    a.merchantId,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activeReleaseId, null);
  assert.equal(rows[0].draft.industry, '');
  await assert.rejects(
    new MySqlAssistantLifecycleRepository(database).confirmDraftKnowledge({
      merchantId: a.merchantId,
      merchantUserId: a.merchantUserId,
      assistantId: a.assistantId,
      expectedDraftRevision: 1,
      now: new Date(),
    }),
  );
  assert.equal(
    (await sql('SELECT name FROM merchant WHERE id=?', [hex(a.merchantId)]))[0].name,
    f.merchantName,
  );
  const after = (await status(a.merchantId))[0];
  assert.deepEqual(after, before);
  await assert.rejects(repo.claimFree({ ...f, password: 'incorrect-existing-password' }), {
    code: 'authentication_failed',
  });
});

test('different concurrent requests for one account converge to one merchant/binding/allocation', async () => {
  const f = input();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => repo.claimFree({ ...f, requestId: randomUUID() })),
  );
  assert.equal(new Set(results.map((r) => r.merchantId)).size, 1);
  assert.equal(new Set(results.map((r) => r.assistantId)).size, 1);
  const id = hex(results[0].merchantId);
  assert.equal((await sql('SELECT COUNT(*) n FROM assistant WHERE merchant_id=?', [id]))[0].n, 1);
  assert.equal(
    (await sql('SELECT COUNT(*) n FROM merchant_assistant WHERE merchant_id=?', [id]))[0].n,
    1,
  );
});

test('failure before commit rolls back allocation and campaign count; lost commit acknowledgement retries the same allocation', async () => {
  const f = input(),
    before = (await sql('SELECT COUNT(*) n FROM merchant'))[0].n;
  await assert.rejects(
    new MySqlMarketplaceRepository(intercepted('audit'), key, env).claimFree(f),
    /injected audit/,
  );
  assert.equal((await sql('SELECT COUNT(*) n FROM merchant'))[0].n, before);
  await assert.rejects(
    new MySqlMarketplaceRepository(intercepted('lost-commit'), key, env).claimFree(f),
    { code: 'state_unknown' },
  );
  assert.equal((await sql('SELECT COUNT(*) n FROM merchant'))[0].n, before + 1);
  const a = await repo.claimFree(f);
  assert.equal(
    (await sql('SELECT COUNT(*) n FROM assistant WHERE merchant_id=?', [hex(a.merchantId)]))[0].n,
    1,
  );
});

test('quota is reserved atomically across all supplier operations and retries do not reset it', async () => {
  const f = input(),
    a = await repo.claimFree(f);
  const attempts = await Promise.allSettled(
    ['consumer', 'preview', 'writing', 'organize', 'preview'].map((operation) =>
      repo.reserveModelCall(a.merchantId, operation),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal((await status(a.merchantId))[0].model_calls_reserved, 3);
  await repo.claimFree(f);
  await assert.rejects(repo.reserveModelCall(a.merchantId, 'consumer'), {
    code: 'quota_exhausted',
  });
  assert.equal(
    (
      await sql(
        'SELECT COUNT(*) n FROM marketplace_model_attempt t JOIN marketplace_allocation a ON a.subject_digest=t.subject_digest AND a.product=t.product WHERE a.merchant_id=?',
        [hex(a.merchantId)],
      )
    )[0].n,
    3,
  );
});

test('expired or revoked rights block write sessions and model access; identity and fixed assistant survive restore', async () => {
  const f = input(),
    a = await repo.claimFree(f);
  for (const change of [
    "e.status='paused'",
    'e.expires_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY)',
  ]) {
    await sql(
      `UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET ${change} WHERE a.merchant_id=?`,
      [hex(a.merchantId)],
    );
    await assert.rejects(repo.reserveModelCall(a.merchantId, 'preview'), { code: 'not_eligible' });
    assert.equal(await access.resolveSession(a.sessionToken, a.merchantId), null);
    assert.equal(
      (await access.resolveSessionIdentity(a.sessionToken, a.merchantId)).merchantId,
      a.merchantId,
    );
    await assert.rejects(repo.claimFree(f), { code: 'not_eligible' });
    await sql(
      "UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET e.status='active', e.expires_at=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 DAY) WHERE a.merchant_id=?",
      [hex(a.merchantId)],
    );
  }
  assert.equal((await repo.claimFree(f)).assistantId, a.assistantId);
});

test('cross merchant session is rejected and later manual creation cannot create a second customer assistant', async () => {
  const a = await repo.claimFree(input()),
    b = await repo.claimFree(input());
  assert.equal(await access.resolveSession(a.sessionToken, b.merchantId), null);
  const repoLife = new MySqlAssistantLifecycleRepository(database);
  assert.equal(await repoLife.findManagementSnapshot(a.merchantId, b.assistantId), null);
  const row = (await repoLife.listMerchantAssistants(a.merchantUserId, a.merchantId))[0];
  assert.equal(row.assistantId, a.assistantId);
  const result = await repoLife.createManualDraft({
    merchantId: a.merchantId,
    merchantUserId: a.merchantUserId,
    displayName: '不应创建另一个',
    draft: {
      industry: '测试行业',
      businessScope: '测试服务',
      materialsSummary: '测试资料',
      pricingSummary: '价格待确认',
      promotionSummary: '暂无优惠',
      welcomeMessage: '我是AI客服',
      insufficientInfoMessage: '请联系商家',
    },
    idempotency: {
      actorScopeDigest: randomBytes(32),
      keyDigest: randomBytes(32),
      requestHash: randomBytes(32),
      expiresAt: new Date(Date.now() + 60000),
    },
    now: new Date(),
  });
  assert.equal(result.assistantId, a.assistantId);
  assert.equal(result.reusedExisting, true);
  assert.equal(result.publicSlug, row.publicSlug);
});

test('an existing authenticated owner reuses the current assistant and original data without choosing a historical draft', async () => {
  const f = input();
  const provision = await new MySqlPlatformProvisioningRepository(database).provisionMerchant({
    name: '原有合成商家',
    operatorId: 'local-verification',
    idempotencyKey: randomUUID(),
  });
  const session = await access.claimInvitation({
    setupToken: provision.setupToken,
    phone: f.phone,
    password: f.password,
  });
  const life = new MySqlAssistantLifecycleRepository(database);
  const original = await life.createManualDraft({
    merchantId: session.merchantId,
    merchantUserId: session.merchantUserId,
    displayName: '原客服',
    draft: {
      industry: '合成零售',
      businessScope: '零售服务',
      materialsSummary: '原商品资料不可覆盖',
      pricingSummary: '9元/件',
      promotionSummary: '暂无优惠',
      welcomeMessage: '我是AI客服',
      insufficientInfoMessage: '请联系商家',
    },
    idempotency: {
      actorScopeDigest: randomBytes(32),
      keyDigest: randomBytes(32),
      requestHash: randomBytes(32),
      expiresAt: new Date(Date.now() + 60000),
    },
    now: new Date(),
  });
  await assert.rejects(repo.claimFree(f), { code: 'existing_resources_require_selection' });
  const reused = await repo.claimFree({ ...f, reuseExisting: true });
  assert.equal(reused.assistantId, original.assistantId);
  assert.equal(reused.merchantId, session.merchantId);
  const after = await life.findManagementSnapshot(session.merchantId, original.assistantId);
  assert.deepEqual(after.draft, original.draft);
  assert.equal(after.publicSlug, original.publicSlug);
});

test('campaign cap and disabled free policy are enforced by backend; existing grants still return their original resources', async () => {
  const one = {
    ...env,
    H5CS_FREE_CAMPAIGN: 'cap-' + randomBytes(8).toString('hex'),
    H5CS_FREE_MAX_CLAIMS: '1',
  };
  const limited = new MySqlMarketplaceRepository(database, key, one),
    f = input();
  const a = await limited.claimFree(f);
  await assert.rejects(limited.claimFree(input()), { code: 'not_eligible' });
  assert.equal((await limited.claimFree(f)).assistantId, a.assistantId);
  const off = new MySqlMarketplaceRepository(database, key, { ...env, H5CS_MARKETPLACE_MODE: '' });
  await assert.rejects(off.claimFree(input()), { code: 'not_eligible' });
});
