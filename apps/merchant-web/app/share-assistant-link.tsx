'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

import { safeShareAssistantUrl } from './share-assistant-url';

type QrState = Readonly<{ href: string; dataUrl: string | null }>;
type CopyResult = 'copied' | 'failed';

export async function copyAssistantLink(
  href: string,
  expectedOrigin: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
): Promise<CopyResult> {
  const safeHref = safeShareAssistantUrl(href, expectedOrigin);
  if (!safeHref || !clipboard) return 'failed';
  try {
    await clipboard.writeText(safeHref);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export function ShareAssistantLink({
  href,
  expectedOrigin,
}: {
  href: string;
  expectedOrigin: string;
}) {
  const safeHref = safeShareAssistantUrl(href, expectedOrigin);
  const [qr, setQr] = useState<QrState>();
  const [copy, setCopy] = useState<Readonly<{ href: string; result: CopyResult }>>();

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
  const copyState = copy?.href === safeHref ? copy.result : 'idle';
  const publicSlug = new URL(safeHref).pathname.slice(3);
  return (
    <div className="assistant-share">
      {['127.0.0.1', 'localhost'].includes(new URL(safeHref).hostname) ? (
        <p role="note">本地测试客户咨询码：仅本机有效，不是正式产品领取码。</p>
      ) : null}
      <p>
        固定消费者链接：<a href={safeHref}>{safeHref}</a>
      </p>
      <p>把此链接或二维码发给消费者即可咨询。保存草稿、刷新页面和发布新版不会更换此地址。</p>
      <button
        type="button"
        onClick={() => {
          void copyAssistantLink(safeHref, expectedOrigin, navigator.clipboard).then((result) =>
            setCopy({ href: safeHref, result }),
          );
        }}
      >
        复制消费者链接
      </button>
      {copyState !== 'idle' ? (
        <p role="status">
          {copyState === 'copied'
            ? '固定链接已复制，可发送给消费者。'
            : '自动复制未成功，请选中上方链接手动复制。'}
        </p>
      ) : null}
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
