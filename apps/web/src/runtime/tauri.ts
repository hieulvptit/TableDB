// Thin wrapper over the Tauri 2 JS bridge. We deliberately do not depend on @tauri-apps/api: the shell exposes
// window.__TAURI_INTERNALS__ always and window.__TAURI__ when `withGlobalTauri` is on. Command names/args are the
// contract with apps/desktop (see README "Desktop command contract").

export interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) => Promise<unknown>;
  transformCallback?: (cb: (ev: unknown) => void, once?: boolean) => number;
}
interface TauriGlobal {
  core?: { invoke: TauriInternals['invoke'] };
  event?: { listen: (event: string, cb: (ev: { payload: unknown }) => void) => Promise<() => void> };
}
type W = { __TAURI_INTERNALS__?: TauriInternals; __TAURI__?: TauriGlobal };
const w = (): W => (typeof window === 'undefined' ? {} : (window as unknown as W));

/** Detect the desktop shell at runtime (not build time): the same bundle serves web and desktop. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** `args` may be raw bytes (sent as the request body, e.g. file chunks) with metadata in `options.headers`. */
export async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }): Promise<T> {
  const g = w();
  const inv = g.__TAURI__?.core?.invoke ?? g.__TAURI_INTERNALS__?.invoke;
  if (!inv) throw new Error('Tauri bridge is not available');
  return (await (options ? inv(cmd, args, options) : inv(cmd, args))) as T;
}

export async function tauriListen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const g = w();
  if (g.__TAURI__?.event?.listen) {
    return g.__TAURI__.event.listen(event, (e) => handler(e.payload as T));
  }
  const i = g.__TAURI_INTERNALS__;
  if (!i?.transformCallback) throw new Error('Tauri event bridge is not available');
  const cb = i.transformCallback((e) => handler((e as { payload: T }).payload));
  const id = (await i.invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler: cb })) as number;
  return () => { void i.invoke('plugin:event|unlisten', { event, eventId: id }).catch(() => {}); };
}

export interface DriverFile { file: string; sha256: string }
export interface CustomDriverInfo {
  id: string; name: string; version?: string; className: string; urlTemplate: string; defaultPort?: number;
  files: DriverFile[]; loaded: boolean; error?: string;
}
export interface DriverImportParams { name: string; className: string; urlTemplate: string; defaultPort?: number; version?: string }

/** Imported SSH private key (the key bytes stay in app data; only the id goes to the sidecar). */
export interface SshKeyInfo { id: string; name: string; format: 'openssh' | 'pem' | 'putty'; encrypted: boolean; addedAt: number }

/** `agent` section of the local config.json (no secrets): LLM endpoints, defaults, OpenMetadata MCP flag. */
export interface AgentConfigInfo {
  endpoints: Array<{ id: string; label: string; baseUrl: string; models: string[]; description?: string }>;
  defaultEndpointId: string | null; defaultModel: string | null; budgetChars: number; openMetadataEnabled: boolean;
}

export interface AppInfo { version?: string; env?: string; apiBaseUrl?: string; [k: string]: unknown }
export const desktopCommands = {
  appInfo: () => tauriInvoke<AppInfo>('app_info'),
  openExternal: (url: string) => tauriInvoke<void>('open_external', { url }),
  secretSet: (key: string, value: string) => tauriInvoke<void>('secret_set', { key, value }),
  secretGet: (key: string) => tauriInvoke<string | null>('secret_get', { key }),
  secretDelete: (key: string) => tauriInvoke<void>('secret_delete', { key }),
  /** Agent: local config + the HTTP bridge (the Rust core resolves the URL from config.json and attaches the stored credential). */
  agentConfig: () => tauriInvoke<AgentConfigInfo>('agent_config'),
  agentHttp: (requestId: string, req: unknown) => tauriInvoke<{ status: number; contentType: string; sessionId?: string; body: string }>('agent_http', { requestId, req }),
  agentHttpCancel: (requestId: string) => tauriInvoke<void>('agent_http_cancel', { requestId }),
  oidcBegin: (params: { authorizeEndpoint: string; clientId: string; scope?: string; extraParams?: Record<string, string>; timeoutSec?: number }) =>
    tauriInvoke<{ code: string; redirectUri: string; codeVerifier: string }>('oidc_begin', { params }),
  sidecarRequest: (method: string, params: unknown) => tauriInvoke<unknown>('sidecar_request', { method, params }),
  /** Opens the native multi-file .jar picker in Rust; copies the JARs into app data with sha256. Rejects with code E_CANCELLED if the user cancels. */
  driverImport: (params: DriverImportParams) => tauriInvoke<CustomDriverInfo>('driver_import', { params }),
  driverList: () => tauriInvoke<{ drivers: CustomDriverInfo[] }>('driver_list'),
  driverRemove: (id: string) => tauriInvoke<void>('driver_remove', { id }),
  sidecarCancel: (queryId: string) => tauriInvoke<unknown>('sidecar_cancel', { queryId }),
  /** Opens the native file picker in Rust and copies the private key into app data. Rejects with E_CANCELLED if the user cancels. */
  sshKeyImport: (name?: string) => tauriInvoke<SshKeyInfo>('ssh_key_import', { name: name ?? null }),
  sshKeyList: () => tauriInvoke<{ keys: SshKeyInfo[] }>('ssh_key_list'),
  sshKeyRemove: (id: string) => tauriInvoke<void>('ssh_key_remove', { id }),
  /** Encrypted editor workspace in app data (AES-256-GCM, key in the OS credential store). null = nothing saved yet. */
  workspaceLoad: () => tauriInvoke<string | null>('workspace_load'),
  workspaceSave: (data: string) => tauriInvoke<void>('workspace_save', { data }),
  /** Deletes the file and its key. */
  workspaceClear: () => tauriInvoke<void>('workspace_clear'),
  /** Native save dialog in Rust (path never reaches the WebView) → `.part` file. Rejects with E_CANCELLED if the user cancels. Returns a handle. */
  transferSaveBegin: (params: { fileName: string; size: number; sha256: string }) => tauriInvoke<string>('transfer_save_begin', { params }),
  transferSaveChunk: (handle: string, bytes: Uint8Array) => tauriInvoke<void>('transfer_save_chunk', bytes, { headers: { 'x-save-handle': handle } }),
  /** Verifies size + SHA-256 then moves the file into place; returns the saved file name. */
  transferSaveFinish: (handle: string) => tauriInvoke<string>('transfer_save_finish', { handle }),
  transferSaveAbort: (handle: string) => tauriInvoke<void>('transfer_save_abort', { handle }),
};
