import { useMemo, useState } from 'react';
import { Button, Dialog, Input, Textarea } from '@vnpay/ui';
import { t } from '../../i18n';
import { uid } from '../../lib';
import { deleteSnippet, saveSnippet, snippetText, useSnippets, type Snippet } from './workspace';

/**
 * Saved SQL templates. `${name}` marks a field: in the editor, typing the snippet name offers it in the completion list
 * and Tab moves between the fields.
 */
export function SnippetsDialog({ initialSql, onClose, onInsert }: { initialSql?: string; onClose: () => void; onInsert: (sql: string) => void }) {
  const list = useSnippets();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Snippet | null>(initialSql ? { id: uid(), name: '', sql: initialSql } : null);
  const [sel, setSel] = useState<string | null>(null);
  const shown = useMemo(() => { const s = q.trim().toLowerCase(); return list.filter((x) => !s || x.name.toLowerCase().includes(s) || x.sql.toLowerCase().includes(s) || (x.description ?? '').toLowerCase().includes(s)); }, [list, q]);
  const pick = shown.find((x) => x.id === sel) ?? shown[0] ?? null;
  const nameTaken = !!editing && list.some((x) => x.id !== editing.id && x.name.toLowerCase() === editing.name.trim().toLowerCase());
  const valid = !!editing && /^[A-Za-z_][\w]{0,59}$/.test(editing.name.trim()) && !!editing.sql.trim() && !nameTaken;

  if (editing) {
    return (
      <Dialog open wide title={t('snippet.edit')} onClose={() => setEditing(null)}
        footer={<><Button onClick={() => (initialSql ? onClose() : setEditing(null))}>{t('common.cancel')}</Button><Button variant="primary" disabled={!valid} onClick={() => { saveSnippet(editing); setSel(editing.id); if (initialSql) onClose(); else setEditing(null); }}>{t('snippet.save')}</Button></>}>
        <div className="ui-col" style={{ gap: 8 }}>
          <Input label={t('snippet.name')} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} hint={t('snippet.nameHint')} error={nameTaken ? t('snippet.nameTaken') : undefined} autoFocus />
          <Input label={t('snippet.description')} value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          <Textarea label="SQL" className="ui-mono" rows={10} value={editing.sql} onChange={(e) => setEditing({ ...editing, sql: e.target.value })} hint={t('snippet.fieldsHint')} />
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open wide title={t('snippet.title')} onClose={onClose}
      footer={<>
        <Button onClick={() => setEditing({ id: uid(), name: '', sql: '' })}>{t('snippet.new')}</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>{t('common.close')}</Button>
        <Button variant="primary" disabled={!pick} onClick={() => { if (pick) { onInsert(snippetText(pick.sql)); onClose(); } }}>{t('history.insert')}</Button>
      </>}>
      <div className="ui-col" style={{ gap: 8 }}>
        <input className="ui-input" type="search" placeholder={t('snippet.search')} aria-label={t('snippet.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: 8, minHeight: 260 }}>
          <div role="listbox" aria-label={t('snippet.title')} style={{ overflow: 'auto', maxHeight: '50vh', border: '1px solid var(--ui-border)', borderRadius: 6 }}>
            {shown.length === 0 && <div className="ui-muted" style={{ padding: 8 }}>{t('snippet.empty')}</div>}
            {shown.map((s) => (
              <div key={s.id} role="option" aria-selected={pick?.id === s.id} tabIndex={0} className={`tb-list__item${pick?.id === s.id ? ' is-selected' : ''}`}
                onClick={() => setSel(s.id)} onDoubleClick={() => { onInsert(snippetText(s.sql)); onClose(); }}>
                <strong className="ui-mono">{s.name}</strong> <span className="ui-muted">{s.description ?? ''}</span>
              </div>
            ))}
          </div>
          <div className="ui-col" style={{ gap: 6, minWidth: 0 }}>
            <pre className="ui-mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, flex: 1, overflow: 'auto', background: 'var(--ui-surface-2)', padding: 8, borderRadius: 6 }}>{pick?.sql ?? ''}</pre>
            {pick && <div className="ui-row"><Button size="sm" onClick={() => setEditing(pick)}>{t('snippet.editBtn')}</Button><Button size="sm" variant="ghost" onClick={() => deleteSnippet(pick.id)}>{t('snippet.delete')}</Button></div>}
          </div>
        </div>
        <div className="ui-muted" style={{ fontSize: 12 }}>{t('snippet.usage')}</div>
      </div>
    </Dialog>
  );
}
