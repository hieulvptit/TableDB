import { useEffect, useSyncExternalStore } from 'react';
import { desktopCommands, isTauri } from '../../runtime/tauri';
import { parseChartSpec, type ChartSpec } from '../report/chart';

/**
 * Per-workstation editor state: open SQL tabs, query history, snippets and the switches that turn the first two off.
 * Only SQL text the user typed and non-secret metadata — never passwords, never result rows.
 *
 * Storage: in the desktop app one JSON document encrypted by the Rust core (AES-256-GCM file in app data, key in the
 * OS credential store — see apps/desktop/src-tauri/src/workspace_store.rs); nothing is written to the WebView's
 * localStorage. Outside the desktop shell (tests, browser dev server) the document lives in localStorage.
 * The state is kept in memory and saved (debounced) after each change.
 */
export const WS_PREFIX = 'tdb.ws.';
const LOCAL_DOC = `${WS_PREFIX}v1`;
/** localStorage keys of the first (unencrypted) version, migrated once and removed */
const LEGACY = { tabs: `${WS_PREFIX}tabs.v1`, history: `${WS_PREFIX}history.v1`, snippets: `${WS_PREFIX}snippets.v1`, settings: `${WS_PREFIX}settings.v1` };

/** Minimal observable value for useSyncExternalStore. */
class Cell<T> {
  private listeners = new Set<() => void>();
  constructor(private v: T) {}
  get = () => this.v;
  set(v: T) { this.v = v; this.listeners.forEach((l) => l()); }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ------------------------------------------------------------------ model

export interface WorkspaceSettings {
  /** reopen SQL tabs (text only) on the next start */
  persistTabs: boolean;
  /** record executed statements in the local history */
  recordHistory: boolean;
}
export interface SavedTab { title: string; sql: string; profileId?: string; fileName?: string; schema?: string; catalog?: string; maxRows: number; timeoutSec: number }
export interface HistoryEntry {
  id: string; at: number; sql: string; connName: string; profileId?: string; driver?: string;
  ok: boolean; ms?: number; rows?: number; errorCode?: string; mode: 'read' | 'write';
}
export interface Snippet { id: string; name: string; sql: string; description?: string }
/** A report widget: the query (SQL text only, never rows) plus how to draw it. Re-run on demand against the saved profile. */
export interface Widget { id: string; name: string; sql: string; chart: ChartSpec; profileId?: string; connName?: string; schema?: string; catalog?: string; maxRows: number }
export interface ChatMsg { role: 'user' | 'assistant'; content: string; at: number; model?: string; error?: boolean }
/** One Agent conversation. Text only: never result rows, never metadata manifests. `summary` covers the first `summarized` messages. */
export interface ChatSession { id: string; title: string; pinned?: boolean; connName?: string; profileId?: string; createdAt: number; updatedAt: number; summary?: string; summarized: number; messages: ChatMsg[] }
/** A fact the user wants the Agent to remember across conversations; sent with every message while `enabled`. */
export interface MemoryNote { id: string; text: string; at: number; enabled: boolean }
export const CONTEXT_KINDS = ['entity', 'terminology', 'filter', 'metric', 'gotcha'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];
/** Durable business knowledge about ONE saved connection (entity meanings, standard filters, metric formulas, gotchas). The user confirms every note; enabled ones ride with each Agent request for that profile. */
export interface ContextNote { id: string; profileId: string; kind: ContextKind; text: string; at: number; enabled: boolean }
interface Doc { v: 1; settings: WorkspaceSettings; tabs: SavedTab[]; history: HistoryEntry[]; snippets: Snippet[]; widgets: Widget[]; chats: ChatSession[]; memories: MemoryNote[]; contexts: ContextNote[] }

const DEFAULT_SETTINGS: WorkspaceSettings = { persistTabs: true, recordHistory: true };
const MAX_TAB_SQL = 2_000_000;
const MAX_TABS = 50;
const MAX_HISTORY = 500;
const MAX_WIDGETS = 60;
const MAX_CHATS = 100;
const MAX_CHAT_MSGS = 200;
const MAX_MEMORIES = 50;
export const MAX_MEMORY_CHARS = 500;
export const MAX_CONTEXT_CHARS = 300;
const MAX_CONTEXTS = 200;
const MAX_CONTEXTS_PER_PROFILE = 30;
const MAX_HISTORY_SQL = 20_000;
const BUILTIN: Snippet[] = [
  { id: 'b-sel', name: 'sel', sql: 'SELECT *\nFROM ${table}\nWHERE ${condition}', description: 'SELECT … WHERE' },
  { id: 'b-cnt', name: 'cnt', sql: 'SELECT COUNT(*)\nFROM ${table}', description: 'COUNT(*)' },
  { id: 'b-grp', name: 'grp', sql: 'SELECT ${column}, COUNT(*)\nFROM ${table}\nGROUP BY ${column}\nORDER BY 2 DESC', description: 'GROUP BY + COUNT' },
  { id: 'b-dup', name: 'dup', sql: 'SELECT ${column}, COUNT(*)\nFROM ${table}\nGROUP BY ${column}\nHAVING COUNT(*) > 1', description: 'Find duplicate values' },
  { id: 'b-join', name: 'join', sql: 'SELECT a.*, b.*\nFROM ${table_a} a\nJOIN ${table_b} b ON b.${key} = a.${key}', description: 'JOIN two tables' },
];

const cleanTab = (x: Record<string, unknown>): SavedTab => ({
  title: str(x.title, 200) || 'SQL', sql: str(x.sql, MAX_TAB_SQL),
  ...(typeof x.profileId === 'string' ? { profileId: x.profileId } : {}), ...(typeof x.fileName === 'string' ? { fileName: x.fileName.slice(0, 200) } : {}), ...(typeof x.schema === 'string' && x.schema ? { schema: x.schema.slice(0, 200) } : {}), ...(typeof x.catalog === 'string' && x.catalog ? { catalog: x.catalog.slice(0, 200) } : {}),
  maxRows: Number.isInteger(x.maxRows) ? Math.min(100_000, Math.max(1, x.maxRows as number)) : 1000,
  timeoutSec: Number.isInteger(x.timeoutSec) ? Math.min(600, Math.max(1, x.timeoutSec as number)) : 60,
});
const validEntry = (e: unknown): e is HistoryEntry => isObj(e) && typeof e.sql === 'string' && typeof e.id === 'string';
const validSnippet = (x: unknown): x is Snippet => isObj(x) && typeof x.name === 'string' && typeof x.sql === 'string' && typeof x.id === 'string';

const cleanWidget = (x: unknown): Widget | null => {
  if (!isObj(x) || typeof x.id !== 'string' || typeof x.sql !== 'string' || !isObj(x.chart)) return null;
  const c = x.chart;
  // stored specs are re-validated structurally (column names are checked against the result when it is drawn)
  const y = Array.isArray(c.y) ? c.y.filter((v): v is string => typeof v === 'string').slice(0, 6) : [];
  const probe = parseChartSpec({ ...c, y }, [...y, ...(typeof c.x === 'string' ? [c.x] : [])].map((name) => ({ name })));
  if (!probe) return null;
  return {
    id: x.id.slice(0, 40), name: str(x.name, 100) || 'Widget', sql: str(x.sql, 50_000), chart: probe,
    ...(typeof x.profileId === 'string' ? { profileId: x.profileId } : {}), ...(typeof x.connName === 'string' ? { connName: x.connName.slice(0, 100) } : {}),
    ...(typeof x.schema === 'string' && x.schema ? { schema: x.schema.slice(0, 200) } : {}), ...(typeof x.catalog === 'string' && x.catalog ? { catalog: x.catalog.slice(0, 200) } : {}),
    maxRows: Number.isInteger(x.maxRows) ? Math.min(10_000, Math.max(1, x.maxRows as number)) : 1000,
  };
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cleanChat = (x: unknown): ChatSession | null => {
  if (!isObj(x) || typeof x.id !== 'string') return null;
  const messages = arr(x.messages).filter(isObj).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-MAX_CHAT_MSGS).map((m): ChatMsg => ({
    role: m.role as ChatMsg['role'], content: str(m.content, 20_000), at: num(m.at, 0), ...(typeof m.model === 'string' ? { model: m.model.slice(0, 100) } : {}), ...(m.error === true ? { error: true } : {}),
  }));
  const created = num(x.createdAt, 0);
  return {
    id: x.id.slice(0, 40), title: str(x.title, 120) || 'Chat', createdAt: created, updatedAt: num(x.updatedAt, created), messages,
    summarized: Math.min(messages.length, Math.max(0, Math.trunc(num(x.summarized, 0)))),
    ...(x.pinned === true ? { pinned: true } : {}), ...(typeof x.summary === 'string' && x.summary ? { summary: x.summary.slice(0, 4000) } : {}),
    ...(typeof x.connName === 'string' ? { connName: x.connName.slice(0, 100) } : {}), ...(typeof x.profileId === 'string' ? { profileId: x.profileId } : {}),
  };
};
const cleanMemory = (x: unknown): MemoryNote | null =>
  isObj(x) && typeof x.id === 'string' && typeof x.text === 'string' && x.text.trim() ? { id: x.id.slice(0, 40), text: x.text.trim().slice(0, MAX_MEMORY_CHARS), at: num(x.at, 0), enabled: x.enabled !== false } : null;

const cleanContext = (x: unknown): ContextNote | null =>
  isObj(x) && typeof x.id === 'string' && typeof x.profileId === 'string' && x.profileId && typeof x.text === 'string' && x.text.trim() && (CONTEXT_KINDS as readonly string[]).includes(x.kind as string)
    ? { id: x.id.slice(0, 40), profileId: x.profileId, kind: x.kind as ContextKind, text: x.text.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTEXT_CHARS), at: num(x.at, 0), enabled: x.enabled !== false } : null;

