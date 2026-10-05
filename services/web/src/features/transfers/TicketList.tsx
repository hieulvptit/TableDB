import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, Select, Table } from '@vnpay/ui';
import { TICKET_STATUSES, STATUS_LABEL_VI } from '@vnpay/shared';
import { AsyncView } from '../../components/AsyncView';
import { useAsync } from '../../hooks';
import { t } from '../../i18n';
import { fmtBytes, fmtDate } from '../../lib';
import { transfersApi, type TransferView } from '../../api/services';
import type { TicketView } from '../../api/types';
import { NotifyIndicator, TicketStatusBadge } from './TicketBadges';

function FileIcon() {
  return (
    <svg className="tr-file__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TicketTable({ rows, showRequester }: { rows: TicketView[]; showRequester?: boolean }) {
  if (rows.length === 0) return <EmptyState title={t('tr.empty')} />;
  return (
    <Table caption={t('tr.tableCaption')} className="tr-table">
      <thead><tr>
        <th scope="col">{t('tr.code')}</th><th scope="col">{t('dir.label')}</th><th scope="col">{t('tr.file')}</th><th scope="col">{t('tr.size')}</th><th scope="col">{t('tr.status')}</th>
        <th scope="col">{t('tr.notify')}</th><th scope="col">{t('tr.created')}</th><th scope="col">{t('tr.expires')}</th>{showRequester && <th scope="col">{t('tr.requester')}</th>}
      </tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><Link to={`/transfers/${r.id}`} className="tr-code">{r.code}</Link></td>
            <td>{t(`dir.${r.direction}`)}</td>
            <td title={r.purpose}><span className="tr-file"><FileIcon />{r.fileName}</span></td>
            <td className="tr-num">{fmtBytes(r.size)}</td>
            <td><TicketStatusBadge status={r.status} /></td>
            <td>{r.status === 'PENDING_APPROVAL' ? <NotifyIndicator state={r.notifyState} /> : <span className="ui-muted">—</span>}</td>
            <td className="tr-num">{fmtDate(r.createdAt)}</td>
            <td className="tr-num">{fmtDate(r.expiresAt)}</td>
            {showRequester && <td className="ui-mono">{r.requesterId.slice(0, 8)}</td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function TicketList({ view, defaultStatus = '' }: { view: TransferView; defaultStatus?: string }) {
  const [status, setStatus] = useState(defaultStatus);
  const state = useAsync(() => transfersApi.list(view, status || undefined), [view, status], { pollMs: 20000 });
  return (
    <div className="ui-col tr-list">
      <div className="ui-row tr-filters">
        <Select label={t('tr.filterStatus')} value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('tr.allStatuses')}
          options={TICKET_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL_VI[s] }))} />
        <Button onClick={state.reload} style={{ alignSelf: 'flex-end' }}>{t('common.refresh')}</Button>
      </div>
      <AsyncView state={state}>{(rows) => <TicketTable rows={rows} showRequester={view === 'inbox' || view === 'all'} />}</AsyncView>
    </div>
  );
}
