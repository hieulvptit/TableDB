import { loadDbRuntimeConfig } from './runtimeConfig';
import { useAsync } from '../../hooks';
import { AsyncView } from '../../components/AsyncView';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Spinner, SplitPane, Tabs } from '@vnpay/ui';
import { DashboardDialog } from '../report/DashboardDialog';
import { AgentPanel } from '../agent/AgentPanel';
import { t } from '../../i18n';
import { ConnectPanel } from './ConnectPanel';
import { QueryTab } from './QueryTab';
import { TableDataTab } from './TableDataTab';
import { Navigator } from './Navigator';
import { TableDbProvider, useTableDb } from './store';
import { useRestoreConnections } from './useRestoreConnections';
import { WriteConfirmDialog } from './WriteConfirmDialog';
import { BindDialog } from './BindDialog';
import { useWorkspaceReady } from './workspace';
import { useLocalProfiles } from './profiles';
import { Icon } from './icons';

function Workspace() {
  const db = useTableDb();
  useRestoreConnections();
  /** connection dialog: closed | new | a saved connection (edit, or connect right away) */
  const [connectDlg, setConnectDlg] = useState<{ id?: string; connect?: boolean } | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const refocusFab = useRef(false);
  const [agentSize, setAgentSize] = useState<{ w: number; h: number } | null>(() => {
    try { const v = JSON.parse(localStorage.getItem('tabledb.agentSize') || 'null'); return v && v.w > 0 && v.h > 0 ? v : null; } catch { return null; }
  });
  const startAgentResize = (dx: 0 | 1, dy: 0 | 1) => (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    let last = { w: box.width, h: box.height };
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const move = (ev: PointerEvent) => {
      last = {
        w: clamp(box.width + (dx ? x0 - ev.clientX : 0), 320, window.innerWidth - 32),
        h: clamp(box.height + (dy ? y0 - ev.clientY : 0), 300, window.innerHeight - 70),
      };
      setAgentSize(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.classList.remove('agent-resizing');
      try { localStorage.setItem('tabledb.agentSize', JSON.stringify(last)); } catch { /* ignore */ }
    };
    e.preventDefault();
    document.body.classList.add('agent-resizing');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const collapseAgent = useCallback(() => { refocusFab.current = true; setAgentOpen(false); }, []);
  const newConnection = useCallback(() => setConnectDlg({}), []);
  const editConnection = useCallback((id: string, connect?: boolean) => setConnectDlg({ id, connect }), []);
  // after collapsing, keyboard focus lands on the bubble instead of being lost with the hidden popup
  useEffect(() => { if (!agentOpen && refocusFab.current) { refocusFab.current = false; fabRef.current?.focus(); } }, [agentOpen]);
  const conn = db.activeConn;
  const profiles = useLocalProfiles();
  /** database the tab runs against: open connection, else the saved profile it is bound to */
  const dbNameOf = (x: (typeof db.tabs)[number]) => db.connections.find((c) => c.id === x.connId)?.name ?? profiles.find((p) => p.id === x.profileId)?.name;

  const center = db.connections.length === 0 ? (
    <div className="tdb-connect">
      <div className="ui-card" style={{ width: 'min(560px, 100%)', height: 'fit-content' }}>
        <h2 style={{ marginTop: 0 }}>{t('tabledb.connectTitle')}</h2>
        <ConnectPanel />
      </div>
    </div>
  ) : (
    <Tabs
      label={t('tabledb.editors')}
      items={db.tabs.map((x) => ({ id: x.id, label: <span className="tdb-tab" title={dbNameOf(x) ? `${x.title} — ${dbNameOf(x)}` : x.title}>{x.running ? <span className="ui-spinner" aria-hidden="true" /> : x.kind === 'table' ? <Icon name="grid" /> : null}<span className="tdb-tab__title">{x.title}</span>{dbNameOf(x) && <span className="tdb-tab__db">· {dbNameOf(x)}</span>}</span>, closable: true, closeLabel: t('tabledb.closeTab'), content: x.kind === 'table' ? <TableDataTab tab={x} /> : <QueryTab tab={x} /> }))}
      activeId={db.activeTab?.id ?? ''} onChange={db.setActiveTab} onClose={db.closeTab}
      trailing={<>
        <button type="button" className="tdb-tab-add" onClick={() => db.newTab()} aria-label={t('tabledb.newTab')} title={t('tabledb.newTab')}><Icon name="plus" /></button>
        <button type="button" className="tdb-tab-add" onClick={() => setDashOpen(true)} aria-label={t('dash.open')} title={t('dash.open')}><Icon name="dashboard" /></button>
      </>}
      className="ui-fill"
    />
  );

  return (
    <div className="tdb-workspace" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SplitPane primary="first" initial={290} min={200} max={520} label={t('layout.resizeTree')}>
          <Navigator onNewConnection={newConnection} onEditConnection={editConnection} />
          <div style={{ height: '100%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{center}</div>
        </SplitPane>
      </div>
      {/* Non-modal popup: the tree and editor stay usable (select tables, insert SQL) while chatting. Kept mounted so the conversation survives closing. */}
      {db.connections.length > 0 && (
        <div id="agent-popup" className="agent-popup" hidden={!agentOpen} role="dialog" aria-modal="false" aria-label={t('agent.title')}
          style={agentSize ? { width: agentSize.w, height: agentSize.h, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 70px)' } : undefined}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); collapseAgent(); } }}>
          <div className="agent-popup__grip agent-popup__grip--w" onPointerDown={startAgentResize(1, 0)} />
          <div className="agent-popup__grip agent-popup__grip--n" onPointerDown={startAgentResize(0, 1)} />
          <div className="agent-popup__grip agent-popup__grip--nw" onPointerDown={startAgentResize(1, 1)} />
          <AgentPanel open={agentOpen} onClose={collapseAgent} />
        </div>
      )}
      {db.connections.length > 0 && !agentOpen && (
        <button ref={fabRef} type="button" className="agent-fab" aria-controls="agent-popup" aria-expanded={false} title={t('agent.expand')} onClick={() => setAgentOpen(true)}>
          {t('agent.open')}
        </button>
      )}
      <Dialog open={!!connectDlg} wide title={t('tabledb.manageConnections')} onClose={() => setConnectDlg(null)}>
        <ConnectPanel onConnected={() => setConnectDlg(null)} initial={connectDlg?.id ? { id: connectDlg.id, connect: connectDlg.connect } : undefined} />
      </Dialog>
      <DashboardDialog open={dashOpen} onClose={() => setDashOpen(false)} />
      {db.pendingBinds && <BindDialog pending={db.pendingBinds} />}
      {db.pendingWrite && (() => {
        const p = db.pendingWrite;
        const wc = db.connections.find((c) => c.id === db.tabs.find((x) => x.id === p.tabId)?.connId) ?? conn;
        return (
          <WriteConfirmDialog open sql={p.sql} classification={p.classification} connectionName={wc?.name}
            binds={p.bindNames?.map((name, i) => ({ name, value: p.params![i]! }))} script={p.script} manualCommit={wc?.tx ? !wc.tx.autoCommit : false}
            onConfirm={() => void db.confirmWrite()} onCancel={db.dismissWrite} onSkip={db.skipWrite} />
        );
      })()}
      <Dialog open={!!db.pendingDisconnect} alert title={t('tx.disconnectTitle')} onClose={() => void db.resolveDisconnect('cancel')}
        footer={<>
          <Button data-autofocus onClick={() => void db.resolveDisconnect('cancel')}>{t('common.cancel')}</Button>
          <Button onClick={() => void db.resolveDisconnect('rollback')}>{t('tx.rollbackDisconnect')}</Button>
          <Button variant="primary" onClick={() => void db.resolveDisconnect('commit')}>{t('tx.commitDisconnect')}</Button>
        </>}>
        {t('tx.disconnectBody', { name: db.pendingDisconnect?.name ?? '' })}
      </Dialog>
    </div>
  );
}

export default function TableDbPage() {
  // saved tabs are restored when the provider mounts: wait until the (encrypted) workspace is loaded
  const ready = useWorkspaceReady();
  const config = useAsync(loadDbRuntimeConfig, []);
  if (!ready) return <div className="ui-row" style={{ padding: 24 }}><Spinner label={t('common.loading')} /> {t('common.loading')}</div>;
  return <AsyncView state={config}>{() => <TableDbProvider><Workspace /></TableDbProvider>}</AsyncView>;
}
