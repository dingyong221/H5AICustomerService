import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ImprovementConflictError } from '@h5cs/domain';

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  member: vi.fn(),
  database: vi.fn(),
  refresh: vi.fn(),
  preview: vi.fn(),
  policy: vi.fn(),
  createScenario: vi.fn(),
  createFromMessage: vi.fn(),
  update: vi.fn(),
  applyCorrection: vi.fn(),
  startEvaluation: vi.fn(),
  finishEvaluation: vi.fn(),
  reviewEvaluation: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.refresh }));
vi.mock('../account/merchant-actions', () => ({ currentMerchantForWrite: mocks.member }));
vi.mock('../workspace/worker-preview', () => ({ requestWorkerPreview: mocks.preview }));
vi.mock('../workspace/publication-policy', () => ({ publicationPolicy: mocks.policy }));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: mocks.database,
  MySqlAssistantImprovementRepository: class {
    createScenario = mocks.createScenario;
    createFromMessage = mocks.createFromMessage;
    update = mocks.update;
    applyCorrection = mocks.applyCorrection;
    startEvaluation = mocks.startEvaluation;
    finishEvaluation = mocks.finishEvaluation;
    reviewEvaluation = mocks.reviewEvaluation;
  },
}));
import {
  applyImprovementAction,
  createImprovementAction,
  evaluateImprovementAction,
  reviewImprovementAction,
  updateImprovementAction,
} from './improvement-actions';
import { emptyImprovementAction } from './improvement-model';

const merchantId = 'aa'.repeat(16);
const assistantId = 'bb'.repeat(16);
const improvementId = 'cc'.repeat(16);
const runId = 'dd'.repeat(16);
const userId = '11'.repeat(16);
const messageId = 'ee'.repeat(16);
const origin = 'https://h5cs.example.invalid';
const draft = {
  industry: '家居零售',
  businessScope: '毛巾咨询',
  materialsSummary: '毛巾纯棉，34×76 厘米。',
  pricingSummary: '29 元/条',
  promotionSummary: '无已确认优惠',
  welcomeMessage: '我是 AI 客服。',
  insufficientInfoMessage: '待商家确认。',
};
function form(patch: Record<string, string> = {}) {
  const data = new FormData();
  for (const [name, value] of Object.entries({
    merchantId,
    assistantId,
    improvementId,
    runId,
    csrfToken: 'test-csrf',
    requestKey: '12345678-1234-4234-8234-123456789abc',
    expectedVersion: '2',
    expectedDraftRevision: '3',
    question: '退货运费如何承担？',
    expectedAnswer: '先联系商家核实退货原因，再确认运费承担方。',
    reason: 'unclear_policy',
    notes: '商家内部备注。',
    ...patch,
  }))
    data.set(name, value);
  return data;
}