/** Whitelist parse of a stored document (anything unknown or malformed is dropped). */
function parseDoc(raw: unknown): Doc {
  const d = isObj(raw) ? raw : {};
  const s = isObj(d.settings) ? d.settings : {};
  return {
    v: 1,
    settings: { persistTabs: s.persistTabs !== false, recordHistory: s.recordHistory !== false },
    tabs: arr(d.tabs).filter(isObj).slice(0, MAX_TABS).map(cleanTab),
    history: arr(d.history).filter(validEntry).slice(0, MAX_HISTORY),
    snippets: Array.isArray(d.snippets) ? d.snippets.filter(validSnippet) : BUILTIN,
    widgets: arr(d.widgets).map(cleanWidget).filter((w): w is Widget => !!w).slice(0, MAX_WIDGETS),
    chats: arr(d.chats).map(cleanChat).filter((c): c is ChatSession => !!c).slice(0, MAX_CHATS),
    memories: arr(d.memories).map(cleanMemory).filter((m): m is MemoryNote => !!m).slice(0, MAX_MEMORIES),
    contexts: arr(d.contexts).map(cleanContext).filter((c): c is ContextNote => !!c).slice(0, MAX_CONTEXTS),
  };
}

const settingsCell = new Cell<WorkspaceSettings>({ ...DEFAULT_SETTINGS });
const tabsCell = new Cell<SavedTab[]>([]);
const historyCell = new Cell<HistoryEntry[]>([]);
const snippetsCell = new Cell<Snippet[]>(BUILTIN);
const widgetsCell = new Cell<Widget[]>([]);
const chatsCell = new Cell<ChatSession[]>([]);
const memoriesCell = new Cell<MemoryNote[]>([]);
const contextsCell = new Cell<ContextNote[]>([]);
const readyCell = new Cell<boolean>(false);

