import { useSyncExternalStore } from 'react';
import type { AuthMode, DbTarget } from '../../api/types';
import { desktopCommands } from '../../runtime/tauri';
import { emptyCustomForm, type ConnectType, type CustomDriver, type CustomForm, type PropRow } from './custom';
import { networkFields, networkSecrets, parseNetworkSecrets, restoreNetwork, type NetworkForm, type NetworkProfileFields, type NetworkSecrets } from './network';

/**
 * Locally saved sign-in preferences for a catalog target. NON-secret fields only, kept in localStorage (the desktop app's
 * WebView storage); the password (opt-in) lives in the OS credential manager via secret_*. Host/port/driver are never
 * stored here: they always come from the catalog.
 */
export interface LocalProfile {
  id: string; targetId: string; name: string; authType: AuthMode; username?: string; schema?: string; savePassword: boolean;
  /** hand-entered (db:custom) connection: non-secret endpoint fields; targetId is then CUSTOM_TARGET */
  custom?: CustomProfileFields;
}
export const CUSTOM_TARGET = 'custom';
export interface CustomProfileFields {
  driver: CustomDriver; driverId?: string; driverName?: string; host: string; port: string; connectType: ConnectType; database: string;
  ssl: boolean; connectTimeoutSec: string; props: PropRow[]; allowWrite: boolean; sso?: boolean;
  /** SSH tunnel / proxy without secrets (passwords/passphrases live in the credential store, see netSecretKeyFor) */
  network?: NetworkProfileFields;
}
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
/** Whitelist copy of the custom fields (drops anything unknown, e.g. a password smuggled into `props` rows is still just a prop the user typed). */
function cleanCustom(c: CustomProfileFields): CustomProfileFields {
  return {
    driver: c.driver, ...(c.driverId ? { driverId: str(c.driverId) } : {}), ...(c.driverName ? { driverName: str(c.driverName) } : {}),
    host: str(c.host), port: str(c.port), connectType: c.connectType === 'sid' ? 'sid' : 'serviceName', database: str(c.database),
    ssl: c.ssl === true, sso: c.sso === true, connectTimeoutSec: str(c.connectTimeoutSec, '15'), allowWrite: c.allowWrite === true,
    props: (Array.isArray(c.props) ? c.props : []).slice(0, 20).map((r) => ({ key: str(r?.key), value: str(r?.value) })),
    ...(c.network && typeof c.network === 'object' ? { network: networkFields(c.network) } : {}),
  };
}
const KEY = 'tabledb.localProfiles.v2';
export const secretKeyFor = (id: string) => `db.profile.${id}.password`;
/** SSH passwords/passphrases + proxy password of one saved connection, as one JSON item */
export const netSecretKeyFor = (id: string) => `db.profile.${id}.network`;

