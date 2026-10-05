import { Badge, StatusBadge, type BadgeTone } from '@vnpay/ui';
import { STATUS_LABEL_VI, type NotifyState, type TicketStatus } from '@vnpay/shared';
import { t } from '../../i18n';

const TONE: Record<TicketStatus, BadgeTone> = {
  UPLOADING: 'info', SCANNING: 'info', PENDING_APPROVAL: 'warning', APPROVED: 'success', DOWNLOADED: 'success',
  REJECTED: 'danger', EXPIRED: 'neutral', REVOKED: 'danger', QUARANTINED: 'danger', ABORTED: 'neutral',
};
export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <StatusBadge label={STATUS_LABEL_VI[status] ?? status} tone={TONE[status] ?? 'neutral'} />;
}

const NOTIFY_TONE: Record<NotifyState, BadgeTone> = { PENDING: 'warning', SENT: 'success', ERROR: 'danger' };
export function NotifyIndicator({ state }: { state: NotifyState }) {
  return <Badge tone={NOTIFY_TONE[state] ?? 'neutral'} title={t(`notify.${state}Hint`)}>{t(`notify.${state}`)}</Badge>;
}
