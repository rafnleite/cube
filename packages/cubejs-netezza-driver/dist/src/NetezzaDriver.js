"use strict";
/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview IBM Netezza driver implemented through its vendor ODBC driver.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetezzaDriver = exports.buildNetezzaConnectionString = exports.escapeOdbcConnectionValue = exports.interpolateNetezzaParameters = exports.normalizeNetezzaResultRow = exports.normalizeNetezzaResultValue = void 0;
const stream_1 = require("stream");
const odbc = require("odbc");
const shared_1 = require("@cubejs-backend/shared");
const base_driver_1 = require("@cubejs-backend/base-driver");
const errors_1 = require("./errors");
const NetezzaQuery_1 = require("./NetezzaQuery");
const IGNORED_SCHEMAS = new Set([
    'DEFINITION_SCHEMA',
    'INFORMATION_SCHEMA',
    'PG_CATALOG',
    'SYSTEM',
]);
const GenericTypeToNetezza = {
    string: 'VARCHAR(64000)',
    text: 'VARCHAR(64000)',
    double: 'DOUBLE PRECISION',
    float: 'REAL',
    int: 'INTEGER',
    bigint: 'BIGINT',
    decimal: 'NUMERIC',
    boolean: 'BOOLEAN',
    date: 'DATE',
    timestamp: 'TIMESTAMP',
    time: 'TIME',
    binary: 'VARBINARY(64000)',
};
const NetezzaToGenericType = {
    bool: 'boolean',
    boolean: 'boolean',
    byteint: 'int',
    int1: 'int',
    int2: 'int',
    int4: 'int',
    int8: 'int',
    int16: 'int',
    int32: 'int',
    smallint: 'int',
    integer: 'int',
    int: 'int',
    int64: 'bigint',
    bigint: 'bigint',
    decimal: 'decimal',
    numeric: 'decimal',
    real: 'float',
    float: 'float',
    float4: 'float',
    double: 'double',
    'double precision': 'double',
    float8: 'double',
    date: 'date',
    timestamp: 'timestamp',
    datetime: 'timestamp',
    time: 'string',
    timetz: 'string',
    interval: 'string',
    char: 'text',
    character: 'text',
    varchar: 'text',
    'character varying': 'text',
    nchar: 'text',
    nvarchar: 'text',
    varbinary: 'binary',
    binary: 'binary',
};
/**
 * node-odbc returns Netezza INTEGER8/NUMERIC values as JavaScript bigint.
 * JSON.stringify rejects bigint and casting it to number loses precision.
 * Cube can safely transport measures as strings, so normalize at the driver
 * boundary while preserving the exact value.
 */
function normalizeNetezzaResultValue(value) {
    if (typeof value === 'bigint')
        return value.toString();
    if (Array.isArray(value))
        return value.map(normalizeNetezzaResultValue);
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            normalizeNetezzaResultValue(item),
        ]));
    }
    return value;
}
exports.normalizeNetezzaResultValue = normalizeNetezzaResultValue;
function normalizeNetezzaResultRow(row) {
    return normalizeNetezzaResultValue(row);
}
exports.normalizeNetezzaResultRow = normalizeNetezzaResultRow;
function netezzaSqlLiteral(value) {
    if (value === null || value === undefined)
        return 'NULL';
    if (typeof value === 'bigint')
        return value.toString();
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new errors_1.NetezzaError('Netezza cannot interpolate a non-finite numeric query parameter.');
        return String(value);
    }
    if (typeof value === 'boolean')
        return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime()))
            throw new errors_1.NetezzaError('Netezza cannot interpolate an invalid Date query parameter.');
        return `'${value.toISOString().replace('T', ' ').replace(/Z$/, '')}'`;
    }
    if (Buffer.isBuffer(value))
        return `X'${value.toString('hex')}'`;
    if (typeof value !== 'string')
        throw new errors_1.NetezzaError(`Netezza cannot interpolate query parameter of type ${typeof value}.`);
    // Cube supplies ISO dates in UTC. Netezza TIMESTAMP has no time-zone component.
    const text = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(value)
        ? value.replace('T', ' ').replace(/Z$/, '')
        : value;
    return `'${text.replace(/'/g, "''")}'`;
}
/**
 * Netezza's vendor ODBC driver rejects bound parameter markers for otherwise
 * valid statements in some versions. Cube still compiles with `?` markers, so
 * substitute their escaped literals immediately before sending the statement.
 * Markers inside SQL strings, identifiers, and comments are deliberately left
 * untouched.
 */
