import { useState } from 'react';
import { Button, Checkbox, EmptyState } from '@vnpay/ui';
import { t } from '../../i18n';
import { Icon } from '../tabledb/icons';
import { MAX_MEMORY_CHARS, deleteMemory, newMemoryId, saveMemory, useMemories } from '../tabledb/workspace';

/** Long-term memory: short notes the user wants in every conversation. They are sent to the LLM, so each one can be switched off. */
export function MemoryManager() {
  const notes = useMemories();
  const [draft, setDraft] = useState('');
  const add = () => { const text = draft.trim(); if (text && saveMemory({ id: newMemoryId(), text, at: Date.now(), enabled: true })) setDraft(''); };
  const enabled = notes.filter((n) => n.enabled).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: 8 }}>
        <p className="ui-muted" style={{ margin: '0 0 6px', fontSize: 'var(--ui-fs-sm)' }}>{t('memory.hint')}</p>
        <div className="ui-row" style={{ gap: 6 }}>
          <input className="ui-input" style={{ flex: 1 }} maxLength={MAX_MEMORY_CHARS} placeholder={t('memory.placeholder')} aria-label={t('memory.add')} value={draft}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={add}>{t('memory.add')}</Button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 8px' }}>
        {notes.length === 0 && <EmptyState title={t('memory.empty')} />}
        {notes.map((n) => (
          <div key={n.id} className="ui-row" style={{ gap: 6, padding: '4px 0', borderBottom: '1px solid var(--ui-border)' }}>
            <Checkbox label="" aria-label={t('memory.enabled')} checked={n.enabled} onChange={(e) => saveMemory({ ...n, enabled: e.target.checked })} />
            <span style={{ flex: 1, wordBreak: 'break-word', opacity: n.enabled ? 1 : 0.5 }}>{n.text}</span>
            <Button size="sm" variant="ghost" aria-label={t('memory.delete')} title={t('memory.delete')} onClick={() => deleteMemory(n.id)}><Icon name="trash" /></Button>
          </div>
        ))}
      </div>
      <div className="ui-muted" style={{ padding: 8, fontSize: 'var(--ui-fs-sm)', borderTop: '1px solid var(--ui-border)' }}>{t('memory.sent', { n: enabled })}</div>
    </div>
  );
}
