import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, useToast } from '@vnpay/ui';
import { AsyncView } from '../../components/AsyncView';
import { useAuth } from '../../auth/AuthContext';
import { useAsync } from '../../hooks';
import { errorMessage, t } from '../../i18n';
import { transfersApi } from '../../api/services';
import type { TicketDetail } from '../../api/types';
import { downloadTicket } from './download';
import { DecisionPanel } from './DecisionPanel';
import { EventTimeline, RevokeControl, TicketFields, TicketHeading, TraceFields } from './TicketInfo';
import { FileContentPanel } from './FileContentPanel';
import { TracePanel } from './TracePanel';

/** BO portal ticket detail: read, download (jump → office tickets only), revoke, approve/reject, admin approver change. No resume here. */
export default function TicketDetailPage() {
  const { id = '' } = useParams();
  const state = useAsync(() => transfersApi.get(id), [id], { pollMs: 10000 });
  return <div className="td-page"><AsyncView state={state}>{(d) => <Detail d={d} reload={state.reload} />}</AsyncView></div>;
}

function Detail({ d, reload }: { d: TicketDetail; reload: () => void }) {
  const { me, can } = useAuth();
  const toast = useToast();
  const tk = d.ticket;
  const [busy, setBusy] = useState('');

  const isRequester = me?.user.id === tk.requesterId;
  // UI hint only (server decides): approved/downloaded, has permission, and the download budget is not used up
  const approved = (tk.status === 'APPROVED' || tk.status === 'DOWNLOADED') && tk.downloadCount < tk.maxDownloads;
  const downloadOk = can('transfer:download') && approved && tk.direction === 'JUMP_TO_OFFICE';

  const run = async (name: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(name);
    try { await fn(); if (okMsg) toast.push(okMsg, 'success'); reload(); }
    catch (e) {
      if ((e as { code?: string }).code === 'STEPUP_REQUIRED') return; // page is redirecting / re-authenticating
      toast.push(errorMessage(e), 'error');
    } finally { setBusy(''); }
  };

  return (
    <div className="ui-col td-col">
      <div><Link to="/transfers" className="td-back">← {t('td.back')}</Link></div>
      <TicketHeading tk={tk} />
      <TicketFields tk={tk} />
      <TraceFields d={d} />
      <FileContentPanel ticketId={tk.id} manifest={d.manifest} />

      <div className="ui-row nt-actions">
        {downloadOk && <Button variant="primary" loading={busy === 'dl'} onClick={() => void run('dl', () => downloadTicket(tk.id))}>{t('td.download')}</Button>}
        <RevokeControl tk={tk} onDone={reload} />
      </div>
      {approved && !downloadOk && tk.direction === 'OFFICE_TO_JUMP' && <div className="ui-muted">{t('td.downloadElsewhere.OFFICE_TO_JUMP')}</div>}

      {tk.status === 'PENDING_APPROVAL' && can('transfer:approve') && !isRequester && <DecisionPanel ticket={tk} onDone={reload} />}

      {(can('audit:read') || isRequester || me?.user.id === tk.approverId) && <TracePanel ticketId={tk.id} />}

      <div className="ui-card">
        <h2 style={{ marginTop: 0 }}>{t('td.timeline')}</h2>
        <EventTimeline events={d.events} />
      </div>
    </div>
  );
}
