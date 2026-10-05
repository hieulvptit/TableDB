import { describe, expect, it, vi } from 'vitest';
import { csvCell, toCsv } from './csv';
import { SchemaStore } from './schemaStore';
import { quoteIdent, selectStarSql } from './SchemaTree';
import type { DbApi } from '../../gateway';

describe('csv export', () => {
  it('quotes commas/quotes/newlines and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell({ $binary: 'AAAA', length: 3 })).toContain('binary 3 B');
  });
  it('builds header + rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [[1, 'x'], [null, 'y']])).toBe('a,b\r\n1,x\r\n,y');
  });
});

describe('SchemaStore', () => {
  const mk = () => {
    const api = {
      catalogs: vi.fn(async () => []), schemas: vi.fn(async () => ['public']),
      tables: vi.fn(async () => [{ name: 'orders', type: 'TABLE' }, { name: 'v1', type: 'VIEW' }]),
      columns: vi.fn(async () => ({ columns: [{ name: 'id', typeName: 'int4' }], primaryKey: ['id'], foreignKeys: [] })),
    } as unknown as DbApi;
    return { api, store: new SchemaStore(api) };
  };
  it('autocomplete namespace is built only from loaded metadata (empty at first)', async () => {
    const { store } = mk();
    expect(store.sqlNamespace()).toEqual({});
    await store.loadTables(undefined, 'public');
    expect(store.sqlNamespace()).toEqual({ public: { orders: [], v1: [] } });
    await store.loadColumns({ schema: 'public', name: 'orders' });
    expect(store.sqlNamespace()).toEqual({ public: { orders: ['id'], v1: [] } });
  });
  it('is lazy and caches: repeated loads hit the API once', async () => {
    const { api, store } = mk();
    await store.loadTables(undefined, 'public'); await store.loadTables(undefined, 'public');
    expect((api.tables as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((api.columns as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
  it('accessibleMetas only lists tables whose columns were loaded', async () => {
    const { store } = mk();
    await store.loadTables(undefined, 'public');
    expect(store.accessibleMetas()).toEqual([]);
    await store.loadColumns({ schema: 'public', name: 'orders' });
    expect(store.accessibleMetas().map((m) => m.name)).toEqual(['orders']);
  });
  it('records errors instead of throwing', async () => {
    const api = { tables: vi.fn(async () => { throw new Error('denied'); }) } as unknown as DbApi;
    const s = new SchemaStore(api);
    await s.loadTables(undefined, 'x');
    expect(s.tables(undefined, 'x')).toMatchObject({ status: 'error', error: 'denied' });
  });
});

describe('SQL helpers', () => {
  it('quotes identifiers per dialect', () => {
    expect(quoteIdent('orders', 'postgresql')).toBe('orders');
    expect(quoteIdent('Orders', 'postgresql')).toBe('"Orders"');
    expect(quoteIdent('ORDERS', 'oracle')).toBe('ORDERS');
    expect(quoteIdent('my table', 'oracle')).toBe('"my table"');
    expect(selectStarSql({ schema: 'public', name: 'orders' }, 'postgresql')).toBe('SELECT * FROM public.orders\nLIMIT 100');
    expect(selectStarSql({ schema: 'HR', name: 'EMP' }, 'oracle')).toContain('FETCH FIRST 100 ROWS ONLY');
  });
});
