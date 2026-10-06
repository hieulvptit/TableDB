import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, useToast } from '@vnpay/ui';
import { useAuth } from '../../auth/AuthContext';
import { createGateway } from '../../gateway';
import { errorMessage, t } from '../../i18n';
import { uid } from '../../lib';
import { ContextMenu, runShortcut, type MenuItem } from './ContextMenu';
import { openConnection } from './connect';
import { usesSso, validateCustomForm } from './custom';
import { friendlyDbError } from './dbErrors';
import {
  customProfiles, deleteLocalProfile, downloadTextFile, duplicateLocalProfile, exportProfilesJson, formFromProfile, importLocalProfiles, parseProfilesJson, renameLocalProfile,
  useLocalProfiles, type LocalProfile,
} from './profiles';
import { Icon } from './icons';
import { MonitorDialog, SchemaCompareDialog, SearchDialog } from './DbTools';
import { SchemaTree, storeHasMatch } from './SchemaTree';
import { useTableDbSelector, type TableDbApi } from './store';
import type { Connection } from './types';

/** one tree root: a saved connection (open or not) or an open session that has no saved profile */
interface Entry { key: string; name: string; driver: string; profile?: LocalProfile; conn?: Connection }

const driverOf = (p: LocalProfile) => (p.custom!.driver === 'custom' ? p.custom!.driverName ?? 'custom' : p.custom!.driver);
const DRIVER_MARK: Record<string, string> = { oracle: 'O', postgresql: 'P', trino: 'T' };

