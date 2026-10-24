import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerServiceShell } from './customer-service-shell';

describe('unavailable customer entry', () => {
  beforeEach(() => vi.stubGlobal('React', React));
  afterEach(() => vi.unstubAllGlobals());
  it('provides safe refresh and original-channel guidance without guessing a contact or creating a session', () => {
    const html = renderToStaticMarkup(
      createElement(CustomerServiceShell, {
        result: {
          reason: 'api_unavailable',
          status: 'unavailable',
          requestId: 'request_1234567890',
        },
      }),
    );
    expect(html).toContain('刷新客服状态');
    expect(html).toContain('原购买渠道');
    expect(html).toContain('支持编号');
    expect(html).not.toContain('链接参数');
    expect(html).not.toContain('tel:');
    expect(html).not.toContain('已转接');
  });
  it('keeps paused entries disabled and does not expose an invented merchant contact', () => {
    const html = renderToStaticMarkup(
      createElement(CustomerServiceShell, {
        result: { reason: 'paused', status: 'unavailable' },
      }),
    );
    expect(html).toContain('咨询服务未开放');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('支持编号');
    expect(html).not.toContain('复制联系说明');
  });
});
