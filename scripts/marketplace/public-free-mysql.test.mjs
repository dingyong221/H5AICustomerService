import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  loadDatabaseConfig,
  MySqlMarketplaceRepository,
  MySqlMerchantAccessRepository,
  MySqlAssistantLifecycleRepository,
  MySqlPlatformProvisioningRepository,
  MySqlGrowthUsageRepository,
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

test('growth attribution is first-touch, new-allocation-only, transactional and tenant isolated; telemetry deduplicates safely', async () => {
  const environment = {
    ...env,
    H5CS_GROWTH_USAGE_ENABLED: 'true',
    H5CS_FREE_CAMPAIGN: 'growth-' + randomBytes(6).toString('hex'),
  };
  const accounts = new MySqlMarketplaceRepository(database, key, environment),
    growth = new MySqlGrowthUsageRepository(database);
  const ownerInput = input(),
    owner = await accounts.claimFree(ownerInput),
    other = await accounts.claimFree(input());
  await assert.rejects(growth.invitation(owner.merchantId, owner.merchantUserId, true));
  await assert.rejects(growth.invitation(owner.merchantId, other.merchantUserId, false));
  const code = randomBytes(32).toString('base64url'),
    otherCode = randomBytes(32).toString('base64url');
  await sql(
    `INSERT INTO growth_invitation (merchant_id,owner_id,public_code,status,created_at) VALUES (?,?,?,'active',UTC_TIMESTAMP(6)),(?,?,?,'active',UTC_TIMESTAMP(6))`,
    [
      hex(owner.merchantId),
      hex(owner.merchantUserId),
      code,
      hex(other.merchantId),
      hex(other.merchantUserId),
      otherCode,
    ],
  );
  const touch = await growth.touch(code);
  assert(touch);
  assert.equal((await growth.touch(otherCode, touch.token)).token, touch.token);
  assert.equal(await growth.touch('invalid'), null);
  const friendInput = { ...input(), growthTouch: touch.token };
  const friends = await Promise.all(
    Array.from({ length: 3 }, () =>
      accounts.claimFree({ ...friendInput, requestId: randomUUID() }),
    ),
  );
  assert(friends.every((f) => f.merchantId === friends[0].merchantId));
  let rows = await sql('SELECT inviter_id FROM growth_referral WHERE invitee_id=?', [
    hex(friends[0].merchantId),
  ]);
  assert.equal(rows.length, 1);
  assert(rows[0].inviter_id.equals(hex(owner.merchantId)));
  const otherTouch = await growth.touch(otherCode);
  await accounts.claimFree({
    ...friendInput,
    growthTouch: otherTouch.token,
    requestId: randomUUID(),
  });
  rows = await sql('SELECT inviter_id FROM growth_referral WHERE invitee_id=?', [
    hex(friends[0].merchantId),
  ]);
  assert(rows[0].inviter_id.equals(hex(owner.merchantId)));
  await accounts.claimFree({ ...ownerInput, growthTouch: touch.token, requestId: randomUUID() });
  assert.equal(
    (await sql('SELECT * FROM growth_referral WHERE invitee_id=?', [hex(owner.merchantId)])).length,
    0,
  );
  await sql(
    'UPDATE growth_touch SET expires_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY) WHERE token_digest=UNHEX(SHA2(?,256))',
    [otherTouch.token],
  );
  const expired = await accounts.claimFree({ ...input(), growthTouch: otherTouch.token });
  assert.equal(
    (await sql('SELECT * FROM growth_referral WHERE invitee_id=?', [hex(expired.merchantId)]))
      .length,
    0,
  );
  const identity = { role: 'merchant', actor: owner.merchantUserId, merchantId: owner.merchantId };
  const event = {
    id: randomUUID(),
    instance: randomUUID(),
    event: 'page_view',
    page: 'workspace',
    control: 'page',
    activeMs: 0,
    at: new Date().toISOString(),
  };
  assert.equal(await growth.collect(identity, [event]), 1);
  assert.equal(await growth.collect(identity, [event]), 0);
  await assert.rejects(growth.collect(identity, [{ ...event, activeMs: 1 }]));
  const report = await growth.usageReport();
  assert(report.days.length > 0);
  assert(report.retention.length > 0);
  assert.equal((await growth.invitationStats(owner.merchantId)).opened, 1);
});
const status = (id) =>
  sql(
    'SELECT e.* FROM marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product WHERE a.merchant_id=?',
    [hex(id)],
  );

test('explicit unlimited offer records attempts, preserves pause/revoke and can later become bounded without resetting resources', async () => {
  const unlimitedEnv = {
    ...env,
    H5CS_FREE_CAMPAIGN: 'unlimited-' + randomBytes(6).toString('hex'),
    H5CS_FREE_DAYS: 'unlimited',
    H5CS_FREE_MODEL_CALLS: 'unlimited',
    H5CS_FREE_MAX_CLAIMS: 'unlimited',
  };
  const unlimited = new MySqlMarketplaceRepository(database, key, unlimitedEnv);
  const owner = input(),
    account = await unlimited.claimFree(owner);
  assert.equal((await unlimited.quotaForMerchant(account.merchantId)).limit, null);
  assert.equal((await unlimited.quotaForMerchant(account.merchantId)).expiresAt, null);
  await Promise.all(
    Array.from({ length: 5 }, () => unlimited.reserveModelCall(account.merchantId, 'preview')),
  );
  assert.equal((await status(account.merchantId))[0].model_calls_reserved, 5);
  await sql(
    'UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET e.model_call_limit=5, e.expires_at=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 DAY) WHERE a.merchant_id=?',
    [hex(account.merchantId)],
  );
  await assert.rejects(unlimited.reserveModelCall(account.merchantId, 'preview'), {
    code: 'quota_exhausted',
  });
  await sql(
    "UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET e.model_call_limit=NULL, e.expires_at=NULL, e.status='paused' WHERE a.merchant_id=?",
    [hex(account.merchantId)],
  );
  await assert.rejects(unlimited.assertModelAccess(account.merchantId), { code: 'not_eligible' });
  await assert.rejects(unlimited.reserveModelCall(account.merchantId, 'preview'), {
    code: 'not_eligible',
  });
  assert.equal(await access.resolveSession(account.sessionToken), null);
  await sql(
    "UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET e.status='active' WHERE a.merchant_id=?",
    [hex(account.merchantId)],
  );
  const again = await unlimited.claimFree({ ...owner, requestId: randomUUID() });
  assert.equal(again.merchantId, account.merchantId);
  assert.equal(again.assistantId, account.assistantId);
  assert.equal((await status(account.merchantId))[0].model_calls_reserved, 5);
  await unlimited.reserveModelCall(account.merchantId, 'preview');
  assert.equal((await status(account.merchantId))[0].model_calls_reserved, 6);
  await sql('UPDATE marketplace_campaign SET claimed_count=10001 WHERE campaign=?', [
    unlimitedEnv.H5CS_FREE_CAMPAIGN,
  ]);
  await unlimited.claimFree(input());
  const bounded = new MySqlMarketplaceRepository(database, key, {
    ...unlimitedEnv,
    H5CS_FREE_MAX_CLAIMS: '100',
  });
  await assert.rejects(bounded.claimFree(input()), { code: 'not_eligible' });
});
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
