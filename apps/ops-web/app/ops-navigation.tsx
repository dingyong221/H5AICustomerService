'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function OpsNavigation() {
  const raw = usePathname();
  const pathname = raw === '/ops' ? '/' : raw.startsWith('/ops/') ? raw.slice(4) : raw;
  return (
    <nav aria-label="运营后台主导航" className="ops-nav">
      {[
        ['/', '运营总览'],
        ['/merchants', '商家管理'],
        ['/reports', '数据报表'],
        ['/#provision', '商家开通'],
        ['/#industry-templates', '行业模板'],
        ['/#tasks', '任务与审计'],
      ].map(([href, label]) => (
        <Link
          key={href}
          href={href!}
          aria-current={
            !href!.includes('#') && (href === '/' ? pathname === '/' : pathname.startsWith(href!))
              ? 'page'
              : undefined
          }
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