function apply(doc: Doc) {
  settingsCell.set(doc.settings);
  tabsCell.set(doc.settings.persistTabs ? doc.tabs : []);
  historyCell.set(doc.history);
  snippetsCell.set(doc.snippets);
  widgetsCell.set(doc.widgets);
  chatsCell.set(doc.chats);
  memoriesCell.set(doc.memories);
  contextsCell.set(doc.contexts);
}
const snapshot = (): Doc => ({ v: 1, settings: settingsCell.get(), tabs: settingsCell.get().persistTabs ? tabsCell.get() : [], history: historyCell.get(), snippets: snippetsCell.get(), widgets: widgetsCell.get(), chats: chatsCell.get(), memories: memoriesCell.get(), contexts: contextsCell.get() });

// ------------------------------------------------------------------ storage backends

interface Backend { load(): Promise<string | null>; save(json: string): Promise<void>; clear(): Promise<void> }
const localBackend: Backend = {
  load: async () => { try { return localStorage.getItem(LOCAL_DOC); } catch { return null; } },
  save: async (json) => { try { localStorage.setItem(LOCAL_DOC, json); } catch { /* storage blocked or full */ } },
  clear: async () => { try { localStorage.removeItem(LOCAL_DOC); } catch { /* ignore */ } },
};
const encryptedBackend: Backend = {
  load: () => desktopCommands.workspaceLoad(),
  save: (json) => desktopCommands.workspaceSave(json),
  clear: () => desktopCommands.workspaceClear(),
};
const backend = () => (isTauri() ? encryptedBackend : localBackend);

