import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Input, useToast } from '@vnpay/ui';
import { errorMessage, t } from '../../i18n';
import { desktopCommands, isTauri, type CustomDriverInfo } from '../../runtime/tauri';
import { toGatewayError } from '../../gateway/errors';

/** Imported (custom) JDBC drivers, loaded from the desktop shell. Empty outside the desktop runtime. */
export function useCustomDrivers() {
  const [drivers, setDrivers] = useState<CustomDriverInfo[]>([]);
  const reload = useCallback(async () => {
    if (!isTauri()) return;
    try { setDrivers((await desktopCommands.driverList()).drivers ?? []); } catch { setDrivers([]); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { drivers, reload };
}

const EXAMPLE = 'jdbc:mysql://{host}:{port}/{database}';

export function DriverManager({ drivers, onChanged }: { drivers: CustomDriverInfo[]; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [className, setClassName] = useState('');
  const [urlTemplate, setUrlTemplate] = useState('');
  const [defaultPort, setDefaultPort] = useState('');
  const [busy, setBusy] = useState(false);
  if (!isTauri()) return null;

  const portNum = defaultPort.trim() ? Number(defaultPort) : undefined;
  const portOk = portNum === undefined || (Number.isInteger(portNum) && portNum > 0 && portNum < 65536);
  const valid = !!name.trim() && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(className.trim()) && urlTemplate.trim().startsWith('jdbc:') && urlTemplate.includes('{host}') && portOk;

  const doImport = async () => {
    setBusy(true);
    try {
      const d = await desktopCommands.driverImport({ name: name.trim(), className: className.trim(), urlTemplate: urlTemplate.trim(), ...(portNum ? { defaultPort: portNum } : {}) });
      toast.push(t(d.loaded ? 'custom.driver.imported' : 'custom.driver.importedNotLoaded', { name: d.name }), d.loaded ? 'success' : 'error');
      setName(''); setClassName(''); setUrlTemplate(''); setDefaultPort('');
      onChanged();
    } catch (e) {
      if (toGatewayError(e).code !== 'E_CANCELLED') toast.push(errorMessage(e), 'error');
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await desktopCommands.driverRemove(id); onChanged(); } catch (e) { toast.push(errorMessage(e), 'error'); }
  };

  return (
    <details className="ui-card" style={{ padding: 8 }}>
      <summary>{t('custom.driver.title')} ({drivers.length})</summary>
      <div className="ui-col" style={{ gap: 8, marginTop: 8 }}>
        <div className="ui-muted" role="note">{t('custom.driver.warn')}</div>
        {drivers.map((d) => (
          <div key={d.id} className="ui-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong>{d.name}</strong>
            <span className="ui-mono ui-muted">{d.className} · {d.files.length} JAR</span>
            <Badge tone={d.loaded ? 'success' : 'danger'} title={d.error}>{d.loaded ? t('custom.driver.loaded') : t('custom.driver.notLoaded')}</Badge>
            {d.error && <span className="ui-error-text">{d.error}</span>}
            <Button size="sm" variant="ghost" onClick={() => void remove(d.id)}>{t('common.delete')}</Button>
          </div>
        ))}
        <Input label={t('custom.driver.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <Input label={t('custom.driver.class')} value={className} onChange={(e) => setClassName(e.target.value)} hint="com.mysql.cj.jdbc.Driver" />
        <Input label={t('custom.driver.url')} value={urlTemplate} onChange={(e) => setUrlTemplate(e.target.value)} hint={t('custom.driver.urlHint', { example: EXAMPLE })} />
        <Input label={t('custom.driver.port')} value={defaultPort} onChange={(e) => setDefaultPort(e.target.value)} inputMode="numeric" />
        <div><Button onClick={() => void doImport()} loading={busy} disabled={!valid || busy}>{t('custom.driver.import')}</Button></div>
      </div>
    </details>
  );
}
