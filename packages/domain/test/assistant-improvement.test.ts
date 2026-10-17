import { describe, expect, it } from 'vitest';
import {
  applyImprovementFaq,
  deriveImprovementState,
  ImprovementConflictError,
  type AssistantEvaluationRun,
} from '../src/assistant-improvement.js';

const taskId = '11'.repeat(16);
const now = new Date('2026-10-17T04:00:00Z');
const run: AssistantEvaluationRun = {
  id: '22'.repeat(16),
  improvementId: taskId,
  taskVersion: 3,
  draftRevision: 8,
  factsHash: '33'.repeat(32),
  question: '新疆包邮吗？',
  expectedAnswer: '新疆运费需另行核价',
  answer: '新疆运费需另行核价',
  errorCode: null,
  state: 'completed',
  verdict: 'pass',
  createdAt: now,
  completedAt: now,
  reviewedAt: now,
  promptTemplateVersion: 'v1',
  modelPolicyVersion: 'v1',
};
const stateInput = {
  taskVersion: 3,
  expectedAnswer: '新疆运费需另行核价',
  appliedBlock: 'block',
  appliedDraftRevision: 8,
  publishedTaskVersion: null,
  publishedReleaseId: null,
  activeReleaseId: null,
  currentDraftRevision: 8,
  currentFactsHash: run.factsHash,
  latestRun: run,
};

describe('merchant-confirmed FAQ patches', () => {
  it('preserves existing materials exactly and explicitly appends one managed block', () => {
    const original = '商品A：100元。\n现有售后规则不得丢失。';
    const patch = applyImprovementFaq({
      materials: original,
      improvementId: taskId,
      question: run.question,
      expectedAnswer: run.expectedAnswer,
      previousBlock: null,
    });
    expect(patch.materials).toBe(`${original}\n\n${patch.block}`);
    expect(patch.block).toContain('[FAQ-');
    expect(patch.block).toContain('问：新疆包邮吗？\n答：新疆运费需另行核价');
  });
  it('replaces only the exact previous block without leaving contradictory old answers', () => {
    const first = applyImprovementFaq({
      materials: '保留商品。',
      improvementId: taskId,
      question: run.question,
      expectedAnswer: '旧规则',
      previousBlock: null,
    });
    const second = applyImprovementFaq({
      materials: `${first.materials}\n其他人工编辑照常保留。`,
      improvementId: taskId,
      question: run.question,
      expectedAnswer: '新规则',
      previousBlock: first.block,
    });
    expect(second.materials).not.toContain('旧规则');
    expect(second.materials).toContain('新规则');
    expect(second.materials).toContain('其他人工编辑照常保留。');
    expect(second.materials.match(/\[FAQ-/gu)).toHaveLength(1);
  });
  it('does not overwrite a block that the merchant changed manually or removed', () => {
    const first = applyImprovementFaq({
      materials: '原文',
      improvementId: taskId,
      question: run.question,
      expectedAnswer: '旧规则',
      previousBlock: null,
    });
    for (const materials of [
      first.materials.replace('旧规则', '商家手改规则'),
      '已删除',
      `${first.materials}\n${first.block}`,
    ]) {
      expect(() =>
        applyImprovementFaq({
          materials,
          improvementId: taskId,
          question: run.question,
          expectedAnswer: '新规则',
          previousBlock: first.block,
        }),
      ).toThrow(expect.objectContaining({ code: 'managed_block_changed' }));
    }
  });
  it('rejects oversized corrections instead of truncating existing or new facts', () => {
    expect(() =>
      applyImprovementFaq({
        materials: 'a'.repeat(3_999),
        improvementId: taskId,
        question: 'q',
        expectedAnswer: 'a',
        previousBlock: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'too_long' }));
    expect(() =>
      applyImprovementFaq({
        materials: '',
        improvementId: taskId,
        question: 'q'.repeat(2_001),
        expectedAnswer: 'a',
        previousBlock: null,
      }),
    ).toThrow(ImprovementConflictError);
  });
  it('rejects forged marker syntax and empty expected knowledge', () => {
    for (const expectedAnswer of ['', ' ', `[FAQ-${taskId}]恶意文本`]) {
      expect(() =>
        applyImprovementFaq({
          materials: '',
          improvementId: taskId,
          question: 'q',
          expectedAnswer,
          previousBlock: null,
        }),
      ).toThrow(ImprovementConflictError);
    }
  });
});

describe('improvement state is evidence-based, not a solved-answer score', () => {
  it('requires a correction and merchant confirmation', () => {
    expect(deriveImprovementState({ ...stateInput, expectedAnswer: '' })).toBe('needs_correction');
    expect(deriveImprovementState({ ...stateInput, appliedBlock: null })).toBe('needs_correction');
    expect(deriveImprovementState({ ...stateInput, appliedDraftRevision: null })).toBe(
      'needs_correction',
    );
  });
  it('expires verification on any task version, draft revision, or facts hash drift', () => {
    expect(deriveImprovementState({ ...stateInput, taskVersion: 4 })).toBe('needs_evaluation');
    expect(deriveImprovementState({ ...stateInput, currentDraftRevision: 9 })).toBe(
      'needs_evaluation',
    );
    expect(deriveImprovementState({ ...stateInput, currentFactsHash: 'different' })).toBe(
      'needs_evaluation',
    );
    expect(
      deriveImprovementState({
        ...stateInput,
        currentPolicy: { promptTemplateVersion: 'v2', modelPolicyVersion: 'v1' },
      }),
    ).toBe('needs_evaluation');
    expect(
      deriveImprovementState({
        ...stateInput,
        currentPolicy: { promptTemplateVersion: 'v1', modelPolicyVersion: 'v2' },
      }),
    ).toBe('needs_evaluation');
  });
  it('never treats a returned text as a passed or published evaluation', () => {
    expect(deriveImprovementState({ ...stateInput, latestRun: { ...run, verdict: null } })).toBe(
      'needs_review',
    );
    expect(deriveImprovementState(stateInput)).toBe('ready_to_publish');
    expect(
      deriveImprovementState({
        ...stateInput,
        latestRun: { ...run, state: 'failed', verdict: null },
      }),
    ).toBe('failed');
    expect(deriveImprovementState({ ...stateInput, latestRun: { ...run, verdict: 'fail' } })).toBe(
      'failed',
    );
    expect(
      deriveImprovementState({
        ...stateInput,
        latestRun: { ...run, state: 'pending', verdict: null },
      }),
    ).toBe('needs_evaluation');
  });
  it('requires a matching current release and retains drift protection after publication', () => {
    const published = {
      ...stateInput,
      publishedTaskVersion: 3,
      publishedReleaseId: 'release-a',
      activeReleaseId: 'release-a',
    };
    expect(deriveImprovementState(published)).toBe('published');
    expect(deriveImprovementState({ ...published, currentDraftRevision: 9 })).toBe(
      'needs_evaluation',
    );
    expect(deriveImprovementState({ ...published, appliedBlock: null })).toBe('needs_correction');
    expect(deriveImprovementState({ ...published, activeReleaseId: 'release-b' })).toBe(
      'ready_to_publish',
    );
  });
});
