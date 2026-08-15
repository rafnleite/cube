import { ParamAllocator } from '@cubejs-backend/schema-compiler';
import {
  buildNetezzaConnectionString,
  escapeOdbcConnectionValue,
  NetezzaDriver,
} from '../src/NetezzaDriver';
import { NetezzaQuery } from '../src/NetezzaQuery';

describe('NetezzaDriver', () => {
  it('builds an escaped ODBC connection string from conventional fields', () => {
    expect(buildNetezzaConnectionString({
      host: 'netezza.internal',
      port: 5480,
      database: 'warehouse',
      schema: 'analytics',
      user: 'cube',
      password: 'p;ass}',
    })).toBe('DRIVER={NetezzaSQL};SERVER={netezza.internal};PORT={5480};DATABASE={warehouse};SCHEMA={analytics};UID={cube};PWD={p;ass}}}');
    expect(escapeOdbcConnectionValue('a}b')).toBe('{a}}b}');
  });

  it('keeps a supplied connection string untouched', () => {
    expect(buildNetezzaConnectionString({
      connectionString: 'DSN=warehouse;UID=cube;PWD=secret',
    })).toBe('DSN=warehouse;UID=cube;PWD=secret');
  });

  it('uses ODBC markers and Netezza physical types', async () => {
    const driver = new NetezzaDriver({ connectionString: 'DSN=warehouse' });
    expect(driver.param(0)).toBe('?');
    expect(driver.fromGenericType('string')).toBe('VARCHAR(64000)');
    expect(driver.fromGenericType('double')).toBe('DOUBLE PRECISION');
    await driver.release();
  });

  it('does not reuse ODBC parameter positions in the Netezza dialect', () => {
    const query = Object.create(NetezzaQuery.prototype) as NetezzaQuery;
    const allocator = query.newParamAllocator(['first', 'second']);
    expect(allocator).toBeInstanceOf(ParamAllocator);
    expect(allocator.buildSqlAndParams('$0$ = $0$', false, query.shouldReuseParams)).toEqual([
      '? = ?',
      ['first', 'first'],
    ]);
  });
});
