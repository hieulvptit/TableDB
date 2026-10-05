import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@vnpay/shared';
import { ToastProvider } from '@vnpay/ui';
import { apiClient } from '../../api/client';
import type { ManifestEntry, ManifestSummary, ManifestView, TicketDetail } from '../../api/types';
import { AuthContext, type AuthState } from '../../auth/AuthContext';
import { AuditPage } from '../admin/AdminPage';
import { FileContentPanel } from './FileContentPanel';
import TicketDetailPage from './TicketDetailPage';
import { TracePanel } from './TracePanel';
import { TraceFields, PiiWarning } from './TicketInfo';
import { errorMessage } from '../../i18n';
import { ApiError } from '../../api/errors';
import { vi as viDict } from '../../i18n/vi';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  apiClient.configure({ baseUrl: '/api/v1', onStepUp: undefined, fetchImpl: fetchMock as unknown as typeof fetch });
  apiClient.setCsrfToken('c');
});

const summary = (o: Partial<ManifestSummary> = {}): ManifestSummary => ({
  version: 1, size: 100, sha256: 'a'.repeat(64), declaredExt: 'csv', detectedType: 'csv', label: 'csv', typeMismatch: false, executable: false,
  containsSensitivePatterns: false, truncated: false, ...o,
});
const view = (s: ManifestSummary, items: ManifestEntry[] = [], total = items.length, offset = 0): ManifestView => ({
  status: 'ok', inspectedAt: '2026-09-01T00:00:00Z', durationMs: 5, manifestHash: 'f'.repeat(64), summary: s, entries: { offset, limit: 100, total, items },
});
const entry = (i: number, o: Partial<ManifestEntry> = {}): ManifestEntry => ({
  idx: i, path: `dir/file${i}.txt`, isDir: false, compressedSize: 10, size: 20, modified: '2026-01-01T00:00:00Z', crc32: 'deadbeef', encrypted: false, zipSlip: false, nested: false, depth: 0, flags: [], ...o,
});
const text = { encoding: 'utf-8' as const, lines: 1234, bytes: 5000, emptyLines: 2, maxLineBytes: 80 };
const wrap = (ui: React.ReactElement) => render(<ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider>);

it('shows a PII warning to the reviewer without exposing detected values', () => {
  const detail = { scan: { result: 'clean' }, pii: { detected: true, categories: ['email', 'national_id'], chunks: 2, engine: 'llm-pii' } } as TicketDetail;
  wrap(<TraceFields d={detail} />);
  expect(screen.getByRole('alert')).toHaveTextContent('LLM phát hiện dữ liệu nhạy cảm (Email, CCCD/CMND)');
  expect(screen.getByRole('alert')).toHaveTextContent('Người duyệt cần xem xét');
});

it('keeps helper failures advisory and distinguishes encrypted content', () => {
 const report = { detected: false, categories: [], chunks: 0, engine: 'llm-pii', coverage: 'unavailable' };
 const {unmount} = wrap(<PiiWarning report={report} />);
 expect(screen.getByRole('status')).toHaveTextContent('Leader có thể tiếp tục');
 unmount();
 wrap(<PiiWarning report={{...report,coverage:'metadata_only'}} />);
 expect(screen.getByRole('status')).toHaveTextContent('chưa kiểm tra nội dung');
});
it('does not claim full coverage for a negative sample', () => {
 wrap(<PiiWarning report={{detected:false,categories:[],chunks:1,engine:'llm-pii',coverage:'sampled'}} />);
 expect(screen.getByRole('status')).toHaveTextContent('mẫu kiểm tra');
 expect(screen.getByRole('status')).not.toHaveTextContent('toàn bộ');
});

