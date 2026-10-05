import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useToast } from '@vnpay/ui';
import { classifySql, type SqlClassification } from '@vnpay/shared';
import type { BindValue, QueryResult } from '../../gateway';
import { uid } from '../../lib';
import { t } from '../../i18n';
import { auditReporter, type AuditReporter } from './audit';
import { closeConnection } from './connect';
import { findCrossDatabase } from './crossDb';
import { friendlyDbError, type FriendlyError } from './dbErrors';
import { reportTx, runWriteBatch, type WriteBatchResult } from './exec';
import { decideRun } from './runGate';
import { errorOffset, findBinds, splitStatements, type Stmt } from './sqlSplit';
import type { AgentRowsAttachment, Connection, EditorTabState, OutputState, QueryOutput, ScriptLogEntry, SelectedTable } from './types';
import { tableKey, type TableRef } from './schemaStore';
import { tableDataSql } from './tableSql';
import { addHistory, loadTabs, remapContextProfiles, saveTabs } from './workspace';

export type WriteDecision = 'run' | 'skip' | 'stop';
export interface PendingWrite {
  tabId: string; sql: string; classification: SqlClassification; newOutput?: boolean;
  /** editor offset of the statement, values for its :name placeholders and the SQL actually sent (with `?`) */
  from?: number; params?: BindValue[]; bindNames?: string[]; sendSql?: string;
  /** script run: position of the statement; the dialog then offers Skip / Stop and resolves the run's promise */
  script?: { index: number; total: number };
  resolve?: (d: WriteDecision) => void;
}
export interface PendingBinds { names: string[]; values: Record<string, BindValue>; sql: string; resolve: (v: Record<string, BindValue> | null) => void }
export interface RunRequest {
  /** append a result tab instead of refilling the active one */
  newOutput?: boolean;
  /** text to run (a statement, the selection or the whole buffer); default: the whole tab */
  sql?: string;
  /** offset of `sql` in the editor buffer */
  from?: number;
}

export interface TableDbApi {
  connections: Connection[];
  activeConn: Connection | null;
  setActiveConn: (id: string) => void;
  addConnection: (c: Connection) => void;
  /** closes the session; with pending changes in manual-commit mode it asks first (unless `force`) */
  removeConnection: (id: string, force?: boolean) => Promise<void>;
  /** reopen the session with the same request (network/session only, no dialog); throws when the endpoint is still unreachable */
  reconnectConnection: (id: string) => Promise<void>;
  updateConnection: (id: string, patch: Partial<Connection>) => void;
  /** saved connections were merged (old id → kept id): tabs and open connections follow the kept entry */
  remapProfiles: (moved: Map<string, string>) => void;
  tabs: EditorTabState[];
  activeTab: EditorTabState | null;
  setActiveTab: (id: string) => void;
  newTab: (sql?: string, opts?: { title?: string; fileName?: string; schema?: string; catalog?: string; connId?: string }) => string;
  closeTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<EditorTabState>) => void;
  selected: SelectedTable[];
  setSelected: (s: SelectedTable[]) => void;
  insertSql: (sql: string) => void;
  /** run SQL of a tab: one statement, or several as a script (each gated and confirmed on its own) */
  run: (tabId: string, opts?: RunRequest) => Promise<void>;
  /** execution plan of one statement into a new result tab */
  explain: (tabId: string, opts?: RunRequest) => Promise<void>;
  /** re-run the (read) statement of an output in place */
  refreshOutput: (tabId: string, outputId: string) => Promise<void>;
  patchOutput: (tabId: string, outputId: string, patch: Partial<OutputState>) => void;
  setActiveOutput: (tabId: string, outputId: string) => void;
  closeOutput: (tabId: string, outputId: string) => void;
  cancel: (tabId: string) => Promise<void>;
  loadMore: (tabId: string, outputId?: string) => Promise<void>;
  loadAll: (tabId: string, outputId?: string) => Promise<QueryOutput | undefined>;
  /** open (or focus) the data view tab of a table and query its first page */
  openTable: (ref: TableRef, filter?: string) => void;
  /** re-query a table data view with a new WHERE condition */
  setTableFilter: (tabId: string, filter: string) => Promise<void>;
  /** re-query a table data view with a server-side ORDER BY (null = none) */
  setTableSort: (tabId: string, orderBy: { column: string; desc: boolean } | null) => Promise<void>;
  pendingWrite: PendingWrite | null;
  confirmWrite: () => Promise<void>;
  /** script run: skip the statement awaiting confirmation */
  skipWrite: () => void;
  dismissWrite: () => void;
  pendingBinds: PendingBinds | null;
  resolveBinds: (values: Record<string, BindValue> | null) => void;
  pendingDisconnect: Connection | null;
  resolveDisconnect: (action: 'commit' | 'rollback' | 'cancel') => Promise<void>;
  setAutoCommit: (connId: string, autoCommit: boolean) => Promise<boolean>;
  commit: (connId: string) => Promise<boolean>;
  rollback: (connId: string) => Promise<boolean>;
  setSchema: (connId: string, schema: string) => Promise<void>;
  /** several write statements (table edits, imports); `atomic` commits all or rolls back all */
  runWrites: (connId: string, stmts: string[], opts: { atomic: boolean; onProgress?: (done: number) => void; stop?: () => boolean }) => Promise<WriteBatchResult>;
  agentRows: AgentRowsAttachment | null;
  setAgentRows: (r: AgentRowsAttachment | null) => void;
}

const Ctx = createContext<TableDbApi | null>(null);
export const useTableDb = () => { const c = useContext(Ctx); if (!c) throw new Error('TableDbProvider missing'); return c; };
export { Ctx as TableDbContext };

