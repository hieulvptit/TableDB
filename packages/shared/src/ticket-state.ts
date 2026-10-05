export const TICKET_STATUSES = [
  'UPLOADING', 'SCANNING', 'PENDING_APPROVAL', 'APPROVED', 'DOWNLOADED',
  'REJECTED', 'EXPIRED', 'REVOKED', 'QUARANTINED', 'ABORTED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Delivery state of the approval-request email to the approver (independent of the workflow status). */
export const NOTIFY_STATES = ['PENDING', 'SENT', 'ERROR'] as const;
export type NotifyState = (typeof NOTIFY_STATES)[number];

const T: Record<TicketStatus, TicketStatus[]> = {
  UPLOADING: ['SCANNING', 'ABORTED', 'REVOKED', 'EXPIRED'],
  SCANNING: ['PENDING_APPROVAL', 'QUARANTINED', 'REVOKED', 'EXPIRED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED', 'QUARANTINED'],
  APPROVED: ['DOWNLOADED', 'EXPIRED', 'REVOKED', 'QUARANTINED'],
  DOWNLOADED: ['DOWNLOADED', 'EXPIRED', 'REVOKED', 'QUARANTINED'],
  REJECTED: [], EXPIRED: [], REVOKED: [], QUARANTINED: [], ABORTED: [],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return T[from].includes(to);
}
export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal ticket transition ${from} -> ${to}`);
}
export const TERMINAL: TicketStatus[] = ['REJECTED', 'EXPIRED', 'REVOKED', 'QUARANTINED', 'ABORTED'];

/** Vietnamese labels used by the UI and emails. */
export const STATUS_LABEL_VI: Record<TicketStatus, string> = {
  UPLOADING: 'Đang tải lên', SCANNING: 'Chờ kiểm tra', PENDING_APPROVAL: 'Chờ duyệt', APPROVED: 'Đã duyệt',
  DOWNLOADED: 'Đã tải', REJECTED: 'Từ chối', EXPIRED: 'Hết hạn', REVOKED: 'Đã thu hồi',
  QUARANTINED: 'Cách ly (mã độc)', ABORTED: 'Đã hủy upload',
};

/**
 * Which way a file moves. Set by the server from the uploader's session kind, never by the client:
 * desktop (installed on the jump host) uploads go to the office; web BO (office) uploads go to the jump host.
 */
export const TRANSFER_DIRECTIONS = ['JUMP_TO_OFFICE', 'OFFICE_TO_JUMP'] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];
export type ClientKind = 'web' | 'desktop';

export const directionForUploader = (kind: ClientKind): TransferDirection => (kind === 'desktop' ? 'JUMP_TO_OFFICE' : 'OFFICE_TO_JUMP');
/** The only client kind that may download a ticket of this direction (the side the file is going to). */
export const downloadClientFor = (d: TransferDirection): ClientKind => (d === 'JUMP_TO_OFFICE' ? 'web' : 'desktop');

export const DIRECTION_LABEL_VI: Record<TransferDirection, string> = {
  JUMP_TO_OFFICE: 'Jump → Office', OFFICE_TO_JUMP: 'Office → Jump',
};
