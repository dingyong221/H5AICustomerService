import {
  materialAccess,
  materialResponse,
  readMaterialBody,
} from '../../../../../knowledge/material-http';
import { requestKnowledgeOrganization } from '../../../../../knowledge/worker-knowledge';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string; assistantId: string }> },
) {
  const scope = await params;
  try {
    const access = await materialAccess(request, scope);
    if (!access) return materialResponse(403, { error: '登录已失效或无权管理此客服。' });
    const data: unknown = JSON.parse((await readMaterialBody(request, 16000)).toString('utf8'));
    const value = data as { consent?: unknown; sourceIds?: unknown };
    if (
      value?.consent !== true ||
      !Array.isArray(value.sourceIds) ||
      !value.sourceIds.length ||
      value.sourceIds.length > 5 ||
      !value.sourceIds.every((id) => typeof id === 'string' && /^[0-9a-f]{32}$/u.test(id)) ||
      new Set(value.sourceIds).size !== value.sourceIds.length
    )
      return materialResponse(400, { error: '请选择 1–5 份材料并同意发送所选文字至阿里云千问。' });
    const materials = await access.repository.list(
      scope.merchantId,
      scope.assistantId,
      access.session.merchantUserId,
    );
    const selected = value.sourceIds.map((id) => materials.find((item) => item.id === id));
    if (selected.some((item) => !item))
      return materialResponse(404, { error: '所选材料不存在或无权访问。' });
    const text = selected.map((item) => `【来源：${item!.name}】\n${item!.text}`).join('\n\n');
    if (text.length > 24000)
      return materialResponse(413, { error: '所选文字合计超过 24000 字，请分批整理。' });
    return materialResponse(200, await requestKnowledgeOrganization(scope.merchantId, text));
  } catch {
    return materialResponse(503, { error: 'AI 整理暂不可用。材料已保留，可稍后重试或手动整理。' });
  }
}
