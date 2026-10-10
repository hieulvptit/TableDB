import { DbApi, createGateway } from '../../gateway';
import type { AuthSpec, DbGateway, GatewayEvent, SessionRequest, TestResult } from '../../gateway/types';
import { desktopCommands } from '../../runtime/tauri';
import type { DbTarget } from '../../api/types';
import { auditReporter, type AuditReporter } from './audit';
import { profileFromTarget } from './catalog';
import { buildCustomRequest, customName, dialectOf, endpointOf, usesSso, type CustomForm } from './custom';
import { buildNetwork, isNetworkActive, routeLabel, type NetworkForm } from './network';
import { SchemaStore } from './schemaStore';
import type { Connection } from './types';

/** A connection the user typed by hand (db:custom): endpoint + credentials + driver options. */
export interface CustomSource { custom: CustomForm; canWrite: boolean; network?: NetworkForm }
/** A connection the user asked for: an admin-catalog target + the user's own credentials. */
export interface CatalogSource {
  target: DbTarget;
  authType: AuthSpec['type'];
  username?: string;
  password?: string;
  schema?: string;
  /** user holds db:write (write mode also needs target.allowWrite) */
  canWrite: boolean;
  /** SSH tunnel (and a proxy when the catalog does not fix one) chosen by the user */
  network?: NetworkForm;
}

export type ConnectSource = CatalogSource | CustomSource;
export const isCustomSource = (s: ConnectSource): s is CustomSource => 'custom' in s;

const authOf = (src: ConnectSource) => (isCustomSource(src) ? (usesSso(src.custom) ? 'trino-external' : 'password') : src.authType);
const auditTarget = (src: ConnectSource) => (isCustomSource(src) ? { custom: endpointOf(src.custom, src.canWrite) } : { targetId: src.target.id });
/** the admin catalog fixes the proxy for its targets; the user may still add SSH hops */
const catalogProxy = (src: ConnectSource) => (isCustomSource(src) ? null : src.target.proxy ?? null);
const networkOf = (src: ConnectSource) => src.network ?? (isCustomSource(src) ? src.custom.network : undefined);
/** Non-secret route description for the audit log (empty = direct). */
export const routeOf = (src: ConnectSource) => routeLabel(networkOf(src), catalogProxy(src));
const auditRoute = (src: ConnectSource) => { const r = routeOf(src); return r ? { route: r } : {}; };

export function buildSessionRequest(src: ConnectSource): SessionRequest {
  const network = buildNetwork(networkOf(src), !!catalogProxy(src));
  if (isCustomSource(src)) return { ...buildCustomRequest(src.custom, src.canWrite), ...(network ? { network } : {}) };
  const sso = src.authType === 'trino-external';
  const auth: AuthSpec = sso ? { type: 'trino-external' } : { type: 'password', username: src.username ?? '', password: src.password ?? '' };
  const profile = profileFromTarget(src.target, { canWrite: src.canWrite, sso, userRoute: isNetworkActive(networkOf(src)) });
  return { profile, auth, schema: src.schema || undefined, ...(network ? { network } : {}) };
}