const PAGE = 500;
/** table data views fetch smaller pages (fast first paint) and keep fetching while the user scrolls, like DBeaver */
const TABLE_PAGE = 200;
const TABLE_MAX_ROWS = 100_000; // sidecar cap
const MAX_OUTPUTS = 10;
const activeOutputOf = (tab: EditorTabState) => tab.outputs.find((o) => o.id === tab.activeOutputId) ?? tab.outputs[tab.outputs.length - 1];
const pageOf = (tab: EditorTabState) => (tab.kind === 'table' ? TABLE_PAGE : PAGE);
let tabSeq = 0;
const mkTab = (conn: Connection | null, sql = '', extra: Partial<EditorTabState> = {}): EditorTabState => ({
  id: uid(), title: t('tabledb.tabTitle', { n: ++tabSeq }), connId: conn?.id ?? null, ...(conn?.profileId ? { profileId: conn.profileId } : {}),
  sql, mode: 'read', maxRows: 1000, timeoutSec: 60, running: false, kind: 'sql', outputs: [], outputSeq: 0, ...extra,
});
const mkTableTab = (conn: Connection, ref: TableRef, filter = ''): EditorTabState => ({
  id: uid(), title: ref.name, connId: conn.id, sql: tableDataSql(ref, conn.driver, filter), mode: 'read', maxRows: TABLE_MAX_ROWS, timeoutSec: 60, running: false,
  kind: 'table', table: ref, filter, view: 'grid', outputs: [], outputSeq: 0,
});
/** tabs of the previous run (text only, not connected yet) */
const restoredTabs = (): EditorTabState[] => loadTabs().map((s) => ({ ...mkTab(null, s.sql), title: s.title, ...(s.profileId ? { profileId: s.profileId } : {}), ...(s.fileName ? { fileName: s.fileName } : {}), ...(s.schema ? { schema: s.schema } : {}), ...(s.catalog ? { catalog: s.catalog } : {}), maxRows: s.maxRows, timeoutSec: s.timeoutSec }));

interface ExecSpec {
  /** statement as written (audit, history, dialogs) */
  sql: string;
  /** what is sent: `sql` with :name → ? */
  sendSql?: string;
  params?: BindValue[];
  from?: number;
  mode: 'read' | 'write';
  confirm: boolean;
  /** output to fill; null = none (script writes: the log records the outcome) */
  outId: string | null;
  /** script runs keep the tab's running flag until the end */
  keepRunning?: boolean;
}
interface ExecOutcome { ok: boolean; cancelled?: boolean; result?: QueryResult; error?: FriendlyError }