function interpolateNetezzaParameters(query, values = []) {
    let result = '';
    let valueIndex = 0;
    let state = 'normal';
    for (let index = 0; index < query.length; index += 1) {
        const char = query[index];
        const next = query[index + 1];
        if (state === 'normal') {
            if (char === "'")
                state = 'singleQuote';
            else if (char === '"')
                state = 'doubleQuote';
            else if (char === '-' && next === '-') {
                state = 'lineComment';
                result += char + next;
                index += 1;
                continue;
            }
            else if (char === '/' && next === '*') {
                state = 'blockComment';
                result += char + next;
                index += 1;
                continue;
            }
            else if (char === '?') {
                if (valueIndex >= values.length)
                    throw new errors_1.NetezzaError('Netezza query has more parameter markers than supplied values.');
                result += netezzaSqlLiteral(values[valueIndex]);
                valueIndex += 1;
                continue;
            }
        }
        else if (state === 'singleQuote' && char === "'") {
            if (next === "'") {
                result += char + next;
                index += 1;
                continue;
            }
            state = 'normal';
        }
        else if (state === 'doubleQuote' && char === '"') {
            if (next === '"') {
                result += char + next;
                index += 1;
                continue;
            }
            state = 'normal';
        }
        else if (state === 'lineComment' && (char === '\n' || char === '\r')) {
            state = 'normal';
        }
        else if (state === 'blockComment' && char === '*' && next === '/') {
            result += char + next;
            index += 1;
            state = 'normal';
            continue;
        }
        result += char;
    }
    if (valueIndex !== values.length)
        throw new errors_1.NetezzaError('Netezza query has more supplied values than parameter markers.');
    return result;
}
exports.interpolateNetezzaParameters = interpolateNetezzaParameters;
/** Escapes an ODBC connection-string value using ODBC brace escaping. */
function escapeOdbcConnectionValue(value) {
    return `{${String(value).replace(/}/g, '}}')}}`;
}
exports.escapeOdbcConnectionValue = escapeOdbcConnectionValue;
/**
 * Builds a Netezza ODBC connection string. A complete raw string or a DSN
 * always takes precedence over the conventional host/database configuration.
 */
