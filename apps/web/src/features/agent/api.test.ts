import { DEFAULT_RUNTIME } from './runtimeConfig';
import { afterEach, expect, it, vi } from 'vitest';
import { apiClient } from '../../api/client';
import { MemoryTokenStore } from '../../api/tokens';
import { agentApi, setAgentService } from './api';

const config = { runtime: DEFAULT_RUNTIME, endpoints: [{ id: 'server', label: 'Server', baseUrl: 'https://llm.example/v1', models: ['model-new'] }], defaultEndpointId: 'server', defaultModel: 'model-new', budgetChars: 4000, openMetadataEnabled: true };
afterEach(() => { setAgentService(null); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it('loads settings through the pinned native API route and retries after session refresh', async () => {
  const invoke = vi.fn(async (_cmd: string, args?: Record<string, unknown>) => args?.accessToken === 'fresh'
    ? { status: 200, body: JSON.stringify(config) }
    : { status: 401, body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }) });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accessToken: 'fresh', refreshToken: 'refresh-new', expiresAt: Date.now() + 3600000 }), { status: 200 }));
  apiClient.configure({ desktop: true, tokens: new MemoryTokenStore({ accessToken: 'old', refreshToken: 'refresh', expiresAt: Date.now() + 3600000 }), fetchImpl });
  const settings = await agentApi.settings();
  expect(settings.defaultModel).toBe('model-new');
  expect(settings.endpoints).toEqual([{ id: 'server', label: 'Server', models: ['model-new'] }]);
  expect(invoke.mock.calls.map(([cmd, args]) => [cmd, args?.accessToken])).toEqual([['agent_config', 'old'], ['agent_config', 'fresh']]);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('propagates server denial without falling back to local models', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: async () => ({ status: 403, body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'denied' } }) }) };
  apiClient.configure({ desktop: true, tokens: new MemoryTokenStore() });
  await expect(agentApi.settings()).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
});
