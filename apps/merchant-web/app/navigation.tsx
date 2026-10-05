'use client';

import { useParams, usePathname } from 'next/navigation';
import Link from 'next/link';

export function MerchantNavigation({ merchantId }: { merchantId?: string | undefined }) {
  const pathname = usePathname();
  const params = useParams<{ merchantId?: string; assistantId?: string }>();
  const workspace = merchantId ? `/workspace/${merchantId}` : '/account/login';
  const assistantId =
    merchantId === params.merchantId &&
    typeof params.assistantId === 'string' &&
    /^[0-9a-f]{32}$/u.test(params.assistantId)
      ? params.assistantId
      : null;
  const assistant = assistantId ? `${workspace}/assistants/${assistantId}` : null;
  const assistantList = merchantId ? `${workspace}#assistants` : workspace;
  const navItems = [
    { href: workspace, label: '工作台', short: '台' },
    { href: assistant ? `${assistant}#draft` : assistantList, label: '客服草稿', short: '草' },
    { href: assistant ? `${assistant}#knowledge` : assistantList, label: '知识库', short: '知' },
    { href: assistant ? `${assistant}#release` : assistantList, label: '测试与发布', short: '发' },
    { href: merchantId ? `${workspace}/conversations` : workspace, label: '咨询管理', short: '询' },
  ];

  return (
    <nav aria-label="商家后台主导航" className="merchant-nav">
      {navItems.map((item) => {
        const active = item.href === pathname;

        return (
          <Link
            aria-current={active ? 'page' : undefined}
            className={active ? 'merchant-nav__item is-active' : 'merchant-nav__item'}
            href={item.href}
            key={item.label}
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
