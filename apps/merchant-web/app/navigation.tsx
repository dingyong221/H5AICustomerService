'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';

const navItems = [
  { href: '/', label: '工作台', short: '台' },
  { href: '/onboarding', label: 'WorkBuddy 接入', short: 'W' },
  { href: '/#draft', label: '客服草稿', short: '草' },
  { href: '/#knowledge', label: '知识库', short: '知' },
  { href: '/#release', label: '测试与发布', short: '发' },
  { href: '/#conversations', label: '咨询管理', short: '询' },
] as const;

export function MerchantNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="商家后台主导航" className="merchant-nav">
      {navItems.map((item) => {
        const active =
          item.href === '/onboarding'
            ? pathname.startsWith('/onboarding')
            : item.href === '/' && pathname === '/';

        return (
          <Link
            aria-current={active ? 'page' : undefined}
            className={active ? 'merchant-nav__item is-active' : 'merchant-nav__item'}
            href={item.href}
            key={item.href}
          >
            <span aria-hidden="true" className="merchant-nav__icon">
              {item.short}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
