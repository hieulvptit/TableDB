import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select, useToast } from '@vnpay/ui';
import { useAuth } from '../../auth/AuthContext';
import { createGateway } from '../../gateway';
import { t, errorMessage } from '../../i18n';
import { uid } from '../../lib';
import { friendlyDbError } from './dbErrors';
import { openConnection, openExternalUrl, testConnection } from './connect';
import {
  DEFAULT_PORTS, PASTE_EXAMPLE, customName, dialectOf, emptyCustomForm, formatEndpoint, usesSso, parseEndpoint, validateCustomForm, type ConnectType, type CustomDriver, type CustomForm, type FormIssue,
} from './custom';
import { useCustomDrivers } from './DriverManager';
import { customProfiles, deleteLocalProfile, findSameProfile, importLocalProfiles, downloadTextFile, useLocalProfiles, formFromProfile, duplicateLocalProfile, exportProfilesJson, loadLocalProfiles, parseProfilesJson, renameLocalProfile, saveLocalProfile, savedPassword, CUSTOM_TARGET, type LocalProfile } from './profiles';
import { emptyNetwork, hostKeyPrompt, pinHostKey, validateNetwork, type HostKeyPrompt, type NetworkForm } from './network';
import { HostKeyDialog, NetworkSettings } from './NetworkSettings';
import { ContextMenu, runShortcut, type MenuItem } from './ContextMenu';
import { useTableDb } from './store';

