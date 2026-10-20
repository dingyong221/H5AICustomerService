import { MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toMerchantId, toMerchantUserId, toAssistantId } from '@h5cs/domain';
import { revalidatePath } from 'next/cache';
import {
  materialAccess,
  materialResponse,
  readMaterialBody,
} from '../../../../../knowledge/material-http';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string; assistantId: string }> },
) {
  const scope = await params;
  try {
    const access = await materialAccess(request, scope);
    if (!access) return materialResponse(403, { error: '登录已失效或无权管理此客服。' });
    const value = JSON.parse((await readMaterialBody(request, 20000)).toString('utf8')) as {
      summary?: unknown;
      revision?: unknown;
      mode?: unknown;
      confirmed?: unknown;
    };
    if (
      value?.confirmed !== true ||
      typeof value.summary !== 'string' ||
      !value.summary.trim() ||
      value.summary.length > 4000 ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 ||
      !['append', 'replace'].includes(String(value.mode)) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.summary)
    )
      return materialResponse(400, { error: '请核对最多 4000 字的整理稿，选择保存方式并确认。' });
    const lifecycle = new MySqlAssistantLifecycleRepository(access.database);
    const current = await lifecycle.findManagementSnapshot(
      toMerchantId(scope.merchantId),
      toAssistantId(scope.assistantId),
    );
    if (!current || current.draftRevision !== value.revision)
      return materialResponse(409, { error: '草稿已经变化，请刷新并重新核对，不要覆盖其他编辑。' });
    const combined =
      value.mode === 'append'
        ? `${current.draft.materialsSummary}\n\n【上传材料整理稿】\n${value.summary.trim()}`
        : value.summary.trim();
    if (combined.length > 4000)
      return materialResponse(400, {
        error: '合并后超过 4000 字，请精简整理稿，或核对后明确选择替换原商品资料。',
      });
    await lifecycle.saveDraft({
      merchantId: toMerchantId(scope.merchantId),
      assistantId: toAssistantId(scope.assistantId),
      merchantUserId: toMerchantUserId(access.session.merchantUserId),
      expectedRevision: Number(value.revision),
      draft: { ...current.draft, materialsSummary: combined },
      now: new Date(),
    });
    for (const section of ['drafts', 'knowledge', 'publish']) {
      revalidatePath(`/${scope.merchantId}/${section}`);
      revalidatePath(`/${scope.merchantId}/${section}/${scope.assistantId}`);
    }
    revalidatePath(`/${scope.merchantId}`);
    return materialResponse(200, { saved: true });
  } catch {
    return materialResponse(409, { error: '未能确认保存结果，请刷新检查草稿修订后再操作。' });
  }
}
