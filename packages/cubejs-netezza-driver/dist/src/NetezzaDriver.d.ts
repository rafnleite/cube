/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview IBM Netezza driver implemented through its vendor ODBC driver.
 */
import odbc = require('odbc');
import { Pool, type PoolUserOptions } from '@cubejs-backend/shared';
import { BaseDriver, DatabaseStructure, DownloadQueryResultsOptions, DownloadQueryResultsResult, DriverCapabilities, DriverInterface, ForeignKeysQueryResult, GenericDataBaseType, QueryColumnsResult, QueryOptions, QuerySchemasResult, QueryTablesResult, StreamOptions, StreamTableDataWithTypes, TableColumn, TableQueryResult, TableStructure } from '@cubejs-backend/base-driver';
import { NetezzaQuery } from './NetezzaQuery';
type CatalogRow = Record<string, unknown>;
type NetezzaConnectionOptions = {
    connectionString?: string;
    dsn?: string;
    driver?: string;
    host?: string;
    port?: number | string;
    database?: string;
    schema?: string;
    user?: string;
    password?: string;
};
export type NetezzaDriverConfiguration = NetezzaConnectionOptions & PoolUserOptions & {
    /** @deprecated Use maxPoolSize. */
    max?: number;
    /** @deprecated Use minPoolSize. */
    min?: number;
    dataSource?: string;
    preAggregations?: boolean;
    maxPoolSize?: number;
    minPoolSize?: number;
    testConnectionTimeout?: number;
    connectionTimeout?: number;
    loginTimeout?: number;
    readOnly?: boolean;
};
/** Escapes an ODBC connection-string value using ODBC brace escaping. */
export declare function escapeOdbcConnectionValue(value: string | number): string;
/**
 * Builds a Netezza ODBC connection string. A complete raw string or a DSN
 * always takes precedence over the conventional host/database configuration.
 */
export declare function buildNetezzaConnectionString(options: NetezzaConnectionOptions): string;
/** Cube.js driver for IBM Netezza through the vendor ODBC driver. */
export declare class NetezzaDriver extends BaseDriver implements DriverInterface {
    static getDefaultConcurrency(): number;
    static dialectClass(): typeof NetezzaQuery;
    protected readonly pool: Pool<odbc.Connection>;
    protected readonly config: NetezzaDriverConfiguration;
    private enabled;
    constructor(config?: NetezzaDriverConfiguration);
    protected createConnection(connectionString: string, poolName: string, config: NetezzaDriverConfiguration): Promise<odbc.Connection>;
    protected withConnection<T>(fn: (connection: odbc.Connection) => Promise<T>): Promise<T>;
    protected asOdbcParameters(values?: unknown[]): Array<number | string>;
    protected queryResponse<R = unknown>(query: string, values?: unknown[]): Promise<odbc.Result<R>>;
    query<R = unknown>(query: string, values?: unknown[], _options?: QueryOptions): Promise<R[]>;
    testConnection(): Promise<void>;
    protected mapOdbcColumns(columns?: odbc.ColumnDefinition[]): TableStructure;
    downloadQueryResults(query: string, values: unknown[] | undefined, options: DownloadQueryResultsOptions): Promise<DownloadQueryResultsResult>;
    stream(query: string, values: unknown[] | undefined, { highWaterMark }: StreamOptions): Promise<StreamTableDataWithTypes>;
    queryColumnTypes(sql: string, params?: unknown[]): Promise<{
        name: any;
        type: string;
    }[]>;
    protected normalizeCatalogField(row: CatalogRow, field: string): unknown;
    protected catalogString(row: CatalogRow, field: string): string | undefined;
    protected ignoredSchema(schema: string | undefined): boolean;
    protected catalogTables(): Promise<QueryTablesResult[]>;
    protected catalogColumns(schema?: string, table?: string): Promise<QueryColumnsResult[]>;
    protected catalogPrimaryKeys(): Promise<{
        table_schema: string;
        table_name: string;
        column_name: string;
    }[]>;
    protected catalogForeignKeys(): Promise<ForeignKeysQueryResult[]>;
    getSchemas(): Promise<QuerySchemasResult[]>;
    getTablesForSpecificSchemas(schemas: QuerySchemasResult[]): Promise<QueryTablesResult[]>;
    getColumnsForSpecificTables(tables: QueryTablesResult[]): Promise<QueryColumnsResult[]>;
    tablesSchema(): Promise<DatabaseStructure>;
    tablesSchemaV2(): Promise<DatabaseStructure>;
    getTablesQuery(schemaName: string): Promise<TableQueryResult[]>;
    createSchemaIfNotExists(schemaName: string): Promise<void>;
    tableColumnTypes(table: string): Promise<TableStructure>;
    protected toGenericType(columnType: string, precision?: number | null, scale?: number | null): GenericDataBaseType;
    fromGenericType(columnType: string): string;
    protected createTableSql(quotedTableName: string, columns: TableColumn[]): string;
    readOnly(): boolean;
    capabilities(): DriverCapabilities;
    release(): Promise<void>;
}
export {};
//# sourceMappingURL=NetezzaDriver.d.ts.map