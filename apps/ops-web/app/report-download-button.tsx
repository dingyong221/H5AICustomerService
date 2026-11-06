'use client';

import { useState, useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
const clientReady = () => true;
const serverReady = () => false;

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
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
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
        signal: AbortSignal.timeout(60_000),
      });
      if (!result.ok) {
        const body: unknown = await result.json().catch(() => null);
        throw new Error(
          result.status >= 500
            ? '报表服务暂不可用，请稍后重试。'
            : typeof body === 'object' &&
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
      setError(
        failure instanceof Error && ['AbortError', 'TimeoutError'].includes(failure.name)
          ? '报表生成超时，请缩小范围后重试。'
          : failure instanceof TypeError
            ? '网络暂不可用，请稍后重试。'
            : failure instanceof Error && !(failure instanceof SyntaxError)
              ? failure.message
              : '网络暂不可用，请稍后重试。',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="ops-download-control">
      <button
        type="button"
        className={secondary ? 'ops-secondary-link' : 'ops-primary-link'}
        disabled={!hydrated || pending}
        onClick={() => void download()}
      >
        {!hydrated ? '正在准备导出…' : pending ? '正在生成报表…' : children}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <noscript>
        <a href={href}>下载 CSV（浏览器未启用脚本，错误将单独显示）</a>
      </noscript>
    </div>
  );
}
