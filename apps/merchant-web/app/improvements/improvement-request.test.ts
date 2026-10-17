import { describe, expect, it } from 'vitest';
import { emptyImprovementAction } from './improvement-model';
import {
  improvementRequestScope,
  parseImprovementRequest,
  prepareImprovementRequest,
  settleImprovementRequest,
} from './improvement-request';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
const firstKey = '12345678-1234-4234-8234-123456789abc';
const refreshedKey = '87654321-4321-4321-8321-cba987654321';
const merchantId = 'aa'.repeat(16);
const assistantId = 'bb'.repeat(16);
const scope = improvementRequestScope({ operation: 'create', merchantId, assistantId });
const form = (patch: Record<string, string> = {}) => {
  const data = new FormData();
  for (const [name, value] of Object.entries({
    question: '偏远地区包邮吗？',
    expectedAnswer: '需要联系商家确认运费。',
    reason: 'unclear_policy',
    notes: '仅限真实规则',
    expectedVersion: '2',
    expectedDraftRevision: '3',
    csrfToken: 'do-not-store-csrf',
    modelConsent: 'yes',
    factsVerified: 'yes',
    ...patch,
  }))
    data.set(name, value);
  return data;
};

describe('unknown-result-safe merchant improvement requests', () => {
  it('reuses one key and original CAS values after RSC refresh or same-tab reload', async () => {
    const storage = new MemoryStorage();
    const first = await prepareImprovementRequest({
      storage,
      scope,
      form: form(),
      initialKey: firstKey,
    });
    settleImprovementRequest({
      storage,
      scope,
      record: first,
      state: { ...emptyImprovementAction, outcome: 'unknown', error: 'response lost' },
    });
    const afterRefresh = form({ expectedVersion: '9', expectedDraftRevision: '12' });
    const retry = await prepareImprovementRequest({
      storage,
      scope,
      form: afterRefresh,
      initialKey: refreshedKey,
    });
    expect(retry.key).toBe(firstKey);
    expect(afterRefresh.get('requestKey')).toBe(firstKey);
    expect(afterRefresh.get('expectedVersion')).toBe('2');
    expect(afterRefresh.get('expectedDraftRevision')).toBe('3');
    expect(retry.values['expectedAnswer']).toBe('需要联系商家确认运费。');
  });

  it('blocks changed business input while an earlier write is unknown rather than silently making a new request', async () => {
    const storage = new MemoryStorage();
    await prepareImprovementRequest({ storage, scope, form: form(), initialKey: firstKey });
    for (const patch of [
      { question: '新问题' },
      { expectedAnswer: '全场包邮' },
      { sourceMessageId: 'cc'.repeat(16) },
    ])
      await expect(
        prepareImprovementRequest({ storage, scope, form: form(patch), initialKey: refreshedKey }),
      ).rejects.toThrow('上次提交结果尚未确认');
    expect(parseImprovementRequest(storage.getItem(scope))?.key).toBe(firstKey);
  });

  it('can correct a definitely rejected input without rotating the original unconsumed key', async () => {
    const storage = new MemoryStorage();
    const first = await prepareImprovementRequest({
      storage,
      scope,
      form: form(),
      initialKey: firstKey,
    });
    settleImprovementRequest({
      storage,
      scope,
      record: first,
      state: {
        ...emptyImprovementAction,
        outcome: 'rejected',
        error: 'validation failed before writing',
      },
    });
    const retry = await prepareImprovementRequest({
      storage,
      scope,
      form: form({ expectedAnswer: '已核实的新规则', expectedVersion: '5' }),
      initialKey: refreshedKey,
    });
    expect(retry.key).toBe(firstKey);
    expect(retry.values['expectedVersion']).toBe('5');
  });

  it('clears only on confirmed terminal persistence, including a recorded model failure, allowing a later explicit retry', async () => {
    const storage = new MemoryStorage();
    const first = await prepareImprovementRequest({
      storage,
      scope,
      form: form(),
      initialKey: firstKey,
    });
    settleImprovementRequest({
      storage,
      scope,
      record: first,
      state: {
        ...emptyImprovementAction,
        outcome: 'confirmed',
        resultKey: 'confirmed-result',
        error: 'model failure was persisted',
      },
    });
    expect(storage.getItem(scope)).toBeNull();
    const retry = await prepareImprovementRequest({
      storage,
      scope,
      form: form(),
      initialKey: refreshedKey,
    });
    expect(retry.key).toBe(refreshedKey);
  });

  it('never persists authentication or consent and uses only current explicit consent on retry', async () => {
    const storage = new MemoryStorage();
    const record = await prepareImprovementRequest({
      storage,
      scope,
      form: form({ password: 'do-not-store-password' }),
      initialKey: firstKey,
    });
    expect(JSON.stringify(record)).not.toContain('do-not-store');
    expect(record.values).not.toHaveProperty('modelConsent');
    expect(record.values).not.toHaveProperty('factsVerified');
    const retry = form();
    retry.delete('modelConsent');
    retry.delete('factsVerified');
    await prepareImprovementRequest({ storage, scope, form: retry, initialKey: refreshedKey });
    expect(retry.get('modelConsent')).toBeNull();
    expect(retry.get('factsVerified')).toBeNull();
  });

  it('isolates keys by merchant, assistant, source, task and operation', () => {
    const original = { operation: 'create', merchantId, assistantId };
    for (const patch of [
      { operation: 'update' },
      { merchantId: 'cc'.repeat(16) },
      { assistantId: 'dd'.repeat(16) },
      { sourceMessageId: 'ee'.repeat(16) },
      { improvementId: 'ff'.repeat(16) },
    ])
      expect(improvementRequestScope({ ...original, ...patch })).not.toBe(scope);
  });

  it('fails closed when stored state is corrupted or persistence is unavailable', async () => {
    const storage = new MemoryStorage();
    storage.setItem(scope, '{corrupt');
    await expect(
      prepareImprovementRequest({ storage, scope, form: form(), initialKey: refreshedKey }),
    ).rejects.toThrow('本地请求记录无法读取');
    expect(storage.getItem(scope)).toBe('{corrupt');
    const denied = {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage denied');
      },
      removeItem: () => undefined,
    };
    await expect(
      prepareImprovementRequest({ storage: denied, scope, form: form(), initialKey: firstKey }),
    ).rejects.toThrow('storage denied');
  });
});
