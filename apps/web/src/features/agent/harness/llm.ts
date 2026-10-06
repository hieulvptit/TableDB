// LLM provider adapter: auth header, paths, body template and response path come from a mapping; the default is the VNPAY AI
// gateway contract (OpenAI-compatible, genai.vnpay.vn/aigateway/<llm>/v1). The Rust core adds the credential header.
import { CompletionStream } from './stream';
import { ApiError } from '../../../api/errors';
import type { AgentHttp } from './bridge';
import type { ChatMsg } from './harness';

export interface LlmEndpoint { id: string; label: string; baseUrl: string; models: string[]; description?: string }
export interface VerifyResult { ok: boolean; reason?: string }

export interface LlmMapping {
  verify: { method: string; path: string; body?: unknown; okStatus: number[] };
  chat: { method: string; path: string; body: unknown; responsePath: string; extraHeaders?: Record<string, string> };
}

/** Verify is a 1-token completion: the gateway may not expose /models. */
import { DEFAULT_RUNTIME } from '../runtimeConfig';
export const VNPAY_GATEWAY_MAPPING: LlmMapping = DEFAULT_RUNTIME.llm;

/** OpenAI-compatible wire form: a message with images becomes a content-part array; others stay plain strings. */
export function toWire(m: ChatMsg): Record<string, unknown> {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return { role: m.role, content: [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))] };
}

const WHOLE = /^\{\{\s*(\w+)\s*\}\}$/;
const VAR = /\{\{\s*(\w+)\s*\}\}/g;
const UNDEF = Symbol('undefined');

function render(t: unknown, vars: Record<string, unknown>): unknown {
  if (typeof t === 'string') {
    const m = WHOLE.exec(t);
    if (m) return Object.prototype.hasOwnProperty.call(vars, m[1]!) ? vars[m[1]!] : UNDEF;
    return t.replace(VAR, (_s, k: string) => { const v = vars[k]; return v === undefined || v === null ? '' : String(v); });
  }
  if (Array.isArray(t)) return t.map((e) => { const r = render(e, vars); return r === UNDEF ? null : r; });
  if (t && typeof t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(t)) { const r = render(e, vars); if (r !== UNDEF) out[k] = r; }
    return out;
  }
  return t;
}
export function renderTemplate(t: unknown, vars: Record<string, unknown>): unknown { const v = render(t, vars); return v === UNDEF ? null : v; }

export function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split('.')) {
    if (Array.isArray(cur)) { const i = /^\d+$/.test(k) ? Number(k) : -1; if (i < 0 || i >= cur.length) return undefined; cur = cur[i]; }
    else if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, k)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

export class LlmProvider {
  constructor(private http: AgentHttp, private mapping: LlmMapping = VNPAY_GATEWAY_MAPPING, private timeoutSec = DEFAULT_RUNTIME.llm.timeoutSec) {}

  /** `token` set = verify that credential; unset = the stored one. */
  async verify(ep: LlmEndpoint, model: string, token?: string, signal?: AbortSignal): Promise<VerifyResult> {
    const m = this.mapping.verify;
    const body = m.body === undefined ? undefined : JSON.stringify(renderTemplate(m.body, { model }));
    let status: number;
    try {
      status = (await this.http({ target: { kind: 'llm', endpointId: ep.id }, method: m.method || 'GET', path: m.path, timeoutSec: this.timeoutSec, ...(body !== undefined ? { body, headers: { 'Content-Type': 'application/json' } } : {}), ...(token ? { token } : {}) }, signal)).status;
    } catch (e) { if (signal?.aborted) throw e; return { ok: false, reason: 'endpoint unreachable' }; }
    return (m.okStatus.length ? m.okStatus : [200]).includes(status) ? { ok: true } : { ok: false, reason: `endpoint answered ${status}` };
  }

  async chat(ep: LlmEndpoint, model: string, messages: ChatMsg[], signal?: AbortSignal, onText?: (text: string) => void): Promise<string> {
    const m = this.mapping.chat;
    const all = messages.map(toWire);
    const system = messages.filter((x) => x.role === 'system').map((x) => x.content).join('\n');
    const rest = messages.filter((x) => x.role !== 'system').map(toWire);
    const rendered = renderTemplate(m.body, { model, system, messages: rest, allMessages: all });
    const streaming = !!onText && m.responsePath === 'choices.0.message.content' && rendered !== null && typeof rendered === 'object' && !Array.isArray(rendered);
    const body = JSON.stringify(streaming ? { ...rendered as Record<string, unknown>, stream: true } : rendered);
    const live = new CompletionStream(onText);
    let streamError: unknown;
    const res = await this.http({ target: { kind: 'llm', endpointId: ep.id }, method: m.method || 'POST', path: m.path, headers: { 'Content-Type': 'application/json', ...(m.extraHeaders ?? {}) }, body, timeoutSec: this.timeoutSec }, signal, streaming ? (chunk) => {
      try { live.push(chunk); } catch (e) { streamError = e; }
    } : undefined);
    if (res.status === 401 || res.status === 403) throw new ApiError('VALIDATION', 'LLM token rejected', 400);
    if (res.status < 200 || res.status > 299) throw new ApiError('UPSTREAM', `LLM endpoint HTTP ${res.status}`, 502);
    if (res.contentType.includes('text/event-stream')) {
      if (streamError) throw streamError;
      // Parse the full response too: completion and event delivery can race across IPC.
      const complete = new CompletionStream();
      complete.push(res.body);
      const text = complete.finish();
      onText?.(text);
      return text;
    }
    let doc: unknown;
    try { doc = JSON.parse(res.body); } catch { throw new ApiError('UPSTREAM', 'unexpected LLM response shape', 502); }
    const v = getPath(doc, m.responsePath);
    if (typeof v !== 'string') throw new ApiError('UPSTREAM', 'unexpected LLM response shape', 502);
    return v;
  }
}
