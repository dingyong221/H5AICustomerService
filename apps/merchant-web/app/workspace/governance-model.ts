import type { MySqlAssistantLifecycleRepository } from '@h5cs/database';
import type { MerchantSection } from '../tenant-paths';

export type PublicationGovernance = Awaited<
  ReturnType<MySqlAssistantLifecycleRepository['getPublicationGovernance']>
>;

export function governanceNextStep(governance: PublicationGovernance | null): {
  label: string;
  section: MerchantSection;
  detail: string;
} {
  if (!governance)
    return {
      label: '刷新核对发布检查',
      section: 'publish',
      detail: '检查状态暂不可用，不能据此认定可发布。',
    };
  if (!governance.canManage)
    return {
      label: '查看资料与版本',
      section: 'publish',
      detail: '当前账号为只读，请由有管理权限的成员处理修改。',
    };
  if (governance.issues.some((issue) => issue.severity === 'blocking'))
    return {
      label: '先处理业务资料问题',
      section: 'drafts',
      detail: '存在冲突或失效资料，不能直接发布。',
    };
  if (
    governance.activeReleaseNo !== null &&
    !governance.hasUnpublishedChanges &&
    governance.quality.state === 'not_tested'
  )
    return {
      label: '查看客户链接与分享',
      section: 'publish',
      detail: '已有线上版本，未发布修改为零；如需再次发布，仍须先试聊并判定当前修订。',
    };
  if (governance.quality.state === 'needs_review')
    return {
      label: '核对试聊回答并判定',
      section: 'preview',
      detail: '已经生成回答，仍需商家明确判定本修订是否合格。',
    };
  if (governance.quality.state !== 'passed')
    return {
      label: governance.quality.state === 'failed' ? '修正后重新试聊' : '试聊当前草稿',
      section: 'preview',
      detail: '成功试聊并明确判定通过，才可发布本修订。',
    };
  if (governance.hasUnpublishedChanges || governance.activeReleaseNo === null)
    return {
      label: '确认并发布本修订',
      section: 'publish',
      detail: '本修订试聊已通过，核对资料后发布；固定链接不变。',
    };
  return {
    label: '查看客户链接与分享',
    section: 'publish',
    detail: '已有发布版本；可查看咨询并持续改善，处理完成不代表问题都已解决。',
  };
}

export const qualityLabels = {
  not_tested: '尚未试聊本修订',
  needs_review: '等待商家判定',
  passed: '本修订试聊已判定通过',
  failed: '试聊判定需要修改',
} as const;
