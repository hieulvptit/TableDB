import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Spinner, SplitPane, Tabs, useToast } from '@vnpay/ui';
import { t } from '../../i18n';
import { joinConditionSource, lazyMetaSource, statementColumnsSource } from './completion';
import { downloadText } from './csv';
import { HistoryDialog } from './HistoryDialog';
import { Rail, RailButton, RailSep } from './icons';
import { ResultPanel } from './ResultView';
import { SnippetsDialog } from './SnippetsDialog';
import { SqlEditor, type SqlEditorHandle } from './SqlEditor';
import { useStoreVersion } from './SchemaTree';
import { useTableDb } from './store';
import type { Connection, EditorTabState } from './types';

const MAX_FILE = 5 * 1024 * 1024;

/** Schema switch (session.setSchema) + auto/manual commit with Commit/Rollback, in the editor status bar. */
export function SessionControls({ conn, tab }: { conn: Connection; tab?: EditorTabState }) {
  const db = useTableDb();
  useStoreVersion(conn);
  const cats = conn.store.catalogs()?.value ?? [];
  const schemas = conn.store.schemas(cats.length === 1 ? cats[0] : undefined)?.value ?? [];
  const cur = (tab?.kind === 'sql' ? tab.schema : null) ?? conn.currentSchema ?? '';
  const tx = conn.tx ?? { autoCommit: true, pending: false };
  const options = cur && !schemas.includes(cur) ? [cur, ...schemas] : schemas;
  return (
    <>
      {options.length > 0 && (
        <label title={t('session.schemaHint')}>{t('session.schema')}
          <select className="ui-select tb-status__select" value={cur} aria-label={t('session.schema')} onChange={(e) => { if (tab?.kind === 'sql') db.updateTab(tab.id, { schema: e.target.value }); void db.setSchema(conn.id, e.target.value); }}>
            {!cur && <option value="">—</option>}
            {options.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
      <label title={conn.allowWrite ? t('tx.modeHint') : t('tx.needsWrite')}>{t('tx.mode')}
        <select className="ui-select tb-status__select" aria-label={t('tx.mode')} value={tx.autoCommit ? 'auto' : 'manual'} disabled={!conn.allowWrite || tx.pending}
          onChange={(e) => void db.setAutoCommit(conn.id, e.target.value === 'auto')}>
          <option value="auto">{t('tx.auto')}</option>
          <option value="manual">{t('tx.manual')}</option>
        </select>
      </label>
      {!tx.autoCommit && (
        <>
          {tx.pending && <span className="tb-status__pending" role="status">● {t('tx.pending')}</span>}
          <Button size="sm" variant={tx.pending ? 'primary' : 'default'} disabled={!tx.pending} onClick={() => void db.commit(conn.id)}>{t('tx.commit')}</Button>
          <Button size="sm" disabled={!tx.pending} onClick={() => void db.rollback(conn.id)}>{t('tx.rollback')}</Button>
        </>
      )}
    </>
  );
}

export function QueryTab({ tab }: { tab: EditorTabState }) {
  const db = useTableDb();
  const toast = useToast();
  const conn = db.connections.find((c) => c.id === tab.connId) ?? null;
  useStoreVersion(conn);
  const connRef = useRef(conn); connRef.current = conn;
  const defaultSchema = conn?.currentSchema ?? conn?.defaultSchema ?? null;
  // read on every completion: metadata the completion itself loads shows up without waiting for a re-render
  const namespace = useCallback(() => connRef.current?.store.sqlNamespace() ?? {}, []);
  const sources = useMemo(() => {
    const store = () => connRef.current?.store ?? null;
    const schema = () => connRef.current?.currentSchema ?? connRef.current?.defaultSchema;
    return [
      joinConditionSource(store, () => connRef.current?.driver, schema),
      lazyMetaSource(store, schema, () => connRef.current?.driver),
      statementColumnsSource(store, schema),
    ];
  }, []);
  const ed = useRef<SqlEditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dlg, setDlg] = useState<null | 'history' | 'snippets' | 'saveSnippet'>(null);
  const writeAllowed = !!conn?.allowWrite;
  const write = tab.mode === 'write';
  const activeOut = tab.outputs.find((o) => o.id === tab.activeOutputId) ?? tab.outputs[tab.outputs.length - 1];
  // the error marker only while the statement is still where it ran
  const errorPos = activeOut?.errorPos !== undefined && activeOut.sqlFrom !== undefined && tab.sql.slice(activeOut.sqlFrom, activeOut.sqlFrom + activeOut.sql.length) === activeOut.sql ? activeOut.errorPos : null;

  const target = () => { const x = ed.current?.runTarget(); return x ? { sql: x.sql, from: x.from } : { sql: '', from: 0 }; };
  const run = (newOutput = false) => void db.run(tab.id, { ...target(), newOutput });
  const runScript = () => void db.run(tab.id, { sql: tab.sql, from: 0 });
  const explain = () => void db.explain(tab.id, target());
  const save = () => {
    const name = tab.fileName ?? `${tab.title.replace(/[\\/:*?"<>|\s]+/g, '_')}.sql`;
    downloadText(name, tab.sql, 'text/plain;charset=utf-8');
    db.updateTab(tab.id, { fileName: name });
    toast.push(t('file.saved', { name }), 'success');
  };
  const open = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_FILE) { toast.push(t('file.tooBig'), 'error'); return; }
    const text = (await f.text()).replace(/^﻿/, '');
    db.newTab(text, { title: f.name.replace(/\.(sql|txt)$/i, ''), fileName: f.name });
  };
  const insert = (sql: string) => { if (ed.current) ed.current.insert(sql); else db.insertSql(sql); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SplitPane direction="vertical" primary="first" initial={220} min={80} max={700} label={t('layout.resizeEditor')}>
          <div className="tb-with-rail">
            <Rail label={t('editor.toolbar')}>
              {tab.running
                ? <RailButton icon="stop" tone="danger" label={tab.script ? t('editor.stopScript') : t('editor.cancel')} onClick={() => void db.cancel(tab.id)} />
                : <RailButton icon="run" tone="run" label={t('editor.run')} disabled={!conn} onClick={() => run()} />}
              <RailButton icon="runNew" label={t('editor.runNewHint')} disabled={!conn || tab.running} onClick={() => run(true)} />
              <RailButton icon="script" label={t('editor.runScript')} disabled={!conn || tab.running} onClick={runScript} />
              <RailButton icon="explain" label={t('editor.explain')} disabled={!conn || tab.running} onClick={explain} />
              <RailSep />
              <RailButton icon={write ? 'unlock' : 'lock'} tone={write ? 'warn' : undefined} aria-pressed={write}
                label={t('editor.modeToggle', { mode: t(write ? 'mode.write' : 'mode.read'), hint: writeAllowed ? t(write ? 'mode.writeHint' : 'mode.readHint') : t('mode.writeUnavailable') })}
                disabled={!writeAllowed && !write} onClick={() => db.updateTab(tab.id, { mode: write ? 'read' : 'write' })} />
              {conn?.driver === 'oracle' && (
                <RailButton icon="output" aria-pressed={!!tab.serverOutput} label={t('editor.serverOutput')} onClick={() => db.updateTab(tab.id, { serverOutput: !tab.serverOutput })} />
              )}
              <RailSep />
              <RailButton icon="format" label={t('editor.format')} onClick={() => void ed.current?.format()} />
              <RailButton icon="open" label={t('editor.openFile')} onClick={() => fileRef.current?.click()} />
              <RailButton icon="save" label={t('editor.saveFile')} disabled={!tab.sql} onClick={save} />
              <RailSep />
              <RailButton icon="history" label={t('editor.history')} onClick={() => setDlg('history')} />
              <RailButton icon="snippet" label={t('editor.snippets')} onClick={() => setDlg(ed.current?.selectionText().trim() ? 'saveSnippet' : 'snippets')} />
            </Rail>
            <SqlEditor ref={ed} value={tab.sql} onChange={(v) => db.updateTab(tab.id, { sql: v })} driver={conn?.driver} namespace={namespace} defaultSchema={defaultSchema} sources={sources}
              onRun={() => run()} onRunNew={() => run(true)} onRunScript={runScript} onExplain={explain} onSave={save}
              onFormatError={(m) => toast.push(`${t('editor.formatFailed')} ${m.split('\n')[0]}`, 'error')}
              errorPos={errorPos} ariaLabel={t('editor.aria')} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            {tab.outputs.length === 0 || !activeOut
              ? <EmptyState title={t('result.emptyTitle')} description={t('result.emptyDesc')} />
              : (
                <Tabs
                  label={t('output.tabs')}
                  items={tab.outputs.map((o) => ({ id: o.id, label: <>{o.running ? '⏳ ' : o.pinned && !o.log ? '📌 ' : ''}{o.title}</>, closable: !o.running, closeLabel: t('output.close'), content: <ResultPanel tab={tab} output={o} /> }))}
                  activeId={activeOut.id} onChange={(id) => db.setActiveOutput(tab.id, id)} onClose={(id) => db.closeOutput(tab.id, id)}
                  className="ui-fill tdb-results"
                />
              )}
          </div>
        </SplitPane>
      </div>
      <div className="tb-status">
        {tab.running
          ? <span className="ui-row" style={{ gap: 4 }}><Spinner label="" />{tab.script ? t('editor.scriptProgress', { i: tab.script.index, n: tab.script.total }) : t('editor.running')}</span>
          : <span className={`tb-status__mode${write ? ' is-write' : ''}`}>{t('editor.modeStatus', { mode: t(write ? 'mode.write' : 'mode.read') })}</span>}
        {tab.fileName && <span className="ui-muted" title={tab.fileName}>{tab.fileName}</span>}
        <span style={{ flex: 1 }} />
        {conn && <SessionControls conn={conn} tab={tab} />}
        <label>{t('editor.maxRows')}
          <input className="ui-input" type="number" min={1} max={100000} value={tab.maxRows}
            onChange={(e) => db.updateTab(tab.id, { maxRows: Math.max(1, Math.min(100000, Number(e.target.value) || 1)) })} />
        </label>
        <label>{t('editor.timeout')}
          <input className="ui-input" type="number" min={1} max={600} value={tab.timeoutSec} style={{ width: 56 }}
            onChange={(e) => db.updateTab(tab.id, { timeoutSec: Math.max(1, Math.min(600, Number(e.target.value) || 1)) })} />
        </label>
      </div>
      <input ref={fileRef} type="file" accept=".sql,.txt,text/plain" hidden onChange={(e) => { void open(e.target.files?.[0]); e.target.value = ''; }} />
      {dlg === 'history' && <HistoryDialog onClose={() => setDlg(null)} onInsert={insert} onOpenTab={(sql) => db.newTab(sql)} />}
      {(dlg === 'snippets' || dlg === 'saveSnippet') && (
        <SnippetsDialog initialSql={dlg === 'saveSnippet' ? ed.current?.selectionText() : undefined} onClose={() => setDlg(null)} onInsert={insert} />
      )}
    </div>
  );
}
