import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@h5cs/ui/styles.css';
import './styles.css';
import Link from 'next/link';
import { OpsNavigation } from './ops-navigation';

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
          <Link aria-label="H5 AI 客服运营中心" className="ops-brand" href="/">
            <span aria-hidden="true">H5</span>
            <strong>运营中心</strong>
          </Link>
          <OpsNavigation />
          <div className="ops-identity">
            <span aria-hidden="true">运</span>
            <div>
              <strong>运营后台</strong>
              <small>会话由服务端验证</small>
            </div>
          </div>
        </header>
        <main id="ops-main">{children}</main>
      </body>
    </html>
  );
}
