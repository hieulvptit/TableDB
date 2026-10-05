import { describe, expect, it } from 'vitest';
import { aggregate, exportText, inList, matches, viewOrder } from './gridModel';
import { readXlsx, toXlsx, unzip, zipStore } from './xlsx';
import { deleteRowSql, insertRowSql, tableDataSql, updateRowSql, upsertStatements } from './tableSql';
import { compareResults } from './resultExtras';
import { diffSchemas, lineDiff, monitorSpec, searchSql } from './DbTools';
import { resolveTable, tableRefsBefore } from './completion';
import { SchemaStore } from './schemaStore';
import { addHistory, clearHistory, flushWorkspaceForTests, getHistory, getSettings, loadTabs, saveSnippet, getSnippets, saveTabs, setSettings, snippetTemplate } from './workspace';
import { callTemplate } from './objects';

describe('grid model', () => {
  const rows = [[3, 'b', null], [1, 'a', 'x'], [2, 'c', 'y'], [10, 'a', null]];
  it('sorts numerically, NULLs last, stable', () => {
    expect(viewOrder(rows, [true, false, false], {}, { col: 0, desc: false })).toEqual([1, 2, 0, 3]);
    expect(viewOrder(rows, [true, false, false], {}, { col: 0, desc: true })).toEqual([3, 0, 2, 1]);
    expect(viewOrder(rows, [true, false, false], {}, { col: 2, desc: false })).toEqual([1, 2, 0, 3]);
    expect(viewOrder(rows, [true, false, false], {}, { col: 1, desc: false })).toEqual([1, 3, 0, 2]);
  });
  it('column filters: substring, null, comparisons, equality, negation', () => {
    expect(viewOrder(rows, [true, false, false], { 1: 'a' }, null)).toEqual([1, 3]);
    expect(viewOrder(rows, [true, false, false], { 2: 'null' }, null)).toEqual([0, 3]);
    expect(viewOrder(rows, [true, false, false], { 0: '>2' }, null)).toEqual([0, 3]);
    expect(matches('abc', '=abc')).toBe(true);
    expect(matches('abc', '!b')).toBe(false);
    expect(matches(null, '!null')).toBe(false);
    expect(matches('5', '<=5')).toBe(true);
  });
  it('aggregates numbers and distinct values', () => {
    const a = aggregate([1, '2.5', null, 'x', 1]);
    expect(a).toMatchObject({ cells: 5, nonNull: 4, numeric: 3, sum: 4.5, min: 1, max: 2.5, distinct: 3 });
    expect(aggregate(['a', 'b']).sum).toBeUndefined();
  });
  it('exports text formats', () => {
    const cols = [{ name: 'id', typeName: 'int4' }, { name: 'name', typeName: 'text' }];
    const data = [[1, "O'Hara"], [2, null]];
    expect(exportText('csv', cols, data)).toBe("id,name\r\n1,O'Hara\r\n2,");
    expect(exportText('tsv', cols, data, { header: false })).toBe("1\tO'Hara\n2\t");
    expect(exportText('markdown', cols, [[1, 'a|b']])).toContain('a\\|b');
    expect(exportText('sql', cols, data, { table: 'public.t', driver: 'postgresql' })).toBe("INSERT INTO public.t (id, name) VALUES (1, 'O''Hara');\nINSERT INTO public.t (id, name) VALUES (2, NULL);");
    expect(JSON.parse(exportText('json', cols, data))).toEqual([{ id: 1, name: "O'Hara" }, { id: 2, name: null }]);
    expect(exportText('html', cols, [[1, '<b>']])).toContain('&lt;b&gt;');
    expect(exportText('csv', cols, [[1, '=cmd()']])).toContain("'=cmd()"); // formula injection neutralised
  });
  it('IN list of distinct literals', () => {
    expect(inList(['a', 'b', 'a', null], 'varchar', 'postgresql')).toBe("'a', 'b', NULL");
  });
});

describe('xlsx', () => {
  it('zip round trip (stored entries)', async () => {
    const enc = new TextEncoder();
    const z = zipStore([{ name: 'a.txt', data: enc.encode('hello') }, { name: 'dir/b.txt', data: enc.encode('wörld') }]);
    const m = await unzip(z);
    expect(new TextDecoder().decode(m.get('a.txt'))).toBe('hello');
    expect(new TextDecoder().decode(m.get('dir/b.txt'))).toBe('wörld');
  });
  it('workbook written by toXlsx reads back', async () => {
    const book = toXlsx(['id', 'tên', 'note'], [[1, 'Nguyễn <A>', null], [2.5, 'x&y', true]], 'Sheet/1');
    const grid = await readXlsx(book);
    expect(grid).toEqual([['id', 'tên', 'note'], ['1', 'Nguyễn <A>', ''], ['2.5', 'x&y', 'true']]);
  });
});

