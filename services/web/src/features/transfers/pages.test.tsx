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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ticket = (o: Partial<TicketView> = {}): TicketView => ({
  id: 'T1', code: 'TR-001', status: 'PENDING_APPROVAL', notifyState: 'ERROR', fileName: 'data.csv', size: 2048, sha256: 'a'.repeat(64), purpose: 'p', requesterId: 'r', approverId: 'a',
  createdAt: '2026-09-01T00:00:00Z', expiresAt: null, downloadCount: 0, maxDownloads: 3, direction: 'JUMP_TO_OFFICE', ...o,
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  apiClient.configure({ baseUrl: '/api/v1', onStepUp: undefined, fetchImpl: fetchMock as unknown as typeof fetch });
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
