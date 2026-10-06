import { dbRuntimeConfig } from './runtimeConfig';
import type { DriverType } from '@vnpay/shared';
import { apiClient, type ApiClient } from '../../api/client';
import { asList } from '../../api/services';
import type { AuthMode, DbTarget } from '../../api/types';
import type { ProfileSpec } from '../../gateway/types';

const DRIVERS: readonly DriverType[] = ['postgresql', 'oracle', 'trino'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536;

/**
 * Keep only catalog entries the desktop can safely use: known driver, complete host/port, at least one valid auth mode
 * (Trino SSO only for trino), unique ids. Anything else is dropped rather than guessed. Sorted by name.
 */
export function filterCatalog(raw: unknown): DbTarget[] {
  const seen = new Set<string>();
  const out: DbTarget[] = [];
  for (const r of asList<Record<string, unknown>>(raw, 'targets')) {
    if (!r || typeof r !== 'object') continue;
    const { id, name, driver, host, port } = r as Record<string, unknown>;
    if (!isStr(id) || !isStr(name) || !isStr(host) || !isPort(port) || !DRIVERS.includes(driver as DriverType) || seen.has(id)) continue;
    const modes = (Array.isArray(r.authModes) ? r.authModes : ['password']).filter((m): m is AuthMode => m === 'password' || (m === 'trino-external' && driver === 'trino'));
    if (modes.length === 0) continue;
    const proxy = r.proxy as { type?: unknown; host?: unknown; port?: unknown } | null | undefined;
    const validProxy = proxy && (proxy.type === 'http' || proxy.type === 'socks') && isStr(proxy.host) && isPort(proxy.port) ? { type: proxy.type as 'http' | 'socks', host: proxy.host, port: proxy.port } : null;
    const o = (r.options ?? {}) as { ssl?: unknown; connectTimeoutSec?: unknown };
    seen.add(id);
    out.push({
      id, name, driver: driver as DriverType, host, port, database: isStr(r.database) ? r.database : null,
      allowWrite: r.allowWrite === true, authModes: modes, requiresProxy: r.requiresProxy === true,
      proxy: validProxy,
      options: { ...(typeof o.ssl === 'boolean' ? { ssl: o.ssl } : {}), ...(typeof o.connectTimeoutSec === 'number' && o.connectTimeoutSec > 0 ? { connectTimeoutSec: Math.min(o.connectTimeoutSec, 300) } : {}) },
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const fetchCatalog = async (c: ApiClient = apiClient): Promise<DbTarget[]> => filterCatalog(await c.get<unknown>('/db/targets'));

export class ProxyRequiredError extends Error {
  constructor(readonly targetId: string) { super('target requires a proxy but the catalog does not provide one'); this.name = 'ProxyRequiredError'; }
}

/**
 * Sidecar profile for a catalog target. Host/port/driver/database, proxy and options come ONLY from the catalog entry;
 * the user contributes credentials (auth) and an optional default schema elsewhere. Write is possible only when the
 * user holds db:write AND the target allows it (the confirmation dialog is a third, per-statement gate).
 */
export function profileFromTarget(target: DbTarget, opts: { canWrite: boolean; sso?: boolean; userRoute?: boolean }): ProfileSpec {
  // a required-but-missing catalog proxy can be replaced by the user's own route (SSH tunnel or proxy)
  if (target.requiresProxy && !target.proxy && !opts.userRoute) throw new ProxyRequiredError(target.id);
  return {
    driver: target.driver, host: target.host, port: target.port, ...(target.database ? { database: target.database } : {}),
    options: {
      ssl: target.options?.ssl ?? true,
      readOnly: true,
      allowWrite: opts.canWrite && target.allowWrite,
      connectTimeoutSec: target.options?.connectTimeoutSec ?? dbRuntimeConfig().connectTimeoutSec,
      ...(opts.sso ? { externalAuthTimeoutSec: dbRuntimeConfig().externalAuthTimeoutSec } : {}),
      ...(target.proxy ? { proxy: target.proxy } : {}),
    },
  };
}