describe('row edit SQL', () => {
  const ref = { schema: 'public', name: 'orders' };
  const cols = [{ name: 'id', typeName: 'int4' }, { name: 'status', typeName: 'text' }, { name: 'amount', typeName: 'numeric' }];
  it('UPDATE/DELETE by primary key, INSERT omits unset columns', () => {
    expect(updateRowSql(ref, 'postgresql', cols, [0], [7, 'NEW', '1'], new Map<number, unknown>([[1, "PAI'D"], [2, '9.5']]))).toBe("UPDATE public.orders SET status = 'PAI''D', amount = 9.5 WHERE id = 7");
    expect(deleteRowSql(ref, 'postgresql', cols, [0, 1], [7, null, null])).toBe('DELETE FROM public.orders WHERE id = 7 AND status IS NULL');
    expect(insertRowSql(ref, 'postgresql', cols, [undefined, 'A', null])).toBe("INSERT INTO public.orders (status, amount) VALUES ('A', NULL)");
    expect(insertRowSql(ref, 'postgresql', cols, [undefined, undefined, undefined])).toBe('INSERT INTO public.orders DEFAULT VALUES');
  });
  it('upsert: ON CONFLICT (PostgreSQL), MERGE (Oracle), none elsewhere', () => {
    const pg = upsertStatements(ref, 'postgresql', cols, ['id'], [[1, 'a', '2']])!;
    expect(pg[0]).toBe("INSERT INTO public.orders (id, status, amount) VALUES\n  (1, 'a', 2)\nON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount");
    const ora = upsertStatements({ schema: 'APP', name: 'T' }, 'oracle', [{ name: 'ID', typeName: 'NUMBER' }, { name: 'V', typeName: 'VARCHAR2' }], ['ID'], [[1, 'x'], [2, 'y']])!;
    expect(ora[0]).toContain('MERGE INTO APP.T d');
    expect(ora[0]).toContain("SELECT 1 AS ID, 'x' AS V FROM DUAL\n  UNION ALL SELECT 2 AS ID, 'y' AS V FROM DUAL");
    expect(ora[0]).toContain('WHEN MATCHED THEN UPDATE SET d.V = s.V');
    expect(upsertStatements(ref, 'trino', cols, ['id'], [[1, 'a', 1]])).toBeNull();
  });
  it('table data view ORDER BY', () => {
    expect(tableDataSql(ref, 'postgresql', 'id > 1', { column: 'Amount', desc: true })).toBe('SELECT * FROM public.orders\nWHERE id > 1\nORDER BY "Amount" DESC');
  });
});