/** DBeaver-style "Database Navigator": toolbar + one tree root per saved connection; connecting expands it into catalogs/schemas/tables. */
const navigatorState = (db: TableDbApi) => ({ connections: db.connections, activeConn: db.activeConn, setActiveConn: db.setActiveConn, addConnection: db.addConnection, reconnectConnection: db.reconnectConnection, removeConnection: db.removeConnection, newTab: db.newTab });
export const Navigator = memo(function Navigator({ onNewConnection, onEditConnection }: { onNewConnection: () => void; onEditConnection: (profileId: string, connect?: boolean) => void }) {
  const db = useTableDbSelector(navigatorState);
  const toast = useToast();
  const { can } = useAuth();
  const conn = db.activeConn;
  const saved = customProfiles(useLocalProfiles());
  const gateway = useMemo(() => createGateway(), []);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [refreshKey, setRefreshKey] = useState<Record<string, number>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<LocalProfile | null>(null);
  const [tool, setTool] = useState<null | { kind: 'search' | 'monitor'; conn: Connection } | { kind: 'compare' }>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const q = filter.trim().toLowerCase();

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const p of saved) {
      const open = db.connections.filter((c) => c.profileId === p.id);
      if (open.length === 0) out.push({ key: `p:${p.id}`, name: p.name, driver: driverOf(p), profile: p });
      open.forEach((c, i) => out.push({ key: i === 0 ? `p:${p.id}` : `c:${c.id}`, name: p.name, driver: driverOf(p), profile: p, conn: c }));
    }
    const known = new Set(saved.map((p) => p.id));
    for (const c of db.connections) if (!c.profileId || !known.has(c.profileId)) out.push({ key: `c:${c.id}`, name: c.name, driver: c.driverName ?? c.driver, conn: c });
    return out;
  }, [saved, db.connections]);
  const nameMatch = (e: Entry) => e.name.toLowerCase().includes(q);
  // a connection stays visible when its name matches, or (once connected) one of its loaded schemas/tables does
  const shown = useMemo(() => entries.filter((e) => !q || nameMatch(e) || (!!e.conn && storeHasMatch(e.conn.store, q))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, q, db.connections.map((c) => c.store.getVersion()).join(',')]);
  const openSearch = () => { setSearching(true); setTimeout(() => searchRef.current?.focus(), 0); };
  const closeSearch = () => { setSearching(false); setFilter(''); };
  useEffect(() => { if (searching) searchRef.current?.select(); }, [searching]);

  const toggle = (key: string) => setCollapsed((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const refresh = () => { if (!conn) return; conn.store.clear(); setRefreshKey((k) => ({ ...k, [conn.id]: (k[conn.id] ?? 0) + 1 })); };
  const setBusy = (id: string, on: boolean) => setConnecting((cur) => { const n = new Set(cur); if (on) n.add(id); else n.delete(id); return n; });

  /** Connect a saved profile with what is stored; anything that needs the user (password, SSH host key, bad fields) opens the dialog instead. */
  const connect = async (p: LocalProfile) => {
    if (connecting.has(p.id)) return;
    // already open: focus it instead of opening a second sidecar session
    const open = db.connections.find((c) => c.profileId === p.id);
    if (open) { db.setActiveConn(open.id); return; }
    setBusy(p.id, true);
    try {
      const form = await formFromProfile(p);
      if ((!usesSso(form) && !form.password) || validateCustomForm(form).length > 0) { onEditConnection(p.id, true); return; }
      const c = await openConnection({ custom: form, canWrite: can('db:write') }, undefined, gateway);
      c.profileId = p.id;
      db.addConnection(c);
      toast.push(t('connect.connected', { name: c.name }), 'success');
    } catch (e) {
      const fe = friendlyDbError(e);
      toast.push(`${fe.title}${fe.detail ? ` — ${fe.detail.split('\n')[0]}` : ''}`, 'error');
    } finally { setBusy(p.id, false); }
  };
  /** reopen the live session (same host, credentials, SSH/proxy route) without any dialog; the tree reloads on success */
  const reconnect = async (c: Connection) => {
    if (connecting.has(c.id)) return;
    setBusy(c.id, true);
    try {
      await db.reconnectConnection(c.id);
      setRefreshKey((k) => ({ ...k, [c.id]: (k[c.id] ?? 0) + 1 }));
      toast.push(t('connect.connected', { name: c.name }), 'success');
    } catch (e) {
      const fe = friendlyDbError(e);
      toast.push(`${fe.title}${fe.detail ? ` — ${fe.detail.split('\n')[0]}` : ''}`, 'error');
    } finally { setBusy(c.id, false); }
  };
  const disconnect = async (p: LocalProfile) => { for (const c of db.connections.filter((x) => x.profileId === p.id)) await db.removeConnection(c.id); };
  const commitRename = async () => {
    const r = renaming; setRenaming(null);
    if (r && r.name.trim()) await renameLocalProfile(r.id, r.name.trim().slice(0, 120));
  };
  const exportProfiles = (list: LocalProfile[]) => { downloadTextFile('tabledb-connections.json', exportProfilesJson(list)); toast.push(t('saved.exported', { n: list.length }), 'success'); };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const imported = parseProfilesJson(await file.text(), uid);
    if (!imported || imported.length === 0) { toast.push(t('saved.importInvalid'), 'error'); return; }
    const r = await importLocalProfiles(imported);
    toast.push(r.skipped ? t('saved.importedSkipped', { n: r.added, skipped: r.skipped }) : t('saved.imported', { n: r.added }), 'success');
  };

  const entryItems = (e: Entry | null): MenuItem[] => {
    const p = e?.profile;
    const open = !!e?.conn;
    const items: MenuItem[] = e ? [
      ...(open
        ? [
          { key: 'sql', label: t('tabledb.newTab'), shortcut: 'Alt+N', onSelect: () => { db.setActiveConn(e.conn!.id); db.newTab(); } },
          { key: 'refresh', label: t('tree.refresh'), shortcut: 'F5', onSelect: () => { db.setActiveConn(e.conn!.id); e.conn!.store.clear(); setRefreshKey((k) => ({ ...k, [e.conn!.id]: (k[e.conn!.id] ?? 0) + 1 })); } },
          { key: 'search', label: t('search.title'), shortcut: 'Alt+F', onSelect: () => setTool({ kind: 'search', conn: e.conn! }) },
          { key: 'monitor', label: t('monitor.title'), shortcut: 'Alt+M', onSelect: () => setTool({ kind: 'monitor', conn: e.conn! }) },
          { key: 'compare', label: t('sc.title'), shortcut: 'Alt+K', onSelect: () => setTool({ kind: 'compare' }) },
          { key: 'reconnect', label: t('saved.reconnect'), shortcut: 'Alt+R', onSelect: () => void reconnect(e.conn!) },
          { key: 'disconnect', label: t('saved.disconnect'), shortcut: 'Alt+X', onSelect: () => void (p ? disconnect(p) : db.removeConnection(e.conn!.id)) },
        ]
        : p ? [{ key: 'connect', label: t('saved.connect'), shortcut: 'Enter', onSelect: () => void connect(p) }] : []),
      ...(p ? [
        { key: 's1', label: '', separator: true },
        { key: 'edit', label: t('saved.edit'), shortcut: 'F4', onSelect: () => onEditConnection(p.id) },
        { key: 'rename', label: t('saved.rename'), shortcut: 'F2', onSelect: () => setRenaming({ id: p.id, name: p.name }) },
        { key: 'duplicate', label: t('saved.duplicate'), shortcut: 'Mod+D', onSelect: async () => { try { await duplicateLocalProfile(p.id, uid(), t('saved.copyName', { name: p.name })); } catch (er) { toast.push(errorMessage(er), 'error'); } } },
        { key: 'export', label: t('saved.export'), shortcut: 'Mod+E', onSelect: () => exportProfiles([p]) },
      ] : []),
      ...(p ? [{ key: 's3', label: '', separator: true }, { key: 'delete', label: t('saved.delete'), shortcut: 'Delete', danger: true, onSelect: () => setDeleting(p) }] : []),
    ] : [];
    return items;
  };
  const openMenu = (x: number, y: number, e: Entry | null) => {
    const items = entryItems(e);
    if (items.length) setMenu({ x, y, items });
  };

  const activate = (e: Entry) => {
    setSelectedKey(e.key);
    if (e.conn) { db.setActiveConn(e.conn.id); toggle(e.key); } else if (e.profile) void connect(e.profile);
  };
  const onRowKey = (ev: React.KeyboardEvent, e: Entry) => {
    if (ev.target !== ev.currentTarget) return;
    const p = e.profile;
    if (ev.key === 'Enter') { ev.preventDefault(); activate(e); }
    else if (ev.key === 'ArrowRight' && e.conn && collapsed.has(e.key)) { ev.preventDefault(); toggle(e.key); }
    else if (ev.key === 'ArrowLeft' && e.conn && !collapsed.has(e.key)) { ev.preventDefault(); toggle(e.key); }
    else if (ev.key === 'F2' && p) { ev.preventDefault(); setRenaming({ id: p.id, name: p.name }); }
    else if (ev.key === 'F4' && p) { ev.preventDefault(); onEditConnection(p.id); }
    else if (ev.key === 'Delete' && p) { ev.preventDefault(); setDeleting(p); }
    else if (runShortcut(entryItems(e), ev)) { /* handled */ }
    else if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault();
      const r = ev.currentTarget.getBoundingClientRect();
      openMenu(r.left + 24, r.bottom, e);
    }
  };

  return (
    <div className="nav" tabIndex={-1} onKeyDown={(ev) => { if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'f') { ev.preventDefault(); openSearch(); } }}>
      <div className="nav__bar" role="toolbar" aria-label={t('nav.title')}>
        <button type="button" className="nav__btn" onClick={onNewConnection} title={t('nav.newConnection')} aria-label={t('nav.newConnection')}><Icon name="dbAdd" /></button>
        <button type="button" className="nav__btn nav__btn--text" onClick={() => db.newTab()} disabled={!conn} title={t('tabledb.newTab')} aria-label={t('tabledb.newTab')}><Icon name="plus" />SQL</button>
        <span className="nav__sep" />
        <button type="button" className="nav__btn" onClick={refresh} disabled={!conn} title={t('tree.refresh')} aria-label={t('tree.refresh')}><Icon name="refresh" /></button>
        <button type="button" className="nav__btn" onClick={() => conn && void db.removeConnection(conn.id)} disabled={!conn} title={t('tabledb.disconnect')} aria-label={t('tabledb.disconnect')}><Icon name="eject" /></button>
        <span className="nav__sep" />
        <button type="button" className="nav__btn" onClick={() => conn && setTool({ kind: 'search', conn })} disabled={!conn} title={t('search.title')} aria-label={t('search.title')}><Icon name="database" /></button>
        <button type="button" className="nav__btn" onClick={() => conn && setTool({ kind: 'monitor', conn })} disabled={!conn} title={t('monitor.title')} aria-label={t('monitor.title')}><Icon name="activity" /></button>
        <button type="button" className="nav__btn" onClick={() => setTool({ kind: 'compare' })} disabled={!conn} title={t('sc.title')} aria-label={t('sc.title')}><Icon name="schemaDiff" /></button>
        <span className="nav__sep" />
        <button type="button" className={`nav__btn${searching ? ' is-active' : ''}`} onClick={() => (searching ? closeSearch() : openSearch())} aria-pressed={searching} title={`${t('nav.filter')} (Ctrl+F)`} aria-label={t('nav.filter')}><Icon name="search" /></button>
      </div>
      {searching && <input ref={searchRef} className="nav__filter ui-input" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('nav.filter')} aria-label={t('nav.filter')}
        onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeSearch(); } }} />}
      <div className="nav__list"  onContextMenu={(ev) => ev.preventDefault()}>
        {shown.length === 0 && <div className="ui-muted" style={{ padding: 8 }}>{entries.length === 0 ? t('nav.empty') : t('nav.noMatch')}</div>}
        {shown.map((e) => {
          const p = e.profile;
          const c = e.conn;
          const open = !!c && !collapsed.has(e.key);
          const busy = (!!p && connecting.has(p.id)) || (!!c && connecting.has(c.id));
          const active = !!c && conn?.id === c.id;
          return (
            <section key={e.key} className="nav__conn" aria-label={e.name}>
              <div className={`nav__row${active ? ' is-active' : ''}${selectedKey === e.key ? ' is-selected' : ''}${c ? '' : ' is-off'}`}
                tabIndex={0} title={c ? `${c.info.user}@${c.info.serverVersion}` : t('saved.hint')}
                onClick={() => { setSelectedKey(e.key); if (c) db.setActiveConn(c.id); }} onDoubleClick={() => { if (!renaming) activate(e); }}
                onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setSelectedKey(e.key); if (c) db.setActiveConn(c.id); openMenu(ev.clientX, ev.clientY, e); }}
                onKeyDown={(ev) => onRowKey(ev, e)}>
                <button type="button" className="nav__twisty" tabIndex={-1} aria-expanded={c ? open : undefined} aria-label={e.name}
                  onClick={(ev) => { ev.stopPropagation(); if (c) toggle(e.key); else if (p) void connect(p); }}>{c ? (open ? '▾' : '▸') : '▸'}</button>
                <span className="nav__icon" data-driver={e.driver} aria-hidden>{DRIVER_MARK[e.driver] ?? 'J'}<i className={`nav__status${c && !c.lost ? ' is-on' : ''}${c?.lost ? ' is-lost' : ''}`} /></span>
                {renaming && p && renaming.id === p.id ? (
                  <input autoFocus aria-label={t('saved.rename')} className="ui-input nav__rename" value={renaming.name} onClick={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
                    onChange={(ev) => setRenaming({ id: p.id, name: ev.target.value })} onBlur={() => void commitRename()}
                    onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') void commitRename(); else if (ev.key === 'Escape') setRenaming(null); }} />
                ) : <span className="nav__name">{e.name}</span>}
                {busy && <span className="ui-spinner" role="status"><span className="ui-sr-only">…</span></span>}
                <span className="nav__meta">{e.driver}</span>
              </div>
              {open && c && <SchemaTree key={`${c.id}:${refreshKey[c.id] ?? 0}`} conn={c} embedded filter={q && !nameMatch(e) ? q : ''} />}
            </section>
          );
        })}
      </div>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(ev) => { void importFile(ev.target.files?.[0]); ev.target.value = ''; }} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {tool?.kind === 'search' && <SearchDialog conn={tool.conn} onClose={() => setTool(null)} />}
      {tool?.kind === 'monitor' && <MonitorDialog conn={tool.conn} onClose={() => setTool(null)} />}
      {tool?.kind === 'compare' && <SchemaCompareDialog onClose={() => setTool(null)} />}
      <Dialog open={!!deleting} alert title={t('saved.deleteTitle')} onClose={() => setDeleting(null)}
        footer={<>
          <Button onClick={() => setDeleting(null)}>{t('saved.cancel')}</Button>
          <Button variant="danger" onClick={() => { const p = deleting; setDeleting(null); if (p) void disconnect(p).then(() => deleteLocalProfile(p.id)); }}>{t('saved.delete')}</Button>
        </>}>
        {t('saved.deleteConfirm', { name: deleting?.name ?? '' })}
      </Dialog>
    </div>
  );
});
