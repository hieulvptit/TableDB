import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Dialog, Spinner, Tabs, formatCell, useToast } from '@vnpay/ui';
import type { DriverType } from '@vnpay/shared';
import type { ColumnInfo, ColumnsResult } from '../../gateway/types';
import { t } from '../../i18n';
import { downloadText } from './csv';
import { friendlyDbError } from './dbErrors';
import { runAudited, type Grid } from './exec';
import { SourceDialog } from './ObjectTools';
import type { DbObject, ObjectKind } from './objects';
import { useStoreVersion } from './SchemaTree';
import { useTableDb } from './store';
import { selectStarSql } from './tableSql';
import type { Connection } from './types';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const likePattern = (q: string) => lit(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;
const cellText = (v: unknown) => (v === null || v === undefined ? '' : formatCell(v).text);

/** Small read-only grid used by the tool dialogs. */
function MiniGrid({ grid, actions, label }: { grid: Grid; actions?: (row: unknown[]) => React.ReactNode; label: string }) {
  if (grid.rows.length === 0) return <div className="ui-muted">{t('tt.noRows')}</div>;
  return (
    <div style={{ overflow: 'auto', maxHeight: '52vh' }}>
      <table className="ui-table" aria-label={label}>
        <thead><tr>{actions && <th scope="col" />}{grid.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
        <tbody>{grid.rows.map((r, i) => (
          <tr key={i}>{actions && <td style={{ whiteSpace: 'nowrap' }}>{actions(r)}</td>}{grid.columns.map((_, j) => <td key={j} className={r[j] === null ? 'ui-null' : undefined} style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cellText(r[j]).slice(0, 2000)}>{r[j] === null ? 'NULL' : cellText(r[j])}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ global search

type SearchKind = 'tables' | 'columns' | 'routines';
interface Hit { schema: string; name: string; type: string; column?: string; dataType?: string }

export function searchSql(driver: DriverType, kind: SearchKind, q: string, schema: string | null, catalog: string | null): string | null {
  const p = likePattern(q);
  if (driver === 'oracle') {
    const own = schema ? ` AND OWNER = ${lit(schema)}` : '';
    const wrap = (s: string) => `SELECT * FROM (${s}) WHERE ROWNUM <= 500`;
    if (kind === 'tables') return wrap(`SELECT OWNER AS SCHEMA_NAME, OBJECT_NAME, OBJECT_TYPE, NULL AS COLUMN_NAME, NULL AS DATA_TYPE FROM ALL_OBJECTS WHERE OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SYNONYM', 'SEQUENCE') AND UPPER(OBJECT_NAME) LIKE UPPER(${p}) ESCAPE '\\'${own} ORDER BY OWNER, OBJECT_NAME`);
    if (kind === 'routines') return wrap(`SELECT OWNER AS SCHEMA_NAME, OBJECT_NAME, OBJECT_TYPE, NULL AS COLUMN_NAME, NULL AS DATA_TYPE FROM ALL_OBJECTS WHERE OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'TYPE') AND UPPER(OBJECT_NAME) LIKE UPPER(${p}) ESCAPE '\\'${own} ORDER BY OWNER, OBJECT_NAME`);
    return wrap(`SELECT OWNER AS SCHEMA_NAME, TABLE_NAME AS OBJECT_NAME, 'COLUMN' AS OBJECT_TYPE, COLUMN_NAME, DATA_TYPE FROM ALL_TAB_COLUMNS WHERE UPPER(COLUMN_NAME) LIKE UPPER(${p}) ESCAPE '\\'${own} ORDER BY OWNER, TABLE_NAME, COLUMN_ID`);
  }
  if (driver === 'postgresql') {
    const sys = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'`;
    const own = schema ? ` AND n.nspname = ${lit(schema)}` : '';
    if (kind === 'tables') return `SELECT n.nspname AS schema_name, c.relname AS object_name, CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'SEQUENCE' END AS object_type, NULL AS column_name, NULL AS data_type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND c.relname ILIKE ${p} AND ${sys}${own} ORDER BY 1, 2 LIMIT 500`;
    if (kind === 'routines') return `SELECT n.nspname AS schema_name, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object_name, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, NULL AS column_name, p.oid::text AS data_type FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prokind IN ('f', 'p') AND p.proname ILIKE ${p} AND ${sys}${own} ORDER BY 1, 2 LIMIT 500`;
    return `SELECT table_schema AS schema_name, table_name AS object_name, 'COLUMN' AS object_type, column_name, data_type FROM information_schema.columns WHERE column_name ILIKE ${p} AND table_schema NOT IN ('pg_catalog', 'information_schema')${schema ? ` AND table_schema = ${lit(schema)}` : ''} ORDER BY 1, 2, ordinal_position LIMIT 500`;
  }
  // Trino (per catalog) and other engines: information_schema
  if (kind === 'routines') return null;
  const is = driver === 'trino' ? (catalog ? `${qid(catalog)}.information_schema` : null) : 'information_schema';
  if (!is) return null;
  const own = schema ? ` AND table_schema = ${lit(schema)}` : ` AND table_schema <> 'information_schema'`;
  if (kind === 'tables') return `SELECT table_schema AS schema_name, table_name AS object_name, table_type AS object_type, NULL AS column_name, NULL AS data_type FROM ${is}.tables WHERE lower(table_name) LIKE lower(${p}) ESCAPE '\\'${own} ORDER BY 1, 2 LIMIT 500`;
  return `SELECT table_schema AS schema_name, table_name AS object_name, 'COLUMN' AS object_type, column_name, data_type FROM ${is}.columns WHERE lower(column_name) LIKE lower(${p}) ESCAPE '\\'${own} ORDER BY 1, 2 LIMIT 500`;
}

export function SearchDialog({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const db = useTableDb();
  const toast = useToast();
  useStoreVersion(conn);
  const cats = conn.store.catalogs()?.value ?? [];
  const [catalog, setCatalog] = useState<string>(cats[0] ?? '');
  const schemas = conn.store.schemas(cats.length ? catalog || cats[0] : undefined)?.value ?? [];
  useEffect(() => { if (cats.length && catalog) void conn.store.loadSchemas(catalog); }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  const [q, setQ] = useState('');
  const [schema, setSchema] = useState(conn.currentSchema ?? '');
  const [kinds, setKinds] = useState<Record<SearchKind, boolean>>({ tables: true, columns: true, routines: true });
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [src, setSrc] = useState<{ schema: string; obj: DbObject } | null>(null);
  const go = async () => {
    if (q.trim().length < 2) return;
    setBusy(true); setErrors([]);
    const out: Hit[] = [];
    const errs: string[] = [];
    for (const k of (['tables', 'routines', 'columns'] as SearchKind[]).filter((x) => kinds[x])) {
      const sql = searchSql(conn.driver, k, q.trim(), schema || null, cats.length ? catalog || null : null);
      if (!sql) continue;
      try {
        const g = await runAudited(conn, sql, 'read', { maxRows: 500 });
        for (const r of g.rows) out.push({ schema: cellText(r[0]), name: cellText(r[1]), type: cellText(r[2]), ...(r[3] !== null ? { column: cellText(r[3]) } : {}), ...(r[4] !== null ? { dataType: cellText(r[4]) } : {}) });
      } catch (e) { const f = friendlyDbError(e); errs.push(`${t(`search.kind.${k}`)}: ${f.detail || f.title}`); }
    }
    setHits(out); setErrors(errs); setBusy(false);
  };
  const isTable = (h: Hit) => /TABLE|VIEW|BASE/i.test(h.type) && h.type !== 'COLUMN';
  const refOf = (h: Hit) => ({ ...(cats.length ? { catalog: catalog || cats[0] } : {}), schema: h.schema, name: h.name });
  const routineKind = (h: Hit): ObjectKind | null => ({ PROCEDURE: 'procedures', FUNCTION: 'functions', PACKAGE: 'packages', TRIGGER: 'triggers', TYPE: 'types', SEQUENCE: 'sequences', SYNONYM: 'synonyms' } as Record<string, ObjectKind>)[h.type] ?? null;
  return (
    <Dialog open wide title={`${t('search.title')} — ${conn.name}`} onClose={onClose}>
      <form className="ui-col" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <div className="ui-row" style={{ flexWrap: 'wrap' }}>
          <input className="ui-input" style={{ flex: 1, minWidth: 220 }} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} />
          {cats.length > 0 && <select className="ui-select" aria-label="Catalog" value={catalog} onChange={(e) => setCatalog(e.target.value)}>{cats.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
          <select className="ui-select" aria-label={t('session.schema')} value={schema} onChange={(e) => setSchema(e.target.value)}>
            <option value="">{t('search.allSchemas')}</option>
            {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button type="submit" variant="primary" loading={busy} disabled={q.trim().length < 2}>{t('search.go')}</Button>
        </div>
        <div className="ui-row">
          {(['tables', 'columns', 'routines'] as SearchKind[]).map((k) => <Checkbox key={k} label={t(`search.kind.${k}`)} checked={kinds[k]} onChange={(e) => setKinds((x) => ({ ...x, [k]: e.target.checked }))} />)}
        </div>
      </form>
      {errors.map((e, i) => <div key={i} className="ui-error-text" role="alert">{e}</div>)}
      {hits && (
        <div style={{ overflow: 'auto', maxHeight: '50vh' }}>
          {hits.length === 0 ? <div className="ui-muted">{t('search.none')}</div> : (
            <table className="ui-table" aria-label={t('search.title')}>
              <thead><tr><th scope="col">Schema</th><th scope="col">{t('search.object')}</th><th scope="col">{t('tree.type')}</th><th scope="col">{t('tree.col')}</th><th scope="col" /></tr></thead>
              <tbody>{hits.map((h, i) => (
                <tr key={i}>
                  <td>{h.schema}</td><td className="ui-mono">{h.name}</td><td><Badge>{h.type}</Badge></td>
                  <td className="ui-mono">{h.column ? `${h.column}${h.dataType ? ` ${h.dataType}` : ''}` : ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {(isTable(h) || h.column) && <Button size="sm" onClick={() => { db.setActiveConn(conn.id); db.openTable(refOf(h)); onClose(); }}>{t('tree.menu.viewData')}</Button>}
                    {(isTable(h) || h.column) && <Button size="sm" variant="ghost" onClick={() => { db.setActiveConn(conn.id); db.insertSql(selectStarSql(refOf(h), conn.driver)); onClose(); }}>SELECT</Button>}
                    {routineKind(h) && !isTable(h) && <Button size="sm" onClick={() => setSrc({ schema: h.schema, obj: { name: h.name, kind: routineKind(h)!, ...(conn.driver === 'postgresql' && h.dataType ? { oid: h.dataType } : {}) } })}>{t('obj.viewSource')}</Button>}
                    <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(h.column ?? `${h.schema}.${h.name}`).then(() => toast.push(t('tree.copied'), 'success'), () => {})}>{t('tt.copy')}</Button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {hits.length >= 500 && <div className="ui-muted">{t('search.capped')}</div>}
        </div>
      )}
      {src && <SourceDialog conn={conn} schema={src.schema} obj={src.obj} onClose={() => setSrc(null)} />}
    </Dialog>
  );
}

// ------------------------------------------------------------------ session / lock monitor

interface MonitorSpec { sessions: string; locks?: string; kill?: Array<{ label: string; sql: (row: unknown[], cols: string[]) => string | null }> }
const val = (row: unknown[], cols: string[], name: string) => { const i = cols.findIndex((c) => c.toUpperCase() === name.toUpperCase()); return i >= 0 ? row[i] : undefined; };
const int = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? String(v) : null);

export function monitorSpec(driver: DriverType): MonitorSpec | null {
  if (driver === 'postgresql') return {
    sessions: `SELECT pid, pid = pg_backend_pid() AS me, usename, datname, application_name, client_addr::text AS client_addr, state, wait_event_type, wait_event, backend_start, xact_start, query_start, (now() - query_start)::text AS running_for, left(query, 500) AS query FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY state = 'active' DESC, query_start NULLS LAST`,
    locks: `SELECT l.pid, a.usename, l.locktype, l.mode, l.granted, coalesce(n.nspname || '.' || c.relname, l.relation::text) AS relation, pg_blocking_pids(l.pid)::text AS blocked_by, left(a.query, 200) AS query FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation LEFT JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.pid <> pg_backend_pid() ORDER BY l.granted, l.pid`,
    kill: [
      { label: 'monitor.cancelQuery', sql: (r, c) => { const p = int(val(r, c, 'pid')); return p ? `SELECT pg_cancel_backend(${p})` : null; } },
      { label: 'monitor.terminate', sql: (r, c) => { const p = int(val(r, c, 'pid')); return p ? `SELECT pg_terminate_backend(${p})` : null; } },
    ],
  };
  if (driver === 'oracle') return {
    sessions: `SELECT SID, SERIAL#, USERNAME, STATUS, CASE WHEN SID = SYS_CONTEXT('USERENV', 'SID') THEN 'YES' END AS ME, OSUSER, MACHINE, PROGRAM, SQL_ID, EVENT, SECONDS_IN_WAIT, BLOCKING_SESSION, LOGON_TIME FROM V$SESSION WHERE TYPE = 'USER' ORDER BY STATUS, SID`,
    locks: `SELECT l.SID, s.USERNAME, l.TYPE, l.LMODE, l.REQUEST, l.BLOCK, l.CTIME, o.OWNER || '.' || o.OBJECT_NAME AS OBJECT_NAME FROM V$LOCK l JOIN V$SESSION s ON s.SID = l.SID LEFT JOIN ALL_OBJECTS o ON o.OBJECT_ID = l.ID1 AND l.TYPE = 'TM' WHERE l.TYPE IN ('TM', 'TX', 'UL') ORDER BY l.BLOCK DESC, l.SID`,
    kill: [{ label: 'monitor.kill', sql: (r, c) => { const a = int(val(r, c, 'SID')), b = int(val(r, c, 'SERIAL#')); return a && b ? `ALTER SYSTEM KILL SESSION '${a},${b}' IMMEDIATE` : null; } }],
  };
  if (driver === 'trino') return {
    sessions: `SELECT query_id, state, "user", source, created, started, "end", error_code, left(query, 500) AS query FROM system.runtime.queries ORDER BY created DESC LIMIT 500`,
    kill: [{ label: 'monitor.kill', sql: (r, c) => { const q = val(r, c, 'query_id'); return typeof q === 'string' && /^[A-Za-z0-9_]+$/.test(q) ? `CALL system.runtime.kill_query(query_id => '${q}', message => 'Killed from TableDB')` : null; } }],
  };
  return null;
}

export function MonitorDialog({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const toast = useToast();
  const spec = monitorSpec(conn.driver);
  const [tab, setTab] = useState<'sessions' | 'locks'>('sessions');
  const [data, setData] = useState<{ sessions?: Grid; locks?: Grid; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [kill, setKill] = useState<{ sql: string } | null>(null);
  const [ack, setAck] = useState(false);
  const busyRef = useRef(false);
  const load = async () => {
    if (!spec || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const sessions = await runAudited(conn, spec.sessions, 'read', { maxRows: 2000 });
      const locks = spec.locks && tab === 'locks' ? await runAudited(conn, spec.locks, 'read', { maxRows: 5000 }) : data.locks;
      setData({ sessions, locks });
    } catch (e) { const f = friendlyDbError(e); setData((d) => ({ ...d, error: f.detail || f.title })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => { void load(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!auto) return; const h = setInterval(() => void load(), 5000); return () => clearInterval(h); }, [auto, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const doKill = async () => {
    if (!kill) return;
    try { await runAudited(conn, kill.sql, 'write'); toast.push(t('monitor.done'), 'success'); setKill(null); void load(); }
    catch (e) { const f = friendlyDbError(e); toast.push(f.detail || f.title, 'error'); }
  };
  const actions = spec?.kill && conn.allowWrite ? (row: unknown[]) => (
    <>{spec.kill!.map((k) => { const sql = k.sql(row, data.sessions?.columns ?? []); const me = val(row, data.sessions?.columns ?? [], 'me'); return sql && me !== true && me !== 'YES' ? <Button key={k.label} size="sm" variant="ghost" onClick={() => { setAck(false); setKill({ sql }); }}>{t(k.label)}</Button> : null; })}</>
  ) : undefined;
  return (
    <Dialog open wide title={`${t('monitor.title')} — ${conn.name}`} onClose={onClose}
      footer={<>
        <Checkbox label={t('monitor.auto')} checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span style={{ flex: 1 }} />
        <Button loading={busy} onClick={() => void load()}>{t('tree.menu.refresh')}</Button>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </>}>
      {!spec ? <div className="ui-muted">{t('monitor.unsupported')}</div> : (
        <>
          {data.error && <div className="ui-error-text" role="alert">{data.error}<div className="ui-muted">{t('monitor.privHint')}</div></div>}
          {!conn.allowWrite && <div className="ui-muted" style={{ fontSize: 12 }}>{t('monitor.readOnly')}</div>}
          <Tabs label={t('monitor.title')} activeId={tab} onChange={(id) => setTab(id as 'sessions' | 'locks')} items={[
            { id: 'sessions', label: t('monitor.sessions', { n: data.sessions?.rows.length ?? 0 }), content: tab === 'sessions' ? (data.sessions ? <MiniGrid grid={data.sessions} actions={actions} label={t('monitor.title')} /> : <Spinner label="" />) : null },
            ...(spec.locks ? [{ id: 'locks', label: t('monitor.locks'), content: tab === 'locks' ? (data.locks ? <MiniGrid grid={data.locks} label={t('monitor.locks')} /> : <Spinner label="" />) : null }] : []),
          ]} />
        </>
      )}
      <Dialog open={!!kill} alert title={t('monitor.confirm')} onClose={() => setKill(null)}
        footer={<><Button data-autofocus onClick={() => setKill(null)}>{t('common.cancel')}</Button><Button variant="danger" disabled={!ack} onClick={() => void doKill()}>{t('write.run')}</Button></>}>
        <pre className="ui-mono" style={{ whiteSpace: 'pre-wrap', margin: 0, background: 'var(--ui-surface-2)', padding: 8, borderRadius: 6 }}>{kill?.sql}</pre>
        <Checkbox label={t('write.ack')} checked={ack} onChange={(e) => setAck(e.target.checked)} />
      </Dialog>
    </Dialog>
  );
}

// ------------------------------------------------------------------ schema compare

interface SideSel { connId: string; catalog: string; schema: string }
interface TableDiff { name: string; status: 'onlyLeft' | 'onlyRight' | 'changed' | 'same'; columns: Array<{ name: string; change: 'added' | 'removed' | 'changed'; left?: string; right?: string }>; pk?: { left: string; right: string } }

const colSig = (c: ColumnInfo) => `${c.typeName}${c.size ? `(${c.size}${c.scale ? `,${c.scale}` : ''})` : ''}${c.nullable === false ? ' NOT NULL' : ''}${c.default ? ` DEFAULT ${c.default}` : ''}`;

export function diffSchemas(left: Map<string, ColumnsResult>, right: Map<string, ColumnsResult>): TableDiff[] {
  const up = (m: Map<string, ColumnsResult>) => new Map([...m].map(([k, v]) => [k.toUpperCase(), { name: k, v }]));
  const L = up(left), R = up(right);
  const out: TableDiff[] = [];
  for (const [k, l] of L) {
    const r = R.get(k);
    if (!r) { out.push({ name: l.name, status: 'onlyLeft', columns: [] }); continue; }
    const lc = new Map(l.v.columns.map((c) => [c.name.toUpperCase(), c])), rc = new Map(r.v.columns.map((c) => [c.name.toUpperCase(), c]));
    const cols: TableDiff['columns'] = [];
    for (const [ck, c] of lc) { const o = rc.get(ck); if (!o) cols.push({ name: c.name, change: 'removed', left: colSig(c) }); else if (colSig(c) !== colSig(o)) cols.push({ name: c.name, change: 'changed', left: colSig(c), right: colSig(o) }); }
    for (const [ck, c] of rc) if (!lc.has(ck)) cols.push({ name: c.name, change: 'added', right: colSig(c) });
    const lpk = l.v.primaryKey.join(', ').toUpperCase(), rpk = r.v.primaryKey.join(', ').toUpperCase();
    const pk = lpk !== rpk ? { left: l.v.primaryKey.join(', '), right: r.v.primaryKey.join(', ') } : undefined;
    out.push({ name: l.name, status: cols.length || pk ? 'changed' : 'same', columns: cols, ...(pk ? { pk } : {}) });
  }
  for (const [k, r] of R) if (!L.has(k)) out.push({ name: r.name, status: 'onlyRight', columns: [] });
  const rank = { changed: 0, onlyLeft: 1, onlyRight: 2, same: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

/** Line diff (LCS) for the DDL side-by-side view. */
export function lineDiff(a: string[], b: string[]): Array<{ op: ' ' | '-' | '+'; text: string }> {
  const n = Math.min(a.length, 2000), m = Math.min(b.length, 2000);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<{ op: ' ' | '-' | '+'; text: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i]! }); i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: '-', text: a[i++]! }); else out.push({ op: '+', text: b[j++]! });
  }
  while (i < n) out.push({ op: '-', text: a[i++]! });
  while (j < m) out.push({ op: '+', text: b[j++]! });
  return out;
}

const MAX_COMPARE = 400;

function SideSelect({ label, value, onChange }: { label: string; value: SideSel; onChange: (v: SideSel) => void }) {
  const db = useTableDb();
  const conn = db.connections.find((c) => c.id === value.connId) ?? null;
  useStoreVersion(conn);
  useEffect(() => { if (conn) void conn.store.loadCatalogs().then((c) => (c && c.length === 0 ? conn.store.loadSchemas(undefined) : undefined)); }, [conn]);
  const cats = conn?.store.catalogs()?.value ?? [];
  useEffect(() => { if (conn && cats.length) void conn.store.loadSchemas(value.catalog || cats[0]); }, [conn, value.catalog, cats.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const schemas = conn?.store.schemas(cats.length ? value.catalog || cats[0] : undefined)?.value ?? [];
  return (
    <fieldset className="ui-col" style={{ gap: 4, border: '1px solid var(--ui-border)', borderRadius: 6, padding: 8, minWidth: 0 }}>
      <legend className="ui-label">{label}</legend>
      <select className="ui-select" aria-label={`${label}: ${t('tabledb.connection')}`} value={value.connId} onChange={(e) => onChange({ connId: e.target.value, catalog: '', schema: '' })}>
        {db.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {cats.length > 0 && <select className="ui-select" aria-label={`${label}: catalog`} value={value.catalog || cats[0]} onChange={(e) => onChange({ ...value, catalog: e.target.value, schema: '' })}>{cats.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
      <select className="ui-select" aria-label={`${label}: schema`} value={value.schema} onChange={(e) => onChange({ ...value, schema: e.target.value })}>
        <option value="">{t('common.choose')}</option>
        {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </fieldset>
  );
}

export function SchemaCompareDialog({ onClose }: { onClose: () => void }) {
  const db = useTableDb();
  const toast = useToast();
  const first = db.activeConn?.id ?? db.connections[0]?.id ?? '';
  const [left, setLeft] = useState<SideSel>({ connId: first, catalog: '', schema: db.activeConn?.currentSchema ?? '' });
  const [right, setRight] = useState<SideSel>({ connId: db.connections.find((c) => c.id !== first)?.id ?? first, catalog: '', schema: '' });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<TableDiff[] | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [showSame, setShowSame] = useState(false);
  const [ddl, setDdl] = useState<{ left: string; right: string } | null>(null);
  const stop = useRef(false);
  const connOf = (s: SideSel) => db.connections.find((c) => c.id === s.connId) ?? null;
  const catOf = (c: Connection, s: SideSel) => { const cats = c.store.catalogs()?.value ?? []; return cats.length ? s.catalog || cats[0] : undefined; };

  const loadSide = async (s: SideSel, tick: () => void) => {
    const c = connOf(s)!;
    const cat = catOf(c, s);
    const tables = ((await c.store.loadTables(cat, s.schema)) ?? []).filter((x) => !/view/i.test(x.type)).slice(0, MAX_COMPARE);
    const out = new Map<string, ColumnsResult>();
    const queue = [...tables];
    const worker = async () => { while (queue.length && !stop.current) { const tb = queue.shift()!; const m = await c.store.loadColumns({ catalog: cat, schema: s.schema, name: tb.name }); if (m) out.set(tb.name, m); tick(); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { out, count: tables.length };
  };
  const compare = async () => {
    const lc = connOf(left), rc = connOf(right);
    if (!lc || !rc || !left.schema || !right.schema) return;
    stop.current = false; setError(''); setResult(null); setPick(null); setDdl(null);
    let done = 0;
    setProgress({ done: 0, total: 0 });
    try {
      const lt = (await lc.store.loadTables(catOf(lc, left), left.schema)) ?? [];
      const rt = (await rc.store.loadTables(catOf(rc, right), right.schema)) ?? [];
      const total = Math.min(MAX_COMPARE, lt.length) + Math.min(MAX_COMPARE, rt.length);
      setProgress({ done: 0, total });
      const tick = () => { done++; setProgress({ done, total }); };
      const [L, R] = await Promise.all([loadSide(left, tick), loadSide(right, tick)]);
      if (L.count >= MAX_COMPARE || R.count >= MAX_COMPARE) toast.push(t('sc.capped', { n: MAX_COMPARE }), 'warning');
      setResult(diffSchemas(L.out, R.out));
    } catch (e) { setError(friendlyDbError(e).detail || (e as Error).message); }
    finally { setProgress(null); }
  };
  const sel = result?.find((x) => x.name === pick) ?? null;
  const loadDdl = async (name: string) => {
    const lc = connOf(left)!, rc = connOf(right)!;
    const ref = (c: Connection, s: SideSel) => ({ catalog: catOf(c, s), schema: s.schema, name });
    try {
      const [a, b] = await Promise.all([lc.store.loadDdl(ref(lc, left), true), rc.store.loadDdl(ref(rc, right), true)]);
      setDdl({ left: a ?? '', right: b ?? '' });
    } catch (e) { toast.push((e as Error).message, 'error'); }
  };
  const report = () => {
    if (!result) return;
    const lines = [`# ${t('sc.title')}`, '', `- A: ${connOf(left)?.name} / ${left.schema}`, `- B: ${connOf(right)?.name} / ${right.schema}`, ''];
    for (const d of result.filter((x) => x.status !== 'same')) {
      lines.push(`## ${d.name} — ${t(`sc.st.${d.status}`)}`);
      for (const c of d.columns) lines.push(`- ${c.name}: ${t(`sc.col.${c.change}`)}${c.left ? ` A=\`${c.left}\`` : ''}${c.right ? ` B=\`${c.right}\`` : ''}`);
      if (d.pk) lines.push(`- PK: A=(${d.pk.left}) B=(${d.pk.right})`);
      lines.push('');
    }
    downloadText(`schema-compare_${left.schema}_${right.schema}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
  };
  const counts = useMemo(() => ({ changed: result?.filter((x) => x.status === 'changed').length ?? 0, onlyLeft: result?.filter((x) => x.status === 'onlyLeft').length ?? 0, onlyRight: result?.filter((x) => x.status === 'onlyRight').length ?? 0, same: result?.filter((x) => x.status === 'same').length ?? 0 }), [result]);
  const tone = { changed: 'warning', onlyLeft: 'danger', onlyRight: 'info', same: 'success' } as const;

  return (
    <Dialog open wide title={t('sc.title')} onClose={() => { stop.current = true; onClose(); }}
      footer={<>
        <Button disabled={!result} onClick={report}>{t('sc.report')}</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={() => { stop.current = true; onClose(); }}>{t('common.close')}</Button>
        <Button variant="primary" loading={!!progress} disabled={!left.schema || !right.schema} onClick={() => void compare()}>{t('sc.go')}</Button>
      </>}>
      {db.connections.length === 0 ? <div className="ui-muted">{t('sc.noConn')}</div> : (
        <div className="ui-col" style={{ gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <SideSelect label="A" value={left} onChange={setLeft} />
            <SideSelect label="B" value={right} onChange={setRight} />
          </div>
          {progress && <div className="ui-row" role="status"><Spinner label="" /> {t('sc.loading', { a: progress.done, b: progress.total })}</div>}
          {error && <div className="ui-error-text" role="alert">{error}</div>}
          {result && (
            <>
              <div className="ui-row" style={{ flexWrap: 'wrap' }} role="status">
                {(['changed', 'onlyLeft', 'onlyRight', 'same'] as const).map((k) => <Badge key={k} tone={tone[k]}>{t(`sc.st.${k}`)}: {counts[k]}</Badge>)}
                <Checkbox label={t('sc.showSame')} checked={showSame} onChange={(e) => setShowSame(e.target.checked)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) 2fr', gap: 8, minHeight: 280 }}>
                <div role="listbox" aria-label={t('sc.title')} style={{ overflow: 'auto', maxHeight: '48vh', border: '1px solid var(--ui-border)', borderRadius: 6 }}>
                  {result.filter((x) => showSame || x.status !== 'same').map((d) => (
                    <div key={d.name} role="option" aria-selected={pick === d.name} tabIndex={0} className={`tb-list__item${pick === d.name ? ' is-selected' : ''}`} onClick={() => { setPick(d.name); setDdl(null); }}>
                      <Badge tone={tone[d.status]}>{t(`sc.st.${d.status}`)}</Badge> <span className="ui-mono">{d.name}</span>
                      {d.columns.length > 0 && <span className="ui-muted"> · {t('sc.nCols', { n: d.columns.length })}</span>}
                    </div>
                  ))}
                  {result.every((x) => x.status === 'same') && <div className="ui-muted" style={{ padding: 8 }}>{t('sc.identical')}</div>}
                </div>
                <div style={{ minWidth: 0, overflow: 'auto', maxHeight: '48vh' }}>
                  {sel && (
                    <div className="ui-col" style={{ gap: 6 }}>
                      <strong className="ui-mono">{sel.name}</strong>
                      {sel.pk && <div>PK: A=({sel.pk.left}) · B=({sel.pk.right})</div>}
                      {sel.columns.length > 0 && (
                        <table className="ui-table">
                          <thead><tr><th scope="col">{t('tree.col')}</th><th scope="col">{t('sc.change')}</th><th scope="col">A</th><th scope="col">B</th></tr></thead>
                          <tbody>{sel.columns.map((c) => <tr key={c.name}><td className="ui-mono">{c.name}</td><td>{t(`sc.col.${c.change}`)}</td><td className="ui-mono">{c.left ?? ''}</td><td className="ui-mono">{c.right ?? ''}</td></tr>)}</tbody>
                        </table>
                      )}
                      {sel.status !== 'onlyLeft' && sel.status !== 'onlyRight' && <Button size="sm" onClick={() => void loadDdl(sel.name)}>{t('sc.ddl')}</Button>}
                      {ddl && (
                        <pre className="ui-mono" style={{ margin: 0, fontSize: 12, background: 'var(--ui-surface-2)', padding: 8, borderRadius: 6 }}>
                          {lineDiff(ddl.left.split('\n'), ddl.right.split('\n')).map((l, i) => <div key={i} className={l.op === '-' ? 'sc-del' : l.op === '+' ? 'sc-add' : undefined}>{l.op} {l.text}</div>)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
          <div className="ui-muted" style={{ fontSize: 12 }}>{t('sc.note', { n: MAX_COMPARE })}</div>
        </div>
      )}
    </Dialog>
  );
}
