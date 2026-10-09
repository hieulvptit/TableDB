import { dbRuntimeConfig } from './runtimeConfig';
import type { DriverType } from '@vnpay/shared';
import type { AuthSpec, ProfileSpec, SessionRequest } from '../../gateway/types';
import type { NetworkForm } from './network';

/**
 * Custom (user-entered) connections: host/port/SID-or-service-name/driver properties typed by the user instead of taken
 * from the admin catalog. Gated by `db:custom`; writing additionally needs `db:write` and a per-statement confirmation.
 * Everything here is pure so it can be tested without a DOM. The sidecar re-validates every field.
 */

export type CustomDriver = DriverType | 'custom';
export type ConnectType = 'serviceName' | 'sid';
export interface PropRow { key: string; value: string }

/** Sidecar HOST rule (docs/SIDECAR-PROTOCOL.md): hostname/IPv4 or bracketed IPv6; no / ? ; = characters. */
export const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])$/;
export const PROP_KEY_RE = /^[A-Za-z][A-Za-z0-9_.$-]{0,79}$/;
export const MAX_PROPS = 20;
export const MAX_PROP_VALUE = 256;
const DENY_KEYS = new Set(['user', 'password']);
const DENY_PREFIXES = ['javax.net.ssl.', 'java.'];

export const DEFAULT_PORTS: Record<DriverType, number> = { oracle: 1521, postgresql: 5432, trino: 8080 };

export interface CustomForm {
  driver: CustomDriver;
  /** imported driver id (driver === 'custom') */
  driverId?: string;
  driverName?: string;
  host: string;
  port: string;
  connectType: ConnectType;
  /** Oracle: service name or SID; PostgreSQL: database; Trino: catalog; custom: value of {database} */
  database: string;
  ssl: boolean;
  connectTimeoutSec: string;
  props: PropRow[];
  allowWrite: boolean;
  username: string;
  password: string;
  /** Trino only: browser SSO (external authentication) instead of username/password */
  sso: boolean;
  schema: string;
  /** SSH tunnel / proxy (advanced); absent or inactive = direct connection */
  network?: NetworkForm;
}

export const emptyCustomForm = (): CustomForm => ({
  driver: 'trino', host: '', port: String(DEFAULT_PORTS.trino), connectType: 'serviceName', database: '', ssl: false,
  connectTimeoutSec: String(dbRuntimeConfig().connectTimeoutSec), props: [], allowWrite: false, username: '', password: '', schema: '', sso: false,
});

/** SSO is effective only for Trino. */
export const usesSso = (f: Pick<CustomForm, 'driver' | 'sso'>) => f.driver === 'trino' && f.sso;

export interface ParsedEndpoint { host: string; port?: number; database?: string; connectType?: ConnectType; schema?: string }

/**
 * Quick-paste parser, per driver.
 * - oracle: `host:port/service`, `//host:port/service`, `host:port:SID`, `host/service`, `host:port`, bracketed IPv6 and a
 *   full `jdbc:oracle:thin:@[tcps:]…` prefix.
 * - postgresql: `host:port/database`, `jdbc:postgresql://…`, `postgres(ql)://[user@]host:port/database[?…]`.
 * - trino (and imported drivers): `host:port/catalog[/schema]`, `jdbc:trino://…`, `trino://…`, `http(s)://…`.
 * Returns null when it does not look like an endpoint.
 */
