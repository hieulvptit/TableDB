// The Agent, fully local (desktop). Everything the server used to do for /agent/* happens here: settings come from the local
// config.json (via Rust), tokens live in the OS credential store (write-only from the webview), the LLM / OpenMetadata
// calls go through the Rust HTTP bridge, and the tool loop runs in the harness. Only a metadata-only audit record leaves the machine.
import { AgentChatBody, attachRows, buildAgentContext, classifySql, maskSql, redactText, type BuiltContext, type ContextManifest } from '@vnpay/shared';
import { ApiError } from '../../api/errors';
import type { AgentChatResult, AgentSettings, AgentSqlBlock, AgentTokenState, OpenMetadataTokenState } from '../../api/types';
import { tauriAgentHttp, type AgentHttp } from './harness/bridge';
import { sanitizeBlock, type ChatMsg, type ContextProposal, type TraceEvent } from './harness/harness';
import { LlmProvider, type LlmEndpoint } from './harness/llm';
import { allowedOMTools, openMcp } from './harness/openmetadata';
import { runAgent, type OMSession } from './harness/orchestrator';
import type { PreviewBody } from './context';

export const HARD_BUDGET = 30_000;
export const DEFAULT_BUDGET = 12_000;

/** What Rust returns from the local config.json `agent` section. */
export interface AgentConfig {
  endpoints: LlmEndpoint[];
  defaultEndpointId: string | null;
  defaultModel: string | null;
  budgetChars: number;
  openMetadataEnabled: boolean;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Tokens are write-only from the webview (Rust refuses `secret_get` for these); the metadata next to them is not secret. */
export const KEYS = { llmToken: 'agent:token:llm', llmMeta: 'agent:meta:llm', omToken: 'agent:token:om', omMeta: 'agent:meta:om' } as const;

export interface AgentAuditRecord { [k: string]: unknown }
export interface AgentServiceDeps {
  http?: AgentHttp;
  config: () => Promise<AgentConfig>;
  secrets: SecretStore;
  audit?: (body: AgentAuditRecord) => void;
}

interface LlmMeta { endpointId: string; model: string; lastVerifiedAt: string }
interface OmMeta { lastVerifiedAt: string }

export type SqlSuggestion = AgentSqlBlock;
const SQL_FENCE = /```sql\s*\n([\s\S]*?)```/gi;

/** Fenced ```sql blocks of a reply, classified (nothing is ever executed by the Agent). */
export function extractSql(reply: string): SqlSuggestion[] {
  const out: SqlSuggestion[] = [];
  for (const m of reply.matchAll(SQL_FENCE)) {
    const sql = m[1]!.trim();
    if (!sql) continue;
    const c = classifySql(sql);
    out.push({ sql, kind: c.kind, multi: c.multi });
  }
  return out;
}

/** Audit copy of a question/answer: redacted and bounded. */
export const auditText = (s: string) => redactText(s).slice(0, 2000);
const validation = (m: string) => new ApiError('VALIDATION', m, 400);
const readJson = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

export class AgentService {
  private http: AgentHttp;
  private llm: LlmProvider;
  constructor(private d: AgentServiceDeps) {
    this.http = d.http ?? tauriAgentHttp;
    this.llm = new LlmProvider(this.http);
  }

  private async cfg(): Promise<AgentConfig> {
    const c = await this.d.config();
    return { ...c, endpoints: c.endpoints ?? [], budgetChars: Math.min(HARD_BUDGET, Math.max(1000, c.budgetChars || DEFAULT_BUDGET)) };
  }

  private async endpointAndModel(endpointId: string, model: string): Promise<LlmEndpoint> {
    const ep = (await this.cfg()).endpoints.find((e) => e.id === endpointId);
    if (!ep) throw validation('unknown endpoint');
    if (!ep.models.includes(model)) throw validation('model not allowed for endpoint');
    return ep;
  }

  async settings(): Promise<AgentSettings> {
    const c = await this.cfg();
    return {
      endpoints: c.endpoints.map((e) => ({ id: e.id, label: e.label, models: e.models, ...(e.description ? { description: e.description } : {}) })),
      defaultEndpointId: c.defaultEndpointId ?? '', defaultModel: c.defaultModel ?? '', budgetChars: c.budgetChars, openMetadataEnabled: c.openMetadataEnabled,
    };
  }

  private async llmMeta(): Promise<LlmMeta | null> {
    const m = readJson<LlmMeta>(await this.d.secrets.get(KEYS.llmMeta));
    return m && m.endpointId && m.model ? m : null;
  }

  async tokenState(): Promise<AgentTokenState> {
    const m = await this.llmMeta();
    return m ? { configured: true, endpointId: m.endpointId, model: m.model, lastVerifiedAt: m.lastVerifiedAt } : { configured: false };
  }

