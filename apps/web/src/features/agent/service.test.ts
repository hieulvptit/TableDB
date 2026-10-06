import { DEFAULT_RUNTIME } from './runtimeConfig';
import { describe, expect, it, vi } from 'vitest';
import type { AgentChatBody } from '@vnpay/shared';
import type { AgentHttp, AgentHttpRequest } from './harness/bridge';
import { parseRpc } from './harness/openmetadata';
import { getPath, renderTemplate, toWire } from './harness/llm';
import { AgentService, KEYS, extractSql, type AgentConfig, type SecretStore } from './service';
import { PERSONAL_TEMPLATES } from './personalTemplates';

const CONFIG: AgentConfig = {
 runtime: DEFAULT_RUNTIME,
  endpoints: [{ id: 'gw', label: 'Gateway', baseUrl: 'https://genai.example.vn/v1', models: ['m1', 'm2'] }],
  defaultEndpointId: 'gw', defaultModel: 'm1', budgetChars: 12_000, openMetadataEnabled: true,
};

function vault(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); }, delete: async (k) => { data.delete(k); } };
}

const completion = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });
const ok = (body: string, extra: object = {}) => ({ status: 200, contentType: 'application/json', body, ...extra });

interface Rig { svc: AgentService; secrets: ReturnType<typeof vault>; reqs: AgentHttpRequest[]; audits: Array<Record<string, unknown>> }
function rig(handler: (r: AgentHttpRequest, signal?: AbortSignal) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>, config: AgentConfig = CONFIG): Rig {
  const secrets = vault();
  const reqs: AgentHttpRequest[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const http: AgentHttp = async (r, signal) => { reqs.push(r); return handler(r, signal); };
  return { svc: new AgentService({ http, config: async () => config, secrets, audit: (b) => audits.push(b) }), secrets, reqs, audits };
}

const body = (over: Partial<AgentChatBody> = {}): AgentChatBody => ({
  connectionId: 'c1', dialect: 'postgresql', connectionName: 'prod', selectedCatalog: null, selectedSchema: 'public', selectedTables: [{ schema: 'public', name: 'orders' }],
  accessible: [{ schema: 'public', name: 'orders', columns: [{ name: 'id', typeName: 'int4' }, { name: 'total', typeName: 'numeric' }], primaryKey: ['id'] }],
  expandRelated: false, messages: [{ role: 'user', content: 'tổng doanh thu?' }], useOpenMetadata: true, plain: false, ...over,
});
const configured = async (r: Rig) => { r.secrets.data.set(KEYS.llmToken, 'tok-12345678'); r.secrets.data.set(KEYS.llmMeta, JSON.stringify({ endpointId: 'gw', model: 'm1', lastVerifiedAt: '2026-01-01T00:00:00Z' })); };

describe('token and settings (local)', () => {
  it('lists endpoints from the local config without base URLs', async () => {
    const s = await rig(() => ok('{}')).svc.settings();
    expect(s.endpoints).toEqual([{ id: 'gw', label: 'Gateway', models: ['m1', 'm2'] }]);
    expect(s.defaultModel).toBe('m1');
    expect(s.openMetadataEnabled).toBe(true);
  });

  it('verifies a token against the chosen endpoint before storing it, then reports state without exposing the token', async () => {
    const r = rig(() => ok(completion('pong')));
    expect(await r.svc.tokenState()).toEqual({ configured: false });
    await r.svc.saveToken({ token: ' tok-12345678 ', endpointId: 'gw', model: 'm2' });
    expect(r.reqs[0]).toMatchObject({ target: { kind: 'llm', endpointId: 'gw' }, path: '/chat/completions', token: 'tok-12345678' });
    expect(JSON.parse(r.reqs[0]!.body!)).toMatchObject({ model: 'm2', max_tokens: 1 });
    expect(r.secrets.data.get(KEYS.llmToken)).toBe('tok-12345678');
    expect(await r.svc.tokenState()).toMatchObject({ configured: true, endpointId: 'gw', model: 'm2' });
    expect(JSON.stringify(await r.svc.tokenState())).not.toContain('tok-1234');
    await r.svc.deleteToken();
    expect(r.secrets.data.size).toBe(0);
  });

  it('rejects unknown endpoint/model, short tokens and a token the gateway refuses (nothing is stored)', async () => {
    const r = rig((q) => (q.token === 'bad-token-xx' ? { status: 401, contentType: '', body: '' } : ok('{}')));
    await expect(r.svc.saveToken({ token: 'tok-12345678', endpointId: 'nope', model: 'm1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(r.svc.saveToken({ token: 'tok-12345678', endpointId: 'gw', model: 'zzz' })).rejects.toMatchObject({ message: 'model not allowed for endpoint' });
    await expect(r.svc.saveToken({ token: 'short', endpointId: 'gw', model: 'm1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(r.svc.saveToken({ token: 'bad-token-xx', endpointId: 'gw', model: 'm1' })).rejects.toMatchObject({ message: expect.stringContaining('endpoint answered 401') });
    expect(r.secrets.data.size).toBe(0);
  });

  it('OpenMetadata token: validated through MCP, needs a read-only tool, stored only then', async () => {
    const mcp = (tools: string[]) => (q: AgentHttpRequest) => {
      const m = JSON.parse(q.body!) as { id?: number; method: string };
      if (m.method === 'tools/list') return ok(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: tools.map((name) => ({ name })) } }));
      return ok(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }));
    };
    const none = rig(mcp(['patch_entity']));
    await expect(none.svc.saveOmToken('om-token-12')).rejects.toMatchObject({ message: expect.stringContaining('none of the supported read-only tools') });
    expect(none.secrets.data.size).toBe(0);
    const good = rig(mcp(['search_metadata', 'patch_entity']));
    expect(await good.svc.saveOmToken('om-token-12')).toEqual({ ok: true, tools: ['search_metadata'] });
    expect(good.reqs.every((q) => q.target.kind === 'om')).toBe(true);
    expect(await good.svc.omState()).toMatchObject({ enabled: true, configured: true });
    const off = rig(mcp(['search_metadata']), { ...CONFIG, openMetadataEnabled: false });
    await expect(off.svc.saveOmToken('om-token-12')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('chat (local harness)', () => {
  it('runs a selected personal specialist through the provider without initializing disallowed OpenMetadata', async () => {
    const template = PERSONAL_TEMPLATES[0]!;
    let calls = 0;
    const r = rig((request) => {
      const messages = JSON.parse(request.body!).messages as Array<{ role: string; content: string }>;
      expect(request.target.kind).toBe('llm');
      expect(messages[0]!.content).not.toContain(template.agent.instructions);
      if (++calls === 1) {
        expect(messages[1]!.content).toContain(template.agent.instructions);
        return ok(completion('```tool\n{"tool":"load_personal_skill","arguments":{"name":"personal:transaction-reconciliation"}}\n```'));
      }
      expect(messages.at(-1)!.content).toContain('DECIMAL/NUMERIC');
      return ok(completion('Đây là quy trình đối soát.'));
    });
    await configured(r); r.secrets.data.set(KEYS.omMeta, '{"lastVerifiedAt":"x"}');
    const result = await r.svc.chat(body({ personalSkills: [template.skill], personalAgents: [template.agent], agentName: template.agent.name }));
    expect(result.reply).toBe('Đây là quy trình đối soát.');
    expect(r.audits.at(-1)).toMatchObject({ personalAgent: 'reconciliation', personalSkillCount: 1 });
    expect(r.reqs).toHaveLength(2);
  });

  it('rejects an unavailable selected specialist and does not apply profiles to summaries', async () => {
    const template = PERSONAL_TEMPLATES[0]!;
    const r = rig(() => ok(completion('summary'))); await configured(r);
    await expect(r.svc.chat(body({ agentName: template.agent.name }))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(r.reqs).toHaveLength(0);
    await r.svc.chat(body({ plain: true, personalSkills: [template.skill], personalAgents: [template.agent], agentName: template.agent.name }));
    expect(r.reqs[0]!.body).not.toContain(template.agent.instructions);
    expect(r.reqs[0]!.body).not.toContain('load_personal_skill');
  });
  it('records first streamed text latency, LLM time and cumulative input size', async () => {
    vi.useFakeTimers();
    try {
      const secrets = vault();
      secrets.data.set(KEYS.llmMeta, '{"endpointId":"gw","model":"m1","lastVerifiedAt":"x"}');
      const audits: Array<Record<string, unknown>> = [];
      const first = 'data: {"choices":[{"index":0,"delta":{"content":"Xin "}}]}\n\n';
      const last = 'data: {"choices":[{"index":0,"delta":{"content":"chào"}}]}\n\ndata: [DONE]\n\n';
      const http: AgentHttp = async (_req, _signal, onChunk) => {
        vi.advanceTimersByTime(20); onChunk?.(first);
        vi.advanceTimersByTime(30);
        return { status: 200, contentType: 'text/event-stream', body: first + last };
      };
      const svc = new AgentService({ http, secrets, config: async () => CONFIG, audit: (record) => audits.push(record) });
      const live: string[] = [];
      expect((await svc.chat(body(), undefined, undefined, (text) => live.push(text))).reply).toBe('Xin chào');
      expect(live).toEqual(['Xin ', 'Xin chào']);
      expect(audits.at(-1)?.timing).toMatchObject({ firstTextMs: 20, durationMs: 50, llmMs: 50 });
      expect((audits.at(-1)?.timing as { inputChars: number }).inputChars).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });
  it('bounds OpenMetadata initialization by the whole-run deadline', async () => {
    vi.useFakeTimers();
    try {
      let pendingSignal: AbortSignal | undefined;
      const r = rig((_q, signal) => { pendingSignal = signal; return new Promise(() => {}); }, {
        ...CONFIG, runtime: { ...DEFAULT_RUNTIME, harness: { ...DEFAULT_RUNTIME.harness, deadlineMs: 50 } },
      });
      await configured(r); r.secrets.data.set(KEYS.omMeta, '{"lastVerifiedAt":"x"}');
      const rejected = expect(r.svc.chat(body())).rejects.toThrow('deadline');
      await vi.advanceTimersByTimeAsync(50); await rejected;
      expect(pendingSignal?.aborted).toBe(true);
      expect(r.reqs.every((q) => q.target.kind === 'om')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('propagates cancellation into an OpenMetadata tool request', async () => {
    const ctrl = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const r = rig((q, signal) => {
      if (q.target.kind === 'llm') return ok(completion('```tool\n{"tool":"search_metadata","arguments":{"q":"orders"}}\n```'));
      const m = JSON.parse(q.body!) as { id: number; method: string };
      if (m.method === 'tools/list') return ok(JSON.stringify({ id: m.id, result: { tools: [{ name: 'search_metadata' }] } }));
      if (m.method === 'tools/call') {
        toolSignal = signal; ctrl.abort();
        return new Promise(() => {});
      }
      return ok(JSON.stringify({ id: m.id, result: {} }));
    });
    await configured(r); r.secrets.data.set(KEYS.omMeta, '{"lastVerifiedAt":"x"}');
    await expect(r.svc.chat(body(), undefined, ctrl.signal)).rejects.toThrow('cancelled');
    expect(toolSignal?.aborted).toBe(true);
  });

  it('reuses the MCP handshake/catalog briefly and invalidates on config, credential and TTL changes', async () => {
    vi.useFakeTimers();
    try {
      const config = { ...CONFIG, openMetadataRevision: 'server-a' };
      const r = rig((q) => {
        if (q.target.kind === 'llm') return ok(completion('answer'));
        const m = JSON.parse(q.body!) as { id: number; method: string };
        return ok(JSON.stringify({ id: m.id, result: m.method === 'tools/list' ? { tools: [{ name: 'search_metadata' }] } : {} }));
      }, config);
      await configured(r); r.secrets.data.set(KEYS.omMeta, '{"lastVerifiedAt":"x"}');
      const handshakes = () => r.reqs.filter((q) => q.target.kind === 'om' && JSON.parse(q.body!).method === 'initialize').length;
      await r.svc.chat(body()); await r.svc.chat(body());
      expect(handshakes()).toBe(1);
      config.openMetadataRevision = 'server-b'; await r.svc.chat(body());
      expect(handshakes()).toBe(2);
      await vi.advanceTimersByTimeAsync(60_001); await r.svc.chat(body());
      expect(handshakes()).toBe(3);
      r.secrets.data.set(KEYS.omMeta, '{"lastVerifiedAt":"new"}'); await r.svc.chat(body());
      expect(handshakes()).toBe(4);
      await r.svc.deleteOmToken(); await r.svc.chat(body());
      expect(handshakes()).toBe(4);
    } finally { vi.useRealTimers(); }
  });
  it('needs a stored token', async () => {
    await expect(rig(() => ok('{}')).svc.chat(body())).rejects.toMatchObject({ message: 'no LLM token configured' });
  });

  it('runs the loop, fences metadata into the first user turn, classifies SQL and audits metadata only', async () => {
    const r = rig(() => ok(completion('Tổng:\n```sql\nSELECT SUM(total) FROM public.orders\n```\n```sql\nDELETE FROM public.orders\n```')));
    await configured(r);
    const trace: string[] = [];
    const res = await r.svc.chat(body({ dataContext: '- Doanh thu = SUM(total) của đơn SUCCESS' }), (e) => trace.push(e.kind));
    expect(res.reply).toContain('SELECT SUM(total)');
    expect(res.sql.map((s) => s.kind)).toEqual(['read', 'write']);
    expect(res.manifest.included).toEqual([expect.objectContaining({ schema: 'public', table: 'orders' })]);
    expect(trace).toContain('thinking');
    const sent = JSON.parse(r.reqs[0]!.body!) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(sent.model).toBe('m1');
    expect(sent.messages[0]!.role).toBe('system');
    expect(sent.messages[1]!.content).toMatch(/^<<DATA-[0-9a-f]+>>[\s\S]*TABLE public\.orders[\s\S]*<<BUSINESS-CONTEXT-[0-9a-f]+>>[\s\S]*Doanh thu[\s\S]*tổng doanh thu\?$/);
    expect(r.reqs[0]!.token).toBeUndefined(); // the stored credential is attached in Rust, never read here
    const a = r.audits.at(-1)!;
    expect(a).toMatchObject({ action: 'agent.chat', ok: true, connectionId: 'c1', model: 'm1', tables: ['public.orders'], suggestedSql: ['read', 'write'], businessContext: true });
    // the Q&A is kept for the trail; SQL only with literals masked; no table data
    expect(a).toMatchObject({ question: 'tổng doanh thu?' });
    expect(String(a.answer)).toContain('SELECT SUM(total)');
    expect(a.sqlMasked).toEqual(['SELECT SUM(total) FROM public.orders', 'DELETE FROM public.orders']);
  });

  it('endpoint/model chosen per message must be allowed; images only on the last user turn', async () => {
    const r = rig(() => ok(completion('ok')));
    await configured(r);
    await expect(r.svc.chat(body({ model: 'zzz' }))).rejects.toMatchObject({ message: 'model not allowed for endpoint' });
    const img = 'data:image/png;base64,AAAA';
    await r.svc.chat(body({ model: 'm2', messages: [{ role: 'user', content: 'a', images: [img] }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c', images: [img] }] }));
    const sent = JSON.parse(r.reqs[0]!.body!) as { model: string; messages: Array<{ content: unknown }> };
    expect(sent.model).toBe('m2');
    expect(typeof sent.messages[1]!.content).toBe('string'); // first user turn lost its image
    expect(Array.isArray(sent.messages.at(-1)!.content)).toBe(true);
  });

  it('plain mode: one call, no metadata, no tools', async () => {
    const r = rig(() => ok(completion('tóm tắt')));
    await configured(r);
    const res = await r.svc.chat(body({ plain: true }));
    expect(res).toMatchObject({ reply: 'tóm tắt', trace: [], sql: [] });
    expect(r.reqs).toHaveLength(1);
    expect(r.reqs[0]!.body).not.toContain('TABLE public.orders');
    expect(r.audits.at(-1)).toMatchObject({ plain: true, ok: true });
  });

  it('degrades to the harness without OpenMetadata when the MCP server fails', async () => {
    const r = rig((q) => (q.target.kind === 'om' ? { status: 500, contentType: '', body: '' } : ok(completion('answer'))));
    await configured(r);
    r.secrets.data.set(KEYS.omMeta, JSON.stringify({ lastVerifiedAt: 'x' }));
    const res = await r.svc.chat(body());
    expect(res.reply).toBe('answer');
    expect(r.audits.at(-1)).toMatchObject({ openMetadata: { available: false, used: false } });
  });

  it('uses OpenMetadata tools with the user token when available and records that they were used', async () => {
    let llmCalls = 0;
    const r = rig((q) => {
      if (q.target.kind === 'om') {
        const m = JSON.parse(q.body!) as { id?: number; method: string };
        if (m.method === 'tools/list') return ok(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search_metadata', description: 'find' }, { name: 'delete_entity' }] } }));
        if (m.method === 'tools/call') return ok(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'orders: revenue table' }] } }));
        return ok(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }));
      }
      llmCalls++;
      return ok(completion(llmCalls === 1 ? '```tool\n{"tool":"search_metadata","arguments":{"q":"orders"}}\n```' : 'đã tra cứu'));
    });
    await configured(r);
    r.secrets.data.set(KEYS.omMeta, JSON.stringify({ lastVerifiedAt: 'x' }));
    const res = await r.svc.chat(body());
    expect(res.reply).toBe('đã tra cứu');
    expect(res.toolCalls).toEqual([{ tool: 'search_metadata', ok: true, depth: 0 }]);
    expect(r.audits.at(-1)).toMatchObject({ openMetadata: { available: true, used: true } });
    const second = JSON.parse(r.reqs.filter((q) => q.target.kind === 'llm')[1]!.body!) as { messages: Array<{ content: string }> };
    expect(second.messages.at(-1)!.content).toMatch(/<<TOOL-RESULT-[0-9a-f]+ id=1 tool=search_metadata>>\norders: revenue table/);
    const sys = (JSON.parse(r.reqs.find((q) => q.target.kind === 'llm')!.body!) as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(sys).not.toContain('delete_entity');
  });

  it('LLM failures are audited and surfaced; 401 maps to a token error', async () => {
    const r = rig(() => ({ status: 401, contentType: '', body: '' }));
    await configured(r);
    await expect(r.svc.chat(body())).rejects.toMatchObject({ message: 'LLM token rejected' });
    expect(r.audits.at(-1)).toMatchObject({ action: 'agent.chat', ok: false });
    const down = rig(() => ({ status: 503, contentType: '', body: '' }));
    await configured(down);
    await expect(down.svc.chat(body())).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('refuses unconfirmed rows and a last message that is not from the user', async () => {
    const r = rig(() => ok(completion('x')));
    await configured(r);
    await expect(r.svc.chat(body({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }))).rejects.toMatchObject({ message: 'last message must be from user' });
    await expect(r.svc.chat(body({ rows: { confirmed: false as unknown as true, columns: ['a'], rows: [[1]] } }))).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('cancellation reaches the transport', async () => {
    const ctrl = new AbortController();
    const r = rig(() => ok(completion('x')));
    await configured(r);
    ctrl.abort();
    await expect(r.svc.chat(body(), undefined, ctrl.signal)).rejects.toThrow('cancelled');
  });
});

describe('helpers', () => {
  it('extractSql classifies fenced sql blocks only', () => {
    expect(extractSql('a\n```sql\nSELECT 1; SELECT 2\n```\n```js\nx\n```\n```sql\n\n```')).toEqual([{ sql: 'SELECT 1; SELECT 2', kind: 'other', multi: true }]); // a multi-statement block is never 'read'
  });
  it('template rendering follows JSON.stringify semantics', () => {
    expect(renderTemplate({ a: '{{x}}', b: '{{missing}}', c: ['{{missing}}', 'p {{x}} q'], d: 'n={{ n }}' }, { x: 1, n: 5 })).toEqual({ a: 1, c: [null, 'p 1 q'], d: 'n=5' });
    expect(getPath({ choices: [{ message: { content: 'hi' } }] }, 'choices.0.message.content')).toBe('hi');
    expect(getPath({ a: [] }, 'a.0')).toBeUndefined();
    expect(toWire({ role: 'user', content: 'x', images: ['data:image/png;base64,AA'] })).toEqual({ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] });
  });
  it('MCP replies: JSON or SSE, matched by id', () => {
    expect(parseRpc('{"jsonrpc":"2.0","id":2,"result":{"ok":1}}', 'application/json', 2).result).toEqual({ ok: 1 });
    expect(parseRpc('event: message\ndata: {"jsonrpc":"2.0","method":"ping"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"x":1}}\n\n', 'text/event-stream', 3).result).toEqual({ x: 1 });
    expect(() => parseRpc('{"id":9}', 'application/json', 1)).toThrow(/unexpected OpenMetadata MCP response/);
  });
});

describe('audit text', () => {
  it('redacts sensitive patterns and is bounded; SQL literals are masked; rows/images/tokens never go to the audit', async () => {
    const { auditText } = await import('./service');
    expect(auditText('mail a@b.co thẻ 4111 1111 1111 1111')).not.toMatch(/a@b\.co|4111/);
    expect(auditText('x'.repeat(5000))).toHaveLength(2000);
    const r = rig(() => ok(completion('```sql\nSELECT * FROM public.orders WHERE phone = \'0912345678\'\n```')));
    await configured(r);
    await r.svc.chat(body({ messages: [{ role: 'user', content: 'tra số 0912345678', images: ['data:image/png;base64,AAAA'] }], rows: { confirmed: true, columns: ['secret'], rows: [['VALUE-XYZ']] } }));
    const a = JSON.stringify(r.audits.at(-1));
    expect(a).not.toContain('VALUE-XYZ');
    expect(a).not.toContain('base64');
    expect(a).not.toContain('0912345678'); // masked SQL literal; phone redacted in Q&A
  });
});

it('uses server LLM parameters, timeout and Agent budget for a run', async () => {
 const config = structuredClone(CONFIG);
 config.runtime.llm.chat.body = { model: '{{model}}', messages: '{{allMessages}}', max_tokens: 1234, temperature: 0.7 };
 config.runtime.llm.timeoutSec = 77;
 config.runtime.harness.maxLlmCalls = 2;
 config.runtime.harness.maxParallel = 1;
 const r = rig(() => ok(completion('done')), config);
 await configured(r);
 await r.svc.chat(body({ useOpenMetadata: false }));
 const request = r.reqs.find(x => x.target.kind === 'llm')!;
 expect(JSON.parse(request.body!)).toMatchObject({ max_tokens: 1234, temperature: 0.7 });
 expect(request.timeoutSec).toBe(77);
});
