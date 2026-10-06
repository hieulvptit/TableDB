import { apiClient } from './client';
import type { TicketDetail, TicketView, TransferOptions } from './types';

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

/** Calls used by both targets (read side, revoke, download token). Upload calls live in services.upload, approval/admin calls in services.web. */
export const transfersApi = {
  options: () => apiClient.get<TransferOptions>('/transfers/options'),
  get: (id: string) => apiClient.get<TicketDetail>(`/transfers/${encodeURIComponent(id)}`),
  list: async (view: TransferView, status?: string) => asList<TicketView>(await apiClient.get<unknown>('/transfers', { query: { view, status } }), 'tickets'),
  revoke: (id: string) => apiClient.post(`/transfers/${encodeURIComponent(id)}/revoke`),
  /** one-time, TTL configured by the server; the server only issues it to the destination side of the ticket direction */
  downloadToken: (id: string) => apiClient.post<{ url: string; expiresInSec: number }>(`/transfers/${encodeURIComponent(id)}/download-token`),
};
