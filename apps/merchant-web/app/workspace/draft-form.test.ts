import { describe, expect, it } from 'vitest';

import { parseAssistantDraftForm } from './draft-form';

const completeForm = (): FormData => {
  const data = new FormData();
  data.set('industry', ' 家政服务 ');
  data.set('businessScope', '空调清洗咨询');
  data.set('materialsSummary', '商家提供挂机清洗服务');
  data.set('pricingSummary', '挂机清洗每台 100 元');
  data.set('promotionSummary', '目前无优惠');
  data.set('welcomeMessage', '你好，我是 AI 客服。');
  data.set('insufficientInfoMessage', '该信息需要商家确认。');
  return data;
};

describe('merchant assistant draft form', () => {
  it('normalizes complete merchant-provided facts', () => {
    expect(parseAssistantDraftForm(completeForm())).toMatchObject({
      industry: '家政服务',
      pricingSummary: '挂机清洗每台 100 元',
    });
    const multiline = completeForm();
    multiline.set('materialsSummary', '服务 A\r\n服务 B');
    expect(parseAssistantDraftForm(multiline)?.materialsSummary).toBe('服务 A\n服务 B');
  });

  it('rejects missing, oversized, and control-character facts', () => {
    const missing = completeForm();
    missing.delete('materialsSummary');
    expect(parseAssistantDraftForm(missing)).toBeNull();
    const oversized = completeForm();
    oversized.set('industry', '客'.repeat(129));
    expect(parseAssistantDraftForm(oversized)).toBeNull();
    const control = completeForm();
    control.set('pricingSummary', '100 元\u0000');
    expect(parseAssistantDraftForm(control)).toBeNull();
  });
});
