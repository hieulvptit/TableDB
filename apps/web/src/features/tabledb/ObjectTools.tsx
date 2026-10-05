import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Checkbox, Dialog, Spinner, useToast } from '@vnpay/ui';
import type { ColumnsResult } from '../../gateway/types';
import { t } from '../../i18n';
import { downloadText } from './csv';
import { friendlyDbError } from './dbErrors';
import { objectSource, type DbObject } from './objects';
import { tableKey, type TableRef } from './schemaStore';
import { useTableDb } from './store';
import type { Connection } from './types';

// ------------------------------------------------------------------ source viewer

export function SourceDialog({ conn, schema, obj, onClose }: { conn: Connection; schema: string; obj: DbObject; onClose: () => void }) {
  const db = useTableDb();
  const toast = useToast();
  const [state, setState] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    objectSource(conn, schema, obj)
      .then((text) => alive && setState({ loading: false, text }))
      .catch((e) => { if (alive) { const f = friendlyDbError(e); setState({ loading: false, error: f.code === 'E_INTERNAL' || !f.detail ? (e as Error).message || f.title : f.detail }); } });
    return () => { alive = false; };
  }, [conn, schema, obj, nonce]);
  return (
    <Dialog open wide title={<span className="ui-mono">{schema}.{obj.name} <span className="ui-muted">· {t(`obj.kind.${obj.kind}`)}</span></span>} onClose={onClose}
      footer={<>
        <Button onClick={() => setNonce((n) => n + 1)}>{t('tree.menu.refresh')}</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>{t('common.close')}</Button>
        <Button disabled={!state.text} onClick={() => void navigator.clipboard?.writeText(state.text ?? '').then(() => toast.push(t('tree.copied'), 'success'), () => {})}>{t('tt.copy')}</Button>
        <Button variant="primary" disabled={!state.text} onClick={() => { db.newTab(state.text ?? '', { title: obj.name.replace(/\(.*$/, '') }); onClose(); }}>{t('tt.openInEditor')}</Button>
      </>}>
      {state.loading && <Spinner label={t('common.loading')} />}
      {state.error && <div className="ui-error-text" role="alert">{t('obj.sourceFailed')} {state.error}</div>}
      {state.text && <pre className="ui-mono" style={{ whiteSpace: 'pre', margin: 0, fontSize: 12, maxHeight: '60vh', overflow: 'auto', background: 'var(--ui-surface-2)', padding: 8, borderRadius: 6 }}>{state.text}</pre>}
      {obj.status && <div className="ui-muted">{t('obj.status')}: {obj.status}{obj.detail ? ` · ${obj.detail}` : ''}</div>}
    </Dialog>
  );
}

// ------------------------------------------------------------------ ER diagram

const MAX_ER_TABLES = 150;
const HEAD = 24, LINE = 18, PAD = 8;
interface ErTable { ref: TableRef; meta: ColumnsResult }
interface Box { x: number; y: number; w: number; h: number }

function boxSize(t: ErTable, keysOnly: boolean) {
  const cols = visibleCols(t, keysOnly);
  const longest = Math.max(t.ref.name.length + 2, ...cols.map((c) => c.name.length + (c.typeName?.length ?? 0) + 3));
  return { w: Math.min(320, Math.max(150, longest * 6.6 + 30)), h: HEAD + Math.max(1, Math.min(cols.length, 18)) * LINE + (cols.length > 18 ? LINE : 0) + PAD };
}
function visibleCols(t: ErTable, keysOnly: boolean) {
  const fk = new Set(t.meta.foreignKeys.flatMap((f) => f.columns));
  return keysOnly ? t.meta.columns.filter((c) => t.meta.primaryKey.includes(c.name) || fk.has(c.name)) : t.meta.columns;
}

