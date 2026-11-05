import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { UsageTracker } from '@h5cs/ui';
import '@h5cs/ui/styles.css';
import './styles.css';
import { OpsSidebar } from './ops-navigation';

export const metadata: Metadata = {
  description: '管理商家、运行任务和审计记录的运营工作台。',
  robots: { index: false, follow: false },
  title: {
    default: '平台运营中心 | 客来答',
    template: '%s | 客来答运营中心',
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
        <UsageTracker
          enabled={process.env['H5CS_GROWTH_USAGE_ENABLED'] === 'true'}
          endpoint="/ops/usage"
        />
        <a className="ops-skip-link" href="#ops-main">
          跳到主要内容
        </a>
        <div className="ops-shell">
          <OpsSidebar />
          <main id="ops-main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
