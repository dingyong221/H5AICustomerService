import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@h5cs/ui/styles.css';
import './styles.css';

export const metadata: Metadata = {
  description: '通过商家公开入口进行连续的在线业务咨询。',
  robots: { index: false, follow: false },
  title: '在线咨询 | 客来答',
};

export const viewport: Viewport = {
  colorScheme: 'light',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#f4f7fc',
  viewportFit: 'cover',
  width: 'device-width',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {['test', 'local'].includes(process.env['APP_ENV'] ?? '') &&
        process.env['H5CS_LOCAL_MODEL_FIXTURE'] === 'true' ? (
          <p role="note">本地合成测试 · 确定性模型夹具 · 非真实千问/AI超市，不作正式业务入口</p>
        ) : null}
        {children}
        <div className="consumer-platform-brand">客来答 · 为商家提供 AI 咨询服务</div>
      </body>
    </html>
  );
}