  async saveToken(b: { token: string; endpointId: string; model: string }): Promise<{ ok: boolean }> {
    const token = b.token.trim();
    if (token.length < 8 || token.length > 4000) throw validation('token must be 8-4000 characters');
    const ep = await this.endpointAndModel(b.endpointId, b.model);
    const v = await this.llm.verify(ep, b.model, token);
    if (!v.ok) throw validation('token verification failed: ' + (v.reason || 'rejected'));
    await this.d.secrets.set(KEYS.llmToken, token);
    await this.d.secrets.set(KEYS.llmMeta, JSON.stringify({ endpointId: b.endpointId, model: b.model, lastVerifiedAt: new Date().toISOString() } satisfies LlmMeta));
    this.d.audit?.({ action: 'agent.token.set', endpointId: b.endpointId, model: b.model });
    return { ok: true };
  }

  async verify(): Promise<{ ok: boolean; reason?: string }> {
    const m = await this.llmMeta();
    if (!m) throw validation('no LLM token configured');
    const ep = await this.endpointAndModel(m.endpointId, m.model);
    const v = await this.llm.verify(ep, m.model);
    if (v.ok) await this.d.secrets.set(KEYS.llmMeta, JSON.stringify({ ...m, lastVerifiedAt: new Date().toISOString() }));
    return v;
  }

  async deleteToken(): Promise<{ ok: boolean }> {
    await this.d.secrets.delete(KEYS.llmToken);
    await this.d.secrets.delete(KEYS.llmMeta);
    this.d.audit?.({ action: 'agent.token.delete' });
    return { ok: true };
  }

  async omState(): Promise<OpenMetadataTokenState> {
    const [c, m] = await Promise.all([this.cfg(), this.d.secrets.get(KEYS.omMeta)]);
    const meta = readJson<OmMeta>(m);
    return { enabled: c.openMetadataEnabled, configured: !!meta, lastVerifiedAt: meta?.lastVerifiedAt ?? null };
  }

  async saveOmToken(token0: string): Promise<{ ok: boolean; tools: string[] }> {
    const token = token0.trim();
    if (token.length < 8 || token.length > 4000) throw validation('token must be 8-4000 characters');
    if (!(await this.cfg()).openMetadataEnabled) throw validation('OpenMetadata is not configured (config.json agent.openMetadataUrl)');
    const session = await openMcp(this.http, token);
    const tools = allowedOMTools(await session.listTools());
    if (tools.length === 0) throw validation('OpenMetadata MCP exposes none of the supported read-only tools');
    await this.d.secrets.set(KEYS.omToken, token);
    await this.d.secrets.set(KEYS.omMeta, JSON.stringify({ lastVerifiedAt: new Date().toISOString() } satisfies OmMeta));
    const names = tools.map((t) => t.name);
    this.d.audit?.({ action: 'agent.openmetadata.token.set', tools: names });
    return { ok: true, tools: names };
  }

  async deleteOmToken(): Promise<{ ok: boolean }> {
    await this.d.secrets.delete(KEYS.omToken);
    await this.d.secrets.delete(KEYS.omMeta);
    this.d.audit?.({ action: 'agent.openmetadata.token.delete' });
    return { ok: true };
  }

  private build(b: PreviewBody, metadataTools: boolean, budget: number): BuiltContext {
    let built = buildAgentContext({
      dialect: b.dialect, connectionName: b.connectionName, selectedCatalog: b.selectedCatalog, selectedSchema: b.selectedSchema,
      selectedTables: b.selectedTables, accessible: b.accessible, expandRelated: b.expandRelated, budgetChars: Math.min(budget, HARD_BUDGET), metadataTools,
    });
    if (b.rows) {
      try { built = attachRows(built, { columns: b.rows.columns, rows: b.rows.rows }, { confirmed: b.rows.confirmed, maxRows: 20 }); }
      catch (e) { throw validation(e instanceof Error ? e.message : 'rows rejected'); }
    }
    return built;
  }

