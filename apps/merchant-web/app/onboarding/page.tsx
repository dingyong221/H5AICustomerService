import type { Metadata } from 'next';
import Link from 'next/link';

import { Button, PageShell, ProgressSteps, StatusBadge } from '@h5cs/ui';

import { buildOnboardingViewModel } from './onboarding-view-model';

export const metadata: Metadata = {
  description: '通过四步引导准备真实业务资料，并由平台生成可编辑的 AI 客服草稿。',
  title: '首次生成 AI 客服',
};

function LockIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M7 10V8a5 5 0 0 1 10 0v2m-11 0h12v10H6V10Zm6 4v2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

const stepStatusLabel = {
  blocked: '等待连接',
  complete: '已完成',
  current: '当前步骤',
  paused: '已暂停',
  upcoming: '待开始',
} as const;

export default function OnboardingPage() {
  const viewModel = buildOnboardingViewModel({
    apiConnected: false,
    authorization: 'binding_required',
  });

  return (
    <PageShell
      aside={
        <Link className="quiet-link" href={viewModel.helpHref}>
          获取帮助
        </Link>
      }
      description={<p>四步确认真实资料后，服务端才会生成可编辑草稿；生成不等于自动发布。</p>}
      eyebrow="WorkBuddy Onboarding"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>{viewModel.connectionLabel}</strong>
            <span>无法建立 onboarding 会话，所有字段保持只读，也不会在本地模拟保存。</span>
          </div>
        </div>
      }
      title="首次生成 AI 客服"
    >
      <section aria-labelledby="identity-heading" className="binding-panel">
        <div aria-hidden="true" className="binding-panel__icon">
          <LockIcon />
        </div>
        <div>
          <div className="binding-panel__title-row">
            <h2 id="identity-heading">身份与权限</h2>
            <StatusBadge tone={viewModel.identity.tone}>{viewModel.identity.label}</StatusBadge>
          </div>
          <p>{viewModel.identity.description}</p>
        </div>
        {viewModel.identity.actionHref && viewModel.identity.actionLabel ? (
          <Link className="binding-panel__action" href={viewModel.identity.actionHref}>
            {viewModel.identity.actionLabel}
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="progress-heading" className="onboarding-progress">
        <div className="section-title-row">
          <div>
            <p className="panel__eyebrow">引导进度</p>
            <h2 id="progress-heading">{viewModel.statusLabel}</h2>
          </div>
          <StatusBadge tone="warning">不可提交</StatusBadge>
        </div>
        <ProgressSteps ariaLabel="AI 客服生成进度" steps={viewModel.steps} />
      </section>

      <div className="onboarding-layout">
        <form aria-describedby="form-readonly-note" className="onboarding-form">
          <p className="readonly-note" id="form-readonly-note">
            当前字段仅展示后续采集范围。连接管理 API 并完成安全绑定后才能编辑和提交。
          </p>

          <fieldset disabled={viewModel.isReadOnly}>
            <legend className="visually-hidden">AI 客服生成资料</legend>

            <section aria-labelledby="industry-step-heading" className="onboarding-step-card">
              <div className="onboarding-step-card__header">
                <span aria-hidden="true" className="onboarding-step-card__number">
                  01
                </span>
                <div>
                  <p>行业</p>
                  <h2 id="industry-step-heading">先确定业务所在领域</h2>
                </div>
                <StatusBadge>
                  {stepStatusLabel[viewModel.steps[0]?.status ?? 'upcoming']}
                </StatusBadge>
              </div>
              <div className="form-grid">
                <label>
                  所属行业
                  <select defaultValue="">
                    <option disabled value="">
                      等待服务端提供行业选项
                    </option>
                  </select>
                </label>
                <label>
                  细分方向
                  <input placeholder="例如：家电清洗" type="text" />
                </label>
              </div>
            </section>

            <section aria-labelledby="materials-step-heading" className="onboarding-step-card">
              <div className="onboarding-step-card__header">
                <span aria-hidden="true" className="onboarding-step-card__number">
                  02
                </span>
                <div>
                  <p>产品 / 商品 / 服务资料</p>
                  <h2 id="materials-step-heading">只提交可以确认的真实信息</h2>
                </div>
                <StatusBadge>
                  {stepStatusLabel[viewModel.steps[1]?.status ?? 'upcoming']}
                </StatusBadge>
              </div>
              <div className="form-grid">
                <label>
                  商家或业务名称
                  <input placeholder="等待服务连接" type="text" />
                </label>
                <label className="form-grid__wide">
                  业务范围与服务对象
                  <textarea placeholder="描述提供什么、服务谁，以及明确不提供什么" rows={4} />
                </label>
                <div className="material-placeholder form-grid__wide">
                  <strong>业务资料</strong>
                  <span>后续可添加 FAQ、文本或可提取文字的 PDF。</span>
                  <Button disabled size="small" variant="secondary">
                    添加资料
                  </Button>
                </div>
              </div>
            </section>

            <section aria-labelledby="policy-step-heading" className="onboarding-step-card">
              <div className="onboarding-step-card__header">
                <span aria-hidden="true" className="onboarding-step-card__number">
                  03
                </span>
                <div>
                  <p>价格 / 优惠 / 售卖策略</p>
                  <h2 id="policy-step-heading">为关键事实设置清晰边界</h2>
                </div>
                <StatusBadge>
                  {stepStatusLabel[viewModel.steps[2]?.status ?? 'upcoming']}
                </StatusBadge>
              </div>
              <div className="policy-grid">
                <label>
                  <input name="pricing" type="radio" />
                  <span>
                    <strong>价格信息</strong>
                    <small>由商家提供、暂不适用或需要人工确认。</small>
                  </span>
                </label>
                <label>
                  <input name="promotion" type="radio" />
                  <span>
                    <strong>优惠信息</strong>
                    <small>只有已确认的活动才能进入回答依据。</small>
                  </span>
                </label>
                <label>
                  <input name="insufficient" type="radio" />
                  <span>
                    <strong>资料不足时</strong>
                    <small>说明无法确认、收集需求或引导联系商家。</small>
                  </span>
                </label>
              </div>
            </section>

            <section aria-labelledby="confirm-step-heading" className="onboarding-step-card">
              <div className="onboarding-step-card__header">
                <span aria-hidden="true" className="onboarding-step-card__number">
                  04
                </span>
                <div>
                  <p>确认生成</p>
                  <h2 id="confirm-step-heading">复核资料，再交给服务端生成</h2>
                </div>
                <StatusBadge>
                  {stepStatusLabel[viewModel.steps[3]?.status ?? 'upcoming']}
                </StatusBadge>
              </div>
              <div className="confirmation-note">
                <p>
                  生成结果将保存为可编辑草稿，不会自动发布。价格、优惠和服务承诺不会由模型补造。
                </p>
                <label>
                  <input type="checkbox" />
                  <span>我已核对以上资料，并理解生成后仍需测试和发布。</span>
                </label>
              </div>
            </section>
          </fieldset>

          <div className="onboarding-actions">
            <div>
              <Button disabled={!viewModel.canCancel} variant="ghost">
                取消本次引导
              </Button>
              <Button disabled={!viewModel.canResume} variant="secondary">
                恢复引导
              </Button>
            </div>
            <Button disabled={!viewModel.canSubmit}>{viewModel.primaryActionLabel}</Button>
          </div>
        </form>

        <aside aria-labelledby="missing-heading" className="onboarding-aside">
          <section className="missing-panel">
            <div className="missing-panel__header">
              <p className="panel__eyebrow">缺失项</p>
              <h2 id="missing-heading">{viewModel.missingItemsLabel}</h2>
            </div>
            {viewModel.missingItems.length > 0 ? (
              <ul>
                {viewModel.missingItems.map((item) => (
                  <li key={item.code}>
                    <span>{item.stepLabel}</span>
                    <p>{item.message}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="missing-panel__empty">
                当前没有服务端结果，不能把空列表理解为资料已经完整。
              </p>
            )}
          </section>

          <section className="help-panel" id="help">
            <p className="panel__eyebrow">帮助</p>
            <h2>填写时遇到问题？</h2>
            <details>
              <summary>还没有价格资料怎么办？</summary>
              <p>选择需要人工确认，不要让模型猜测价格、优惠或适用条件。</p>
            </details>
            <details>
              <summary>中途退出会丢失吗？</summary>
              <p>只有服务端确认保存后才可恢复；当前 API 未连接，页面不会声称已保存。</p>
            </details>
            <details>
              <summary>生成后会直接上线吗？</summary>
              <p>不会。生成的是草稿，仍需补充知识、试聊并明确发布。</p>
            </details>
          </section>
        </aside>
      </div>
    </PageShell>
  );
}
