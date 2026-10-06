import { sanitizeField } from '@vnpay/shared';
import type { ToolCtx, ToolDef, Todo } from './harness';
import type { SkillRegistry } from './skills';
import type { McpSession, McpTool } from './openmetadata';
import { isReadonlyOM } from './openmetadata';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);

export const loadSkillTool = (skills: SkillRegistry): ToolDef => ({
  name: 'load_skill', trusted: true,
  description: 'Load the full instructions of a skill from the catalog (or one of its reference files).',
  args: '{"name": string, "ref"?: string}',
  run: (a) => skills.load(str(a.name, 64), a.ref ? str(a.ref, 80) : ''),
});

export const readFileTool: ToolDef = {
  name: 'read_file', noEvict: true,
  description: 'Read a slice of a saved tool result (path from a "saved to" message). 1-based line numbers; at most ~200 lines per call.',
  args: '{"path": string, "offset"?: number (0-based line), "limit"?: number}',
  run: (a, c) => c.shared.vfs.read(str(a.path, 200), num(a.offset, 0), num(a.limit, 100)),
};

export const grepTool: ToolDef = {
  name: 'grep', noEvict: true,
  description: 'Case-insensitive literal search in saved tool results; optionally restricted to one path.',
  args: '{"pattern": string, "path"?: string}',
  run: (a, c) => c.shared.vfs.grep(str(a.pattern, 200), a.path ? str(a.path, 200) : ''),
};

export const writeTodosTool: ToolDef = {
  name: 'write_todos', trusted: true,
  description: 'Write or update your plan for work with 3 or more steps (replaces the whole list). Mark an item in_progress before starting it and completed right after finishing it. Skip for trivial requests. Never call it in parallel with itself.',
  args: '{"todos": [{"content": string, "status": "pending"|"in_progress"|"completed"}]} (max 12 items)',
  run: (a, c: ToolCtx) => {
    const raw = (Array.isArray(a.todos) ? a.todos : []).slice(0, 12) as Array<Record<string, unknown>>;
    const items: Todo[] = [];
    for (const t of raw) {
      const content = sanitizeField(str(t?.content, 200), 200).text;
      const status = t?.status;
      if (!content || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) throw new Error('each todo needs content and status pending|in_progress|completed');
      items.push({ content, status });
    }
    c.todos = items;
    const body = items.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n');
    return `Plan updated:\n${body || '(empty)'}`;
  },
};

/** OpenMetadata MCP tools, narrowed to the read-only allow-list; the call is made with the user's own token. */
export function openMetadataTools(session: McpSession, listed: McpTool[], allowed?: string[]): ToolDef[] {
  return listed.filter((t) => isReadonlyOM(t.name, allowed)).map((t) => {
    const schema = sanitizeField(t.inputSchema === undefined || t.inputSchema === null ? '{}' : JSON.stringify(t.inputSchema), 400).text;
    return {
      name: t.name,
      description: '[OpenMetadata, read-only] ' + sanitizeField(t.description ?? '', 300).text,
      args: schema,
      run: (a, c) => session.callTool(t.name, a, c.shared.signal),
    };
  });
}

export const askUserTool: ToolDef = {
  name: 'ask_user', trusted: true,
  description: 'Stop and ask the user ONE clarifying question when the request is ambiguous in a way that changes the SQL (which metric definition, which time range, which of several matching tables) and metadata cannot settle it. Offer 2-4 short options when possible. Do not use it for things you can decide with a stated assumption.',
  args: '{"question": string, "options"?: string[]}',
  run: (a, c) => {
    const question = sanitizeField(str(a.question, 400), 400).text;
    if (!question) throw new Error('question is required');
    const options = (Array.isArray(a.options) ? a.options : []).slice(0, 4).map((o) => sanitizeField(str(o, 80), 80).text).filter(Boolean);
    c.shared.asked = { question, options };
    return 'Question sent to the user; the run stops here.';
  },
};

const CONTEXT_KINDS = ['entity', 'terminology', 'filter', 'metric', 'gotcha'] as const;

export const proposeContextTool: ToolDef = {
  name: 'propose_context_note', trusted: true,
  description: 'Suggest saving a durable business-context note for THIS connection (what an entity means, a standard filter such as "exclude test accounts", a metric formula, a data gotcha). Use only for facts the user stated or confirmed in this conversation, or that OpenMetadata states; never for guesses. The user decides whether it is saved.',
  args: '{"kind": "entity"|"terminology"|"filter"|"metric"|"gotcha", "text": string (one sentence, max 300 chars)}',
  run: (a, c) => {
    const kind = CONTEXT_KINDS.find((k) => a.kind === k);
    const text = sanitizeField(str(a.text, 300), 300).text;
    if (!kind || text.length < 8) throw new Error('kind and a meaningful text are required');
    const props = c.shared.proposals;
    if (props.length >= 5) return 'Enough proposals for one answer.';
    if (!props.some((p) => p.text === text)) props.push({ kind, text });
    return 'Noted; the user will be offered to save it.';
  },
};
