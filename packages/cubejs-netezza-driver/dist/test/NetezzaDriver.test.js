"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schema_compiler_1 = require("@cubejs-backend/schema-compiler");
const NetezzaDriver_1 = require("../src/NetezzaDriver");
const errors_1 = require("../src/errors");
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
    it('does not emit PostgreSQL null-safe comparison for multi-fact merges', () => {
        const query = Object.create(NetezzaQuery_1.NetezzaQuery.prototype);
        expect(query.sqlTemplates().operators.is_not_distinct_from).toBeUndefined();
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
    it('uses LOWER and LIKE instead of unsupported ILIKE for text filters', () => {
        const query = Object.create(NetezzaQuery_1.NetezzaQuery.prototype);
        const filter = query.newFilter({
            dimension: 'td_participante.nm_participante',
            operator: 'contains',
            values: ['Rafael'],
        });
        filter.allocateParam = () => '?';
        expect(filter.likeIgnoreCase('"NM_PARTICIPANTE"', false, 'Rafael', 'contains'))
            .toBe("LOWER(\"NM_PARTICIPANTE\") LIKE '%' || LOWER(?) || '%'");
    });
    it('uses the compatible LIKE templates for native planning', () => {
        const templates = Object.create(NetezzaQuery_1.NetezzaQuery.prototype).sqlTemplates();
        expect(templates.expressions.ilike).toContain('LIKE');
        expect(templates.expressions.ilike).not.toContain('ILIKE');
        expect(templates.tesseract.ilike).toContain('LIKE');
        expect(templates.tesseract.ilike).not.toContain('ILIKE');
    });
    it('serializes ODBC bigint results without losing precision', () => {
        expect((0, NetezzaDriver_1.normalizeNetezzaResultRow)({
            count: 9007199254740993n,
            nested: { value: 12n },
            values: [1n, 'texto'],
        })).toEqual({
            count: '9007199254740993',
            nested: { value: '12' },
            values: ['1', 'texto'],
        });
    });
    it('inlines escaped parameters for Netezza ODBC execution', () => {
        expect((0, NetezzaDriver_1.interpolateNetezzaParameters)("SELECT ? AS number, ? AS text, ? AS timestamp, '?' AS literal, \"?\" AS identifier -- ?\n/* ? */", [42, "O'Hara", '2026-08-20T23:59:59.999Z'])).toBe("SELECT 42 AS number, 'O''Hara' AS text, '2026-08-20 23:59:59.999' AS timestamp, '?' AS literal, \"?\" AS identifier -- ?\n/* ? */");
    });
    it('rejects a mismatch between Netezza markers and supplied parameters', () => {
        expect(() => (0, NetezzaDriver_1.interpolateNetezzaParameters)('SELECT ?', [])).toThrow('more parameter markers');
        expect(() => (0, NetezzaDriver_1.interpolateNetezzaParameters)('SELECT 1', ['unused'])).toThrow('more supplied values');
    });
    it('includes Netezza ODBC diagnostics in execution errors', () => {
        expect((0, errors_1.odbcDiagnostics)(Object.assign(new Error('failed'), {
            odbcErrors: [{ state: '42883', code: 1100, message: 'function does not exist' }],
        }))).toBe(' (42883: 1100: function does not exist)');
    });
});
//# sourceMappingURL=NetezzaDriver.test.js.map