/** Store kind shown to the user. */
export const workspaceStorage = (): 'encrypted' | 'local' => (isTauri() ? 'encrypted' : 'local');

function readLegacy(): Doc | null {
  try {
    const get = (k: string) => { const v = localStorage.getItem(k); return v ? JSON.parse(v) as unknown : undefined; };
    const parts = { settings: get(LEGACY.settings), tabs: get(LEGACY.tabs), history: get(LEGACY.history), snippets: get(LEGACY.snippets) };
    if (Object.values(parts).every((v) => v === undefined)) return null;
    return parseDoc(parts);
  } catch { return null; }
}
function dropLegacy() { try { for (const k of Object.values(LEGACY)) localStorage.removeItem(k); } catch { /* ignore */ } }

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
/** Debounced save of the whole document (never before the stored one was loaded: that would overwrite it). */
function persist() {
  if (!readyCell.get()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 300);
}
function flush() {
  const json = JSON.stringify(snapshot());
  const b = backend();
  saving = saving.then(() => b.save(json)).catch(() => { /* kept in memory; the next change retries */ });
}

let initPromise: Promise<void> | null = null;
/** Loads the stored document once (desktop: decrypts it; first run: migrates the old localStorage keys). */
export function initWorkspace(): Promise<void> {
  initPromise ??= (async () => {
    let doc: Doc | null = null;
    try {
      const raw = await backend().load();
      if (raw) doc = parseDoc(JSON.parse(raw));
    } catch { /* unreadable (key lost / file damaged): start empty, the next save replaces it */ }
    const legacy = readLegacy();
    if (!doc && legacy) doc = legacy;
    if (doc) apply(doc);
    readyCell.set(true);
    if (legacy) { flush(); await saving; dropLegacy(); }
  })();
  return initPromise;
}
export function useWorkspaceReady(): boolean {
  const ready = useSyncExternalStore(readyCell.subscribe, readyCell.get);
  useEffect(() => { void initWorkspace(); }, []);
  return ready;
}

/** Deletes everything stored (desktop: the encrypted file and its key) and resets to defaults. */
export async function clearWorkspace() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await saving;
  apply(parseDoc({}));
  dropLegacy();
  await backend().clear();
}

// ------------------------------------------------------------------ settings

export const getSettings = settingsCell.get;
export function setSettings(patch: Partial<WorkspaceSettings>) {
  settingsCell.set({ ...settingsCell.get(), ...patch });
  if (!settingsCell.get().persistTabs) tabsCell.set([]);
  persist();
}
export const useWorkspaceSettings = () => useSyncExternalStore(settingsCell.subscribe, settingsCell.get);

