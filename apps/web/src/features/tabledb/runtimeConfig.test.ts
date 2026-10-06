import { describe, expect, it } from 'vitest';
import { apiClient } from '../../api/client';
import { TauriGateway } from '../../gateway/TauriGateway';
import { dbRuntimeConfig, loadDbRuntimeConfig, setDbRuntimeConfig } from './runtimeConfig';
import { TEST_DB_CONFIG } from '../../test/dbConfig';

describe('server DB configuration', () => {
 it('uses the fetched settings and bounds query parameters restored from an older workspace', async () => {
  apiClient.configure({ fetchImpl: async () => new Response(JSON.stringify({ ...TEST_DB_CONFIG, defaultMaxRows: 25, maxRows: 100, defaultTimeoutSec: 5, maxTimeoutSec: 10, pageSize: 20 }), { headers: { 'Content-Type': 'application/json' } }) });
  await loadDbRuntimeConfig();
  const calls: unknown[] = [];
  const gateway = new TauriGateway({ request: async (method, params) => { calls.push({ method, params }); return {}; }, cancel: async () => true, listen: async () => () => {} });
  await gateway.rpc('s', 'query.execute', { sql: 'select 1', maxRows: 100000, timeoutSec: 600 });
  await gateway.rpc('s', 'query.plan', { sql: 'select 1', timeoutSec: 600 });
  expect(calls).toEqual([
   { method: 'query.execute', params: { sessionId: 's', sql: 'select 1', maxRows: 100, timeoutSec: 10, pageSize: 20 } },
   { method: 'query.plan', params: { sessionId: 's', sql: 'select 1', timeoutSec: 10 } },
  ]);
 });
 it('rejects malformed server settings without replacing valid settings', () => {
  setDbRuntimeConfig(TEST_DB_CONFIG);
  expect(() => setDbRuntimeConfig({ ...TEST_DB_CONFIG, maxRows: 0 })).toThrow();
  expect(dbRuntimeConfig().maxRows).toBe(TEST_DB_CONFIG.maxRows);
 });
});