describe('compare & diff', () => {
  it('result sets by key and as multisets', () => {
    const A = { columns: ['id', 'v', 'x'], rows: [[1, 'a', 0], [2, 'b', 0], [3, 'c', 0]] };
    const B = { columns: ['v', 'id'], rows: [['a', 1], ['B', 2], ['d', 4]] };
    const byKey = compareResults(A, B, ['id']);
    expect(byKey.columns).toEqual(['id', 'v']);
    expect(byKey.same).toBe(1);
    expect(byKey.changed.map((c) => c.a[0])).toEqual([2]);
    expect(byKey.onlyA).toEqual([[3, 'c']]);
    expect(byKey.onlyB).toEqual([[4, 'd']]);
    const bag = compareResults({ columns: ['v'], rows: [['a'], ['a'], ['b']] }, { columns: ['v'], rows: [['a'], ['c']] }, []);
    expect(bag).toMatchObject({ same: 1, onlyA: [['a'], ['b']], onlyB: [['c']] });
  });
  it('schemas: tables and columns', () => {
    const mk = (cols: Array<[string, string, boolean?]>, pk: string[] = []) => ({ columns: cols.map(([name, typeName, nn]) => ({ name, typeName, nullable: !nn })), primaryKey: pk, foreignKeys: [] });
    const d = diffSchemas(new Map([['T1', mk([['ID', 'int', true], ['A', 'text']], ['ID'])], ['ONLY_L', mk([])], ['SAME', mk([['X', 'int']])]]),
      new Map([['t1', mk([['id', 'int', true], ['A', 'varchar'], ['B', 'int']], [])], ['ONLY_R', mk([])], ['same', mk([['x', 'int']])]]));
    expect(d.map((x) => [x.name, x.status])).toEqual([['T1', 'changed'], ['ONLY_L', 'onlyLeft'], ['ONLY_R', 'onlyRight'], ['SAME', 'same']]);
    expect(d[0]!.columns.map((c) => [c.name, c.change])).toEqual([['A', 'changed'], ['B', 'added']]);
    expect(d[0]!.pk).toEqual({ left: 'ID', right: '' });
  });
  it('line diff', () => {
    expect(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']).map((l) => `${l.op}${l.text}`)).toEqual([' a', '-b', '+x', ' c']);
  });
});

describe('tool SQL', () => {
  it('global search escapes LIKE wildcards and quotes', () => {
    const s = searchSql('postgresql', 'columns', "o'_x%", 'public', null)!;
    expect(s).toContain("ILIKE '%o''\\_x\\%%'");
    expect(s).toContain("table_schema = 'public'");
    expect(searchSql('oracle', 'tables', 'ord', null, null)).toMatch(/ROWNUM <= 500/);
    expect(searchSql('trino', 'tables', 'ord', null, null)).toBeNull(); // Trino needs a catalog
    expect(searchSql('trino', 'tables', 'ord', null, 'hive')).toContain('"hive".information_schema.tables');
  });
  it('monitor kill statements only from validated ids', () => {
    const pg = monitorSpec('postgresql')!;
    expect(pg.kill![1]!.sql([123], ['pid'])).toBe('SELECT pg_terminate_backend(123)');
    expect(pg.kill![0]!.sql(['1; DROP'], ['pid'])).toBeNull();
    const ora = monitorSpec('oracle')!;
    expect(ora.kill![0]!.sql([12, 345], ['SID', 'SERIAL#'])).toBe("ALTER SYSTEM KILL SESSION '12,345' IMMEDIATE");
    const tr = monitorSpec('trino')!;
    expect(tr.kill![0]!.sql(["x'); DROP"], ['query_id'])).toBeNull();
  });
  it('call templates', () => {
    expect(callTemplate('oracle', 'APP', { name: 'P', kind: 'procedures' })).toBe('BEGIN\n  APP.P(/* args */);\nEND;');
    expect(callTemplate('postgresql', 'public', { name: 'f(integer)', kind: 'functions' })).toBe('SELECT public.f(/* args */)');
  });
});

describe('completion helpers', () => {
  it('FROM / JOIN references with aliases', () => {
    expect(tableRefsBefore('SELECT * FROM public.orders o JOIN "Cust" AS c ON ')).toEqual([{ parts: ['public', 'orders'], alias: 'o' }, { parts: ['Cust'], alias: 'c' }]);
    expect(tableRefsBefore('SELECT * FROM t WHERE')).toEqual([{ parts: ['t'], alias: null }]);
  });
  it('resolves names against loaded tables (case-insensitive, default schema first)', async () => {
    const api = { tables: async (s: string) => (s === 'a' ? [{ name: 'Orders', type: 'TABLE' }] : [{ name: 'orders', type: 'TABLE' }]) };
    const st = new SchemaStore(api as never);
    await st.loadTables(undefined, 'a');
    await st.loadTables(undefined, 'b');
    expect(resolveTable(st, ['ORDERS'], 'b')).toEqual({ schema: 'b', name: 'orders' });
    expect(resolveTable(st, ['a', 'orders'], 'b')).toEqual({ schema: 'a', name: 'Orders' });
    expect(resolveTable(st, ['nope'], null)).toBeNull();
  });
});

describe('workspace storage', () => {
  it('history: newest first, de-duplicated, can be switched off and cleared', () => {
    addHistory({ sql: 'SELECT 1', connName: 'PG', ok: true, mode: 'read' });
    addHistory({ sql: 'SELECT 2', connName: 'PG', ok: false, mode: 'read', errorCode: 'E_SQL' });
    addHistory({ sql: 'SELECT 1', connName: 'PG', ok: true, mode: 'read' });
    expect(getHistory().map((h) => h.sql)).toEqual(['SELECT 1', 'SELECT 2']);
    setSettings({ recordHistory: false });
    addHistory({ sql: 'SELECT 3', connName: 'PG', ok: true, mode: 'read' });
    expect(getHistory()).toHaveLength(2);
    clearHistory();
    expect(getHistory()).toEqual([]);
  });
  it('tabs persist (debounced) and are dropped when switched off', async () => {
    expect(getSettings().persistTabs).toBe(true);
    saveTabs([{ title: 'Q', sql: 'SELECT 1', maxRows: 5, timeoutSec: 9, profileId: 'p1' }]);
    await flushWorkspaceForTests();
    expect(loadTabs()).toEqual([{ title: 'Q', sql: 'SELECT 1', maxRows: 5, timeoutSec: 9, profileId: 'p1' }]);
    expect(JSON.parse(localStorage.getItem('tdb.ws.v1')!).tabs).toHaveLength(1); // outside the desktop shell: localStorage
    setSettings({ persistTabs: false });
    expect(loadTabs()).toEqual([]);
    await flushWorkspaceForTests();
    expect(JSON.parse(localStorage.getItem('tdb.ws.v1')!).tabs).toEqual([]);
  });
  it('snippets: builtin + saved, ${x} fields become CodeMirror fields', () => {
    expect(getSnippets().some((s) => s.name === 'sel')).toBe(true);
    saveSnippet({ id: 'm1', name: 'mine', sql: 'SELECT ${a} FROM t' });
    expect(getSnippets().find((s) => s.id === 'm1')?.sql).toBe('SELECT ${a} FROM t');
    expect(snippetTemplate('SELECT ${a}, ${b}')).toBe('SELECT #{a}, #{b}');
  });
});
