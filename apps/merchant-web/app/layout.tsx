import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import '@h5cs/ui/styles.css';
import './styles.css';
import { MerchantNavigation } from './navigation';

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

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div className="merchant-layout">
          <aside className="merchant-sidebar">
            <Link aria-label="H5 AI 客服商家工作台" className="merchant-brand" href="/">
              <span aria-hidden="true" className="merchant-brand__mark">
                H5
              </span>
              <span className="merchant-brand__copy">
                <strong>AI 客服</strong>
                <small>商家工作台</small>
              </span>
            </Link>
            <MerchantNavigation />
            <div className="merchant-sidebar__footer">
              <span className="merchant-avatar" aria-hidden="true">
                W
              </span>
              <span>
                <strong>需要安全绑定</strong>
                <Link href="/auth/workbuddy/bind">HTTPS 安全绑定</Link>
              </span>
            </div>
          </aside>
          <main id="main-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
