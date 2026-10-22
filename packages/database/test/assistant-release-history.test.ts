import { describe, expect, it, vi } from 'vitest';
import {
  AssistantRevisionConflictError,
  toAssistantId,
  toMerchantId,
  toMerchantUserId,
  toReleaseId,
} from '@h5cs/domain';
import type { AssistantDraftConfig } from '@h5cs/domain';
import type { Connection, ResultSetHeader } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  AssistantHistorySourceUnavailableError,
  MySqlAssistantLifecycleRepository,
} from '../src/assistant-lifecycle-repository.js';

const merchantId = toMerchantId('11'.repeat(16));
const assistantId = toAssistantId('22'.repeat(16));
const merchantUserId = toMerchantUserId('33'.repeat(16));
const releaseId = toReleaseId('44'.repeat(16));
const currentRelease = '55'.repeat(16);
const now = new Date('2026-10-23T01:00:00Z');
const draft: AssistantDraftConfig = {
  industry: '零售',
  businessScope: '日用品咨询',
  materialsSummary: '毛巾每条29元。\nQ：包邮吗？\nA：新疆单件不包邮。',
  pricingSummary: '新疆单件运费15元，多件需确认。',
  promotionSummary: '不叠加优惠券。',
  welcomeMessage: '您好，我是 AI 客服。',
  insufficientInfoMessage: '请联系商家核对。',
};
const current = () => ({
  assistant_id: Buffer.from(assistantId, 'hex'),
  merchant_id: Buffer.from(merchantId, 'hex'),
  display_name: '零售客服',
  public_slug: 'a-fixed-retail',
  status: 'active',
  draft_revision: 4,
  config: { ...draft, materialsSummary: '当前尚未发布的新内容' },
  validation: { publishable: true },
  active_release_id: Buffer.from(currentRelease, 'hex'),
  created_at: now,
  updated_at: now,
  membership_status: 'active',
  merchant_status: 'active',
});
const history = (overrides: Record<string, unknown> = {}) => ({
  release_id: Buffer.from(releaseId, 'hex'),
  merchant_id: Buffer.from(merchantId, 'hex'),
  assistant_id: Buffer.from(assistantId, 'hex'),
  release_no: 1,
  draft_revision: 1,
  status: 'retired',
  config_snapshot: { ...draft, displayName: '零售客服' },
  created_at: now,
  activated_at: now,
  active_release_id: Buffer.from(currentRelease, 'hex'),
  membership_role: 'owner',
  ...overrides,
});
const header = (affectedRows = 1) => [{ affectedRows } as ResultSetHeader, []];
type Call = { sql: string; values: readonly unknown[] };
function fixture(handler: (sql: string, values: readonly unknown[]) => unknown) {
  const calls: Call[] = [];
  const begin = vi.fn(),
    commit = vi.fn(),
    rollback = vi.fn(),
    end = vi.fn();
  const connection = {
    execute: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return handler(sql, values);
    },
    beginTransaction: begin,
    commit,
    rollback,
    end,
  } as unknown as Connection;
  const open = vi.fn(async () => connection);
  const config = {
    openConnection: open,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  } as DatabaseConnectionConfig;
  return {
    repository: new MySqlAssistantLifecycleRepository(config),
    calls,
    open,
    begin,
    commit,
    rollback,
    end,
  };
}
const scope = { merchantId, assistantId, merchantUserId };
const restore = { ...scope, releaseId, expectedRevision: 4, now };

