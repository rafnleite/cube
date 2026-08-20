"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schema_compiler_1 = require("@cubejs-backend/schema-compiler");
const NetezzaDriver_1 = require("../src/NetezzaDriver");
const NetezzaQuery_1 = require("../src/NetezzaQuery");
describe('NetezzaDriver', () => {
    it('builds an escaped ODBC connection string from conventional fields', () => {
        expect((0, NetezzaDriver_1.buildNetezzaConnectionString)({
            host: 'netezza.internal',
            port: 5480,
            database: 'warehouse',
            schema: 'analytics',
            user: 'cube',
            password: 'pass',
        })).toBe('DRIVER={NetezzaSQL};SERVERNAME=netezza.internal;PORT=5480;DATABASE=warehouse;SECURITYLEVEL=preferredUnSecured;UNICODETRANSLATIONOPTION=utf16;CHARACTERTRANSLATIONOPTION=all;SCHEMA=analytics;USERNAME=cube;PASSWORD=pass');
        expect((0, NetezzaDriver_1.escapeOdbcConnectionValue)('a}b')).toBe('{a}}b}');
    });
    it('keeps a supplied connection string untouched', () => {
        expect((0, NetezzaDriver_1.buildNetezzaConnectionString)({
            connectionString: 'DSN=warehouse;UID=cube;PWD=secret',
        })).toBe('DSN=warehouse;UID=cube;PWD=secret');
    });
    it('uses ODBC markers and Netezza physical types', async () => {
        const driver = new NetezzaDriver_1.NetezzaDriver({ connectionString: 'DSN=warehouse' });
        expect(driver.param(0)).toBe('?');
        expect(driver.fromGenericType('string')).toBe('VARCHAR(64000)');
        expect(driver.fromGenericType('double')).toBe('DOUBLE PRECISION');
        await driver.release();
    });
    it('does not reuse ODBC parameter positions in the Netezza dialect', () => {
        const query = Object.create(NetezzaQuery_1.NetezzaQuery.prototype);
        const allocator = query.newParamAllocator(['first', 'second']);
        expect(allocator).toBeInstanceOf(schema_compiler_1.ParamAllocator);
        expect(allocator.buildSqlAndParams('$0$ = $0$', false, query.shouldReuseParams)).toEqual([
            '? = ?',
            ['first', 'first'],
        ]);
    });
});
//# sourceMappingURL=NetezzaDriver.test.js.map