/** Only http(s) URLs coming from the driver are ever opened. */
export function openExternalUrl(url: string) {
  let u: URL;
  try { u = new URL(url); } catch { return; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
  void desktopCommands.openExternal(u.toString()).catch(() => {});
}

export interface ConnectCallbacks { onSsoUrl?: (url: string) => void }

function watchSso(cb?: ConnectCallbacks): (e: GatewayEvent) => void {
  return (e) => {
    if (e.event === 'auth.openUrl' && typeof e.data?.url === 'string') {
      cb?.onSsoUrl?.(e.data.url);
      if (e.data.browserHandled !== true) openExternalUrl(e.data.url);
    }
  };
}

export async function testConnection(gw: DbGateway, src: ConnectSource, cb?: ConnectCallbacks): Promise<TestResult> {
  const req = buildSessionRequest(src);
  const unsub = req.auth.type === 'trino-external' ? gw.subscribePending(watchSso(cb)) : undefined;
  try { return await gw.testSession(req); } finally { unsub?.(); }
}

export async function openConnection(src: ConnectSource, cb?: ConnectCallbacks, gw: DbGateway = createGateway(), audit: Pick<AuditReporter, 'report'> = auditReporter): Promise<Connection> {
  const req = buildSessionRequest(src);
  const sso = req.auth.type === 'trino-external';
  const unsubPending = sso ? gw.subscribePending(watchSso(cb)) : undefined;
  let info;
  try { info = await gw.openSession(req); }
  catch (e) { audit.report({ ...auditTarget(src), event: 'open_failed', authType: authOf(src), ...auditRoute(src) }); throw e; }
  finally { unsubPending?.(); }
  audit.report({ ...auditTarget(src), event: 'open', authType: authOf(src), ...auditRoute(src) });
  const api = new DbApi(gw, info.sessionId);
  const conn: Connection = isCustomSource(src)
    ? {
      id: info.sessionId, targetId: `custom:${info.sessionId}`, custom: endpointOf(src.custom, src.canWrite), authType: usesSso(src.custom) ? 'trino-external' : 'password', name: customName(src.custom),
      driver: dialectOf(src.custom.driver), driverName: src.custom.driver === 'custom' ? src.custom.driverName : undefined, gateway: gw, api, store: new SchemaStore(api), info,
      allowWrite: src.canWrite && src.custom.allowWrite, defaultSchema: src.custom.schema.trim() || undefined, ...(routeOf(src) ? { route: routeOf(src) } : {}),
    }
    : {
      id: info.sessionId, targetId: src.target.id, authType: src.authType, name: src.target.name, driver: src.target.driver, gateway: gw, api, store: new SchemaStore(api), info,
      // write mode is offered only with db:write AND target.allowWrite (the sidecar is opened with the same allowWrite)
      allowWrite: src.canWrite && src.target.allowWrite,
      defaultSchema: src.schema, ...(routeOf(src) ? { route: routeOf(src) } : {}),
    };
  conn.tx = { autoCommit: info.autoCommit ?? true, pending: false };
  conn.currentSchema = info.schema ?? null;
  // Trino tokens expire: the driver re-emits auth.openUrl on the live session.
  if (sso) conn.unsubscribe = gw.subscribe(info.sessionId, watchSso(cb));
  api.reconnect = (force) => reopenSession(conn, src, req, cb, audit, force);
  return conn;
}

/**
 * The sidecar dropped the session (idle reaper, restart): open a fresh one with the same request so the failed call can be retried.
 * Not done in manual-commit mode, where the pending transaction is gone and must not silently become a new auto-commit session.
 */
async function reopenSession(conn: Connection, src: ConnectSource, req: SessionRequest, cb: ConnectCallbacks | undefined, audit: Pick<AuditReporter, 'report'>, force = false): Promise<string> {
  if (!force && conn.tx && !conn.tx.autoCommit) throw new Error('manual-commit session lost');
  const gw = conn.gateway;
  const sso = req.auth.type === 'trino-external';
  const unsubPending = sso ? gw.subscribePending(watchSso(cb)) : undefined;
  let info;
  try { info = await gw.openSession(req); }
  catch (e) { audit.report({ ...auditTarget(src), event: 'open_failed', authType: authOf(src), ...auditRoute(src) }); throw e; }
  finally { unsubPending?.(); }
  audit.report({ ...auditTarget(src), event: 'open', authType: authOf(src), ...auditRoute(src) });
  // keep the schema the user switched to
  let schema = info.schema ?? null;
  if (conn.currentSchema && conn.currentSchema !== schema) {
    try { schema = (await gw.rpc<{ schema: string | null }>(info.sessionId, 'session.setSchema', { schema: conn.currentSchema })).schema; } catch { /* stay on the default schema */ }
  }
  conn.info = { ...info, schema };
  conn.currentSchema = schema;
  conn.tx = { autoCommit: info.autoCommit ?? true, pending: false };
  if (sso) { conn.unsubscribe?.(); conn.unsubscribe = gw.subscribe(info.sessionId, watchSso(cb)); }
  return info.sessionId;
}

export async function closeConnection(c: Connection, audit: Pick<AuditReporter, 'report'> = auditReporter) {
  c.unsubscribe?.();
  try { await c.gateway.closeSession(c.api.sessionId); } catch { /* already gone */ }
  audit.report({ ...(c.custom ? { custom: c.custom } : { targetId: c.targetId }), event: 'close', authType: c.authType, ...(c.route ? { route: c.route } : {}) });
}
