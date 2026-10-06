import { startSecureDownload, WEB_SERVER_PUBLIC_KEY } from '@vnpay/shared';
import workerUrl from './secureDownload.worker?worker&url';
import { apiClient } from '../../api/client';
import { transfersApi } from '../../api/services';

/**
 * Download: POST download-token (re-checks policy + step-up; STEPUP_REQUIRED is handled centrally by apiClient) then navigate.
 * Browser navigation (Content-Disposition: attachment) with the session cookie. BO portal only.
 */
export async function downloadTicket(id: string): Promise<void> {
  const { url } = await transfersApi.downloadToken(id);
  // The API returns an absolute URL built from its PUBLIC_URL. Only path+query are trusted: they are re-anchored to the
  // page origin so credentials never go elsewhere.
  const u = new URL(url, window.location.origin);
  if (!/\/transfers\/[^/]+\/download$/.test(u.pathname) || !u.searchParams.get('t')) throw new Error('unexpected download URL');
  await startSecureDownload(workerUrl, apiClient.baseUrl, import.meta.env.VITE_SECURE_WEB_PUBLIC_KEY ?? WEB_SERVER_PUBLIC_KEY, u.pathname + u.search);
}
