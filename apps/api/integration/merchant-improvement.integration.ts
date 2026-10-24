import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loadDatabaseConfig,
  MySqlAssistantImprovementRepository,
  MySqlAssistantLifecycleRepository,
  MySqlConversationTurnJobRepository,
  MySqlMerchantAccessRepository,
  MySqlPlatformProvisioningRepository,
  MySqlPublicSessionRepository,
} from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { approveSyntheticPreview } from './governance-fixture.js';

// These assertions exercise genuine MySQL constraints and transactions. The answers below
// are deterministic fixtures, not evidence of actual model quality or consumer resolution.
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
) {
  throw new Error('Never run improvement tests against merchant databases');
}
const config = loadDatabaseConfig({ MYSQL_DATABASE_URL: url, NODE_ENV: 'test', APP_ENV: 'test' });
if (!config.configured) throw new Error('Dedicated database unavailable');
const database = config.config;
const policy = { promptTemplateVersion: 'iteration-v1', modelPolicyVersion: 'iteration-v1' };
const assistants = new MySqlAssistantLifecycleRepository(database);
const improvements = new MySqlAssistantImprovementRepository(database, policy);
const idem = () => ({
  actorScopeDigest: randomBytes(32),
  keyDigest: randomBytes(32),
  requestHash: randomBytes(32),
  expiresAt: new Date(Date.now() + 3_600_000),
});
const write = <T extends object>(input: T) => ({
  ...input,
  requestKey: randomUUID(),
  now: new Date(),
});

async function fixture() {
  const provisioner = new MySqlPlatformProvisioningRepository(database);
  const merchant = await provisioner.provisionMerchant({
    name: `改善闭环合成商家 ${randomBytes(4).toString('hex')}`,
    operatorId: 'iteration_test',
  });
  const access = new MySqlMerchantAccessRepository(database, randomBytes(32).toString('base64url'));
  const owner = await access.claimInvitation({
    setupToken: merchant.setupToken,
    phone: `139${String(randomInt(0, 100_000_000)).padStart(8, '0')}`,
    password: randomBytes(24).toString('base64url'),
  });
  const merchantId = toMerchantId(merchant.id);
  const merchantUserId = toMerchantUserId(owner.merchantUserId);
  const draft = {
    industry: '电商零售',
    businessScope: '保温杯咨询',
    materialsSummary: '测试保温杯 A，500ml；不是实际在售商品。',
    pricingSummary: 'A款99元，具体运费需核实。',
    promotionSummary: '没有已确认的优惠。',
    welcomeMessage: '您好，我是 AI 客服。',
    insufficientInfoMessage: '资料不足，请联系商家确认。',
    humanContact: '人工渠道：测试店铺订单页联系客服，工作日9点至18点。',
  };
  const snapshot = await assistants.createManualDraft({
    merchantId,
    merchantUserId,
    displayName: '改善场景测试客服',
    draft,
    idempotency: idem(),
    now: new Date(),
  });
  const assistantId = toAssistantId(snapshot.assistantId);
  const actor = { merchantId, merchantUserId, assistantId };
  const publish = async (revision: number) => {
    await approveSyntheticPreview(assistants, actor, revision);
    await assistants.confirmDraftKnowledge({
      ...actor,
      expectedDraftRevision: revision,
      now: new Date(),
    });
    return assistants.publish({
      ...actor,
      expectedDraftRevision: revision,
      ...policy,
      retrievalPolicyVersion: 'iteration-v1',
      idempotency: idem(),
      now: new Date(),
    });
  };
  const release = await publish(snapshot.draftRevision);
  return { actor, draft, snapshot, publish, release };
}

