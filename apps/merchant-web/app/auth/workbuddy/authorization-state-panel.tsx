import Link from 'next/link';

import { Button } from '@h5cs/ui';

import {
  secureAuthorizationLinkAttributes,
  type WorkBuddyConnectionViewModel,
} from './connection-view-model';

export function WorkBuddyAuthorizationStatePanel({
  backHref = '/',
  model,
}: {
  backHref?: string;
  model: WorkBuddyConnectionViewModel;
}) {
  return (
    <section className="auth-placeholder">
      {model.securityNotice ? (
        <div className="connection-banner" role="alert">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>URL参数未被采信</strong>
            <span>{model.securityNotice}</span>
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
                <strong>{merchant.displayName}</strong> · {merchant.roleLabel}{' '}
                {merchant.selectionHref ? (
                  <a
                    {...secureAuthorizationLinkAttributes}
                    className="quiet-link"
                    href={merchant.selectionHref}
                  >
                    选择
                  </a>
                ) : (
                  <span>（等待服务端选择路由）</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {model.consent ? (
        <div>
          <p className="panel__eyebrow">OAuth consent</p>
          <h2>
            {model.consent.connectorLabel} · {model.consent.merchantDisplayName}
          </h2>
          <p>
            授权范围：<code>{model.consent.scope}</code>。该范围只适用于上方单一商家。
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
        ) : (
          <Button disabled>{model.actionLabel}</Button>
        )}
        <Link className="quiet-link" href={backHref}>
          安全返回
        </Link>
      </div>
    </section>
  );
}
