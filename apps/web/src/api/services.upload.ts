import type { UploadInit } from '@vnpay/shared';
import type { UploadApi } from '../features/transfers/uploader';
import { apiClient } from './client';
import { transfersApi } from './services';
import type { UploadInitResult } from './types';

/** Both targets: create a ticket for a new upload (desktop: jump → office, web: office → jump; the server sets the direction). */
export const uploadsApi = {
  create: (b: Omit<UploadInit, 'recipientIds'> & { recipientIds?: string[] }) => apiClient.post<UploadInitResult>('/transfers', { recipientIds: [], ...b }),
};

/** Binds UploadApi to the api client (raw octet-stream parts + X-Part-SHA256). */
export const uploadApi: UploadApi = {
  putPart: async (ticketId, n, data, sha256, signal) => {
    await apiClient.request('PUT', `/transfers/${encodeURIComponent(ticketId)}/parts/${n}`, {
      rawBody: new Blob([data as unknown as BlobPart], { type: 'application/octet-stream' }),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Part-SHA256': sha256 },
      signal,
    });
  },
  received: async (ticketId) => {
    const d = await transfersApi.get(ticketId);
    return { receivedParts: d.receivedParts ?? [], totalParts: d.totalParts };
  },
  complete: (ticketId, key) => apiClient.post(`/transfers/${encodeURIComponent(ticketId)}/complete`, undefined, { headers: { 'Idempotency-Key': key } }),
  abort: (ticketId) => apiClient.post(`/transfers/${encodeURIComponent(ticketId)}/abort`),
};
