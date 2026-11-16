export const opsMenuGroups = [
  {
    id: 'merchants',
    label: '商家运营',
    icon: '商',
    items: [
      { href: '/merchants', label: '商家管理' },
      { href: '/#provision', label: '商家开通' },
      { href: '/#industry-templates', label: '行业模板' },
    ],
  },
  {
    id: 'reports',
    label: '数据报表',
    icon: '报',
    items: [
      { href: '/reports?report=daily', label: '每日使用' },
      { href: '/reports?report=merchants', label: '商家使用' },
      { href: '/reports?report=assistants', label: '客服使用' },
      { href: '/reports?report=quality', label: '改进与复测' },
      { href: '/reports?report=errors', label: '异常分布' },
    ],
  },
  {
    id: 'runtime',
    label: '运行管理',
    icon: '运',
    items: [
      { href: '/#assistants', label: '最近客服状态' },
      { href: '/#tasks', label: '运行控制与异常' },
      { href: '/#audit-log', label: '审计记录' },
    ],
  },
  {
    id: 'growth',
    label: '增长与使用',
    icon: '增',
    items: [{ href: '/growth', label: '邀请与行为统计' }],
  },
] as const;

export function normalizeOpsPath(raw: string) {
  return raw === '/ops' ? '/' : raw.startsWith('/ops/') ? raw.slice(4) : raw;
}

export function selectedOpsHref(pathname: string, report: string | null, hash: string) {
  const path = normalizeOpsPath(pathname);
  if (path === '/merchants' || path.startsWith('/merchants/')) return '/merchants';
  if (path === '/growth') return '/growth';
  if (path === '/reports') {
    const kind = opsMenuGroups[1].items.some((item) => item.href === `/reports?report=${report}`)
      ? report
      : 'daily';
    return `/reports?report=${kind}`;
  }
  if (path === '/') {
    const anchor = `/${hash}`;
    return opsMenuGroups.some((group) => group.items.some((item) => item.href === anchor))
      ? anchor
      : '/';
  }
  return null;
}
