import { useState } from 'react';
import { Button, Checkbox } from '@vnpay/ui';
import { t } from '../../i18n';
import { Icon } from '../tabledb/icons';
import { CONTEXT_KINDS, MAX_CONTEXT_CHARS, contextFor, deleteContextNote, newContextId, saveContextNote, useContextNotes, type ContextKind } from '../tabledb/workspace';

/** Business context of one saved connection. Everything here is user-approved; enabled notes are sent with each Agent request for that profile. */
export function ContextNotes({ profileId, connName }: { profileId?: string; connName?: string }) {
  const all = useContextNotes();
  const notes = contextFor(profileId, all);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<ContextKind>('entity');
  const add = () => {
    const text = draft.trim();
    if (profileId && text && saveContextNote({ id: newContextId(), profileId, kind, text, at: Date.now(), enabled: true })) setDraft('');
  };
  return (
    <div style={{ padding: 8, borderBottom: '1px solid var(--ui-border)', maxHeight: '45%', overflow: 'auto' }}>
      <strong>{t('ctx.title')}{connName ? ` · ${connName}` : ''}</strong>
      <p className="ui-muted" style={{ margin: '4px 0 6px', fontSize: 'var(--ui-fs-sm)' }}>{profileId ? t('ctx.hint') : t('ctx.noProfile')}</p>
      {profileId && (
        <>
          <div className="ui-row" style={{ gap: 6 }}>
            <select className="ui-input" aria-label={t('ctx.title')} value={kind} onChange={(e) => setKind(e.target.value as ContextKind)}>
              {CONTEXT_KINDS.map((k) => <option key={k} value={k}>{t(`ctx.kind.${k}`)}</option>)}
            </select>
            <input className="ui-input" style={{ flex: 1 }} maxLength={MAX_CONTEXT_CHARS} placeholder={t('ctx.placeholder')} aria-label={t('ctx.add')} value={draft}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
            <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={add}>{t('ctx.add')}</Button>
          </div>
          {notes.length === 0 && <p className="ui-muted" style={{ fontSize: 'var(--ui-fs-sm)' }}>{t('ctx.empty')}</p>}
          {notes.map((n) => (
            <div key={n.id} className="ui-row" style={{ gap: 6, padding: '4px 0', borderBottom: '1px solid var(--ui-border)' }}>
              <Checkbox label="" aria-label={t('ctx.enabled')} checked={n.enabled} onChange={(e) => saveContextNote({ ...n, enabled: e.target.checked })} />
              <span style={{ flex: 1, wordBreak: 'break-word', opacity: n.enabled ? 1 : 0.5 }}><em>{t(`ctx.kind.${n.kind}`)}</em> · {n.text}</span>
              <Button size="sm" variant="ghost" aria-label={t('ctx.delete')} title={t('ctx.delete')} onClick={() => deleteContextNote(n.id)}><Icon name="trash" /></Button>
            </div>
          ))}
          <div className="ui-muted" style={{ fontSize: 'var(--ui-fs-sm)', marginTop: 4 }}>{t('ctx.sent', { n: notes.filter((n) => n.enabled).length })}</div>
        </>
      )}
    </div>
  );
}
