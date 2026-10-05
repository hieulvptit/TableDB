import { describe, expect, it } from 'vitest';
import { findCrossDatabase as f } from './crossDb';

const dbs = ['appdb', 'billing', 'sales'];
const schemas = ['public', 'callcfg', 'hr'];

describe('findCrossDatabase', () => {
  it('allows every schema of the bound database, unqualified names and aliases', () => {
    expect(f('SELECT * FROM public.a JOIN callcfg.b ON a.id = b.id', 'appdb', dbs, schemas)).toBeNull();
    expect(f('SELECT * FROM appdb.callcfg.b', 'appdb', dbs, schemas)).toBeNull();
    expect(f('SELECT e.name FROM emp e', 'appdb', dbs, schemas)).toBeNull();
    expect(f("SELECT 'billing.x' FROM emp -- billing.y", 'appdb', dbs, schemas)).toBeNull();
    expect(f('SET search_path TO callcfg', 'appdb', dbs, schemas)).toBeNull();
  });
  it('rejects names qualified with another database', () => {
    expect(f('SELECT * FROM billing.public.invoice', 'appdb', dbs, schemas)).toBe('billing');
    expect(f('SELECT * FROM public.a JOIN "SALES"."hr"."orders" o ON 1=1', 'appdb', dbs, schemas)).toBe('SALES');
  });
  it('reads a name that is also a local schema as the schema', () => {
    expect(f('SELECT * FROM hr.emp', 'appdb', [...dbs, 'hr'], schemas)).toBeNull();
  });
  it('rejects switching the session to another database', () => {
    expect(f('USE billing', 'appdb', dbs, schemas)).toBe('billing');
    expect(f('USE appdb;', 'appdb', dbs, schemas)).toBeNull();
    expect(f('USE callcfg', 'appdb', dbs, schemas)).toBeNull();
  });
  it('does nothing without a bound database or other databases', () => {
    expect(f('SELECT * FROM billing.public.x', null, dbs)).toBeNull();
    expect(f('SELECT * FROM x.y.z', 'appdb', ['appdb'], schemas)).toBeNull();
  });
});
