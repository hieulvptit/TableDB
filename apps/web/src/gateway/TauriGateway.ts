import { dbRuntimeConfig, bounded } from '../features/tabledb/runtimeConfig';
import { desktopCommands, tauriListen } from '../runtime/tauri';
import { toGatewayError } from './errors';
import type { DbGateway, GatewayEvent, RpcOptions, SessionInfo, SessionRequest, TestResult, Unsubscribe } from './types';
import { GatewayError } from './types';

const CURSOR_METHODS = new Set(['query.fetch', 'query.cancel', 'query.closeCursor']);

export interface TauriBridge {
  request(method: string, params: unknown): Promise<unknown>;
  cancel(queryId: string): Promise<unknown>;
  listen(handler: (payload: GatewayEvent) => void): Promise<() => void>;
}
const defaultBridge: TauriBridge = {
  request: (m, p) => desktopCommands.sidecarRequest(m, p),
  cancel: (q) => desktopCommands.sidecarCancel(q),
  listen: (h) => tauriListen<GatewayEvent>('sidecar:event', h),
};

/** Desktop: local JDBC sidecar via Rust core (stdio NDJSON). Session credentials are passed per call and never stored here. */
export class TauriGateway implements DbGateway {
  readonly kind = 'tauri' as const;
  private handlers = new Map<string, Set<(e: GatewayEvent) => void>>();
  private unlisten: Promise<() => void> | null = null;
  private pending = new Set<(e: GatewayEvent) => void>();
  constructor(private bridge: TauriBridge = defaultBridge) {}

  private profileBody(req: SessionRequest) {
    if (!req.profile) throw new GatewayError('E_BAD_REQUEST', 'profile is required');
    const { options, ...p } = req.profile;
    const net = req.network;
    return {
      profile: {
        ...p, ...(req.schema ? { schema: req.schema } : {}), auth: req.auth,
        ...(net?.ssh ? { ssh: net.ssh } : {}),
        options: { readOnly: true, ...options, ...(net?.proxy ? { proxy: net.proxy } : {}) },
      },
    };
  }

  async openSession(req: SessionRequest): Promise<SessionInfo> {
    try { return (await this.bridge.request('session.open', this.profileBody(req))) as SessionInfo; } catch (e) { throw toGatewayError(e); }
  }
  async testSession(req: SessionRequest): Promise<TestResult> {
    try { return (await this.bridge.request('session.test', this.profileBody(req))) as TestResult; } catch (e) { throw toGatewayError(e); }
  }
  async closeSession(sessionId: string): Promise<void> {
    this.handlers.delete(sessionId);
    try { await this.bridge.request('session.close', { sessionId }); } catch (e) { throw toGatewayError(e); }
  }
  async closeAllSessions(): Promise<number> {
    this.handlers.clear();
    try { return ((await this.bridge.request('session.closeAll', {})) as { closed?: number } | null)?.closed ?? 0; } catch (e) { throw toGatewayError(e); }
  }
  async rpc<T>(sessionId: string, method: string, params: Record<string, unknown> = {}, opts: RpcOptions = {}): Promise<T> {
    if (opts.signal?.aborted) throw new GatewayError('E_CANCELLED', 'cancelled');
    if (method === 'query.execute' || method === 'query.plan' || method === 'query.fetch') {
      const c = dbRuntimeConfig();
      params = { ...params };
      if (method === 'query.execute') {
        params.maxRows = bounded(params.maxRows as number | undefined, c.defaultMaxRows, c.maxRows);
        params.pageSize = bounded(params.pageSize as number | undefined, c.pageSize, 5000);
      }
      if (method === 'query.fetch') params.count = bounded(params.count as number | undefined, c.pageSize, 5000);
      else params.timeoutSec = bounded(params.timeoutSec as number | undefined, c.defaultTimeoutSec, c.maxTimeoutSec);
    }
    // Cursor/cancel methods carry their own ids (protocol has no sessionId there); everything else is session-scoped.
    const body = CURSOR_METHODS.has(method) ? params : { sessionId, ...params };
    try { return (await this.bridge.request(method, body)) as T; } catch (e) { throw toGatewayError(e); }
  }
  async cancel(_sessionId: string, queryId: string): Promise<boolean> {
    try {
      const r = (await this.bridge.cancel(queryId)) as { cancelled?: boolean } | boolean | null;
      return typeof r === 'boolean' ? r : !!r?.cancelled;
    } catch (e) { throw toGatewayError(e); }
  }

  subscribe(sessionId: string, handler: (e: GatewayEvent) => void): Unsubscribe {
    let set = this.handlers.get(sessionId);
    if (!set) { set = new Set(); this.handlers.set(sessionId, set); }
    set.add(handler);
    this.ensureListening();
    return () => { this.handlers.get(sessionId)?.delete(handler); };
  }

  subscribePending(handler: (e: GatewayEvent) => void): Unsubscribe {
    this.pending.add(handler);
    this.ensureListening();
    return () => { this.pending.delete(handler); };
  }

  private ensureListening() {
    this.unlisten ??= this.bridge.listen((ev) => {
      const sid = ev?.data?.sessionId;
      if (!sid) { for (const s of this.handlers.values()) s.forEach((h) => h(ev)); }
      else this.handlers.get(sid)?.forEach((h) => h(ev));
      this.pending.forEach((h) => h(ev));
    });
  }
}
