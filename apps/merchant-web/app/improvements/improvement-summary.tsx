import Link from 'next/link';
import { readImprovements } from './improvement-data';
import { actionableImprovementCount, improvementStateLabels } from './improvement-model';

export async function ImprovementSummaryPanel({
  merchantId,
  merchantUserId,
  assistantId,
}: {
  merchantId: string;
  merchantUserId: string;
  assistantId?: string;
}) {
  const list = await readImprovements(merchantId, merchantUserId, assistantId);
  const href = `/${merchantId}/improvements${assistantId ? `?assistant=${assistantId}` : ''}`;
  return (
    <section className="merchant-account-card assistant-detail-card improvement-summary">
      <h2>持续改善客服</h2>
      <p>从真实咨询或手工场景建立问题，修正资料、复测并由你判定，再发布更新。</p>
      {list ? (
        <>
          <p>
            待推进 <strong>{actionableImprovementCount(list.counts)}</strong> 项 · 总计 {list.total}{' '}
            项。
          </p>
          <ul className="improvement-counts" aria-label="改进任务状态数量">
            {Object.entries(list.counts).map(([key, count]) => (
              <li key={key}>
                {improvementStateLabels[key as keyof typeof improvementStateLabels]}{' '}
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
          {!list.total ? (
            <p>
              暂时没有任务。你可以从咨询中标记一个答得不好的问题，或新增“运费、优惠边界、投诉”等场景。
            </p>
          ) : null}
        </>
      ) : (
        <p role="status">改进数据暂不可读，未将读取失败显示为 0。</p>
      )}
      <Link className="tenant-feature-link" href={href}>
        查看问题与改进{assistantId ? '，新增测试场景' : ''}
      </Link>
      <p className="improvement-muted">
        这里是商家主动记录的任务，不等于所有消费者未解决数；咨询“待处理”也不等于 AI 回答失败。
      </p>
    </section>
  );
}
