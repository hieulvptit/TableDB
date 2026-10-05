import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { buildChartData, formatNumber, niceAxis, parseChartSpec, specFits, suggestSpec, toNumber } from './chart';

const cols = [{ name: 'DAY', typeName: 'date' }, { name: 'CHANNEL', typeName: 'varchar' }, { name: 'AMOUNT', typeName: 'numeric' }, { name: 'CNT', typeName: 'int4' }];
const rows: unknown[][] = [['2026-10-01', 'APP', '100.5', 2], ['2026-10-01', 'WEB', 50, 1], ['2026-10-02', 'APP', 70, 3]];

describe('toNumber', () => {
  it('parses numbers and numeric strings only', () => {
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber(' 7 ')).toBe(7);
    expect(toNumber(3n)).toBe(3);
    expect(toNumber('abc')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(NaN)).toBeNull();
    expect(toNumber(null)).toBeNull();
  });
});

describe('suggestSpec', () => {
  it('line for a date x, bar for a text x, kpi for one row, null without numbers', () => {
    expect(suggestSpec(cols, rows)).toMatchObject({ kind: 'line', x: 'DAY', y: ['AMOUNT', 'CNT'] });
    expect(suggestSpec(cols.slice(1), rows.map((r) => r.slice(1)))).toMatchObject({ kind: 'bar', x: 'CHANNEL', y: ['AMOUNT'] });
    expect(suggestSpec(cols, [rows[0]!])).toMatchObject({ kind: 'kpi', y: ['AMOUNT', 'CNT'] });
    expect(suggestSpec([{ name: 'A', typeName: 'varchar' }], [['x']])).toBeNull();
    expect(suggestSpec(cols, [])).toBeNull();
  });
  it('detects numeric columns without a type from sampled values', () => {
    expect(suggestSpec([{ name: 'K' }, { name: 'V' }], [['a', '1'], ['b', '2']])).toMatchObject({ kind: 'bar', x: 'K', y: ['V'] });
  });
});

describe('parseChartSpec', () => {
  it('accepts a valid spec and maps column names case-insensitively', () => {
    expect(parseChartSpec({ kind: 'bar', x: 'channel', y: 'amount', agg: 'avg', title: 'Doanh thu' }, cols)).toEqual({ kind: 'bar', x: 'CHANNEL', y: ['AMOUNT'], agg: 'avg', title: 'Doanh thu' });
  });
  it('rejects unknown columns, kinds and missing x', () => {
    expect(parseChartSpec({ kind: 'bar', x: 'NOPE', y: ['AMOUNT'] }, cols)).toBeNull();
    expect(parseChartSpec({ kind: 'bar', x: 'DAY', y: ['NOPE'] }, cols)).toBeNull();
    expect(parseChartSpec({ kind: 'radar', x: 'DAY', y: ['AMOUNT'] }, cols)).toBeNull();
    expect(parseChartSpec({ kind: 'line', y: ['AMOUNT'] }, cols)).toBeNull();
    expect(parseChartSpec([], cols)).toBeNull();
  });
  it('kpi needs no x; markup characters are stripped from the title', () => {
    expect(parseChartSpec({ kind: 'kpi', y: ['AMOUNT'], title: '<b>T</b>' }, cols)).toMatchObject({ kind: 'kpi', title: 'b T /b' });
  });
});

describe('buildChartData', () => {
  it('groups by x and sums', () => {
    const d = buildChartData({ kind: 'bar', x: 'CHANNEL', y: ['AMOUNT'], agg: 'sum' }, cols, rows);
    expect(d.labels).toEqual(['APP', 'WEB']);
    expect(d.series[0]!.values).toEqual([170.5, 50]);
  });
  it('avg, count and none', () => {
    expect(buildChartData({ kind: 'bar', x: 'CHANNEL', y: ['AMOUNT'], agg: 'avg' }, cols, rows).series[0]!.values).toEqual([85.25, 50]);
    expect(buildChartData({ kind: 'bar', x: 'CHANNEL', y: ['AMOUNT'], agg: 'count' }, cols, rows).series[0]!.values).toEqual([2, 1]);
    expect(buildChartData({ kind: 'line', x: 'DAY', y: ['CNT'], agg: 'none' }, cols, rows).labels).toHaveLength(3);
  });
  it('pie folds the tail into "Other"', () => {
    const many = Array.from({ length: 12 }, (_, i) => [`c${i}`, i + 1]);
    const d = buildChartData({ kind: 'pie', x: 'K', y: ['V'] }, [{ name: 'K' }, { name: 'V', typeName: 'int' }], many);
    expect(d.labels).toHaveLength(9);
    expect(d.labels[0]).toBe('c11');
    expect(d.labels[8]).toBe(t('chart.other'));
    expect(d.series[0]!.values.reduce((a, b) => a + b, 0)).toBe(78);
  });
  it('bar/line are capped and flagged', () => {
    const many = Array.from({ length: 60 }, (_, i) => [`c${i}`, 1]);
    const d = buildChartData({ kind: 'bar', x: 'K', y: ['V'] }, [{ name: 'K' }, { name: 'V', typeName: 'int' }], many);
    expect(d.labels).toHaveLength(40);
    expect(d.truncated).toBe(true);
  });
  it('kpi sums each value column', () => {
    expect(buildChartData({ kind: 'kpi', y: ['AMOUNT', 'CNT'] }, cols, rows).series.map((s) => s.values[0])).toEqual([220.5, 6]);
  });
});

describe('helpers', () => {
  it('specFits detects a changed query', () => {
    expect(specFits({ kind: 'bar', x: 'CHANNEL', y: ['AMOUNT'] }, cols)).toBe(true);
    expect(specFits({ kind: 'bar', x: 'GONE', y: ['AMOUNT'] }, cols)).toBe(false);
  });
  it('formatNumber and niceAxis', () => {
    expect(formatNumber(1234567)).toBe('1.23M');
    expect(formatNumber(12.345)).toBe('12.35');
    expect(niceAxis(170.5)).toEqual({ max: 200, ticks: [0, 50, 100, 150, 200] });
    expect(niceAxis(0).max).toBe(1);
  });
});
