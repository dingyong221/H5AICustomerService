import { describe, expect, it } from 'vitest';
import {
  filterMaterials,
  materialKind,
  reviewMaterials,
  knowledgeTemplates,
} from './material-review';
const item = (id: string, name: string, text: string, hash = id.repeat(64).slice(0, 64)) => ({
  id,
  name,
  text,
  sha256: hash,
  size: 10,
  createdAt: '2026-10-22T00:00:00Z',
});
describe('merchant-language material maintenance', () => {
  it('searches name and raw text, and only classifies by file format', () => {
    const data = [item('a', '商品.XLSX', '保温杯39元'), item('b', '营业说明.pdf', '周末10点开门')];
    expect(materialKind('catalog.CSV')).toBe('table');
    expect(materialKind('faq.md')).toBe('text');
    expect(materialKind('报价.doc')).toBe('document');
    expect(filterMaterials(data, '周末', 'all').map((x) => x.id)).toEqual(['b']);
    expect(filterMaterials(data, '商品', 'table').map((x) => x.id)).toEqual(['a']);
    expect(filterMaterials(data, '商品', 'document')).toEqual([]);
    expect(filterMaterials(data, '   ', 'all')).toHaveLength(2);
    expect(data).toHaveLength(2);
  });
  it('reminds of exact duplicate text even when filenames differ, without deleting either', () => {
    const data = [
      item('a', 'old.txt', '问：运费？\n答：单件15元'),
      item('b', 'new.txt', '问：运费？\n答：单件15元'),
    ];
    const result = reviewMaterials(data);
    expect(result.map((x) => x.code)).toEqual(['duplicate']);
    expect(result[0]?.sourceIds).toEqual(['a', 'b']);
    expect(data).toHaveLength(2);
  });
  it('finds conflicting explicit FAQ answers, preserves source names, and does not choose truth', () => {
    const result = reviewMaterials([
      item('a', '地区A.txt', '问：是否包邮？\n答：需要确认'),
      item('b', '地区B.txt', '问：是否包邮？\n答：单件不包邮'),
    ]);
    expect(result).toEqual([
      expect.objectContaining({ code: 'faq_conflict', sourceIds: ['a', 'b'] }),
    ]);
    expect(result[0]?.detail).toContain('适用条件');
    expect(result[0]?.detail).toContain('地区A.txt');
  });
  it('does not invent semantic conflict findings or identify SKU case changes as duplicates', () => {
    expect(
      reviewMaterials([item('a', 'a.txt', 'A型号39元'), item('b', 'b.txt', 'a型号39元')]),
    ).toEqual([]);
    expect(
      reviewMaterials([item('a', 'a.txt', '这件包邮'), item('b', 'b.txt', '新疆不包邮')]),
    ).toEqual([]);
  });
  it('recognizes inclusive China business cutoff dates, ignores invalid dates and unrelated historical dates', () => {
    const data = [
      item('a', '活动.txt', '截止：2026-10-22'),
      item('b', '坏日期.txt', '有效至2026年2月30日'),
      item('c', '历史.txt', '成立时间2020-01-01'),
    ];
    expect(reviewMaterials(data, new Date('2026-10-22T15:59:59Z'))).toEqual([]);
    expect(reviewMaterials(data, new Date('2026-10-22T16:00:00Z')).map((x) => x.code)).toEqual([
      'expired',
    ]);
    expect(
      reviewMaterials(
        [item('a', '活动.txt', '有效至2026年10月21日')],
        new Date('2026-10-22T00:00:00Z'),
      )[0]?.code,
    ).toBe('expired');
  });
  it('templates cover merchant topics but contain no invented business promises', () => {
    expect(knowledgeTemplates.map((x) => x.id)).toEqual([
      'product',
      'service',
      'price',
      'hours',
      'after_sales',
      'faq',
    ]);
    for (const t of knowledgeTemplates) {
      expect(t.text).toContain('待补充');
      expect(t.text.length).toBeLessThan(4000);
    }
  });
});
