import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createAssistantDraft } from '../../../workspace/workspace-actions';
import { currentMerchant } from '../../../account/merchant-actions';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ merchantId: string }> },
) {
  const { merchantId } = await params;
  const requestId = randomUUID();
  const headers = { 'Cache-Control': 'no-store', 'X-Request-ID': requestId };
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) {
    return NextResponse.json(
      { error: '商家地址无效。', created: null, requestId },
      { status: 400, headers },
    );
  }
  if (
    !process.env['MERCHANT_PUBLIC_ORIGIN'] ||
    request.headers.get('origin') !== process.env['MERCHANT_PUBLIC_ORIGIN']
  ) {
    return NextResponse.json(
      { error: '请求来源校验失败，未创建客服。', created: null, requestId },
      { status: 403, headers },
    );
  }
  if (!(await currentMerchant(merchantId))) {
    return NextResponse.json(
      {
        error: '登录已失效或无权管理此商家。资料已保留，请重新登录后提交。',
        created: null,
        requestId,
      },
      { status: 403, headers },
    );
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > 128 * 1024) {
    return NextResponse.json(
      { error: '资料过长，请缩短后再创建。', created: null, requestId },
      { status: 413, headers },
    );
  }
  try {
    const data = await request.formData();
    if (data.get('merchantId') !== merchantId) {
      return NextResponse.json(
        { error: '商家编号不匹配，未创建客服。', created: null, requestId },
        { status: 403, headers },
      );
    }
    const result = await createAssistantDraft({ error: null, created: null }, data);
    return NextResponse.json(
      { ...result, requestId },
      { status: result.created ? 201 : 400, headers },
    );
  } catch {
    return NextResponse.json(
      { error: '提交未完成，请保留当前资料并稍后重试。', created: null, requestId },
      { status: 503, headers },
    );
  }
}
