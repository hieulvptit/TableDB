import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ContextManifest } from '@vnpay/shared';
import { Badge, Button, EmptyState, Spinner, useToast } from '@vnpay/ui';
import type { AgentAsk, AgentProposal, AgentSettings, AgentSqlBlock, AgentTokenState, AgentTraceEvent } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, t } from '../../i18n';
import { useStoreVersion } from '../tabledb/SchemaTree';
import { useTableDbSelector, type TableDbApi } from '../tabledb/store';
import { Icon } from '../tabledb/icons';
import { agentApi } from './api';
import { ContextDisclosure } from './ContextDisclosure';
import { buildChatBody, buildPreviewBody, ensureContext, type AgentLlmChoice } from './context';
import { withDeadline } from './harness/harness';
import { DEFAULT_RUNTIME } from './runtimeConfig';
import { parseReply } from './parseReply';
import { ChartBlock } from './ChartBlock';
import { HtmlBlock } from './HtmlBlock';
import { SqlBlock } from './SqlBlock';
import { PersonalAgentsManager } from './PersonalAgentsManager';
import { MemoryManager } from './MemoryManager';
import { SessionList } from './SessionList';
import { buildHistory, pendingSummary, summaryRequest, titleFrom } from './memory';
import { MAX_CHAT_MSGS, getPersonalSkills, getPersonalAgents, usePersonalAgents, contextPayload, getChats, getMemories, newChatId, newContextId, newMemoryId, saveChat, saveContextNote, saveMemory, type ChatMsg, type ChatSession } from '../tabledb/workspace';
import { ContextNotes } from './ContextNotes';
import { LiveStatus, TraceSummary } from './TraceView';
import { TokenSetup } from './TokenSetup';
import { OpenMetadataSetup } from './OpenMetadataSetup';
import { fileToDataUrl, imageFiles, MAX_IMAGES } from './images';

interface Msg { id: number; role: 'user' | 'assistant'; content: string; sql?: AgentSqlBlock[]; manifest?: ContextManifest; error?: boolean; rowsAttached?: number; model?: string; at?: number; trace?: AgentTraceEvent[]; ask?: AgentAsk; proposals?: AgentProposal[]; images?: string[] }
type PanelView = 'chat' | 'sessions' | 'memory' | 'personal';
const toStored = (m: Msg[]): ChatMsg[] => m.map((x) => ({ role: x.role, content: x.content, at: x.at ?? Date.now(), ...(x.model ? { model: x.model } : {}), ...(x.error ? { error: true } : {}) }));

const LLM_KEY = 'tabledb.agent.llm';
const choiceValue = (c: AgentLlmChoice) => `${c.endpointId}|${c.model}`; // endpoint ids are [a-z0-9-], so '|' never appears in them
const parseChoice = (v: string): AgentLlmChoice | null => { const i = v.indexOf('|'); return i > 0 ? { endpointId: v.slice(0, i), model: v.slice(i + 1) } : null; };
const isAllowed = (s: AgentSettings, c: AgentLlmChoice | null): c is AgentLlmChoice => !!c && !!s.endpoints.find((e) => e.id === c.endpointId)?.models.includes(c.model);
function storedChoice(): AgentLlmChoice | null { try { return parseChoice(localStorage.getItem(LLM_KEY) ?? ''); } catch { return null; } }

/** The model used for the next message: the one picked in the popup (remembered per browser), else the token's, else the admin default. */
function pickChoice(s: AgentSettings, tk: AgentTokenState, current: AgentLlmChoice | null): AgentLlmChoice | null {
  const first = s.endpoints[0];
  const candidates = [current, storedChoice(), tk.endpointId && tk.model ? { endpointId: tk.endpointId, model: tk.model } : null,
    { endpointId: s.defaultEndpointId, model: s.defaultModel }, first ? { endpointId: first.id, model: first.models[0] ?? '' } : null];
  return candidates.find((c) => isAllowed(s, c)) ?? null;
}

