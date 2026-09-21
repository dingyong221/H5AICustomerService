import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@h5cs/ui/styles.css';
import './styles.css';

export const metadata: Metadata = {
  description: '通过商家公开入口进行连续的在线业务咨询。',
  robots: { index: false, follow: false },
  title: '在线咨询 | AI 客服',
};

export const viewport: Viewport = {
  colorScheme: 'light',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#f7faf8',
  viewportFit: 'cover',
  width: 'device-width',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