describe('persistent merchant improvement actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', origin);
    mocks.headers.mockResolvedValue(new Headers({ origin }));
    mocks.member.mockResolvedValue({ merchantId, merchantUserId: userId });
    mocks.database.mockReturnValue({ configured: true, config: {} });
    for (const method of [mocks.createScenario, mocks.createFromMessage, mocks.update])
      method.mockResolvedValue({ id: improvementId });
    mocks.applyCorrection.mockResolvedValue({
      improvement: { id: improvementId },
      draftRevision: 4,
    });
    mocks.policy.mockReturnValue({
      ready: true,
      consumerOrigin: origin,
      promptTemplateVersion: 'p1',
      modelPolicyVersion: 'm1',
      retrievalPolicyVersion: 'r1',
    });
    mocks.startEvaluation.mockResolvedValue({
      started: true,
      assistantName: '毛巾客服',
      draft,
      run: { id: runId, state: 'pending', question: '退货运费如何承担？' },
    });
    mocks.preview.mockResolvedValue('请联系商家核实退货原因，再确认运费承担方。');
    mocks.finishEvaluation.mockResolvedValue({ id: runId, state: 'completed', verdict: null });
    mocks.reviewEvaluation.mockResolvedValue({ id: runId, verdict: 'pass' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('requires same-origin and current merchant membership plus CSRF before any writes or model sends', async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: 'https://evil.invalid' }));
    for (const action of [
      createImprovementAction,
      updateImprovementAction,
      applyImprovementAction,
      evaluateImprovementAction,
      reviewImprovementAction,
    ])
      expect((await action(emptyImprovementAction, form())).error).toContain('来源');
    expect(mocks.member).not.toHaveBeenCalled();
    mocks.headers.mockResolvedValue(new Headers({ origin }));
    mocks.member.mockResolvedValue(null);
    expect((await createImprovementAction(emptyImprovementAction, form())).error).toContain('登录');
    expect(mocks.member).toHaveBeenCalledWith(merchantId, 'test-csrf');
    expect(mocks.createScenario).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('uses the authenticated user and scopes source creation to the route merchant and assistant', async () => {
    const result = await createImprovementAction(
      emptyImprovementAction,
      form({
        sourceMessageId: messageId,
        sourceSessionId: 'ff'.repeat(16),
        merchantUserId: 'forged',
      }),
    );
    expect(result.improvementId).toBe(improvementId);
    expect(mocks.createFromMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId,
        assistantId,
        merchantUserId: userId,
        sourceMessageId: messageId,
      }),
    );
    expect(mocks.createFromMessage.mock.calls[0]?.[0]).not.toHaveProperty('sourceSessionId');
    expect(mocks.createScenario).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledWith(`/${merchantId}/improvements`);
  });

  it('allows recording a missing answer but rejects malformed or unbounded edits', async () => {
    expect(
      (await createImprovementAction(emptyImprovementAction, form({ expectedAnswer: '' }))).error,
    ).toBeNull();
    for (const patch of [
      { question: '' },
      { expectedAnswer: 'x'.repeat(2001) },
      { reason: 'invented' },
      { notes: 'x\u0000' },
      { requestKey: 'invalid' },
    ])
      expect(
        (await createImprovementAction(emptyImprovementAction, form(patch))).error,
      ).not.toBeNull();
    expect(mocks.createScenario).toHaveBeenCalledTimes(1);
  });

  it('requires explicit factual confirmation before a CAS-protected FAQ patch', async () => {
    expect((await applyImprovementAction(emptyImprovementAction, form())).error).toContain('真实');
    expect(mocks.applyCorrection).not.toHaveBeenCalled();
    expect(
      (await applyImprovementAction(emptyImprovementAction, form({ factsVerified: 'yes' })))
        .message,
    ).toContain('消费者线上版本尚未改变');
    expect(mocks.applyCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ improvementId, expectedVersion: 2, expectedDraftRevision: 3 }),
    );
  });

  it('keeps safe actionable errors for stale versions, content limits and manually changed blocks', async () => {
    for (const [code, message] of [
      ['stale', '已变化'],
      ['too_long', '4000'],
      ['managed_block_changed', '手动修改'],
    ] as const) {
      mocks.applyCorrection.mockRejectedValue(new ImprovementConflictError(code));
      expect(
        (await applyImprovementAction(emptyImprovementAction, form({ factsVerified: 'yes' })))
          .error,
      ).toContain(message);
    }
    mocks.update.mockRejectedValue(new Error('secret provider credential'));
    const unknown = await updateImprovementAction(emptyImprovementAction, form());
    expect(unknown.outcome).toBe('unknown');
    expect(unknown.error).not.toContain('secret');
  });

  it('does not send merchant material until explicit model consent is given', async () => {
    expect((await evaluateImprovementAction(emptyImprovementAction, form())).error).toContain(
      '千问',
    );
    expect(mocks.startEvaluation).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    mocks.policy.mockReturnValue({ ready: false, reason: '模型暂未配置' });
    expect(
      (await evaluateImprovementAction(emptyImprovementAction, form({ modelConsent: 'yes' })))
        .error,
    ).toBe('模型暂未配置');
    expect(mocks.startEvaluation).not.toHaveBeenCalled();
  });

  it('persists actual server-obtained answers with no automatic pass and never forwards notes or expected-answer hints', async () => {
    const result = await evaluateImprovementAction(
      emptyImprovementAction,
      form({ modelConsent: 'yes', answer: 'browser fake answer' }),
    );
    expect(mocks.startEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 2,
        expectedDraftRevision: 3,
        promptTemplateVersion: 'p1',
        modelPolicyVersion: 'm1',
      }),
    );
    expect(mocks.preview).toHaveBeenCalledWith({
      merchantId,
      assistantName: '毛巾客服',
      draft,
      question: '退货运费如何承担？',
    });
    expect(mocks.finishEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        improvementId,
        runId,
        answer: '请联系商家核实退货原因，再确认运费承担方。',
        errorCode: null,
      }),
    );
    expect(mocks.reviewEvaluation).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.preview.mock.calls)).not.toContain('商家内部备注');
    expect(JSON.stringify(mocks.finishEvaluation.mock.calls)).not.toContain('browser fake answer');
    expect(result.message).toContain('尚未判定通过');
  });

  it('does not repeat model calls on an idempotent or currently pending replay', async () => {
    mocks.startEvaluation.mockResolvedValue({
      started: false,
      assistantName: '毛巾客服',
      draft,
      run: { id: runId, state: 'pending' },
    });
    const result = await evaluateImprovementAction(
      emptyImprovementAction,
      form({ modelConsent: 'yes' }),
    );
    expect(result.message).toContain('未重复');
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.finishEvaluation).not.toHaveBeenCalled();
  });

  it('records a sanitized failed run if the provider fails, without approving it', async () => {
    mocks.preview.mockRejectedValue(new Error('sensitive model response'));
    const result = await evaluateImprovementAction(
      emptyImprovementAction,
      form({ modelConsent: 'yes' }),
    );
    expect(mocks.finishEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ answer: null, errorCode: 'preview_unavailable' }),
    );
    expect(result.message).toContain('不算通过');
    expect(result.error).not.toContain('sensitive');
    expect(result.outcome).toBe('confirmed');
    expect(mocks.reviewEvaluation).not.toHaveBeenCalled();
  });

  it('persists only an explicit human verdict against current task and draft versions', async () => {
    expect(
      (await reviewImprovementAction(emptyImprovementAction, form({ verdict: 'auto_pass' }))).error,
    ).not.toBeNull();
    expect(mocks.reviewEvaluation).not.toHaveBeenCalled();
    for (const verdict of ['pass', 'fail']) {
      const result = await reviewImprovementAction(emptyImprovementAction, form({ verdict }));
      expect(result.error).toBeNull();
      expect(mocks.reviewEvaluation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          merchantId,
          assistantId,
          merchantUserId: userId,
          improvementId,
          runId,
          expectedVersion: 2,
          expectedDraftRevision: 3,
          verdict,
        }),
      );
    }
  });
});
