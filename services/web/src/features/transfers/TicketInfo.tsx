import { useState } from 'react';
import { canRevoke, type Principal, type TicketRef } from '@vnpay/shared';
import { Button, Dialog, useToast } from '@vnpay/ui';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, t } from '../../i18n';
import { fmtBytes, fmtDate } from '../../lib';
import { transfersApi } from '../../api/services';
import type { PiiReport, TicketDetail, TicketEvent, TicketView } from '../../api/types';
import { NotifyIndicator, TicketStatusBadge } from './TicketBadges';

export function EventTimeline({ events }: { events: TicketEvent[] }) {
  if (!events?.length) return <div className="ui-muted">{t('td.noEvents')}</div>;
  return (
    <ol aria-label={t('td.timeline')} className="td-timeline">
      {events.map((e, i) => (
        <li key={String(e.id ?? i)}>
          <span aria-hidden className="td-timeline__dot" />
          <div><strong>{e.kind ? (t(`ev.${e.kind}`) === `ev.${e.kind}` ? e.kind : t(`ev.${e.kind}`)) : '—'}</strong> <span className="ui-muted">{fmtDate(e.at)}</span></div>
          {e.actor_id && <div className="ui-muted ui-mono">{e.actor_id}</div>}
          {e.data && Object.keys(e.data).length > 0 && <div className="ui-muted" style={{ fontSize: 12, wordBreak: 'break-word' }}>{Object.entries(e.data).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}</div>}
        </li>
      ))}
    </ol>
  );
}

export function TicketHeading({ tk }: { tk: TicketView }) {
  return (
    <div className="ui-row td-heading">
      <h1>{tk.code}</h1>
      <TicketStatusBadge status={tk.status} />
      <NotifyIndicator state={tk.notifyState} />
    </div>
  );
}

export function TicketFields({ tk }: { tk: TicketView }) {
  return (
    <div className="ui-card">
      <dl className="nt-summary">
        <dt>{t('nt.file')}</dt><dd>{tk.fileName} ({fmtBytes(tk.size)})</dd>
        <dt>{t('dir.label')}</dt><dd>{t(`dir.${tk.direction}`)}</dd>
        <dt>{t('td.approver')}</dt><dd>{tk.approverName ? `${tk.approverName} (${tk.approverEmail})` : (tk.approverEmail ?? tk.approverId)}</dd>
        <dt>SHA-256</dt><dd className="ui-mono">{tk.sha256}</dd>
        <dt>{t('nt.purpose')}</dt><dd className="nt-pre">{tk.purpose}</dd>
        <dt>{t('tr.created')}</dt><dd>{fmtDate(tk.createdAt)}</dd>
        <dt>{t('tr.expires')}</dt><dd>{fmtDate(tk.expiresAt)}</dd>
        <dt>{t('td.downloads')}</dt><dd>{tk.downloadCount} / {tk.maxDownloads}</dd>
        {tk.decisionReason && <><dt>{t('td.reason')}</dt><dd>{tk.decisionReason}</dd></>}
      </dl>
    </div>
  );
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
}

export function PiiWarning({ report }: { report?: PiiReport | null }) {
  if (!report) return null;
  if (report.coverage === 'unavailable' || report.coverage === 'metadata_only') return <div role="status" className="fc-warn">{t(report.coverage === 'metadata_only' ? 'td.pii.encrypted' : 'td.pii.unavailable')}</div>;
  return <div role={report.detected ? 'alert' : 'status'} className={report.detected ? 'fc-warn' : 'ui-muted'}>
    {report.detected ? t('td.pii.detected', { categories: report.categories.map((c) => t(`td.pii.category.${c}`)).join(', ') }) : t('td.pii.clear')}
  </div>;
}