export function TableDbProvider({ children, writeAllowedOverride, audit = auditReporter }: { children: ReactNode; writeAllowedOverride?: boolean; audit?: Pick<AuditReporter, 'report'> }) {
  const toast = useToast();
  const auditRef = useRef(audit); auditRef.current = audit;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<EditorTabState[]>(restoredTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null);
  const [selectedBy, setSelectedBy] = useState<Record<string, SelectedTable[]>>({});
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);
  const [pendingBinds, setPendingBinds] = useState<PendingBinds | null>(null);
  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(null);
  const [agentRows, setAgentRows] = useState<AgentRowsAttachment | null>(null);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const connsRef = useRef(connections); connsRef.current = connections;
  const scriptStop = useRef<Record<string, boolean>>({});

  const activeConn = connections.find((c) => c.id === activeConnId) ?? null;
  const activeTab = tabs.find((x) => x.id === activeTabId) ?? null;

  // The query tab in front decides the active connection (and thus the Agent context); picking a connection in the tree afterwards still works.
  const activeTabConnId = activeTab?.connId ?? null;
  useEffect(() => {
    if (activeTabConnId && connsRef.current.some((c) => c.id === activeTabConnId)) setActiveConnId(activeTabConnId);
  }, [activeTabId, activeTabConnId]);

  // SQL tabs (text only) survive a restart; table data views are reopened from the tree
  useEffect(() => {
    saveTabs(tabs.filter((x) => x.kind !== 'table').map((x) => ({
      title: x.title, sql: x.sql, maxRows: x.maxRows, timeoutSec: x.timeoutSec, ...(x.profileId ? { profileId: x.profileId } : {}), ...(x.fileName ? { fileName: x.fileName } : {}), ...(x.schema ? { schema: x.schema } : {}), ...(x.catalog ? { catalog: x.catalog } : {}),
    })));
  }, [tabs]);

  const updateTab = useCallback((id: string, patch: Partial<EditorTabState>) => {
    tabsRef.current = tabsRef.current.map((x) => (x.id === id ? { ...x, ...patch } : x));
    setTabs((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  const updateConnection = useCallback((id: string, patch: Partial<Connection>) => {
    // Connection objects are shared by reference (tree, dialogs): update in place, then publish a new array
    const c = connsRef.current.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, patch);
    setConnections((l) => [...l]);
  }, []);

  const remapProfiles = useCallback((moved: Map<string, string>) => {
    if (moved.size === 0) return;
    remapContextProfiles(moved);
    for (const c of connsRef.current) if (c.profileId && moved.has(c.profileId)) c.profileId = moved.get(c.profileId);
    setConnections((l) => [...l]);
    const next = tabsRef.current.map((x) => (x.profileId && moved.has(x.profileId) ? { ...x, profileId: moved.get(x.profileId) } : x));
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const newTab = useCallback((sql = '', opts?: { title?: string; fileName?: string; schema?: string; catalog?: string; connId?: string }) => {
    const conn = connsRef.current.find((c) => c.id === (opts?.connId ?? activeConnId)) ?? null;
    const schema = opts?.schema ?? conn?.currentSchema ?? conn?.defaultSchema ?? null;
    const tab = mkTab(conn, sql, { ...(opts?.title ? { title: opts.title } : {}), ...(opts?.fileName ? { fileName: opts.fileName } : {}), ...(schema ? { schema } : {}), ...(opts?.catalog ? { catalog: opts.catalog } : {}) });
    tabsRef.current = [...tabsRef.current, tab];
    setTabs((l) => [...l, tab]);
    setActiveTabId(tab.id);
    return tab.id;
  }, [activeConnId]);

  const addConnection = useCallback((c: Connection) => {
    c.tx ??= { autoCommit: true, pending: false };
    c.api.onLost = () => {
      updateConnection(c.id, { lost: true });
      toast.push(t('tabledb.sessionLost', { name: c.name }), 'error');
    };
    setConnections((l) => [...l, c]);
    setActiveConnId(c.id);
    setSelectedBy((s) => ({ ...s, [c.id]: [] }));
    if (tabsRef.current.length === 0) {
      const tab = mkTab(c);
      tabsRef.current = [tab];
      setTabs([tab]);
      setActiveTabId(tab.id);
    } else {
      // restored/unbound tabs: those of this saved connection, and those that belong to none
      const bind = (x: EditorTabState) => !x.connId && (x.profileId ? x.profileId === c.profileId : true);
      const next = tabsRef.current.map((x) => (bind(x) ? { ...x, connId: c.id, ...(c.profileId ? { profileId: c.profileId } : {}) } : x));
      tabsRef.current = next;
      setTabs(next);
    }
  }, [toast, updateConnection]); // eslint-disable-line react-hooks/exhaustive-deps

  const doRemove = useCallback(async (id: string) => {
    const c = connsRef.current.find((x) => x.id === id);
    if (c) await closeConnection(c, auditRef.current);
    setConnections((l) => l.filter((x) => x.id !== id));
    setActiveConnId((cur) => (cur === id ? connsRef.current.find((x) => x.id !== id)?.id ?? null : cur));
    setTabs((l) => l.map((x) => (x.connId === id ? { ...x, connId: null, running: false, script: undefined, outputs: x.outputs.map((o) => ({ ...o, running: false })) } : x)));
  }, []);

  const removeConnection = useCallback(async (id: string, force = false) => {
    const c = connsRef.current.find((x) => x.id === id);
    if (!force && c?.tx?.pending) { setPendingDisconnectId(id); return; }
    await doRemove(id);
  }, [doRemove]);

  const reconnectConnection = useCallback(async (id: string) => {
    const c = connsRef.current.find((x) => x.id === id);
    if (!c) return;
    await c.api.reconnectNow();
    c.store.clear();
    updateConnection(id, { lost: false, tx: { autoCommit: c.info.autoCommit ?? true, pending: false } });
  }, [updateConnection]);

  const closeTab = useCallback((id: string) => {
    const tab = tabsRef.current.find((x) => x.id === id);
    const conn = connsRef.current.find((c) => c.id === tab?.connId);
    if (conn) for (const o of tab?.outputs ?? []) if (o.result?.cursorId) void conn.api.closeCursor(o.result.cursorId).catch(() => {});
    scriptStop.current[id] = true;
    const rest = tabsRef.current.filter((x) => x.id !== id);
    tabsRef.current = rest;
    setTabs(rest);
    setActiveTabId((cur) => (cur === id ? rest[rest.length - 1]?.id ?? null : cur));
  }, []);

  const connFor = (tab: EditorTabState) => connsRef.current.find((c) => c.id === tab.connId) ?? null;
  const tabOf = (id: string) => tabsRef.current.find((x) => x.id === id);

  const setOutputs = useCallback((tabId: string, f: (tab: EditorTabState) => Partial<EditorTabState>) => {
    const apply = (l: EditorTabState[]) => l.map((x) => (x.id !== tabId ? x : { ...x, ...f(x) }));
    tabsRef.current = apply(tabsRef.current);
    setTabs(apply);
  }, []);

  const patchOutput = useCallback((tabId: string, outId: string, patch: Partial<OutputState>) =>
    setOutputs(tabId, (x) => ({ outputs: x.outputs.map((o) => (o.id === outId ? { ...o, ...patch } : o)) })), [setOutputs]);

  const closeCursorOf = (conn: Connection | null, o: OutputState) => { if (o.result?.cursorId && conn) void conn.api.closeCursor(o.result.cursorId).catch(() => {}); };

  /**
   * Pick the output a run reports into (the active one unless it is pinned, or a fresh one) and make it active;
   * `reset` clears it for the new statement.
   */
  const ensureOutput = useCallback((tab: EditorTabState, fresh: boolean, reset: boolean, sql?: string, title?: string): string => {
    const cur = tabOf(tab.id) ?? tab;
    const conn = connFor(cur);
    const active = activeOutputOf(cur);
    const target = fresh || active?.pinned ? undefined : active;
    if (target) {
      if (reset) closeCursorOf(conn, target);
      setOutputs(tab.id, (x) => ({
        activeOutputId: target.id,
        outputs: reset ? x.outputs.map((o) => (o.id === target.id ? { id: o.id, title: o.title, sql: sql ?? tab.sql, ...(o.refreshSec ? { refreshSec: o.refreshSec } : {}) } : o)) : x.outputs,
      }));
      return target.id;
    }
    const out: OutputState = { id: uid(), title: title ?? t('output.title', { n: cur.outputSeq + 1 }), sql: sql ?? tab.sql };
    setOutputs(tab.id, (x) => {
      let all = [...x.outputs, out];
      // trim the oldest unpinned outputs beyond the cap
      while (all.length > MAX_OUTPUTS) {
        const i = all.findIndex((o) => !o.pinned && !o.running && o.id !== out.id);
        if (i < 0) break;
        closeCursorOf(conn, all[i]!);
        all = all.filter((_, k) => k !== i);
      }
      return { outputSeq: x.outputSeq + 1, outputs: all, activeOutputId: out.id };
    });
    return out.id;
  }, [setOutputs]); // eslint-disable-line react-hooks/exhaustive-deps

  const setActiveOutput = useCallback((tabId: string, outputId: string) => updateTab(tabId, { activeOutputId: outputId }), [updateTab]);

  const closeOutput = useCallback((tabId: string, outputId: string) => {
    const tab = tabOf(tabId);
    const out = tab?.outputs.find((o) => o.id === outputId);
    if (!tab || !out || out.running) return;
    closeCursorOf(connFor(tab), out);
    const rest = tab.outputs.filter((o) => o.id !== outputId);
    updateTab(tabId, { outputs: rest, activeOutputId: tab.activeOutputId === outputId ? rest[rest.length - 1]?.id : tab.activeOutputId });
  }, [updateTab]); // eslint-disable-line react-hooks/exhaustive-deps

  /** report a client-side failure (no connection / gate rejection) in the target output, keeping its previous result */
  const failInto = useCallback((tab: EditorTabState, newOutput: boolean, error: NonNullable<OutputState['error']>) => {
    const id = ensureOutput(tab, newOutput, false);
    patchOutput(tab.id, id, { error });
  }, [ensureOutput, patchOutput]);

  const syncTx = (conn: Connection, r: { autoCommit?: boolean; txPending?: boolean }) => {
    if (r.autoCommit === undefined) return;
    const next = { autoCommit: r.autoCommit, pending: !!r.txPending };
    if (conn.tx?.autoCommit !== next.autoCommit || conn.tx?.pending !== next.pending) updateConnection(conn.id, { tx: next });
  };

  /** The session schema is shared by all tabs of a connection: switch it to the one this query is bound to. */
  const bindSchema = async (tab: EditorTabState, conn: Connection) => {
    if (tab.kind === 'table' || !tab.schema || conn.currentSchema === tab.schema) return;
    const s = await conn.api.setSchema(tab.schema);
    updateConnection(conn.id, { currentSchema: s ?? tab.schema });
  };

  /** database (catalog) a query tab is bound to: the one picked in the tree, else the connection's only database */
  const boundDbOf = (tab: EditorTabState, conn: Connection): string | null => {
    const cats = conn.store.catalogs()?.value ?? [];
    return tab.catalog ?? (cats.length === 1 ? cats[0]! : null);
  };
  /** a query tab is bound to one database: statements reaching into another database are refused (other schemas are fine) */
  const crossDbOf = (tab: EditorTabState, conn: Connection, sql: string): string | null => {
    if (tab.kind === 'table') return null;
    const bound = boundDbOf(tab, conn);
    if (!bound) return null;
    return findCrossDatabase(sql, bound, conn.store.catalogs()?.value ?? [], conn.store.schemas(bound)?.value ?? []);
  };

  const exec = useCallback(async (tab: EditorTabState, conn: Connection, spec: ExecSpec): Promise<ExecOutcome> => {
    const queryId = uid();
    const outId = spec.outId;
    updateTab(tab.id, { running: true, queryId });
    if (outId) patchOutput(tab.id, outId, { running: true, sql: spec.sql, mode: spec.mode, ...(spec.from !== undefined ? { sqlFrom: spec.from } : {}), ...(spec.params ? { params: spec.params } : {}) });
    const started = Date.now();
    const kind = classifySql(spec.sql).kind;
    // Audit record for this execution (raw SQL: the server masks literals). Counts/timing only, never row data.
    const auditQuery = (ok: boolean, extra: { rows?: number; ms?: number; errorCode?: string }) =>
      auditRef.current.report({ ...(conn.custom ? { custom: conn.custom } : { targetId: conn.targetId }), mode: spec.mode, kind, sql: spec.sql, ok, ...extra });
    const history = (ok: boolean, extra: { rows?: number; ms?: number; errorCode?: string }) => {
      if (tab.kind !== 'table') addHistory({ sql: spec.sql, connName: conn.name, ...(conn.profileId ? { profileId: conn.profileId } : {}), driver: conn.driverName ?? conn.driver, mode: spec.mode, ok, ...extra });
    };
    const done = () => { if (!spec.keepRunning) updateTab(tab.id, { running: false, queryId: undefined }); else updateTab(tab.id, { queryId: undefined }); };
    try {
      await bindSchema(tab, conn);
      const r = await conn.api.execute({
        queryId, sql: spec.sendSql ?? spec.sql, mode: spec.mode, ...(spec.confirm ? { confirmWrite: true } : {}),
        maxRows: tab.maxRows, timeoutSec: tab.timeoutSec, pageSize: pageOf(tab),
        ...(spec.params?.length ? { params: spec.params } : {}),
        ...(tab.serverOutput && conn.driver === 'oracle' ? { serverOutput: true } : {}),
      });
      const rows = r.updateCount ?? r.rowCount ?? r.rows?.length ?? 0;
      const ms = r.elapsedMs ?? Date.now() - started;
      auditQuery(true, { rows, ms });
      history(true, { rows, ms });
      syncTx(conn, r);
      done();
      const extraMsgs = (r.moreResults ?? []).filter((m) => !m.columns?.length && m.updateCount !== undefined).map((m) => t('result.moreUpdate', { n: m.updateCount! }));
      const messages = [...(r.messages ?? []), ...extraMsgs];
      if (outId) {
        patchOutput(tab.id, outId, {
          running: false,
          result: {
            kind: r.kind, columns: r.columns, rows: r.rows ?? [], hasMore: r.hasMore, cursorId: r.cursorId, updateCount: r.updateCount, truncated: r.truncated, elapsedMs: r.elapsedMs,
            ...(messages.length ? { messages } : {}), ...(r.serverOutput?.length ? { serverOutput: r.serverOutput } : {}),
          },
        });
      }
      // further result sets of the same statement (procedure calls, Oracle implicit results): one static tab each
      (r.moreResults ?? []).filter((m) => m.columns?.length).forEach((m, i) => {
        const id = ensureOutput(tab, true, false, spec.sql, `${t('output.more', { n: i + 2 })}`);
        patchOutput(tab.id, id, { mode: spec.mode, result: { kind: 'read', columns: m.columns, rows: m.rows ?? [], hasMore: false, truncated: !!m.truncated, elapsedMs: 0 } });
      });
      if (outId && (r.moreResults ?? []).some((m) => m.columns?.length)) updateTab(tab.id, { activeOutputId: outId });
      return { ok: true, result: r };
    } catch (e) {
      const f = friendlyDbError(e);
      auditQuery(false, { ms: Date.now() - started, errorCode: f.code });
      history(false, { ms: Date.now() - started, errorCode: f.code });
      // manual commit: a failed write may still leave the transaction open
      if (spec.mode === 'write' && conn.tx && !conn.tx.autoCommit && !conn.tx.pending) updateConnection(conn.id, { tx: { autoCommit: false, pending: true } });
      done();
      const off = !f.cancelled && spec.from !== undefined && !spec.params?.length ? errorOffset(f.detail, spec.sql) : null;
      if (outId) patchOutput(tab.id, outId, { running: false, cancelled: f.cancelled, error: f.cancelled ? null : f, ...(off !== null ? { errorPos: spec.from! + off } : {}) });
      return { ok: false, cancelled: f.cancelled, error: f };
    }
  }, [updateTab, ensureOutput, patchOutput, updateConnection]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ interactive prompts (binds, write confirmation in scripts)

  const askBinds = useCallback((tab: EditorTabState, names: string[], sql: string) => new Promise<Record<string, BindValue> | null>((resolve) => {
    const unique = [...new Set(names)];
    const prev = tabOf(tab.id)?.binds ?? {};
    const values = Object.fromEntries(unique.map((n) => [n, prev[n] ?? { type: 'string', value: '' } as BindValue]));
    setPendingBinds({ names: unique, values, sql, resolve: (v) => { setPendingBinds(null); if (v) updateTab(tab.id, { binds: { ...(tabOf(tab.id)?.binds ?? {}), ...v } }); resolve(v); } });
  }), [updateTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveBinds = useCallback((v: Record<string, BindValue> | null) => { pendingBinds?.resolve(v); }, [pendingBinds]);

  /** `:name` placeholders → positional values (asks the user); null = cancelled. DDL (trigger bodies use :NEW) is sent as written. */
  const bindsFor = useCallback(async (tab: EditorTabState, stmt: string, kind: string) => {
    if (tab.kind === 'table' || kind === 'ddl') return { sendSql: undefined, params: undefined, names: [] as string[] };
    const scan = findBinds(stmt);
    if (scan.names.length === 0) return { sendSql: undefined, params: undefined, names: [] as string[] };
    const vals = await askBinds(tab, scan.names, stmt);
    if (!vals) return null;
    return { sendSql: scan.sql, params: scan.names.map((n) => vals[n]!), names: scan.names };
  }, [askBinds]);

  const askWrite = useCallback((p: Omit<PendingWrite, 'resolve'>) => new Promise<WriteDecision>((resolve) => {
    setPendingWrite({ ...p, resolve: (d) => { setPendingWrite(null); resolve(d); } });
  }), []);

  // ------------------------------------------------------------------ run

  const statementsOf = (tab: EditorTabState, conn: Connection, req?: RunRequest): Stmt[] => {
    const text = req?.sql ?? tab.sql;
    const base = req?.from ?? 0;
    if (tab.kind === 'table') return text.trim() ? [{ from: 0, to: text.length, text }] : [];
    return splitStatements(text, conn.driver).map((s) => ({ ...s, from: s.from + base, to: s.to + base }));
  };

  const runScript = useCallback(async (tab: EditorTabState, conn: Connection, stmts: Stmt[]) => {
    const writeAllowed = writeAllowedOverride ?? conn.allowWrite;
    scriptStop.current[tab.id] = false;
    const logId = ensureOutput(tab, true, true, stmts.map((s) => s.text).join(';\n'), t('script.title'));
    const log: ScriptLogEntry[] = [];
    patchOutput(tab.id, logId, { pinned: true, running: true, log: [] });
    const pushLog = (e: ScriptLogEntry) => { log.push(e); patchOutput(tab.id, logId, { log: [...log] }); };
    updateTab(tab.id, { running: true, script: { index: 0, total: stmts.length } });
    let failed = false;
    try {
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i]!;
        const entry = { index: i + 1, sql: s.text };
        if (scriptStop.current[tab.id]) { stmts.slice(i).forEach((x, k) => pushLog({ index: i + k + 1, sql: x.text, status: 'cancelled' })); break; }
        updateTab(tab.id, { script: { index: i + 1, total: stmts.length } });
        const cur = tabOf(tab.id) ?? tab;
        const foreign = crossDbOf(cur, conn, s.text);
        if (foreign) {
          pushLog({ ...entry, status: 'rejected', message: t('tabledb.reject.crossDb', { db: boundDbOf(cur, conn) ?? '', other: foreign }) });
          failed = true;
          break;
        }
        const d = decideRun(s.text, cur.mode, writeAllowed);
        if (d.action === 'reject') {
          pushLog({ ...entry, status: 'rejected', kind: d.classification.kind, message: t(`tabledb.reject.${d.reason}`) });
          failed = true;
          break;
        }
        const b = await bindsFor(cur, s.text, d.classification.kind);
        if (!b) { pushLog({ ...entry, status: 'cancelled' }); break; }
        let mode: 'read' | 'write' = 'read';
        if (d.action === 'confirm-write') {
          const dec = await askWrite({ tabId: tab.id, sql: s.text, classification: d.classification, from: s.from, params: b.params, bindNames: b.names, script: { index: i + 1, total: stmts.length } });
          if (dec === 'skip') { pushLog({ ...entry, status: 'skipped', kind: d.classification.kind }); continue; }
          if (dec === 'stop') { stmts.slice(i).forEach((x, k) => pushLog({ index: i + k + 1, sql: x.text, status: 'cancelled' })); break; }
          mode = 'write';
        }
        const outId = d.classification.kind === 'read' ? ensureOutput(cur, true, true, s.text) : null;
        const r = await exec(cur, conn, { sql: s.text, sendSql: b.sendSql, params: b.params, from: s.from, mode, confirm: mode === 'write', outId, keepRunning: true });
        // a non-read statement that returned rows (RETURNING …) still gets a result tab
        if (r.ok && !outId && r.result?.columns?.length) {
          const id = ensureOutput(cur, true, false, s.text);
          patchOutput(tab.id, id, { mode, result: { kind: r.result.kind, columns: r.result.columns, rows: r.result.rows ?? [], hasMore: false, truncated: r.result.truncated || r.result.hasMore, elapsedMs: r.result.elapsedMs } });
          if (r.result.cursorId) void conn.api.closeCursor(r.result.cursorId).catch(() => {});
        }
        pushLog({
          ...entry, kind: d.classification.kind, status: r.ok ? 'ok' : r.cancelled ? 'cancelled' : 'error', ms: r.result?.elapsedMs,
          ...(r.result?.updateCount !== undefined ? { updateCount: r.result.updateCount } : r.result ? { rows: r.result.rows?.length ?? 0 } : {}),
          ...(r.error ? { message: `${r.error.title}${r.error.detail ? ` — ${r.error.detail}` : ''}` } : {}),
        });
        if (!r.ok) { failed = !r.cancelled; break; }
      }
    } finally {
      patchOutput(tab.id, logId, { running: false });
      updateTab(tab.id, { running: false, queryId: undefined, script: undefined });
      if (failed) updateTab(tab.id, { activeOutputId: logId });
    }
  }, [ensureOutput, patchOutput, updateTab, exec, bindsFor, askWrite, writeAllowedOverride]);

  /** gate + execute a tab snapshot (callers that just changed the tab pass the new state) */
  const runWith = useCallback(async (tab: EditorTabState, newOutput = false, req?: RunRequest) => {
    const conn = connFor(tab);
    if (!conn) { failInto(tab, newOutput, { title: t('tabledb.noConnection'), detail: '', code: 'NO_CONN' }); return; }
    const stmts = statementsOf(tab, conn, req);
    if (stmts.length > 1) { await runScript(tab, conn, stmts); return; }
    const s = stmts[0] ?? { from: req?.from ?? 0, to: 0, text: req?.sql ?? tab.sql };
    const writeAllowed = writeAllowedOverride ?? conn.allowWrite;
    const foreign = crossDbOf(tab, conn, s.text);
    if (foreign) { failInto(tab, newOutput, { title: t('tabledb.reject.crossDb', { db: boundDbOf(tab, conn) ?? '', other: foreign }), detail: '', code: 'CLIENT_GATE' }); return; }
    const d = decideRun(s.text, tab.mode, writeAllowed);
    if (d.action === 'reject') {
      failInto(tab, newOutput, { title: t(`tabledb.reject.${d.reason}`), detail: d.reason === 'not-read' ? t('tabledb.reject.notReadDetail', { kind: d.classification.kind }) : '', code: 'CLIENT_GATE' });
      return;
    }
    const b = await bindsFor(tab, s.text, d.classification.kind);
    if (!b) return;
    if (d.action === 'confirm-write') {
      setPendingWrite({ tabId: tab.id, sql: s.text, classification: d.classification, newOutput, from: s.from, ...(b.params ? { params: b.params, bindNames: b.names, sendSql: b.sendSql } : {}) });
      return;
    }
    await exec(tab, conn, { sql: s.text, sendSql: b.sendSql, params: b.params, from: tab.kind === 'table' ? undefined : s.from, mode: 'read', confirm: false, outId: ensureOutput(tab, newOutput, true, s.text) });
  }, [exec, failInto, runScript, bindsFor, ensureOutput, writeAllowedOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async (tabId: string, opts?: RunRequest) => {
    const tab = tabOf(tabId);
    if (!tab || tab.running) return;
    await runWith(tab, !!opts?.newOutput, opts);
  }, [runWith]); // eslint-disable-line react-hooks/exhaustive-deps

  const explain = useCallback(async (tabId: string, opts?: RunRequest) => {
    const tab = tabOf(tabId);
    if (!tab || tab.running) return;
    const conn = connFor(tab);
    if (!conn) { failInto(tab, true, { title: t('tabledb.noConnection'), detail: '', code: 'NO_CONN' }); return; }
    const s = statementsOf(tab, conn, opts)[0];
    if (!s) { failInto(tab, false, { title: t('tabledb.reject.empty'), detail: '', code: 'CLIENT_GATE' }); return; }
    const foreign = crossDbOf(tab, conn, s.text);
    if (foreign) { failInto(tab, false, { title: t('tabledb.reject.crossDb', { db: boundDbOf(tab, conn) ?? '', other: foreign }), detail: '', code: 'CLIENT_GATE' }); return; }
    if (findBinds(s.text).names.length) { failInto(tab, false, { title: t('explain.noBinds'), detail: '', code: 'CLIENT_GATE' }); return; }
    const outId = ensureOutput(tab, true, true, s.text, t('explain.title'));
    updateTab(tabId, { running: true });
    patchOutput(tabId, outId, { running: true, sqlFrom: s.from });
    const started = Date.now();
    const report = (ok: boolean, errorCode?: string) => auditRef.current.report({ ...(conn.custom ? { custom: conn.custom } : { targetId: conn.targetId }), mode: 'read', kind: 'read', sql: `EXPLAIN ${s.text}`, ok, ms: Date.now() - started, ...(errorCode ? { errorCode } : {}) });
    try {
      await bindSchema(tab, conn);
      const plan = await conn.api.plan(s.text, tab.timeoutSec);
      report(true);
      patchOutput(tabId, outId, { running: false, plan });
    } catch (e) {
      const f = friendlyDbError(e);
      report(false, f.code);
      const off = errorOffset(f.detail, s.text);
      patchOutput(tabId, outId, { running: false, error: f, ...(off !== null ? { errorPos: s.from + off } : {}) });
    } finally { updateTab(tabId, { running: false }); }
  }, [ensureOutput, failInto, patchOutput, updateTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshOutput = useCallback(async (tabId: string, outputId: string) => {
    const tab = tabOf(tabId);
    const out = tab?.outputs.find((o) => o.id === outputId);
    const conn = tab && connFor(tab);
    if (!tab || !out || !conn || tab.running || out.running || out.plan || out.log) return;
    if (tab.kind === 'table') { await runWith(tab); return; }
    // only statements that are reads are ever re-run without the user pressing Run
    if (classifySql(out.sql).kind !== 'read') return;
    closeCursorOf(conn, out);
    setOutputs(tabId, (x) => ({ activeOutputId: x.activeOutputId, outputs: x.outputs.map((o) => (o.id === outputId ? { id: o.id, title: o.title, sql: o.sql, sqlFrom: o.sqlFrom, params: o.params, pinned: o.pinned, refreshSec: o.refreshSec } : o)) }));
    const scan = out.params?.length ? findBinds(out.sql) : null;
    await exec(tab, conn, { sql: out.sql, sendSql: scan?.sql, params: out.params, mode: 'read', confirm: false, outId: outputId });
  }, [runWith, setOutputs, exec]); // eslint-disable-line react-hooks/exhaustive-deps

  const openTable = useCallback((ref: TableRef, filter?: string) => {
    const conn = connsRef.current.find((c) => c.id === activeConnId);
    if (!conn) return;
    const open = tabsRef.current.find((x) => x.kind === 'table' && x.connId === conn.id && x.table && tableKey(x.table) === tableKey(ref));
    if (open) {
      setActiveTabId(open.id);
      if (filter !== undefined && filter !== open.filter && !open.running) {
        const next = { ...open, filter, sql: tableDataSql(ref, conn.driver, filter, open.orderBy) };
        updateTab(open.id, { filter, sql: next.sql });
        void runWith(next);
      }
      return;
    }
    const tab = mkTableTab(conn, ref, filter);
    tabsRef.current = [...tabsRef.current, tab];
    setTabs((l) => [...l, tab]);
    setActiveTabId(tab.id);
    void runWith(tab);
  }, [activeConnId, runWith, updateTab]);

  const requery = useCallback(async (tabId: string, patch: { filter?: string; orderBy?: { column: string; desc: boolean } | null }) => {
    const tab = tabOf(tabId);
    const conn = tab && connFor(tab);
    if (!tab?.table || !conn || tab.running) return;
    const filter = patch.filter ?? tab.filter ?? '';
    const orderBy = patch.orderBy !== undefined ? patch.orderBy : tab.orderBy ?? null;
    const next = { ...tab, filter, orderBy, sql: tableDataSql(tab.table, conn.driver, filter, orderBy) };
    updateTab(tabId, { filter, orderBy, sql: next.sql });
    await runWith(next);
  }, [runWith, updateTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const setTableFilter = useCallback((tabId: string, filter: string) => requery(tabId, { filter }), [requery]);
  const setTableSort = useCallback((tabId: string, orderBy: { column: string; desc: boolean } | null) => requery(tabId, { orderBy }), [requery]);

  const confirmWrite = useCallback(async () => {
    const p = pendingWrite;
    if (!p) return;
    if (p.resolve) { p.resolve('run'); return; }
    setPendingWrite(null);
    const tab = tabOf(p.tabId);
    const conn = tab && connFor(tab);
    if (!tab || !conn) return;
    // Run exactly the statement that was shown in the dialog.
    await exec({ ...tab, sql: p.sql }, conn, { sql: p.sql, sendSql: p.sendSql, params: p.params, from: p.from, mode: 'write', confirm: true, outId: ensureOutput(tab, !!p.newOutput, true, p.sql) });
  }, [pendingWrite, exec, ensureOutput]); // eslint-disable-line react-hooks/exhaustive-deps
  const skipWrite = useCallback(() => { const p = pendingWrite; if (p?.resolve) p.resolve('skip'); else setPendingWrite(null); }, [pendingWrite]);
  const dismissWrite = useCallback(() => { const p = pendingWrite; if (p?.resolve) p.resolve('stop'); else setPendingWrite(null); }, [pendingWrite]);

  const cancel = useCallback(async (tabId: string) => {
    const tab = tabOf(tabId);
    const conn = tab && connFor(tab);
    if (tab?.script) scriptStop.current[tabId] = true;
    if (!tab?.queryId || !conn) return;
    try { await conn.api.cancel(tab.queryId); } catch (e) { toast.push(friendlyDbError(e).title, 'error'); }
  }, [toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(async (tabId: string, outputId?: string) => {
    const tab = tabOf(tabId);
    const conn = tab && connFor(tab);
    const out = tab && (outputId ? tab.outputs.find((o) => o.id === outputId) : activeOutputOf(tab));
    const res = out?.result;
    // a failed page is not retried on every scroll event: the user re-runs / refreshes instead
    if (!tab || !conn || !out || !res?.cursorId || !res.hasMore || out.loadingMore || (tab.running && !tab.script) || out.error) return;
    const cursorId = res.cursorId;
    const oid = out.id;
    const mapOut = (f: (o: OutputState) => OutputState) => setOutputs(tabId, (x) => ({ outputs: x.outputs.map((o) => (o.id === oid ? f(o) : o)) }));
    mapOut((o) => ({ ...o, loadingMore: true })); // blocks a second fetch before the next render
    try {
      const r = await conn.api.fetch(cursorId, pageOf(tab));
      // drop the page if the output was re-run meanwhile (its result belongs to another cursor)
      mapOut((o) => (o.result?.cursorId !== cursorId ? { ...o, loadingMore: false }
        : { ...o, loadingMore: false, result: { ...o.result, rows: [...o.result.rows, ...r.rows], hasMore: r.hasMore, truncated: r.truncated, cursorId: r.hasMore ? cursorId : undefined } }));
    } catch (e) {
      const f = friendlyDbError(e);
      mapOut((o) => (o.result?.cursorId !== cursorId ? { ...o, loadingMore: false } : { ...o, loadingMore: false, error: f }));
    }
  }, [setOutputs]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAll = useCallback(async (tabId: string, outputId?: string) => {
    const find = () => { const tab = tabOf(tabId); return tab && (outputId ? tab.outputs.find((o) => o.id === outputId) : activeOutputOf(tab)); };
    for (let i = 0; i < 1000; i++) {
      const out = find();
      if (!out?.result?.hasMore || out.error) break;
      // a page requested by scrolling is still in flight: wait for it instead of skipping
      if (out.loadingMore) { i--; await new Promise((r) => setTimeout(r, 30)); continue; }
      await loadMore(tabId, outputId);
      await new Promise((r) => setTimeout(r, 0));
    }
    return find()?.result;
  }, [loadMore]); // eslint-disable-line react-hooks/exhaustive-deps

  const insertSql = useCallback((sql: string) => {
    // a table data view has no editor: insert into the active SQL tab, else the last one, else a new one
    const active = tabOf(activeTabId ?? '');
    const cur = active && active.kind !== 'table' ? active : [...tabsRef.current].reverse().find((x) => x.kind !== 'table');
    if (!cur) { newTab(sql); return; }
    setActiveTabId(cur.id);
    updateTab(cur.id, { sql: cur.sql.trim() ? `${cur.sql.replace(/\s+$/, '')}\n\n${sql}` : sql });
  }, [activeTabId, newTab, updateTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ transactions & session

  const connById = (id: string) => connsRef.current.find((c) => c.id === id) ?? null;

  const setAutoCommit = useCallback(async (connId: string, on: boolean) => {
    const c = connById(connId);
    if (!c) return false;
    try {
      const st = await c.api.setAutoCommit(on);
      updateConnection(c.id, { tx: { autoCommit: st.autoCommit, pending: st.txPending } });
      return true;
    } catch (e) { const f = friendlyDbError(e); toast.push(`${f.title}${f.detail ? ` — ${f.detail}` : ''}`, 'error'); return false; }
  }, [toast, updateConnection]); // eslint-disable-line react-hooks/exhaustive-deps

  const endTx = useCallback(async (connId: string, commit: boolean) => {
    const c = connById(connId);
    if (!c) return false;
    const t0 = Date.now();
    try {
      const st = await (commit ? c.api.commit() : c.api.rollback());
      reportTx(c, commit ? 'COMMIT' : 'ROLLBACK', true, Date.now() - t0, auditRef.current);
      updateConnection(c.id, { tx: { autoCommit: st.autoCommit, pending: st.txPending } });
      toast.push(t(commit ? 'tx.committed' : 'tx.rolledBack'), 'success');
      return true;
    } catch (e) {
      const f = friendlyDbError(e);
      reportTx(c, commit ? 'COMMIT' : 'ROLLBACK', false, Date.now() - t0, auditRef.current, f.code);
      toast.push(`${f.title}${f.detail ? ` — ${f.detail}` : ''}`, 'error');
      return false;
    }
  }, [toast, updateConnection]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = useCallback((id: string) => endTx(id, true), [endTx]);
  const rollback = useCallback((id: string) => endTx(id, false), [endTx]);

  const resolveDisconnect = useCallback(async (action: 'commit' | 'rollback' | 'cancel') => {
    const id = pendingDisconnectId;
    setPendingDisconnectId(null);
    if (!id || action === 'cancel') return;
    if (await endTx(id, action === 'commit')) await doRemove(id);
  }, [pendingDisconnectId, endTx, doRemove]);

  const setSchema = useCallback(async (connId: string, schema: string) => {
    const c = connById(connId);
    if (!c) return;
    try {
      const s = await c.api.setSchema(schema);
      updateConnection(c.id, { currentSchema: s ?? schema });
    } catch (e) { const f = friendlyDbError(e); toast.push(`${f.title}${f.detail ? ` — ${f.detail}` : ''}`, 'error'); }
  }, [toast, updateConnection]); // eslint-disable-line react-hooks/exhaustive-deps

  const runWrites = useCallback(async (connId: string, stmts: string[], opts: { atomic: boolean; onProgress?: (done: number) => void; stop?: () => boolean }) => {
    const c = connById(connId);
    if (!c) return { done: 0, committed: false, pending: false, error: { title: t('tabledb.noConnection'), detail: '', code: 'NO_CONN', cancelled: false } };
    const r = await runWriteBatch(c, stmts, { ...opts, audit: auditRef.current });
    if (c.tx && !c.tx.autoCommit) updateConnection(c.id, { tx: { autoCommit: false, pending: c.tx.pending || r.pending } });
    return r;
  }, [updateConnection]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = activeConnId ? selectedBy[activeConnId] ?? [] : [];
  const setSelected = useCallback((s: SelectedTable[]) => {
    if (!activeConnId) return;
    const seen = new Set<string>();
    setSelectedBy((m) => ({ ...m, [activeConnId]: s.filter((x) => (seen.has(tableKey(x)) ? false : (seen.add(tableKey(x)), true))) }));
  }, [activeConnId]);

  const pendingDisconnect = connections.find((c) => c.id === pendingDisconnectId) ?? null;

  const value = useMemo<TableDbApi>(() => ({
    connections, activeConn, setActiveConn: setActiveConnId, addConnection, removeConnection, reconnectConnection, updateConnection, remapProfiles,
    tabs, activeTab, setActiveTab: setActiveTabId, newTab, closeTab, updateTab,
    selected, setSelected, insertSql, run, explain, refreshOutput, patchOutput, setActiveOutput, closeOutput, cancel, loadMore, loadAll, openTable, setTableFilter, setTableSort,
    pendingWrite, confirmWrite, skipWrite, dismissWrite, pendingBinds, resolveBinds, pendingDisconnect, resolveDisconnect,
    setAutoCommit, commit, rollback, setSchema, runWrites, agentRows, setAgentRows,
  }), [connections, activeConn, addConnection, removeConnection, reconnectConnection, updateConnection, remapProfiles, tabs, activeTab, newTab, closeTab, updateTab, selected, setSelected, insertSql, run, explain, refreshOutput,
    patchOutput, setActiveOutput, closeOutput, cancel, loadMore, loadAll, openTable, setTableFilter, setTableSort, pendingWrite, confirmWrite, skipWrite, dismissWrite, pendingBinds, resolveBinds,
    pendingDisconnect, resolveDisconnect, setAutoCommit, commit, rollback, setSchema, runWrites, agentRows]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