const SUGGESTIONS: { icon: Parameters<typeof Icon>[0]['name']; tone: string; id: string }[] = [
  { icon: 'search', tone: 'cyan', id: 'structure' },
  { icon: 'bolt', tone: 'blue', id: 'latest' },
  { icon: 'chart', tone: 'indigo', id: 'join' },
  { icon: 'shield', tone: 'green', id: 'fkIndex' },
  { icon: 'trend', tone: 'amber', id: 'optimize' },
  { icon: 'edit', tone: 'purple', id: 'ddl' },
];
const SQL_TEMPLATE = '```sql\nSELECT * FROM \n```';

const agentState = (db: TableDbApi) => ({ connections: db.connections, activeConn: db.activeConn, selected: db.selected, agentRows: db.agentRows, setAgentRows: db.setAgentRows, setSelected: db.setSelected, insertSql: db.insertSql });
export const AgentPanel = memo(function AgentPanel({ open = true, onClose }: { open?: boolean; onClose?: () => void }) {
  const db = useTableDbSelector(agentState);
  const { can } = useAuth();
  const toast = useToast();
  const conn = db.activeConn;
  useStoreVersion(conn);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [tokenState, setTokenState] = useState<AgentTokenState | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<string[]>([]);   // attached to the next message; never persisted
  const fileRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [liveReply, setLiveReply] = useState('');
  const [live, setLive] = useState<AgentTraceEvent[]>([]);
  const [savedNotes, setSavedNotes] = useState<Set<string>>(new Set());
  const summaryRuns = useRef(new Map<string, AbortController>());
  const abortRef = useRef<AbortController | null>(null);
  const expandRelated = true; // related (FK) tables are always included
  const [preview, setPreview] = useState<ContextManifest | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [llm, setLlm] = useState<AgentLlmChoice | null>(null);
  const [view, setView] = useState<PanelView>('chat');
  const personalAgents = usePersonalAgents();
  const [agentName, setAgentName] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const followReply = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const [s, tk] = await Promise.all([agentApi.settings(), agentApi.tokenState()]);
      setSettings(s); setTokenState(tk); setLoadErr('');
      setLlm((cur) => pickChoice(s, tk, cur));
    } catch (e) { setLoadErr(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // "before": what would be sent for the current selection / option / attached rows
  const selKey = db.selected.map((r) => `${r.catalog ?? ''}.${r.schema}.${r.name}`).join('|');
  const rowsKey = db.agentRows ? db.agentRows.rows.length : 0;
  useEffect(() => {
    if (!open || !conn || !settings) { setPreview(null); return; }
    if (db.selected.length === 0) { setPreview(null); setPreviewErr(null); return; }
    const ctrl = new AbortController();
    const h = setTimeout(async () => {
      setPreviewLoading(true); setPreviewErr(null);
      try {
        await ensureContext(conn, db.selected, expandRelated);
        const r = await agentApi.preview(buildPreviewBody(conn, db.selected, expandRelated, db.agentRows), ctrl.signal);
        if (!ctrl.signal.aborted) setPreview(r.manifest);
      } catch (e) { if (!ctrl.signal.aborted) { setPreview(null); setPreviewErr(errorMessage(e)); } }
      finally { if (!ctrl.signal.aborted) setPreviewLoading(false); }
    }, 400);
    return () => { clearTimeout(h); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conn, settings, selKey, expandRelated, rowsKey]);

  useEffect(() => { if (followReply.current) listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight }); }, [msgs.length, liveReply]);
  const cancelRun = useCallback(() => { const current = abortRef.current; abortRef.current = null; current?.abort(); setSending(false); setLive([]); setLiveReply(''); }, []);
  const newChat = useCallback(() => { cancelRun(); setMsgs([]); setSessionId(null); setView('chat'); }, [cancelRun]);
  useEffect(() => () => { abortRef.current?.abort(); abortRef.current = null; summaryRuns.current.forEach((c) => c.abort()); }, []);
  // a conversation belongs to one connection: switching connection starts a fresh one (the old one stays in the list)
  useEffect(() => { newChat(); }, [conn?.id, newChat]);
  const openSession = (c: ChatSession) => { cancelRun(); setAgentName(c.agentName ?? ''); setMsgs(c.messages.map((m) => ({ id: ++seq.current, ...m }))); setSessionId(c.id); setView('chat'); };
  const remember = (text: string) => {
    const ok = saveMemory({ id: newMemoryId(), text: text.replace(/\s+/g, ' ').trim().slice(0, 300), at: Date.now(), enabled: true });
    toast.push(t(ok ? 'memory.saved' : 'memory.full'), ok ? 'success' : 'error');
  };

  const growInput = () => { const el = inputRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; } };
  useEffect(growInput, [draft]);
  const fillDraft = (text: string) => { setDraft(text); requestAnimationFrame(() => { inputRef.current?.focus(); }); };
  const insertAtCaret = (text: string) => {
    const el = inputRef.current;
    const a = el?.selectionStart ?? draft.length, b = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, a) + text + draft.slice(b));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + text.length, a + text.length); });
  };
  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    if (images.length + files.length > MAX_IMAGES) toast.push(t('agent.imageTooMany'), 'error');
    const room = files.slice(0, Math.max(0, MAX_IMAGES - images.length));
    try {
      const urls = await Promise.all(room.map(fileToDataUrl));
      setImages((cur) => [...cur, ...urls].slice(0, MAX_IMAGES));
    } catch { toast.push(t('agent.imageBad'), 'error'); }
  };
  const selectedNames = db.selected.map((r) => `${r.schema}.${r.name}`);
  const promptTable = selectedNames[0] ?? t('agent.sug.selected');

  const saveProposal = (p: AgentProposal) => {
    if (!conn?.profileId) { toast.push(t('ctx.noProfile'), 'error'); return; }
    const ok = saveContextNote({ id: newContextId(), profileId: conn.profileId, kind: p.kind, text: p.text, at: Date.now(), enabled: true });
    if (ok) setSavedNotes((s) => new Set(s).add(p.text)); toast.push(t(ok ? 'ctx.savedToast' : 'ctx.full'), ok ? 'success' : 'error');
  };

  const send = async (override?: string) => {
    const shots = override === undefined ? images : [];
    const text = (override ?? draft).trim() || (shots.length ? t('agent.imageOnlyPrompt') : '');
    if (!text || !conn || sending || abortRef.current) return;
    const rows = db.agentRows;
    const skillsForRun = getPersonalSkills().filter((s) => s.enabled);
    const agentsForRun = getPersonalAgents().filter((a) => a.enabled);
    if (agentName && !agentsForRun.some((a) => a.name === agentName)) { toast.push(t('personal.unavailable'), 'error'); return; }
    const userMsg: Msg = { id: ++seq.current, role: 'user', content: text, rowsAttached: rows?.rows.length, at: Date.now(), ...(shots.length ? { images: shots } : {}) };
    followReply.current = true;
    const base = [...msgs, userMsg].slice(-MAX_CHAT_MSGS);
    const sid = sessionId ?? newChatId();
    if (!sessionId) setSessionId(sid);
    setMsgs(base); setDraft(''); setImages([]); setSending(true); setLive([]); setLiveReply('');
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const prev = getChats().find((c) => c.id === sid);
    const persist = (messages: Msg[]) => {
      const now = Date.now();
      const current = getChats().find((c) => c.id === sid);
      const first = messages[0];
      const skipped = current && first ? current.messages.findIndex((m) => m.at === first.at && m.role === first.role && m.content === first.content) : 0;
      const summarized = Math.max(0, (current?.summarized ?? 0) - Math.max(0, skipped));
      saveChat({
        ...(agentName ? { agentName } : {}),
        id: sid, title: current?.title ?? prev?.title ?? titleFrom(text), ...(current?.pinned ? { pinned: true } : {}), connName: conn.name, ...(conn.profileId ? { profileId: conn.profileId } : {}),
        createdAt: prev?.createdAt ?? now, updatedAt: now, ...(current?.summary ? { summary: current.summary } : {}), summarized, messages: toStored(messages),
      });
    };
    persist(base);
    let final = base;
    try {
      const r = await withDeadline(settings?.runtime.harness.deadlineMs ?? DEFAULT_RUNTIME.harness.deadlineMs, ctrl.signal, async (signal) => {
        await ensureContext(conn, db.selected, expandRelated);
        if (signal.aborted || ctrl.signal.aborted || abortRef.current !== ctrl) throw new Error('cancelled');
        const saved = getChats().find((c) => c.id === sid);
        const history = buildHistory(toStored(base), getMemories(), saved?.summary, saved?.summarized ?? 0, settings?.runtime.memory);
        return agentApi.chatStream(buildChatBody(conn, db.selected, expandRelated, shots.length ? [...history.slice(0, -1), { ...history[history.length - 1]!, images: shots }] : history, rows, llm, { dataContext: contextPayload(conn.profileId), personalSkills: skillsForRun, personalAgents: agentsForRun, ...(agentName ? { agentName } : {}) }), (e) => {
          if (abortRef.current === ctrl && !ctrl.signal.aborted) {
            setLive((l) => [...l, e].slice(-60));
            if (e.depth === 0 && (e.kind === 'thinking' || e.kind === 'tool' || e.kind === 'subagent')) setLiveReply('');
          }
        }, signal, (reply) => {
          if (abortRef.current === ctrl && !ctrl.signal.aborted) setLiveReply(reply);
        });
      });
      if (ctrl.signal.aborted || abortRef.current !== ctrl) return;
      db.setAgentRows(null); // rows are single-use: never re-sent silently
      final = [...base, { id: ++seq.current, role: 'assistant' as const, content: r.reply, sql: r.sql, manifest: r.manifest, model: llm?.model, at: Date.now(), trace: r.trace, ...(r.ask ? { ask: r.ask } : {}), ...(r.proposals?.length ? { proposals: r.proposals } : {}) }].slice(-MAX_CHAT_MSGS);
    } catch (e) {
      if (ctrl.signal.aborted || abortRef.current !== ctrl) return;
      toast.push(errorMessage(e), 'error');
      final = [...base, { id: ++seq.current, role: 'assistant' as const, content: errorMessage(e), error: true, at: Date.now() }].slice(-MAX_CHAT_MSGS);
    } finally { if (abortRef.current === ctrl) { abortRef.current = null; setSending(false); setLiveReply(''); } }
    setMsgs(final);
    persist(final);
    void summarize(sid, conn, llm);
  };

  /** Best-effort: fold messages that left the verbatim window into the session summary (one extra LLM call, no table metadata). */
  const summarize = async (sid: string, c: NonNullable<typeof conn>, choice: AgentLlmChoice | null) => {
    const s = getChats().find((x) => x.id === sid);
    const older = s ? pendingSummary(s, settings?.runtime.memory) : [];
    if (!s || older.length === 0 || summaryRuns.current.has(sid)) return;
    const ctrl = new AbortController();
    summaryRuns.current.set(sid, ctrl);
    const covered = s.messages.length - (settings?.runtime.memory.keepRecent ?? DEFAULT_RUNTIME.memory.keepRecent);
    try {
      const r = await agentApi.chat(buildChatBody(c, [], false, [summaryRequest(s.summary, older, settings?.runtime.memory)], null, choice, { plain: true }), ctrl.signal);
      const summary = r.reply.replace(/```[\s\S]*?```/g, '').trim().slice(0, settings?.runtime.memory.summaryOutputChars);
      const cur = getChats().find((x) => x.id === sid);
      // Apply only to the same transcript prefix. Storage may have evicted old messages meanwhile.
      if (!ctrl.signal.aborted && cur && summary && cur.summarized === s.summarized && cur.messages.length >= s.messages.length && s.messages.every((m, i) => cur.messages[i]?.at === m.at && cur.messages[i]?.content === m.content)) {
        saveChat({ ...cur, summary, summarized: covered });
      }
    } catch { /* the next message retries */ }
    finally { summaryRuns.current.delete(sid); }
  };

  const pickLlm = (v: string) => {
    const c = parseChoice(v);
    if (!settings || !isAllowed(settings, c)) return;
    setLlm(c);
    try { localStorage.setItem(LLM_KEY, v); } catch { /* per-browser convenience only */ }
  };
  const llmEp = settings?.endpoints.find((e) => e.id === llm?.endpointId);
  const ctxExtra: ReactNode = db.selected.length > 0 ? (
    <div className="agent-chips" aria-label={t('agent.selectedTables')}>
      {db.selected.map((r) => (
        <span key={`${r.schema}.${r.name}`} className="agent-chip">
          {r.schema}.{r.name}
          <button type="button" aria-label={`${t('agent.rowsRemove')} ${r.schema}.${r.name}`} onClick={() => db.setSelected(db.selected.filter((x) => x !== r))}>×</button>
        </span>
      ))}
    </div>
  ) : null;
  const header = (
    <div className="agent-head">
      <div className="agent-head__row">
        <span className={`agent-dot${tokenState?.configured ? ' agent-dot--on' : ''}`} aria-hidden="true" />
        <strong className="agent-head__title">{t('agent.title')}</strong>
        <span className="agent-badge">Copilot</span>
        <span style={{ flex: 1 }} />
        {tokenState?.configured && (<>
          <Button size="sm" variant="ghost" onClick={newChat} aria-label={t('chats.new')} title={t('chats.new')}><Icon name="plus" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setView((v) => (v === 'sessions' ? 'chat' : 'sessions'))} aria-label={t('chats.title')} title={t('chats.title')} aria-pressed={view === 'sessions'}><Icon name="history" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setView((v) => (v === 'memory' ? 'chat' : 'memory'))} aria-label={t('memory.title')} title={t('memory.title')} aria-pressed={view === 'memory'}><Icon name="snippet" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setShowSetup((v) => !v)} aria-label={t('agent.settings')} title={t('agent.settings')} aria-pressed={showSetup}><Icon name="settings" /></Button>
        </>)}
        {can('agent:use') && <Button size="sm" variant="ghost" onClick={() => setView((v) => v === 'personal' ? 'chat' : 'personal')} aria-label={t('personal.title')} title={t('personal.title')} aria-pressed={view === 'personal'}><Icon name="agent" /></Button>}
        {onClose && <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('agent.collapse')} title={t('agent.collapse')}>–</Button>}
      </div>
      {settings && tokenState?.configured && llm && (
        <div className="agent-head__row agent-head__row--pills">
          <label className="agent-pill agent-pill--model" title={llmEp?.description}>
            <Icon name="agent" />
            <select aria-label={t('agent.chatModel')} value={choiceValue(llm)} onChange={(e) => pickLlm(e.target.value)} disabled={sending}>
              {settings.endpoints.flatMap((e) => e.models.map((m) => <option key={`${e.id}/${m}`} value={choiceValue({ endpointId: e.id, model: m })}>{e.label} — {m}</option>))}
            </select>
            <span className="agent-pill__chev"><Icon name="chevron" /></span>
          </label>
          <label className="agent-pill agent-pill--model">
            <Icon name="agent" />
            <select aria-label={t('personal.chooseAgent')} value={agentName} disabled={sending} onChange={(e) => { newChat(); setAgentName(e.target.value); }}>
              <option value="">{t('personal.auto')}</option>
              {agentName && !personalAgents.some((a) => a.enabled && a.name === agentName) && <option value={agentName} disabled>{t('personal.unavailable')}</option>}
              {personalAgents.filter((a) => a.enabled).map((a) => <option key={a.name} value={a.name}>{a.label}</option>)}
            </select>
            <span className="agent-pill__chev"><Icon name="chevron" /></span>
          </label>
          {view === 'chat' && <ContextDisclosure compact phase="before" manifest={preview} loading={previewLoading} error={previewErr} extra={ctxExtra} selectedCount={db.selected.length} />}
        </div>
      )}
    </div>
  );
  const body = (() => {
    if (!can('agent:use')) return <EmptyState title={t('agent.noPermission')} />;
    if (loadErr) return <div className="ui-error-text" role="alert" style={{ padding: 12 }}>{loadErr} <Button size="sm" onClick={() => void load()}>{t('common.retry')}</Button></div>;
    if (!settings || !tokenState) return <div style={{ padding: 12 }}><Spinner label={t('common.loading')} /></div>;
    return null;
  })();
  if (body || !settings || !tokenState) return <section aria-label={t('agent.title')} className="agent-popup__panel">{header}{body}</section>;

  return (
    <section aria-label={t('agent.title')} className="agent-popup__panel">
      {header}
      {view !== 'personal' && (!tokenState.configured || showSetup) && (
        <div style={{ overflow: 'auto', flex: tokenState.configured ? '0 0 auto' : 1, maxHeight: tokenState.configured ? 360 : undefined }}>
          <TokenSetup key={String(tokenState.configured) + tokenState.model} settings={settings} state={tokenState} onChanged={() => void load()} />
          <OpenMetadataSetup />
        </div>
      )}
      {tokenState.configured && view === 'sessions' && <SessionList activeId={sessionId} onOpen={openSession} onNew={newChat} />}
      {view === 'personal' && <PersonalAgentsManager dialect={conn?.driver} />}
      {tokenState.configured && view === 'memory' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <ContextNotes profileId={conn?.profileId} connName={conn?.name} />
          <MemoryManager />
        </div>
      )}
      {tokenState.configured && view === 'chat' && (
        <>
          {db.agentRows && (
            <div className="ui-row agent-rows" role="status">
              <Badge tone="warning">{t('agent.rowsAttached', { n: db.agentRows.rows.length })}</Badge>
              <Button size="sm" variant="ghost" onClick={() => db.setAgentRows(null)}>{t('agent.rowsRemove')}</Button>
            </div>
          )}
          <div ref={listRef} onScroll={(e) => { const el = e.currentTarget; followReply.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }} aria-live="polite" aria-label={t('agent.conversation')}>
            {msgs.length === 0 && (
              <div className="agent-welcome">
                <div className="agent-welcome__icon"><Icon name="database" /></div>
                <h2>{t('agent.emptyTitle')}</h2>
                <p>{t('agent.emptyDesc')}</p>
                <div className="agent-cards">
                  {SUGGESTIONS.map((c) => (
                    <button key={c.id} type="button" className={`agent-card agent-card--${c.tone}`} disabled={!conn} onClick={() => fillDraft(t(`agent.sug.${c.id}.prompt`, { tbl: promptTable }))}>
                      <span className="agent-card__icon"><Icon name={c.icon} /></span>
                      <span className="agent-card__text"><strong>{t(`agent.sug.${c.id}.title`)}</strong><small>{t(`agent.sug.${c.id}.hint`)}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m) => (
              <div key={m.id} className={`ui-card agent-msg agent-msg--${m.role}`} style={{ padding: 8, borderColor: m.error ? 'var(--ui-danger)' : undefined }}>
                <div className="ui-label">{m.role === 'user' ? t('agent.you') : t('agent.assistant')}{m.model ? ` · ${m.model}` : ''}{m.rowsAttached ? ` · ${t('agent.rowsAttached', { n: m.rowsAttached })}` : ''}
                  {!m.error && <button type="button" className="ui-btn ui-btn--ghost" style={{ float: 'right', padding: '0 6px', fontSize: 'var(--ui-fs-sm)' }} onClick={() => remember(m.content)} title={t('memory.remember')}>{t('memory.remember')}</button>}</div>
                {m.role === 'assistant' && !m.error ? (
                  <div className="ui-col">
                    {parseReply(m.content).map((seg, i) => seg.type === 'text'
                      ? <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{seg.text.trim()}</div>
                      : (seg.lang === 'sql' || seg.lang === '' || seg.lang === 'plsql' || seg.lang === 'pgsql')
                        ? <SqlBlock key={i} sql={seg.code} serverKind={m.sql?.find((s) => s.sql.trim() === seg.code.trim())?.kind} onInsert={(sql) => { db.insertSql(sql); toast.push(t('agent.inserted'), 'success'); }} />
                        : seg.lang === 'html' || seg.lang === 'svg' ? <HtmlBlock key={i} code={seg.code} />
                        : seg.lang === 'chart' ? <ChartBlock key={i} code={seg.code} />
                        : <pre key={i} className="ui-mono ui-card" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{seg.code}</pre>)}
                    {m.proposals && m.proposals.length > 0 && (
                      <div className="ui-col" style={{ gap: 4 }} aria-label={t('ctx.propose')}>
                        <span className="ui-muted" style={{ fontSize: 'var(--ui-fs-sm)' }}>{t('ctx.propose')}</span>
                        {m.proposals.map((p) => (
                          <div key={p.text} className="ui-row" style={{ gap: 6 }}>
                            <span style={{ flex: 1 }}><em>{t(`ctx.kind.${p.kind}`)}</em> · {p.text}</span>
                            <Button size="sm" disabled={savedNotes.has(p.text) || !conn?.profileId} onClick={() => saveProposal(p)}>{savedNotes.has(p.text) ? t('ctx.saved') : t('ctx.save')}</Button>
                          </div>
                        ))}
                      </div>
                    )}
                    {m.ask && m.ask.options.length > 0 && m.id === msgs[msgs.length - 1]?.id && (
                      <div className="ui-row" style={{ flexWrap: 'wrap', gap: 6 }} role="group" aria-label={t('trace.tool.ask_user')}>
                        {m.ask.options.map((o) => <Button key={o} size="sm" disabled={sending} onClick={() => void send(o)}>{o}</Button>)}
                      </div>
                    )}
                    {m.trace && <TraceSummary trace={m.trace} />}
                    {m.manifest && <ContextDisclosure phase="after" manifest={m.manifest} />}
                  </div>
                ) : (<>
                  {m.images && m.images.length > 0 && (
                    <div className="ui-row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                      {m.images.map((src, i) => <img key={i} src={src} alt="" style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, border: '1px solid var(--ui-border)' }} />)}
                    </div>
                  )}
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
                </>)}
              </div>
            ))}
            {sending && liveReply && <div className="ui-card agent-msg agent-msg--assistant" style={{ padding: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{liveReply}</div>}
            {sending && <div className="ui-row"><Spinner label={t('agent.thinking')} /> <LiveStatus events={live} /></div>}
          </div>
          <form className="agent-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <div className="agent-input__wrap" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
              onDrop={(e) => { const f = imageFiles(e.dataTransfer); if (f.length) { e.preventDefault(); void addImages(f); } }}>
              {images.length > 0 && (
                <div className="ui-row" style={{ flexWrap: 'wrap', gap: 6, padding: '6px 8px 0' }}>
                  {images.map((src, i) => (
                    <span key={i} style={{ position: 'relative' }}>
                      <img src={src} alt="" style={{ height: 52, borderRadius: 6, border: '1px solid var(--ui-border)', display: 'block' }} />
                      <button type="button" className="agent-chip" aria-label={t('agent.imageRemove')} title={t('agent.imageRemove')} onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                        style={{ position: 'absolute', top: -6, right: -6, padding: '0 5px', cursor: 'pointer' }}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <textarea ref={inputRef} className="agent-input__box" aria-label={t('agent.ask')} placeholder={t('agent.placeholder')} rows={1} value={draft} disabled={!conn}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => { const f = imageFiles(e.clipboardData); if (f.length) { e.preventDefault(); void addImages(f); } }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim() || images.length) void send(); } }} />
              <div className="agent-input__bar">
                <button type="button" className="agent-tool" disabled={!conn} title={t('agent.insertTable')} onClick={() => insertAtCaret(selectedNames.length ? selectedNames.join(', ') : '@')}><b>@</b> {t('agent.tableBtn')}</button>
                <button type="button" className="agent-tool" disabled={!conn} title={t('agent.insertSql')} onClick={() => insertAtCaret(SQL_TEMPLATE)}><Icon name="code" /> {t('agent.sqlTemplate')}</button>
                <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addImages(imageFiles(e.target.files)); e.target.value = ''; }} />
                <button type="button" className="agent-tool" disabled={!conn || images.length >= MAX_IMAGES} title={t('agent.attachImage')} onClick={() => fileRef.current?.click()}>🖼 {t('agent.imageBtn')}</button>
                <span style={{ flex: 1 }} />
                {sending && <Button type="button" variant="ghost" onClick={cancelRun}>{t('common.cancel')}</Button>}
                <Button type="submit" variant="primary" disabled={!conn || (!draft.trim() && images.length === 0)} loading={sending}>{t('agent.send')} <Icon name="send" /></Button>
              </div>
            </div>
            <div className="agent-input__note">{t('agent.disclaimer')}{images.length > 0 && ` ${t('agent.imageNote')}`}</div>
          </form>
        </>
      )}
    </section>
  );
});
