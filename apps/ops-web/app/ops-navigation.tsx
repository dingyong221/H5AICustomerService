'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState, useSyncExternalStore } from 'react';

import { opsHref } from './ops-path';
import { opsMenuGroups, selectedOpsHref } from './ops-navigation-model';

function subscribeHash(change: () => void) {
  window.addEventListener('hashchange', change);
  window.addEventListener('popstate', change);
  return () => {
    window.removeEventListener('hashchange', change);
    window.removeEventListener('popstate', change);
  };
}
const readHash = () => window.location.hash;
const serverHash = () => '';

function NavigationTree({
  selected,
  onNavigate,
}: {
  selected: string | null;
  onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useState<string[]>(() =>
    opsMenuGroups
      .filter((group) => group.items.some((item) => item.href === selected))
      .map((group) => group.id),
  );
  return (
    <nav aria-label="运营后台主导航" className="ops-nav">
      <Link aria-current={selected === '/' ? 'page' : undefined} href="/" onClick={onNavigate}>
        <span aria-hidden="true" className="ops-menu-icon">
          总
        </span>
        运营总览
      </Link>
      {opsMenuGroups.map((group) => {
        const open = expanded.includes(group.id);
        const active = group.items.some((item) => item.href === selected);
        return (
          <div className="ops-menu-group" key={group.id}>
            <button
              aria-controls={`ops-menu-${group.id}`}
              aria-expanded={open}
              className="ops-menu-toggle"
              data-active={active}
              onClick={() =>
                setExpanded((current) =>
                  open ? current.filter((id) => id !== group.id) : [...current, group.id],
                )
              }
              type="button"
            >
              <span aria-hidden="true" className="ops-menu-icon">
                {group.icon}
              </span>
              {group.label}
              <span aria-hidden="true" className="ops-menu-chevron">
                ›
              </span>
            </button>
            <ul className="ops-submenu" hidden={!open} id={`ops-menu-${group.id}`}>
              {group.items.map((item) => (
                <li key={item.href}>
                  {item.href.includes('#') ? (
                    <a
                      aria-current={selected === item.href ? 'location' : undefined}
                      href={opsHref(item.href)}
                      onClick={onNavigate}
                    >
                      {item.label}
                    </a>
                  ) : (
                    <Link
                      aria-current={selected === item.href ? 'page' : undefined}
                      href={item.href}
                      onClick={onNavigate}
                    >
                      {item.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function Sidebar({ selected }: { selected: string | null }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  function closeMenu() {
    setMobileOpen(false);
    // The mobile menu is inline, not a modal. Return focus before hiding links.
    if (window.matchMedia('(max-width: 800px)').matches) toggle.current?.focus();
  }
  return (
    <aside
      aria-label="平台运营导航"
      className="ops-sidebar"
      data-expanded={mobileOpen}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && mobileOpen) closeMenu();
      }}
    >
      <div className="ops-sidebar-header">
        <Link aria-label="H5 AI 客服运营中心" className="ops-brand" href="/" onClick={closeMenu}>
          <span aria-hidden="true">H5</span>
          <strong>运营中心</strong>
        </Link>
        <button
          aria-controls="ops-sidebar-body"
          aria-expanded={mobileOpen}
          className="ops-mobile-toggle"
          onClick={() => setMobileOpen(!mobileOpen)}
          ref={toggle}
          type="button"
        >
          {mobileOpen ? '收起菜单' : '展开菜单'}
        </button>
      </div>
      <div className="ops-sidebar-body" id="ops-sidebar-body">
        <p className="ops-nav-caption">平台管理</p>
        <NavigationTree key={selected} onNavigate={closeMenu} selected={selected} />
        <div className="ops-identity">
          <span aria-hidden="true">运</span>
          <div>
            <strong>运营后台</strong>
            <small>会话由服务端验证</small>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ConnectedSidebar() {
  const path = usePathname();
  const search = useSearchParams();
  const hash = useSyncExternalStore(subscribeHash, readHash, serverHash);
  return <Sidebar selected={selectedOpsHref(path, search.get('report'), hash)} />;
}

export function OpsSidebar() {
  return (
    <Suspense fallback={<Sidebar selected={null} />}>
      <ConnectedSidebar />
    </Suspense>
  );
}
