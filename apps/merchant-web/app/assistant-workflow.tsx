import Link from 'next/link';

import { merchantPath } from './tenant-paths';

export const assistantWorkflowSteps = [
  { section: 'drafts', title: '基础资料', description: '填写业务与回复规则' },
  { section: 'knowledge', title: '知识补充', description: '上传材料并核对整理稿' },
  { section: 'preview', title: '效果试聊', description: '用真实场景检查回答' },
  { section: 'publish', title: '发布分享', description: '确认版本并获取固定链接' },
] as const;

export type AssistantWorkflowSection = (typeof assistantWorkflowSteps)[number]['section'];

export function AssistantWorkflowSteps({
  merchantId,
  assistantId,
  section,
}: {
  merchantId: string;
  assistantId: string;
  section: AssistantWorkflowSection;
}) {
  return (
    <nav aria-label="客服发布步骤" className="assistant-workflow-steps">
      <ol>
        {assistantWorkflowSteps.map((step, index) => (
          <li key={step.section}>
            <Link
              aria-current={section === step.section ? 'step' : undefined}
              href={merchantPath(merchantId, step.section, assistantId)}
            >
              <span aria-hidden="true" className="assistant-workflow-steps__number">
                {index + 1}
              </span>
              <span>
                <strong>{step.title}</strong>
                <small>{step.description}</small>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function AssistantWorkflowActions({
  backHref,
  backLabel,
  nextHref,
  nextLabel,
}: {
  backHref: string;
  backLabel: string;
  nextHref?: string;
  nextLabel?: string;
}) {
  return (
    <div className="assistant-workflow-actions">
      <Link className="workflow-button workflow-button--secondary" href={backHref}>
        {backLabel}
      </Link>
      {nextHref && nextLabel ? (
        <Link className="workflow-button" href={nextHref}>
          {nextLabel}
          <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </div>
  );
}
