import { describe, expect, it } from 'vitest';
import { buildCustomRequest, customName, dialectOf, emptyCustomForm, endpointOf, formatEndpoint, parseEndpoint, validateCustomForm, validateProps, type CustomForm } from './custom';

describe('parseEndpoint (quick paste)', () => {
  it('host:port/service -> serviceName', () => {
    expect(parseEndpoint('ora.internal:1521/BISVC')).toEqual({ host: 'ora.internal', port: 1521, database: 'BISVC', connectType: 'serviceName' });
    expect(parseEndpoint('//10.1.2.3:1522/BI.SVC')).toEqual({ host: '10.1.2.3', port: 1522, database: 'BI.SVC', connectType: 'serviceName' });
  });
  it('host:port:SID -> sid', () => {
    expect(parseEndpoint('db1:1521:ORCL')).toEqual({ host: 'db1', port: 1521, database: 'ORCL', connectType: 'sid' });
  });
  it('host, host:port, host/service, jdbc prefix, IPv6', () => {
    expect(parseEndpoint('db1')).toEqual({ host: 'db1' });
    expect(parseEndpoint('db1:1521')).toEqual({ host: 'db1', port: 1521 });
    expect(parseEndpoint('db1/SVC')).toEqual({ host: 'db1', database: 'SVC', connectType: 'serviceName' });
    expect(parseEndpoint('jdbc:oracle:thin:@//h:1521/S')).toEqual({ host: 'h', port: 1521, database: 'S', connectType: 'serviceName' });
    expect(parseEndpoint('jdbc:oracle:thin:@tcps://h:2484/S')).toMatchObject({ host: 'h', port: 2484 });
    expect(parseEndpoint('[::1]:1521/S')).toEqual({ host: '[::1]', port: 1521, database: 'S', connectType: 'serviceName' });
  });
  it('rejects garbage and bad ports', () => {
    for (const bad of ['', '  ', 'h:99999/S', 'h:0/S', 'h;x:1521/S', 'a b', 'h:1521/S/extra', 'h?x=1:1521']) expect(parseEndpoint(bad)).toBeNull();
  });
});

describe('validateProps', () => {
  it('accepts normal properties and ignores blank rows', () => {
    const r = validateProps([{ key: 'oracle.net.CONNECT_TIMEOUT', value: '5000' }, { key: '', value: '' }, { key: 'defaultRowPrefetch', value: '50' }]);
    expect(r.issues).toEqual([]);
    expect(r.props).toEqual({ 'oracle.net.CONNECT_TIMEOUT': '5000', defaultRowPrefetch: '50' });
  });
  it('flags bad keys, denied keys, duplicates, long values and the 20 cap', () => {
    const r = validateProps([
      { key: '1bad', value: 'x' }, { key: 'User', value: 'x' }, { key: 'PASSWORD', value: 'x' }, { key: 'javax.net.ssl.trustStore', value: 'x' }, { key: 'java.home', value: 'x' },
      { key: 'a', value: 'x' }, { key: 'A', value: 'y' }, { key: 'b', value: 'x'.repeat(257) },
    ]);
    expect(r.issues.map((i) => i.issue)).toEqual(['key', 'denied', 'denied', 'denied', 'denied', 'duplicate', 'value']);
    const many = Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    expect(validateProps(many).issues).toEqual([{ row: 20, issue: 'count' }]);
  });
});

const form = (o: Partial<CustomForm> = {}): CustomForm => ({ ...emptyCustomForm(), driver: 'oracle', port: '1521', host: 'ora.internal', database: 'BISVC', username: 'scott', password: 'tiger', ...o });

describe('validateCustomForm', () => {
  it('valid oracle form', () => expect(validateCustomForm(form())).toEqual([]));
  it('reports each problem', () => {
    expect(validateCustomForm(form({ host: 'a/b', port: '0', database: '', username: ' ', connectTimeoutSec: '999' })).sort()).toEqual(['database', 'host', 'port', 'timeout', 'username']);
    expect(validateCustomForm(form({ driver: 'custom' }))).toEqual(['driverId']);
    expect(validateCustomForm(form({ props: [{ key: 'user', value: 'x' }] }))).toEqual(['props']);
  });
  it('database is optional for non-oracle drivers', () => expect(validateCustomForm(form({ driver: 'postgresql', database: '' }))).toEqual([]));
});

