import { describe, expect, it } from 'vitest';
import { errorOffset, findBinds, splitStatements, statementAt } from './sqlSplit';

const texts = (sql: string, d?: Parameters<typeof splitStatements>[1]) => splitStatements(sql, d).map((s) => s.text);

describe('splitStatements', () => {
  it('splits on top-level semicolons, ignoring strings, comments and quoted names', () => {
    expect(texts("SELECT 'a;b' FROM t; -- x;y\nSELECT \"c;d\" FROM u;\n/* ; */ SELECT 3")).toEqual([
      "SELECT 'a;b' FROM t", 'SELECT "c;d" FROM u', 'SELECT 3',
    ]);
  });
  it('keeps comment lines written right above a statement', () => {
    expect(texts('SELECT 1;\n\n-- total\nSELECT 2')).toEqual(['SELECT 1', '-- total\nSELECT 2']);
  });
  it('blank line before a statement keyword separates statements (smart mode)', () => {
    expect(texts('SELECT 1 FROM a\n\nSELECT 2 FROM b')).toEqual(['SELECT 1 FROM a', 'SELECT 2 FROM b']);
    // ...but not when the previous line continues or inside parentheses
    expect(texts('SELECT 1 FROM a\nUNION ALL\n\nSELECT 2 FROM b')).toHaveLength(1);
    expect(texts('WITH x AS (\n\nSELECT 1)\nSELECT * FROM x')).toHaveLength(1);
    expect(texts('SELECT a,\n\n b FROM t')).toHaveLength(1);
  });
  it('PostgreSQL dollar quotes and BEGIN as a transaction statement', () => {
    expect(texts('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\nSELECT f()', 'postgresql')).toEqual([
      'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql', 'SELECT f()',
    ]);
    expect(texts('BEGIN;\nUPDATE t SET a = 1;\nCOMMIT;', 'postgresql')).toEqual(['BEGIN', 'UPDATE t SET a = 1', 'COMMIT']);
  });
  it('Oracle anonymous blocks and stored units stay whole, with END;', () => {
    const sql = "BEGIN\n  UPDATE t SET a = 1;\n  IF x THEN NULL; END IF;\nEND;\nSELECT 1 FROM dual;\nCREATE OR REPLACE PROCEDURE p IS\n  v NUMBER;\nBEGIN\n  v := 1;\n  FOR r IN (SELECT 1 FROM dual) LOOP NULL; END LOOP;\nEND p;\nSELECT 2 FROM dual";
    expect(texts(sql, 'oracle')).toEqual([
      'BEGIN\n  UPDATE t SET a = 1;\n  IF x THEN NULL; END IF;\nEND;',
      'SELECT 1 FROM dual',
      'CREATE OR REPLACE PROCEDURE p IS\n  v NUMBER;\nBEGIN\n  v := 1;\n  FOR r IN (SELECT 1 FROM dual) LOOP NULL; END LOOP;\nEND p;',
      'SELECT 2 FROM dual',
    ]);
  });
  it('Oracle package spec/body and the SQL*Plus slash terminator', () => {
    const sql = 'CREATE PACKAGE pk AS\n  PROCEDURE a;\n  FUNCTION b RETURN NUMBER;\nEND pk;\n/\nCREATE PACKAGE BODY pk AS\n  PROCEDURE a IS BEGIN NULL; END;\n  FUNCTION b RETURN NUMBER IS BEGIN RETURN CASE WHEN 1=1 THEN 1 END; END;\nEND pk;\n/\nSELECT 1 FROM dual';
    const out = texts(sql, 'oracle');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^CREATE PACKAGE pk AS[\s\S]*END pk;$/);
    expect(out[1]).toMatch(/^CREATE PACKAGE BODY pk AS[\s\S]*END pk;$/);
    expect(out[2]).toBe('SELECT 1 FROM dual');
  });
  it('a slash line ends an unterminated block', () => {
    expect(texts('DECLARE\n v NUMBER;\nBEGIN\n v := 1;\nEND\n/\nSELECT 1 FROM dual', 'oracle')).toEqual(['DECLARE\n v NUMBER;\nBEGIN\n v := 1;\nEND', 'SELECT 1 FROM dual']);
  });
  it('offsets point into the buffer', () => {
    const sql = '  SELECT 1;\n\nSELECT 2 ;';
    const st = splitStatements(sql);
    expect(st.map((s) => sql.slice(s.from, s.to))).toEqual(['SELECT 1', 'SELECT 2']);
    expect(statementAt(st, 0)?.text).toBe('SELECT 1');
    expect(statementAt(st, sql.indexOf('2'))?.text).toBe('SELECT 2');
    expect(statementAt(st, sql.length)?.text).toBe('SELECT 2');
    expect(statementAt(st, sql.indexOf('\n\n') + 1)?.text).toBe('SELECT 1');
    expect(splitStatements('  -- only a comment\n')).toEqual([]);
  });
});

describe('findBinds', () => {
  it('replaces :name outside strings and comments', () => {
    expect(findBinds("SELECT * FROM t WHERE a = :id AND b IN (:x, :id) AND c = ':no' -- :no")).toEqual({
      sql: "SELECT * FROM t WHERE a = ? AND b IN (?, ?) AND c = ':no' -- :no", names: ['id', 'x', 'id'],
    });
  });
  it('ignores casts, assignments and slices', () => {
    expect(findBinds('SELECT a::int, b[1:2], c[x:y] FROM t').names).toEqual([]);
    expect(findBinds('BEGIN v := 1; END;').names).toEqual([]);
    expect(findBinds('SELECT :a+:b, x:y').names).toEqual(['a', 'b']);
  });
});

describe('errorOffset', () => {
  it('PostgreSQL Position and line/column styles', () => {
    expect(errorOffset('ERROR: column "x" does not exist\n  Position: 8', 'SELECT x FROM t')).toBe(7);
    expect(errorOffset("line 2:3: Column 'z' cannot be resolved", 'SELECT 1\nFROM zz')).toBe(11);
    expect(errorOffset('ORA-00942: table or view does not exist', 'SELECT 1')).toBeNull();
  });
});
