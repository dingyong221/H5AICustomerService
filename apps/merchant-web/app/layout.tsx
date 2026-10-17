import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import '@h5cs/ui/styles.css';
import './styles.css';
import './improvements/improvements.css';
import { currentMerchant } from './account/merchant-actions';
import { MerchantNavigation } from './navigation';
import { readImprovements } from './improvements/improvement-data';
import { actionableImprovementCount } from './improvements/improvement-model';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  description: '创建、测试并发布专属 AI 客服。',
  robots: { index: false, follow: false },
  title: {
    default: '商家工作台 | H5 AI 客服',
    template: '%s | H5 AI 客服',
  },
};

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#f3f6f4',
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
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div className="merchant-layout">
          <aside className="merchant-sidebar">
            <Link aria-label="H5 AI 客服商家工作台" className="merchant-brand" href={workspaceHref}>
              <span aria-hidden="true" className="merchant-brand__mark">
                H5
              </span>
              <span className="merchant-brand__copy">
                <strong>AI 客服</strong>
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
          </aside>
          <main id="main-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