// ------------------------------------------------------------------ tabs

export function loadTabs(): SavedTab[] { return getSettings().persistTabs ? tabsCell.get() : []; }
/** Called on every tab change (saved debounced). */
export function saveTabs(tabs: SavedTab[]) {
  if (!getSettings().persistTabs) return;
  const next = tabs.slice(0, MAX_TABS).map((t) => ({ ...t, sql: t.sql.slice(0, MAX_TAB_SQL) }));
  if (JSON.stringify(next) === JSON.stringify(tabsCell.get())) return;
  tabsCell.set(next);
  persist();
}

// ------------------------------------------------------------------ history

export const useHistory = () => useSyncExternalStore(historyCell.subscribe, historyCell.get);
export const getHistory = historyCell.get;

export function addHistory(e: Omit<HistoryEntry, 'id' | 'at'> & { at?: number }) {
  if (!getSettings().recordHistory || !e.sql.trim()) return;
  const entry: HistoryEntry = { ...e, sql: e.sql.slice(0, MAX_HISTORY_SQL), at: e.at ?? Date.now(), id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` };
  // the same statement run again moves to the top instead of piling up
  const rest = historyCell.get().filter((x) => !(x.sql === entry.sql && x.connName === entry.connName));
  historyCell.set([entry, ...rest].slice(0, MAX_HISTORY));
  persist();
}
export function deleteHistory(ids: string[]) {
  const drop = new Set(ids);
  historyCell.set(historyCell.get().filter((x) => !drop.has(x.id)));
  persist();
}
export function clearHistory() { historyCell.set([]); persist(); }

// ------------------------------------------------------------------ snippets

export const useSnippets = () => useSyncExternalStore(snippetsCell.subscribe, snippetsCell.get);
export const getSnippets = snippetsCell.get;
export function saveSnippet(s: Snippet) {
  const clean: Snippet = { id: s.id, name: s.name.trim().slice(0, 60), sql: s.sql.slice(0, 50_000), ...(s.description?.trim() ? { description: s.description.trim().slice(0, 200) } : {}) };
  const cur = snippetsCell.get();
  snippetsCell.set(cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? clean : x)) : [...cur, clean]);
  persist();
}
export function deleteSnippet(id: string) {
  snippetsCell.set(snippetsCell.get().filter((x) => x.id !== id));
  persist();
}
/** `${name}` placeholders become CodeMirror snippet fields `#{name}`. */
export const snippetTemplate = (sql: string) => sql.replace(/\$\{([^}]*)\}/g, (_, n: string) => `#{${n}}`);
/** Plain text of a snippet (placeholders shown by name). */
export const snippetText = (sql: string) => sql.replace(/\$\{([^}]*)\}/g, (_, n: string) => n);

// ------------------------------------------------------------------ dashboard widgets

export const useWidgets = () => useSyncExternalStore(widgetsCell.subscribe, widgetsCell.get);
export const getWidgets = widgetsCell.get;
export function saveWidget(w: Widget): boolean {
  const clean = cleanWidget(w);
  if (!clean) return false;
  const cur = widgetsCell.get();
  if (!cur.some((x) => x.id === clean.id) && cur.length >= MAX_WIDGETS) return false;
  widgetsCell.set(cur.some((x) => x.id === clean.id) ? cur.map((x) => (x.id === clean.id ? clean : x)) : [...cur, clean]);
  persist();
  return true;
}
export function deleteWidget(id: string) { widgetsCell.set(widgetsCell.get().filter((x) => x.id !== id)); persist(); }
export const newWidgetId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ------------------------------------------------------------------ agent chats + memory

