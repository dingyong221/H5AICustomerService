import { marketplaceFixtureEnabled } from '@h5cs/database';
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { BrandMark } from '@h5cs/ui';
import type { ReactNode } from 'react';

import { UsageTracker } from '@h5cs/ui';
import '@h5cs/ui/styles.css';
import './styles.css';
import './improvements/improvements.css';
import { currentMerchant, currentMerchantCsrfToken } from './account/merchant-actions';
import { MerchantLogoutForm } from './account/logout-form';
import { MerchantNavigation } from './navigation';
import { readImprovements } from './improvements/improvement-data';
import { actionableImprovementCount } from './improvements/improvement-model';
import { UnsavedNavigationBoundary } from './unsaved-navigation-boundary';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  description: '创建、测试并发布专属 AI 客服。',
  robots: { index: false, follow: false },
  title: {
    default: '商家工作台 | 客来答',
    template: '%s | 客来答',
  },
};

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#f3f6fb',
  width: 'device-width',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const merchant = await currentMerchant();
  const improvements = merchant
    ? await readImprovements(merchant.merchantId, merchant.merchantUserId)
    : null;
  const workspaceHref = merchant ? `/${merchant.merchantId}` : '/console';
  return (
    <html lang="zh-CN">
      <body>
        <UsageTracker
          enabled={process.env['H5CS_GROWTH_USAGE_ENABLED'] === 'true'}
          endpoint="/console/usage"
        />
        <UnsavedNavigationBoundary />
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div className="merchant-layout">
          <aside className="merchant-sidebar">
            <Link aria-label="客来答商家工作台" className="merchant-brand" href={workspaceHref}>
              <span aria-hidden="true" className="merchant-brand__mark">
                <BrandMark />
              </span>
              <span className="merchant-brand__copy">
                <strong>客来答</strong>
                <small>商家工作台</small>
              </span>
            </Link>
            <MerchantNavigation
              merchantId={merchant?.merchantId}
              improvementCount={
                improvements ? actionableImprovementCount(improvements.counts) : null
              }
            />
            <div className="merchant-sidebar__footer">
              <span className="merchant-avatar" aria-hidden="true">
                商
              </span>
              <span>
                <strong>{merchant ? '商家已登录' : '商家账号'}</strong>
                <a href={merchant ? workspaceHref : '/console/account/login'}>
                  {merchant ? '进入商家工作台' : '登录管理后台'}
                </a>
              </span>
            </div>
            {merchant ? (
              <MerchantLogoutForm
                merchantId={merchant.merchantId}
                csrfToken={await currentMerchantCsrfToken()}
              />
            ) : null}
          </aside>
          <main id="main-content">
            {marketplaceFixtureEnabled(process.env) &&
            process.env['H5CS_LOCAL_MODEL_FIXTURE'] === 'true' &&
            /^http:\/\/(127\.0\.0\.1|localhost):9020\/chat\/completions$/.test(
              process.env['MODEL_CHAT_COMPLETIONS_URL'] ?? '',
            ) ? (
              <p role="note" className="workflow-note">
                本地合成测试：AI
                超市身份为测试夹具；本轮模型请求仅发回环确定性服务，不连接千问。下方模型授权文案在本模式下均指本地夹具。链接及二维码仅供本机测试。
              </p>
            ) : null}
            {children}
            <p className="workflow-note">
              <Link href="/console/usage-info">使用数据说明与统计设置</Link>
            </p>
          </main>
        </div>
      </body>
    </html>
  );
}
