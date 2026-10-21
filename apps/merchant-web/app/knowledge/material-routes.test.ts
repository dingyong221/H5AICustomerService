import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  member: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  archive: vi.fn(),
  organize: vi.fn(),
  parse: vi.fn(),
  snapshot: vi.fn(),
  saveDraft: vi.fn(),
  publish: vi.fn(),
  revalidate: vi.fn(),
  config: vi.fn(),
  limit: vi.fn(),
  AccessError: class extends Error {},
  ParseError: class extends Error {},
}));
vi.mock('../account/merchant-actions', () => ({ currentMerchantForWrite: mocks.member }));
vi.mock('@h5cs/database', () => ({
  KnowledgeMaterialAccessError: mocks.AccessError,
  loadDatabaseConfig: mocks.config,
  MySqlKnowledgeMaterialRepository: class {
    list = mocks.list;
    save = mocks.save;
    archive = mocks.archive;
  },
  MySqlAssistantLifecycleRepository: class {
    findManagementSnapshot = mocks.snapshot;
    saveDraft = mocks.saveDraft;
    publish = mocks.publish;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('./material-parser', () => ({
  parseMaterial: mocks.parse,
  MaterialParseError: mocks.ParseError,
}));
vi.mock('./worker-knowledge', () => ({ requestKnowledgeOrganization: mocks.organize }));
vi.mock('./material-http', async (original) => ({
  ...(await original<typeof import('./material-http')>()),
  materialRateLimit: mocks.limit,
}));
import { POST as upload } from '../[merchantId]/knowledge/[assistantId]/materials/route';
import { POST as organize } from '../[merchantId]/knowledge/[assistantId]/materials/organize/route';
import { POST as apply } from '../[merchantId]/knowledge/[assistantId]/materials/apply/route';
import { POST as remove } from '../[merchantId]/knowledge/[assistantId]/materials/delete/route';
import { readMaterialBody } from './material-http';

const merchantId = 'aa'.repeat(16),
  assistantId = 'bb'.repeat(16),
  userId = 'cc'.repeat(16),
  sourceId = 'dd'.repeat(16);
const origin = 'https://h5cs.1rying.com';
const scope = { merchantId, assistantId };
const params = { params: Promise.resolve(scope) };
const material = {
  id: sourceId,
  name: '商品.txt',
  text: '毛巾 29 元/条',
  size: 100,
  sha256: 'ef'.repeat(32),
  createdAt: '2026-10-20T00:00:00Z',
};
const draft = {
  assistantName: '测试客服',
  industry: '零售',
  businessScope: '毛巾',
  materialsSummary: '原商品资料',
  pricingSummary: '价格待确认',
  promotionSummary: '优惠待确认',
  insufficientInfoMessage: '请联系商家确认',
};
const organized = { summary: '商品.txt：毛巾 29 元/条', warnings: [] };
function json(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/${merchantId}/knowledge/${assistantId}/materials`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'x-h5cs-csrf': 'test-csrf',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function files(names = ['商品.txt']) {
  const data = new FormData();
  for (const name of names) data.append('files', new File(['毛巾 29 元/条'], name));
  return new Request(`${origin}/${merchantId}/knowledge/${assistantId}/materials`, {
    method: 'POST',
    headers: { Origin: origin, 'x-h5cs-csrf': 'test-csrf' },
    body: data,
  });
}
describe('knowledge material HTTP access boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', origin);
    mocks.config.mockReturnValue({ configured: true, config: {} });
    mocks.member.mockResolvedValue({ merchantUserId: userId, merchantId });
    mocks.list.mockResolvedValue([material]);
    mocks.save.mockResolvedValue(sourceId);
    mocks.archive.mockResolvedValue(undefined);
    mocks.parse.mockResolvedValue(material.text);
    mocks.organize.mockResolvedValue(organized);
    mocks.snapshot.mockResolvedValue({
      draftRevision: 7,
      draft,
      publishedReleaseId: 'unchanged-release',
    });
    mocks.saveDraft.mockResolvedValue({ draftRevision: 8 });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('checks origin, membership and CSRF before reading any body or parsing files', async () => {
    for (const handler of [upload, organize, apply, remove]) {
      const evil = json({}, { Origin: 'https://evil.invalid' });
      const readEvil = vi.spyOn(evil.body!, 'getReader');
      expect((await handler(evil, params)).status).toBe(403);
      expect(readEvil).not.toHaveBeenCalled();
    }
    expect(mocks.member).not.toHaveBeenCalled();
    mocks.member.mockResolvedValue(null);
    for (const handler of [upload, organize, apply, remove]) {
      const request = json({});
      const read = vi.spyOn(request.body!, 'getReader');
      expect((await handler(request, params)).status).toBe(403);
      expect(read).not.toHaveBeenCalled();
    }
    expect(mocks.member).toHaveBeenCalledWith(merchantId, 'test-csrf');
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.organize).not.toHaveBeenCalled();
  });
  it('rejects cross-merchant or cross-assistant permissions before parsing or external calls', async () => {
    mocks.list.mockRejectedValue(new mocks.AccessError());
    for (const handler of [upload, organize, apply, remove])
      expect((await handler(json({}), params)).status).toBe(403);
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.organize).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('rejects malformed route scope and unavailable database without reading the payload', async () => {
    expect(
      (await organize(json({}), { params: Promise.resolve({ merchantId: '../bad', assistantId }) }))
        .status,
    ).toBe(403);
    expect(mocks.member).not.toHaveBeenCalled();
    mocks.config.mockReturnValue({ configured: false });
    expect((await upload(files(), params)).status).toBe(403);
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it('bounds streamed bodies, cancels over-limit reads and does not silently truncate', async () => {
    const request = json({ text: 'x'.repeat(100) });
    await expect(readMaterialBody(request, 20)).rejects.toThrow('请求过大');
    expect(request.body?.locked).toBe(false);
    const bytes = await readMaterialBody(json({ text: '资料' }), 100);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ text: '资料' });
  });
  it('requires explicit organization consent, unique bounded IDs and selected-tenant sources', async () => {
    for (const value of [
      { consent: false, sourceIds: [sourceId] },
      { consent: 'true', sourceIds: [sourceId] },
      { consent: true, sourceIds: [] },
      { consent: true, sourceIds: [sourceId, sourceId] },
      { consent: true, sourceIds: ['not-an-id'] },
      { consent: true, sourceIds: Array.from({ length: 6 }, (_, i) => i.toString(16).repeat(32)) },
    ]) {
      expect((await organize(json(value), params)).status).toBe(400);
    }
    expect(
      (await organize(json({ consent: true, sourceIds: ['ee'.repeat(16)] }), params)).status,
    ).toBe(404);
    expect(mocks.organize).not.toHaveBeenCalled();
  });
  it('requires an explicit single-source deletion confirmation before writing', async () => {
    for (const value of [
      null,
      {},
      { sourceId, confirmed: false },
      { sourceId, confirmed: 'true' },
      { sourceId: '../foreign', confirmed: true },
      { sourceId: [sourceId], confirmed: true },
    ])
      expect((await remove(json(value), params)).status).toBe(400);
    expect(
      (await remove(json({ sourceId, confirmed: true, padding: 'x'.repeat(2000) }), params)).status,
    ).toBe(400);
    expect(mocks.archive).not.toHaveBeenCalled();
  });
  it('deletes idempotently in server-authorized scope without changing draft, publication or consumer link', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await remove(
        json({ sourceId, confirmed: true, merchantId: 'ff'.repeat(16), userId: 'ff'.repeat(16) }),
        params,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ deleted: true, sourceId });
    }
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    expect(mocks.archive).toHaveBeenCalledWith({ merchantId, assistantId, userId, sourceId });
    expect(mocks.revalidate).toHaveBeenCalledWith(`/${merchantId}/knowledge/${assistantId}`);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.organize).not.toHaveBeenCalled();
  });
  it('rejects missing/foreign sources without disclosure and fails closed on an unknown delete result', async () => {
    mocks.archive.mockRejectedValueOnce(new mocks.AccessError('foreign secret'));
    const denied = await remove(json({ sourceId, confirmed: true }), params);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('secret');
    mocks.archive.mockRejectedValueOnce(new Error('database credential private'));
    const failed = await remove(json({ sourceId, confirmed: true }), params);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain('请刷新核对已保存材料');
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it('refuses to organize archived sources after deletion instead of sending their old text', async () => {
    await remove(json({ sourceId, confirmed: true }), params);
    mocks.list.mockResolvedValue([]);
    expect((await organize(json({ sourceIds: [sourceId], consent: true }), params)).status).toBe(
      404,
    );
    expect(mocks.organize).not.toHaveBeenCalled();
  });
  it('passes only selected source text and server-authorized scope, without payload-supplied context', async () => {
    const response = await organize(
      json({
        consent: true,
        sourceIds: [sourceId],
        merchantId: 'ff'.repeat(16),
        text: 'do-not-send',
      }),
      params,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(organized);
    expect(mocks.organize).toHaveBeenCalledWith(
      merchantId,
      `【来源：${material.name}】\n${material.text}`,
    );
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('rejects over-limit selected text and hides provider failures while preserving materials', async () => {
    mocks.list.mockResolvedValue([{ ...material, text: 'x'.repeat(24000) }]);
    expect((await organize(json({ consent: true, sourceIds: [sourceId] }), params)).status).toBe(
      413,
    );
    expect(mocks.organize).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue([material]);
    mocks.organize.mockRejectedValue(new Error('private provider detail'));
    const response = await organize(json({ consent: true, sourceIds: [sourceId] }), params);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });
  it('saves extracted source metadata in authorized scope but never writes draft or publishes on upload', async () => {
    const response = await upload(files(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: [sourceId], errors: [] });
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        ...scope,
        userId,
        name: '商品.txt',
        text: material.text,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('returns failure when no upload succeeds and separately reports partial success', async () => {
    mocks.parse.mockRejectedValueOnce(new mocks.ParseError('不支持此文件。'));
    const failed = await upload(files(['bad.exe']), params);
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ saved: [], error: 'bad.exe：不支持此文件。' });
    mocks.parse
      .mockRejectedValueOnce(new mocks.ParseError('损坏的文件。'))
      .mockResolvedValueOnce(material.text);
    const partial = await upload(files(['bad.pdf', '商品.txt']), params);
    expect(partial.status).toBe(200);
    expect(await partial.json()).toEqual({ saved: [sourceId], errors: ['bad.pdf：损坏的文件。'] });
  });
  it('rejects missing files and more than five files, before starting parser work', async () => {
    for (const names of [[], ['1.txt', '2.txt', '3.txt', '4.txt', '5.txt', '6.txt']])
      expect((await upload(files(names), params)).status).toBe(400);
    expect(mocks.parse).not.toHaveBeenCalled();
  });
  it('requires explicit apply confirmation and bounded nonempty summary', async () => {
    const valid = { summary: '新资料', revision: 7, mode: 'append', confirmed: true };
    for (const patch of [
      { confirmed: false },
      { confirmed: 'true' },
      { summary: '' },
      { summary: 'x'.repeat(4001) },
      { summary: 'bad\u0000' },
      { revision: 0 },
      { revision: '7' },
      { mode: 'merge' },
    ])
      expect((await apply(json({ ...valid, ...patch }), params)).status).toBe(400);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });
  it('preserves all other draft fields, appends explicitly and does not automatically confirm or publish', async () => {
    const response = await apply(
      json({ summary: organized.summary, revision: 7, mode: 'append', confirmed: true }),
      params,
    );
    expect(response.status).toBe(200);
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId,
        assistantId,
        merchantUserId: userId,
        expectedRevision: 7,
        draft: {
          ...draft,
          materialsSummary: `${draft.materialsSummary}\n\n【上传材料整理稿】\n${organized.summary}`,
        },
      }),
    );
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledWith(`/${merchantId}/knowledge/${assistantId}`);
  });
  it('rejects append overflow without truncation, but permits a separately confirmed replacement', async () => {
    const body = { summary: 'x'.repeat(4000), revision: 7, mode: 'append', confirmed: true };
    expect((await apply(json(body), params)).status).toBe(400);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect((await apply(json({ ...body, mode: 'replace' }), params)).status).toBe(200);
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draft: { ...draft, materialsSummary: body.summary } }),
    );
  });
  it('detects both pre-save revision mismatch and concurrent save conflict without retry or publishing', async () => {
    const body = { summary: '新资料', revision: 6, mode: 'append', confirmed: true };
    expect((await apply(json(body), params)).status).toBe(409);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    mocks.saveDraft.mockRejectedValue(new Error('Concurrent revision conflict'));
    expect((await apply(json({ ...body, revision: 7 }), params)).status).toBe(409);
    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