export const useChats = () => useSyncExternalStore(chatsCell.subscribe, chatsCell.get);
export const getChats = chatsCell.get;
/** Insert or replace a session; the oldest unpinned ones are dropped past the limit. */
export function saveChat(c: ChatSession) {
  const clean = cleanChat(c);
  if (!clean) return;
  const rest = chatsCell.get().filter((x) => x.id !== clean.id);
  const all = [clean, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
  const pinned = all.filter((x) => x.pinned);
  chatsCell.set([...pinned, ...all.filter((x) => !x.pinned)].slice(0, MAX_CHATS));
  persist();
}
export function deleteChat(id: string) { chatsCell.set(chatsCell.get().filter((x) => x.id !== id)); persist(); }
export function clearChats() { chatsCell.set([]); persist(); }
export const newChatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const useMemories = () => useSyncExternalStore(memoriesCell.subscribe, memoriesCell.get);
export const getMemories = memoriesCell.get;
export function saveMemory(m: MemoryNote): boolean {
  const clean = cleanMemory(m);
  if (!clean) return false;
  const cur = memoriesCell.get();
  if (!cur.some((x) => x.id === clean.id) && cur.length >= MAX_MEMORIES) return false;
  memoriesCell.set(cur.some((x) => x.id === clean.id) ? cur.map((x) => (x.id === clean.id ? clean : x)) : [...cur, clean]);
  persist();
  return true;
}
export function deleteMemory(id: string) { memoriesCell.set(memoriesCell.get().filter((x) => x.id !== id)); persist(); }
export const newMemoryId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ------------------------------------------------------------------ business context per saved connection
export const useContextNotes = () => useSyncExternalStore(contextsCell.subscribe, contextsCell.get);
export const getContextNotes = contextsCell.get;
export const contextFor = (profileId: string | undefined, all: ContextNote[] = contextsCell.get()) => (profileId ? all.filter((n) => n.profileId === profileId) : []);
export function saveContextNote(n: ContextNote): boolean {
  const clean = cleanContext(n);
  if (!clean) return false;
  const cur = contextsCell.get();
  const exists = cur.some((x) => x.id === clean.id);
  if (!exists && (cur.length >= MAX_CONTEXTS || contextFor(clean.profileId, cur).length >= MAX_CONTEXTS_PER_PROFILE)) return false;
  if (!exists && cur.some((x) => x.profileId === clean.profileId && x.text.toLowerCase() === clean.text.toLowerCase())) return true;   // already saved
  contextsCell.set(exists ? cur.map((x) => (x.id === clean.id ? clean : x)) : [...cur, clean]);
  persist();
  return true;
}
export function deleteContextNote(id: string) { contextsCell.set(contextsCell.get().filter((x) => x.id !== id)); persist(); }
/** saved connections were merged (old id -> kept id): their notes follow */
export function remapContextProfiles(moved: Map<string, string>) {
  const cur = contextsCell.get();
  if (!cur.some((n) => moved.has(n.profileId))) return;
  contextsCell.set(cur.map((n) => (moved.has(n.profileId) ? { ...n, profileId: moved.get(n.profileId)! } : n)));
  persist();
}
export const newContextId = () => `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The block sent with the Agent request: enabled notes of this profile, one per line, bounded. */
export function contextPayload(profileId: string | undefined): string {
  return contextFor(profileId).filter((n) => n.enabled).map((n) => `- [${n.kind}] ${n.text}`).join('\n').slice(0, 4000);
}

// ------------------------------------------------------------------ tests

/** Test hook: drop pending saves and reload synchronously from the local backend (localStorage is cleared between tests). */
export function reloadWorkspaceForTests() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  let raw: string | null = null;
  try { raw = localStorage.getItem(LOCAL_DOC); } catch { /* none */ }
  apply(parseDoc(raw ? JSON.parse(raw) : {}));
  initPromise = Promise.resolve();
  readyCell.set(true);
}
/** Test hook: forget the loaded state so the next initWorkspace() loads again. */
export function resetWorkspaceForTests() { initPromise = null; readyCell.set(false); apply(parseDoc({})); }
/** Test hook: wait for the debounced save. */
export async function flushWorkspaceForTests() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; flush(); }
  await saving;
}
