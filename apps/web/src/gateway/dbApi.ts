import { toGatewayError } from './errors';
import type { ColumnsResult, DbGateway, ExecuteParams, PlanResult, QueryResult, RpcOptions, TableInfo, TxState } from './types';

/** The sidecar no longer knows the session (idle reaper, sidecar restart). */
export const isLostSession = (e: unknown) => {
  const g = toGatewayError(e);
  return g.code === 'E_NOT_FOUND' && /unknown session/i.test(g.message);
};

/** Typed convenience wrapper over gateway.rpc for one session. */
export class DbApi {
  /** Reopens the session after the sidecar lost it; resolves to the new session id. Unset = no automatic reconnect. */
  reconnect?: (force?: boolean) => Promise<string>;
  /** the session is gone and could not be reopened (called once per loss; reset when a call succeeds again) */
  onLost?: (e: unknown) => void;
  private lostReported = false;
  private reopening: Promise<string> | null = null;
  constructor(readonly gw: DbGateway, public sessionId: string) {}

  /** One rpc; a lost session is reopened once and the call retried before the error reaches the caller. */
  private async call<T>(method: string, params?: Record<string, unknown>, opts?: RpcOptions, retry = true): Promise<T> {
    const sid = this.sessionId;
    try { const r = await this.gw.rpc<T>(sid, method, params, opts); this.lostReported = false; return r; }
    catch (e) {
      if (opts?.signal?.aborted || !isLostSession(e)) throw e;
      if (!retry || !this.reconnect) { this.reportLost(e); throw e; }
      try { await this.reopen(sid); } catch { this.reportLost(e); throw e; }
      return this.gw.rpc<T>(this.sessionId, method, params, opts);
    }
  }

  /** user-requested reconnect of the same session request (same endpoint, credentials and network route); also drops a pending manual-commit transaction */
  async reconnectNow(): Promise<string> {
    if (!this.reconnect) throw new Error('reconnect unavailable');
    const old = this.sessionId;
    const id = await this.reconnect(true);
    this.sessionId = id;
    this.lostReported = false;
    if (old !== id) void this.gw.closeSession(old).catch(() => {});
    return id;
  }

  private reportLost(e: unknown) { if (this.lostReported) return; this.lostReported = true; this.onLost?.(e); }

  /** concurrent failures share one reconnect; a call that failed on an already replaced session just retries */
  private reopen(failed: string): Promise<string> {
    if (this.sessionId !== failed) return Promise.resolve(this.sessionId);
    this.reopening ??= this.reconnect!().then((id) => { this.sessionId = id; return id; }).finally(() => { this.reopening = null; });
    return this.reopening;
  }

  catalogs = () => this.call<{ catalogs: string[] }>('meta.catalogs').then((r) => r.catalogs ?? []);
  schemas = (catalog?: string) => this.call<{ schemas: string[] }>('meta.schemas', { ...(catalog ? { catalog } : {}) }).then((r) => r.schemas ?? []);
  tables = (schema: string, catalog?: string) =>
    this.call<{ tables: TableInfo[] }>('meta.tables', { schema, ...(catalog ? { catalog } : {}), types: ['TABLE', 'VIEW'] }).then((r) => r.tables ?? []);
  columns = (schema: string, table: string, catalog?: string) =>
    this.call<ColumnsResult>('meta.columns', { schema, table, ...(catalog ? { catalog } : {}) });
  ddl = (schema: string, table: string, catalog?: string) =>
    this.call<{ ddl: string; source: string }>('meta.ddl', { schema, table, ...(catalog ? { catalog } : {}) });
  fingerprint = (schema: string, catalog?: string) =>
    this.call<{ fingerprint: string }>('meta.fingerprint', { schema, ...(catalog ? { catalog } : {}) });
  execute = (p: ExecuteParams, signal?: AbortSignal) => this.call<QueryResult>('query.execute', { ...p }, { signal });
  // cursors die with their session: nothing to retry on a new one
  fetch = (cursorId: string, count?: number) => this.call<{ rows: unknown[][]; hasMore: boolean; truncated: boolean }>('query.fetch', { cursorId, ...(count ? { count } : {}) }, undefined, false);
  closeCursor = (cursorId: string) => this.call<unknown>('query.closeCursor', { cursorId }, undefined, false);
  cancel = (queryId: string) => this.gw.cancel(this.sessionId, queryId);
  /** execution plan of one query/DML statement (never executed) */
  plan = (sql: string, timeoutSec?: number) => this.call<PlanResult>('query.plan', { sql, ...(timeoutSec ? { timeoutSec } : {}) });
  setSchema = (schema: string) => this.call<{ schema: string | null }>('session.setSchema', { schema }).then((r) => r.schema);
  setAutoCommit = (autoCommit: boolean) => this.call<TxState>('tx.setAutoCommit', { autoCommit });
  // the pending transaction was lost with the session: committing/rolling back a fresh one would mislead
  commit = () => this.call<TxState>('tx.commit', undefined, undefined, false);
  rollback = () => this.call<TxState>('tx.rollback', undefined, undefined, false);
}