describe('buildCustomRequest', () => {
  it('oracle serviceName / sid, secrets only inside auth', () => {
    const r = buildCustomRequest(form({ ssl: true, props: [{ key: 'defaultRowPrefetch', value: '50' }] }), false);
    expect(r).toEqual({
      profile: { driver: 'oracle', host: 'ora.internal', port: 1521, database: 'BISVC', options: { connectType: 'serviceName', ssl: true, readOnly: true, allowWrite: false, connectTimeoutSec: 15, props: { defaultRowPrefetch: '50' } } },
      auth: { type: 'password', username: 'scott', password: 'tiger' }, schema: undefined,
    });
    expect(buildCustomRequest(form({ connectType: 'sid' }), false).profile.options?.connectType).toBe('sid');
    expect(JSON.stringify(r.profile)).not.toContain('tiger');
  });
  it('write needs BOTH db:write and the checkbox', () => {
    expect(buildCustomRequest(form({ allowWrite: true }), false).profile.options?.allowWrite).toBe(false);
    expect(buildCustomRequest(form({ allowWrite: false }), true).profile.options?.allowWrite).toBe(false);
    expect(buildCustomRequest(form({ allowWrite: true }), true).profile.options?.allowWrite).toBe(true);
  });
  it('custom driver carries driverId; connectType only for oracle', () => {
    const p = buildCustomRequest(form({ driver: 'custom', driverId: 'mysql8', port: '3306', database: 'shop' }), false).profile;
    expect(p).toMatchObject({ driver: 'custom', driverId: 'mysql8', port: 3306, database: 'shop' });
    expect(p.options).not.toHaveProperty('connectType');
    expect(p.options).not.toHaveProperty('props');
  });
  it('audit endpoint + display name + dialect', () => {
    expect(endpointOf(form({ connectType: 'sid' }), true)).toEqual({ driver: 'oracle', host: 'ora.internal', port: 1521, database: 'BISVC', connectType: 'sid', allowWrite: false });
    expect(customName(form())).toBe('scott@ora.internal:1521/BISVC');
    expect(dialectOf('custom')).toBe('postgresql');
    expect(dialectOf('oracle')).toBe('oracle');
  });
});

describe('parseEndpoint / formatEndpoint per driver', () => {
  it('postgresql', () => {
    expect(parseEndpoint('pg:5432/mydb', 'postgresql')).toEqual({ host: 'pg', port: 5432, database: 'mydb' });
    expect(parseEndpoint('jdbc:postgresql://pg:5432/mydb?ssl=true', 'postgresql')).toEqual({ host: 'pg', port: 5432, database: 'mydb' });
    expect(parseEndpoint('postgres://u:p@pg/mydb', 'postgresql')).toEqual({ host: 'pg', database: 'mydb' });
  });
  it('trino', () => {
    expect(parseEndpoint('t:8080/hive/default', 'trino')).toEqual({ host: 't', port: 8080, database: 'hive', schema: 'default' });
    expect(parseEndpoint('jdbc:trino://t:8080/hive', 'trino')).toEqual({ host: 't', port: 8080, database: 'hive' });
  });
  it('uses HTTP scheme defaults and keeps explicit ports', () => {
    expect(parseEndpoint('https://query-engine-staging.vnpayapi.vn', 'trino')).toEqual({ host: 'query-engine-staging.vnpayapi.vn', port: 443, ssl: true });
    expect(parseEndpoint('https://t:8443/hive/default', 'trino')).toEqual({ host: 't', port: 8443, ssl: true, database: 'hive', schema: 'default' });
    expect(parseEndpoint('http://t/hive', 'trino')).toEqual({ host: 't', port: 80, ssl: false, database: 'hive' });
    expect(parseEndpoint('t:8080', 'trino')).toEqual({ host: 't', port: 8080 });
  });
  it('formats per driver', () => {
    const base = { host: 'h', port: '1521', database: 'X', connectType: 'serviceName' as const, schema: 'S' };
    expect(formatEndpoint({ ...base, driver: 'oracle' })).toBe('h:1521/X');
    expect(formatEndpoint({ ...base, driver: 'oracle', connectType: 'sid' })).toBe('h:1521:X');
    expect(formatEndpoint({ ...base, driver: 'postgresql' })).toBe('h:1521/X');
    expect(formatEndpoint({ ...base, driver: 'trino' })).toBe('h:1521/X/S');
  });
});

describe('Trino SSO (custom)', () => {
  const base = { ...emptyCustomForm(), driver: 'trino' as const, host: 'h', port: '8080', sso: true };
  it('needs no username and sends trino-external', () => {
    expect(validateCustomForm(base)).toEqual([]);
    const r = buildCustomRequest(base, false);
    expect(r.auth).toEqual({ type: 'trino-external' });
    expect(r.profile.options?.externalAuthTimeoutSec).toBe(180);
    expect(buildCustomRequest({ ...base, ssl: false }, false).profile.options?.ssl).toBe(true);
  });
  it('is ignored for other drivers', () => {
    const pg = { ...base, driver: 'postgresql' as const };
    expect(validateCustomForm(pg)).toContain('username');
    expect(buildCustomRequest({ ...pg, username: 'u' }, false).auth.type).toBe('password');
  });
});
