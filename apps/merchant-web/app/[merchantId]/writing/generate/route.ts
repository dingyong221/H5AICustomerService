import { MarketplaceModelError } from '../../../workspace/model-service-error';
import { randomUUID } from 'node:crypto';
import { parseWritingInput } from '@h5cs/contracts';
import { currentMerchantForWrite } from '../../../account/merchant-actions';
import { requestWorkerWriting, WritingUnavailable } from '../../../writing/worker-writing';

export async function POST(request: Request, context: { params: Promise<{ merchantId: string }> }) {
  const requestId = `req_${randomUUID()}`;
  const respond = (status: number, data: unknown) =>
    Response.json(data, {
      status,
      headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId },
    });
  const { merchantId } = await context.params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) return respond(404, { error: '页面不存在。' });
  if (
    !process.env['MERCHANT_PUBLIC_ORIGIN'] ||
    request.headers.get('origin') !== process.env['MERCHANT_PUBLIC_ORIGIN']
  )
    return respond(403, { error: '请求来源校验失败，请从商家后台操作。' });
  const member = await currentMerchantForWrite(
    merchantId,
    request.headers.get('x-h5cs-csrf') ?? '',
  );
  if (!member) return respond(403, { error: '登录已失效或没有此商家的权限，请重新登录。' });
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body)
    return respond(400, { error: '请求格式不正确。' });
  let payload: unknown;
  const reader = request.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 24_576) return respond(413, { error: '内容过长，请缩短后再生成。' });
      chunks.push(value);
    }
    payload = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    return respond(400, { error: '请求格式不正确。' });
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const input = parseWritingInput(payload);
  if (
    !input ||
    typeof payload !== 'object' ||
    payload === null ||
    !('consent' in payload) ||
    payload.consent !== true
  )
    return respond(400, { error: '请填写 1 至 1000 字简述，并确认发送当前字段文字至阿里云千问。' });
  try {
    return respond(200, { data: await requestWorkerWriting(merchantId, input) });
  } catch (error) {
    if (error instanceof MarketplaceModelError)
      return respond(error.status, { error: error.message, code: error.code });
    const status = error instanceof WritingUnavailable ? error.status : 503;
    return respond(status, {
      error:
        status === 429
          ? '生成请求较多，请等待一分钟再试。当前内容已保留。'
          : '暂时未能生成可用文案，请稍后重试或手动填写。当前内容已保留。',
    });
  }
}
