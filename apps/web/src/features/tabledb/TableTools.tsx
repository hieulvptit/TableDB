import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, Input, Select, Spinner, Tabs, formatCell, useToast } from '@vnpay/ui';
import { t } from '../../i18n';
import { detectDelimiter, downloadBytes, downloadText, parseCsv, toCsv } from './csv';
import { runAudited, type Grid } from './exec';
import { friendlyDbError } from './dbErrors';
import type { TableRef } from './schemaStore';
import { useStoreVersion } from './SchemaTree';
import { EXPORT_EXT, insertStatements, metaSql, qualified, toJson, toSqlScript, upsertStatements, type ExportFormat, type MetaKind } from './tableSql';
import { readXlsx, toXlsx } from './xlsx';
import { useTableDb } from './store';
import type { Connection } from './types';

export type InfoTab = 'columns' | MetaKind | 'ddl';
export type ToolRequest = { kind: 'info'; tab: InfoTab; ref: TableRef } | { kind: 'export'; ref: TableRef } | { kind: 'import'; ref: TableRef };

const MAX_IMPORT_ROWS = 100_000;

export function TableTools({ conn, req, onClose }: { conn: Connection; req: ToolRequest | null; onClose: () => void }) {
  if (!req) return null;
  if (req.kind === 'info') return <InfoDialog key={`${req.ref.schema}.${req.ref.name}`} conn={conn} tableRef={req.ref} initial={req.tab} onClose={onClose} />;
  if (req.kind === 'export') return <ExportDialog conn={conn} tableRef={req.ref} onClose={onClose} />;
  return <ImportDialog conn={conn} tableRef={req.ref} onClose={onClose} />;
}

// ------------------------------------------------------------------ info
function GridTable({ grid }: { grid: Grid }) {
  if (grid.rows.length === 0) return <div className="ui-muted">{t('tt.noRows')}</div>;
  return (
    <div style={{ overflow: 'auto', maxHeight: '50vh' }}>
      <table className="ui-table">
        <thead><tr>{grid.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
        <tbody>{grid.rows.map((r, i) => <tr key={i}>{grid.columns.map((_, j) => { const f = formatCell(r[j]); return <td key={j} className={f.isNull ? 'ui-muted' : 'ui-mono'} style={{ whiteSpace: 'pre-wrap' }}>{f.text}</td>; })}</tr>)}</tbody>
      </table>
    </div>
  );
}

function MetaPanel({ conn, kind, tableRef }: { conn: Connection; kind: MetaKind; tableRef: TableRef }) {
  const sql = useMemo(() => metaSql(kind, tableRef, conn.driver), [kind, tableRef, conn.driver]);
  const [state, setState] = useState<{ loading: boolean; grid?: Grid; error?: string }>({ loading: !!sql });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!sql) return;
    let alive = true;
    setState({ loading: true });
    runAudited(conn, sql, 'read', { maxRows: 5000 })
      .then((grid) => alive && setState({ loading: false, grid }))
      .catch((e) => alive && setState({ loading: false, error: friendlyDbError(e).detail || friendlyDbError(e).title }));
    return () => { alive = false; };
  }, [conn, sql, nonce]);
  if (!sql) return <div className="ui-muted">{t(`tt.unsupported.${kind}` as never)}</div>;
  return (
    <div className="ui-col" style={{ gap: 6 }}>
      <div className="ui-row">
        <span className="ui-muted" style={{ flex: 1 }}>{t('tt.readOnlyNote')}</span>
        <Button size="sm" onClick={() => setNonce((n) => n + 1)}>{t('tree.menu.refresh')}</Button>
      </div>
      {state.loading && <Spinner label={t('common.loading')} />}
      {state.error && <div className="ui-error-text" role="alert">{state.error}</div>}
      {state.grid && (kind === 'partitions' && state.grid.rows.length === 0 ? <div className="ui-muted">{t('tt.notPartitioned')}</div> : <GridTable grid={state.grid} />)}
      <details><summary className="ui-muted">SQL</summary><pre className="ui-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{sql}</pre></details>
    </div>
  );
}

