'use client';

import { useState } from 'react';

export function ReportDownloadButton({
  href,
  children,
  secondary = false,
}: {
  href: string;
  children: string;
  secondary?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const target = new URL(href, window.location.origin);
      if (target.origin !== window.location.origin) throw new Error('下载地址无效，请刷新页面。');
      const result = await fetch(target, {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
      if (!result.ok) {
        const body: unknown = await result.json();
        throw new Error(
          typeof body === 'object' &&
            body !== null &&
            'error' in body &&
            typeof body.error === 'string'
            ? body.error
            : '导出失败，请稍后重试。',
        );
      }
      const filename =
        /^attachment; filename="(h5cs-[a-z]+-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv)"$/u.exec(
          result.headers.get('content-disposition') ?? '',
        )?.[1];
      if (!filename || !result.headers.get('content-type')?.startsWith('text/csv'))
        throw new Error('报表格式无效，请重新登录后再试。');
      const blob = await result.blob(),
        url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '网络暂不可用，请稍后重试。');
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="ops-download-control">
      <button
        type="button"
        className={secondary ? 'ops-secondary-link' : 'ops-primary-link'}
        disabled={pending}
        onClick={() => void download()}
      >
        {pending ? '正在生成报表…' : children}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
