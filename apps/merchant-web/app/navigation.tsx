'use client';

import { useState } from 'react';
import { useParams, usePathname } from 'next/navigation';
import Link from 'next/link';

import { assistantWorkflowSteps } from './assistant-workflow';
import { merchantPath } from './tenant-paths';

type NavigationItem = { href: string; label: string; short: string; count?: number | null };

export function MerchantNavigation({
  merchantId,
  improvementCount,
}: {
  merchantId?: string | undefined;
  improvementCount?: number | null;
}) {
  const pathname = usePathname();
  const params = useParams<{ merchantId?: string; assistantId?: string }>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const authorizedMerchant =
    merchantId && (!params.merchantId || params.merchantId === merchantId) ? merchantId : null;
  const reference =
    authorizedMerchant &&
    typeof params.assistantId === 'string' &&
    /^[0-9a-f]{32}$/u.test(params.assistantId)
      ? params.assistantId
      : undefined;
  const path = (section?: Parameters<typeof merchantPath>[1], assistantId?: string) =>
    authorizedMerchant
      ? merchantPath(authorizedMerchant, section, assistantId)
      : '/console/account/login';
  const groups: { id: string; title: string; short: string; items: NavigationItem[] }[] = [
    {
      id: 'assistants',
      title: 'AI 客服',
      short: '客',
      items: [
        { href: path('drafts'), label: 'AI客服管理', short: '管' },
        ...(reference
          ? assistantWorkflowSteps.map((step, index) => ({
              href: path(step.section, reference),
              label: step.title,
              short: String(index + 1),
            }))
          : []),
      ],
    },
    {
      id: 'operations',
      title: '日常运营',
      short: '营',
      items: [
        { href: path('conversations'), label: '咨询管理', short: '询' },
        {
          href: path('improvements'),
          label: '问题与改进',
          short: '改',
          count: improvementCount ?? null,
        },
      ],
    },
    {
      id: 'support',
      title: '支持工具',
      short: '助',
      items: [
        { href: path('writing'), label: '资料填写助手', short: '写' },
        { href: path('help'), label: '帮助中心', short: '助' },
      ],
    },
  ];
  const active = (item: NavigationItem) =>
    authorizedMerchant !== null &&
    (pathname === item.href ||
      ((item.label === '问题与改进' || item.label === '咨询管理') &&
        pathname.startsWith(`${item.href}/`)));
  function navigationLink(item: NavigationItem, nested = false) {
    const isActive = active(item);
    return (
      <Link
        key={item.label}
        href={item.href}
        title={item.label}
        aria-label={
          item.count != null && authorizedMerchant
            ? `${item.label}，待推进 ${item.count} 项`
            : item.label
        }
        aria-current={isActive ? 'page' : undefined}
        className={`merchant-nav__item${nested ? ' merchant-nav__item--nested' : ''}${isActive ? ' is-active' : ''}`}
        onClick={() => setMobileOpen(false)}
      >
        <span aria-hidden="true" className="merchant-nav__icon">
          {item.short}
        </span>
        <span className="merchant-nav__label">
          {item.label}
          {item.count != null && authorizedMerchant ? (
            <span className="improvement-nav-count">{item.count}</span>
          ) : null}
        </span>
      </Link>
    );
  }
  return (
    <nav aria-label="商家后台主导航" className="merchant-nav" data-mobile-open={mobileOpen}>
      <button
        aria-controls="merchant-navigation-tree"
        aria-expanded={mobileOpen}
        className="merchant-nav__mobile-toggle"
        onClick={() => setMobileOpen((previous) => !previous)}
        type="button"
      >
        {mobileOpen ? '收起菜单' : '展开菜单'}
      </button>
      <div className="merchant-nav__tree" id="merchant-navigation-tree">
        {navigationLink({ href: path(), label: '工作台', short: '台' })}
        {groups.map((group) => {
          const groupActive = group.items.some(active);
          return (
            <details
              className="merchant-nav__group"
              key={`${group.id}:${pathname}`}
              open={groupActive || group.id === 'assistants'}
            >
              <summary>
                <span aria-hidden="true" className="merchant-nav__icon">
                  {group.short}
                </span>
                <span className="merchant-nav__label">{group.title}</span>
                <span aria-hidden="true" className="merchant-nav__chevron">
                  ⌄
                </span>
              </summary>
              <div className="merchant-nav__children">
                {group.items.map((item) => navigationLink(item, true))}
              </div>
            </details>
          );
        })}
      </div>
    </nav>
  );
}