/** Grid layout in connectivity order (most connected first, neighbours next to each other). */
function layout(tables: ErTable[], keysOnly: boolean): Map<string, Box> {
  const key = (r: TableRef) => tableKey(r);
  const byName = new Map(tables.map((x) => [x.ref.name.toUpperCase(), x]));
  const adj = new Map<string, Set<string>>(tables.map((x) => [key(x.ref), new Set<string>()]));
  for (const x of tables) for (const f of x.meta.foreignKeys) {
    const p = byName.get(f.refTable.toUpperCase());
    if (p && p !== x) { adj.get(key(x.ref))!.add(key(p.ref)); adj.get(key(p.ref))!.add(key(x.ref)); }
  }
  const order: ErTable[] = [];
  const seen = new Set<string>();
  const sorted = [...tables].sort((a, b) => adj.get(key(b.ref))!.size - adj.get(key(a.ref))!.size);
  for (const start of sorted) {
    if (seen.has(key(start.ref))) continue;
    const queue = [start];
    seen.add(key(start.ref));
    while (queue.length) {
      const cur = queue.shift()!;
      order.push(cur);
      for (const n of adj.get(key(cur.ref))!) if (!seen.has(n)) { seen.add(n); queue.push(tables.find((x) => key(x.ref) === n)!); }
    }
  }
  const perRow = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.6)));
  const out = new Map<string, Box>();
  const colW: number[] = [];
  const sizes = order.map((x) => boxSize(x, keysOnly));
  sizes.forEach((s, i) => { const c = i % perRow; colW[c] = Math.max(colW[c] ?? 0, s.w); });
  let y = 20;
  for (let r = 0; r * perRow < order.length; r++) {
    let x = 20, rowH = 0;
    for (let c = 0; c < perRow && r * perRow + c < order.length; c++) {
      const i = r * perRow + c;
      out.set(key(order[i]!.ref), { x, y, ...sizes[i]! });
      x += colW[c]! + 70;
      rowH = Math.max(rowH, sizes[i]!.h);
    }
    y += rowH + 60;
  }
  return out;
}

