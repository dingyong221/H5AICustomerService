import { KnowledgeMaterialAccessError } from '@h5cs/database';
import { revalidatePath } from 'next/cache';
import {
  materialAccess,
  materialResponse,
  readMaterialBody,
} from '../../../../../knowledge/material-http';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string; assistantId: string }> },
) {
  const scope = await params;
  try {
    const access = await materialAccess(request, scope);
    if (!access) return materialResponse(403, { error: '登录已失效或无权管理此客服。' });
    let value: { sourceId?: unknown; confirmed?: unknown };
    try {
      value = JSON.parse((await readMaterialBody(request, 1024)).toString('utf8')) as typeof value;
    } catch {
      return materialResponse(400, { error: '删除请求无效，请刷新后重新确认。' });
    }
    if (
      value?.confirmed !== true ||
      typeof value.sourceId !== 'string' ||
      !/^[0-9a-f]{32}$/u.test(value.sourceId)
    )
      return materialResponse(400, { error: '请选择一份材料并明确确认删除。' });
    await access.repository.archive({
      merchantId: scope.merchantId,
      assistantId: scope.assistantId,
      userId: access.session.merchantUserId,
      sourceId: value.sourceId,
    });
    revalidatePath(`/${scope.merchantId}/knowledge/${scope.assistantId}`);
    return materialResponse(200, { deleted: true, sourceId: value.sourceId });
  } catch (error) {
    if (error instanceof KnowledgeMaterialAccessError)
      return materialResponse(404, { error: '材料不存在或无权操作。' });
    return materialResponse(503, {
      error: '未能确认删除结果，请刷新核对已保存材料后再操作；不会自动重试。',
    });
  }
}
