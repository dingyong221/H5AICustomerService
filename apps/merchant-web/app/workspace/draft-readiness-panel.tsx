import type { AssistantDraftConfig } from '@h5cs/domain';

import { reviewDraftReadiness } from './draft-readiness';

export function DraftReadinessPanel({ draft }: { draft: AssistantDraftConfig }) {
  const reminders = reviewDraftReadiness(draft);
  return (
    <section
      className="merchant-account-card assistant-detail-card"
      aria-labelledby="draft-readiness-heading"
    >
      <h2 id="draft-readiness-heading">资料自检提示</h2>
      <p>
        以下仅用文字规则提醒常见缺项，不是质量评分，也不能完整检查知识冲突。资料已确认不等于回答质量达标，仍需用真实场景试聊并人工核对。
      </p>
      {reminders.length ? (
        <ul>
          {reminders.map((reminder) => (
            <li key={reminder.code}>
              <strong>{reminder.title}</strong>
              <p>{reminder.detail}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          未触发当前规则提醒，这不证明资料完整或回答正确。请继续核对价格、优惠、售后及人工联系信息，并验证实际问题。
        </p>
      )}
      <p>
        建议试问：“这款多少钱，有什么条件？”“优惠能叠加吗？”“收到商品有问题怎么办？”“我要找人工”。
      </p>
    </section>
  );
}