export function loadLocalProfiles(): LocalProfile[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? (v as LocalProfile[]).filter((p) => p && typeof p.id === 'string' && typeof p.targetId === 'string') : [];
  } catch { return []; }
}
const listeners = new Set<() => void>();
function persist(list: LocalProfile[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}
let snapRaw: string | null | undefined;
let snapList: LocalProfile[] = [];
function snapshot(): LocalProfile[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (raw !== snapRaw) { snapRaw = raw; snapList = loadLocalProfiles(); }
  return snapList;
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Saved profiles as reactive state: the navigator tree and the connection dialog always show the same list. */
export const useLocalProfiles = (): LocalProfile[] => useSyncExternalStore(subscribe, snapshot);

/** Saves text as a file through a temporary link (browser download / WebView). */
export function downloadTextFile(name: string, text: string, type = 'application/json;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Profiles that still make sense against the current catalog: target must exist and still offer the saved auth mode. */
export function profilesForCatalog(profiles: LocalProfile[], catalog: DbTarget[]): LocalProfile[] {
  const byId = new Map(catalog.map((x) => [x.id, x]));
  return profiles.filter((p) => !p.custom && byId.get(p.targetId)?.authModes.includes(p.authType));
}

/** Saved hand-entered connections (never mixed into the catalog list). */
export const customProfiles = (profiles: LocalProfile[]) => profiles.filter((p) => !!p.custom);

/**
 * @param netSecrets network secrets to store (null = none). By default they are taken from `p.custom.network` when it is
 * a live form (with password fields); a profile without a live form (e.g. an import) leaves the stored item alone.
 */
export async function saveLocalProfile(p: LocalProfile, password?: string, netSecrets?: NetworkSecrets | null): Promise<LocalProfile[]> {
  const n = p.custom?.network as Partial<NetworkForm> | undefined;
  const live = !!n && typeof n.proxy === 'object' && 'password' in n.proxy;
  const net = netSecrets !== undefined ? netSecrets : live ? networkSecrets(n as NetworkForm) : null;
  // Only known non-secret fields are persisted (a password can never end up in localStorage by accident).
  const clean: LocalProfile = { id: p.id, targetId: p.targetId, name: p.name, authType: p.authType, username: p.username, schema: p.schema, savePassword: p.savePassword, ...(p.custom ? { custom: cleanCustom(p.custom) } : {}) };
  const list = loadLocalProfiles().filter((x) => x.id !== p.id);
  list.push(clean);
  list.sort((a, b) => a.name.localeCompare(b.name));
  persist(list);
  if (clean.authType === 'password' && clean.savePassword && password) await desktopCommands.secretSet(secretKeyFor(clean.id), password);
  if (!clean.savePassword) await desktopCommands.secretDelete(secretKeyFor(clean.id)).catch(() => {});
  if (clean.savePassword && net) await desktopCommands.secretSet(netSecretKeyFor(clean.id), JSON.stringify(net));
  else if (!clean.savePassword || live || netSecrets !== undefined) await desktopCommands.secretDelete(netSecretKeyFor(clean.id)).catch(() => {});
  return list;
}
export async function deleteLocalProfile(id: string): Promise<LocalProfile[]> {
  const list = loadLocalProfiles().filter((x) => x.id !== id);
  persist(list);
  await desktopCommands.secretDelete(secretKeyFor(id)).catch(() => {});
  await desktopCommands.secretDelete(netSecretKeyFor(id)).catch(() => {});
  return list;
}
export const savedNetworkSecrets = async (id: string) => parseNetworkSecrets(await desktopCommands.secretGet(netSecretKeyFor(id)).catch(() => null));
export const savedPassword = (id: string) => desktopCommands.secretGet(secretKeyFor(id)).catch(() => null);

export async function renameLocalProfile(id: string, name: string): Promise<LocalProfile[]> {
  const list = loadLocalProfiles().map((x) => (x.id === id ? { ...x, name } : x));
  list.sort((a, b) => a.name.localeCompare(b.name));
  persist(list);
  return list;
}
/** Copy of a saved connection under a new id (the saved password, if any, is copied inside the OS credential manager). */
export async function duplicateLocalProfile(id: string, newId: string, name: string): Promise<LocalProfile[]> {
  const src = loadLocalProfiles().find((x) => x.id === id);
  if (!src) return loadLocalProfiles();
  const pw = src.savePassword ? await savedPassword(id) : null;
  const net = src.savePassword ? await savedNetworkSecrets(id) : null;
  return saveLocalProfile({ ...src, id: newId, name }, pw ?? undefined, net);
}

/**
 * Identity of a saved hand-entered connection: same driver + endpoint + database + user is the same connection, whatever its name
 * (host is case-insensitive, port compared as a number). null for catalog profiles.
 */
export function profileKey(p: Pick<LocalProfile, 'username' | 'custom'>): string | null {
  const c = p.custom;
  if (!c) return null;
  const driver = c.driver === 'custom' ? `custom:${c.driverId ?? ''}` : c.driver;
  return [driver, c.host.trim().toLowerCase(), Number(c.port) || c.port.trim(), c.database.trim(), c.driver === 'oracle' ? c.connectType : '', c.sso ? 'sso' : (p.username ?? '').trim()].join('|');
}
/** Saved connection with the same identity as `p` (other than `p` itself). */
export const findSameProfile = (list: LocalProfile[], p: Pick<LocalProfile, 'id' | 'username' | 'custom'>) => {
  const k = profileKey(p);
  return k === null ? undefined : list.find((x) => x.id !== p.id && profileKey(x) === k);
};

/** Saves imported connections, skipping those already saved (or repeated in the file). */
export async function importLocalProfiles(imported: LocalProfile[]): Promise<{ added: number; skipped: number }> {
  const seen = loadLocalProfiles();
  let added = 0;
  for (const p of imported) {
    if (findSameProfile(seen, p)) continue;
    await saveLocalProfile(p);
    seen.push(p);
    added++;
  }
  return { added, skipped: imported.length - added };
}

/**
 * Merges saved connections that are the same connection under the same name (left by earlier versions that saved a new entry on
 * every connect / import). A copy the user renamed (e.g. via "duplicate") is kept. The entry that is open, or has a saved password,
 * wins; the others and their stored secrets are removed. Returns removed id → kept id (SQL tabs of a removed entry move to the kept one).
 */
export async function dedupeLocalProfiles(): Promise<Map<string, string>> {
  const list = loadLocalProfiles();
  const open = loadOpenProfileIds();
  const groups = new Map<string, LocalProfile[]>();
  for (const p of list) {
    const k = profileKey(p);
    if (k === null) continue;
    const g = `${k}|${p.name.trim().toLowerCase()}`;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const drop = new Map<string, string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = g.find((p) => open.includes(p.id)) ?? g.find((p) => p.savePassword) ?? g[0]!;
    for (const p of g) if (p !== keep) drop.set(p.id, keep.id);
  }
  if (drop.size === 0) return drop;
  persist(list.filter((p) => !drop.has(p.id)));
  saveOpenProfileIds([...new Set(open.map((id) => drop.get(id) ?? id))]);
  for (const id of drop.keys()) {
    await desktopCommands.secretDelete(secretKeyFor(id)).catch(() => {});
    await desktopCommands.secretDelete(netSecretKeyFor(id)).catch(() => {});
  }
  return drop;
}

const EXPORT_FORMAT = 'tabledb.connections';
/** Imported SSH key ids are local to this machine: exported network settings keep the hops but not the key id. */
const exportable = (c: CustomProfileFields): CustomProfileFields => {
  const x = cleanCustom(c);
  return x.network ? { ...x, network: { ...x.network, hops: x.network.hops.map((h) => ({ ...h, keyId: '' })) } } : x;
};
/** JSON for sharing between machines. Non-secret fields only: passwords, SSH passphrases and keys are never exported. */
export function exportProfilesJson(list: LocalProfile[]): string {
  const profiles = list.filter((p) => !!p.custom).map((p) => ({ name: p.name, username: p.username, schema: p.schema, custom: exportable(p.custom!) }));
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, connections: profiles }, null, 2);
}
/** Validates an exported file; returns fresh profiles (new ids, no password) or null when the file is not ours. */
export function parseProfilesJson(text: string, newId: () => string): LocalProfile[] | null {
  try {
    const v = JSON.parse(text);
    if (!v || v.format !== EXPORT_FORMAT || !Array.isArray(v.connections)) return null;
    return v.connections.slice(0, 500)
      .filter((c: { name?: unknown; custom?: { host?: unknown } }) => typeof c?.name === 'string' && c.name.trim() && typeof c.custom?.host === 'string')
      .map((c: { name: string; username?: unknown; schema?: unknown; custom: CustomProfileFields }): LocalProfile => ({
        id: newId(), targetId: CUSTOM_TARGET, name: c.name.trim().slice(0, 120), authType: 'password',
        username: typeof c.username === 'string' ? c.username : undefined, schema: typeof c.schema === 'string' ? c.schema : undefined, savePassword: false, custom: cleanCustom(c.custom),
      }));
  } catch { return null; }
}

/** Form for a saved hand-entered connection, with the password / network secrets from the credential store when they were saved. */
export async function formFromProfile(p: LocalProfile): Promise<CustomForm> {
  const { network: net, ...custom } = p.custom!;
  return {
    ...emptyCustomForm(), ...custom, username: p.username ?? '', schema: p.schema ?? '', password: p.savePassword ? (await savedPassword(p.id)) ?? '' : '',
    ...(net ? { network: restoreNetwork(net, p.savePassword ? await savedNetworkSecrets(p.id) : null) } : {}),
  };
}

const OPEN_KEY = 'tabledb.openProfiles.v1';
/** Saved connections that were open when the page was last left; they are reopened after a refresh. */
export function loadOpenProfileIds(): string[] {
  try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
export function saveOpenProfileIds(ids: string[]) { try { localStorage.setItem(OPEN_KEY, JSON.stringify(ids)); } catch { /* ignore */ } }
