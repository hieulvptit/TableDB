import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { AgentPanel } from './AgentPanel';
import { agentApi } from './api';
import { DEFAULT_RUNTIME } from './runtimeConfig';
import { SchemaStore } from '../tabledb/schemaStore';
import type { DbApi } from '../../gateway';
import { getChats, resetWorkspaceForTests, saveChat, installPersonalTemplate } from '../tabledb/workspace';
import { PERSONAL_TEMPLATES } from './personalTemplates';
import type { AgentChatResult } from '../../api/types';

const state = vi.hoisted(() => ({ db: {} as Record<string, unknown> }));
vi.mock('../tabledb/store', () => ({ useTableDbSelector: (selector: (db: unknown) => unknown) => selector(state.db) }));
vi.mock('../tabledb/SchemaTree', () => ({ useStoreVersion: () => {} }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('./api', () => ({ agentApi: { settings: vi.fn(), tokenState: vi.fn(), preview: vi.fn(), chatStream: vi.fn(), chat: vi.fn() } }));

const reply = (text: string): AgentChatResult => ({
  reply: text, sql: [], trace: [], toolCalls: [], proposals: [], ask: null,
  manifest: { included: [], denied: [], droppedForBudget: [], suspiciousFields: 0, budgetChars: 12000, usedChars: 0, rowsIncluded: false },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); resetWorkspaceForTests();
  state.db = { activeConn: { id: 'c1', name: 'PG', driver: 'postgresql', store: new SchemaStore({} as DbApi) }, connections: [], selected: [], agentRows: null, setAgentRows: vi.fn(), setSelected: vi.fn(), insertSql: vi.fn() };
  vi.mocked(agentApi.settings).mockResolvedValue({ runtime: DEFAULT_RUNTIME, endpoints: [{ id: 'gw', label: 'Gateway', models: ['m'] }], defaultEndpointId: 'gw', defaultModel: 'm', budgetChars: 12000, openMetadataEnabled: false });
  vi.mocked(agentApi.tokenState).mockResolvedValue({ configured: true, endpointId: 'gw', model: 'm' });
});
async function mount() {
  const view = render(<ToastProvider><AgentPanel /></ToastProvider>);
  await screen.findByRole('textbox');
  return view;
}
async function send(text: string) {
  await userEvent.type(screen.getByRole('textbox'), text);
  await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));
  await waitFor(() => expect(agentApi.chatStream).toHaveBeenCalled());
}

it('ignores a late reply from a cancelled chat while a newer request remains active', async () => {
  const old = deferred<AgentChatResult>(); const next = deferred<AgentChatResult>();
  vi.mocked(agentApi.chatStream).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await mount(); await send('old question');
  const oldSignal = vi.mocked(agentApi.chatStream).mock.calls[0]![2]!;
  await userEvent.click(screen.getByRole('button', { name: 'Cuộc trò chuyện mới' }));
  expect(oldSignal.aborted).toBe(true);
  await send('new question');
  await act(async () => { old.resolve(reply('stale answer')); await old.promise; });
  expect(screen.queryByText('stale answer')).toBeNull();
  expect(screen.getByRole('button', { name: 'Gửi' })).toBeDisabled();
  await act(async () => { next.resolve(reply('current answer')); await next.promise; });
  expect(screen.getByText('current answer')).toBeInTheDocument();
  expect(getChats().find((s) => s.title === 'old question')?.messages).toHaveLength(1);
});

it('cancels a running request when opening a saved session', async () => {
  saveChat({ id: 'saved', title: 'Saved session', createdAt: 1, updatedAt: 1, summarized: 0, messages: [{ role: 'user', content: 'saved question', at: 1 }] });
  const pending = deferred<AgentChatResult>(); vi.mocked(agentApi.chatStream).mockReturnValue(pending.promise);
  await mount(); await send('running question');
  const signal = vi.mocked(agentApi.chatStream).mock.calls[0]![2]!;
  await userEvent.click(screen.getByRole('button', { name: 'Các cuộc trò chuyện' }));
  await userEvent.click(screen.getByRole('button', { name: 'Saved session' }));
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(reply('wrong session answer')); await pending.promise; });
  expect(screen.getByText('saved question')).toBeInTheDocument();
  expect(screen.queryByText('wrong session answer')).toBeNull();
});

