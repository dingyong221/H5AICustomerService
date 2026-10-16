import { describe, expect, it } from 'vitest';
import type { AssistantEvaluationRun } from '@h5cs/domain';
import { helpTopics, manualMarkdown, manualText, searchHelp } from '../help/manual';
import { safeMerchantReturnPath } from '../account/merchant-return-path';
import { merchantPath } from '../tenant-paths';
import {
  actionableImprovementCount,
  evaluationIsCurrent,
  improvementSourcePath,
  parseImprovementEdit,
  positiveVersion,
} from './improvement-model';

const merchantId = 'aa'.repeat(16);
const assistantId = 'bb'.repeat(16);
const taskId = 'cc'.repeat(16);
const messageId = 'dd'.repeat(16);
const sessionId = 'ee'.repeat(16);

describe('merchant improvement view contracts', () => {
  it('accepts bounded factual edits including complaints but never files or control characters', () => {
    const form = new FormData();
    form.set('question', '  退货运费谁承担？  ');
    form.set('expectedAnswer', '  需要核对退货原因，不直接承诺免运费。  ');
    form.set('reason', 'complaint');
    form.set('notes', '  先联系商家核实。  ');
    expect(parseImprovementEdit(form)).toEqual({
      question: '退货运费谁承担？',
      expectedAnswer: '需要核对退货原因，不直接承诺免运费。',
      reason: 'complaint',
      notes: '先联系商家核实。',
    });
    for (const [field, value] of [
      ['question', ''],
      ['question', 'x'.repeat(2001)],
      ['expectedAnswer', 'x'.repeat(2001)],
      ['notes', 'x\u0000'],
      ['reason', 'all_resolved'],
    ]) {
      const changed = new FormData();
      form.forEach((entry, name) => changed.set(name, entry));
      changed.set(field!, value!);
      expect(parseImprovementEdit(changed)).toBeNull();
    }
    form.set('expectedAnswer', '');
    expect(parseImprovementEdit(form)?.expectedAnswer).toBe('');
  });

  it('expires verification on task, draft revision or factual hash changes', () => {
    const run = {
      taskVersion: 3,
      draftRevision: 6,
      factsHash: 'old-hash',
    } as AssistantEvaluationRun;
    expect(evaluationIsCurrent(run, { version: 3, draftRevision: 6, factsHash: 'old-hash' })).toBe(
      true,
    );
    expect(evaluationIsCurrent(run, { version: 4, draftRevision: 6, factsHash: 'old-hash' })).toBe(
      false,
    );
    expect(evaluationIsCurrent(run, { version: 3, draftRevision: 7, factsHash: 'old-hash' })).toBe(
      false,
    );
    expect(evaluationIsCurrent(run, { version: 3, draftRevision: 6, factsHash: 'new-hash' })).toBe(
      false,
    );
  });

  it('expires a still-current draft run when the model or prompt policy changed', () => {
    const run = {
      taskVersion: 3,
      draftRevision: 6,
      factsHash: 'hash',
      promptTemplateVersion: 'p1',
      modelPolicyVersion: 'm1',
    } as AssistantEvaluationRun;
    const current = {
      version: 3,
      draftRevision: 6,
      factsHash: 'hash',
      promptTemplateVersion: 'p1',
      modelPolicyVersion: 'm1',
    };
    expect(evaluationIsCurrent(run, current)).toBe(true);
    expect(evaluationIsCurrent(run, { ...current, promptTemplateVersion: 'p2' })).toBe(false);
    expect(evaluationIsCurrent(run, { ...current, modelPolicyVersion: 'm2' })).toBe(false);
  });

  it('counts merchant tasks, not pending conversations or presumed resolutions', () => {
    expect(
      actionableImprovementCount({
        needs_correction: 1,
        needs_evaluation: 2,
        needs_review: 3,
        failed: 4,
        ready_to_publish: 5,
        published: 20,
      }),
    ).toBe(15);
    expect(positiveVersion('1')).toBe(1);
    for (const value of ['0', '-1', '1.1', '01', 'Infinity', '999999999999999', null])
      expect(positiveVersion(value)).toBeNull();
  });

  it('builds tenant-scoped entry links and permits only bounded internal login returns', () => {
    expect(merchantPath(merchantId, 'improvements')).toBe(`/${merchantId}/improvements`);
    expect(improvementSourcePath({ merchantId, assistantId, sessionId, messageId })).toBe(
      `/${merchantId}/improvements?assistant=${assistantId}&session=${sessionId}&message=${messageId}#create`,
    );
    expect(() =>
      improvementSourcePath({ merchantId: '../other', assistantId, sessionId, messageId }),
    ).toThrow();
    for (const path of [
      `/${merchantId}/improvements`,
      `/${merchantId}/improvements?assistant=${assistantId}`,
      `/${merchantId}/improvements/${taskId}?assistant=${assistantId}`,
      `/${merchantId}/improvements?assistant=${assistantId}&session=${sessionId}&message=${messageId}`,
      `/${merchantId}/improvements?assistant=${assistantId}&session=${sessionId}&message=${messageId}#create`,
    ])
      expect(safeMerchantReturnPath(merchantId, path)).toBe(path);
    for (const path of [
      `/${assistantId}/improvements`,
      `/${merchantId}/improvements?next=https://evil.invalid`,
      `/${merchantId}/improvements?assistant=${assistantId}&token=secret`,
      `/${merchantId}/improvements/${taskId}?assistant=bad`,
      `/${merchantId}/improvements?assistant=${assistantId}#other`,
    ])
      expect(safeMerchantReturnPath(merchantId, path)).toBeNull();
  });

  it('keeps help and downloadable instructions on the same manual source', () => {
    const topic = helpTopics.find((entry) => entry.id === 'improvements');
    expect(topic?.section).toBe('improvements');
    expect(searchHelp('复测').some((entry) => entry.id === 'improvements')).toBe(true);
    const manual = manualMarkdown();
    expect(manual).toContain('调用完成不自动算通过');
    expect(manual).toContain('不代表投诉已解决');
    expect(manual).toContain('旧复测和通过判定会过期');
    expect(manual).toContain('上限为 4000 字');
  });

  it('documents the actual create/detail controls and guarded FAQ recovery in both help formats', () => {
    for (const manual of [manualMarkdown(), manualText()]) {
      expect(manual).toContain('点击“建立改进任务”。建立成功后进入该任务详情');
      expect(manual).toContain('点击“保存改进任务”');
      expect(manual).toContain('先备份当前草稿全文和有价值的手动补充');
      expect(manual).toContain('本任务旧 FAQ 完整原文');
      expect(manual).toContain('无需剪贴板授权');
      expect(manual).toContain('仅在能唯一定位本任务区块时');
      expect(manual).toContain('保留其余资料并点击“保存草稿修订”');
      expect(manual).toContain('回任务详情刷新，重新核对新补丁');
      expect(manual).toContain('恢复旧原文不等于应用新答案');
      expect(manual).toContain('不要盲目删除、追加或覆盖，请联系平台管理员核对');
      expect(manual).toContain('仅整理草稿不能保证解除 FAQ 冲突');
      expect(manual).toContain('复测通过不是普通发布的强制门槛');
      expect(manual).toContain('也不代表本任务已验证');
    }
  });
});