export function parseEndpoint(input: string, driver: CustomDriver = 'oracle'): ParsedEndpoint | null {
  let s = input.trim();
  if (!s) return null;
  if (driver === 'oracle') {
    s = s.replace(/^jdbc:oracle:thin:@/i, '').replace(/^tcps?:/i, '').replace(/^\/\//, '');
    const m = /^(\[[^\]\s]+\]|[^:/\s]+)(?::(\d{1,5}))?(?:([/:])([^\s/:]+))?$/.exec(s);
    if (!m) return null;
    return finishEndpoint(m[1]!, m[2], m[3] && m[4] ? { database: m[4], connectType: m[3] === '/' ? 'serviceName' : 'sid' } : {});
  }
  s = s.replace(/^jdbc:(?:postgresql|trino|presto):/i, '').replace(/^(?:postgres(?:ql)?|trino|presto|https?):\/\//i, '').replace(/^\/\//, '');
  s = s.replace(/[?#].*$/, '').replace(/^[^@/\s]*@/, '');
  const m = /^(\[[^\]\s]+\]|[^:/\s]+)(?::(\d{1,5}))?(?:\/([^\s/:]+)(?:\/([^\s/:]+))?)?\/?$/.exec(s);
  if (!m) return null;
  return finishEndpoint(m[1]!, m[2], {
    ...(m[3] ? { database: m[3] } : {}),
    ...(m[4] && driver === 'trino' ? { schema: m[4] } : {}),
  });
}

function finishEndpoint(host: string, portStr: string | undefined, rest: Partial<ParsedEndpoint>): ParsedEndpoint | null {
  if (!HOST_RE.test(host)) return null;
  const out: ParsedEndpoint = { host, ...rest };
  if (portStr !== undefined) {
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    out.port = port;
  }
  return out;
}

/** Inverse of parseEndpoint: the quick-paste text for the form's current values, in the selected driver's format. */
export function formatEndpoint(f: Pick<CustomForm, 'driver' | 'host' | 'port' | 'database' | 'connectType' | 'schema'>): string {
  const host = f.host.trim();
  if (!host) return '';
  const hp = `${host}${f.port.trim() ? `:${f.port.trim()}` : ''}`;
  const db = f.database.trim();
  if (f.driver === 'oracle') return db ? `${hp}${f.connectType === 'sid' ? ':' : '/'}${db}` : hp;
  if (!db) return hp;
  const schema = f.driver === 'trino' ? f.schema.trim() : '';
  return `${hp}/${db}${schema ? `/${schema}` : ''}`;
}

/** Placeholder example and hint key suffix for the quick-paste box. */
export const PASTE_EXAMPLE: Record<DriverType, string> = {
  oracle: 'ora.internal:1521/BISVC', postgresql: 'pg.internal:5432/mydb', trino: 'trino.internal:8080/hive/default',
};

export type PropIssue = 'count' | 'key' | 'denied' | 'value' | 'duplicate';
export interface PropsResult { props: Record<string, string>; issues: Array<{ row: number; issue: PropIssue }> }

/** Validate extra driver properties (blank rows are ignored). Mirrors the sidecar's key rules. */
export function validateProps(rows: readonly PropRow[]): PropsResult {
  const props: Record<string, string> = {};
  const issues: PropsResult['issues'] = [];
  const seen = new Set<string>();
  let n = 0;
  rows.forEach((r, i) => {
    const key = r.key.trim();
    if (!key && !r.value) return;
    n++;
    if (n > MAX_PROPS) { issues.push({ row: i, issue: 'count' }); return; }
    if (!PROP_KEY_RE.test(key)) { issues.push({ row: i, issue: 'key' }); return; }
    const lk = key.toLowerCase();
    if (DENY_KEYS.has(lk) || DENY_PREFIXES.some((p) => lk.startsWith(p))) { issues.push({ row: i, issue: 'denied' }); return; }
    if (r.value.length > MAX_PROP_VALUE || r.value.includes('\0')) { issues.push({ row: i, issue: 'value' }); return; }
    if (seen.has(lk)) { issues.push({ row: i, issue: 'duplicate' }); return; }
    seen.add(lk);
    props[key] = r.value;
  });
  return { props, issues };
}

export type FormIssue = 'host' | 'port' | 'database' | 'driverId' | 'username' | 'timeout' | 'props';

export function validateCustomForm(f: CustomForm): FormIssue[] {
  const out: FormIssue[] = [];
  if (!HOST_RE.test(f.host.trim())) out.push('host');
  const port = Number(f.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) out.push('port');
  if (f.driver === 'oracle' && !f.database.trim()) out.push('database');
  if (f.database.trim() && !/^[A-Za-z0-9_$#.-]{1,128}$/.test(f.database.trim())) out.push('database');
  if (f.driver === 'custom' && !f.driverId) out.push('driverId');
  if (!usesSso(f) && !f.username.trim()) out.push('username');
  const to = Number(f.connectTimeoutSec);
  if (!Number.isInteger(to) || to < 1 || to > 120) out.push('timeout');
  if (validateProps(f.props).issues.length > 0) out.push('props');
  return out;
}

/** Non-secret description of the endpoint, sent to POST /db/audit instead of a catalog targetId. */
export interface CustomEndpoint {
  driver: CustomDriver; driverName?: string; host: string; port: number; database?: string; connectType?: ConnectType; allowWrite: boolean;
}

/** The SQL dialect used for editor/quoting/agent context: imported drivers are treated as generic ANSI-like (PostgreSQL-style). */
export const dialectOf = (d: CustomDriver): DriverType => (d === 'custom' ? 'postgresql' : d);

export function endpointOf(f: CustomForm, canWrite: boolean): CustomEndpoint {
  const database = f.database.trim();
  return {
    driver: f.driver, ...(f.driver === 'custom' && f.driverName ? { driverName: f.driverName } : {}),
    host: f.host.trim(), port: Number(f.port), ...(database ? { database } : {}),
    ...(f.driver === 'oracle' ? { connectType: f.connectType } : {}), allowWrite: canWrite && f.allowWrite,
  };
}

/** Sidecar request for a custom connection. Write is possible only when the user holds db:write AND ticked the box. */
export function buildCustomRequest(f: CustomForm, canWrite: boolean): SessionRequest {
  const database = f.database.trim();
  const { props } = validateProps(f.props);
  const profile: ProfileSpec = {
    driver: f.driver, ...(f.driver === 'custom' ? { driverId: f.driverId } : {}),
    host: f.host.trim(), port: Number(f.port), ...(database ? { database } : {}),
    options: {
      ...(f.driver === 'oracle' ? { connectType: f.connectType } : {}),
      ssl: f.ssl || usesSso(f), readOnly: true, allowWrite: canWrite && f.allowWrite,
      connectTimeoutSec: Number(f.connectTimeoutSec),
      ...(usesSso(f) ? { externalAuthTimeoutSec: dbRuntimeConfig().externalAuthTimeoutSec } : {}),
      ...(Object.keys(props).length > 0 ? { props } : {}),
    },
  };
  const auth: AuthSpec = usesSso(f) ? { type: 'trino-external' } : { type: 'password', username: f.username.trim(), password: f.password };
  return { profile, auth, schema: f.schema.trim() || undefined };
}

/** Display name like `user@host:port/db`. */
export const customName = (f: Pick<CustomForm, 'username' | 'host' | 'port' | 'database'>) =>
  `${f.username.trim() || 'sso'}@${f.host.trim()}:${f.port}${f.database.trim() ? `/${f.database.trim()}` : ''}`;
