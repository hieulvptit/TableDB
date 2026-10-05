import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS_LABEL_VI } from '@vnpay/shared';
import { ToastProvider } from '@vnpay/ui';
import { apiClient } from '../../api/client';
import type { TicketView } from '../../api/types';
import { DecisionPanel } from './DecisionPanel';
import { TicketList } from './TicketList';
import { validateFile } from './NewTransferPage';
import { saveTicketToDisk, type SaveBridge } from './desktopSave';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ticket = (o: Partial<TicketView> = {}): TicketView => ({
  id: 'T1', code: 'TR-001', status: 'PENDING_APPROVAL', notifyState: 'ERROR', fileName: 'data.csv', size: 2048, sha256: 'a'.repeat(64), purpose: 'p', requesterId: 'r', approverId: 'a',
  createdAt: '2026-09-01T00:00:00Z', expiresAt: null, downloadCount: 0, maxDownloads: 3, direction: 'JUMP_TO_OFFICE', ...o,
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  apiClient.configure({ desktop: false, baseUrl: '/api/v1', onStepUp: undefined, fetchImpl: fetchMock as unknown as typeof fetch });
  apiClient.setCsrfToken('c');
});
const wrap = (ui: React.ReactElement) => render(<ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider>);

describe('ticket list', () => {
  it('shows status label and approver-email notify indicator only while pending approval', async () => {
    fetchMock.mockResolvedValue(json([ticket(), ticket({ id: 'T2', code: 'TR-002', status: 'APPROVED', notifyState: 'SENT' })]));
    wrap(<TicketList view="sent" />);
    expect(await screen.findByText(STATUS_LABEL_VI.PENDING_APPROVAL)).toBeInTheDocument();
    expect(screen.getByText('Chưa gửi được email cho người duyệt')).toBeInTheDocument();
    expect(screen.queryByText('Đã gửi email cho người duyệt')).toBeNull();
  });
  it('degrades gracefully on 403 (no crash, "no access" view)', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403));
    wrap(<TicketList view="all" />);
    expect(await screen.findByText('Không có quyền truy cập')).toBeInTheDocument();
  });
});

describe('DecisionPanel', () => {
  it('reject needs a reason (>=3 chars) and posts it; approve posts without reason', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    const onDone = vi.fn();
    wrap(<DecisionPanel ticket={ticket()} onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Từ chối…' }));
    const confirm = screen.getByRole('button', { name: 'Xác nhận từ chối' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Lý do từ chối/), 'no');
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Lý do từ chối/), 'pe');
    await userEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/decision'))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ decision: 'reject', reason: 'nope' });
  });
  it('server 403 (not the approver) is shown, not thrown', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'FORBIDDEN', message: 'not approver' } }, 403));
    wrap(<DecisionPanel ticket={ticket()} onDone={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Phê duyệt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('không phải người duyệt');
  });
});

describe('validateFile', () => {
  const limits = { maxBytes: 1000, partBytes: 100, allowedExtensions: ['csv', '.xlsx'], defaultTtlHours: 24, maxDownloads: 3 };
  it('enforces size and extension client-side (server re-checks)', () => {
    expect(validateFile(new File(['x'], 'a.csv'), limits)).toBeNull();
    expect(validateFile(new File(['x'], 'a.XLSX'), limits)).toBeNull();
    expect(validateFile(new File(['x'], 'a.exe'), limits)).toMatch(/Định dạng/);
    expect(validateFile(new File([new Uint8Array(2000)], 'a.csv'), limits)).toMatch(/vượt quá/);
    expect(validateFile(new File([], 'a.csv'), limits)).toMatch(/rỗng/);
  });
});

describe('desktop save (office → jump download)', () => {
  const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
  const tk = ticket({ id: 'T9', status: 'APPROVED', direction: 'OFFICE_TO_JUMP', size: bytes.length, sha256: 'b'.repeat(64) });
  const bridge = (o: Partial<SaveBridge> = {}) => {
    const got: number[] = [];
    const b: SaveBridge = {
      begin: vi.fn(async () => 'H1'), chunk: vi.fn(async (_h: string, c: Uint8Array) => { got.push(...c); }),
      finish: vi.fn(async () => 'data.csv'), abort: vi.fn(async () => {}), ...o,
    };
    return { b, got };
  };
  const routes = (sum = tk.sha256) => fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith('/download-token') ? json({ url: 'https://evil.example/api/v1/transfers/T9/download?t=tok', expiresInSec: 60 })
      : new Response(bytes, { status: 200, headers: { 'x-content-sha256': sum } }));

  it('opens the dialog first, then streams every byte to Rust and finishes', async () => {
    routes();
    const { b, got } = bridge();
    expect(await saveTicketToDisk(tk, undefined, b)).toBe('data.csv');
    expect(b.begin).toHaveBeenCalledWith({ fileName: 'data.csv', size: bytes.length, sha256: tk.sha256 });
    expect(Uint8Array.from(got)).toEqual(bytes);
    expect(b.finish).toHaveBeenCalledWith('H1');
    // token URL host is ignored: the download goes to the API base with the token only
    expect(String(fetchMock.mock.calls[1]![0])).toBe('/api/v1/transfers/T9/download?t=tok');
  });
  it('cancelling the dialog spends no download', async () => {
    const { b } = bridge({ begin: vi.fn(async () => { throw { code: 'E_CANCELLED' }; }) });
    expect(await saveTicketToDisk(tk, undefined, b)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a different file from the server aborts the save', async () => {
    routes('c'.repeat(64));
    const { b } = bridge();
    await expect(saveTicketToDisk(tk, undefined, b)).rejects.toThrow(/different file/);
    expect(b.abort).toHaveBeenCalledWith('H1');
    expect(b.finish).not.toHaveBeenCalled();
  });
});
