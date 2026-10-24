import { describe, expect, it } from 'vitest';
import { inspectBusinessFacts } from '../src/publication-governance.js';

const now = new Date('2026-10-24T08:00:00Z');
const inspect = (materialsSummary: string, pricingSummary: string, promotionSummary = '暂无优惠') =>
  inspectBusinessFacts({ materialsSummary, pricingSummary, promotionSummary }, now);
const blocked = (issues: ReturnType<typeof inspect>) =>
  issues.some((item) => item.severity === 'blocking');

describe('narrow business fact publication checks', () => {
  it('blocks different prices for an identical named project and identical conditions', () => {
    expect(blocked(inspect('清洗：79元/台，仅限壁挂机', '清洗：89元/台，仅限壁挂机'))).toBe(true);
  });
  it('blocks explicit generic and bare scalar prices across fields', () => {
    expect(blocked(inspect('价格：79元', '价格：89元'))).toBe(true);
    expect(blocked(inspect('79元', '89元'))).toBe(true);
  });
  it('does not merge distinct conditions, units or product names', () => {
    for (const [left, right] of [
      ['清洗：79元，仅限壁挂机', '清洗：99元，仅限柜机'],
      ['清洗：79元/台', '清洗：99元/次'],
      ['M1：79元', 'M2：99元'],
    ])
      expect(blocked(inspect(left!, right!))).toBe(false);
  });
  it('does not call original and promotional prices a contradiction', () => {
    expect(blocked(inspect('原价：100元', '优惠价：79元'))).toBe(false);
  });
  it('blocks same-question same-condition numeric FAQ conflicts', () => {
    expect(
      blocked(inspect('问：运费多少？\n答：新疆单件15元', '问：运费多少？\n答：新疆单件20元')),
    ).toBe(true);
  });
  it('only warns on different FAQ conditions or paraphrases', () => {
    expect(
      blocked(inspect('问：运费多少？\n答：新疆单件15元', '问：运费多少？\n答：广东单件0元')),
    ).toBe(false);
    expect(blocked(inspect('问：你好？\n答：你好', '问：你好？\n答：您好'))).toBe(false);
  });
  it('treats explicit deadline as inclusive through its Beijing calendar day', () => {
    const draft = {
      materialsSummary: '真实服务',
      pricingSummary: '需确认',
      promotionSummary: '有效期至2026-10-24',
    };
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T15:59:59.999Z')))).toBe(false);
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T16:00:00Z')))).toBe(true);
  });
  it('blocks invalid explicit dates without guessing unrelated dates as expiry', () => {
    expect(blocked(inspect('成立于2020-01-01', '需确认', '无优惠'))).toBe(false);
    for (const date of ['2026-02-30', '2026-13-01', '2026-00-01', '2026-10-00'])
      expect(inspect('商品', '需确认', `有效至${date}`)).toContainEqual(
        expect.objectContaining({ code: 'RULE_TIME_REVIEW', severity: 'blocking' }),
      );
  });
  it.each([
    ' 12:00',
    'T12:00',
    ' 北京时间12:00',
    ' 中国标准时间12:00',
    '，北京时间12:00',
    ' 12:00:00',
  ])('enforces supported explicit clock variant %s', (suffix) => {
    const draft = {
      materialsSummary: '商品',
      pricingSummary: '需确认',
      promotionSummary: `截止时间2026-10-24${suffix}`,
    };
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T03:59:59.999Z')))).toBe(false);
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T04:00:00Z')))).toBe(true);
  });
  it('enforces an explicit Beijing hour and minute exactly, rather than extending to the day end', () => {
    const draft = {
      materialsSummary: '商品',
      pricingSummary: '商品A：99元',
      promotionSummary: '优惠截止时间2026-10-24 12:00，满99减10',
    };
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T03:59:59.999Z')))).toBe(false);
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T04:00:00Z')))).toBe(true);
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T05:00:00Z')))).toBe(true);
  });
  it('blocks unsupported explicit time syntax and invalid hour/minute instead of silently extending expiry', () => {
    for (const time of [
      '25:00',
      '123:00',
      '-1:00',
      '当地时间12:00',
      '12:99',
      '12:00:60',
      '12点',
      '12时00分',
      '下午12点',
      '北京时间12点',
      '12:00Z',
      '12:00+08:00',
      '08:00PM',
    ])
      expect(inspect('商品', '需确认', `优惠截止时间2026-10-24 ${time}`)).toContainEqual(
        expect.objectContaining({ code: 'RULE_TIME_REVIEW', severity: 'blocking' }),
      );
  });
  it('honors explicit seconds at the precise cutoff', () => {
    const draft = {
      materialsSummary: '商品',
      pricingSummary: '需确认',
      promotionSummary: '截止时间2026-10-24T12:00:30',
    };
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T04:00:29.999Z')))).toBe(false);
    expect(blocked(inspectBusinessFacts(draft, new Date('2026-10-24T04:00:30Z')))).toBe(true);
  });
  it('fails on an invalid trusted clock', () => {
    expect(() =>
      inspectBusinessFacts(
        { materialsSummary: '服务', pricingSummary: '需确认', promotionSummary: '无' },
        new Date('invalid'),
      ),
    ).toThrow();
  });
});
