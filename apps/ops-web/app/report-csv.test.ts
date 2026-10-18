import { describe, expect, it } from 'vitest';
import { csvCell, reportCsv } from './report-csv';

describe('Chinese spreadsheet report export', () => {
  it.each([
    '=1+1',
    '+SUM(A1:A2)',
    '-cmd',
    '@SUM(1)',
    '  =HYPERLINK("x")',
    '\tvalue',
    '\rvalue',
    '\nvalue',
    '00000000000000000000000000000001',
  ])('neutralizes formula or numeric-ID coercion for %j', (value) => {
    expect(csvCell(value).startsWith('"\'')).toBe(true);
  });
  it('quotes separators, newlines and embedded quotes while keeping ordinary names intact', () => {
    expect(csvCell('商家,"A"\n分店')).toBe('"商家,""A""\n分店"');
    expect(csvCell('零售商家')).toBe('"零售商家"');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell(null)).toBe('""');
  });
  it('writes UTF-8 BOM and CRLF rows, including a header-only empty report', () => {
    expect(reportCsv(['商家', '问句'], [['测试', 1]])).toBe(
      '\ufeff"商家","问句"\r\n"测试","1"\r\n',
    );
    expect(reportCsv(['日期'], [])).toBe('\ufeff"日期"\r\n');
    expect(() => reportCsv(['a'], [[1, 2]])).toThrow('CSV column count');
  });
});
