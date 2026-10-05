import { useEffect, useRef, useState } from 'react';
import { Button, Table } from '@vnpay/ui';
import { errorMessage, t } from '../../i18n';
import { fmtBytes, fmtDate } from '../../lib';
import { transfersApi } from '../../api/services';
import type { ManifestView, TextInfo } from '../../api/types';

const PAGE = 100;

/** Control characters are stripped server-side, but we still render only as text and never trust length. */
const show = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);

function Warn({ children }: { children: React.ReactNode }) {
  return <div role="alert" className="fc-warn" style={{ border: '1px solid var(--ui-danger, #c00)', borderRadius: 6, padding: '6px 10px', margin: '6px 0' }}>{children}</div>;
}

function TextSection({ text }: { text: TextInfo }) {
  return (
    <dl className="nt-summary" aria-label={t('fc.title')}>
      <dt>{t('fc.encoding')}</dt><dd>{text.encoding}</dd>
      <dt>{t('fc.lines')}</dt><dd>{text.lines.toLocaleString()}</dd>
      <dt>{t('fc.emptyLines')}</dt><dd>{text.emptyLines.toLocaleString()}</dd>
      <dt>{t('fc.maxLine')}</dt><dd>{text.maxLineBytes.toLocaleString()}</dd>
      <dt>{t('fc.bytes')}</dt><dd>{fmtBytes(text.bytes)}</dd>
      {text.csv && <>
        <dt>{t('fc.csvDelimiter')}</dt><dd className="ui-mono">{text.csv.delimiter === '\t' ? 'TAB' : text.csv.delimiter}</dd>
        <dt>{t('fc.csvColumns')}</dt><dd>{text.csv.columns}</dd>
        <dt>{t('fc.csvRows')}</dt><dd>{text.csv.dataRows.toLocaleString()}</dd>
        <dt>{t('fc.csvRagged')}</dt><dd>{text.csv.raggedRows.toLocaleString()}</dd>
        <dt>{t('fc.csvHeader')}</dt>
        <dd>
          <ul aria-label={t('fc.csvHeader')} style={{ margin: 0, paddingLeft: 18 }}>{text.csv.headerNames.map((n, i) => <li key={i} className="ui-mono">{show(n)}</li>)}</ul>
          {text.csv.headerTruncated && <span className="ui-muted">{t('fc.csvHeaderTruncated')}</span>}
        </dd>
      </>}
      {text.json && <>
        <dt>{t('fc.jsonShape')}</dt>
        <dd>{text.json.valid
          ? <>{t('fc.jsonValid')} — {t('fc.jsonTop', { type: text.json.topLevel, n: text.json.length, depth: text.json.maxDepth })}</>
          : t('fc.jsonInvalid', { err: text.json.error ?? '?' })}</dd>
      </>}
      {text.jsonl && <><dt>{t('fc.jsonl')}</dt><dd>{t('fc.jsonlSummary', { ok: text.jsonl.validLines, bad: text.jsonl.invalidLines })}</dd></>}
    </dl>
  );
}

