import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import {
  KnowledgeMaterialAccessError,
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlKnowledgeMaterialRepository,
  MySqlMerchantAccessRepository,
  MySqlPlatformProvisioningRepository,
} from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId } from '@h5cs/domain';

// Fail closed: these synthetic fixtures may only use the disposable loopback CI database.
const url = process.env['H5CS_INTEGRATION_MYSQL_URL'];
if (!url) throw new Error('Dedicated integration database required');
const target = new URL(url);
if (
  target.protocol !== 'mysql:' ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  target.pathname !== '/h5cs_integration_ci' ||
  target.username !== 'h5cs_ci' ||
  target.search ||
  target.hash
)
  throw new Error('Material deletion fixtures must never run against merchant databases');
const loaded = loadDatabaseConfig({ MYSQL_DATABASE_URL: url, NODE_ENV: 'test', APP_ENV: 'test' });
if (!loaded.configured) throw new Error('Dedicated database unavailable');
const database = loaded.config;
const repository = new MySqlKnowledgeMaterialRepository(database);
const lifecycle = new MySqlAssistantLifecycleRepository(database);
const idem = () => ({
  actorScopeDigest: randomBytes(32),
  keyDigest: randomBytes(32),
  requestHash: randomBytes(32),
  expiresAt: new Date(Date.now() + 3_600_000),
});
const draft = {
  industry: '电商零售',
  businessScope: '合成测试商品咨询',
  materialsSummary: 'SYNTHETIC 商品A 29元，商品B 39元，仅测试使用。',
  pricingSummary: '商品A 29元，商品B 39元',
  promotionSummary: '暂无优惠',
  welcomeMessage: '您好，我是AI客服。',
  insufficientInfoMessage: '请联系商家确认。',
};
async function fixture() {
  const provisioned = await new MySqlPlatformProvisioningRepository(database).provisionMerchant({
    name: `MATERIAL_DELETE_SYNTHETIC_${randomBytes(8).toString('hex')}`,
    operatorId: 'material_delete_ci',
  });
  const account = await new MySqlMerchantAccessRepository(
    database,
    randomBytes(32).toString('base64url'),
  ).claimInvitation({
    setupToken: provisioned.setupToken,
    phone: `139${String(randomInt(0, 100_000_000)).padStart(8, '0')}`,
    password: randomBytes(24).toString('base64url'),
  });
  const merchantId = toMerchantId(provisioned.id),
    merchantUserId = toMerchantUserId(account.merchantUserId);
  const created = await lifecycle.createManualDraft({
    merchantId,
    merchantUserId,
    displayName: '材料删除合成测试客服',
    draft,
    idempotency: idem(),
    now: new Date(),
  });
  const assistantId = toAssistantId(created.assistantId);
  return { merchantId, userId: merchantUserId, merchantUserId, assistantId, created };
}
async function sql(query: string, values: (string | Buffer)[]) {
  const connection = await database.openConnection();
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(query, values);
    return rows;
  } finally {
    await connection.end();
  }
}
const bytes = (id: string) => Buffer.from(id, 'hex');
async function material(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  const text = `SYNTHETIC ${name} 已核对商品资料`;
  return repository.save({
    ...f,
    name,
    text,
    size: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
}

describe('real MySQL uploaded material soft deletion', () => {
  it('serializes duplicate imports within one assistant, isolates equal text in another merchant, and never reuses archived sources', async () => {
    const a = await fixture(),
      b = await fixture();
    const text = 'SYNTHETIC DUPLICATE 保温杯39元/件，单件新疆运费15元；其他地区需确认。';
    const input = {
      ...a,
      name: '商品表原件.csv',
      text,
      size: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    };
    const result = await Promise.all([
      repository.saveWithResult(input),
      repository.saveWithResult({ ...input, name: '商品表再次导入.csv' }),
    ]);
    expect(result[0]!.id).toBe(result[1]!.id);
    expect(result.map((x) => x.reused).sort()).toEqual([false, true]);
    expect(await repository.list(a.merchantId, a.assistantId, a.userId)).toHaveLength(1);
    const other = await repository.saveWithResult({ ...input, ...b });
    expect(other.reused).toBe(false);
    expect(other.id).not.toBe(result[0]!.id);
    await lifecycle.confirmDraftKnowledge({ ...a, expectedDraftRevision: 1, now: new Date() });
    await sql(
      "UPDATE merchant_membership SET role='viewer' WHERE merchant_id=? AND merchant_user_id=?",
      [bytes(a.merchantId), bytes(a.userId)],
    );
    await expect(
      repository.assertEditable(a.merchantId, a.assistantId, a.userId),
    ).rejects.toBeInstanceOf(KnowledgeMaterialAccessError);
    const readonlyBefore = await lifecycle.findManagementSnapshot(a.merchantId, a.assistantId);
    await expect(
      lifecycle.saveDraft({
        ...a,
        draft: { ...draft, materialsSummary: 'viewer不得写入' },
        expectedRevision: 1,
        now: new Date(),
      }),
    ).rejects.toThrow();
    await expect(
      lifecycle.confirmDraftKnowledge({ ...a, expectedDraftRevision: 1, now: new Date() }),
    ).rejects.toThrow();
    await expect(
      lifecycle.createManualDraft({
        ...a,
        displayName: 'viewer不得创建',
        draft,
        idempotency: idem(),
        now: new Date(),
      }),
    ).rejects.toThrow();
    await expect(
      lifecycle.publish({
        ...a,
        expectedDraftRevision: 1,
        promptTemplateVersion: 'material-ci-v1',
        modelPolicyVersion: 'material-ci-v1',
        retrievalPolicyVersion: 'material-ci-v1',
        idempotency: idem(),
        now: new Date(),
      }),
    ).rejects.toThrow();
    expect(await lifecycle.findManagementSnapshot(a.merchantId, a.assistantId)).toEqual(
      readonlyBefore,
    );
    await sql(
      "UPDATE merchant_membership SET role='owner' WHERE merchant_id=? AND merchant_user_id=?",
      [bytes(a.merchantId), bytes(a.userId)],
    );
    await expect(
      repository.assertEditable(a.merchantId, a.assistantId, a.userId),
    ).resolves.toBeUndefined();
    await expect(repository.archive({ ...a, sourceId: other.id })).rejects.toBeInstanceOf(
      KnowledgeMaterialAccessError,
    );
    await repository.archive({ ...a, sourceId: result[0]!.id });
    const restored = await repository.saveWithResult(input);
    expect(restored.reused).toBe(false);
    expect(restored.id).not.toBe(result[0]!.id);
    expect((await repository.list(a.merchantId, a.assistantId, a.userId)).map((x) => x.id)).toEqual(
      [restored.id],
    );
    expect(
      (await lifecycle.findManagementSnapshot(a.merchantId, a.assistantId))?.draftRevision,
    ).toBe(1);
    expect(await lifecycle.findPublicSnapshot(a.created.publicSlug)).toBeNull();
  });
  it('atomically authorizes the exact source, archives idempotently, preserves release/draft/URL, and rolls back a failed audit', async () => {
    const a = await fixture(),
      b = await fixture();
    const sourceA = await material(a, '商品A.txt'),
      sourceB = await material(a, '商品B.txt');
    await lifecycle.confirmDraftKnowledge({ ...a, expectedDraftRevision: 1, now: new Date() });
    await lifecycle.publish({
      ...a,
      expectedDraftRevision: 1,
      promptTemplateVersion: 'material-ci-v1',
      modelPolicyVersion: 'material-ci-v1',
      retrievalPolicyVersion: 'material-ci-v1',
      idempotency: idem(),
      now: new Date(),
    });
    const managementBefore = await lifecycle.findManagementSnapshot(a.merchantId, a.assistantId);
    const publicBefore = await lifecycle.findPublicSnapshot(a.created.publicSlug);
    const revisionBefore = await sql(
      'SELECT source_metadata,content_hash FROM knowledge_revision WHERE merchant_id=? AND assistant_id=? AND source_id=?',
      [bytes(a.merchantId), bytes(a.assistantId), bytes(sourceA)],
    );

    // B is authorized for its own assistant but cannot remove A's material, even knowing the ID.
    await expect(repository.archive({ ...b, sourceId: sourceA })).rejects.toBeInstanceOf(
      KnowledgeMaterialAccessError,
    );
    const sibling = await lifecycle.createManualDraft({
      ...a,
      displayName: '同商家另一客服',
      draft,
      idempotency: idem(),
      now: new Date(),
    });
    await expect(
      repository.archive({ ...a, assistantId: sibling.assistantId, sourceId: sourceA }),
    ).rejects.toBeInstanceOf(KnowledgeMaterialAccessError);
    await expect(
      repository.archive({ ...a, sourceId: randomBytes(16).toString('hex') }),
    ).rejects.toBeInstanceOf(KnowledgeMaterialAccessError);

    // Active membership is insufficient for viewers, revoked users or disabled tenants.
    await sql(
      "UPDATE merchant_membership SET role='viewer' WHERE merchant_id=? AND merchant_user_id=?",
      [bytes(a.merchantId), bytes(a.userId)],
    );
    await expect(repository.archive({ ...a, sourceId: sourceA })).rejects.toBeInstanceOf(
      KnowledgeMaterialAccessError,
    );
    await sql(
      "UPDATE merchant_membership SET role='editor' WHERE merchant_id=? AND merchant_user_id=?",
      [bytes(a.merchantId), bytes(a.userId)],
    );
    await sql("UPDATE merchant_user SET status='disabled' WHERE id=?", [bytes(a.userId)]);
    await expect(repository.archive({ ...a, sourceId: sourceA })).rejects.toBeInstanceOf(
      KnowledgeMaterialAccessError,
    );
    await sql("UPDATE merchant_user SET status='active' WHERE id=?", [bytes(a.userId)]);
    await sql("UPDATE merchant SET status='disabled' WHERE id=?", [bytes(a.merchantId)]);
    await expect(repository.archive({ ...a, sourceId: sourceA })).rejects.toBeInstanceOf(
      KnowledgeMaterialAccessError,
    );
    await sql("UPDATE merchant SET status='active' WHERE id=?", [bytes(a.merchantId)]);

    await Promise.all([
      repository.archive({ ...a, sourceId: sourceA }),
      repository.archive({ ...a, sourceId: sourceA }),
    ]);
    await repository.archive({ ...a, sourceId: sourceA });
    expect(
      (await repository.list(a.merchantId, a.assistantId, a.userId)).map((item) => item.id),
    ).toEqual([sourceB]);
    expect(await lifecycle.findManagementSnapshot(a.merchantId, a.assistantId)).toEqual(
      managementBefore,
    );
    expect(await lifecycle.findPublicSnapshot(a.created.publicSlug)).toEqual(publicBefore);
    expect(
      await sql(
        'SELECT source_metadata,content_hash FROM knowledge_revision WHERE merchant_id=? AND assistant_id=? AND source_id=?',
        [bytes(a.merchantId), bytes(a.assistantId), bytes(sourceA)],
      ),
    ).toEqual(revisionBefore);
    expect(
      (
        await sql(
          'SELECT status FROM knowledge_source WHERE merchant_id=? AND assistant_id=? AND id=?',
          [bytes(a.merchantId), bytes(a.assistantId), bytes(sourceA)],
        )
      )[0]?.status,
    ).toBe('archived');
    expect(
      await sql(
        "SELECT actor_id,target_id FROM audit_log WHERE merchant_id=? AND action='knowledge.material_archive' AND target_id=?",
        [bytes(a.merchantId), sourceA],
      ),
    ).toEqual([expect.objectContaining({ actor_id: a.userId, target_id: sourceA })]);

    // Inject only an audit-write failure around a genuine MySQL transaction: the source UPDATE must roll back.
    const auditFailure = new MySqlKnowledgeMaterialRepository({
      ...database,
      openConnection: async () => {
        const connection = await database.openConnection();
        return new Proxy(connection, {
          get(targetConnection, property) {
            if (property === 'execute')
              return async (query: string, values: Parameters<Connection['execute']>[1]) => {
                if (query.includes('knowledge.material_archive'))
                  throw new Error('SYNTHETIC audit unavailable');
                return targetConnection.execute(query, values);
              };
            const value: unknown = Reflect.get(targetConnection, property);
            return typeof value === 'function' ? value.bind(targetConnection) : value;
          },
        }) as Connection;
      },
    });
    await expect(auditFailure.archive({ ...a, sourceId: sourceB })).rejects.toThrow(
      'SYNTHETIC audit unavailable',
    );
    expect(
      (await repository.list(a.merchantId, a.assistantId, a.userId)).map((item) => item.id),
    ).toEqual([sourceB]);
    expect(
      await sql(
        "SELECT id FROM audit_log WHERE merchant_id=? AND action='knowledge.material_archive' AND target_id=?",
        [bytes(a.merchantId), sourceB],
      ),
    ).toEqual([]);
  });
});