function ColumnsPanel({ conn, tableRef }: { conn: Connection; tableRef: TableRef }) {
  useStoreVersion(conn);
  const store = conn.store;
  useEffect(() => { void store.loadColumns(tableRef); }, [store, tableRef]);
  const cols = store.columns(tableRef);
  if (!cols || cols.status === 'loading') return <Spinner label={t('common.loading')} />;
  if (cols.status === 'error') return <div className="ui-error-text">{cols.error}</div>;
  const v = cols.value!;
  return (
    <div className="ui-col" style={{ gap: 8 }}>
      <div style={{ overflow: 'auto', maxHeight: '45vh' }}>
        <table className="ui-table">
          <thead><tr><th>#</th><th>{t('tree.col')}</th><th>{t('tree.type')}</th><th>NULL</th><th>{t('tt.default')}</th><th>{t('tree.keys')}</th><th>{t('tree.remarks')}</th></tr></thead>
          <tbody>{v.columns.map((c, i) => (
            <tr key={c.name}>
              <td>{c.position ?? i + 1}</td><td className="ui-mono">{c.name}</td>
              <td>{c.typeName}{c.size ? `(${c.size}${c.scale ? `,${c.scale}` : ''})` : ''}</td>
              <td>{c.nullable === false ? 'NOT NULL' : 'NULL'}</td><td className="ui-mono">{c.default ?? ''}</td>
              <td>{v.primaryKey.includes(c.name) ? 'PK ' : ''}{v.foreignKeys.filter((f) => f.columns.includes(c.name)).map((f) => `FK→${f.refTable}`).join(' ')}</td>
              <td>{c.remarks ?? ''}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {(v.primaryKey.length > 0 || v.foreignKeys.length > 0) && (
        <div>
          <strong>{t('tt.constraints')}</strong>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {v.primaryKey.length > 0 && <li className="ui-mono">PRIMARY KEY ({v.primaryKey.join(', ')})</li>}
            {v.foreignKeys.map((f, i) => <li key={i} className="ui-mono">{f.name ? `${f.name}: ` : ''}FOREIGN KEY ({f.columns.join(', ')}) → {f.refSchema}.{f.refTable} ({f.refColumns.join(', ')})</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function DdlPanel({ conn, tableRef }: { conn: Connection; tableRef: TableRef }) {
  useStoreVersion(conn);
  const db = useTableDb();
  const toast = useToast();
  const store = conn.store;
  useEffect(() => { void store.loadDdl(tableRef); }, [store, tableRef]);
  const ddl = store.ddl(tableRef);
  if (!ddl || ddl.status === 'loading') return <Spinner label={t('common.loading')} />;
  if (ddl.status === 'error') return <div className="ui-error-text" role="alert">{ddl.error}</div>;
  return (
    <div className="ui-col" style={{ gap: 6 }}>
      <div className="ui-row">
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(ddl.value ?? '').then(() => toast.push(t('tree.copied'), 'success'), () => {})}>{t('tt.copy')}</Button>
        <Button size="sm" onClick={() => db.newTab(ddl.value ?? '')}>{t('tt.openInEditor')}</Button>
        <Button size="sm" onClick={() => void store.loadDdl(tableRef, true)}>{t('tree.menu.refresh')}</Button>
      </div>
      <pre className="ui-mono" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, maxHeight: '50vh', overflow: 'auto' }}>{ddl.value}</pre>
    </div>
  );
}

function InfoDialog({ conn, tableRef, initial, onClose }: { conn: Connection; tableRef: TableRef; initial: InfoTab; onClose: () => void }) {
  const [tab, setTab] = useState<InfoTab>(initial);
  useEffect(() => { setTab(initial); }, [initial]);
  const panel = (id: InfoTab) => id === 'columns' ? <ColumnsPanel conn={conn} tableRef={tableRef} /> : id === 'ddl' ? <DdlPanel conn={conn} tableRef={tableRef} /> : <MetaPanel conn={conn} kind={id} tableRef={tableRef} />;
  const ids: InfoTab[] = ['columns', 'indexes', 'partitions', 'properties', 'ddl'];
  return (
    <Dialog open wide title={<span className="ui-mono">{qualified(tableRef, conn.driver)}</span>} onClose={onClose}>
      <Tabs label={t('tt.tabs')} activeId={tab} onChange={(id) => setTab(id as InfoTab)}
        items={ids.map((id) => ({ id, label: t(`tt.tab.${id}` as never), content: tab === id ? panel(id) : null }))} />
    </Dialog>
  );
}

// ------------------------------------------------------------------ export
function ExportDialog({ conn, tableRef, onClose }: { conn: Connection; tableRef: TableRef; onClose: () => void }) {
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [maxRows, setMaxRows] = useState(100_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stop = useRef(false);
  const go = async () => {
    setBusy(true); setError(''); stop.current = false;
    try {
      const g = await runAudited(conn, `SELECT * FROM ${qualified(tableRef, conn.driver)}`, 'read', { maxRows, all: true, cancelled: () => stop.current });
      const x = EXPORT_EXT[format];
      if (format === 'xlsx') downloadBytes(`${tableRef.name}.${x.ext}`, toXlsx(g.columns, g.rows, tableRef.name), x.mime);
      else {
        const text = format === 'csv' ? toCsv(g.columns, g.rows) : format === 'json' ? toJson(g.columns, g.rows)
          : toSqlScript(tableRef, conn.driver, g.columns.map((name, i) => ({ name, typeName: g.typeNames[i] ?? '' })), g.rows);
        downloadText(`${tableRef.name}.${x.ext}`, text, x.mime, format === 'csv');
      }
      toast.push(t('result.exported', { n: g.rows.length }) + (g.truncated ? ` ${t('tt.export.truncated')}` : ''), 'success');
      onClose();
    } catch (e) { const f = friendlyDbError(e); setError(f.detail || f.title); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open title={`${t('tt.export.title')}: ${tableRef.schema}.${tableRef.name}`} onClose={() => { stop.current = true; onClose(); }}
      footer={<><Button onClick={() => { stop.current = true; onClose(); }}>{t('tt.cancel')}</Button><Button variant="primary" onClick={() => void go()} loading={busy}>{t('tt.export.go')}</Button></>}>
      <div className="ui-col" style={{ gap: 10 }}>
        <Select label={t('tt.export.format')} value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}
          options={[{ value: 'csv', label: 'CSV (UTF-8, Excel)' }, { value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'json', label: 'JSON' }, { value: 'sql', label: t('tt.export.sql') }]} />
        <Input label={t('editor.maxRows')} type="number" min={1} max={100000} value={maxRows} onChange={(e) => setMaxRows(Math.max(1, Math.min(100_000, Number(e.target.value) || 1)))} hint={t('tt.export.hint')} />
        {error && <div className="ui-error-text" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ import
type Delim = 'auto' | ',' | ';' | '\t' | '|';
type ImportMode = 'insert' | 'upsert' | 'replace';
interface RowError { row: number; message: string }

function ImportDialog({ conn, tableRef, onClose }: { conn: Connection; tableRef: TableRef; onClose: () => void }) {
  useStoreVersion(conn);
  const db = useTableDb();
  const toast = useToast();
  const store = conn.store;
  useEffect(() => { void store.loadColumns(tableRef); }, [store, tableRef]);
  const meta = store.columns(tableRef)?.value;
  const tableCols = meta?.columns ?? [];
  const pk = meta?.primaryKey ?? [];
  const [src, setSrc] = useState<{ name: string; text?: string; grid?: string[][] } | null>(null);
  const [delim, setDelim] = useState<Delim>('auto');
  const [header, setHeader] = useState(true);
  const [trim, setTrim] = useState(true);
  const [emptyNull, setEmptyNull] = useState(true);
  const [nullText, setNullText] = useState('NULL');
  const [mapping, setMapping] = useState<number[]>([]);
  const [mode, setMode] = useState<ImportMode>('insert');
  const [atomic, setAtomic] = useState(true);
  const [batch, setBatch] = useState(200);
  const [parseErr, setParseErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);
  const stop = useRef(false);
  const manual = !!conn.tx && !conn.tx.autoCommit;
  const canUpsert = (conn.driver === 'postgresql' || conn.driver === 'oracle') && pk.length > 0;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setParseErr(''); setError(''); setConfirm(false); setSrc(null); setRowErrors([]);
    if (f.size > 25 * 1024 * 1024) { setParseErr(t('tt.import.tooBig')); return; }
    try {
      if (/\.xlsx$/i.test(f.name)) setSrc({ name: f.name, grid: await readXlsx(new Uint8Array(await f.arrayBuffer())) });
      else setSrc({ name: f.name, text: await f.text() });
    } catch (e) { setParseErr(`${t('tt.import.unreadable')} ${(e as Error).message}`); }
  };

  const grid = useMemo(() => {
    if (!src) return null;
    if (src.grid) return src.grid;
    const text = src.text ?? '';
    return parseCsv(text, delim === 'auto' ? detectDelimiter(text) : delim);
  }, [src, delim]);
  const fileCols = useMemo(() => (!grid || grid.length === 0 ? [] : header ? grid[0]!.map((h) => h.trim()) : grid[0]!.map((_, i) => `#${i + 1}`)), [grid, header]);
  const dataRows = useMemo(() => (!grid ? [] : header ? grid.slice(1) : grid), [grid, header]);
  // file column -> table column (by name, case-insensitive; by position without a header row)
  useEffect(() => {
    if (!fileCols.length) { setMapping([]); return; }
    const byName = new Map(tableCols.map((c, i) => [c.name.toLowerCase(), i]));
    const used = new Set<number>();
    setMapping(fileCols.map((h, i) => {
      const j = header ? byName.get(h.toLowerCase()) : i < tableCols.length ? i : undefined;
      if (j === undefined || used.has(j)) return -1;
      used.add(j); return j;
    }));
  }, [fileCols, tableCols, header]);

  const used = mapping.map((j, i) => ({ i, j })).filter((x) => x.j >= 0);
  const cols = used.map((u) => ({ name: tableCols[u.j]!.name, typeName: tableCols[u.j]!.typeName }));
  const value = (v: string | undefined) => {
    if (v === undefined) return null;
    const x = trim ? v.trim() : v;
    if (emptyNull && x === '') return null;
    if (nullText && x === nullText) return null;
    return x;
  };
  const data = () => dataRows.map((r) => used.map((u) => value(r[u.i])));
  const pkMapped = pk.every((k) => cols.some((c) => c.name === k));
  const tooMany = dataRows.length > MAX_IMPORT_ROWS;
  const ready = !!grid && used.length > 0 && conn.allowWrite && !tooMany && dataRows.length > 0 && (mode !== 'upsert' || (canUpsert && pkMapped));

  const build = (rows: unknown[][], size: number) => (mode === 'upsert' ? upsertStatements(tableRef, conn.driver, cols, pk, rows, size) ?? [] : insertStatements(tableRef, conn.driver, cols, rows, size));

  const run = async () => {
    setError(''); setRowErrors([]); stop.current = false;
    const rows = data();
    const total = rows.length;
    setProgress({ done: 0, total });
    try {
      if (atomic || mode === 'replace') {
        const stmts = [...(mode === 'replace' ? [`DELETE FROM ${qualified(tableRef, conn.driver)}`] : []), ...build(rows, batch)];
        const offset = mode === 'replace' ? 1 : 0;
        const r = await db.runWrites(conn.id, stmts, { atomic: true, stop: () => stop.current, onProgress: (n) => setProgress({ done: Math.min(total, Math.max(0, n - offset) * batch), total }) });
        if (r.error) { setError(`${r.error.detail || r.error.title}\n${t(manual ? 'tt.import.failedManual' : 'tt.import.rolledBack')}`); setProgress(null); setConfirm(false); return; }
        if (stop.current) { toast.push(t('tt.import.stopped'), 'warning'); setProgress(null); setConfirm(false); return; }
        toast.push(r.pending ? t('tt.import.donePending', { n: total }) : t('tt.import.done', { n: total }), 'success');
        onClose();
        return;
      }
      // skip-errors: each batch commits on its own; a failing batch is retried row by row
      let done = 0, ok = 0;
      const errs: RowError[] = [];
      for (let i = 0; i < rows.length && !stop.current; i += batch) {
        const part = rows.slice(i, i + batch);
        try {
          await runAudited(conn, build(part, batch)[0]!, 'write');
          ok += part.length;
        } catch {
          for (let k = 0; k < part.length && !stop.current; k++) {
            try { await runAudited(conn, build([part[k]!], 1)[0]!, 'write'); ok++; }
            catch (e) { const f = friendlyDbError(e); if (errs.length < 500) errs.push({ row: i + k + (header ? 2 : 1), message: f.detail || f.title }); }
          }
        }
        done += part.length;
        setProgress({ done, total });
        setRowErrors([...errs]);
      }
      setProgress(null); setConfirm(false);
      if (errs.length === 0 && !stop.current) { toast.push(t('tt.import.done', { n: ok }), 'success'); onClose(); return; }
      setError(t('tt.import.partialSkip', { ok, bad: total - ok - (total - done) }));
    } catch (e) {
      const f = friendlyDbError(e);
      setError(f.detail || f.title);
      setProgress(null); setConfirm(false);
    }
  };

  return (
    <Dialog open wide title={`${t('tt.import.title')}: ${tableRef.schema}.${tableRef.name}`} onClose={() => { stop.current = true; onClose(); }}
      footer={<>
        {rowErrors.length > 0 && <Button onClick={() => downloadText(`${tableRef.name}_import_errors.csv`, toCsv(['row', 'error'], rowErrors.map((e) => [e.row, e.message])), 'text/csv;charset=utf-8', true)}>{t('tt.import.errorsFile')}</Button>}
        <span style={{ flex: 1 }} />
        <Button onClick={() => { stop.current = true; if (!progress) onClose(); }}>{progress ? t('tt.import.stop') : t('tt.cancel')}</Button>
        {!confirm
          ? <Button variant="primary" disabled={!ready || !!progress} onClick={() => setConfirm(true)}>{t('tt.import.review')}</Button>
          : <Button variant="danger" loading={!!progress} onClick={() => void run()}>{t('tt.import.go', { n: dataRows.length })}</Button>}
      </>}>
      <div className="ui-col" style={{ gap: 10 }}>
        {!conn.allowWrite && <div className="ui-card" role="alert" style={{ borderColor: 'var(--ui-danger)' }}>{t('tt.import.noWrite')}</div>}
        <label className="ui-col" style={{ gap: 4 }}>
          <span className="ui-label">{t('tt.import.file')}</span>
          <input type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <div className="ui-row" style={{ flexWrap: 'wrap', gap: 12 }}>
          {!src?.grid && (
            <label className="ui-row" style={{ gap: 4 }}>{t('export.delimiter')}
              <select className="ui-select" value={delim} onChange={(e) => setDelim(e.target.value as Delim)}>
                <option value="auto">{t('tt.import.auto')}</option><option value=",">,</option><option value=";">;</option><option value={'\t'}>Tab</option><option value="|">|</option>
              </select>
            </label>
          )}
          <Checkbox label={t('tt.import.header')} checked={header} onChange={(e) => setHeader(e.target.checked)} />
          <Checkbox label={t('tt.import.trim')} checked={trim} onChange={(e) => setTrim(e.target.checked)} />
          <Checkbox label={t('tt.import.emptyNull')} checked={emptyNull} onChange={(e) => setEmptyNull(e.target.checked)} />
          <label className="ui-row" style={{ gap: 4 }}>{t('tt.import.nullText')}<input className="ui-input" style={{ width: 80 }} value={nullText} onChange={(e) => setNullText(e.target.value)} /></label>
        </div>
        {parseErr && <div className="ui-error-text" role="alert">{parseErr}</div>}
        {grid && (
          <div className="ui-col" style={{ gap: 6 }}>
            <div>{t('tt.import.summary', { name: src!.name, n: dataRows.length, m: used.length })}</div>
            {tooMany && <div className="ui-error-text">{t('tt.import.tooMany', { n: MAX_IMPORT_ROWS })}</div>}
            {used.length === 0 && <div className="ui-error-text">{t('tt.import.noMatch')}</div>}
            <div style={{ overflow: 'auto', maxHeight: 240 }}>
              <table className="ui-table" aria-label={t('tt.import.mapping')}>
                <thead>
                  <tr>{fileCols.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr>
                  <tr>{fileCols.map((h, i) => (
                    <th key={i}>
                      <select className="ui-select" aria-label={t('tt.import.target', { c: h })} value={mapping[i] ?? -1}
                        onChange={(e) => { const j = Number(e.target.value); setMapping((m) => m.map((x, k) => (k === i ? j : x === j && j >= 0 ? -1 : x))); }}>
                        <option value={-1}>{t('tt.import.skipCol')}</option>
                        {tableCols.map((c, j) => <option key={c.name} value={j}>{c.name} : {c.typeName}{pk.includes(c.name) ? ' (PK)' : ''}</option>)}
                      </select>
                    </th>
                  ))}</tr>
                </thead>
                <tbody>{dataRows.slice(0, 5).map((r, ri) => <tr key={ri}>{fileCols.map((_, i) => { const v = mapping[i]! >= 0 ? value(r[i]) : r[i]; return <td key={i} className={mapping[i]! < 0 ? 'ui-muted' : 'ui-mono'}>{v === null ? <span className="ui-muted">NULL</span> : v}</td>; })}</tr>)}</tbody>
              </table>
            </div>
          </div>
        )}
        <div className="ui-row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <Select label={t('tt.import.mode')} value={mode} onChange={(e) => { const m = e.target.value as ImportMode; setMode(m); if (m === 'replace') setAtomic(true); }} options={[
            { value: 'insert', label: t('tt.import.mode.insert') },
            { value: 'upsert', label: t('tt.import.mode.upsert'), disabled: !canUpsert },
            { value: 'replace', label: t('tt.import.mode.replace') },
          ]} />
          <Select label={t('tt.import.tx')} value={atomic ? 'atomic' : 'skip'} onChange={(e) => setAtomic(e.target.value === 'atomic')} options={[
            { value: 'atomic', label: t('tt.import.tx.atomic') },
            { value: 'skip', label: t('tt.import.tx.skip'), disabled: mode === 'replace' || manual },
          ]} />
          <Select label={t('tt.import.batch')} value={String(batch)} onChange={(e) => setBatch(Number(e.target.value))} options={[50, 200, 500, 1000].map((n) => ({ value: String(n), label: String(n) }))} />
        </div>
        {mode === 'upsert' && canUpsert && !pkMapped && <div className="ui-error-text">{t('tt.import.pkNeeded', { pk: pk.join(', ') })}</div>}
        {mode === 'upsert' && !canUpsert && <div className="ui-muted">{t('tt.import.noUpsert')}</div>}
        {manual && <div className="ui-muted">{t('tt.import.manualNote')}</div>}
        {confirm && <div className="ui-card" role="alert" style={{ borderColor: 'var(--ui-danger)' }}>{t(mode === 'replace' ? 'tt.import.warnReplace' : 'tt.import.warn', { n: dataRows.length, table: qualified(tableRef, conn.driver) })}</div>}
        {progress && <div role="status">{t('tt.import.progress', { a: progress.done, b: progress.total })}</div>}
        {error && <div className="ui-error-text" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
        {rowErrors.length > 0 && (
          <div style={{ overflow: 'auto', maxHeight: 160 }}>
            <table className="ui-table"><thead><tr><th scope="col">{t('tt.import.row')}</th><th scope="col">{t('script.st.error')}</th></tr></thead>
              <tbody>{rowErrors.slice(0, 100).map((e, i) => <tr key={i}><td>{e.row}</td><td className="ui-mono" style={{ fontSize: 12 }}>{e.message}</td></tr>)}</tbody></table>
          </div>
        )}
      </div>
    </Dialog>
  );
}
