import { createElement } from 'react';

export function HumanContactNotice({ instructions }: { instructions: string | undefined }) {
  return createElement(
    'details',
    { className: 'human-contact-notice' },
    createElement('summary', null, '联系商家 / 人工服务'),
    createElement(
      'p',
      null,
      instructions?.trim() ||
        '商家尚未提供人工联系说明。请通过你购买商品或服务时使用的商家渠道联系，不要向 AI 提供支付密码或验证码。',
    ),
    createElement(
      'p',
      null,
      '此处不实时转接；请通过以上方式联系。发送消息不会自动通知人工或表示商家已受理。',
    ),
  );
}
