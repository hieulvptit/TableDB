import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, toCsv } from './csv';
import { insertStatements, metaSql, qualified, sqlLiteral, toSqlScript } from './tableSql';

const ref = { schema: 'APP', name: "O'RDERS" };

describe('metaSql', () => {
  it('escapes literals and targets the right catalog per dialect', () => {
    expect(metaSql('indexes', ref, 'oracle')).toContain("TABLE_NAME = 'O''RDERS'");
    expect(metaSql('indexes', { schema: 'public', name: 'orders' }, 'postgresql')).toContain("t.relname = 'orders'");
    expect(metaSql('partitions', { schema: 'public', name: 'orders' }, 'postgresql')).toContain('pg_inherits');
  });
  it('oracle partitions select the LONG column last', () => {
    expect(metaSql('partitions', ref, 'oracle')).toMatch(/HIGH_VALUE FROM ALL_TAB_PARTITIONS/);
  });
  it('trino has no indexes; partitions use the $partitions table', () => {
    const r = { catalog: 'hive', schema: 'web', name: 'events' };
    expect(metaSql('indexes', r, 'trino')).toBeNull();
    expect(metaSql('partitions', r, 'trino')).toBe('SELECT * FROM hive.web."events$partitions"');
  });
  it('only ever produces read statements', () => {
    for (const d of ['oracle', 'postgresql', 'trino'] as const) for (const k of ['indexes', 'partitions', 'properties'] as const) {
      const s = metaSql(k, ref, d);
      if (s) expect(s).toMatch(/^(SELECT|SHOW)\b/);
    }
  });
});

describe('sql literals / INSERT generation', () => {
  it('quotes strings, keeps numerics, NULLs and dates per dialect', () => {
    expect(sqlLiteral("a'b", 'varchar', 'postgresql')).toBe("'a''b'");
    expect(sqlLiteral('12.5', 'numeric', 'postgresql')).toBe('12.5');
    expect(sqlLiteral('12.5', 'varchar', 'postgresql')).toBe("'12.5'");
    expect(sqlLiteral(null, 'int4', 'oracle')).toBe('NULL');
    expect(sqlLiteral('2024-01-02T03:04:05Z', 'DATE', 'oracle')).toBe("TO_DATE('2024-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS')");
    expect(sqlLiteral('2024-01-02', 'date', 'trino')).toBe("DATE '2024-01-02'");
  });
  it('batches rows; oracle uses INSERT ALL', () => {
    const cols = [{ name: 'id', typeName: 'int4' }, { name: 'name', typeName: 'text' }];
    const rows = Array.from({ length: 450 }, (_, i) => [String(i), `n${i}`]);
    expect(insertStatements({ schema: 'public', name: 't' }, 'postgresql', cols, rows)).toHaveLength(3);
    const o = insertStatements({ schema: 'APP', name: 'T' }, 'oracle', cols.map((c) => ({ ...c, name: c.name.toUpperCase() })), rows.slice(0, 2))[0]!;
    expect(o).toMatch(/^INSERT ALL\n {2}INTO APP\.T \(ID, NAME\) VALUES \(0, 'n0'\)/);
    expect(o.endsWith('SELECT 1 FROM DUAL')).toBe(true);
    expect(toSqlScript({ schema: 'public', name: 't' }, 'postgresql', cols, rows.slice(0, 1))).toBe("INSERT INTO public.t (id, name) VALUES\n  (0, 'n0');");
  });
  it('qualifies trino names with the catalog', () => { expect(qualified({ catalog: 'hive', schema: 's', name: 't' }, 'trino')).toBe('hive.s.t'); });
});

describe('csv parse', () => {
  it('round-trips quotes, commas and newlines', () => {
    const csv = toCsv(['a', 'b'], [['x,y', 'line1\nline2'], ['he said "hi"', null]]);
    expect(parseCsv(csv)).toEqual([['a', 'b'], ['x,y', 'line1\nline2'], ['he said "hi"', '']]);
  });
  it('detects ; and tab, ignores BOM and blank lines', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(parseCsv('﻿a,b\r\n\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});
