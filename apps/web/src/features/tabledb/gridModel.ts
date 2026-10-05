import { formatCell } from '@vnpay/ui';
import type { DriverType } from '@vnpay/shared';
import { csvCell } from './csv';
import { quoteIdent, sqlLiteral } from './tableSql';

export const NUMERIC_TYPE = /int|num|dec|float|double|real|serial|money|number/i;

export interface SortSpec { col: number; desc: boolean }
/** Rectangular cell selection in display coordinates (rows of the filtered/sorted view). */
export interface CellRange { r1: number; c1: number; r2: number; c2: number }
export const normRange = (r: CellRange): CellRange => ({ r1: Math.min(r.r1, r.r2), r2: Math.max(r.r1, r.r2), c1: Math.min(r.c1, r.c2), c2: Math.max(r.c1, r.c2) });

const cmpVal = (a: unknown, b: unknown, numeric: boolean): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // NULLs last
  if (b === null || b === undefined) return -1;
  if (numeric || (typeof a === 'number' && typeof b === 'number')) {
    const x = Number(a), y = Number(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  return formatCell(a).text.localeCompare(formatCell(b).text, 'vi', { numeric: true });
};

/** Display order: row indices that pass the column filters, sorted (stable). */
export function viewOrder(rows: unknown[][], numericCols: boolean[], filters: Record<number, string>, sort: SortSpec | null): number[] {
  const active = Object.entries(filters).filter(([, v]) => v.trim() !== '').map(([k, v]) => [Number(k), v.trim().toLowerCase()] as const);
  let idx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (active.every(([c, q]) => matches(r[c], q))) idx.push(i);
  }
  if (sort) {
    const s = sort;
    idx = idx.map((i, k) => [i, k] as const).sort((a, b) => { const d = cmpVal(rows[a[0]]![s.col], rows[b[0]]![s.col], numericCols[s.col] ?? false); return (s.desc ? -d : d) || a[1] - b[1]; }).map((x) => x[0]);
  }
  return idx;
}

/** Column quick filter: substring (case-insensitive); `NULL` / `!NULL`; `>n` `<n` `>=n` `<=n` `=x` `!x` */
export function matches(v: unknown, q: string): boolean {
  const isNull = v === null || v === undefined;
  if (q === 'null') return isNull;
  if (q === '!null') return !isNull;
  const text = isNull ? '' : formatCell(v).text.toLowerCase();
  const m = /^(>=|<=|>|<|=|!)\s*(.*)$/.exec(q);
  if (m) {
    const [, op, rest] = m;
    if (op === '=') return text === rest;
    if (op === '!') return !text.includes(rest!);
    if (isNull) return false;
    const x = Number(text), y = Number(rest);
    const both = !Number.isNaN(x) && !Number.isNaN(y) && rest !== '';
    const d = both ? x - y : text.localeCompare(rest!, 'vi', { numeric: true });
    return op === '>' ? d > 0 : op === '<' ? d < 0 : op === '>=' ? d >= 0 : d <= 0;
  }
  return text.includes(q);
}

export interface Aggregates { cells: number; nonNull: number; numeric: number; sum?: number; avg?: number; min?: number; max?: number; distinct: number }
/** Statistics of a selection (numbers: also sum/avg/min/max). Bounded to 200 000 cells. */
export function aggregate(values: unknown[]): Aggregates {
  let nonNull = 0, numeric = 0, sum = 0, min = Infinity, max = -Infinity;
  const seen = new Set<string>();
  for (const v of values.slice(0, 200_000)) {
    if (v === null || v === undefined) continue;
    nonNull++;
    const text = formatCell(v).text;
    if (seen.size < 100_000) seen.add(text);
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isNaN(n)) { numeric++; sum += n; if (n < min) min = n; if (n > max) max = n; }
  }
  return { cells: values.length, nonNull, numeric, distinct: seen.size, ...(numeric > 0 ? { sum, avg: sum / numeric, min, max } : {}) };
}

