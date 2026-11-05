import type { AssistantManagementSnapshot } from '@h5cs/domain';
import type { PublicationGovernance } from './governance-model';
import { governanceNextStep } from './governance-model';
import { reviewDraftReadiness } from './draft-readiness';

export function setupProgress(
  assistant: AssistantManagementSnapshot | null,
  governance: PublicationGovernance | null,
) {
  const reminders = assistant ? reviewDraftReadiness(assistant.draft) : [];
  const consistent =
    !!assistant && !!governance && governance.draftRevision === assistant.draftRevision;
  const checked = consistent ? governance : null;
  const blocking = checked?.issues.some((issue) => issue.severity === 'blocking') ?? false;
  const live = !!assistant?.activeReleaseId && assistant.status === 'active';
  const currentPublished = live && !!checked && !checked.hasUnpublishedChanges;
  const qualityPassed = checked?.quality.state === 'passed';
  const next = !assistant
    ? {
        label: '填写基础资料',
        section: 'drafts' as const,
        detail: '先填写行业和实际商品或服务，再补充价格、优惠与回复说明。',
      }
    : assistant.status === 'paused'
      ? {
          label: '查看暂停状态',
          section: 'publish' as const,
          detail: '客服当前已暂停接待，请在发布分享页查看原因及可执行操作。',
        }
      : !checked
        ? governanceNextStep(null)
        : !checked.canManage
          ? governanceNextStep(checked)
          : blocking
            ? governanceNextStep(checked)
            : !currentPublished &&
                reminders.some((item) => item.code === 'materials' || item.code === 'template')
              ? {
                  label: '补充实际业务知识',
                  section: 'knowledge' as const,
                  detail:
                    '目前仍有通用模板或待补资料提醒。可以上传文件整理，也可以直接填写文字；保存后再试聊。',
                }
              : governanceNextStep(checked);
  const qualityStatus = !checked
    ? '待核对'
    : qualityPassed
      ? '本修订已通过'
      : checked.quality.state === 'needs_review'
        ? '等待判定'
        : checked.quality.state === 'failed'
          ? '需要修改'
          : currentPublished
            ? '重新发布需试聊'
            : '待试聊';
  return {
    next,
    reminders,
    live,
    canManage: checked?.canManage ?? false,
    notice: !assistant
      ? '首次开通后始终管理同一个客服，客户使用固定链接咨询。'
      : !checked
        ? '检查状态暂不可用或已变化，请刷新核对。发布状态尚未确认。'
        : assistant.status === 'paused'
          ? '当前暂停接待，固定链接保留。'
          : checked.hasUnpublishedChanges
            ? live
              ? '有待发布修改：客户仍使用已发布版本。'
              : '当前资料尚未对客户发布。'
            : live
              ? '当前已发布，后续修改仍沿用同一个客户链接。'
              : '当前未接待，请查看发布状态。',
    steps: [
      {
        section: 'drafts' as const,
        title: '基础资料',
        status: assistant ? '已保存草稿' : '待填写',
        detail: '行业、商品或服务、价格优惠与特别说明。',
      },
      {
        section: 'knowledge' as const,
        title: '知识补充',
        status: !assistant
          ? '待准备'
          : reminders.some((item) => item.code === 'materials' || item.code === 'template')
            ? '建议补充'
            : '已保存文字，待人工核对',
        detail: '文件可选；只有核对保存并发布的文字才会用于客户回答。',
      },
      {
        section: 'preview' as const,
        title: '效果试聊',
        status: assistant ? qualityStatus : '待准备',
        detail: '修改资料后需重新试聊当前修订，并明确判定回答是否合格。',
      },
      {
        section: 'publish' as const,
        title: '发布分享',
        status: !assistant
          ? '待准备'
          : assistant.status === 'paused'
            ? '已暂停'
            : !checked
              ? '待核对'
              : checked.hasUnpublishedChanges
                ? '待发布'
                : live
                  ? '已发布'
                  : '待发布',
        detail: '确认发布后复制客户链接或下载客户咨询二维码。',
      },
    ],
  };
}
