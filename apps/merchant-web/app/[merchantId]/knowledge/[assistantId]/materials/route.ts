import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  materialAccess,
  admitMaterialUpload,
  MaterialUploadError,
  materialRateLimit,
  materialResponse,
  readMaterialBody,
  materialFormData,
} from '../../../../knowledge/material-http';
import { parseMaterial, MaterialParseError } from '../../../../knowledge/material-parser';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string; assistantId: string }> },
) {
  const scope = await params;
  let admission: ReturnType<typeof admitMaterialUpload> | undefined;
  try {
    const access = await materialAccess(request, scope);
    if (!access) return materialResponse(403, { error: '登录已失效或无权管理此客服。' });
    materialRateLimit(scope.merchantId);
    const type = request.headers.get('content-type') ?? '';
    if (!type.startsWith('multipart/form-data;'))
      return materialResponse(400, { error: '请选择要上传的文件。' });
    admission = admitMaterialUpload(request);
    const bytes = await readMaterialBody(request, 20 * 1024 * 1024 + 65536, admission.signal);
    const form = await materialFormData(bytes, type);
    admission.assertActive();
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
        admission.assertActive();
        if (file.size > 10 * 1024 * 1024)
          throw new MaterialParseError('单个文件必须在 10 MB 以内，且不能为空。');
        const data = Buffer.from(await file.arrayBuffer());
        admission.assertActive();
        const text = await parseMaterial(file.name, data, {
          signal: admission.signal,
          timeoutMs: Math.min(20000, admission.remaining()),
        });
        admission.assertActive();
        // A save already sent to MySQL cannot be undone by an HTTP disconnect.
        // Await its receipt; exact-content retries still use the original repository.
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
          `${file.name.slice(0, 200)}：${error instanceof MaterialParseError || error instanceof MaterialUploadError ? error.message : '材料保存失败，请稍后重试。'}`,
        );
        if (admission.signal.aborted || admission.remaining() <= 0) break;
      }
    }
    revalidatePath(`/${scope.merchantId}/knowledge/${scope.assistantId}`);
    return materialResponse(
      saved.length ? 200 : admission.signal.aborted || admission.remaining() <= 0 ? 408 : 422,
      {
        saved,
        errors,
        ...(reused.length ? { reused } : {}),
        ...(!saved.length ? { error: errors.join('\n') || '没有材料保存成功。' } : {}),
      },
    );
  } catch (error) {
    if (error instanceof MaterialUploadError)
      return materialResponse(error.status, { error: error.message });
    return materialResponse(400, { error: '上传未完成，请检查文件大小、登录状态，或稍后重试。' });
  } finally {
    admission?.release();
  }
}