function buildNetezzaConnectionString(options) {
    if (options.connectionString) {
        return options.connectionString;
    }
    const entry = (name, value) => (value === undefined || value === '' ? undefined : `${name}=${escapeOdbcConnectionValue(value)}`);
    if (options.dsn) {
        return [
            entry('DSN', options.dsn),
            entry('UID', options.user),
            entry('PWD', options.password),
            entry('SCHEMA', options.schema),
        ].filter(Boolean).join(';');
    }
    if (!options.host || !options.database) {
        throw new errors_1.NetezzaError('Netezza requires connectionString/DSN or both host and database.');
    }
    return [
        entry('DRIVER', options.driver || 'NetezzaSQL'),
        // The IBM driver expects these Netezza keywords in their native form.
        // Bracing SERVER/PORT/DATABASE makes the vendor driver reject the
        // connection when SECURITYLEVEL is present.
        `SERVERNAME=${options.host}`,
        `PORT=${options.port || 5480}`,
        `DATABASE=${options.database}`,
        // Match the IBM Netezza DSN used by the Windows clients. This keeps
        // direct Cube connections on the same preferred-unsecured mode.
        // Netezza expects this enum unbraced; braced ODBC values are rejected as
        // an invalid security level by the vendor driver.
        `SECURITYLEVEL=${options.securityLevel || 'preferredUnSecured'}`,
        // Keep Netezza character data in UTF-8 when returned through unixODBC.
        // node-odbc binds SQL_WCHAR metadata as UTF-16 on unixODBC.  The
        // Netezza driver must use the same representation or catalog names are
        // returned as pairs of bytes rendered as CJK characters.
        'UNICODETRANSLATIONOPTION=utf16',
        'CHARACTERTRANSLATIONOPTION=all',
        options.schema === undefined || options.schema === '' ? undefined : `SCHEMA=${options.schema}`,
        options.user === undefined || options.user === '' ? undefined : `USERNAME=${options.user}`,
        options.password === undefined || options.password === '' ? undefined : `PASSWORD=${options.password}`,
    ].filter(Boolean).join(';');
}
exports.buildNetezzaConnectionString = buildNetezzaConnectionString;
/** Cube.js driver for IBM Netezza through the vendor ODBC driver. */
class NetezzaDriver extends base_driver_1.BaseDriver {
    static getDefaultConcurrency() {
        return 2;
    }
    static dialectClass() {
        return NetezzaQuery_1.NetezzaQuery;
    }
    pool;
    config;
    queryTimeout;
    enabled = false;
    constructor(config = {}) {
        super({ testConnectionTimeout: config.testConnectionTimeout });
        const dataSource = config.dataSource || (0, shared_1.assertDataSource)('default');
        const preAggregations = config.preAggregations || false;
        const connectionOptions = {
            connectionString: config.connectionString || (0, shared_1.getEnv)('netezzaConnectionString', { dataSource, preAggregations }) || (0, shared_1.getEnv)('dbUrl', { dataSource, preAggregations }),
            dsn: config.dsn || (0, shared_1.getEnv)('netezzaDsn', { dataSource, preAggregations }),
            driver: config.driver || (0, shared_1.getEnv)('netezzaDriver', { dataSource, preAggregations }),
            host: config.host || (0, shared_1.getEnv)('dbHost', { dataSource, preAggregations }),
            port: config.port || (0, shared_1.getEnv)('dbPort', { dataSource, preAggregations }) || 5480,
            database: config.database || (0, shared_1.getEnv)('dbName', { dataSource, preAggregations }),
            schema: config.schema || (0, shared_1.getEnv)('netezzaSchema', { dataSource, preAggregations }),
            user: config.user || (0, shared_1.getEnv)('dbUser', { dataSource, preAggregations }),
            password: config.password || (0, shared_1.getEnv)('dbPass', { dataSource, preAggregations }),
        };
        const connectionString = buildNetezzaConnectionString(connectionOptions);
        const poolName = (0, base_driver_1.createPoolName)('netezza', dataSource, preAggregations);
        this.pool = new shared_1.Pool(poolName, {
            create: async () => this.createConnection(connectionString, poolName, config),
            destroy: async (connection) => {
                try {
                    await connection.close();
                }
                catch {
                    // The vendor driver may already have closed the native handle.
                }
            },
        }, {
            min: config.minPoolSize || config.min || (0, shared_1.getEnv)('dbMinPoolSize', { dataSource, preAggregations }) || 0,
            max: config.maxPoolSize || config.max || (0, shared_1.getEnv)('dbMaxPoolSize', { dataSource, preAggregations }) || 8,
            evictionRunIntervalMillis: config.evictionRunIntervalMillis || 10000,
            softIdleTimeoutMillis: config.softIdleTimeoutMillis || 30000,
            idleTimeoutMillis: config.idleTimeoutMillis || 30000,
            acquireTimeoutMillis: config.acquireTimeoutMillis || 20000,
        });
        this.pool.on('factoryCreateError', (error) => this.databasePoolError(error));
        this.pool.on('factoryDestroyError', (error) => this.databasePoolError(error));
        this.config = {
            readOnly: false,
            ...config,
            schema: connectionOptions.schema,
        };
        this.queryTimeout = Number(config.queryTimeout
            || (0, shared_1.getEnv)('dbQueryTimeout', { dataSource, preAggregations })
            || 60);
        this.enabled = true;
    }
    async createConnection(connectionString, poolName, config) {
        try {
            return await odbc.connect({
                connectionString,
                connectionTimeout: config.connectionTimeout,
                loginTimeout: config.loginTimeout,
            });
        }
        catch (error) {
            throw new errors_1.NetezzaConnectionError(error, poolName);
        }
    }
    async withConnection(fn) {
        const connection = await this.pool.acquire();
        try {
            return await fn(connection);
        }
        finally {
            await this.pool.release(connection);
        }
    }
    async queryResponse(query, values = [], options) {
        const timeout = Number(options?.queryTimeout || this.queryTimeout);
        try {
            const statement = interpolateNetezzaParameters(query, values);
            return await this.withConnection(async (connection) => connection.query(statement, { timeout }));
        }
        catch (error) {
            throw new errors_1.NetezzaQueryError(error);
        }
    }
    async query(query, values = [], options) {
        const result = await this.queryResponse(query, values, options);
        return Array.from(result).map(normalizeNetezzaResultRow);
    }
    async testConnection() {
        // eslint-disable-next-line no-underscore-dangle
        const connection = await this.pool._factory.create();
        try {
            await connection.query('SELECT 1');
        }
        finally {
            // eslint-disable-next-line no-underscore-dangle
            await this.pool._factory.destroy(connection);
        }
    }
    mapOdbcColumns(columns = []) {
        return columns.map((column) => ({
            name: column.name,
            type: this.toGenericType(column.dataTypeName, column.columnSize, column.decimalDigits),
        }));
    }
    async downloadQueryResults(query, values = [], options) {
        if (options.streamImport) {
            return this.stream(query, values, options);
        }
        const result = await this.queryResponse(query, values);
        return {
            rows: Array.from(result).map(normalizeNetezzaResultRow),
            types: this.mapOdbcColumns(result.columns),
        };
    }
    async stream(query, values = [], { highWaterMark }) {
        const connection = await this.pool.acquire();
        let cursor;
        let released = false;
        const release = async () => {
            if (released)
                return;
            released = true;
            try {
                await cursor?.close();
            }
            catch {
                // The cursor is already closed after a complete fetch.
            }
            finally {
                await this.pool.release(connection);
            }
        };
        try {
            const statement = interpolateNetezzaParameters(query, values);
            cursor = await connection.query(statement, { cursor: true, fetchSize: Math.max(highWaterMark, 1) });
            const activeCursor = cursor;
            const firstBatch = await activeCursor.fetch();
            const types = this.mapOdbcColumns(firstBatch.columns);
            const rows = async function* () {
                try {
                    for (const row of firstBatch)
                        yield normalizeNetezzaResultRow(row);
                    while (!activeCursor.noData) {
                        const batch = await activeCursor.fetch();
                        if (batch.length === 0)
                            break;
                        for (const row of batch)
                            yield normalizeNetezzaResultRow(row);
                    }
                }
                finally {
                    await release();
                }
            };
            return {
                rowStream: stream_1.Readable.from(rows(), { objectMode: true, highWaterMark }),
                types,
                release,
            };
        }
        catch (error) {
            await release();
            throw error;
        }
    }
    async queryColumnTypes(sql, params = []) {
        const statement = sql.trim().replace(/;+\s*$/, '');
        const result = await this.queryResponse(`SELECT * FROM (${statement}) AS "cube_netezza_column_types" WHERE 1 = 0`, params);
        return this.mapOdbcColumns(result.columns);
    }
    normalizeCatalogField(row, field) {
        const normalized = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
        const key = Object.keys(row).find((candidate) => (candidate.replace(/[^a-z0-9]/gi, '').toLowerCase() === normalized));
        return key ? row[key] : undefined;
    }
    catalogString(row, field) {
        const value = this.normalizeCatalogField(row, field);
        return value === undefined || value === null ? undefined : String(value);
    }
    ignoredSchema(schema) {
        return !schema || IGNORED_SCHEMAS.has(schema.toUpperCase());
    }
    async catalogTables() {
        const rows = await this.withConnection((connection) => connection.tables(null, null, null, 'TABLE,VIEW'));
        return Array.from(rows).flatMap((row) => {
            const schemaName = this.catalogString(row, 'TABLE_SCHEM');
            const tableName = this.catalogString(row, 'TABLE_NAME');
            if (this.ignoredSchema(schemaName) || !tableName)
                return [];
            return [{ schema_name: schemaName, table_name: tableName }];
        });
    }
    async catalogColumns(schema, table) {
        const rows = await this.withConnection((connection) => connection.columns(null, schema || null, table || null, null));
        return Array.from(rows).flatMap((row) => {
            const schemaName = this.catalogString(row, 'TABLE_SCHEM');
            const tableName = this.catalogString(row, 'TABLE_NAME');
            const columnName = this.catalogString(row, 'COLUMN_NAME');
            const dataType = this.catalogString(row, 'TYPE_NAME');
            if (this.ignoredSchema(schemaName) || !tableName || !columnName || !dataType)
                return [];
            const precision = this.normalizeCatalogField(row, 'COLUMN_SIZE');
            const scale = this.normalizeCatalogField(row, 'DECIMAL_DIGITS');
            const position = this.normalizeCatalogField(row, 'ORDINAL_POSITION');
            return [{
                    schema_name: schemaName,
                    table_name: tableName,
                    column_name: columnName,
                    data_type: dataType,
                    numeric_precision: precision === undefined ? undefined : Number(precision),
                    numeric_scale: scale === undefined ? undefined : Number(scale),
                    ordinal_position: position === undefined ? undefined : Number(position),
                }];
        }).sort((left, right) => {
            const leftPosition = left.ordinal_position || 0;
            const rightPosition = right.ordinal_position || 0;
            return leftPosition - rightPosition;
        });
    }
    async catalogPrimaryKeys() {
        try {
            const rows = await this.withConnection((connection) => connection.primaryKeys(null, null, null));
            return Array.from(rows).flatMap((row) => {
                const schemaName = this.catalogString(row, 'TABLE_SCHEM');
                const tableName = this.catalogString(row, 'TABLE_NAME');
                const columnName = this.catalogString(row, 'COLUMN_NAME');
                return this.ignoredSchema(schemaName) || !tableName || !columnName ? [] : [{
                        table_schema: schemaName,
                        table_name: tableName,
                        column_name: columnName,
                    }];
            });
        }
        catch (error) {
            this.logger?.('Netezza ODBC primary key metadata could not be read', {
                error: error.message,
            });
            return [];
        }
    }
    async catalogForeignKeys() {
        try {
            const rows = await this.withConnection((connection) => connection.foreignKeys(null, null, null, null, null, null));
            return Array.from(rows).flatMap((row) => {
                const tableSchema = this.catalogString(row, 'FKTABLE_SCHEM');
                const tableName = this.catalogString(row, 'FKTABLE_NAME');
                const columnName = this.catalogString(row, 'FKCOLUMN_NAME');
                const targetTable = this.catalogString(row, 'PKTABLE_NAME');
                const targetColumn = this.catalogString(row, 'PKCOLUMN_NAME');
                return this.ignoredSchema(tableSchema) || !tableName || !columnName || !targetTable || !targetColumn ? [] : [{
                        table_schema: tableSchema,
                        table_name: tableName,
                        column_name: columnName,
                        target_table: targetTable,
                        target_column: targetColumn,
                    }];
            });
        }
        catch (error) {
            this.logger?.('Netezza ODBC foreign key metadata could not be read', {
                error: error.message,
            });
            return [];
        }
    }
    async getSchemas() {
        const tables = await this.catalogTables();
        return [...new Set(tables.map((table) => table.schema_name))]
            .sort()
            .map((schema_name) => ({ schema_name }));
    }
    async getTablesForSpecificSchemas(schemas) {
        const requested = new Set(schemas.map((schema) => schema.schema_name));
        return (await this.catalogTables()).filter((table) => requested.has(table.schema_name));
    }
    async getColumnsForSpecificTables(tables) {
        const requested = new Set(tables.map((table) => `${table.schema_name}\u0000${table.table_name}`));
        const [columns, primaryKeys, foreignKeys] = await Promise.all([
            this.catalogColumns(),
            this.catalogPrimaryKeys(),
            this.catalogForeignKeys(),
        ]);
        return columns
            .filter((column) => requested.has(`${column.schema_name}\u0000${column.table_name}`))
            .map((column) => ({
            ...column,
            attributes: primaryKeys.some((key) => (key.table_schema === column.schema_name &&
                key.table_name === column.table_name &&
                key.column_name === column.column_name)) ? ['primaryKey'] : [],
            foreign_keys: foreignKeys
                .filter((key) => (key.table_schema === column.schema_name &&
                key.table_name === column.table_name &&
                key.column_name === column.column_name))
                .map((key) => ({ target_table: key.target_table, target_column: key.target_column })),
        }));
    }
    async tablesSchema() {
        const tables = await this.catalogTables();
        const tableKeys = new Set(tables.map((table) => `${table.schema_name}\u0000${table.table_name}`));
        const columns = await this.catalogColumns();
        return columns
            .filter((column) => tableKeys.has(`${column.schema_name}\u0000${column.table_name}`))
            .reduce((result, column) => {
            result[column.schema_name] = result[column.schema_name] || {};
            result[column.schema_name][column.table_name] = result[column.schema_name][column.table_name] || [];
            result[column.schema_name][column.table_name].push({
                name: column.column_name,
                type: this.toGenericType(column.data_type, column.numeric_precision, column.numeric_scale),
                attributes: [],
            });
            return result;
        }, {});
    }
    async tablesSchemaV2() {
        const [structure, primaryKeys, foreignKeys] = await Promise.all([
            this.tablesSchema(),
            this.catalogPrimaryKeys(),
            this.catalogForeignKeys(),
        ]);
        for (const [schemaName, tables] of Object.entries(structure)) {
            for (const [tableName, columns] of Object.entries(tables)) {
                for (const column of columns) {
                    if (primaryKeys.some((key) => key.table_schema === schemaName && key.table_name === tableName && key.column_name === column.name)) {
                        column.attributes = ['primaryKey'];
                    }
                    column.foreign_keys = foreignKeys
                        .filter((key) => key.table_schema === schemaName && key.table_name === tableName && key.column_name === column.name)
                        .map((key) => ({ target_table: key.target_table, target_column: key.target_column }));
                }
            }
        }
        return structure;
    }
    async getTablesQuery(schemaName) {
        return (await this.catalogTables())
            .filter((table) => table.schema_name === schemaName)
            .map((table) => ({ table_name: table.table_name }));
    }
    async createSchemaIfNotExists(schemaName) {
        const schemas = await this.getSchemas();
        if (!schemas.some((schema) => schema.schema_name === schemaName)) {
            await this.query(`CREATE SCHEMA ${this.quoteIdentifier(schemaName)}`, []);
        }
    }
    async tableColumnTypes(table) {
        const parts = table.split('.').map((part) => part.replace(/^"|"$/g, '').replace(/""/g, '"'));
        const tableName = parts.pop();
        const schemaName = parts.pop() || this.config.schema;
        if (!tableName)
            return [];
        const columns = await this.catalogColumns(schemaName, tableName);
        return columns.map((column) => ({
            name: column.column_name,
            type: this.toGenericType(column.data_type, column.numeric_precision, column.numeric_scale),
        }));
    }
    toGenericType(columnType, precision, scale) {
        const normalized = columnType.trim().toLowerCase().replace(/\s*\(.+\)$/, '');
        return NetezzaToGenericType[normalized] || super.toGenericType(normalized, precision, scale);
    }
    fromGenericType(columnType) {
        if (columnType === 'HLL_POSTGRES') {
            throw new errors_1.NetezzaError('Netezza does not support the PostgreSQL HLL pre-aggregation type.');
        }
        return GenericTypeToNetezza[columnType] || super.fromGenericType(columnType);
    }
    createTableSql(quotedTableName, columns) {
        const columnDefinitions = columns.map((column) => (`${this.quoteIdentifier(column.name)} ${this.fromGenericType(column.type)}`));
        return `CREATE TABLE ${quotedTableName} (${columnDefinitions.join(', ')}) DISTRIBUTE ON RANDOM`;
    }
    readOnly() {
        return !!this.config.readOnly;
    }
    capabilities() {
        return { incrementalSchemaLoading: true, streamImport: true };
    }
    async release() {
        if (!this.enabled)
            return;
        await this.pool.drain();
        await this.pool.clear();
        this.enabled = false;
    }
}
exports.NetezzaDriver = NetezzaDriver;
//# sourceMappingURL=NetezzaDriver.js.map