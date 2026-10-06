// Agent harness (runs entirely in the desktop app): a bounded tool loop over a text protocol (fenced ```tool JSON blocks),
// independent of any provider's function-calling. Port of services/api/internal/agent/harness.go. Mechanisms: shared budget
// with a reserved final answer, parallel tool calls, parse-error feedback, result eviction to a virtual filesystem,
// deterministic context compaction, repeat/failure guards, completion guard for the plan.
import { redactText, sanitizeField } from '@vnpay/shared';

import { DEFAULT_RUNTIME, type HarnessConfig } from '../runtimeConfig';
export const LIMITS = DEFAULT_RUNTIME.harness;

/** Enforces one wall-clock limit, including pending transport/tool calls. */
export async function withDeadline<T>(ms: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => { ctrl.abort(signal?.reason); reject(new Error('cancelled')); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { ctrl.abort(); reject(new Error('Agent deadline exceeded')); }, Math.max(0, ms));
  });
  try {
    if (ctrl.signal.aborted) return await stopped;
    if (ms <= 0) { ctrl.abort(); throw new Error('Agent deadline exceeded'); }
    return await Promise.race([run(ctrl.signal), stopped]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

export interface TraceEvent { kind: 'thinking' | 'tool' | 'subagent' | 'nudge' | 'compact' | 'final'; name: string; ok: boolean; ms: number; depth: number; note?: string }
export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string; images?: string[] }
export type ChatFunc = (messages: ChatMsg[], signal?: AbortSignal, onText?: (text: string) => void) => Promise<string>;
export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface ContextProposal { kind: 'entity' | 'terminology' | 'filter' | 'metric' | 'gotcha'; text: string }
export interface AskUser { question: string; options: string[] }

/** Shared by the orchestrator and its sub-agents. */
export class Budget {
  llmCalls = 0;
  toolCalls = 0;
  cancelled = false;
  readonly deadline: number;
  constructor(readonly maxLlm = LIMITS.maxLlmCalls, readonly maxTools = LIMITS.maxToolCalls, deadlineMs = LIMITS.deadlineMs) { this.deadline = Date.now() + deadlineMs; }
  llmLeft() { return this.maxLlm - this.llmCalls; }
  expired() { return Date.now() >= this.deadline; }
  takeLlm(reserve = 0) { if (this.llmLeft() <= reserve) return false; return ++this.llmCalls; }
  takeTool() { if (this.toolCalls >= this.maxTools) return false; this.toolCalls++; return true; }
}

/** In-memory scratch space for one run: oversized or elided tool results live here and are read back in slices. */
export class Vfs {
  constructor(private limits: HarnessConfig = LIMITS) {}
  private files = new Map<string, string>();
  private order: string[] = [];
  private n = 0;

  put(dir: string, label: string, content: string): string {
    this.n++;
    const path = `/${dir}/${this.n}-${label.replace(/[^\w-]/g, '_').slice(0, 40)}.txt`;
    if (!this.files.has(path)) this.order.push(path);
    this.files.set(path, content.slice(0, this.limits.storeChars));
    return path;
  }

  private resolve(path: string): string {
    if (this.files.has(path)) return path;
    let t = path.trim().replace(/[\s,;:)\]'"]+$/, '');
    while (t !== '') {
      if (this.files.has(t) || !t.endsWith('.')) break;
      t = t.slice(0, -1);
    }
    return this.files.has(t) ? t : path;
  }

  read(path0: string, offset: number, limit: number): string {
    const path = this.resolve(path0);
    const text = this.files.get(path);
    if (text === undefined) return `ERROR: no such file ${path.slice(0, 120)}. Files: ${this.order.slice(0, 20).join(', ') || '(none)'}`;
    const lines = text.split('\n');
    const floor = (f: number, d: number) => (!Number.isFinite(f) || f === 0 ? d : Math.floor(f));
    const start = Math.max(0, floor(offset, 0));
    const lim = Math.min(200, Math.max(1, floor(limit, 100)));
    const end = Math.min(lines.length, start + lim);
    const out: string[] = [];
    let chars = 0;
    let i = start;
    for (; i < end; i++) {
      const row = `${i + 1}\t${lines[i]}`;
      if (chars + row.length > this.limits.readChars) break;
      out.push(row);
      chars += row.length + 1;
    }
    const more = i < lines.length ? `\n[more: ${lines.length - i} lines left, next offset=${i}]` : '';
    return (out.join('\n') || '(empty range)') + more;
  }

  grep(pattern: string, path0: string): string {
    const path = path0 ? this.resolve(path0) : '';
    const needle = pattern.toLowerCase();
    if (needle === '') return 'ERROR: empty pattern';
    const hits: string[] = [];
    for (const p of this.order) {
      if (path && p !== path) continue;
      const lines = (this.files.get(p) ?? '').split('\n');
      for (let i = 0; i < lines.length && hits.length < 30; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) hits.push(`${p}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
      }
    }
    return hits.length === 0 ? 'no matches' : hits.join('\n');
  }
}

/** State shared by one agent run (the orchestrator and all its sub-agents). */
export interface RunShared {
  limits: HarnessConfig;
  budget: Budget;
  vfs: Vfs;
  trace: TraceEvent[];
  nonce: string;
  chat: ChatFunc;
  signal?: AbortSignal;
  /** live progress; called for every trace event as it happens */
  onEvent?: (e: TraceEvent) => void;
  onText?: (text: string) => void;
  /** set by ask_user: the run stops and the question goes back to the user */
  asked: AskUser | null;
  proposals: ContextProposal[];
}

export function newShared(o: { nonce: string; chat: ChatFunc; signal?: AbortSignal; onEvent?: (e: TraceEvent) => void; onText?: (text: string) => void; limits?: HarnessConfig }): RunShared {
  const limits = o.limits ?? LIMITS;
  return { limits, budget: new Budget(limits.maxLlmCalls, limits.maxToolCalls, limits.deadlineMs), vfs: new Vfs(limits), trace: [], nonce: o.nonce, chat: o.chat, signal: o.signal, onEvent: o.onEvent, onText: o.onText, asked: null, proposals: [] };
}

export interface ToolCtx { shared: RunShared; depth: number; todos: Todo[] }

export interface ToolDef {
  name: string;
  description: string;
  /** short description of the arguments object */
  args: string;
  /** output is bundled trusted text (skills, plan echo): keeps formatting, never evicted or elided */
  trusted?: boolean;
  /** output must not be written to the virtual FS (the read tools themselves) */
  noEvict?: boolean;
  run: (args: Record<string, unknown>, tc: ToolCtx) => Promise<string> | string;
}

export interface ParsedCall { tool: string; args: Record<string, unknown> }

const TOOL_BLOCK = /```tool\s*\n([\s\S]*?)```/gi;

export function parseToolCalls(text: string): { calls: ParsedCall[]; errs: string[] } {
  const calls: ParsedCall[] = [];
  const errs: string[] = [];
  for (const m of text.matchAll(TOOL_BLOCK)) {
    let v: unknown;
    try { v = JSON.parse(m[1]!); } catch { errs.push('tool block is not valid JSON (expected {"tool":"name","arguments":{...}})'); continue; }
    const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    if (typeof o.tool !== 'string') { errs.push('tool block has no "tool" string'); continue; }
    const a = o.arguments;
    calls.push({ tool: o.tool, args: a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {} });
  }
  return { calls, errs };
}

export function stripToolBlocks(t: string): string { return t.replace(/```tool\s*\n[\s\S]*?```/gi, '').trim(); }

/** Untrusted text -> line-preserving, injection-neutralized, redacted block (long lines are wrapped so no data is cut silently). */
export function sanitizeBlock(raw: string, maxChars: number): string {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length <= 1200) { lines.push(line); continue; }
    for (let i = 0; i < line.length; i += 1200) lines.push(line.slice(i, i + 1200));
  }
  let out = lines.map((l) => redactText(sanitizeField(l, 1300).text)).join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…[truncated]';
  return out;
}

function preview(text: string): string {
  const head: string[] = [];
  let n = 0;
  for (const l of text.split('\n').slice(0, 12)) {
    if (n + l.length > 1200) break;
    head.push(l);
    n += l.length;
  }
  return head.join('\n');
}

const safeName = (s: string) => s.replace(/[^\w.-]/g, '_').slice(0, 64);

export interface LoopOpts { shared: RunShared; messages: ChatMsg[]; tools: ToolDef[]; depth: number; maxSteps: number }

interface ResultMsg { idx: number; keep: boolean; done: boolean }
interface Block { id: number; name: string; ok: boolean; trusted: boolean; body: string }

const cancelled = () => new Error('cancelled');

/** Runs one (sub-)agent to its final text. */
export async function runLoop(o: LoopOpts): Promise<string> {
  const sh = o.shared;
  const budget = sh.budget;
  const messages = [...o.messages];
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const tc: ToolCtx = { shared: sh, depth: o.depth, todos: [] };
  const seen = new Map<string, number>();
  const resultMsgs: ResultMsg[] = [];
  const reserve = o.depth === 0 ? 1 : 2; // a sub-agent must never eat the parent's last call
  let nudges = 0, failStreak = 0, callId = 0;

  const emit = (e: TraceEvent) => { sh.onEvent?.(e); };
  const pushTrace = (e: TraceEvent) => { sh.trace.push(e); sh.onEvent?.(e); };
  const addUser = (content: string) => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${content}` };
    else messages.push({ role: 'user', content });
  };
  const llm = async (): Promise<string> => {
    if (budget.cancelled || sh.signal?.aborted) throw cancelled();
    if (budget.expired()) throw new Error('Agent deadline exceeded');
    const n = budget.takeLlm(o.depth > 0 ? 1 : 0);
    if (n === false) throw new Error('LLM budget exhausted');
    emit({ kind: 'thinking', name: o.depth > 0 ? 'sub-agent' : 'agent', ok: true, ms: 0, depth: o.depth, note: `call ${n}` });
    return sh.chat([...messages], sh.signal, o.depth === 0 && sh.onText ? (text) => {
      if (sh.signal?.aborted || budget.expired()) return;
      // Never expose tool JSON; hold partial fence prefixes until their language is known.
      const visible = /```tool\b/i.test(text) ? '' : text.replace(/```(?:t(?:o(?:o(?:l)?)?)?)?$/i, '').replace(/`{1,2}$/, '');
      sh.onText?.(visible);
    } : undefined);
  };

  for (let step = 0; ; step++) {
    if (budget.expired()) throw new Error('Agent deadline exceeded');
    if (step >= o.maxSteps || budget.llmLeft() <= reserve || budget.deadline - Date.now() <= Math.min(10_000, sh.limits.deadlineMs * 0.15)) {
      // final-answer mode: no tools
      if (o.depth > 0 && budget.llmLeft() <= 1) {
        // Parallel children share this counter. The final-answer path must respect the parent's reserve too.
        const results = resultMsgs.slice(-2).map((r) => messages[r.idx]!.content).join('\n\n');
        return results || stripToolBlocks([...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '') || 'Sub-agent budget exhausted before a report could be generated.';
      }
      if (budget.llmLeft() <= 0) return 'Không đủ ngân sách để hoàn tất câu trả lời. Hãy hỏi lại, thu hẹp phạm vi hơn.';
      addUser('Tool budget exhausted. Answer now with what you already have, state what remains uncertain, and do not call tools.');
      const t0 = Date.now();
      const final = await llm();
      if (sh.signal?.aborted) throw cancelled();
      pushTrace({ kind: 'final', name: 'budget', ok: true, ms: Date.now() - t0, depth: o.depth });
      return stripToolBlocks(final) || 'Chưa đủ dữ kiện để trả lời trọn vẹn.';
    }

    compact(messages, resultMsgs, sh, o.depth);
    const text = await llm();
    if (sh.signal?.aborted) throw cancelled();
    const { calls, errs } = parseToolCalls(text);

    if (calls.length === 0 && errs.length === 0) {
      const open = tc.todos.filter((t) => t.status !== 'completed');
      if (open.length > 0 && nudges < sh.limits.maxNudges) {
        nudges++;
        pushTrace({ kind: 'nudge', name: 'open-todos', ok: true, ms: 0, depth: o.depth, note: `${open.length} open` });
        messages.push({ role: 'assistant', content: text },
          { role: 'user', content: `Your plan still has unfinished items:\n${open.map((t) => `- [${t.status}] ${t.content}`).join('\n')}\nFinish them, or call write_todos to mark each completed/cancelled with a reason, then give the final answer.` });
        continue;
      }
      pushTrace({ kind: 'final', name: 'answer', ok: true, ms: 0, depth: o.depth });
      return text;
    }

    // execute (parallel, bounded). The cheap checks run in order; only tool.run itself is concurrent.
    const batch = calls.slice(0, sh.limits.maxParallel);
    const overflow = calls.length - sh.limits.maxParallel;
    const blocks: Block[] = new Array(batch.length + errs.length);
    const running: Promise<void>[] = [];
    batch.forEach((c, i) => {
      const id = ++callId;
      const name = safeName(c.tool);
      const kind: TraceEvent['kind'] = name === 'task' ? 'subagent' : 'tool';
      const t0 = Date.now();
      emit({ kind, name, ok: true, ms: 0, depth: o.depth, note: 'start' });
      const finish = (ok: boolean, body: string, trusted: boolean) => {
        pushTrace({ kind, name, ok, ms: Date.now() - t0, depth: o.depth });
        blocks[i] = { id, name, ok, trusted, body };
      };
      const tool = byName.get(c.tool);
      if (!tool) { finish(false, `ERROR: unknown tool "${name}". Available: ${o.tools.map((t) => t.name).join(', ')}`, false); return; }
      if (budget.toolCalls >= budget.maxTools) { finish(false, 'ERROR: tool-call budget exhausted; answer with what you have.', false); return; }
      const key = `${c.tool}:${JSON.stringify(c.args)}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n >= sh.limits.repeatLimit) { finish(false, `ERROR: identical call repeated ${n} times. Change the approach (different arguments or tool) or answer now.`, false); return; }
      budget.takeTool();
      running.push((async () => {
        let raw: string;
        try { raw = await tool.run(c.args, tc); } catch (e) {
          if (sh.signal?.aborted) { finish(false, 'ERROR: cancelled', false); return; }
          finish(false, 'ERROR: ' + sanitizeField(e instanceof Error ? e.message : String(e), 300).text, false);
          return;
        }
        if (tool.trusted) { finish(true, raw, true); return; }
        let body = sanitizeBlock(raw, sh.limits.storeChars);
        if (!tool.noEvict && body.length > sh.limits.inlineChars) {
          const path = sh.vfs.put('results', name, body);
          body = `Result too large (${body.length} chars, ${body.split('\n').length} lines) - saved to ${path}. Read it in slices with read_file(path, offset, limit) or search it with grep(pattern, path). Preview:\n${preview(body)}`;
        }
        finish(true, body, false);
      })());
    });
    errs.forEach((e, k) => {
      const i = batch.length + k;
      pushTrace({ kind: 'tool', name: 'invalid', ok: false, ms: 0, depth: o.depth, note: e });
      blocks[i] = { id: ++callId, name: 'invalid', ok: false, trusted: false, body: `ERROR: ${e}` };
    });
    await Promise.all(running);
    if (sh.signal?.aborted) throw cancelled();
    const all = blocks.slice();
    if (overflow > 0) all.push({ id: ++callId, name: 'limit', ok: false, trusted: false, body: `ERROR: at most ${sh.limits.maxParallel} tool calls per message; ${overflow} ignored.` });

    const parts = all.map((b) => `<<TOOL-RESULT-${sh.nonce} id=${b.id} tool=${b.name}>>\n${b.body}\n<<END-TOOL-RESULT-${sh.nonce}>>`);
    failStreak = all.some((b) => b.ok) ? 0 : failStreak + 1;
    const tail = failStreak >= sh.limits.failStreakLimit
      ? '\n\nSeveral tool rounds failed in a row. Stop retrying the same approach: re-read the metadata, try something different, or answer with what you have and say what is missing.' : '';
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: parts.join('\n') + tail });
    resultMsgs.push({ idx: messages.length - 1, keep: all.every((b) => b.trusted), done: false });
    if (sh.asked) {
      pushTrace({ kind: 'final', name: 'ask_user', ok: true, ms: 0, depth: o.depth });
      const s = stripToolBlocks(text);
      return s ? `${s}\n\n${sh.asked.question}` : sh.asked.question;
    }
  }
}