function EntriesTable({ ticketId, first }: { ticketId: string; first: ManifestView }) {
  const [view, setView] = useState(first);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  useEffect(() => { setView(first); }, [first]);
  const { offset, total, items } = view.entries;
  const go = async (to: number) => {
    const my = ++seq.current;
    setLoading(true); setErr('');
    try {
      const v = await transfersApi.manifest(ticketId, Math.max(0, to), PAGE);
      if (my === seq.current) setView(v);
    } catch (e) { if (my === seq.current) setErr(errorMessage(e)); }
    finally { if (my === seq.current) setLoading(false); }
  };
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + items.length;
  return (
    <div>
      <h3>{t('fc.entries')}</h3>
      <div role="status" aria-live="polite" className="ui-muted">{loading ? t('fc.loading') : t('fc.page', { from, to, total })}</div>
      {err && <div role="alert">{err}</div>}
      <Table caption={t('fc.entries')}>
        <thead><tr>
          <th scope="col">{t('fc.col.name')}</th><th scope="col">{t('fc.col.size')}</th><th scope="col">{t('fc.col.csize')}</th>
          <th scope="col">{t('fc.col.modified')}</th><th scope="col">{t('fc.col.lines')}</th><th scope="col">{t('fc.col.flags')}</th>
        </tr></thead>
        <tbody>{items.map((e) => (
          <tr key={e.idx}>
            <td className="ui-mono" style={{ wordBreak: 'break-all', paddingLeft: e.depth ? 8 + e.depth * 12 : undefined }}>{show(e.path)}{e.isDir ? ` ${t('fc.folder')}` : ''}</td>
            <td>{e.isDir ? '' : fmtBytes(e.size)}</td>
            <td>{e.isDir ? '' : fmtBytes(e.compressedSize)}</td>
            <td>{e.modified ? fmtDate(e.modified) : '—'}</td>
            <td>{e.lines ?? ''}</td>
            <td>{e.flags.map((f) => <span key={f} className="ui-badge" style={{ marginRight: 4, color: ['zip-slip', 'executable', 'bomb-ratio', 'mismatch'].includes(f) ? 'var(--ui-danger, #c00)' : undefined }}>{t(`fc.flag.${f}`) === `fc.flag.${f}` ? f : t(`fc.flag.${f}`)}</span>)}</td>
          </tr>))}
        </tbody>
      </Table>
      <div className="ui-row">
        <Button onClick={() => void go(offset - PAGE)} disabled={loading || offset <= 0}>{t('fc.prev')}</Button>
        <Button onClick={() => void go(offset + PAGE)} disabled={loading || offset + items.length >= total}>{t('fc.next')}</Button>
      </div>
    </div>
  );
}

/** "Nội dung file": metadata-only manifest (counts, shapes, archive listing). The approver reads this before deciding. */
export function FileContentPanel({ ticketId, manifest }: { ticketId: string; manifest?: ManifestView | null }) {
  return (
    <section className="ui-card" aria-labelledby="fc-title">
      <h2 id="fc-title" style={{ marginTop: 0 }}>{t('fc.title')}</h2>
      {!manifest ? <div className="ui-muted">{t('fc.pending')}</div> : <Body ticketId={ticketId} m={manifest} />}
    </section>
  );
}

function Body({ ticketId, m }: { ticketId: string; m: ManifestView }) {
  const s = m.summary;
  return (
    <>
      {m.status === 'error' && <Warn>{t('fc.inspectError', { err: m.inspectError ?? '?' })}</Warn>}
      {s.truncated && <Warn>{t('fc.truncated', { reason: s.truncatedReason ?? '?' })}</Warn>}
      {s.containsSensitivePatterns && <Warn>{t('fc.sensitive', { phone: s.sensitive?.phone ?? 0, email: s.sensitive?.email ?? 0, id: s.sensitive?.idNumber ?? 0, card: s.sensitive?.card ?? 0 })}</Warn>}
      {s.zip && s.zip.encryptedCount > 0 && <Warn>{t('fc.zipEncrypted', { n: s.zip.encryptedCount })}</Warn>}
      {s.zip && s.zip.zipSlipCount > 0 && <Warn>{t('fc.zipSlip', { n: s.zip.zipSlipCount })}</Warn>}
      {s.zip && s.zip.nestedArchiveCount > 0 && <div className="ui-muted">{t('fc.zipNested', { n: s.zip.nestedArchiveCount })}</div>}
      {s.text && <TextSection text={s.text} />}
      {s.zip && <>
        <p>{t('fc.zipSummary', { files: s.zip.fileCount, dirs: s.zip.dirCount, size: fmtBytes(s.zip.totalUncompressed), csize: fmtBytes(s.zip.totalCompressed), ratio: s.zip.maxRatio.toFixed(1) })}</p>
        <EntriesTable ticketId={ticketId} first={m} />
      </>}
      <div className="ui-muted ui-mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{t('fc.hash')}: {m.manifestHash}</div>
    </>
  );
}