/** Who/when/what trace: uploader, upload timing, client (IP/UA only when the server sent them = audit:read), file type, scan result. */
export function TraceFields({ d }: { d: TicketDetail }) {
  const { uploader, upload, fileType, scan } = d;
  if (!uploader && !upload && !fileType && !scan) return null;
  return (
    <div className="ui-card">
      <dl className="nt-summary" aria-label={t('td.uploader')}>
        {uploader && <><dt>{t('td.uploader')}</dt><dd>{uploader.name ? `${uploader.name} (${uploader.email})` : uploader.email}</dd></>}
        {upload?.startedAt && <><dt>{t('td.uploadStarted')}</dt><dd>{fmtDate(upload.startedAt)}</dd></>}
        {upload?.completedAt && <><dt>{t('td.uploadCompleted')}</dt><dd>{fmtDate(upload.completedAt)}</dd></>}
        {upload?.durationMs != null && <><dt>{t('td.uploadDuration')}</dt><dd>{fmtDuration(upload.durationMs)}</dd></>}
        {upload?.throughputBps != null && upload.throughputBps > 0 && <><dt>{t('td.uploadThroughput')}</dt><dd>{fmtBytes(upload.throughputBps)}/s</dd></>}
        {upload?.clientKind && <><dt>{t('td.clientKind')}</dt><dd>{t(`td.client.${upload.clientKind}`)}</dd></>}
        {upload?.clientIp && <><dt>{t('td.clientIp')}</dt><dd className="ui-mono">{upload.clientIp}</dd></>}
        {upload?.userAgent && <><dt>{t('td.userAgent')}</dt><dd className="ui-mono" style={{ wordBreak: 'break-all' }}>{upload.userAgent}</dd></>}
        {fileType && <><dt>{t('td.fileType')}</dt><dd>{fileType.label || fileType.detected} <span className="ui-muted">({t('td.typeDetected', { type: fileType.detected })})</span></dd></>}
        {scan && <><dt>{t('td.scan')}</dt><dd>{scan.result === 'clean' ? t('td.scan.clean') : scan.result === 'infected' ? t('td.scan.infected', { sig: scan.signature ?? '?' }) : scan.result === 'skipped' ? t(scan.reason === 'av_disabled' ? 'td.scan.disabled' : 'td.scan.skipped') : t('td.scan.pending')}{scan.scannedAt ? <span className="ui-muted"> · {fmtDate(scan.scannedAt)}</span> : null}</dd></>}
      </dl>
      <PiiWarning report={d.pii} />
      {fileType?.mismatch && <div role="alert" className="fc-warn">{t('td.typeMismatch', { ext: fileType.declaredExt, type: fileType.detected })}</div>}
      {fileType?.executable && <div role="alert" className="fc-warn">{t('td.executable')}</div>}
      {!fileType?.executable && d.manifest?.summary.containsExecutable && <div role="alert" className="fc-warn">{t('td.containsExecutable')}</div>}
    </div>
  );
}

/** Revoke button + confirmation. Shown only when the shared policy says this principal may revoke (server re-checks). */
export function RevokeControl({ tk, onDone }: { tk: TicketView; onDone: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const principal: Principal | null = me ? { id: me.user.id, roles: me.user.roles, grants: me.user.permissions, active: true } : null;
  const ref: TicketRef = { id: tk.id, requesterId: tk.requesterId, approverId: tk.approverId, recipientIds: [], status: tk.status, expiresAt: tk.expiresAt ? new Date(tk.expiresAt) : null, downloadCount: tk.downloadCount, maxDownloads: tk.maxDownloads };
  if (!principal || !canRevoke(principal, ref).allow) return null;
  const revoke = async () => {
    setConfirm(false); setBusy(true);
    try { await transfersApi.revoke(tk.id); toast.push(t('td.revoked'), 'success'); onDone(); }
    catch (e) { if ((e as { code?: string }).code !== 'STEPUP_REQUIRED') toast.push(errorMessage(e), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Button variant="danger" loading={busy} onClick={() => setConfirm(true)}>{t('td.revoke')}</Button>
      <Dialog open={confirm} alert title={t('td.revoke')} onClose={() => setConfirm(false)}
        footer={<><Button data-autofocus onClick={() => setConfirm(false)}>{t('common.cancel')}</Button><Button variant="danger" onClick={() => void revoke()}>{t('td.revoke')}</Button></>}>
        {t('td.revokeConfirm')}
      </Dialog>
    </>
  );
}
