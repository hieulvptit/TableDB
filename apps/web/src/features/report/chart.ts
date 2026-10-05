import { t } from '../../i18n';
// Pure chart logic for result sets: spec validation, auto-suggestion and aggregation. No DOM, no network.
// A spec only names columns of a result the user already has; it never carries row data.
export type ChartKind = 'bar' | 'line' | 'pie' | 'kpi';
export type ChartAgg = 'sum' | 'avg' | 'count' | 'none';
export interface ChartSpec { kind: ChartKind; /** category / x column (unused by kpi) */ x?: string; /** value columns */ y: string[]; agg?: ChartAgg; title?: string }
export interface ChartColumn { name: string; typeName?: string }
export interface ChartData { labels: string[]; series: Array<{ name: string; values: number[] }>; truncated: boolean }

export const MAX_POINTS = 40;
export const MAX_PIE = 8;
const KINDS: ChartKind[] = ['bar', 'line', 'pie', 'kpi'];
const AGGS: ChartAgg[] = ['sum', 'avg', 'count', 'none'];
const NUM_TYPE = /^(?:tiny|small|big|med)?int(?:eger)?\d*$|^number|^numeric|^decimal|^float|^double|^real|^dec$|^serial|^money/i;

/** Number from a cell value (JS number, bigint or numeric string); anything else is null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A column is numeric when its driver type says so, or (unknown type) when every non-null sampled value parses as a number. */
export function isNumericColumn(col: ChartColumn, idx: number, rows: unknown[][]): boolean {
  if (col.typeName && NUM_TYPE.test(col.typeName.trim())) return true;
  if (col.typeName && /char|text|date|time|bool|uuid|json|clob/i.test(col.typeName)) return false;
  let seen = 0;
  for (const r of rows.slice(0, 200)) {
    const v = r[idx];
    if (v === null || v === undefined || v === '') continue;
    if (toNumber(v) === null) return false;
    seen++;
  }
  return seen > 0;
}

export const cellLabel = (v: unknown): string => (v === null || v === undefined ? '(null)' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Best-effort default chart for a result set, or null when nothing numeric can be drawn. */
export function suggestSpec(columns: ChartColumn[], rows: unknown[][]): ChartSpec | null {
  if (columns.length === 0 || rows.length === 0) return null;
  const num = columns.map((c, i) => isNumericColumn(c, i, rows));
  const nums = columns.filter((_, i) => num[i]).map((c) => c.name);
  if (nums.length === 0) return null;
  if (rows.length === 1) return { kind: 'kpi', y: nums.slice(0, 4) };
  const xi = columns.findIndex((_, i) => !num[i]);
  const x = xi >= 0 ? columns[xi]!.name : columns[0]!.name;
  const y = nums.filter((n) => n !== x).slice(0, 3);
  if (y.length === 0) return null;
  const sample = columns[xi >= 0 ? xi : 0]!;
  const temporal = /date|time/i.test(sample.typeName ?? '');
  return { kind: temporal ? 'line' : 'bar', x, y: temporal ? y : y.slice(0, 1), agg: 'sum' };
}

/** Whitelist-parse a spec (e.g. proposed by the Agent) against the real columns. Unknown columns make it invalid. */
export function parseChartSpec(raw: unknown, columns: ChartColumn[]): ChartSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const names = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]));
  const col = (v: unknown) => (typeof v === 'string' ? names.get(v.trim().toLowerCase()) : undefined);
  if (typeof o.kind !== 'string' || !KINDS.includes(o.kind as ChartKind)) return null;
  const kind = o.kind as ChartKind;
  const yRaw = Array.isArray(o.y) ? o.y : o.y !== undefined ? [o.y] : [];
  const y = yRaw.map(col).filter((v): v is string => !!v).slice(0, 6);
  if (yRaw.length === 0 || y.length !== yRaw.length) return null;
  const x = col(o.x);
  if (kind !== 'kpi' && !x) return null;
  const agg = typeof o.agg === 'string' && AGGS.includes(o.agg as ChartAgg) ? (o.agg as ChartAgg) : 'sum';
  const title = typeof o.title === 'string' ? o.title.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 100) : '';
  return { kind, ...(x && kind !== 'kpi' ? { x } : {}), y, agg, ...(title ? { title } : {}) };
}

