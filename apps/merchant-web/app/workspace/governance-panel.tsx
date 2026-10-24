import Link from 'next/link';
import { merchantPath } from '../tenant-paths';
import { governanceNextStep, qualityLabels, type PublicationGovernance } from './governance-model';

export function PublicationGovernancePanel({
  governance,
  merchantId,
  assistantId,
}: {
  governance: PublicationGovernance | null;
  merchantId: string;
  assistantId: string;
}) {
  const next = governanceNextStep(governance);
  return (
    <section className="publication-governance" aria-label="当前修订发布检查">
      <div className="section-heading">
        <h2>现在该做什么</h2>
        <Link href={merchantPath(merchantId, next.section, assistantId)}>{next.label} →</Link>
      </div>
      <p>{next.detail}</p>
      {governance ? (
        <>
          <div className="publication-state-grid">
            <span>
              草稿：修订 {governance.draftRevision}
              {governance.hasUnpublishedChanges ? ' · 有待发布修改' : ''}
            </span>
            <span>
              线上：
              {governance.activeReleaseNo === null
                ? governance.hasPublishedHistory
                  ? '已撤回，暂不接待咨询'
                  : '尚未发布'
                : `第 ${governance.activeReleaseNo} 版`}
            </span>
            <span>{qualityLabels[governance.quality.state]}</span>
          </div>
          {governance.issues.length ? (
            <ul className="fact-review-issues">
              {governance.issues.map((issue, index) => (
                <li key={`${issue.code}:${index}`} data-severity={issue.severity}>
                  <strong>{issue.severity === 'blocking' ? '需处理' : '请核对'}：</strong>
                  {issue.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="workflow-hint">
              规则检查未发现已知阻断，不代表已识别全部语义冲突；仍需核对真实价格、条件和时效。
            </p>
          )}
        </>
      ) : (
        <p role="alert">发布检查暂不可用，请刷新后重试；不会跳过检查放行。</p>
      )}
    </section>
  );
}