export function ErDialog({ conn, catalog, schema, focus, onClose }: { conn: Connection; catalog?: string; schema: string; focus?: TableRef; onClose: () => void }) {
  const db = useTableDb();
  const toast = useToast();
  const [tables, setTables] = useState<ErTable[] | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [keysOnly, setKeysOnly] = useState(false);
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [capped, setCapped] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: 'pan' | 'box'; key?: string; x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = (await conn.store.loadTables(catalog, schema)) ?? conn.store.tables(catalog, schema)?.value ?? [];
        let names = list.filter((x) => !/view/i.test(x.type)).map((x) => x.name);
        if (names.length > MAX_ER_TABLES) { setCapped(true); if (focus) names = [focus.name, ...names.filter((n) => n !== focus.name)]; names = names.slice(0, MAX_ER_TABLES); }
        setProgress({ done: 0, total: names.length });
        const out: ErTable[] = [];
        let done = 0;
        const queue = [...names];
        const worker = async () => {
          while (queue.length && alive) {
            const name = queue.shift()!;
            const ref: TableRef = { catalog, schema, name };
            const meta = await conn.store.loadColumns(ref);
            if (meta) out.push({ ref, meta });
            done++;
            if (alive) setProgress({ done, total: names.length });
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        if (!alive) return;
        let shown = out.sort((a, b) => a.ref.name.localeCompare(b.ref.name));
        if (focus) {
          // the table, the tables it references and the tables referencing it
          const f = focus.name.toUpperCase();
          const me = shown.find((x) => x.ref.name.toUpperCase() === f);
          const refs = new Set((me?.meta.foreignKeys ?? []).map((k) => k.refTable.toUpperCase()));
          shown = shown.filter((x) => x.ref.name.toUpperCase() === f || refs.has(x.ref.name.toUpperCase()) || x.meta.foreignKeys.some((k) => k.refTable.toUpperCase() === f));
        }
        setTables(shown);
      } catch (e) { if (alive) setError(friendlyDbError(e).detail || (e as Error).message); }
    })();
    return () => { alive = false; };
  }, [conn, catalog, schema, focus]);

  useEffect(() => { if (tables) setBoxes(layout(tables, keysOnly)); }, [tables, keysOnly]);

  const edges = useMemo(() => {
    if (!tables) return [];
    const byName = new Map(tables.map((x) => [x.ref.name.toUpperCase(), x]));
    const out: Array<{ from: string; to: string; fromCol: number; toCol: number; label: string }> = [];
    for (const x of tables) {
      const cols = visibleCols(x, keysOnly);
      for (const f of x.meta.foreignKeys) {
        const p = byName.get(f.refTable.toUpperCase());
        if (!p) continue;
        const pcols = visibleCols(p, keysOnly);
        out.push({ from: tableKey(x.ref), to: tableKey(p.ref), fromCol: Math.max(0, cols.findIndex((c) => c.name === f.columns[0])), toCol: Math.max(0, pcols.findIndex((c) => c.name === f.refColumns[0])), label: f.name ?? f.columns.join(',') });
      }
    }
    return out;
  }, [tables, keysOnly]);

  const toSvg = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };
  const onDown = (e: ReactPointerEvent, key?: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (key) { const b = boxes.get(key)!; const p = toSvg(e); drag.current = { kind: 'box', key, x: p.x, y: p.y, ox: b.x, oy: b.y }; }
    else drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
    else { const p = toSvg(e); setBoxes((m) => { const n = new Map(m); const b = n.get(d.key!)!; n.set(d.key!, { ...b, x: d.ox + p.x - d.x, y: d.oy + p.y - d.y }); return n; }); }
  };
  const zoom = (f: number) => setView((v) => ({ ...v, k: Math.min(3, Math.max(0.2, v.k * f)) }));

  const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const color = (v: string, fb: string) => css?.getPropertyValue(v).trim() || fb;
  const C = { box: color('--ui-surface', '#fff'), head: color('--ui-surface-2', '#eef1f5'), border: color('--ui-border', '#c9ced6'), text: color('--ui-text', '#1f2328'), muted: color('--ui-text-muted', '#6b7280'), link: color('--ui-primary', '#2563eb'), pk: color('--ui-warning', '#b7791f') };
  const W = Math.max(800, ...[...boxes.values()].map((b) => b.x + b.w + 40)), H = Math.max(500, ...[...boxes.values()].map((b) => b.y + b.h + 40));

  const exportSvg = () => {
    const el = svgRef.current;
    if (!el) return;
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(W)); clone.setAttribute('height', String(H)); clone.setAttribute('viewBox', `0 0 ${W} ${H}`);
    clone.querySelector('g')?.setAttribute('transform', '');
    downloadText(`${schema}_er.svg`, new XMLSerializer().serializeToString(clone), 'image/svg+xml');
    toast.push(t('er.exported'), 'success');
  };

  return (
    <Dialog open wide title={`${t('er.title')}: ${catalog ? `${catalog}.` : ''}${schema}${focus ? ` · ${focus.name}` : ''}`} onClose={onClose}
      footer={<>
        <Checkbox label={t('er.keysOnly')} checked={keysOnly} onChange={(e) => setKeysOnly(e.target.checked)} />
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => zoom(1 / 1.2)} aria-label={t('er.zoomOut')}>−</Button>
        <Button size="sm" title={t('er.zoomReset')} onClick={() => setView({ x: 0, y: 0, k: 1 })}>{Math.round(view.k * 100)}%</Button>
        <Button size="sm" onClick={() => zoom(1.2)} aria-label={t('er.zoomIn')}>＋</Button>
        <Button disabled={!tables?.length} onClick={exportSvg}>{t('er.export')}</Button>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </>}>
      {error && <div className="ui-error-text" role="alert">{error}</div>}
      {!tables && !error && <div className="ui-row"><Spinner label="" /> {t('er.loading', { a: progress.done, b: progress.total })}</div>}
      {capped && <div className="ui-muted">{t('er.capped', { n: MAX_ER_TABLES })}</div>}
      {tables && tables.length === 0 && <div className="ui-muted">{t('er.empty')}</div>}
      {tables && tables.length > 0 && (
        <div className="er-canvas">
          <svg ref={svgRef} width="100%" height="100%" role="img" aria-label={t('er.title')} onPointerDown={(e) => onDown(e)} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }}
            onWheel={(e) => zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)} style={{ background: C.head, touchAction: 'none', cursor: 'grab' }}>
            <defs><marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill={C.link} /></marker></defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {edges.map((e, i) => {
                const a = boxes.get(e.from), b = boxes.get(e.to);
                if (!a || !b) return null;
                const ay = a.y + HEAD + Math.min(e.fromCol, 17) * LINE + LINE / 2, by = b.y + HEAD + Math.min(e.toCol, 17) * LINE + LINE / 2;
                let d: string;
                if (a === b) d = `M${a.x + a.w} ${ay} C${a.x + a.w + 50} ${ay} ${a.x + a.w + 50} ${by} ${a.x + a.w} ${by}`;
                else {
                  const right = a.x + a.w / 2 < b.x + b.w / 2;
                  const ax = right ? a.x + a.w : a.x, bx = right ? b.x : b.x + b.w;
                  const dx = Math.max(40, Math.abs(bx - ax) / 2) * (right ? 1 : -1);
                  d = `M${ax} ${ay} C${ax + dx} ${ay} ${bx - dx} ${by} ${bx} ${by}`;
                }
                return <path key={i} d={d} fill="none" stroke={C.link} strokeWidth={1.4} markerEnd="url(#er-arrow)"><title>{e.label}</title></path>;
              })}
              {tables.map((x) => {
                const k = tableKey(x.ref);
                const b = boxes.get(k);
                if (!b) return null;
                const cols = visibleCols(x, keysOnly);
                const fk = new Set(x.meta.foreignKeys.flatMap((f) => f.columns));
                return (
                  <g key={k} transform={`translate(${b.x} ${b.y})`} onPointerDown={(e) => onDown(e, k)} onDoubleClick={() => { db.openTable(x.ref); onClose(); }} style={{ cursor: 'move' }}>
                    <rect width={b.w} height={b.h} rx={6} fill={C.box} stroke={focus && x.ref.name === focus.name ? C.link : C.border} strokeWidth={focus && x.ref.name === focus.name ? 2 : 1} />
                    <rect width={b.w} height={HEAD} rx={6} fill={C.head} stroke={C.border} />
                    <text x={8} y={16} fontWeight={700} fontSize={12} fill={C.text}>{x.ref.name}</text>
                    {cols.slice(0, 18).map((c, i) => (
                      <text key={c.name} x={8} y={HEAD + i * LINE + 13} fontSize={11} fill={C.text}>
                        <tspan fill={x.meta.primaryKey.includes(c.name) ? C.pk : fk.has(c.name) ? C.link : C.muted} fontWeight={700}>{x.meta.primaryKey.includes(c.name) ? 'PK ' : fk.has(c.name) ? 'FK ' : '   '}</tspan>
                        {c.name}<tspan fill={C.muted}> {c.typeName}</tspan>
                      </text>
                    ))}
                    {cols.length > 18 && <text x={8} y={HEAD + 18 * LINE + 13} fontSize={11} fill={C.muted}>+{cols.length - 18}…</text>}
                    <title>{t('er.boxHint')}</title>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      )}
      {tables && tables.length > 0 && <div className="ui-muted" style={{ fontSize: 12 }}>{t('er.help', { n: tables.length, e: edges.length })}</div>}
    </Dialog>
  );
}
