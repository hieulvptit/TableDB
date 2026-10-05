import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Dialog, Input, Select, Spinner, formatCell, useToast } from '@vnpay/ui';
import { classifySql, type DriverType } from '@vnpay/shared';
import type { PlanResult } from '../../gateway';
import { t } from '../../i18n';
import { downloadBytes, downloadText } from './csv';
import { friendlyDbError } from './dbErrors';
import { runAudited } from './exec';
import { EXPORT_META, b64ToBytes, exportText, hexDump, isBinary, type ExportKind } from './gridModel';
import { useTableDb } from './store';
import { qualified, quoteIdent, sqlLiteral } from './tableSql';
import type { EditCtx } from './ResultView';
import type { Connection, EditorTabState, OutputState, ScriptLogEntry } from './types';
import { toXlsx } from './xlsx';

// ------------------------------------------------------------------ script log

const STATUS_TONE: Record<ScriptLogEntry['status'], 'success' | 'danger' | 'warning' | 'neutral'> = { ok: 'success', error: 'danger', rejected: 'danger', skipped: 'warning', cancelled: 'neutral' };

export function ScriptLogView({ log, running }: { log: ScriptLogEntry[]; running: boolean }) {
  const ok = log.filter((e) => e.status === 'ok').length;
  const bad = log.filter((e) => e.status === 'error' || e.status === 'rejected').length;
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 8 }}>
      <div className="ui-row" style={{ marginBottom: 6 }} role="status">
        {running && <Spinner label="" />}
        <strong>{t('script.summary', { ok, n: log.length })}</strong>
        {bad > 0 && <Badge tone="danger">{t('script.failed', { n: bad })}</Badge>}
      </div>
      <table className="ui-table" aria-label={t('script.title')}>
        <thead><tr><th scope="col">#</th><th scope="col">{t('script.status')}</th><th scope="col">{t('sql.kindTitle')}</th><th scope="col">{t('script.rows')}</th><th scope="col">ms</th><th scope="col">{t('script.statement')}</th></tr></thead>
        <tbody>
          {log.map((e) => (
            <tr key={e.index}>
              <td>{e.index}</td>
              <td><Badge tone={STATUS_TONE[e.status]}>{t(`script.st.${e.status}`)}</Badge></td>
              <td>{e.kind ? t(`sql.kind.${e.kind}`) : ''}</td>
              <td className="ui-num">{e.updateCount ?? e.rows ?? ''}</td>
              <td className="ui-num">{e.ms ?? ''}</td>
              <td>
                <div className="ui-mono" style={{ fontSize: 12, maxWidth: 520, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.sql}>{e.sql.replace(/\s+/g, ' ')}</div>
                {e.message && <div className={e.status === 'error' || e.status === 'rejected' ? 'ui-error-text' : 'ui-muted'} style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{e.message}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ plan

interface PlanNode { depth: number; op: string; object: string; cost: string; rows: string; width: string; details: string; weight: number }

function pgNodes(json: string): PlanNode[] {
  const root = (JSON.parse(json) as Array<{ Plan: Record<string, unknown> }>)[0]?.Plan;
  const out: PlanNode[] = [];
  const max = Number(root?.['Total Cost'] ?? 1) || 1;
  const DETAIL = ['Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Filter', 'Sort Key', 'Group Key', 'Presorted Key', 'Cache Key', 'One-Time Filter'];
  const walk = (n: Record<string, unknown>, depth: number) => {
    const obj = [n['Schema'] && n['Relation Name'] ? `${String(n['Schema'])}.${String(n['Relation Name'])}` : n['Relation Name'], n['Alias'] && n['Alias'] !== n['Relation Name'] ? `(${String(n['Alias'])})` : '', n['Index Name'] ? `idx ${String(n['Index Name'])}` : '', n['CTE Name'] ? `CTE ${String(n['CTE Name'])}` : '', n['Function Name']]
      .filter(Boolean).join(' ');
    const op = [n['Node Type'], n['Join Type'] ? `(${String(n['Join Type'])})` : '', n['Strategy'] && n['Node Type'] === 'Aggregate' ? `[${String(n['Strategy'])}]` : '', n['Parallel Aware'] ? '∥' : ''].filter(Boolean).join(' ');
    const details = DETAIL.filter((k) => n[k] !== undefined).map((k) => `${k}: ${Array.isArray(n[k]) ? (n[k] as unknown[]).join(', ') : String(n[k])}`).join('\n');
    const total = Number(n['Total Cost'] ?? 0);
    out.push({ depth, op: String(op), object: String(obj), cost: `${n['Startup Cost'] ?? ''}..${n['Total Cost'] ?? ''}`, rows: String(n['Plan Rows'] ?? ''), width: String(n['Plan Width'] ?? ''), details, weight: total / max });
    for (const c of (n['Plans'] as Array<Record<string, unknown>> | undefined) ?? []) walk(c, depth + 1);
  };
  if (root) walk(root, 0);
  return out;
}

function oracleNodes(plan: Extract<PlanResult, { format: 'table' }>): PlanNode[] {
  const idx = (n: string) => plan.columns.findIndex((c) => c.name.toUpperCase() === n);
  const g = (r: unknown[], n: string) => { const i = idx(n); const v = i >= 0 ? r[i] : null; return v === null || v === undefined ? '' : String(v); };
  const max = Math.max(1, ...plan.rows.map((r) => Number(g(r, 'COST')) || 0));
  return plan.rows.map((r) => ({
    depth: Number(g(r, 'DEPTH')) || 0, op: [g(r, 'OPERATION'), g(r, 'OPTIONS')].filter(Boolean).join(' '),
    object: [g(r, 'OBJECT_OWNER'), g(r, 'OBJECT_NAME')].filter(Boolean).join('.'), cost: g(r, 'COST'), rows: g(r, 'CARDINALITY'), width: g(r, 'BYTES'),
    details: [g(r, 'ACCESS_PREDICATES') && `access: ${g(r, 'ACCESS_PREDICATES')}`, g(r, 'FILTER_PREDICATES') && `filter: ${g(r, 'FILTER_PREDICATES')}`].filter(Boolean).join('\n'),
    weight: (Number(g(r, 'COST')) || 0) / max,
  }));
}

export function PlanView({ plan }: { plan: PlanResult }) {
  const toast = useToast();
  const [raw, setRaw] = useState(false);
  const nodes = useMemo(() => {
    try { return plan.format === 'json' ? pgNodes(plan.plan) : plan.format === 'table' ? oracleNodes(plan) : null; } catch { return null; }
  }, [plan]);
  const rawText = plan.format === 'text' ? plan.text : plan.format === 'json' ? JSON.stringify(JSON.parse(plan.plan), null, 2) : plan.rows.map((r) => r.map((v) => formatCell(v).text).join('\t')).join('\n');
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 8 }} className="ui-col">
      <div className="ui-row">
        <strong>{t('explain.title')}</strong> <span className="ui-muted">{plan.elapsedMs} ms · {t('explain.notExecuted')}</span>
        <span style={{ flex: 1 }} />
        {nodes && <Button size="sm" onClick={() => setRaw((x) => !x)}>{raw ? t('explain.tree') : t('explain.raw')}</Button>}
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(rawText).then(() => toast.push(t('tree.copied'), 'success'), () => {})}>{t('tt.copy')}</Button>
      </div>
      {nodes && !raw ? (
        <table className="ui-table" aria-label={t('explain.title')}>
          <thead><tr><th scope="col">{t('explain.op')}</th><th scope="col">{t('explain.object')}</th><th scope="col">{t('explain.cost')}</th><th scope="col">{t('explain.rows')}</th><th scope="col">{plan.format === 'table' ? 'Bytes' : 'Width'}</th><th scope="col">{t('explain.details')}</th></tr></thead>
          <tbody>{nodes.map((n, i) => (
            <tr key={i}>
              <td style={{ paddingLeft: 8 + n.depth * 16, whiteSpace: 'nowrap' }}>
                <span className="rv-planbar" style={{ width: `${Math.round(n.weight * 100)}%` }} aria-hidden />
                {n.depth > 0 ? '↳ ' : ''}<strong>{n.op}</strong>
              </td>
              <td className="ui-mono">{n.object}</td><td className="ui-num">{n.cost}</td><td className="ui-num">{n.rows}</td><td className="ui-num">{n.width}</td>
              <td className="ui-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{n.details}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <pre className="ui-mono" style={{ margin: 0, whiteSpace: 'pre', fontSize: 12 }}>{rawText}</pre>}
    </div>
  );
}

// ------------------------------------------------------------------ messages / server output

export function MessagesView({ messages, serverOutput }: { messages?: string[]; serverOutput?: string[] }) {
  return (
    <details className="rv-messages" open>
      <summary>{t('result.messages', { n: (messages?.length ?? 0) + (serverOutput?.length ?? 0) })}</summary>
      {serverOutput && serverOutput.length > 0 && <><div className="ui-label">DBMS_OUTPUT</div><pre className="ui-mono">{serverOutput.join('\n')}</pre></>}
      {messages && messages.length > 0 && <pre className="ui-mono">{messages.join('\n')}</pre>}
    </details>
  );
}

// ------------------------------------------------------------------ value viewer

const FULL_LOB = 3 << 20;

export function ValueViewer({ conn, tab, output, column, value, rowIndex, row, columns, edit, pkIdx, onClose }: {
  conn: Connection | null; tab: EditorTabState; output: OutputState; column: { name: string; typeName?: string } | null; value: unknown; rowIndex: number | null;
  row: unknown[] | null; columns: Array<{ name: string; typeName?: string }>; edit?: EditCtx; pkIdx: number[]; onClose: () => void;
}) {
  const toast = useToast();
  const [pretty, setPretty] = useState(true);
  const [busy, setBusy] = useState(false);
  const colIdx = column ? columns.findIndex((c) => c.name === column.name) : -1;
  const text = value === null || value === undefined ? null : typeof value === 'string' ? value : isBinary(value) ? null : JSON.stringify(value);
  const json = useMemo(() => {
    if (text === null || !/^\s*[[{]/.test(text)) return null;
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return null; }
  }, [text]);
  const bin = isBinary(value) ? value : null;
  const preview = bin ? b64ToBytes(bin.$binary) : null;
  const truncatedBin = !!bin && !!preview && preview.length < bin.length;
  const name = `${(tab.table?.name ?? tab.title).replace(/\W+/g, '_')}_${column?.name ?? 'value'}`;

  /** the full value: by primary key on a table view, else by re-running the (read) statement up to this row */
  const fetchFull = async (): Promise<unknown> => {
    if (!conn || colIdx < 0 || rowIndex === null || !row) throw new Error(t('viewer.noSource'));
    const d: DriverType = conn.driver;
    if (edit && pkIdx.length && pkIdx.every((i) => i >= 0)) {
      const where = pkIdx.map((i) => (row[i] === null || row[i] === undefined ? `${quoteIdent(columns[i]!.name, d)} IS NULL` : `${quoteIdent(columns[i]!.name, d)} = ${sqlLiteral(row[i], columns[i]!.typeName ?? '', d)}`)).join(' AND ');
      const g = await runAudited(conn, `SELECT ${quoteIdent(column!.name, d)} FROM ${qualified(edit.table, d)} WHERE ${where}`, 'read', { maxRows: 1, lobLimit: FULL_LOB });
      return g.rows[0]?.[0];
    }
    if (output.sql && !output.params?.length && classifySql(output.sql).kind === 'read' && rowIndex < 1000) {
      const g = await runAudited(conn, output.sql, 'read', { maxRows: rowIndex + 1, all: true, lobLimit: FULL_LOB });
      return g.rows[rowIndex]?.[colIdx];
    }
    throw new Error(t('viewer.noSource'));
  };
  const saveFull = async () => {
    setBusy(true);
    try {
      const v = await fetchFull();
      if (isBinary(v)) {
        const bytes = b64ToBytes(v.$binary);
        downloadBytes(`${name}.bin`, bytes, 'application/octet-stream');
        toast.push(bytes.length < v.length ? t('viewer.savedPartial', { n: bytes.length, m: v.length }) : t('viewer.saved', { n: bytes.length }), bytes.length < v.length ? 'warning' : 'success');
      } else if (typeof v === 'string') { downloadText(`${name}.txt`, v, 'text/plain;charset=utf-8'); toast.push(t('viewer.saved', { n: v.length }), 'success'); }
      else toast.push(t('viewer.isNull'), 'info');
    } catch (e) { const f = friendlyDbError(e); toast.push(f.detail || f.title || (e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <aside className="rv-viewer" aria-label={t('grid.viewer')}>
      <div className="rv-viewer__head">
        <strong className="ui-mono" title={column?.typeName}>{column?.name ?? '—'}</strong>
        <span className="ui-muted">{column?.typeName ?? ''}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ui-tab__close" aria-label={t('common.closeLabel')} onClick={onClose}>×</button>
      </div>
      <div className="rv-viewer__body">
        {!column && <div className="ui-muted">{t('viewer.pick')}</div>}
        {column && value === null && <div className="ui-null">NULL</div>}
        {column && value === undefined && <div className="ui-muted">{t('edit.default')}</div>}
        {bin && preview && (
          <>
            <div>{t('viewer.binary', { n: bin.length })}{truncatedBin ? ` · ${t('viewer.preview', { n: preview.length })}` : ''}</div>
            <pre className="ui-mono rv-viewer__pre">{hexDump(preview)}</pre>
          </>
        )}
        {text !== null && (
          <>
            {json && <Checkbox label={t('viewer.prettyJson')} checked={pretty} onChange={(e) => setPretty(e.target.checked)} />}
            <pre className="ui-mono rv-viewer__pre">{json && pretty ? json : text}</pre>
            <div className="ui-muted" style={{ fontSize: 12 }}>{t('viewer.length', { n: text.length })}</div>
          </>
        )}
      </div>
      {column && value !== null && value !== undefined && (
        <div className="rv-viewer__foot">
          {text !== null && <Button size="sm" onClick={() => void navigator.clipboard?.writeText(json && pretty ? json : text).then(() => toast.push(t('tree.copied'), 'success'), () => {})}>{t('tt.copy')}</Button>}
          {text !== null && <Button size="sm" onClick={() => downloadText(`${name}.${json ? 'json' : 'txt'}`, json && pretty ? json : text, 'text/plain;charset=utf-8')}>{t('viewer.saveFile')}</Button>}
          {bin && <Button size="sm" loading={busy} onClick={() => void saveFull()}>{truncatedBin ? t('viewer.fetchSave') : t('viewer.saveFile')}</Button>}
          {text !== null && text.length >= 1_000_000 && <Button size="sm" loading={busy} onClick={() => void saveFull()}>{t('viewer.fetchSave')}</Button>}
        </div>
      )}
    </aside>
  );
}

// ------------------------------------------------------------------ export

export function ExportResultDialog({ tab, output, columns, visibleRows, selectionRows, selectionColumns, driver, onClose }: {
  tab: EditorTabState; output: OutputState; columns: Array<{ name: string; typeName?: string }>; visibleRows: () => unknown[][];
  selectionRows?: () => unknown[][]; selectionColumns?: Array<{ name: string; typeName?: string }>; driver: DriverType; onClose: () => void;
}) {
  const db = useTableDb();
  const toast = useToast();
  const [kind, setKind] = useState<ExportKind>('csv');
  const [scope, setScope] = useState<'view' | 'all' | 'selection'>(output.result?.hasMore ? 'all' : 'view');
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(',');
  const [table, setTable] = useState(tab.table ? qualified(tab.table, driver) : 'TABLE_NAME');
  const base = (tab.outputs.length > 1 ? `${tab.title}_${output.title}` : tab.title).replace(/[\\/:*?"<>|\s]+/g, '_');
  const [file, setFile] = useState(base);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      let cols = columns, rows: unknown[][];
      if (scope === 'selection' && selectionRows) { rows = selectionRows(); cols = selectionColumns ?? columns; }
      else if (scope === 'all') { const r = (output.result?.hasMore ? await db.loadAll(tab.id, output.id) : undefined) ?? output.result; rows = r?.rows ?? []; }
      else rows = visibleRows();
      const meta = EXPORT_META[kind];
      const name = `${file || 'export'}.${meta.ext}`;
      if (kind === 'xlsx') downloadBytes(name, toXlsx(cols.map((c) => c.name), rows, tab.title), meta.mime);
      else downloadText(name, exportText(kind, cols, rows, { header, delimiter: delimiter === 'tab' ? '\t' : delimiter, table, driver }), meta.mime, kind === 'csv');
      toast.push(t('result.exported', { n: rows.length }), 'success');
      onClose();
    } catch (e) { toast.push((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Dialog open title={t('result.export')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void go()}>{t('tt.export.go')}</Button></>}>
      <div className="ui-col" style={{ gap: 10 }}>
        <Select label={t('tt.export.format')} value={kind} onChange={(e) => setKind(e.target.value as ExportKind)} options={(Object.keys(EXPORT_META) as ExportKind[]).map((k) => ({ value: k, label: EXPORT_META[k].label }))} />
        <Select label={t('export.scope')} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} options={[
          { value: 'view', label: t('export.scope.view') }, { value: 'all', label: t('export.scope.all') },
          ...(selectionRows ? [{ value: 'selection', label: t('export.scope.selection') }] : []),
        ]} />
        {(kind === 'csv' || kind === 'tsv') && <Checkbox label={t('export.header')} checked={header} onChange={(e) => setHeader(e.target.checked)} />}
        {kind === 'csv' && <Select label={t('export.delimiter')} value={delimiter} onChange={(e) => setDelimiter(e.target.value)} options={[{ value: ',', label: t('export.delimComma') }, { value: ';', label: t('export.delimSemicolon') }, { value: 'tab', label: 'Tab' }, { value: '|', label: '|' }]} />}
        {kind === 'sql' && <Input label={t('export.table')} value={table} onChange={(e) => setTable(e.target.value)} />}
        <Input label={t('export.file')} value={file} onChange={(e) => setFile(e.target.value.replace(/[\\/:*?"<>|]/g, '_'))} hint={`.${EXPORT_META[kind].ext}`} />
        {scope === 'all' && output.result?.hasMore && <div className="ui-muted">{t('export.fetchNote', { n: tab.maxRows })}</div>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ compare

interface Side { columns: string[]; rows: unknown[][] }
export interface CompareResult { onlyA: unknown[][]; onlyB: unknown[][]; changed: Array<{ a: unknown[]; b: unknown[]; diff: Set<number> }>; same: number; columns: string[] }

/** Diff of two result sets on their common columns: by key columns, or (no keys) as multisets of whole rows. */
export function compareResults(A: Side, B: Side, keys: string[]): CompareResult {
  const columns = A.columns.filter((c) => B.columns.includes(c));
  const ia = columns.map((c) => A.columns.indexOf(c)), ib = columns.map((c) => B.columns.indexOf(c));
  const proj = (r: unknown[], idx: number[]) => idx.map((i) => r[i] ?? null);
  const pa = A.rows.map((r) => proj(r, ia)), pb = B.rows.map((r) => proj(r, ib));
  const enc = (v: unknown[]) => JSON.stringify(v);
  const res: CompareResult = { onlyA: [], onlyB: [], changed: [], same: 0, columns };
  if (keys.length === 0) {
    const bag = new Map<string, number>();
    for (const r of pb) bag.set(enc(r), (bag.get(enc(r)) ?? 0) + 1);
    for (const r of pa) { const k = enc(r); const n = bag.get(k) ?? 0; if (n > 0) { bag.set(k, n - 1); res.same++; } else res.onlyA.push(r); }
    const leftover = new Map(bag);
    for (const r of pb) { const k = enc(r); const n = leftover.get(k) ?? 0; if (n > 0) { leftover.set(k, n - 1); res.onlyB.push(r); } }
    return res;
  }
  const kIdx = keys.map((k) => columns.indexOf(k)).filter((i) => i >= 0);
  const keyOf = (r: unknown[]) => enc(kIdx.map((i) => r[i]));
  const mb = new Map<string, unknown[][]>();
  for (const r of pb) { const k = keyOf(r); const l = mb.get(k); if (l) l.push(r); else mb.set(k, [r]); }
  for (const r of pa) {
    const l = mb.get(keyOf(r));
    const other = l?.shift();
    if (!other) { res.onlyA.push(r); continue; }
    const diff = new Set<number>();
    columns.forEach((_, i) => { if (enc([r[i]]) !== enc([other[i]])) diff.add(i); });
    if (diff.size) res.changed.push({ a: r, b: other, diff }); else res.same++;
  }
  for (const l of mb.values()) res.onlyB.push(...l);
  return res;
}

export function CompareDialog({ current, onClose }: { current: { tab: EditorTabState; output: OutputState }; onClose: () => void }) {
  const db = useTableDb();
  const candidates = db.tabs.flatMap((tb) => tb.outputs.filter((o) => o.result?.columns.length && o.id !== current.output.id).map((o) => ({ id: `${tb.id}|${o.id}`, label: `${tb.title} › ${o.title}`, o })));
  const [other, setOther] = useState(candidates[0]?.id ?? '');
  const B = candidates.find((c) => c.id === other)?.o;
  const A = current.output;
  const common = A.result && B?.result ? A.result.columns.map((c) => c.name).filter((n) => B.result!.columns.some((x) => x.name === n)) : [];
  const [keys, setKeys] = useState<string[]>([]);
  const [show, setShow] = useState<'changed' | 'onlyA' | 'onlyB'>('changed');
  const res = useMemo(() => (A.result && B?.result ? compareResults({ columns: A.result.columns.map((c) => c.name), rows: A.result.rows }, { columns: B.result.columns.map((c) => c.name), rows: B.result.rows }, keys.filter((k) => common.includes(k))) : null),
    [A.result, B?.result, keys]); // eslint-disable-line react-hooks/exhaustive-deps
  const cell = (v: unknown) => formatCell(v).text;
  return (
    <Dialog open wide title={t('compare.title')} onClose={onClose}>
      <div className="ui-col" style={{ gap: 8 }}>
        {candidates.length === 0 ? <div className="ui-muted">{t('compare.none')}</div> : (
          <>
            <div className="ui-row" style={{ flexWrap: 'wrap' }}>
              <span>A: <strong>{current.tab.title} › {A.title}</strong></span>
              <label className="ui-row" style={{ gap: 4 }}>B:
                <select className="ui-select" aria-label="B" value={other} onChange={(e) => { setOther(e.target.value); setKeys([]); }}>{candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
              </label>
            </div>
            <div className="ui-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <span className="ui-label">{t('compare.keys')}</span>
              {common.map((c) => <Checkbox key={c} label={c} checked={keys.includes(c)} onChange={(e) => setKeys((k) => (e.target.checked ? [...k, c] : k.filter((x) => x !== c)))} />)}
              {common.length === 0 && <span className="ui-error-text">{t('compare.noCommon')}</span>}
            </div>
            {(A.result?.hasMore || B?.result?.hasMore) && <div className="ui-muted">{t('compare.loadedOnly')}</div>}
            {res && (
              <>
                <div className="ui-row" role="status" style={{ flexWrap: 'wrap' }}>
                  <Badge tone="success">{t('compare.same', { n: res.same })}</Badge>
                  <button type="button" className="ui-btn ui-btn--sm" aria-pressed={show === 'changed'} disabled={keys.length === 0} onClick={() => setShow('changed')}>{t('compare.changed', { n: res.changed.length })}</button>
                  <button type="button" className="ui-btn ui-btn--sm" aria-pressed={show === 'onlyA'} onClick={() => setShow('onlyA')}>{t('compare.onlyA', { n: res.onlyA.length })}</button>
                  <button type="button" className="ui-btn ui-btn--sm" aria-pressed={show === 'onlyB'} onClick={() => setShow('onlyB')}>{t('compare.onlyB', { n: res.onlyB.length })}</button>
                </div>
                <div style={{ overflow: 'auto', maxHeight: '50vh' }}>
                  <table className="ui-table">
                    <thead><tr>{res.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                    <tbody>
                      {show === 'changed' && keys.length > 0 && res.changed.slice(0, 500).map((d, i) => (
                        <tr key={i}>{res.columns.map((_, k) => <td key={k} className={d.diff.has(k) ? 'rv-diff' : undefined}>{d.diff.has(k) ? <><s className="ui-muted">{cell(d.a[k])}</s> → {cell(d.b[k])}</> : cell(d.a[k])}</td>)}</tr>
                      ))}
                      {(show === 'onlyA' ? res.onlyA : show === 'onlyB' ? res.onlyB : []).slice(0, 500).map((r, i) => <tr key={i}>{r.map((v, k) => <td key={k}>{cell(v)}</td>)}</tr>)}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ edit review

export function EditReviewDialog({ statements, saving, manualCommit, onCancel, onConfirm }: { statements: string[]; saving: boolean; manualCommit: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [ack, setAck] = useState(false);
  return (
    <Dialog open alert wide title={t('edit.reviewTitle', { n: statements.length })} onClose={onCancel}
      footer={<><Button data-autofocus onClick={onCancel}>{t('common.cancel')}</Button><Button variant="danger" disabled={!ack} loading={saving} onClick={onConfirm}>{t('edit.saveN', { n: statements.length })}</Button></>}>
      <pre className="ui-mono" aria-label={t('write.statement')} style={{ whiteSpace: 'pre-wrap', background: 'var(--ui-surface-2)', padding: 8, borderRadius: 6, maxHeight: 320, overflow: 'auto', margin: 0, fontSize: 12 }}>{statements.map((s) => `${s};`).join('\n')}</pre>
      <p style={{ margin: 0 }}>{manualCommit ? t('edit.manualNote') : t('edit.atomicNote')}</p>
      <Checkbox label={t('write.ack')} checked={ack} onChange={(e) => setAck(e.target.checked)} />
    </Dialog>
  );
}
