// Minimal MCP client over Streamable HTTP (JSON or SSE replies): initialize / tools/list / tools/call. The credential is the
// user's own OpenMetadata token, attached by the Rust core.
import { sanitizeField } from '@vnpay/shared';
import { ApiError } from '../../../api/errors';
import type { AgentHttp } from './bridge';

export interface McpTool { name: string; description?: string; inputSchema?: unknown }
export interface McpSession {
  listTools(signal?: AbortSignal): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/** The only OpenMetadata tools the Agent may call. Anything else the server lists (create/patch/...) is never offered or executed. */
export const OM_READONLY_TOOLS = ['search_metadata', 'get_entity_details', 'get_entity_lineage'];
export const isReadonlyOM = (name: string) => OM_READONLY_TOOLS.includes(name);
export const allowedOMTools = (listed: McpTool[]) => listed.filter((t) => isReadonlyOM(t.name));

const MCP_PROTOCOL = '2025-03-26';
const upstream = (m: string) => new ApiError('UPSTREAM', m, 502);

interface RpcMsg { id?: number | string; result?: unknown; error?: { message?: unknown } | null }

export function parseRpc(raw: string, contentType: string, id: number): RpcMsg {
  let candidates: string[];
  if (contentType.includes('text/event-stream')) {
    candidates = raw.split(/\r?\n\r?\n/).map((ev) => ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^[ \t\r\n]+/, '')).join('\n')).filter(Boolean);
  } else candidates = [raw];
  for (const c of candidates) {
    try {
      const m = JSON.parse(c) as RpcMsg;
      if (m && (m.id === id || Number(m.id) === id) && m.id !== undefined && m.id !== '') return m;
    } catch { /* not a JSON-RPC message */ }
  }
  throw upstream('unexpected OpenMetadata MCP response');
}

class HttpMcpSession implements McpSession {
  private sessionId = '';
  private nextId = 0;
  constructor(private http: AgentHttp, private token?: string) {}

  private async post(body: unknown, signal?: AbortSignal) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': MCP_PROTOCOL };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let res;
    try { res = await this.http({ target: { kind: 'om' }, method: 'POST', headers, body: JSON.stringify(body), timeoutSec: 30, ...(this.token ? { token: this.token } : {}) }, signal); }
    catch (e) { if (signal?.aborted) throw e; throw upstream('OpenMetadata MCP unreachable'); }
    if (res.status === 401 || res.status === 403) throw new ApiError('VALIDATION', 'OpenMetadata token rejected', 400);
    if (res.status < 200 || res.status > 299) throw upstream(`OpenMetadata MCP HTTP ${res.status}`);
    return res;
  }

  async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.nextId;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    if (res.sessionId) this.sessionId = res.sessionId;
    const msg = parseRpc(res.body, res.contentType, id);
    if (msg.error) {
      const text = msg.error.message !== undefined && msg.error.message !== null ? String(msg.error.message) : 'unknown';
      throw upstream('OpenMetadata MCP error: ' + text.slice(0, 200));
    }
    return msg.result;
  }

  async init(signal?: AbortSignal) {
    await this.rpc('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'vnpay-tabledb', version: '1' } }, signal);
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal).catch(() => undefined); // best effort
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const r = (await this.rpc('tools/list', {}, signal)) as { tools?: unknown } | null;
    return Array.isArray(r?.tools) ? (r!.tools as McpTool[]).filter((t) => t && typeof t.name === 'string') : [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const r = (await this.rpc('tools/call', { name, arguments: args ?? {} }, signal)) as { content?: Array<{ type?: string; text?: unknown }>; isError?: boolean } | null;
    const text = (r?.content ?? []).filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('\n');
    if (r?.isError) throw upstream(`tool ${name} failed: ${sanitizeField(text, 200).text}`);
    return text;
  }
}

/** Opens one MCP session (handshake included). `token` overrides the stored credential (validating a token before saving it). */
export async function openMcp(http: AgentHttp, token?: string, signal?: AbortSignal): Promise<McpSession> {
  const s = new HttpMcpSession(http, token);
  await s.init(signal);
  return s;
}
