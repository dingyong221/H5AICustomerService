'use client';

import { createElement, useState } from 'react';
import { publishedTelephoneNumbers } from './consumer-recovery';

export function HumanContactNotice({ instructions }: { instructions: string | undefined }) {
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const contact = instructions?.trim() ?? '';
  const numbers = publishedTelephoneNumbers(contact);
  return createElement(
    'details',
    { className: 'human-contact-notice', open: Boolean(contact) },
    createElement('summary', null, '联系商家 / 人工服务'),
    createElement(
      'p',
      null,
      contact ||
        '商家尚未提供人工联系说明。请通过你购买商品或服务时使用的商家渠道联系，不要向 AI 提供支付密码或验证码。',
    ),
    contact
      ? createElement(
          'div',
          { className: 'contact-actions' },
          ...numbers.map((number) =>
            createElement('a', { href: `tel:${number}`, key: number }, `拨打 ${number}`),
          ),
          createElement(
            'button',
            {
              type: 'button',
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(contact);
                  setCopyNotice('已复制联系说明，请通过商家公布的方式联系。');
                } catch {
                  setCopyNotice('未能自动复制，请长按或选中上方联系说明复制。');
                }
              },
            },
            '复制联系说明',
          ),
        )
      : null,
    copyNotice ? createElement('p', { role: 'status' }, copyNotice) : null,
    createElement(
      'p',
      null,
      '此处不实时转接；请通过以上方式联系。发送消息不会自动通知人工或表示商家已受理。',
    ),
  );
}
