import Link from 'next/link';

import { Button } from '@h5cs/ui';

import {
  secureAuthorizationLinkAttributes,
  type WorkBuddyConnectionViewModel,
} from './connection-view-model';

interface WorkBuddyAuthorizationStatePanelProps {
  backHref?: string;
  busy?: boolean;
  errorMessage?: string | undefined;
  model: WorkBuddyConnectionViewModel;
  onConsent?: ((decision: 'deny' | 'grant') => void) | undefined;
  onRetry?: (() => void) | undefined;
  onSelectMerchant?: ((candidateRef: string) => void) | undefined;
  onStart?: (() => void) | undefined;
}

export function WorkBuddyAuthorizationStatePanel({
  backHref = '/',
  busy = false,
  errorMessage,
  model,
  onConsent,
  onRetry,
  onSelectMerchant,
  onStart,
}: WorkBuddyAuthorizationStatePanelProps) {
  return (
    <section className="auth-placeholder">
      {model.securityNotice ? (
        <div className="connection-banner" role="alert">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>URL 参数未被直接采信</strong>
            <span>{model.securityNotice}</span>
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="connection-banner" role="alert">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>操作未完成</strong>
            <span>{errorMessage}</span>
          </div>
        </div>
      ) : null}

      {model.steps.map((step, index) => (
        <div aria-current={step.status === 'current' ? 'step' : undefined} key={step.id}>
          <span aria-hidden="true" className="auth-placeholder__number">
            {String(index + 1).padStart(2, '0')}
          </span>
          <div>
            <h2>{step.label}</h2>
            <p>
              {step.status === 'complete'
                ? '可信服务端已确认完成'
                : step.status === 'current'
                  ? '等待当前步骤完成'
                  : step.status === 'blocked'
                    ? '缺少可信服务端状态，已停止'
                    : '前置步骤完成后才能继续'}
            </p>
          </div>
        </div>
      ))}

      {model.merchants.length > 0 ? (
        <div>
          <p className="panel__eyebrow">服务端候选商家</p>
          <h2>明确选择一个商家</h2>
          <ul>
            {model.merchants.map((merchant) => (
              <li key={merchant.reference}>
                <strong>{merchant.displayName}</strong>{' '}
                <Button
                  busy={busy}
                  disabled={model.transactionRef === undefined || onSelectMerchant === undefined}
                  onClick={() => onSelectMerchant?.(merchant.reference)}
                  size="small"
                  variant="secondary"
                >
                  选择此商家
                </Button>
              </li>
            ))}
          </ul>
          <p>即使只有一个候选，也必须明确选择；页面不会自动提交。</p>
        </div>
      ) : null}

      {model.consent ? (
        <div>
          <p className="panel__eyebrow">OAuth consent</p>
          <h2>{model.consent.merchantDisplayName}</h2>
          <p>
            授权范围：<code>{model.consent.scope}</code>。该范围只适用于服务端锁定的单一商家。
          </p>
          <ul>
            {model.consent.permissions.map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul>
          <p>登录、身份绑定或只有一个商家都不代表已经同意授权。</p>
        </div>
      ) : null}

      <div className="auth-placeholder__actions">
        {model.authorizationHref ? (
          <a
            {...secureAuthorizationLinkAttributes}
            className="secure-auth-link"
            href={model.authorizationHref}
          >
            {model.actionLabel}
          </a>
        ) : null}
        {model.canConsent ? (
          <>
            <Button
              busy={busy}
              disabled={onConsent === undefined}
              onClick={() => onConsent?.('grant')}
            >
              同意并继续
            </Button>
            <Button
              busy={busy}
              disabled={onConsent === undefined}
              onClick={() => onConsent?.('deny')}
              variant="danger"
            >
              拒绝授权
            </Button>
          </>
        ) : null}
        {model.canContinue ? (
          <Link className="secure-auth-link" href="/onboarding">
            继续使用
          </Link>
        ) : null}
        {model.canStart ? (
          <Button busy={busy} disabled={onStart === undefined} onClick={onStart}>
            {model.actionLabel}
          </Button>
        ) : null}
        {model.canRetry && !model.canStart ? (
          <Button busy={busy} disabled={onRetry === undefined} onClick={onRetry}>
            {model.actionLabel}
          </Button>
        ) : null}
        {model.blocked && !model.canRetry ? <Button disabled>{model.actionLabel}</Button> : null}
        <Link className="quiet-link" href={backHref}>
          安全返回
        </Link>
      </div>
    </section>
  );
}
