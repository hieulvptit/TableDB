import { describe, expect, it } from 'vitest';
import { jsonLines, textLines, TEXT_CELL_MAX } from './resultText';
import { tableDataSql } from './tableSql';

describe('result views', () => {
  it('JSON view is a valid pretty-printed array of row objects', () => {
    const lines = jsonLines(['id', 'name'], [[1, 'a'], [2, null]]);
    expect(JSON.parse(lines.join('\n'))).toEqual([{ id: 1, name: 'a' }, { id: 2, name: null }]);
    expect(jsonLines(['id'], [])).toEqual(['[', ']']);
  });
  it('Text view pads columns, right-aligns numbers and clips long / multi-line cells', () => {
    const long = 'x'.repeat(100);
    const lines = textLines([{ name: 'id', numeric: true }, { name: 'note' }], [[5, 'a\nb'], [120, long], [null, 'z']]);
    expect(lines[0]).toBe('id   | note'); // width 4 = 'NULL'
    expect(lines[1]).toBe(`-----+-${'-'.repeat(TEXT_CELL_MAX)}`);
    expect(lines[2]).toBe('   5 | a b');
    expect(lines[3]!.endsWith('…')).toBe(true);
    expect(lines[3]!.split(' | ')[1]).toHaveLength(TEXT_CELL_MAX);
    expect(lines[4]).toBe('NULL | z');
  });
  it('table data SQL has no LIMIT and appends an optional WHERE (trailing ; dropped)', () => {
    expect(tableDataSql({ schema: 'public', name: 'orders' }, 'postgresql')).toBe('SELECT * FROM public.orders');
    expect(tableDataSql({ schema: 'APP', name: 'T' }, 'oracle', " status = 'A' ; ")).toBe("SELECT * FROM APP.T\nWHERE status = 'A'");
  });
});
