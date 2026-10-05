import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, useToast } from '@vnpay/ui';
import { AsyncView } from '../../components/AsyncView';
import { useAuth } from '../../auth/AuthContext';
import { useAsync } from '../../hooks';
import { errorMessage, t } from '../../i18n';
import { transfersApi } from '../../api/services';
import { uploadApi } from '../../api/services.upload';
import type { TicketDetail } from '../../api/types';
import { saveTicketToDisk } from './desktopSave';
import { sha256Source } from './hash';
import { EventTimeline, RevokeControl, TicketFields, TicketHeading } from './TicketInfo';
import type { UploadProgress } from './uploader';
import { runUpload } from './uploadFlow';

/** Desktop ticket detail: status/timeline, resume an interrupted upload (re-select the same file), abort, revoke, and saving approved
 *  office → jump files to disk. No approval. */
export default function DesktopTicketDetailPage() {
  const { id = '' } = useParams();
  const state = useAsync(() => transfersApi.get(id), [id], { pollMs: 10000 });
  return <div style={{ padding: 20, maxWidth: 1000, margin: '0 auto' }}><AsyncView state={state}>{(d) => <Detail d={d} reload={state.reload} />}</AsyncView></div>;
}

function Detail({ d, reload }: { d: TicketDetail; reload: () => void }) {
  const { me, can } = useAuth();
  const toast = useToast();
  const tk = d.ticket;
  const [busy, setBusy] = useState('');
  const [prog, setProg] = useState<UploadProgress | null>(null);
  const [resumeMsg, setResumeMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const isRequester = me?.user.id === tk.requesterId;
  const [savePct, setSavePct] = useState<number | null>(null);
  const approved = (tk.status === 'APPROVED' || tk.status === 'DOWNLOADED') && tk.downloadCount < tk.maxDownloads;
  // UI hint only (server decides): only office → jump files are downloaded here
  const downloadOk = can('transfer:download') && approved && tk.direction === 'OFFICE_TO_JUMP';

  const save = async () => {
    setBusy('save'); setSavePct(0);
    try {
      const name = await saveTicketToDisk(tk, (d, total) => setSavePct(total ? Math.round((d / total) * 100) : 100));
      if (name) toast.push(t('td.saved', { name }), 'success');
      reload();
    } catch (e) { if ((e as { code?: string }).code !== 'STEPUP_REQUIRED') toast.push(errorMessage(e), 'error'); }
    finally { setBusy(''); setSavePct(null); }
  };

  const abort = async () => {
    setBusy('abort');
    try { await uploadApi.abort(tk.id); toast.push(t('nt.abortedServer'), 'success'); reload(); }
    catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(''); }
  };

  const resume = async (f: File) => {
    setResumeMsg('');
    if (f.size !== tk.size) { setResumeMsg(t('td.resumeSizeMismatch')); return; }
    setBusy('resume');
    try {
      const sum = await sha256Source(f);
      if (sum !== tk.sha256) { setResumeMsg(t('td.resumeHashMismatch')); return; }
      await runUpload({
        file: f, purpose: tk.purpose, approverId: tk.approverId, onProgress: setProg,
        state: { sha256: tk.sha256, ticketId: tk.id, partBytes: Math.ceil(tk.size / Math.max(1, d.totalParts)), totalParts: d.totalParts },
      }, { upload: uploadApi, create: () => Promise.reject(new Error('unreachable')) });
      toast.push(t('nt.done'), 'success'); reload();
    } catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(''); }
  };

  return (
    <div className="ui-col" style={{ gap: 16 }}>
      <div><Link to="/transfers">← {t('td.back')}</Link></div>
      <TicketHeading tk={tk} />
      <TicketFields tk={tk} />
      <div className="ui-row" style={{ flexWrap: 'wrap' }}>
        {downloadOk && <Button variant="primary" loading={busy === 'save'} onClick={() => void save()}>{t('td.download')}</Button>}
        <RevokeControl tk={tk} onDone={reload} />
        {tk.status === 'UPLOADING' && isRequester && (
          <>
            <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void resume(f); e.target.value = ''; }} />
            <Button loading={busy === 'resume'} onClick={() => fileRef.current?.click()}>{t('td.resume', { n: d.receivedParts.length, total: d.totalParts })}</Button>
            <Button variant="danger" loading={busy === 'abort'} onClick={() => void abort()}>{t('nt.cancel')}</Button>
          </>
        )}
      </div>
      {approved && tk.direction === 'JUMP_TO_OFFICE' && <div className="ui-muted">{t('td.downloadElsewhere.JUMP_TO_OFFICE')}</div>}
      {savePct !== null && <progress value={savePct} max={100} style={{ width: '100%' }} aria-label={t('td.download')} />}
      {tk.status === 'UPLOADING' && <div className="ui-muted">{t('td.uploadingHint')}</div>}
      {prog && <progress value={prog.uploadedBytes} max={prog.totalBytes} style={{ width: '100%' }} aria-label={t('nt.phase.uploading')} />}
      {resumeMsg && <div className="ui-error-text" role="alert">{resumeMsg}</div>}
      <div className="ui-card">
        <h2 style={{ marginTop: 0 }}>{t('td.timeline')}</h2>
        <EventTimeline events={d.events} />
      </div>
    </div>
  );
}