describe('tenant-scoped published release history and draft recovery', () => {
  it('paginates metadata without exposing all snapshot bodies and includes active membership checks', async () => {
    const f = fixture(() => [
      Array.from({ length: 21 }, (_, index) => history({ release_no: 21 - index })),
      [],
    ]);
    const page = await f.repository.listReleaseHistory(scope);
    expect(page.items).toHaveLength(20);
    expect(page.nextBeforeReleaseNo).toBe(2);
    expect(page.items[0]).toMatchObject({ releaseNo: 21, canRestore: true, isCurrent: false });
    expect(page.items[0]).not.toHaveProperty('draft');
    expect(f.calls[0]!.sql).toContain('r.merchant_id = ? AND r.assistant_id = ?');
    expect(f.calls[0]!.sql).toContain(
      "u.status = 'active' AND mm.status = 'active' AND m.status = 'active'",
    );
    expect(f.calls[0]!.sql).not.toContain('r.config_snapshot');
    expect(f.calls[0]!.values.slice(0, 3)).toEqual([
      Buffer.from(merchantUserId, 'hex'),
      Buffer.from(merchantId, 'hex'),
      Buffer.from(assistantId, 'hex'),
    ]);
    expect(f.begin).not.toHaveBeenCalled();
  });
  it('lets a viewer inspect a source but never advertises permission to restore', async () => {
    const f = fixture(() => [[history({ membership_role: 'viewer' })], []]);
    await expect(
      f.repository.findReleaseHistorySnapshot({ ...scope, releaseId }),
    ).resolves.toMatchObject({ draft, canRestore: false });
    expect(f.calls[0]!.sql).toContain('AND r.id = ?');
    expect(f.calls[0]!.values.at(-1)).toEqual(Buffer.from(releaseId, 'hex'));
  });
  it('keeps inaccessible and nonexistent source reads empty without writes', async () => {
    const f = fixture(() => [[], []]);
    await expect(f.repository.listReleaseHistory(scope)).resolves.toEqual({
      items: [],
      nextBeforeReleaseNo: null,
    });
    await expect(
      f.repository.findReleaseHistorySnapshot({ ...scope, releaseId }),
    ).resolves.toBeNull();
    expect(f.calls.every((call) => call.sql.startsWith('SELECT'))).toBe(true);
  });
  it.each([0, -1, 1.5, Number.NaN])(
    'rejects an invalid cursor before opening a connection: %s',
    async (beforeReleaseNo) => {
      const f = fixture(() => {
        throw Error('no query expected');
      });
      await expect(
        f.repository.listReleaseHistory({ ...scope, beforeReleaseNo }),
      ).rejects.toThrow();
      expect(f.open).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'copies a legacy/current snapshot to an unconfirmed new revision with unchanged public pointers: %s',
    async (contact) => {
      const snapshotDraft = contact ? { ...draft, humanContact: '联系测试商家核对。' } : draft;
      const source = history({
        config_snapshot: JSON.stringify({ ...snapshotDraft, displayName: '零售客服' }),
      });
      const original = JSON.stringify(source);
      const f = fixture((sql) =>
        sql.includes('FOR UPDATE')
          ? [[current()], []]
          : sql.includes('FROM assistant_release')
            ? [[source], []]
            : header(),
      );
      const result = await f.repository.restoreDraftFromRelease(restore);
      expect(result).toMatchObject({
        sourceReleaseNo: 1,
        assistant: {
          draft: snapshotDraft,
          draftRevision: 5,
          knowledgeConfirmed: false,
          activeReleaseId: currentRelease,
          publicSlug: 'a-fixed-retail',
          status: 'active',
        },
      });
      expect(JSON.stringify(source)).toBe(original);
      const updates = f.calls.filter((call) => call.sql.startsWith('UPDATE'));
      expect(updates).toHaveLength(2);
      expect(
        updates.every(
          (call) =>
            !call.sql.includes('assistant_release') &&
            !call.sql.includes('active_release_id') &&
            !call.sql.includes('public_slug'),
        ),
      ).toBe(true);
      const audit = f.calls.find((call) => call.sql.includes('INSERT INTO audit_log'))!;
      expect(audit.sql).toContain('assistant.draft_restore');
      expect(audit.values).toContain(
        JSON.stringify({
          sourceReleaseId: releaseId,
          sourceReleaseNo: 1,
          previousDraftRevision: 4,
          draftRevision: 5,
          publicReleaseUnchanged: true,
        }),
      );
      expect(f.commit).toHaveBeenCalledOnce();
    },
  );
  it.each([null, { ...current(), draft_revision: 5 }])(
    'rejects missing editor access or a stale draft before reading a source',
    async (locked) => {
      const f = fixture((sql) => {
        expect(sql).toContain('FOR UPDATE');
        return [locked ? [locked] : [], []];
      });
      await expect(f.repository.restoreDraftFromRelease(restore)).rejects.toBeInstanceOf(
        AssistantRevisionConflictError,
      );
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.sql).toContain("mm.role IN ('owner','admin','editor')");
      expect(f.rollback).toHaveBeenCalledOnce();
      expect(f.commit).not.toHaveBeenCalled();
    },
  );
  it('rejects a source from another tenant or assistant without writing a draft', async () => {
    const f = fixture((sql) => (sql.includes('FOR UPDATE') ? [[current()], []] : [[], []]));
    await expect(f.repository.restoreDraftFromRelease(restore)).rejects.toBeInstanceOf(
      AssistantHistorySourceUnavailableError,
    );
    expect(f.calls[1]!.sql).toContain('merchant_id = ? AND assistant_id = ? AND id = ?');
    expect(f.calls.some((call) => /^(UPDATE|INSERT)/u.test(call.sql))).toBe(false);
    expect(f.rollback).toHaveBeenCalledOnce();
  });
  it('rolls back a failed CAS or failed audit rather than returning partial success', async () => {
    for (const failure of ['cas', 'audit']) {
      const f = fixture((sql) => {
        if (sql.includes('FOR UPDATE')) return [[current()], []];
        if (sql.includes('FROM assistant_release')) return [[history()], []];
        if (failure === 'audit' && sql.includes('INSERT INTO audit_log'))
          throw Error('audit unavailable');
        return header(failure === 'cas' && sql.startsWith('UPDATE assistant\n') ? 0 : 1);
      });
      await expect(f.repository.restoreDraftFromRelease(restore)).rejects.toThrow();
      expect(f.rollback).toHaveBeenCalledOnce();
      expect(f.commit).not.toHaveBeenCalled();
    }
  });
  it('does not write an invalid historical config into a valid current draft', async () => {
    const f = fixture((sql) =>
      sql.includes('FOR UPDATE')
        ? [[current()], []]
        : [[history({ config_snapshot: { industry: '零售' } })], []],
    );
    await expect(f.repository.restoreDraftFromRelease(restore)).rejects.toThrow();
    expect(f.calls.some((call) => /^(UPDATE|INSERT)/u.test(call.sql))).toBe(false);
    expect(f.rollback).toHaveBeenCalledOnce();
  });
});
