'use client';

import { useState } from 'react';

export function SetupLinkResult({
  name,
  setupUrl,
  expiresAt,
  reissued = false,
}: {
  name: string;
  setupUrl: string;
  expiresAt: string;
  reissued?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(setupUrl);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  return (
    <div className="ops-created" role="status">
      <strong>{reissued ? `${name} 的新领取链接已生成` : `${name} 已创建，等待商家领取`}</strong>
      <p>
        {reissued
          ? '仅通过受控渠道交给商家负责人；本页离开后不再显示明文链接。'
          : '请将下列一次性链接通过受控渠道交给商家负责人。链接过期后需重新签发。'}
      </p>
      <output>{setupUrl}</output>
      <button onClick={() => void copyLink()} type="button">
        复制领取链接
      </button>
      {copyStatus === 'copied' ? <span>已复制。请确认接收人后再发送。</span> : null}
      {copyStatus === 'failed' ? <span>复制失败，请手动选择上方链接。</span> : null}
      <small>有效期至 {new Date(expiresAt).toLocaleString('zh-CN')}</small>
    </div>
  );
}
