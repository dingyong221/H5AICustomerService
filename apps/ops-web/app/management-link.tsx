'use client';

import { useState } from 'react';

export function ManagementLink({ href }: { href: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="ops-management-link">
      <span>商家管理后台：</span>
      <a href={href} rel="noopener noreferrer" target="_blank">
        {href}
      </a>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(href);
            setCopyStatus('copied');
          } catch {
            setCopyStatus('failed');
          }
        }}
        type="button"
      >
        复制链接
      </button>
      {copyStatus === 'copied' ? <small role="status">已复制。请确认接收人后再发送。</small> : null}
      {copyStatus === 'failed' ? <small role="alert">复制失败，请手动复制链接。</small> : null}
    </div>
  );
}
