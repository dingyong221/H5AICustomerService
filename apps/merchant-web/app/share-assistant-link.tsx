'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

import { safeShareAssistantUrl } from './share-assistant-url';

type QrState = Readonly<{ href: string; dataUrl: string | null }>;

export function ShareAssistantLink({
  href,
  expectedOrigin,
}: {
  href: string;
  expectedOrigin: string;
}) {
  const safeHref = safeShareAssistantUrl(href, expectedOrigin);
  const [qr, setQr] = useState<QrState>();

  useEffect(() => {
    if (!safeHref) return;
    let active = true;
    void import('./share-assistant-qr')
      .then(({ generateAssistantQrDataUrl }) => generateAssistantQrDataUrl(safeHref))
      .then((dataUrl) => {
        if (active) setQr({ href: safeHref, dataUrl });
      })
      .catch(() => {
        if (active) setQr({ href: safeHref, dataUrl: null });
      });
    return () => {
      active = false;
    };
  }, [safeHref]);

  if (!safeHref) return <p role="alert">消费者链接未通过校验，请勿分享。</p>;

  const currentQr = qr?.href === safeHref ? qr : undefined;
  const publicSlug = new URL(safeHref).pathname.slice(3);
  return (
    <div className="assistant-share">
      <p>
        消费者链接：<a href={safeHref}>{safeHref}</a>
      </p>
      {currentQr?.dataUrl ? (
        <div className="assistant-share__qr">
          <Image
            alt="扫码打开消费者 AI 客服"
            height={224}
            src={currentQr.dataUrl}
            unoptimized
            width={224}
          />
          <a download={`ai-customer-service-${publicSlug}.png`} href={currentQr.dataUrl}>
            下载二维码
          </a>
        </div>
      ) : (
        <p role="status">
          {currentQr ? '二维码暂不可用，可复制上方链接。' : '正在生成分享二维码…'}
        </p>
      )}
    </div>
  );
}
