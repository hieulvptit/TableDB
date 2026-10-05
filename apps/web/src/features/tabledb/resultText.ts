import { formatCell } from '@vnpay/ui';

/** Longest cell (in characters) shown in the Text view; longer values are cut with "…" (DBeaver does the same). */
export const TEXT_CELL_MAX = 60;

const jsonValue = (v: unknown) => (v === undefined ? null : v);

/**
 * JSON view as lines (one array of row objects, pretty-printed), so the view can be virtualized and extended page by
 * page: rows appended later only add lines at the end — except the comma after the previous last row.
 */
export function jsonLines(columns: string[], rows: unknown[][]): string[] {
  const out: string[] = ['['];
  rows.forEach((r, ri) => {
    const obj = Object.fromEntries(columns.map((c, i) => [c, jsonValue(r[i])]));
    const body = JSON.stringify(obj, null, 2).split('\n');
    body.forEach((l, li) => out.push(`  ${l}${li === body.length - 1 && ri < rows.length - 1 ? ',' : ''}`));
  });
  out.push(']');
  return out;
}

const clip = (s: string) => {
  const one = s.replace(/\r?\n|\r|\t/g, ' ');
  return one.length > TEXT_CELL_MAX ? `${one.slice(0, TEXT_CELL_MAX - 1)}…` : one;
};

/** Fixed-width text table (header, separator, one line per row); numbers right-aligned. */
export function textLines(columns: Array<{ name: string; numeric?: boolean }>, rows: unknown[][]): string[] {
  const cells = rows.map((r) => columns.map((_, i) => clip(formatCell(r[i]).text)));
  const widths = columns.map((c) => clip(c.name).length);
  for (const row of cells) row.forEach((v, i) => { if (v.length > widths[i]!) widths[i] = v.length; }); // no spread: up to 100k rows
  const line = (vals: string[], alignNum: boolean) =>
    vals.map((v, i) => (alignNum && columns[i]!.numeric ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join(' | ').replace(/\s+$/, '');
  return [
    line(columns.map((c) => clip(c.name)), false),
    widths.map((w) => '-'.repeat(w)).join('-+-'),
    ...cells.map((row) => line(row, true)),
  ];
}