/** Deterministic compaction (no extra LLM call): when the transcript grows, older tool results move to the VFS behind a pointer. */
function compact(messages: ChatMsg[], resultMsgs: ResultMsg[], sh: RunShared, depth: number): void {
  const total = () => messages.reduce((n, m) => n + m.content.length, 0);
  if (total() <= sh.limits.compactAtChars) return;
  let candidates = resultMsgs.map((r, i) => (!r.keep && !r.done ? i : -1)).filter((i) => i >= 0);
  candidates = candidates.length >= 2 ? candidates.slice(0, -2) : []; // always keep the two most recent results
  let freed = 0;
  for (const ci of candidates) {
    const r = resultMsgs[ci]!;
    const original = messages[r.idx]!.content;
    const path = sh.vfs.put('elided', 'results', original);
    messages[r.idx] = { role: 'user', content: `<<TOOL-RESULT-${sh.nonce} elided>>\nOlder tool results were removed to save context (${original.length} chars). Full text: ${path} (read_file / grep).\n<<END-TOOL-RESULT-${sh.nonce}>>` };
    r.done = true;
    freed += original.length;
    if (total() <= sh.limits.compactAtChars * 0.7) break;
  }
  if (freed > 0) sh.trace.push({ kind: 'compact', name: 'elide-results', ok: true, ms: 0, depth, note: `${freed} chars` });
}
