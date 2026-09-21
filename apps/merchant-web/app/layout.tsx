import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@h5cs/ui/styles.css';
import './styles.css';

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

const navItems = [
  { href: '#overview', label: '工作台', short: '台' },
  { href: '#draft', label: '客服草稿', short: '草' },
  { href: '#knowledge', label: '知识库', short: '知' },
  { href: '#release', label: '测试与发布', short: '发' },
  { href: '#conversations', label: '咨询管理', short: '询' },
];

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div className="merchant-layout">
          <aside className="merchant-sidebar">
            <a aria-label="H5 AI 客服商家工作台" className="merchant-brand" href="#overview">
              <span aria-hidden="true" className="merchant-brand__mark">
                H5
              </span>
              <span className="merchant-brand__copy">
                <strong>AI 客服</strong>
                <small>商家工作台</small>
              </span>
            </a>
            <nav aria-label="商家后台主导航" className="merchant-nav">
              {navItems.map((item, index) => (
                <a
                  aria-current={index === 0 ? 'page' : undefined}
                  className={index === 0 ? 'merchant-nav__item is-active' : 'merchant-nav__item'}
                  href={item.href}
                  key={item.href}
                >
                  <span aria-hidden="true" className="merchant-nav__icon">
                    {item.short}
                  </span>
                  <span>{item.label}</span>
                </a>
              ))}
            </nav>
            <div className="merchant-sidebar__footer">
              <span className="merchant-avatar" aria-hidden="true">
                商
              </span>
              <span>
                <strong>未登录</strong>
                <small>等待身份 API</small>
              </span>
            </div>
          </aside>
          <main id="main-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
