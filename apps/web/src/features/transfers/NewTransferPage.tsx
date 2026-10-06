import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Select, Textarea, useToast } from '@vnpay/ui';
import { UploadInit, directionForUploader } from '@vnpay/shared';
import { AsyncView } from '../../components/AsyncView';
import { useAsync } from '../../hooks';
import { errorMessage, t } from '../../i18n';
import { fmtBytes } from '../../lib';
import { transfersApi } from '../../api/services';
import { uploadApi, uploadsApi } from '../../api/services.upload';
import { runUpload, type UploadPhase } from './uploadFlow';
import type { UploadProgress } from './uploader';
import type { TransferOptions } from '../../api/types';
import { IS_DESKTOP_BUILD } from '../../target';

type Step = 1 | 2 | 3;

export function validateFile(f: File, limits: TransferOptions['limits']): string | null {
  if (f.size <= 0) return t('nt.errEmpty');
  if (f.size > limits.maxBytes) return t('nt.errTooBig', { max: fmtBytes(limits.maxBytes) });
  const ext = f.name.includes('.') ? f.name.split('.').pop()!.toLowerCase() : '';
  if (limits.allowedExtensions.length > 0 && !limits.allowedExtensions.map((e) => e.replace(/^\./, '').toLowerCase()).includes(ext)) return t('nt.errExt', { list: limits.allowedExtensions.join(', ') });
  return null;
}

export default function NewTransferPage() {
  const opts = useAsync(() => transfersApi.options(), []);
  return <div className="nt-page"><h1>{t('nt.title')}</h1><DirectionHint /><AsyncView state={opts}>{(o) => <Wizard options={o} />}</AsyncView></div>;
}

/** The server sets the direction from the session kind; this only tells the user where the file will be downloaded. */
function DirectionHint() {
  const dir = directionForUploader(IS_DESKTOP_BUILD ? 'desktop' : 'web');
  return <p className="nt-direction" data-testid="nt-direction"><strong>{t(`dir.${dir}`)}</strong> — {t(`nt.dirHint.${dir}`)}</p>;
}

