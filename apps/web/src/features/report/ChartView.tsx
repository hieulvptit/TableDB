import { useMemo } from 'react';
import { buildChartData, formatNumber, niceAxis, type ChartColumn, type ChartSpec } from './chart';
import { t } from '../../i18n';

// Categorical palette readable on both the light and the dark theme.
const COLORS = ['#0284c7', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6', '#ec4899', '#64748b', '#84cc16'];
const W = 640, H = 300, PAD = { l: 52, r: 16, t: 16, b: 52 };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** SVG chart (bar / line / pie / KPI) of a result set. Plain SVG text only — values never become markup. */
export function ChartView({ spec, columns, rows, compact }: { spec: ChartSpec; columns: ChartColumn[]; rows: unknown[][]; compact?: boolean }) {
  const data = useMemo(() => buildChartData(spec, columns, rows), [spec, columns, rows]);
  if (data.series.length === 0 || data.labels.length === 0) return <div className="ui-muted" style={{ padding: 12 }}>—</div>;
  const legend = data.series.length > 1 || spec.kind === 'pie';
  const label = spec.title ?? '';

  if (spec.kind === 'kpi') {
    return (
      <div className="rpt-kpis" role="img" aria-label={label || 'KPI'}>
        {data.series.map((s, i) => (
          <div key={s.name} className="rpt-kpi" style={{ borderTopColor: COLORS[i % COLORS.length] }}>
            <div className="rpt-kpi__value">{formatNumber(s.values[0] ?? 0)}</div>
            <div className="rpt-kpi__name">{s.name}</div>
          </div>
        ))}
      </div>
    );
  }

  if (spec.kind === 'pie') {
    const vals = data.series[0]!.values;
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = 110, cy = 110, r = 96;
    let a0 = -Math.PI / 2;
    const slices = vals.map((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
      const d = v / total >= 0.9999 ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy}` : `M ${cx} ${cy} L ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)} Z`;
      a0 = a1;
      return { d, v, i };
    });
    return (
      <figure className="rpt-chart rpt-pie" aria-label={label || spec.y[0]}>
        <svg viewBox="0 0 220 220" width={compact ? 150 : 220} height={compact ? 150 : 220} role="img" aria-label={label || spec.y[0]}>
          {slices.map((s) => <path key={s.i} d={s.d} fill={COLORS[s.i % COLORS.length]} stroke="var(--ui-surface)" strokeWidth="1.5"><title>{`${data.labels[s.i]}: ${formatNumber(s.v)} (${Math.round((s.v / total) * 100)}%)`}</title></path>)}
        </svg>
        <ul className="rpt-legend">
          {data.labels.map((l, i) => <li key={i}><i style={{ background: COLORS[i % COLORS.length] }} />{clip(l, 24)} <b>{Math.round((vals[i]! / total) * 100)}%</b></li>)}
        </ul>
      </figure>
    );
  }

  const n = data.labels.length;
  const all = data.series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const axis = niceAxis(Math.max(...all, 0));
  const span = axis.max - lo || 1;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - ((v - lo) / span) * ih;
  const band = iw / n;
  const x = (i: number) => PAD.l + band * (i + 0.5);
  const every = Math.ceil(n / 12);
  const k = data.series.length;
  const bw = Math.max(2, Math.min(40, (band * 0.8) / k));
  return (
    <figure className="rpt-chart" aria-label={label || spec.y.join(', ')}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label || spec.y.join(', ')} style={{ maxHeight: compact ? 220 : 420 }}>
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--ui-border)" />
            <text x={PAD.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill="var(--ui-text-muted)">{formatNumber(t)}</text>
          </g>
        ))}
        {data.labels.map((l, i) => i % every === 0 && (
          <text key={i} x={x(i)} y={H - PAD.b + 14} fontSize="11" fill="var(--ui-text-muted)" textAnchor={n > 6 ? 'end' : 'middle'} transform={n > 6 ? `rotate(-35 ${x(i)} ${H - PAD.b + 14})` : undefined}>{clip(l, 14)}</text>
        ))}
        {spec.kind === 'bar' && data.series.map((s, si) => s.values.map((v, i) => (
          <rect key={`${si}-${i}`} x={x(i) - (bw * k) / 2 + si * bw} y={Math.min(y(v), y(0))} width={bw - 1} height={Math.abs(y(v) - y(0))} fill={COLORS[si % COLORS.length]} rx="2">
            <title>{`${data.labels[i]} · ${s.name}: ${formatNumber(v)}`}</title>
          </rect>
        )))}
        {spec.kind === 'line' && data.series.map((s, si) => (
          <g key={si}>
            <polyline fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth="2" strokeLinejoin="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={COLORS[si % COLORS.length]}><title>{`${data.labels[i]} · ${s.name}: ${formatNumber(v)}`}</title></circle>)}
          </g>
        ))}
      </svg>
      {legend && <ul className="rpt-legend">{data.series.map((s, i) => <li key={s.name}><i style={{ background: COLORS[i % COLORS.length] }} />{s.name}</li>)}</ul>}
      {data.truncated && <div className="ui-muted" style={{ fontSize: 'var(--ui-fs-sm)' }}>{t('chart.truncated', { n })}</div>}
    </figure>
  );
}