it('shows partial text and cancels the active request on unmount', async () => {
  const pending = deferred<AgentChatResult>(); vi.mocked(agentApi.chatStream).mockReturnValue(pending.promise);
  const view = await mount(); await send('stream question');
  const call = vi.mocked(agentApi.chatStream).mock.calls[0]!;
  act(() => call[3]?.('Partial answer'));
  expect(screen.getByText('Partial answer')).toBeInTheDocument();
  view.unmount();
  expect(call[2]!.aborted).toBe(true);
  await act(async () => { pending.resolve(reply('late')); await pending.promise; });
});

it('sends the selected specialist and personal definitions and remembers the selection in its session', async () => {
  const template = PERSONAL_TEMPLATES[0]!;
  installPersonalTemplate(template.skill, template.agent);
  vi.mocked(agentApi.chatStream).mockResolvedValue(reply('reconciliation answer'));
  await mount();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Chọn agent chuyên môn' }), template.agent.name);
  await send('đối soát hôm nay');
  await waitFor(() => expect(getChats()[0]?.messages.at(-1)?.content).toBe('reconciliation answer'));
  const body = vi.mocked(agentApi.chatStream).mock.calls[0]![0];
  expect(body.agentName).toBe(template.agent.name);
  expect(body.personalSkills).toEqual([template.skill]);
  expect(body.personalAgents).toEqual([template.agent]);
  expect(getChats()[0]?.agentName).toBe(template.agent.name);
});

it('keeps the summary boundary aligned as an active chat crosses the storage limit', async () => {
  saveChat({ id: 'full', title: 'Full session', createdAt: 1, updatedAt: 1, summary: 'previous summary', summarized: 190, messages: Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}`, at: i })) });
  vi.mocked(agentApi.chatStream).mockResolvedValue(reply('answer'));
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Các cuộc trò chuyện' }));
  await userEvent.click(screen.getByRole('button', { name: 'Full session' }));
  await send('next question');
  await waitFor(() => expect(getChats().find((s) => s.id === 'full')?.messages.at(-1)?.content).toBe('answer'));
  const saved = getChats().find((s) => s.id === 'full')!;
  expect(saved.messages).toHaveLength(200);
  expect(saved.summarized).toBe(188);
  expect(saved.messages[saved.summarized]!.content).toBe('turn 190');
  expect(vi.mocked(agentApi.chatStream).mock.calls[0]![0].messages[0]!.content).toContain('previous summary');
});

it('deduplicates summaries, uses configured keepRecent, and preserves appended turns', async () => {
  const config = { ...DEFAULT_RUNTIME, memory: { ...DEFAULT_RUNTIME.memory, keepRecent: 4, summarizeAfter: 6 } };
  vi.mocked(agentApi.settings).mockResolvedValue({ runtime: config, endpoints: [{ id: 'gw', label: 'Gateway', models: ['m'] }], defaultEndpointId: 'gw', defaultModel: 'm', budgetChars: 12000, openMetadataEnabled: false });
  saveChat({ id: 'long', title: 'Long session', createdAt: 1, updatedAt: 1, summarized: 0, messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}`, at: i })) });
  const summary = deferred<AgentChatResult>(); vi.mocked(agentApi.chat).mockReturnValue(summary.promise);
  vi.mocked(agentApi.chatStream).mockResolvedValue(reply('answer'));
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Các cuộc trò chuyện' }));
  await userEvent.click(screen.getByRole('button', { name: 'Long session' }));
  await send('next question');
  await waitFor(() => expect(agentApi.chat).toHaveBeenCalledTimes(1));
  await send('another question');
  await waitFor(() => expect(getChats().find((s) => s.id === 'long')?.messages).toHaveLength(12));
  expect(agentApi.chat).toHaveBeenCalledTimes(1);
  await act(async () => { summary.resolve(reply('updated summary')); await summary.promise; });
  const saved = getChats().find((s) => s.id === 'long')!;
  expect(saved.summary).toBe('updated summary');
  expect(saved.summarized).toBe(6); // snapshot had 10 messages, keepRecent is 4
  expect(saved.messages).toHaveLength(12);
});