function Wizard({ options }: { options: TransferOptions }) {
  const nav = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState('');
  const [dragging, setDragging] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [approverId, setApproverId] = useState('');
  const [phase, setPhase] = useState<UploadPhase | null>(null);
  const [hashPct, setHashPct] = useState(0);
  const [prog, setProg] = useState<UploadProgress | null>(null);
  const [err, setErr] = useState('');
  const [running, setRunning] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const state = useRef<NonNullable<Parameters<typeof runUpload>[0]['state']>>({});

  const detailsError = useMemo(() => {
    const r = UploadInit.safeParse({ fileName: file?.name ?? 'x', size: file?.size || 1, sha256: '0'.repeat(64), purpose, approverId, recipientIds: [] });
    if (r.success) return '';
    const p = r.error.issues[0]?.path[0];
    return p === 'purpose' ? t('nt.errPurpose') : p === 'approverId' ? t('nt.errApprover') : t('nt.errInvalid');
  }, [file, purpose, approverId]);

  const pickFile = (f: File | null) => {
    state.current = {};
    setFile(f); setFileErr(f ? validateFile(f, options.limits) ?? '' : '');
  };

  const start = async () => {
    if (!file) return;
    setErr(''); setRunning(true);
    ctrl.current = new AbortController();
    try {
      const id = await runUpload({
        ...options.upload,
        file, purpose: purpose.trim(), approverId, state: state.current, signal: ctrl.current.signal,
        onPhase: setPhase, onProgress: setProg, onHashProgress: (d, tot) => setHashPct(tot ? Math.round((d / tot) * 100) : 100),
      }, { upload: uploadApi, create: (b) => uploadsApi.create(b) });
      toast.push(t('nt.done'), 'success');
      nav(`/transfers/${id}`);
    } catch (e) {
      const aborted = (e as { code?: string }).code === 'ABORTED' || (e as { name?: string }).name === 'AbortError';
      setErr(aborted ? t('nt.aborted') : errorMessage(e));
    } finally { setRunning(false); }
  };

  const cancel = async () => {
    ctrl.current?.abort();
    const id = state.current.ticketId;
    if (id) {
      try { await uploadApi.abort(id); toast.push(t('nt.abortedServer'), 'info'); state.current = {}; setPhase(null); setProg(null); }
      catch (e) { toast.push(errorMessage(e), 'error'); }
    }
  };

  const pct = prog && prog.totalBytes ? Math.round((prog.uploadedBytes / prog.totalBytes) * 100) : 0;

  return (
    <div className="ui-card nt-card">
      <ol aria-label={t('nt.steps')} className="nt-steps">
        {[t('nt.step1'), t('nt.step2'), t('nt.step3')].map((s, i) => <li key={s} aria-current={step === i + 1 ? 'step' : undefined} className={step === i + 1 ? 'is-active' : undefined}><span className="nt-steps__n">{i + 1}.</span> {s}</li>)}
      </ol>

      {step === 1 && (
        <div className="ui-col nt-col">
          <div className="ui-field">
            <label className="ui-label" htmlFor="nt-file">{t('nt.file')}</label>
            <div
              data-testid="nt-dropzone"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length > 1) { setFile(null); setFileErr(t('nt.errMulti')); return; } pickFile(e.dataTransfer.files[0] ?? null); }}
              className={`nt-drop${dragging ? ' is-dragging' : ''}`}
            >
              <div className="nt-drop__hint">{t('nt.dropHint')}</div>
              <input id="nt-file" className="ui-input nt-drop__input" type="file" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            </div>
            <span className="ui-hint">{t('nt.limits', { max: fmtBytes(options.limits.maxBytes), ext: options.limits.allowedExtensions.join(', ') || '*' })}</span>
            {fileErr && <span className="ui-error-text" role="alert">{fileErr}</span>}
          </div>
          {file && !fileErr && <div className="nt-picked">{file.name} — {fmtBytes(file.size)}</div>}
          <div className="nt-actions"><Button variant="primary" disabled={!file || !!fileErr} onClick={() => setStep(2)}>{t('common.next')}</Button></div>
        </div>
      )}

      {step === 2 && (
        <form className="ui-col" onSubmit={(e) => { e.preventDefault(); if (!detailsError) setStep(3); }}>
          <Textarea label={t('nt.purpose')} rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} hint={t('nt.purposeHint')} />
          <Select label={t('nt.leader')} value={approverId} onChange={(e) => setApproverId(e.target.value)} placeholder={t('common.choose')}
            options={options.leaders.map((x) => ({ value: x.id, label: `${x.name} (${x.email})` }))} />
          {detailsError && purpose.length > 0 && <span className="ui-error-text" role="alert">{detailsError}</span>}
          <div className="ui-row nt-actions"><Button onClick={() => setStep(1)}>{t('common.back')}</Button><Button type="submit" variant="primary" disabled={!!detailsError}>{t('common.next')}</Button></div>
        </form>
      )}

      {step === 3 && file && (
        <div className="ui-col nt-col">
          <dl className="nt-summary">
            <dt>{t('nt.file')}</dt><dd>{file.name} ({fmtBytes(file.size)})</dd>
            <dt>{t('dir.label')}</dt><dd>{t(`dir.${directionForUploader(IS_DESKTOP_BUILD ? 'desktop' : 'web')}`)}</dd>
            <dt>{t('nt.purpose')}</dt><dd>{purpose}</dd>
            <dt>{t('nt.leader')}</dt><dd>{options.leaders.find((x) => x.id === approverId)?.name}</dd>
          </dl>
          {phase && (
            <div role="status" aria-live="polite" className="ui-col">
              <div>{t(`nt.phase.${phase}`)}</div>
              {phase === 'hashing' && <progress value={hashPct} max={100} aria-label={t('nt.phase.hashing')} className="nt-progress" />}
              {(phase === 'uploading' || phase === 'completing' || phase === 'done') && prog && (
                <>
                  <progress value={pct} max={100} aria-label={t('nt.phase.uploading')} className="nt-progress" />
                  <span className="nt-progress__text">{t('nt.progress', { pct, done: prog.donePartCount, total: prog.totalParts, bytes: fmtBytes(prog.uploadedBytes) })}</span>
                </>
              )}
            </div>
          )}
          {err && <div className="ui-error-text" role="alert">{err}</div>}
          <div className="ui-row nt-actions">
            {!running && !phase && <Button onClick={() => setStep(2)}>{t('common.back')}</Button>}
            <Button variant="primary" loading={running} onClick={() => void start()}>{state.current.ticketId ? t('nt.resume') : t('nt.start')}</Button>
            {(running || state.current.ticketId) && <Button variant="danger" onClick={() => void cancel()}>{t('nt.cancel')}</Button>}
          </div>
        </div>
      )}
    </div>
  );
}
