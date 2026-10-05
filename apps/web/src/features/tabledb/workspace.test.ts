import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addHistory, clearWorkspace, flushWorkspaceForTests, getHistory, initWorkspace, loadTabs, resetWorkspaceForTests, saveTabs, workspaceStorage } from './workspace';

/** Desktop shell: the workspace goes through the Rust core (encrypted file), never into localStorage. */
let stored: string | null;
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stored = null;
  invoke = vi.fn(async (cmd: string, args?: { data?: string }) => {
    if (cmd === 'workspace_load') return stored;
    if (cmd === 'workspace_save') { stored = args!.data!; return null; }
    if (cmd === 'workspace_clear') { stored = null; return null; }
    throw new Error(`unexpected ${cmd}`);
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  resetWorkspaceForTests();
});
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

describe('encrypted workspace (desktop)', () => {
  it('loads from and saves to the Rust store; nothing is written to localStorage', async () => {
    stored = JSON.stringify({ v: 1, settings: { persistTabs: true, recordHistory: true }, tabs: [{ title: 'A', sql: 'SELECT 1', maxRows: 10, timeoutSec: 5 }], history: [], snippets: [] });
    await initWorkspace();
    expect(workspaceStorage()).toBe('encrypted');
    expect(loadTabs()).toEqual([{ title: 'A', sql: 'SELECT 1', maxRows: 10, timeoutSec: 5 }]);
    addHistory({ sql: "SELECT * FROM cards WHERE pan = '4111'", connName: 'PG', ok: true, mode: 'read' });
    saveTabs([{ title: 'B', sql: 'SELECT 2', maxRows: 1, timeoutSec: 1 }]);
    await flushWorkspaceForTests();
    expect(invoke).toHaveBeenCalledWith('workspace_save', expect.anything());
    const doc = JSON.parse(stored!);
    expect(doc.tabs[0].sql).toBe('SELECT 2');
    expect(doc.history[0].sql).toContain('4111');
    expect(Object.keys(localStorage).filter((k) => k.startsWith('tdb.ws.'))).toEqual([]);
  });

  it('migrates the old plaintext localStorage keys once, then removes them', async () => {
    localStorage.setItem('tdb.ws.tabs.v1', JSON.stringify([{ title: 'Old', sql: 'SELECT old', maxRows: 1, timeoutSec: 1 }]));
    localStorage.setItem('tdb.ws.history.v1', JSON.stringify([{ id: 'h1', at: 1, sql: 'SELECT h', connName: 'X', ok: true, mode: 'read' }]));
    await initWorkspace();
    expect(loadTabs()[0]!.sql).toBe('SELECT old');
    expect(getHistory()[0]!.sql).toBe('SELECT h');
    expect(JSON.parse(stored!).tabs[0].sql).toBe('SELECT old');
    expect(localStorage.getItem('tdb.ws.tabs.v1')).toBeNull();
    expect(localStorage.getItem('tdb.ws.history.v1')).toBeNull();
  });

  it('an unreadable store starts empty (and is replaced on the next save); clear removes everything', async () => {
    invoke.mockImplementationOnce(async () => { throw { code: 'E_WORKSPACE_UNREADABLE', message: 'x' }; });
    await initWorkspace();
    expect(loadTabs()).toEqual([]);
    addHistory({ sql: 'SELECT 9', connName: 'PG', ok: true, mode: 'read' });
    await flushWorkspaceForTests();
    expect(JSON.parse(stored!).history[0].sql).toBe('SELECT 9');
    await clearWorkspace();
    expect(invoke).toHaveBeenCalledWith('workspace_clear', undefined);
    expect(stored).toBeNull();
    expect(getHistory()).toEqual([]);
  });

  it('nothing is saved before the stored document was loaded', async () => {
    addHistory({ sql: 'SELECT early', connName: 'PG', ok: true, mode: 'read' });
    await flushWorkspaceForTests();
    expect(invoke).not.toHaveBeenCalledWith('workspace_save', expect.anything());
  });
});