/** Does the spec still fit these columns (a saved widget whose query changed)? */
export const specFits = (spec: ChartSpec, columns: ChartColumn[]) => {
  const have = new Set(columns.map((c) => c.name));
  return spec.y.every((n) => have.has(n)) && (spec.kind === 'kpi' || (!!spec.x && have.has(spec.x)));
};

export function buildChartData(spec: ChartSpec, columns: ChartColumn[], rows: unknown[][]): ChartData {
  const idx = (n: string) => columns.findIndex((c) => c.name === n);
  const yi = spec.y.map(idx).filter((i) => i >= 0);
  const names = yi.map((i) => columns[i]!.name);
  const agg = spec.agg ?? 'sum';
  if (spec.kind === 'kpi') {
    // one number per value column over all rows (the single row of a typical KPI query)
    const series = yi.map((i, k) => {
      const vals = rows.map((r) => toNumber(r[i])).filter((v): v is number => v !== null);
      const total = vals.reduce((a, b) => a + b, 0);
      const v = agg === 'avg' ? (vals.length ? total / vals.length : 0) : agg === 'count' ? vals.length : agg === 'none' ? (vals[0] ?? 0) : total;
      return { name: names[k]!, values: [v] };
    });
    return { labels: [''], series, truncated: false };
  }
  const xi = idx(spec.x ?? '');
  if (xi < 0 || yi.length === 0) return { labels: [], series: [], truncated: false };
  let labels: string[]; let values: number[][];
  if (agg === 'none') {
    labels = rows.map((r) => cellLabel(r[xi]));
    values = yi.map((i) => rows.map((r) => toNumber(r[i]) ?? 0));
  } else {
    const groups = new Map<string, { sum: number[]; n: number[] }>();
    for (const r of rows) {
      const key = cellLabel(r[xi]);
      let g = groups.get(key);
      if (!g) { g = { sum: yi.map(() => 0), n: yi.map(() => 0) }; groups.set(key, g); }
      yi.forEach((i, k) => { const v = toNumber(r[i]); if (v !== null) { g!.sum[k]! += v; g!.n[k]!++; } });
    }
    labels = [...groups.keys()];
    values = yi.map((_, k) => labels.map((l) => { const g = groups.get(l)!; return agg === 'avg' ? (g.n[k]! ? g.sum[k]! / g.n[k]! : 0) : agg === 'count' ? g.n[k]! : g.sum[k]!; }));
  }
  if (spec.kind === 'pie') {
    // largest slices first, the tail folded into "Other" (pie uses the first value column only)
    const v0 = values[0]!.map((v) => Math.max(0, v));
    const order = labels.map((_, i) => i).sort((a, b) => v0[b]! - v0[a]!);
    const head = order.slice(0, MAX_PIE);
    const rest = order.slice(MAX_PIE);
    const l = head.map((i) => labels[i]!); const v = head.map((i) => v0[i]!);
    if (rest.length) { l.push(t('chart.other')); v.push(rest.reduce((s, i) => s + v0[i]!, 0)); }
    return { labels: l, series: [{ name: names[0]!, values: v }], truncated: false };
  }
  const truncated = labels.length > MAX_POINTS;
  return { labels: labels.slice(0, MAX_POINTS), series: values.map((v, k) => ({ name: names[k]!, values: v.slice(0, MAX_POINTS) })), truncated };
}

/** Compact number for axes and tiles: 1 234 567 → 1,23M. */
export function formatNumber(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(2));
}

/** "Nice" axis maximum and ticks for a 0-based value axis. */
export function niceAxis(max: number, ticks = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const top = Math.ceil(max / step) * step;
  const t: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) t.push(+v.toPrecision(12));
  return { max: top, ticks: t };
}