/** Hand-entered connection (permission db:custom): IP/host, port, SID or service name, driver properties, optional write. */
export function CustomConnect({ onConnected, initial }: { onConnected?: () => void; /** saved connection to load when the dialog opens (connect = try to connect right away) */ initial?: { id: string; connect?: boolean } }) {
  const toast = useToast();
  const { can } = useAuth();
  const db = useTableDb();
  const gateway = useMemo(() => createGateway(), []);
  const { drivers } = useCustomDrivers();

  const [f, setF] = useState<CustomForm>(emptyCustomForm);
  const [paste, setPaste] = useState('');
  const [touched, setTouched] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const locals = useLocalProfiles();
  const [busy, setBusy] = useState<'test' | 'connect' | null>(null);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [testMsg, setTestMsg] = useState('');
  /** SSO login page the driver asked us to open (shown as a fallback link while waiting) */
  const [ssoUrl, setSsoUrl] = useState('');
  /** SSH host key waiting for the user's confirmation, and what to retry once it is pinned */
  const [hostKey, setHostKey] = useState<{ prompt: HostKeyPrompt; kind: 'test' | 'connect'; form: CustomForm; pid?: string } | null>(null);

  const set = (p: Partial<CustomForm>) => setF((cur) => ({ ...cur, ...p }));
  const canWrite = can('db:write');
  const network: NetworkForm = f.network ?? emptyNetwork();
  const netIssues = validateNetwork(network);
  const issues = validateCustomForm(f);
  const has = (i: FormIssue) => touched && issues.includes(i);

  const driverOptions = [
    { value: 'trino', label: 'Trino' }, { value: 'postgresql', label: 'PostgreSQL' }, { value: 'oracle', label: 'Oracle' },
    ...drivers.map((d) => ({ value: `custom:${d.id}`, label: `${d.name}${d.loaded ? '' : ` (${t('custom.driver.notLoaded')})`}` })),
  ];
  const driverValue = f.driver === 'custom' ? `custom:${f.driverId ?? ''}` : f.driver;
  const pickDriver = (v: string) => {
    if (v.startsWith('custom:')) {
      const d = drivers.find((x) => x.id === v.slice(7));
      switchTo({ driver: 'custom', driverId: d?.id, driverName: d?.name, port: d?.defaultPort ? String(d.defaultPort) : f.port });
    } else {
      const drv = v as CustomDriver;
      switchTo({ driver: drv, driverId: undefined, driverName: undefined, port: String(DEFAULT_PORTS[drv as keyof typeof DEFAULT_PORTS] ?? f.port) });
    }
  };
  /** Change driver and rewrite the quick-paste text into the new driver's format (only when something was pasted). */
  const switchTo = (p: Partial<CustomForm>) => {
    const next = { ...f, ...p };
    set(p);
    if (paste.trim()) setPaste(formatEndpoint({ ...next, driver: dialectOf(next.driver) }));
  };

  const applyPaste = (v: string) => {
    setPaste(v);
    const p = parseEndpoint(v, dialectOf(f.driver));
    if (!p) return;
    set({
      host: p.host, ...(p.port ? { port: String(p.port) } : {}),
      ...(p.database ? { database: p.database, ...(p.connectType ? { connectType: p.connectType } : {}) } : {}),
      ...(p.schema ? { schema: p.schema } : {}),
    });
  };


  /** Save (or update) the connection locally right after it opened. The same connection (driver, endpoint, database, user) reuses the existing entry and its name. */
  const autoSave = async (form: CustomForm, pid?: string): Promise<string> => {
    const saved = customProfiles(loadLocalProfiles());
    const { username, schema, password, ...custom } = form;
    const probe = { id: '', username: username || undefined, custom };
    const existing = saved.find((x) => x.id === pid) ?? findSameProfile(saved, probe);
    const p: LocalProfile = { id: existing?.id ?? uid(), targetId: CUSTOM_TARGET, name: existing?.name ?? customName(form), authType: 'password', username: username || undefined, schema: schema || undefined, savePassword: true, custom };
    try { await saveLocalProfile(p, password || undefined); } catch { /* saving is best effort: the session is already open */ }
    return p.id;
  };

  /** An unknown/changed SSH host key is not an error to show: ask the user to confirm it, then retry. */
  const askHostKey = (e: unknown, kind: 'test' | 'connect', form: CustomForm, pid?: string) => {
    const prompt = hostKeyPrompt(e);
    if (prompt) setHostKey({ prompt, kind, form, pid });
    return !!prompt;
  };

  const connectWith = async (form: CustomForm, pid?: string) => {
    setBusy('connect');
    try {
      const conn = await openConnection({ custom: { ...form }, canWrite }, { onSsoUrl: setSsoUrl }, gateway);
      conn.profileId = await autoSave(form, pid);
      db.addConnection(conn);
      toast.push(t('connect.connected', { name: conn.name }), 'success');
      set({ password: '' });
      onConnected?.();
    } catch (e) {
      if (askHostKey(e, 'connect', form, pid)) return;
      const fe = friendlyDbError(e);
      setError({ title: fe.title, detail: fe.detail });
    } finally { setBusy(null); setSsoUrl(''); }
  };

  const act = async (kind: 'test' | 'connect') => {
    setError(null); setTestMsg(''); setTouched(true);
    if (issues.length > 0) return;
    if (netIssues.length > 0) { setError({ title: t('net.err.form'), detail: '' }); return; }
    const form = { ...f };
    if (!form.password && profileId) form.password = (await savedPassword(profileId)) ?? '';
    if (kind === 'connect') { await connectWith(form, profileId || undefined); return; }
    await testWith(form);
  };

  const testWith = async (form: CustomForm) => {
    setBusy('test');
    try {
      const r = await testConnection(gateway, { custom: form, canWrite }, { onSsoUrl: setSsoUrl });
      setTestMsg(t('connect.testOk', { ms: r.latencyMs, version: r.serverVersion ?? '?' }));
    } catch (e) {
      if (askHostKey(e, 'test', form)) return;
      const fe = friendlyDbError(e);
      setError({ title: fe.title, detail: fe.detail });
    } finally { setBusy(null); setSsoUrl(''); }
  };

  const profiles = customProfiles(locals);
  const formOf = formFromProfile;
  /** Pin the confirmed host key in the form (saved with the profile on connect) and retry the same action. */
  const trustHostKey = async () => {
    const h = hostKey; setHostKey(null);
    if (!h) return;
    const form: CustomForm = { ...h.form, network: pinHostKey(h.form.network ?? emptyNetwork(), h.prompt.hop, h.prompt.fingerprint) };
    setF((cur) => ({ ...cur, network: form.network }));
    if (h.kind === 'connect') await connectWith(form, h.pid); else await testWith(form);
  };
  const editProfile = async (p: LocalProfile) => { setProfileId(p.id); setError(null); setTestMsg(''); setF(await formOf(p)); };
  const connectProfile = async (p: LocalProfile) => {
    setError(null); setTestMsg('');
    // already open: focus it instead of opening a second sidecar session
    const open = db.connections.find((c) => c.profileId === p.id);
    if (open) { db.setActiveConn(open.id); onConnected?.(); return; }
    const form = await formOf(p);
    setProfileId(p.id); setF(form);
    if (!form.password) { setTouched(true); toast.push(t('saved.needPassword'), 'info'); return; }
    if (validateCustomForm(form).length > 0) { setTouched(true); return; }
    await connectWith(form, p.id);
  };
  const reconnectProfile = async (p: LocalProfile) => {
    for (const c of db.connections.filter((x) => x.profileId === p.id)) await db.removeConnection(c.id);
    await connectProfile(p);
  };
  const initialDone = useRef(false);
  useEffect(() => {
    if (!initial || initialDone.current) return;
    const p = customProfiles(loadLocalProfiles()).find((x) => x.id === initial.id);
    initialDone.current = true;
    if (p) void (initial.connect ? connectProfile(p) : editProfile(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const exportProfiles = (list: LocalProfile[]) => { downloadTextFile('tabledb-connections.json', exportProfilesJson(list)); toast.push(t('saved.exported', { n: list.length }), 'success'); };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const imported = parseProfilesJson(await file.text(), uid);
    if (!imported || imported.length === 0) { toast.push(t('saved.importInvalid'), 'error'); return; }
    const r = await importLocalProfiles(imported);
    toast.push(r.skipped ? t('saved.importedSkipped', { n: r.added, skipped: r.skipped }) : t('saved.imported', { n: r.added }), 'success');
  };
  const profileItems = (p: LocalProfile | null): MenuItem[] => {
    const open = p ? db.connections.some((c) => c.profileId === p.id) : false;
    const items: MenuItem[] = p ? [
      { key: 'connect', label: t('saved.connect'), shortcut: 'Enter', onSelect: () => void connectProfile(p) },
      { key: 'reconnect', label: t('saved.reconnect'), shortcut: 'Alt+R', disabled: !open, onSelect: () => void reconnectProfile(p) },
      { key: 'disconnect', label: t('saved.disconnect'), shortcut: 'Alt+X', disabled: !open, onSelect: () => { for (const c of db.connections.filter((x) => x.profileId === p.id)) void db.removeConnection(c.id); } },
      { key: 's1', label: '', separator: true },
      { key: 'edit', label: t('saved.edit'), shortcut: 'F4', onSelect: () => void editProfile(p) },
      { key: 'rename', label: t('saved.rename'), shortcut: 'F2', onSelect: () => setRenaming({ id: p.id, name: p.name }) },
      { key: 'duplicate', label: t('saved.duplicate'), shortcut: 'Mod+D', onSelect: async () => { try { await (duplicateLocalProfile(p.id, uid(), t('saved.copyName', { name: p.name }))); } catch (er) { toast.push(errorMessage(er), 'error'); } } },
      { key: 'export', label: t('saved.export'), shortcut: 'Mod+E', onSelect: () => exportProfiles([p]) },
      { key: 's3', label: '', separator: true },
      { key: 'delete', label: t('saved.delete'), shortcut: 'Delete', danger: true, onSelect: async () => { await deleteLocalProfile(p.id); if (profileId === p.id) { setProfileId(''); set({ password: '' }); } } },
    ] : [];
    return items;
  };
  const openMenu = (e: React.MouseEvent, p: LocalProfile | null) => {
    e.preventDefault(); e.stopPropagation();
    const items = profileItems(p);
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const commitRename = async () => {
    const r = renaming; setRenaming(null);
    if (r && r.name.trim()) await renameLocalProfile(r.id, r.name.trim().slice(0, 120));
  };

  const isOracle = f.driver === 'oracle';
  const dbLabel = isOracle ? t('custom.oracleValue', { type: f.connectType === 'sid' ? 'SID' : 'Service name' }) : f.driver === 'trino' ? t('custom.catalog') : f.driver === 'custom' ? '{database}' : t('custom.database');

  return (
    <div className="ui-col" style={{ gap: 12 }}>
      <div className="ui-col" style={{ gap: 4 }} onContextMenu={(e) => openMenu(e, null)}>
        <div className="ui-label">{t('saved.title')} ({profiles.length})</div>
        {profiles.length === 0 ? <div className="ui-muted">{t('saved.empty')}</div> : (
          <div role="listbox" aria-label={t('saved.title')} style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--ui-border)', borderRadius: 6 }}>
            {profiles.map((p) => {
              const open = db.connections.some((c) => c.profileId === p.id);
              return (
                <div key={p.id} role="option" aria-selected={p.id === profileId} tabIndex={0} title={t('saved.hint')}
                  onClick={() => void editProfile(p)} onDoubleClick={() => void connectProfile(p)} onContextMenu={(e) => openMenu(e, p)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void connectProfile(p); else if (e.key === 'F2') setRenaming({ id: p.id, name: p.name }); else if (e.key === 'ContextMenu') openMenu(e as unknown as React.MouseEvent, p); else runShortcut(profileItems(p), e); }}
                  style={{ padding: '6px 10px', cursor: 'pointer', background: p.id === profileId ? 'var(--ui-selected, rgba(127,127,127,.18))' : undefined }}>
                  {renaming?.id === p.id ? (
                    <input autoFocus aria-label={t('saved.rename')} className="ui-input" value={renaming.name} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} onBlur={() => void commitRename()}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void commitRename(); else if (e.key === 'Escape') setRenaming(null); }} />
                  ) : <><span style={{ color: open ? 'var(--ui-success)' : 'inherit' }}>{open ? '● ' : ''}{p.name}</span> <span className="ui-muted">{p.custom!.driver === 'custom' ? p.custom!.driverName : p.custom!.driver}</span></>}
                </div>
              );
            })}
          </div>
        )}
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <Input label={t('custom.paste')} value={paste} onChange={(e) => applyPaste(e.target.value)} placeholder={PASTE_EXAMPLE[dialectOf(f.driver)]} hint={t(`custom.pasteHint.${dialectOf(f.driver)}`)} />
      <Select label={t('custom.driver')} value={driverValue} onChange={(e) => pickDriver(e.target.value)} options={driverOptions} />
      {has('driverId') && <div className="ui-error-text" role="alert">{t('custom.err.driverId')}</div>}
      <div className="ui-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Input label={t('custom.host')} value={f.host} onChange={(e) => set({ host: e.target.value })} error={has('host') ? t('custom.err.host') : undefined} autoComplete="off" />
        <Input label={t('custom.port')} value={f.port} onChange={(e) => set({ port: e.target.value })} inputMode="numeric" error={has('port') ? t('custom.err.port') : undefined} />
      </div>
      {isOracle && (
        <fieldset className="ui-row" style={{ gap: 16, border: 0, padding: 0 }}>
          <legend className="ui-label">{t('custom.connectType')}</legend>
          {(['serviceName', 'sid'] as ConnectType[]).map((ct) => (
            <label key={ct} className="ui-row" style={{ gap: 4 }}>
              <input type="radio" name="oracle-connect-type" checked={f.connectType === ct} onChange={() => set({ connectType: ct })} />
              {ct === 'sid' ? 'SID' : 'Service name'}
            </label>
          ))}
        </fieldset>
      )}
      <Input label={dbLabel} value={f.database} onChange={(e) => set({ database: e.target.value })} error={has('database') ? t('custom.err.database') : undefined} autoComplete="off" />
      {f.driver === 'trino' && (
        <label className="ui-row" style={{ gap: 6 }}>
          <input type="checkbox" checked={f.sso} onChange={(e) => set({ sso: e.target.checked, ...(e.target.checked ? { ssl: true } : {}) })} />
          {t('connect.authSso')}
        </label>
      )}
      <label className="ui-row" style={{ gap: 6 }}>
        <input type="checkbox" checked={f.ssl || usesSso(f)} disabled={usesSso(f)} onChange={(e) => set({ ssl: e.target.checked })} />
        {t('custom.ssl')}
      </label>
      {!usesSso(f) && <>
        <Input label={t('connect.username')} value={f.username} onChange={(e) => set({ username: e.target.value })} error={has('username') ? t('custom.err.username') : undefined} autoComplete="off" />
        <Input label={t('connect.password')} type="password" value={f.password} onChange={(e) => set({ password: e.target.value })} autoComplete="off" />
      </>}
      {busy && usesSso(f) && (
        <div className="ui-card" role="status">
          {t('connect.ssoWaiting')}
          {ssoUrl && <div>{t('connect.ssoOpened')} <a href={ssoUrl} onClick={(e) => { e.preventDefault(); openExternalUrl(ssoUrl); }}>{t('connect.ssoReopen')}</a></div>}
        </div>
      )}
      <NetworkSettings value={network} onChange={(n) => set({ network: n })} touched={touched} />
      {error && <div className="ui-card" role="alert" style={{ borderColor: 'var(--ui-danger)' }}><strong>{error.title}</strong>{error.detail && <div className="ui-muted ui-mono" style={{ whiteSpace: 'pre-wrap' }}>{error.detail}</div>}</div>}
      {testMsg && <div className="ui-card" role="status" style={{ borderColor: 'var(--ui-success)' }}>{testMsg}</div>}
      <div className="ui-row" style={{ flexWrap: 'wrap' }}>
        <Button onClick={() => void act('test')} loading={busy === 'test'} disabled={!!busy}>{t('connect.test')}</Button>
        <Button variant="primary" onClick={() => void act('connect')} loading={busy === 'connect'} disabled={!!busy}>{t('connect.connect')}</Button>
      </div>
      <HostKeyDialog prompt={hostKey?.prompt ?? null} onTrust={() => void trustHostKey()} onCancel={() => setHostKey(null)} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
