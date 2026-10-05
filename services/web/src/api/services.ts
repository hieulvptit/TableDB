import { apiClient } from './client';
import type { ManifestView, TicketDetail, TraceResult, TicketView, TransferOptions } from './types';

/** API list routes may return a bare array or an envelope; accept both. */
export function asList<T>(r: unknown, ...keys: string[]): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    for (const k of [...keys, 'items', 'data', 'rows']) if (Array.isArray(o[k])) return o[k] as T[];
  }
  return [];
}

export type TransferView = 'sent' | 'inbox' | 'approvals' | 'all';

/** Calls for the read side (read side, revoke, download token). Upload calls live in services.upload, approval/admin calls in services.web. */
export const transfersApi = {
  options: () => apiClient.get<TransferOptions>('/transfers/options'),
  get: (id: string) => apiClient.get<TicketDetail>(`/transfers/${encodeURIComponent(id)}`),
  manifest: (id: string, offset = 0, limit = 100) => apiClient.get<ManifestView>(`/transfers/${encodeURIComponent(id)}/manifest`, { query: { offset, limit } }),
  trace: (id: string) => apiClient.get<TraceResult>(`/transfers/${encodeURIComponent(id)}/trace`),
  list: async (view: TransferView, status?: string) => asList<TicketView>(await apiClient.get<unknown>('/transfers', { query: { view, status } }), 'tickets'),
  revoke: (id: string) => apiClient.post(`/transfers/${encodeURIComponent(id)}/revoke`),
  /** one-time, 60 s; the server only issues it to the destination side of the ticket direction */
  downloadToken: (id: string) => apiClient.post<{ url: string; expiresInSec: number }>(`/transfers/${encodeURIComponent(id)}/download-token`),
};

/** Same-origin download URLs for the audit export (cookie auth; the browser downloads the streamed attachment). */
export const auditApi = {
  exportUrl: (format: 'csv' | 'jsonl', range: { from?: string; to?: string } = {}) => apiClient.url('/audit/export', { format, from: range.from, to: range.to }),
};
