import { afterEach, expect, it, vi } from 'vitest';
import { tauriAgentHttp } from './bridge';
import { desktopCommands, tauriChannel } from '../../../runtime/tauri';

vi.mock('../../../runtime/tauri', () => ({
  desktopCommands: { agentHttp: vi.fn(), agentHttpCancel: vi.fn(async () => {}) },
  tauriChannel: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it('decodes UTF-8 across chunks and closes the request channel', async () => {
  let receive: (bytes: number[]) => void = () => {};
  const cleanup = vi.fn();
  vi.mocked(tauriChannel).mockImplementation((handler) => { receive = handler; return { id: '__CHANNEL__:7', close: cleanup }; });
  const parts: string[] = [];
  vi.mocked(desktopCommands.agentHttp).mockImplementation(async (_requestId, req, channel) => {
    expect(req).toMatchObject({ stream: true });
    expect(channel).toBe('__CHANNEL__:7');
    const bytes = new TextEncoder().encode('chào 👋');
    for (const byte of bytes) receive([byte]);
    return { status: 200, contentType: 'text/event-stream', body: '' };
  });
  await tauriAgentHttp({ target: { kind: 'llm', endpointId: 'gw' }, method: 'POST' }, undefined, (s) => parts.push(s));
  expect(parts.join('')).toBe('chào 👋');
  expect(cleanup).toHaveBeenCalledOnce();
});

it('does not invoke a request cancelled while registering its channel', async () => {
  const ctrl = new AbortController();
  const cleanup = vi.fn();
  vi.mocked(tauriChannel).mockImplementation(() => { ctrl.abort(); return { id: '__CHANNEL__:7', close: cleanup }; });
  await expect(tauriAgentHttp({ target: { kind: 'llm', endpointId: 'gw' }, method: 'POST' }, ctrl.signal, () => {})).rejects.toThrow('cancelled');
  expect(desktopCommands.agentHttp).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
});
