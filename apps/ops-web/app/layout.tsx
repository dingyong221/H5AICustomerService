import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@h5cs/ui/styles.css';
import './styles.css';

export const metadata: Metadata = {
  description: '管理商家、运行任务和审计记录的运营工作台。',
  robots: { index: false, follow: false },
  title: {
    default: '平台运营中心 | H5 AI 客服',
    template: '%s | 平台运营中心',
  },
};

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#111b2e',
  width: 'device-width',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="ops-skip-link" href="#ops-main">
          跳到主要内容
        </a>
        <header className="ops-topbar">
          <a aria-label="H5 AI 客服运营中心" className="ops-brand" href="#overview">
            <span aria-hidden="true">H5</span>
            <strong>运营中心</strong>
          </a>
          <nav aria-label="运营后台主导航" className="ops-nav">
            <a aria-current="page" href="#overview">
              总览
            </a>
            <a href="#merchants">商家</a>
            <a href="#tasks">任务</a>
            <a href="#audit">审计</a>
          </nav>
          <div className="ops-identity">
            <span aria-hidden="true">运</span>
            <div>
              <strong>未登录</strong>
              <small>等待身份 API</small>
            </div>
          </div>
        </header>
        <main id="ops-main">{children}</main>
      </body>
    </html>
  );
}
