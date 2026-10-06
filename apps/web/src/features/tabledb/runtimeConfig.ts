import { apiClient } from '../../api/client';

export interface DbRuntimeConfig {
  defaultMaxRows: number; maxRows: number; defaultTimeoutSec: number; maxTimeoutSec: number;
  pageSize: number; tablePageSize: number; connectTimeoutSec: number; externalAuthTimeoutSec: number;
}
let current: DbRuntimeConfig | null = null;
export function setDbRuntimeConfig(config: DbRuntimeConfig) {
  const keys: (keyof DbRuntimeConfig)[] = ['defaultMaxRows', 'maxRows', 'defaultTimeoutSec', 'maxTimeoutSec', 'pageSize', 'tablePageSize', 'connectTimeoutSec', 'externalAuthTimeoutSec'];
  if (!config || keys.some((k) => !Number.isInteger(config[k]) || config[k] < 1) || config.defaultMaxRows > config.maxRows || config.maxRows > 100000 || config.defaultTimeoutSec > config.maxTimeoutSec || config.maxTimeoutSec > 600 || config.pageSize > 5000 || config.tablePageSize > 5000 || config.connectTimeoutSec > 300 || config.externalAuthTimeoutSec > 600) throw new Error('Invalid server DB configuration');
  current = { ...config };
}
export function dbRuntimeConfig(): DbRuntimeConfig {
  if (!current) throw new Error('Server DB configuration is not loaded');
  return current;
}
export async function loadDbRuntimeConfig() {
  const config = await apiClient.get<DbRuntimeConfig>('/db/config');
  setDbRuntimeConfig(config);
  return config;
}
export const bounded = (value: number | undefined, fallback: number, max: number) => Math.max(1, Math.min(max, Number.isFinite(value) ? Math.floor(value!) : fallback));
