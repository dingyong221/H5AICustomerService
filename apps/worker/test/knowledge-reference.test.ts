import { describe, expect, it } from 'vitest';
import { buildKnowledgeUnits, renderKnowledgeOrganization } from '../src/knowledge-grounding.js';

const source =
  '【来源：商品表.xlsx】\r\n毛巾29元/条；新疆单件运费15元。\r\n多件运费与包邮资格待确认。';

describe('source-reference material organization', () => {
  it('builds stable whole-sentence references preserving negation, conditions and source labels', () => {
    expect(buildKnowledgeUnits(source)).toEqual([
      { id: 'u0', sourceLabel: '【来源：商品表.xlsx】', text: '毛巾29元/条；新疆单件运费15元。' },
      { id: 'u1', sourceLabel: '【来源：商品表.xlsx】', text: '多件运费与包邮资格待确认。' },
    ]);
    const result = renderKnowledgeOrganization(source, {
      groups: [{ topic: '配送售后', unitIds: ['u0', 'u1'] }],
      reviewUnitIds: ['u1'],
    });
    expect(result?.summary).toBe(
      '配送售后：\n【来源：商品表.xlsx】\n毛巾29元/条；新疆单件运费15元。\n多件运费与包邮资格待确认。',
    );
    expect(result?.warnings).toContain('需核对原文：多件运费与包邮资格待确认。');
  });
  it('never uses model-supplied facts, rewrites, source names or free-form warnings', () => {
    const result = renderKnowledgeOrganization('不提供安装服务。配送政策需确认。', {
      groups: [{ topic: '商品/服务', unitIds: ['u0', 'u1'] }],
      reviewUnitIds: [],
      summary: '提供安装服务。不涉及配送。',
      warnings: ['以预约系统为准。'],
    });
    expect(result?.summary).toBe('商品/服务：\n不提供安装服务。\n配送政策需确认。');
    expect(JSON.stringify(result)).not.toContain('预约系统');
    expect(JSON.stringify(result)).not.toContain('不涉及配送');
  });
  it.each([
    null,
    [],
    {},
    { summary: '不涉及配送。', warnings: [] },
    { groups: [] },
    { groups: [{ topic: '商品/服务', unitIds: ['u999'] }] },
    { groups: [{ topic: '商品/服务', unitIds: [{ id: 'u0', text: '提供安装服务。' }] }] },
    { groups: [{ topic: '商品/服务', unitIds: [] }] },
    { groups: [{ topic: '商品/服务', unitIds: ['u0'] }], reviewUnitIds: ['u999'] },
  ])('rejects missing, malformed or unknown references: %j', (plan) => {
    expect(renderKnowledgeOrganization(source, plan)).toBeNull();
  });
  it('maps unrecognized headings to a neutral server label and deduplicates repeated IDs', () => {
    const result = renderKnowledgeOrganization(source, {
      groups: [
        { topic: '本店保证免运费', unitIds: ['u0', 'u0'] },
        { topic: '配送售后', unitIds: ['u0', 'u1'] },
      ],
    });
    expect(result?.summary).toContain('其他已提供信息：');
    expect(result?.summary).not.toContain('本店保证');
    expect(result?.summary.match(/毛巾29元/gu)).toHaveLength(1);
  });
  it('preserves both conflicting versions and their original source names instead of choosing hours', () => {
    const hours =
      '【来源：旧说明.txt】\n营业时间为9点至18点。\n【来源：新说明.txt】\n营业时间为10点至20点。';
    const result = renderKnowledgeOrganization(hours, {
      groups: [{ topic: '营业时间', unitIds: ['u0', 'u1'] }],
      reviewUnitIds: ['u0', 'u1'],
    });
    expect(result?.summary).toContain('【来源：旧说明.txt】\n营业时间为9点至18点。');
    expect(result?.summary).toContain('【来源：新说明.txt】\n营业时间为10点至20点。');
    expect(result?.summary).not.toContain('营业时间为9点至20点');
    expect(result?.warnings.some((text) => text.includes('冲突'))).toBe(true);
  });
  it('bounds dense/long materials, keeps whole units and warns about omissions', () => {
    for (const text of ['资料。'.repeat(8000), '资'.repeat(24000), '🧺'.repeat(12000)]) {
      const units = buildKnowledgeUnits(text);
      expect(units.length).toBeGreaterThan(0);
      expect(units.length).toBeLessThanOrEqual(80);
      expect(units.map((unit) => unit.text).join('')).toBe(text);
      const result = renderKnowledgeOrganization(text, {
        groups: [{ topic: '商品/服务', unitIds: units.map((unit) => unit.id) }],
        reviewUnitIds: [],
      });
      expect(result!.summary.length).toBeLessThanOrEqual(4000);
      expect(result?.warnings.some((warning) => warning.includes('未涵盖全部原文'))).toBe(true);
      expect(result?.summary).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
  });
  it('accepts a valid per-unit classification plan up to the advertised 80-unit input bound', () => {
    const text = Array.from({ length: 80 }, (_, index) => `商品条目${index}元。`).join('');
    const units = buildKnowledgeUnits(text);
    expect(units).toHaveLength(80);
    const result = renderKnowledgeOrganization(text, {
      groups: units.map((unit) => ({ topic: '商品/服务', unitIds: [unit.id] })),
      reviewUnitIds: [],
    });
    expect(result?.summary).toContain('商品条目79元。');
    expect(result?.warnings.some((warning) => warning.includes('未涵盖全部原文'))).toBe(false);
  });
});
