'use client';
import { useParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { merchantPath } from './tenant-paths';

export function MerchantNavigation({
  merchantId,
  improvementCount,
}: {
  merchantId?: string | undefined;
  improvementCount?: number | null;
}) {
  const pathname = usePathname();
  const params = useParams<{ merchantId?: string; assistantId?: string }>();
  const authorizedMerchant =
    merchantId && (!params.merchantId || params.merchantId === merchantId) ? merchantId : null;
  const reference =
    authorizedMerchant &&
    typeof params.assistantId === 'string' &&
    /^[0-9a-f]{32}$/u.test(params.assistantId)
      ? params.assistantId
      : undefined;
  const login = '/console/account/login';
  const items = [
    {
      href: authorizedMerchant ? merchantPath(authorizedMerchant) : login,
      label: '工作台',
      short: '台',
    },
    {
      href: authorizedMerchant ? merchantPath(authorizedMerchant, 'drafts', reference) : login,
      label: '客服草稿',
      short: '草',
    },
    {
      href: authorizedMerchant ? merchantPath(authorizedMerchant, 'knowledge', reference) : login,
      label: '知识库',
      short: '知',
    },
    {
      href: authorizedMerchant ? merchantPath(authorizedMerchant, 'publish', reference) : login,
      label: '测试与发布',
      short: '发',
    },
    {
      href: authorizedMerchant ? merchantPath(authorizedMerchant, 'conversations') : login,
      label: '咨询管理',
      short: '询',
    },
    {
      href: authorizedMerchant ? merchantPath(authorizedMerchant, 'improvements') : login,
      label: '问题与改进',
      short: '改',
    },
    {
      href: authorizedMerchant ? merchantPath(authorizedMerchant, 'writing') : login,
      label: '资料填写助手',
      short: '写',
    },
    {
      href: authorizedMerchant ? merchantPath(authorizedMerchant, 'help') : login,
      label: '帮助中心',
      short: '助',
    },
  ];
  return (
    <nav aria-label="商家后台主导航" className="merchant-nav">
      {items.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          title={item.label}
          aria-label={
            item.label === '问题与改进' && improvementCount != null
              ? `${item.label}，待推进 ${improvementCount} 项`
              : item.label
          }
          aria-current={
            item.href === pathname ||
            (item.label === '问题与改进' && pathname.startsWith(`${item.href}/`))
              ? 'page'
              : undefined
          }
          className={
            item.href === pathname ||
            (item.label === '问题与改进' && pathname.startsWith(`${item.href}/`))
              ? 'merchant-nav__item is-active'
              : 'merchant-nav__item'
          }
        >
          <span aria-hidden="true" className="merchant-nav__icon">
            {item.short}
          </span>
          <span>
            {item.label}
            {item.label === '问题与改进' && authorizedMerchant && improvementCount != null ? (
              <span className="improvement-nav-count">{improvementCount}</span>
            ) : null}
          </span>
        </Link>
      ))}
    </nav>
  );
}