const plain = (v: unknown) => (v === null || v === undefined ? '' : formatCell(v).text);
const tsvCell = (v: unknown) => { const s = plain(v); return /[\t\r\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export type ExportKind = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown' | 'html' | 'xlsx';
export const EXPORT_META: Record<ExportKind, { ext: string; mime: string; label: string }> = {
  csv: { ext: 'csv', mime: 'text/csv;charset=utf-8', label: 'CSV (UTF-8, Excel)' },
  tsv: { ext: 'tsv', mime: 'text/tab-separated-values;charset=utf-8', label: 'TSV' },
  json: { ext: 'json', mime: 'application/json;charset=utf-8', label: 'JSON' },
  sql: { ext: 'sql', mime: 'text/plain;charset=utf-8', label: 'SQL (INSERT)' },
  markdown: { ext: 'md', mime: 'text/markdown;charset=utf-8', label: 'Markdown' },
  html: { ext: 'html', mime: 'text/html;charset=utf-8', label: 'HTML' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel (.xlsx)' },
};

const htmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdCell = (v: unknown) => plain(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

/** Text formats (xlsx is binary: see toXlsx). `table` is the qualified INSERT target. */
export function exportText(kind: Exclude<ExportKind, 'xlsx'>, columns: Array<{ name: string; typeName?: string }>, rows: unknown[][], opts: { header?: boolean; delimiter?: string; table?: string; driver?: DriverType } = {}): string {
  const names = columns.map((c) => c.name);
  const header = opts.header !== false;
  switch (kind) {
    case 'csv': {
      const d = opts.delimiter ?? ',';
      const cell = (v: unknown) => { const s = csvCell(v); return d !== ',' && s.includes(d) && !s.startsWith('"') ? `"${s}"` : s; };
      return [...(header ? [names.map(cell).join(d)] : []), ...rows.map((r) => names.map((_, i) => cell(r[i])).join(d))].join('\r\n');
    }
    case 'tsv': return [...(header ? [names.map(tsvCell).join('\t')] : []), ...rows.map((r) => names.map((_, i) => tsvCell(r[i])).join('\t'))].join('\n');
    case 'json': return JSON.stringify(rows.map((r) => Object.fromEntries(names.map((c, i) => [c, r[i] ?? null]))), null, 2);
    case 'markdown': return [`| ${names.map(mdCell).join(' | ')} |`, `| ${names.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${names.map((_, i) => mdCell(r[i])).join(' | ')} |`)].join('\n');
    case 'html': return `<!doctype html><meta charset="utf-8"><table border="1" cellspacing="0" cellpadding="4">\n<thead><tr>${names.map((n) => `<th>${htmlEsc(n)}</th>`).join('')}</tr></thead>\n<tbody>\n${rows.map((r) => `<tr>${names.map((_, i) => `<td>${r[i] === null || r[i] === undefined ? '' : htmlEsc(plain(r[i]))}</td>`).join('')}</tr>`).join('\n')}\n</tbody></table>\n`;
    case 'sql': {
      const d = opts.driver ?? 'postgresql';
      const target = opts.table || 'TABLE_NAME';
      const cols = names.map((n) => quoteIdent(n, d)).join(', ');
      return rows.map((r) => `INSERT INTO ${target} (${cols}) VALUES (${columns.map((c, i) => sqlLiteral(r[i], c.typeName ?? '', d)).join(', ')});`).join('\n');
    }
  }
}

/** Copy of a cell range as TSV (optionally with the header line). */
export function rangeTsv(columns: string[], rows: unknown[][], withHeader: boolean): string {
  return [...(withHeader ? [columns.map(tsvCell).join('\t')] : []), ...rows.map((r) => r.map(tsvCell).join('\t'))].join('\n');
}

/** `'a', 'b', NULL` — values of one column for an IN (…) list. */
export function inList(values: unknown[], typeName: string, driver: DriverType): string {
  const uniq: unknown[] = [];
  const seen = new Set<string>();
  for (const v of values) { const k = JSON.stringify(v ?? null); if (!seen.has(k)) { seen.add(k); uniq.push(v); } }
  return uniq.map((v) => sqlLiteral(v, typeName, driver)).join(', ');
}

/** Hex dump lines of bytes (offset · hex · ascii). */
export function hexDump(bytes: Uint8Array, max = 4096): string {
  const out: string[] = [];
  for (let o = 0; o < Math.min(bytes.length, max); o += 16) {
    const chunk = Array.from(bytes.subarray(o, Math.min(o + 16, bytes.length)));
    out.push(`${o.toString(16).padStart(8, '0')}  ${chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`);
  }
  return out.join('\n');
}

export const b64ToBytes = (b64: string) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
export const isBinary = (v: unknown): v is { $binary: string; length: number } => !!v && typeof v === 'object' && typeof (v as { $binary?: unknown }).$binary === 'string';