  async preview(body: PreviewBody): Promise<{ manifest: ContextManifest }> {
    const parsed = AgentChatBody.omit({ messages: true }).safeParse(body);
    if (!parsed.success) throw validation(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return { manifest: this.build(parsed.data, false, (await this.cfg()).budgetChars).manifest };
  }

  /** Runs the whole chat locally. `onTrace` receives every live step. */
  async chat(body: AgentChatBody, onTrace?: (e: TraceEvent) => void, signal?: AbortSignal): Promise<AgentChatResult> {
    const parsed = AgentChatBody.safeParse(body);
    if (!parsed.success) throw validation(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const b = parsed.data;
    const last = b.messages[b.messages.length - 1]!;
    if (last.role !== 'user') throw validation('last message must be from user');
    const messages: ChatMsg[] = b.messages.map((m, i) => ({ role: m.role, content: m.content, ...(i === b.messages.length - 1 && m.images?.length ? { images: m.images } : {}) }));

    const meta = await this.llmMeta();
    if (!meta) throw validation('no LLM token configured');
    // the token is valid on every configured endpoint, so the popup may switch endpoint/model per message
    const endpointId = b.endpointId || meta.endpointId;
    const model = b.model || meta.model;
    const ep = await this.endpointAndModel(endpointId, model);
    const cfg = await this.cfg();
    const llmChat = (ms: ChatMsg[], sig?: AbortSignal) => this.llm.chat(ep, model, ms, sig);
    const audit = (detail: AgentAuditRecord) => this.d.audit?.({ action: 'agent.chat', connectionId: b.connectionId, ...detail });
    const fail = (cause: unknown): never => { audit({ ok: false, endpointId: ep.id, model }); throw cause; };

    if (b.plain) { // conversation summaries: one call, no metadata, no tools
      const built = this.build({ ...b, accessible: [], selectedTables: [] }, false, cfg.budgetChars);
      let text: string;
      try { text = await llmChat([{ role: 'system', content: built.system }, ...messages], signal); } catch (e) { return fail(e); }
      audit({ ok: true, plain: true, endpointId: ep.id, model, replyChars: text.length });
      return { reply: text, sql: [], manifest: built.manifest, toolCalls: [], trace: [], proposals: [], ask: null };
    }

    // OpenMetadata tools only if configured in config.json, the user stored a token and the server exposes allow-listed read-only tools;
    // any failure degrades to the harness without OpenMetadata.
    let om: OMSession | null = null;
    const omConfigured = cfg.openMetadataEnabled && b.useOpenMetadata;
    if (omConfigured && (await this.d.secrets.get(KEYS.omMeta))) {
      try {
        const session = await openMcp(this.http, undefined, signal);
        const tools = allowedOMTools(await session.listTools(signal));
        if (tools.length > 0) om = { session, tools };
      } catch (e) { if (signal?.aborted) throw e; /* degrade */ }
    }

    const built = this.build(b, true, cfg.budgetChars);
    // Untrusted metadata and the user's saved notes go into the first user turn inside nonce-fenced data blocks; the system prompt is fixed text.
    const notes = b.dataContext ? sanitizeBlock(b.dataContext, 4000) : '';
    let prefix = built.contextBlock;
    if (notes) prefix += `\n<<BUSINESS-CONTEXT-${built.nonce}>>\n${notes}\n<<END-BUSINESS-CONTEXT-${built.nonce}>>`;
    const history = messages.map((m) => ({ ...m }));
    if (history[0]!.role === 'user') history[0]!.content = `${prefix}\n\n${history[0]!.content}`;
    else history.unshift({ role: 'user', content: prefix });

    let run;
    try {
      run = await runAgent({ chat: llmChat, baseSystem: built.system, contextBlock: built.contextBlock, nonce: built.nonce, dialect: b.dialect, history, om, signal, onEvent: onTrace });
    } catch (e) { return fail(e); }

    const sql = extractSql(run.text);
    const detail: AgentAuditRecord = {
      ok: true, endpointId: ep.id, model, promptChars: built.system.length + history.reduce((n, m) => n + m.content.length, 0), replyChars: run.text.length,
      tables: built.manifest.included.map((t) => `${t.schema}.${t.table}`), denied: built.manifest.denied.length, rows: built.manifest.rowsIncluded ? built.manifest.rowsIncluded.count : 0,
      suggestedSql: sql.map((s) => s.kind), sqlMasked: sql.slice(0, 5).map((s) => maskSql(s.sql).slice(0, 1000)),
      // Q&A for the audit trail: redacted, bounded; never row data, images or tokens (the server redacts again)
      question: auditText(last.content), answer: auditText(run.text), businessContext: notes !== '', asked: run.asked !== null, contextProposals: run.proposals.length, images: last.images?.length ?? 0,
      harness: { llmCalls: run.stats.llmCalls, toolCalls: run.stats.toolCalls, trace: run.trace.map((e) => `${e.depth}:${e.kind}:${e.name}:${e.ok ? 'ok' : 'fail'}`) },
      ...(omConfigured ? { openMetadata: { available: om !== null, used: run.omUsed } } : {}),
    };
    audit(detail);
    return {
      reply: run.text, sql, manifest: built.manifest, trace: run.trace, proposals: run.proposals as ContextProposal[], ask: run.asked,
      toolCalls: run.trace.filter((e) => e.kind === 'tool' || e.kind === 'subagent').map((e) => ({ tool: e.name, ok: e.ok, depth: e.depth })),
    };
  }
}
