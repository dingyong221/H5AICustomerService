import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  materialAccess,
  materialRateLimit,
  materialResponse,
  readMaterialBody,
} from '../../../../knowledge/material-http';
import { parseMaterial, MaterialParseError } from '../../../../knowledge/material-parser';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string; assistantId: string }> },
) {
  const scope = await params;
  try {
    const access = await materialAccess(request, scope);
    if (!access) return materialResponse(403, { error: '登录已失效或无权管理此客服。' });
    materialRateLimit(scope.merchantId);
    const type = request.headers.get('content-type') ?? '';
    if (!type.startsWith('multipart/form-data;'))
      return materialResponse(400, { error: '请选择要上传的文件。' });
    const bytes = await readMaterialBody(request, 20 * 1024 * 1024 + 65536);
    const form = await new Response(bytes, { headers: { 'content-type': type } }).formData();
    const files = form.getAll('files');
    if (!files.length || files.length > 5 || files.some((file) => !(file instanceof File)))
      return materialResponse(400, { error: '每次请选择 1–5 个文件。' });
    const valid = files as File[];
    if (valid.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024)
      return materialResponse(413, { error: '每批文件总大小不能超过 20 MB。' });
    const saved: string[] = [],
      reused: string[] = [],
      errors: string[] = [];
    for (const file of valid) {
      try {
        const data = Buffer.from(await file.arrayBuffer());
        const text = await parseMaterial(file.name, data);
        const result = await access.repository.saveWithResult({
          ...scope,
          userId: access.session.merchantUserId,
          name: file.name,
          size: file.size,
          sha256: createHash('sha256').update(data).digest('hex'),
          text,
        });
        if (!saved.includes(result.id)) saved.push(result.id);
        if (result.reused && !reused.includes(result.id)) reused.push(result.id);
      } catch (error) {
        errors.push(
          `${file.name.slice(0, 200)}：${error instanceof MaterialParseError ? error.message : '材料保存失败，请稍后重试。'}`,
        );
      }
    }
    revalidatePath(`/${scope.merchantId}/knowledge/${scope.assistantId}`);
    return materialResponse(saved.length ? 200 : 422, {
      saved,
      errors,
      ...(reused.length ? { reused } : {}),
      ...(!saved.length ? { error: errors.join('\n') || '没有材料保存成功。' } : {}),
    });
  } catch {
    return materialResponse(400, { error: '上传未完成，请检查文件大小、登录状态，或稍后重试。' });
  }
}
