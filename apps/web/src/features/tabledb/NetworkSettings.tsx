import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Dialog, Input, Select, useToast } from '@vnpay/ui';
import { errorMessage, t } from '../../i18n';
import { desktopCommands, isTauri, type SshKeyInfo } from '../../runtime/tauri';
import { toGatewayError } from '../../gateway/errors';
import {
  MAX_HOPS, emptyHop, routeLabel, validateNetwork, type HopForm, type HostKeyPrompt, type NetworkForm, type NetworkIssue, type ProxyType, type SshAuthType,
} from './network';

/** SSH private keys imported into the desktop's app data (empty outside the desktop runtime). */
export function useSshKeys() {
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const reload = useCallback(async () => {
    if (!isTauri()) return;
    try { setKeys((await desktopCommands.sshKeyList()).keys ?? []); } catch { setKeys([]); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { keys, reload };
}

function SshKeyManager({ keys, onChanged }: { keys: SshKeyInfo[]; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!isTauri()) return null;
  const doImport = async () => {
    setBusy(true);
    try {
      const k = await desktopCommands.sshKeyImport();
      toast.push(t('net.keys.imported', { name: k.name }), 'success');
      onChanged();
    } catch (e) {
      if (toGatewayError(e).code !== 'E_CANCELLED') toast.push(errorMessage(e), 'error');
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await desktopCommands.sshKeyRemove(id); onChanged(); } catch (e) { toast.push(errorMessage(e), 'error'); }
  };
  return (
    <details className="ui-card" style={{ padding: 8 }}>
      <summary>{t('net.keys.title')} ({keys.length})</summary>
      <div className="ui-col" style={{ gap: 6, marginTop: 8 }}>
        <div className="ui-muted" role="note">{t('net.keys.warn')}</div>
        {keys.map((k) => (
          <div key={k.id} className="ui-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong>{k.name}</strong>
            <span className="ui-mono ui-muted">{k.format}</span>
            {k.encrypted && <Badge tone="info">{t('net.keys.encrypted')}</Badge>}
            <Button size="sm" variant="ghost" onClick={() => void remove(k.id)}>{t('common.delete')}</Button>
          </div>
        ))}
        <div><Button size="sm" onClick={() => void doImport()} loading={busy} disabled={busy}>{t('net.keys.import')}</Button></div>
      </div>
    </details>
  );
}

function HopEditor({ hop, index, count, keys, err, onChange, onRemove, onImportKey }: {
  hop: HopForm; index: number; count: number; keys: SshKeyInfo[]; err: (k: string) => string | undefined;
  onChange: (p: Partial<HopForm>) => void; onRemove?: () => void; onImportKey?: () => void;
}) {
  const n = index + 1;
  const title = count === 1 ? t('net.hop', { n }) : index === 0 ? t('net.hopFirst', { n }) : index === count - 1 ? t('net.hopLast', { n }) : t('net.hop', { n });
  const key = keys.find((k) => k.id === hop.keyId);
  return (
    <fieldset className="ui-card ui-col" style={{ gap: 8, padding: 8 }} aria-label={title}>
      <legend className="ui-label">{title}</legend>
      <div className="ui-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Input label={t('net.hopHost')} value={hop.host} onChange={(e) => onChange({ host: e.target.value, hostKey: '' })} error={err(`hop.${index}.host`)} autoComplete="off" />
        <Input label={t('net.hopPort')} value={hop.port} onChange={(e) => onChange({ port: e.target.value, hostKey: '' })} inputMode="numeric" error={err(`hop.${index}.port`)} />
        <Input label={t('net.hopUser')} value={hop.username} onChange={(e) => onChange({ username: e.target.value })} error={err(`hop.${index}.username`)} autoComplete="off" />
      </div>
      <Select label={t('net.auth')} value={hop.authType} onChange={(e) => onChange({ authType: e.target.value as SshAuthType })}
        options={[{ value: 'password', label: t('net.authPassword') }, { value: 'publicKey', label: t('net.authKey') }]} />
      {hop.authType === 'password' ? (
        <Input label={t('net.sshPassword')} type="password" value={hop.password} onChange={(e) => onChange({ password: e.target.value })} autoComplete="off" />
      ) : (
        <div className="ui-row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Select label={t('net.key')} value={keys.some((k) => k.id === hop.keyId) ? hop.keyId : ''} onChange={(e) => onChange({ keyId: e.target.value })}
            placeholder={t('net.keyPick')} options={keys.map((k) => ({ value: k.id, label: `${k.name}${k.encrypted ? ' 🔒' : ''}` }))} error={err(`hop.${index}.keyId`)} />
          {onImportKey && <div style={{ alignSelf: 'flex-end' }}><Button size="sm" onClick={onImportKey}>{t('net.keys.import')}</Button></div>}
          <Input label={t('net.passphrase')} type="password" value={hop.passphrase} onChange={(e) => onChange({ passphrase: e.target.value })} autoComplete="off"
            hint={key?.encrypted && !hop.passphrase ? t('net.passphraseNeeded') : undefined} />
        </div>
      )}
      <div className="ui-row ui-muted" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span>{t('net.hostKey')}:</span>
        {hop.hostKey ? <span className="ui-mono">{hop.hostKey}</span> : <span>{t('net.hostKeyNone')}</span>}
        {hop.hostKey && <Button size="sm" variant="ghost" onClick={() => onChange({ hostKey: '' })}>{t('net.hostKeyForget')}</Button>}
        {onRemove && <Button size="sm" variant="ghost" onClick={onRemove}>{t('net.removeHop')}</Button>}
      </div>
    </fieldset>
  );
}

const DEFAULT_PROXY_PORT: Record<ProxyType, string> = { socks: '1080', http: '3128' };

const ISSUE_TEXT: Record<string, string> = {
  'proxy.host': 'net.err.proxyHost', 'proxy.port': 'net.err.proxyPort', 'proxy.username': 'net.err.proxyUser', keepAlive: 'net.err.keepAlive',
  host: 'net.err.host', port: 'net.err.port', username: 'net.err.username', keyId: 'net.err.keyId',
};

/** "Advanced connection" block: HTTP/SOCKS5 proxy and/or a chain of SSH servers in front of the database. */
export function NetworkSettings({ value, onChange, touched }: { value: NetworkForm; onChange: (n: NetworkForm) => void; touched: boolean }) {
  const { keys, reload } = useSshKeys();
  const issues = validateNetwork(value);
  const err = (k: string) => {
    if (!touched || !issues.includes(k as NetworkIssue)) return undefined;
    const tail = k.startsWith('hop.') ? k.split('.')[2]! : k;
    return ISSUE_TEXT[tail] ? t(ISSUE_TEXT[tail] as never) : undefined;
  };
  const set = (p: Partial<NetworkForm>) => onChange({ ...value, ...p });
  const setHop = (i: number, p: Partial<HopForm>) => set({ hops: value.hops.map((h, j) => (j === i ? { ...h, ...p } : h)) });
  const route = routeLabel(value);
  const toast = useToast();

  // Key auth without a valid key selected: use the first imported key (the list is ordered by the app's key store).
  useEffect(() => {
    if (!value.useSsh || keys.length === 0) return;
    if (!value.hops.some((h) => h.authType === 'publicKey' && !keys.some((k) => k.id === h.keyId))) return;
    onChange({ ...value, hops: value.hops.map((h) => (h.authType === 'publicKey' && !keys.some((k) => k.id === h.keyId) ? { ...h, keyId: keys[0]!.id } : h)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, value.useSsh, value.hops]);

  /** Pick a private key file from disk (native dialog), store it and select it for this hop. */
  const importKeyFor = async (i: number) => {
    try {
      const k = await desktopCommands.sshKeyImport();
      toast.push(t('net.keys.imported', { name: k.name }), 'success');
      await reload();
      setHop(i, { keyId: k.id });
    } catch (e) {
      if (toGatewayError(e).code !== 'E_CANCELLED') toast.push(errorMessage(e), 'error');
    }
  };

  return (
    <details className="ui-card" style={{ padding: 8 }} open={value.useProxy || value.useSsh}>
      <summary>{t('net.title')} {route ? <Badge tone="info">{route}</Badge> : <span className="ui-muted">— {t('net.direct')}</span>}</summary>
      <div className="ui-col" style={{ gap: 10, marginTop: 8 }}>
        <div className="ui-muted" role="note">{t('net.hint')}</div>

        <Checkbox label={t('net.useProxy')} checked={value.useProxy} onChange={(e) => set({ useProxy: e.target.checked })} />
        {value.useProxy && (
          <div className="ui-col" style={{ gap: 8, paddingLeft: 16 }}>
            <Checkbox label={t('net.useDefaultProxy')} checked={value.proxy.useDefault === true} onChange={(e) => set({ proxy: { ...value.proxy, useDefault: e.target.checked } })} />
            {value.proxy.useDefault ? <div className="ui-muted">HTTP 10.23.5.189:3359 · de_team</div> : <>
            <div className="ui-row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <Select label={t('net.proxyType')} value={value.proxy.type}
                onChange={(e) => { const type = e.target.value as ProxyType; set({ proxy: { ...value.proxy, type, port: value.proxy.port === DEFAULT_PROXY_PORT[value.proxy.type] ? DEFAULT_PROXY_PORT[type] : value.proxy.port } }); }}
                options={[{ value: 'socks', label: 'SOCKS5' }, { value: 'http', label: 'HTTP (CONNECT)' }]} />
              <Input label={t('net.proxyHost')} value={value.proxy.host} onChange={(e) => set({ proxy: { ...value.proxy, host: e.target.value } })} error={err('proxy.host')} autoComplete="off" />
              <Input label={t('net.proxyPort')} value={value.proxy.port} onChange={(e) => set({ proxy: { ...value.proxy, port: e.target.value } })} inputMode="numeric" error={err('proxy.port')} />
            </div>
            <div className="ui-row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <Input label={t('net.proxyUser')} value={value.proxy.username} onChange={(e) => set({ proxy: { ...value.proxy, username: e.target.value } })} error={err('proxy.username')} autoComplete="off" />
              <Input label={t('net.proxyPassword')} type="password" value={value.proxy.password} onChange={(e) => set({ proxy: { ...value.proxy, password: e.target.value } })} autoComplete="off" />
            </div>
            </>}
          </div>
        )}

        <Checkbox label={t('net.useSsh')} checked={value.useSsh} onChange={(e) => set({ useSsh: e.target.checked, hops: value.hops.length ? value.hops : [emptyHop()] })} />
        {value.useSsh && (
          <div className="ui-col" style={{ gap: 8, paddingLeft: 16 }}>
            {value.hops.map((h, i) => (
              <HopEditor key={i} hop={h} index={i} count={value.hops.length} keys={keys} err={err} onChange={(p) => setHop(i, p)} onImportKey={isTauri() ? () => void importKeyFor(i) : undefined}
                onRemove={value.hops.length > 1 ? () => set({ hops: value.hops.filter((_, j) => j !== i) }) : undefined} />
            ))}
            <div className="ui-row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
              <Button size="sm" onClick={() => set({ hops: [...value.hops, { ...emptyHop(), username: value.hops[value.hops.length - 1]?.username ?? '' }] })} disabled={value.hops.length >= MAX_HOPS}>{t('net.addHop')}</Button>
              <Input label={t('net.keepAlive')} value={value.keepAliveSec} onChange={(e) => set({ keepAliveSec: e.target.value })} inputMode="numeric" error={err('keepAlive')} />
            </div>
            <SshKeyManager keys={keys} onChanged={() => void reload()} />
          </div>
        )}
      </div>
    </details>
  );
}

/** Trust-on-first-use prompt for an SSH host key; a changed key needs an explicit acknowledgement. */
export function HostKeyDialog({ prompt, onTrust, onCancel }: { prompt: HostKeyPrompt | null; onTrust: () => void; onCancel: () => void }) {
  const [ack, setAck] = useState(false);
  useEffect(() => { setAck(false); }, [prompt]);
  const mismatch = prompt?.reason === 'mismatch';
  return (
    <Dialog open={!!prompt} alert title={mismatch ? t('net.hk.titleMismatch') : t('net.hk.titleUnknown')} onClose={onCancel}
      footer={<>
        <Button data-autofocus onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant={mismatch ? 'danger' : 'primary'} disabled={mismatch && !ack} onClick={onTrust}>{mismatch ? t('net.hk.replace') : t('net.hk.trust')}</Button>
      </>}>
      {prompt && (
        <div className="ui-col" style={{ gap: 8 }}>
          <p style={{ margin: 0 }}>{mismatch ? t('net.hk.mismatch', { host: prompt.host, port: prompt.port }) : t('net.hk.unknown', { host: prompt.host, port: prompt.port })}</p>
          {mismatch && prompt.expected && <div><div className="ui-label">{t('net.hk.expected')}</div><code className="ui-mono">{prompt.expected}</code></div>}
          <div><div className="ui-label">{t('net.hk.got')} ({prompt.keyType})</div><code className="ui-mono" style={{ wordBreak: 'break-all' }}>{prompt.fingerprint}</code></div>
          {mismatch && <Checkbox label={t('net.hk.ack')} checked={ack} onChange={(e) => setAck(e.target.checked)} />}
        </div>
      )}
    </Dialog>
  );
}
