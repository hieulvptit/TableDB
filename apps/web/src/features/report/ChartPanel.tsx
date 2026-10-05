import { useMemo } from 'react';
import { Button, Select } from '@vnpay/ui';
import { t } from '../../i18n';
import { ChartView } from './ChartView';
import { isNumericColumn, suggestSpec, type ChartAgg, type ChartColumn, type ChartKind, type ChartSpec } from './chart';

const KINDS: ChartKind[] = ['bar', 'line', 'pie', 'kpi'];
const AGGS: ChartAgg[] = ['sum', 'avg', 'count', 'none'];

/** Chart tab of a result: controls (kind / x / value / aggregation) + the chart + pin to dashboard. */
export function ChartPanel({ columns, rows, spec, onSpec, onPin, pinDisabled }: {
  columns: ChartColumn[]; rows: unknown[][]; spec?: ChartSpec; onSpec: (s: ChartSpec) => void; onPin?: () => void; pinDisabled?: boolean;
}) {
  const suggested = useMemo(() => suggestSpec(columns, rows), [columns, rows]);
  const cur = spec ?? suggested;
  const nums = useMemo(() => columns.filter((c, i) => isNumericColumn(c, i, rows)).map((c) => c.name), [columns, rows]);
  if (!cur) return <div className="ui-muted" style={{ padding: 16 }}>{t('chart.none')}</div>;
  const set = (p: Partial<ChartSpec>) => onSpec({ ...cur, ...p });
  const colOpts = columns.map((c) => ({ value: c.name, label: c.name }));
  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div className="rpt-bar">
        <Select label={t('chart.kind')} value={cur.kind} onChange={(e) => { const kind = e.target.value as ChartKind; set({ kind, ...(kind !== 'kpi' && !cur.x ? { x: columns.find((c) => !nums.includes(c.name))?.name ?? columns[0]?.name } : {}) }); }}
          options={KINDS.map((k) => ({ value: k, label: t(`chart.kind.${k}`) }))} />
        {cur.kind !== 'kpi' && <Select label={t('chart.x')} value={cur.x ?? ''} onChange={(e) => set({ x: e.target.value })} options={colOpts} />}
        <Select label={t('chart.y')} value={cur.y[0] ?? ''} onChange={(e) => set({ y: [e.target.value, ...cur.y.slice(1).filter((n) => n !== e.target.value)] })}
          options={(nums.length ? nums : columns.map((c) => c.name)).map((n) => ({ value: n, label: n }))} />
        <Select label={t('chart.agg')} value={cur.agg ?? 'sum'} onChange={(e) => set({ agg: e.target.value as ChartAgg })} options={AGGS.map((a) => ({ value: a, label: t(`chart.agg.${a}`) }))} />
        <span style={{ flex: 1 }} />
        {suggested && <Button size="sm" onClick={() => onSpec(suggested)}>{t('chart.auto')}</Button>}
        {onPin && <Button size="sm" variant="primary" disabled={pinDisabled} onClick={onPin}>{t('chart.pin')}</Button>}
      </div>
      <ChartView spec={cur} columns={columns} rows={rows} />
    </div>
  );
}