describe('real MySQL continuous improvement loop', () => {
  it('keeps source evidence immutable, applies reviewed knowledge, verifies and binds only the exact published revision', async () => {
    const f = await fixture();
    const sessions = new MySqlPublicSessionRepository(
      database,
      randomBytes(32).toString('base64url'),
    );
    const nonce = randomBytes(32).toString('base64url');
    const oldSession = await sessions.createSession({
      publicSlug: f.snapshot.publicSlug,
      sessionRequestId: `session_request_${randomBytes(16).toString('hex')}`,
      visitorNonce: nonce,
      now: new Date(),
    });
    const question = '寄新疆能包邮吗？';
    const turn = await sessions.acceptTurn({
      sessionHandle: oldSession.sessionHandle,
      visitorNonce: nonce,
      clientMessageId: `message_${randomBytes(16).toString('hex')}`,
      content: question,
      now: new Date(),
    });
    const jobs = new MySqlConversationTurnJobRepository(database);
    const claim = await jobs.claimNext(new Date(), 'iteration_test_worker');
    expect(claim?.question).toBe(question);
    if (!claim) throw new Error('Expected a durable job');
    const originalAnswer = '错误答案测试夹具：全国包邮。';
    await jobs.complete(claim, originalAnswer, new Date());
    const result = await sessions.readTurn(
      oldSession.sessionHandle,
      nonce,
      turn.turnId,
      new Date(),
    );
    const sourceMessageId = result?.messages.find(
      (message) => message.role === 'visitor',
    )?.messageId;
    if (!sourceMessageId) throw new Error('Expected persisted source question');
    const creation = write({
      ...f.actor,
      sourceMessageId,
      reason: 'missing_information' as const,
      question: '客户端不得篡改来源问题',
      expectedAnswer: '新疆运费需要另行核算，不能承诺包邮。',
      notes: '补充配送地区例外。',
    });
    const task = await improvements.createFromMessage(creation);
    expect(task.question).toBe(question);
    expect(task.originalAnswer).toBe(originalAnswer);
    expect(task.sourceReleaseId).toBe(f.release.releaseId);
    expect((await improvements.createFromMessage(creation)).id).toBe(task.id);
    expect(
      (await improvements.createFromMessage({ ...creation, requestKey: randomUUID() })).id,
    ).toBe(task.id);
    await expect(
      improvements.createFromMessage({ ...creation, expectedAnswer: '换了内容但沿用请求键' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const applied = await improvements.applyCorrection(
      write({
        ...f.actor,
        improvementId: task.id,
        expectedVersion: task.version,
        expectedDraftRevision: 1,
      }),
    );
    expect(applied.draftRevision).toBe(2);
    const saved = await assistants.findManagementSnapshot(f.actor.merchantId, f.actor.assistantId);
    expect(saved?.draft.materialsSummary).toContain('新疆运费需要另行核算');
    expect(saved?.knowledgeConfirmed).toBe(false);
    expect((await assistants.findPublicSnapshot(f.snapshot.publicSlug))?.releaseRef).toBe(
      f.release.releaseId,
    );

    const startInput = write({
      ...f.actor,
      improvementId: task.id,
      expectedVersion: applied.improvement.version,
      expectedDraftRevision: applied.draftRevision,
      ...policy,
    });
    const started = await improvements.startEvaluation(startInput);
    expect(started.started).toBe(true);
    expect((await improvements.startEvaluation(startInput)).started).toBe(false);
    expect(
      (await improvements.startEvaluation({ ...startInput, requestKey: randomUUID() })).started,
    ).toBe(false);
    await improvements.finishEvaluation(
      write({
        ...f.actor,
        improvementId: task.id,
        runId: started.run.id,
        answer: '新疆地区运费需另行核算，当前不能确认包邮，请通过已提供的人工渠道核实。',
        errorCode: null,
      }),
    );
    expect(
      (await improvements.detail({ ...f.actor, improvementId: task.id }))?.improvement.state,
    ).toBe('needs_review');
    await improvements.reviewEvaluation(
      write({
        ...f.actor,
        improvementId: task.id,
        runId: started.run.id,
        expectedVersion: applied.improvement.version,
        expectedDraftRevision: 2,
        verdict: 'pass',
      }),
    );
    expect(
      (await improvements.detail({ ...f.actor, improvementId: task.id }))?.improvement.state,
    ).toBe('ready_to_publish');
    const published = await f.publish(2);
    const detail = await improvements.detail({ ...f.actor, improvementId: task.id });
    expect(detail?.improvement).toMatchObject({
      state: 'published',
      publishedReleaseId: published.releaseId,
    });
    expect(detail?.runs[0]?.answer).toContain('新疆地区');
    expect(
      (await sessions.readHistory(oldSession.sessionHandle, nonce, new Date()))?.snapshot
        .releaseRef,
    ).toBe(f.release.releaseId);
    expect(
      (
        await sessions.readTurn(oldSession.sessionHandle, nonce, turn.turnId, new Date())
      )?.messages.find((message) => message.role === 'assistant')?.content,
    ).toBe(originalAnswer);
    const nextSession = await sessions.createSession({
      publicSlug: f.snapshot.publicSlug,
      sessionRequestId: `session_request_${randomBytes(16).toString('hex')}`,
      visitorNonce: nonce,
      now: new Date(),
    });
    expect(nextSession.releaseRef).toBe(published.releaseId);

    const laterDraft = await assistants.saveDraft({
      ...f.actor,
      expectedRevision: 2,
      draft: { ...saved!.draft, pricingSummary: '报价已变，必须重新核对。' },
      now: new Date(),
    });
    expect(laterDraft.draftRevision).toBe(3);
    expect(
      (await improvements.detail({ ...f.actor, improvementId: task.id }))?.improvement.state,
    ).toBe('needs_evaluation');
    await expect(
      improvements.reviewEvaluation(
        write({
          ...f.actor,
          improvementId: task.id,
          runId: started.run.id,
          expectedVersion: applied.improvement.version,
          expectedDraftRevision: 3,
          verdict: 'pass',
        }),
      ),
    ).rejects.toMatchObject({ code: 'stale' });
  });

  it('rejects cross-tenant/source scope and preserves an interrupted evaluation as history, not a current pass', async () => {
    const f = await fixture();
    const other = await fixture();
    const task = await improvements.createScenario(
      write({
        ...f.actor,
        reason: 'unclear_policy',
        question: '优惠能叠加吗？',
        expectedAnswer: '本次没有可确认的优惠，不承诺叠加。',
        notes: '',
      }),
    );
    expect(await improvements.detail({ ...other.actor, improvementId: task.id })).toBeNull();
    await expect(
      improvements.update(
        write({
          ...other.actor,
          improvementId: task.id,
          expectedVersion: task.version,
          reason: task.reason,
          question: task.question,
          expectedAnswer: '越权',
          notes: '',
        }),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const applied = await improvements.applyCorrection(
      write({
        ...f.actor,
        improvementId: task.id,
        expectedVersion: task.version,
        expectedDraftRevision: 1,
      }),
    );
    const run = await improvements.startEvaluation(
      write({
        ...f.actor,
        improvementId: task.id,
        expectedVersion: applied.improvement.version,
        expectedDraftRevision: 2,
        ...policy,
      }),
    );
    const current = await assistants.findManagementSnapshot(
      f.actor.merchantId,
      f.actor.assistantId,
    );
    await assistants.saveDraft({
      ...f.actor,
      expectedRevision: 2,
      draft: { ...current!.draft, promotionSummary: '优惠细则已修改，需另行确认。' },
      now: new Date(),
    });
    await improvements.finishEvaluation(
      write({
        ...f.actor,
        improvementId: task.id,
        runId: run.run.id,
        answer: '晚返回的旧草稿答案',
        errorCode: null,
      }),
    );
    await expect(
      improvements.reviewEvaluation(
        write({
          ...f.actor,
          improvementId: task.id,
          runId: run.run.id,
          expectedVersion: applied.improvement.version,
          expectedDraftRevision: 3,
          verdict: 'pass',
        }),
      ),
    ).rejects.toMatchObject({ code: 'stale' });
    const detail = await improvements.detail({ ...f.actor, improvementId: task.id });
    expect(detail?.runs[0]?.answer).toBe('晚返回的旧草稿答案');
    expect(detail?.improvement.state).toBe('needs_evaluation');
  });

  it('does not bind failed/unchecked scenarios to a release and replaces an old correction instead of duplicating it', async () => {
    const f = await fixture();
    const task = await improvements.createScenario(
      write({
        ...f.actor,
        reason: 'wrong_answer',
        question: '能退款吗？',
        expectedAnswer: '退款需人工核对订单，不承诺已退款。',
        notes: '',
      }),
    );
    const first = await improvements.applyCorrection(
      write({
        ...f.actor,
        improvementId: task.id,
        expectedVersion: task.version,
        expectedDraftRevision: 1,
      }),
    );
    const changed = await improvements.update(
      write({
        ...f.actor,
        improvementId: task.id,
        expectedVersion: first.improvement.version,
        reason: task.reason,
        question: task.question,
        expectedAnswer: '退款申请需联系店铺人工核对，AI不能执行退款。',
        notes: '更新依据',
      }),
    );
    const second = await improvements.applyCorrection(
      write({
        ...f.actor,
        improvementId: task.id,
        expectedVersion: changed.version,
        expectedDraftRevision: 2,
      }),
    );
    const current = await assistants.findManagementSnapshot(
      f.actor.merchantId,
      f.actor.assistantId,
    );
    expect(current?.draft.materialsSummary).not.toContain('退款需人工核对订单，不承诺已退款。');
    expect(
      current?.draft.materialsSummary.match(new RegExp(`\\[FAQ-${task.id}\\]`, 'gu')),
    ).toHaveLength(1);
    const started = await improvements.startEvaluation(
      write({
        ...f.actor,
        improvementId: task.id,
        expectedVersion: second.improvement.version,
        expectedDraftRevision: 3,
        ...policy,
      }),
    );
    await improvements.finishEvaluation(
      write({
        ...f.actor,
        improvementId: task.id,
        runId: started.run.id,
        answer: null,
        errorCode: 'preview_unavailable',
      }),
    );
    await f.publish(3);
    const detail = await improvements.detail({ ...f.actor, improvementId: task.id });
    expect(detail?.improvement.state).toBe('failed');
    expect(detail?.improvement.publishedReleaseId).toBeNull();
  });
});
