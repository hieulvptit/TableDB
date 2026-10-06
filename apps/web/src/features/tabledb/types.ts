import type { DriverType } from '@vnpay/shared';
import type { BindValue, DbApi, DbGateway, PlanResult, SessionInfo } from '../../gateway';
import type { ChartSpec } from '../report/chart';
import type { CustomEndpoint } from './custom';
import type { SchemaStore, TableRef } from './schemaStore';

export interface Connection {
  id: string;
  /** admin-catalog target id (audit + write gating); `custom:<session>` for hand-entered connections */
  targetId: string;
  /** hand-entered endpoint (db:custom): reported to the audit endpoint instead of targetId */
  custom?: CustomEndpoint;
  /** imported JDBC driver name (custom drivers only) */
  driverName?: string;
  authType: 'password' | 'trino-external';
  name: string;
  /** SQL dialect (imported drivers use the generic PostgreSQL-style dialect) */
  driver: DriverType;
  gateway: DbGateway;
  api: DbApi;
  store: SchemaStore;
  info: SessionInfo;
  /** write mode may be offered (target.allowWrite AND user has db:write). The sidecar re-checks. */
  allowWrite: boolean;
  defaultSchema?: string;
  /** saved local connection this session was opened from (custom connections only) */
  profileId?: string;
  /** SSH/proxy route description (no secrets), e.g. `SSH bastion:22`; absent = direct */
  route?: string;
  unsubscribe?: () => void;
  /** the sidecar dropped the session and it could not be reopened */
  lost?: boolean;
  /** transaction mode of the sidecar session: manual commit keeps writes pending until commit/rollback */
  tx?: { autoCommit: boolean; pending: boolean };
  /** current schema of the session (session.setSchema), when the driver reports it */
  currentSchema?: string | null;
}

export interface QueryOutput {
  kind: 'read' | 'write' | 'ddl';
  columns: Array<{ name: string; typeName?: string }>;
  rows: unknown[][];
  hasMore: boolean;
  cursorId?: string;
  updateCount?: number;
  truncated: boolean;
  elapsedMs: number;
  /** warnings / notices returned with the statement */
  messages?: string[];
  /** Oracle DBMS_OUTPUT lines */
  serverOutput?: string[];
}
/** How a result set is shown (DBeaver-style Grid / JSON / Text switch). */
export type ResultViewMode = 'grid' | 'json' | 'text' | 'chart';

export interface EditorTabState {
  id: string; title: string; connId: string | null; sql: string; mode: 'read' | 'write';
  maxRows: number; timeoutSec: number;
  /** 'table' = data view of one table opened from the tree (no SQL editor; SQL is generated from `table` + `filter`) */
  kind?: 'sql' | 'table';
  /** schema/database the query is bound to: the session is switched to it before every run */
  schema?: string | null;
  /** database (catalog) the query is bound to; statements may not reach into another database */
  catalog?: string;
  table?: TableRef;
  /** WHERE condition of a table data view (empty = all rows) */
  filter?: string;
  view?: ResultViewMode;
  running: boolean; queryId?: string;
  /** saved connection profile the tab belongs to (restores the tab onto that connection after a restart) */
  profileId?: string;
  /** name of the .sql file the tab was opened from / saved as */
  fileName?: string;
  /** Oracle: collect DBMS_OUTPUT after each statement */
  serverOutput?: boolean;
  /** last values entered for :name bind parameters */
  binds?: Record<string, BindValue>;
  /** table data view: server-side ORDER BY */
  orderBy?: { column: string; desc: boolean } | null;
  /** a script run is in progress (Stop ends it after the current statement) */
  script?: { index: number; total: number };
  /** result tabs of this editor (DBeaver-style): "Run" refills the active one, "Run in new tab" appends one */
  outputs: OutputState[];
  activeOutputId?: string;
  /** monotonic counter for output titles ("Kết quả N") */
  outputSeq: number;
}

export interface ScriptLogEntry {
  index: number; sql: string; status: 'ok' | 'error' | 'skipped' | 'rejected' | 'cancelled';
  kind?: string; rows?: number; updateCount?: number; ms?: number; message?: string;
}

export interface OutputState {
  id: string; title: string;
  /** statement that produced this output (as written, with :name placeholders) */
  sql: string;
  /** offset of `sql` in the editor buffer when it ran (error marking) */
  sqlFrom?: number;
  /** values bound to the statement's placeholders */
  params?: BindValue[];
  mode?: 'read' | 'write';
  running?: boolean; loadingMore?: boolean;
  result?: QueryOutput; error?: { title: string; detail: string; code: string; sqlState?: string } | null; cancelled?: boolean;
  /** absolute editor offset of the error reported by the database */
  errorPos?: number;
  /** EXPLAIN output */
  plan?: PlanResult;
  /** per-statement log of a script run */
  log?: ScriptLogEntry[];
  /** a pinned output is never refilled by Run nor dropped when outputs are trimmed */
  pinned?: boolean;
  /** re-run every N seconds (read results only) */
  refreshSec?: number;
  /** chart shown in the Chart view of this output (absent = suggested from the columns) */
  chart?: ChartSpec;
}

/** Result views use presentation metadata independently of the live editor buffer. */
export type ResultTabState = Pick<EditorTabState, 'id' | 'connId' | 'title' | 'outputs' | 'view' | 'kind' | 'orderBy' | 'table' | 'filter' | 'schema' | 'catalog' | 'maxRows'>;

export type SelectedTable = TableRef;

/** Rows the user explicitly chose (and confirmed) to attach to the next Agent message only. */
export interface AgentRowsAttachment { columns: string[]; rows: unknown[][] }
