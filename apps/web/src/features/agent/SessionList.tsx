import { useMemo, useState } from 'react';
import { Button, EmptyState } from '@vnpay/ui';
import { t } from '../../i18n';
import { Icon } from '../tabledb/icons';
import { downloadTextFile } from '../tabledb/profiles';
import { deleteChat, saveChat, useChats, type ChatSession } from '../tabledb/workspace';
import { toMarkdown } from './memory';

const dayLabel = (ts: number) => {
  const d = new Date(ts); const now = new Date();
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  return days <= 0 ? t('chats.today') : days === 1 ? t('chats.yesterday') : days < 8 ? t('chats.week') : t('chats.older');
};

/** Conversation list (pinned first, then grouped by recency) with search, rename, pin, export and delete. */
export function SessionList({ activeId, onOpen, onNew }: { activeId: string | null; onOpen: (s: ChatSession) => void; onNew: () => void }) {
  const chats = useChats();
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? chats.filter((c) => c.title.toLowerCase().includes(k) || c.messages.some((m) => m.content.toLowerCase().includes(k))) : chats;
  }, [chats, q]);
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: ChatSession[] }> = [];
    for (const c of shown) {
      const label = c.pinned ? t('chats.pinned') : dayLabel(c.updatedAt);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(c); else out.push({ label, items: [c] });
    }
    return out;
  }, [shown]);
  const commitRename = () => {
    const c = renaming && chats.find((x) => x.id === renaming.id);
    if (c && renaming!.title.trim()) saveChat({ ...c, title: renaming!.title.trim().slice(0, 120) });
    setRenaming(null);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="ui-row" style={{ padding: 8, gap: 6 }}>
        <input className="ui-input" style={{ flex: 1 }} type="search" placeholder={t('chats.search')} aria-label={t('chats.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" variant="primary" onClick={onNew}>{t('chats.new')}</Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 8px' }} role="list" aria-label={t('chats.title')}>
        {shown.length === 0 && <EmptyState title={t(q ? 'chats.noMatch' : 'chats.empty')} />}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="ui-label" style={{ margin: '8px 0 4px' }}>{g.label}</div>
            {g.items.map((c) => (
              <div key={c.id} role="listitem" className="ui-row" style={{ gap: 2, padding: '2px 4px', borderRadius: 'var(--ui-radius)', background: c.id === activeId ? 'var(--ui-sel-bg)' : undefined }}>
                {renaming?.id === c.id
                  ? <input className="ui-input" style={{ flex: 1 }} autoFocus aria-label={t('chats.rename')} value={renaming.title} onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
                      onBlur={commitRename} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }} />
                  : <button type="button" className="ui-btn ui-btn--ghost" style={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => onOpen(c)} title={c.title}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                      {c.connName && <span className="ui-muted" style={{ marginLeft: 6, fontSize: 'var(--ui-fs-sm)' }}>· {c.connName}</span>}
                    </button>}
                <Button size="sm" variant="ghost" aria-label={c.pinned ? t('chats.unpin') : t('chats.pin')} title={c.pinned ? t('chats.unpin') : t('chats.pin')} aria-pressed={!!c.pinned}
                  onClick={() => { const { pinned: _p, ...rest } = c; saveChat(c.pinned ? { ...rest, updatedAt: c.updatedAt } : { ...c, pinned: true }); }}><Icon name="pin" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('chats.rename')} title={t('chats.rename')} onClick={() => setRenaming({ id: c.id, title: c.title })}><Icon name="edit" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('chats.export')} title={t('chats.export')} onClick={() => downloadTextFile(`${c.title.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'chat'}.md`, toMarkdown(c), 'text/markdown;charset=utf-8')}><Icon name="export" /></Button>
                <Button size="sm" variant="ghost" aria-label={t('chats.delete')} title={t('chats.delete')} onClick={() => { if (window.confirm(t('chats.deleteConfirm', { title: c.title }))) { deleteChat(c.id); if (c.id === activeId) onNew(); } }}><Icon name="trash" /></Button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
