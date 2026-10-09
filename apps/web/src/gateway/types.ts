import type { DriverType } from '@vnpay/shared';

export type AuthSpec =
  | { type: 'password'; username: string; password: string }
  | { type: 'trino-external' };

/** Non-secret connection settings (desktop local profile / sidecar `session.open` profile minus auth). */
export interface ProfileSpec {
  /** 'custom' = a user-imported JDBC driver, selected by `driverId` */
  driver: DriverType | 'custom';
  driverId?: string;
  host: string;
  port: number;
  database?: string;
  schema?: string;
  options?: { connectType?: 'serviceName' | 'sid'; props?: Record<string, string>; ssl?: boolean; readOnly?: boolean; allowWrite?: boolean; connectTimeoutSec?: number; externalAuthTimeoutSec?: number; proxy?: ProxySpec };
}

/** HTTP CONNECT / SOCKS5 proxy (username/password optional). */
export interface ProxySpec { useDefault?: boolean; type: 'http' | 'socks'; host: string; port: number; username?: string; password?: string }
export interface SshHopSpec {
  host: string; port: number; username: string;
  auth: { type: 'password'; password: string } | { type: 'publicKey'; keyId: string; passphrase?: string };
  /** pinned server key fingerprint `SHA256:…`; absent = the sidecar answers E_SSH_HOSTKEY with the key to confirm */
  hostKey?: string;
}
/** Route to a database the machine cannot reach directly (secrets included; sent only to the local sidecar). */
export interface NetworkSpec {
  /** towards the database (no ssh) or towards the first SSH hop; overrides a catalog proxy only where the UI allows it */
  proxy?: ProxySpec;
  ssh?: { hops: SshHopSpec[]; keepAliveSec?: number };
}

export interface SessionRequest {
  /** connection settings, built only from the admin catalog entry (never contains secrets) */
  profile: ProfileSpec;
  auth: AuthSpec;
  schema?: string;
  /** SSH tunnel / proxy chosen by the user (advanced connection settings) */
  network?: NetworkSpec;
}
export interface SessionInfo { sessionId: string; serverVersion: string; user: string; readOnly: boolean; schema?: string | null; autoCommit?: boolean }
export interface TestResult { ok: boolean; latencyMs: number; serverVersion?: string; user?: string }
export interface GatewayEvent { seq: number; event: string; data: Record<string, unknown> & { sessionId?: string; url?: string; purpose?: string } }
export type Unsubscribe = () => void;

export class GatewayError extends Error {
  /** structured, non-secret data from the sidecar (e.g. E_SSH_HOSTKEY: {hop, host, port, keyType, fingerprint, reason}) */
  public details?: Record<string, unknown>;
  constructor(public code: string, message: string, public sqlState?: string, public retryable = false, public status?: number) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface RpcOptions { signal?: AbortSignal }

export interface DbGateway {
  readonly kind: 'tauri';
  /** session.test: open + measure + close on the local sidecar */
  testSession(req: SessionRequest): Promise<TestResult>;
  openSession(req: SessionRequest): Promise<SessionInfo>;
  closeSession(sessionId: string): Promise<void>;
  /** Close every sidecar session; the SPA calls it on boot since sessions of a previous page load are orphaned. */
  closeAllSessions(): Promise<number>;
  rpc<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, opts?: RpcOptions): Promise<T>;
  /** Cancel a running query (Statement.cancel). */
  cancel(sessionId: string, queryId: string): Promise<boolean>;
  /** Sidecar events for a session (e.g. auth.openUrl). */
  subscribe(sessionId: string, handler: (e: GatewayEvent) => void): Unsubscribe;
  /** Events emitted while `openSession` is still pending (Trino SSO: the URL event arrives BEFORE the session id is known). */
  subscribePending(handler: (e: GatewayEvent) => void): Unsubscribe;
}

// ---- typed RPC surface (docs/SIDECAR-PROTOCOL.md) ----
export interface TableInfo { name: string; type: string; remarks?: string | null }
export interface ColumnInfo { name: string; typeName: string; jdbcType?: number; size?: number; scale?: number; nullable?: boolean; position?: number; remarks?: string | null; default?: string | null }
export interface ForeignKeyInfo { columns: string[]; refCatalog?: string | null; refSchema: string; refTable: string; refColumns: string[]; name?: string }
export interface ColumnsResult { columns: ColumnInfo[]; primaryKey: string[]; foreignKeys: ForeignKeyInfo[] }
export interface ResultColumn { name: string; typeName: string; jdbcType?: number }
/** A further result of the same statement (procedure call, Oracle implicit result), read eagerly. */
export interface MoreResult { columns: ResultColumn[]; rows: unknown[][]; truncated?: boolean; updateCount?: number }
export interface QueryResult {
  queryId: string; kind: 'read' | 'write' | 'ddl'; columns: ResultColumn[]; rows: unknown[][]; hasMore: boolean; cursorId?: string;
  rowCount?: number; updateCount?: number; truncated: boolean; elapsedMs: number;
  /** SQL warnings / notices (PostgreSQL RAISE NOTICE, …) */
  messages?: string[];
  /** Oracle DBMS_OUTPUT lines (only when requested with serverOutput) */
  serverOutput?: string[];
  moreResults?: MoreResult[];
  /** transaction state of the session after the statement */
  autoCommit?: boolean; txPending?: boolean;
}
/** Positional value for a `?` placeholder. */
export interface BindValue { type: 'string' | 'number' | 'boolean' | 'date' | 'timestamp' | 'null'; value?: string }
export interface ExecuteParams {
  queryId: string; sql: string; mode: 'read' | 'write'; confirmWrite?: boolean; maxRows?: number; timeoutSec?: number; pageSize?: number;
  params?: BindValue[];
  /** Oracle: collect DBMS_OUTPUT */
  serverOutput?: boolean;
  /** per-value cap in bytes for BLOB/binary (and half as many chars of CLOB) instead of the 256 B preview; max 3 MiB */
  lobLimit?: number;
}
export type PlanResult = { elapsedMs: number } & (
  | { format: 'text'; text: string }
  | { format: 'json'; plan: string }
  | { format: 'table'; columns: ResultColumn[]; rows: unknown[][] });
export interface TxState { autoCommit: boolean; txPending: boolean }