describe('FileContentPanel', () => {
  it('shows pending notice without a manifest', () => {
    wrap(<FileContentPanel ticketId="T1" manifest={null} />);
    expect(screen.getByRole('heading', { name: 'Nội dung file' })).toBeInTheDocument();
    expect(screen.getByText(/chưa có thông tin nội dung/i)).toBeInTheDocument();
  });
  it('csv: lines, columns, header names and sensitive-pattern warning (counts only)', () => {
    const s = summary({ text: { ...text, csv: { delimiter: ',', columns: 3, headerNames: ['id', 'phone', 'amount'], headerTruncated: false, dataRows: 1233, raggedRows: 4 } },
      containsSensitivePatterns: true, sensitive: { phone: 7, email: 2, idNumber: 0, card: 1 } });
    wrap(<FileContentPanel ticketId="T1" manifest={view(s)} />);
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('phone')).toBeInTheDocument();
    expect(screen.getByText('1,233')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('7 số điện thoại, 2 email, 0 số CMND/CCCD, 1 số thẻ');
  });
  it('json valid, invalid and jsonl', () => {
    const { unmount } = wrap(<FileContentPanel ticketId="T1" manifest={view(summary({ text: { ...text, json: { valid: true, topLevel: 'array', length: 42, maxDepth: 3 } } }))} />);
    expect(screen.getByText(/Kiểu gốc: array, 42 phần tử\/khóa, độ sâu 3/)).toBeInTheDocument();
    unmount();
    const u2 = wrap(<FileContentPanel ticketId="T1" manifest={view(summary({ text: { ...text, json: { valid: false, topLevel: 'object', length: 0, maxDepth: 0, error: 'unexpected EOF' } } }))} />);
    expect(screen.getByText(/JSON không hợp lệ: unexpected EOF/)).toBeInTheDocument();
    u2.unmount();
    wrap(<FileContentPanel ticketId="T1" manifest={view(summary({ text: { ...text, jsonl: { validLines: 9, invalidLines: 1 } } }))} />);
    expect(screen.getByText('9 dòng hợp lệ, 1 dòng lỗi')).toBeInTheDocument();
  });
  it('inspect error and truncation warnings', () => {
    const m = view(summary({ truncated: true, truncatedReason: 'max entries' }));
    m.status = 'error'; m.inspectError = 'boom';
    wrap(<FileContentPanel ticketId="T1" manifest={m} />);
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts.some((a) => a?.includes('boom'))).toBe(true);
    expect(alerts.some((a) => a?.includes('max entries'))).toBe(true);
  });
  it('zip: table with flags, encrypted + zip-slip warnings, pages through /manifest', async () => {
    const zip = { entryCount: 150, fileCount: 150, dirCount: 0, totalCompressed: 1500, totalUncompressed: 3000, encryptedCount: 1, zipSlipCount: 1, nestedArchiveCount: 0, maxRatio: 2, inspectedEntries: 150 };
    const first = view(summary({ detectedType: 'zip', label: 'zip', zip }), [entry(0, { path: '../evil.sh', zipSlip: true, flags: ['zip-slip', 'executable'] }), entry(1, { flags: ['encrypted'], encrypted: true, lines: 12 })], 150);
    fetchMock.mockResolvedValue(json(view(summary({ detectedType: 'zip', zip }), [entry(100, { path: 'page2.txt' })], 150, 100)));
    wrap(<FileContentPanel ticketId="T1" manifest={first} />);
    const table = screen.getByRole('table', { name: 'Danh sách mục trong file nén' });
    expect(within(table).getByText('../evil.sh')).toBeInTheDocument();
    expect(within(table).getByText('đường dẫn nguy hiểm')).toBeInTheDocument();
    expect(screen.getByText(/1 mục được đặt mật khẩu/)).toBeInTheDocument();
    expect(screen.getByText(/1 mục có đường dẫn nguy hiểm/)).toBeInTheDocument();
    expect(screen.getByText('Mục 1–2 trên 150')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trang trước' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    expect(await screen.findByText('page2.txt')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/transfers/T1/manifest?offset=100&limit=100');
    expect(screen.getByText('Mục 101–101 trên 150')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trang trước' })).not.toBeDisabled();
  });
  it('renders hostile entry names as text, not HTML', () => {
    const zip = { entryCount: 1, fileCount: 1, dirCount: 0, totalCompressed: 1, totalUncompressed: 1, encryptedCount: 0, zipSlipCount: 0, nestedArchiveCount: 0, maxRatio: 1, inspectedEntries: 1 };
    wrap(<FileContentPanel ticketId="T1" manifest={view(summary({ zip }), [entry(0, { path: '<img src=x onerror=alert(1)>' })])} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('TracePanel', () => {
  it('loads on demand and lists audit actions', async () => {
    fetchMock.mockResolvedValue(json({ ticket: { id: 'T1', code: 'TF-1' }, entries: [{ seq: 1, at: '2026-09-01T00:00:00Z', action: 'transfer.create', actorLabel: 'a@b.c', ip: '1.2.3.4' }] }));
    wrap(<TracePanel ticketId="T1" />);
    const btn = screen.getByRole('button', { name: 'Xem dấu vết audit của phiếu' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(await screen.findByText('transfer.create')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ẩn dấu vết' })).toHaveAttribute('aria-expanded', 'true');
  });
  it('degrades gracefully on 403', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403));
    wrap(<TracePanel ticketId="T1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Xem dấu vết audit của phiếu' }));
    expect(await screen.findByText('Không xem được dấu vết của phiếu này.')).toBeInTheDocument();
  });
});

const auth = (perms: Permission[], id = 'u1'): AuthState => ({
  status: 'authenticated', can: (p) => perms.includes(p), refresh: async () => {}, logout: async () => {},
  me: { user: { id, email: 'a@b.c', name: 'A', roles: ['user'], permissions: perms }, csrfToken: 'x', authTime: 0, kind: 'web' },
});

describe('TicketDetailPage trace fields', () => {
  const detail = (o: Partial<TicketDetail> = {}): TicketDetail => ({
    ticket: { id: 'T1', code: 'TF-2026-000001', status: 'PENDING_APPROVAL', notifyState: 'SENT', fileName: 'x.csv', size: 100, sha256: 'a'.repeat(64), purpose: 'p', requesterId: 'r1', approverId: 'u1',
      createdAt: '2026-09-01T00:00:00Z', expiresAt: null, downloadCount: 0, maxDownloads: 3, direction: 'OFFICE_TO_JUMP' } as TicketDetail['ticket'],
    events: [], receivedParts: [1], totalParts: 1,
    uploader: { id: 'r1', name: 'Nguyen Van A', email: 'a@vnpay.vn' },
    upload: { startedAt: '2026-09-01T00:00:01Z', completedAt: '2026-09-01T00:00:03Z', durationMs: 2000, clientKind: 'web', clientIp: '10.0.0.5', userAgent: 'UA/1.0' },
    fileType: { declaredExt: 'csv', detected: 'pe', label: 'PE executable', mismatch: true, executable: true },
    scan: { result: 'clean' }, manifest: view(summary({ text: { ...text, csv: { delimiter: ';', columns: 2, headerNames: ['colA', 'colB'], headerTruncated: false, dataRows: 5, raggedRows: 0 } } })), ...o,
  });
  const open = (d: TicketDetail, perms: Permission[]) => {
    fetchMock.mockResolvedValue(json(d));
    return render(<AuthContext.Provider value={auth(perms)}><ToastProvider><MemoryRouter initialEntries={['/transfers/T1']}><Routes><Route path="/transfers/:id" element={<TicketDetailPage />} /></Routes></MemoryRouter></ToastProvider></AuthContext.Provider>);
  };
  it('shows uploader, timing, IP/UA, mismatch + executable warnings, scan and content panel', async () => {
    open(detail(), ['transfer:approve', 'audit:read']);
    expect(await screen.findByText('Nguyen Van A (a@vnpay.vn)')).toBeInTheDocument();
    expect(screen.getByText('2.0 s')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5')).toBeInTheDocument();
    expect(screen.getByText('UA/1.0')).toBeInTheDocument();
    expect(screen.getByText('Sạch')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('không khớp với phần mở rộng ".csv"'))).toBe(true);
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('thực thi'))).toBe(true);
    expect(screen.getByText('colA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xem dấu vết audit của phiếu' })).toBeInTheDocument();
    // content appears before the decision panel
    const content = screen.getByRole('heading', { name: 'Nội dung file' });
    const decision = screen.getByRole('heading', { name: 'Quyết định phê duyệt' });
    expect(content.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('shows AV bypass without claiming a clean scan or encrypted ZIP', async () => {
    open(detail({ scan: { result: 'skipped', reason: 'av_disabled' } }), ['transfer:approve']);
    expect(await screen.findByText('Bỏ qua quét AV trong ứng dụng')).toBeInTheDocument();
    expect(screen.queryByText('Sạch')).not.toBeInTheDocument();
    expect(screen.queryByText('ZIP có mật khẩu: chỉ xem được danh sách file, chưa kiểm tra nội dung.')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Quyết định phê duyệt' })).toBeInTheDocument();
  });
  it('hides IP/UA when the server did not send them', async () => {
    open(detail({ upload: { startedAt: '2026-09-01T00:00:01Z', clientKind: 'desktop' } }), ['transfer:approve']);
    expect(await screen.findByText('Ứng dụng desktop')).toBeInTheDocument();
    expect(screen.queryByText('10.0.0.5')).toBeNull();
    expect(screen.queryByText('UA/1.0')).toBeNull();
  });
});

describe('AuditPage', () => {
  const entries = [{ seq: 5, at: '2026-09-01T00:00:00Z', actorId: null, actorLabel: 'a@b.c', action: 'transfer.create', resourceType: 'ticket', resourceId: 'abcdef12-0000', ip: '9.9.9.9', detail: { code: 'TF-1', size: 3 }, hash: 'h'.repeat(8) }];
  const mount = () => render(<AuthContext.Provider value={auth(['audit:read'])}><ToastProvider><MemoryRouter><AuditPage /></MemoryRouter></ToastProvider></AuthContext.Provider>);
  it('shows IP column, expandable detail, export links', async () => {
    fetchMock.mockResolvedValue(json({ entries }));
    mount();
    expect(await screen.findByText('9.9.9.9')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Xem chi tiết bản ghi 5' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: 'Ẩn chi tiết bản ghi 5' })).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('audit-d-5')!.textContent).toContain('"code": "TF-1"');
    expect(screen.getByRole('link', { name: 'Xuất CSV' })).toHaveAttribute('href', '/api/v1/audit/export?format=csv');
    expect(screen.getByRole('link', { name: /JSONL/ })).toHaveAttribute('href', '/api/v1/audit/export?format=jsonl');
  });
  it('sends ticket and actorEmail filters', async () => {
    fetchMock.mockResolvedValue(json({ entries }));
    mount();
    await screen.findByText('9.9.9.9');
    await userEvent.type(screen.getByLabelText('Mã phiếu'), 'TF-2026-000001');
    await userEvent.type(screen.getByLabelText('Email người thực hiện'), 'bob@');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));
    await waitFor(() => {
      const last = String(fetchMock.mock.calls.at(-1)![0]);
      expect(last).toContain('ticket=TF-2026-000001');
      expect(last).toContain('actorEmail=bob%40');
    });
  });
});

describe('INSUFFICIENT_STORAGE', () => {
  it('maps to a friendly message', () => {
    expect(errorMessage(new ApiError('INSUFFICIENT_STORAGE', 'x', 507))).toBe(viDict['err.INSUFFICIENT_STORAGE']);
    expect(viDict['err.INSUFFICIENT_STORAGE']).toMatch(/đầy/);
  });
});
