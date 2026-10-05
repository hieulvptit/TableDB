import { useState } from 'react';
import { DecisionBody, type TicketView } from '@vnpay/shared';
import { Button, Dialog, Textarea, useToast } from '@vnpay/ui';
import { errorMessage, t } from '../../i18n';
import { approvalsApi } from '../../api/services.web';

/** Approve / reject. Reject requires a reason (same rule as the server: DecisionBody). */
export function DecisionPanel({ ticket, onDone }: { ticket: TicketView; onDone: () => void }) {
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (decision: 'approve' | 'reject') => {
    const body = { decision, ...(decision === 'reject' ? { reason: reason.trim() } : {}) };
    const parsed = DecisionBody.safeParse(body);
    if (!parsed.success) { setErr(t('dec.reasonRequired')); return; }
    setBusy(true); setErr('');
    try {
      await approvalsApi.decision(ticket.id, parsed.data);
      toast.push(decision === 'approve' ? t('dec.approved') : t('dec.rejected'), 'success');
      setRejecting(false); setReason(''); onDone();
    } catch (e) {
      const forbidden = (e as { code?: string }).code === 'FORBIDDEN';
      setErr(forbidden ? t('dec.notAllowed') : errorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="ui-card nt-card nt-card--sm">
      <h2>{t('dec.title')}</h2>
      <div className="ui-row nt-actions">
        <Button variant="primary" loading={busy && !rejecting} onClick={() => void submit('approve')}>{t('dec.approve')}</Button>
        <Button variant="danger" onClick={() => { setRejecting(true); setErr(''); }}>{t('dec.reject')}</Button>
      </div>
      {!rejecting && err && <div className="ui-error-text" role="alert">{err}</div>}
      <Dialog open={rejecting} title={t('dec.rejectTitle', { code: ticket.code })} onClose={() => setRejecting(false)}
        footer={<><Button onClick={() => setRejecting(false)}>{t('common.cancel')}</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => void submit('reject')}>{t('dec.confirmReject')}</Button></>}>
        <Textarea data-autofocus label={t('dec.reason')} rows={4} value={reason} onChange={(e) => setReason(e.target.value)} error={err || undefined} />
      </Dialog>
    </div>
  );
}
