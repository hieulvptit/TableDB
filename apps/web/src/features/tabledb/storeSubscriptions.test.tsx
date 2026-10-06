import { memo } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { TableDbProvider, useTableDb, useTableDbSelector, type TableDbApi } from './store';
import type { Connection } from './types';
import { ResultPanel } from './ResultView';

describe('TableDB state subscriptions', () => {
  it('isolates connection and agent consumers from SQL and query output updates', () => {
    let db: TableDbApi;
    let connectionRenders = 0, agentRenders = 0;
    const connectionState = (state: TableDbApi) => ({ connections: state.connections, activeConn: state.activeConn });
    const agentState = (state: TableDbApi) => ({ connections: state.connections, selected: state.selected, agentRows: state.agentRows });
    const Connections = memo(function Connections() {
      const state = useTableDbSelector(connectionState);
      connectionRenders++;
      return <span>{state.activeConn?.name}</span>;
    });
    const Agent = memo(function Agent() { useTableDbSelector(agentState); agentRenders++; return null; });
    function Workspace() {
      db = useTableDb();
      return <><Connections /><Agent /><span data-testid="sql">{db.activeTab?.sql}</span></>;
    }
    render(<ToastProvider><TableDbProvider><Workspace /></TableDbProvider></ToastProvider>);
    act(() => { db.addConnection({ id: 'c1', name: 'Connection', api: {} } as Connection); });
    act(() => { db.newTab('select 1'); });
    const before = [connectionRenders, agentRenders];
    act(() => { db.updateTab(db.activeTab!.id, { sql: 'select 12' }); });
    expect(screen.getByTestId('sql')).toHaveTextContent('select 12');
    act(() => { db.updateTab(db.activeTab!.id, { outputs: [{ id: 'out', title: 'Result', sql: 'select 12' }] }); });
    act(() => { db.patchOutput(db.activeTab!.id, 'out', { loadingMore: true }); });
    expect([connectionRenders, agentRenders]).toEqual(before);
    act(() => { db.updateConnection('c1', { name: 'Renamed' }); });
    expect(screen.getByText('Renamed')).toBeInTheDocument();
    expect(connectionRenders).toBeGreaterThan(before[0]!);
    expect(agentRenders).toBeGreaterThan(before[1]!);
  });

  it('keeps grid cells outside the viewport lazy and does not render results for SQL typing', () => {
    let db: TableDbApi;
    const visibleCell = vi.fn(() => 'visible');
    const offscreenCell = vi.fn(() => 'offscreen');
    const rows = Array.from({ length: 2000 }, () => ['value']);
    Object.defineProperty(rows[0], '0', { get: visibleCell });
    Object.defineProperty(rows[1999], '0', { get: offscreenCell });
    function Workspace() {
      db = useTableDb();
      return db.activeTab ? <ResultPanel tab={db.activeTab} output={db.activeTab.outputs[0]} /> : null;
    }
    render(<ToastProvider><TableDbProvider><Workspace /></TableDbProvider></ToastProvider>);
    act(() => { db.newTab('select value'); });
    act(() => { db.updateTab(db.activeTab!.id, { outputs: [{ id: 'out', title: 'Result', sql: 'select value', result: { kind: 'read', columns: [{ name: 'value' }], rows, hasMore: false, truncated: false, elapsedMs: 1 } }] }); });
    expect(visibleCell).toHaveBeenCalled();
    expect(offscreenCell).not.toHaveBeenCalled();
    visibleCell.mockClear();
    act(() => { db.updateTab(db.activeTab!.id, { sql: 'select another_value' }); });
    expect(visibleCell).not.toHaveBeenCalled();
    expect(offscreenCell).not.toHaveBeenCalled();
  });
});
