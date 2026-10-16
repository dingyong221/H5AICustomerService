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
    multiline.set('materialsSummary', '问：服务范围？\t答：需向商家确认。');
    expect(parseAssistantDraftForm(multiline)?.materialsSummary).toBe(
      '问：服务范围？ 答：需向商家确认。',
    );
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

  it('keeps the legacy draft shape without contact and accepts only bounded plain contact instructions', () => {
    expect(parseAssistantDraftForm(completeForm())).not.toHaveProperty('humanContact');
    const data = completeForm();
    data.set('humanContact', ' 工作日 9:00—18:00\r\n微信：shop_service ');
    expect(parseAssistantDraftForm(data)?.humanContact).toBe(
      '工作日 9:00—18:00\n微信：shop_service',
    );
    data.set('humanContact', '');
    expect(parseAssistantDraftForm(data)).not.toHaveProperty('humanContact');
    for (const invalid of ['联'.repeat(501), '<b>假转接</b>', '联系\u0000商家']) {
      data.set('humanContact', invalid);
      expect(parseAssistantDraftForm(data)).toBeNull();
    }
  });
});
