/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview IBM Netezza driver implemented through its vendor ODBC driver.
 */

import { Readable } from 'stream';
import odbc = require('odbc');
import { assertDataSource, getEnv, Pool, type PoolUserOptions } from '@cubejs-backend/shared';
import {
  BaseDriver,
  DatabaseStructure,
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  DriverCapabilities,
  DriverInterface,
  ForeignKeysQueryResult,
  GenericDataBaseType,
  QueryColumnsResult,
  QueryOptions,
  QuerySchemasResult,
  QueryTablesResult,
  StreamOptions,
  StreamTableDataWithTypes,
  TableColumn,
  TableQueryResult,
  TableStructure,
  createPoolName,
} from '@cubejs-backend/base-driver';
import { NetezzaConnectionError, NetezzaError } from './errors';
import { NetezzaQuery } from './NetezzaQuery';

const IGNORED_SCHEMAS = new Set([
  'DEFINITION_SCHEMA',
  'INFORMATION_SCHEMA',
  'PG_CATALOG',
  'SYSTEM',
]);

const GenericTypeToNetezza: Record<string, string> = {
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

const NetezzaToGenericType: Record<string, GenericDataBaseType> = {
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

type CatalogRow = Record<string, unknown>;

type NetezzaConnectionOptions = {
  connectionString?: string;
  dsn?: string;
  driver?: string;
  securityLevel?: string;
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
  /** ODBC statement timeout, in seconds. Defaults to one minute. */
  queryTimeout?: number;
  readOnly?: boolean;
};

/** Escapes an ODBC connection-string value using ODBC brace escaping. */
export function escapeOdbcConnectionValue(value: string | number): string {
  return `{${String(value).replace(/}/g, '}}')}}`;
}

/**
 * Builds a Netezza ODBC connection string. A complete raw string or a DSN
 * always takes precedence over the conventional host/database configuration.
 */
export function buildNetezzaConnectionString(options: NetezzaConnectionOptions): string {
  if (options.connectionString) {
    return options.connectionString;
  }

  const entry = (name: string, value: string | number | undefined) => (
    value === undefined || value === '' ? undefined : `${name}=${escapeOdbcConnectionValue(value)}`
  );

  if (options.dsn) {
    return [
      entry('DSN', options.dsn),
      entry('UID', options.user),
      entry('PWD', options.password),
      entry('SCHEMA', options.schema),
    ].filter(Boolean).join(';');
  }

  if (!options.host || !options.database) {
    throw new NetezzaError(
      'Netezza requires connectionString/DSN or both host and database.'
    );
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

/** Cube.js driver for IBM Netezza through the vendor ODBC driver. */
export class NetezzaDriver extends BaseDriver implements DriverInterface {
  public static getDefaultConcurrency(): number {
    return 2;
  }

  public static dialectClass() {
    return NetezzaQuery;
  }

  protected readonly pool: Pool<odbc.Connection>;

  protected readonly config: NetezzaDriverConfiguration;

  protected readonly queryTimeout: number;

  private enabled = false;

  public constructor(config: NetezzaDriverConfiguration = {}) {
    super({ testConnectionTimeout: config.testConnectionTimeout });

    const dataSource = config.dataSource || assertDataSource('default');
    const preAggregations = config.preAggregations || false;
    const connectionOptions: NetezzaConnectionOptions = {
      connectionString: config.connectionString || getEnv('netezzaConnectionString', { dataSource, preAggregations }) || getEnv('dbUrl', { dataSource, preAggregations }),
      dsn: config.dsn || getEnv('netezzaDsn', { dataSource, preAggregations }),
      driver: config.driver || getEnv('netezzaDriver', { dataSource, preAggregations }),
      host: config.host || getEnv('dbHost', { dataSource, preAggregations }),
      port: config.port || getEnv('dbPort', { dataSource, preAggregations }) || 5480,
      database: config.database || getEnv('dbName', { dataSource, preAggregations }),
      schema: config.schema || getEnv('netezzaSchema', { dataSource, preAggregations }),
      user: config.user || getEnv('dbUser', { dataSource, preAggregations }),
      password: config.password || getEnv('dbPass', { dataSource, preAggregations }),
    };
    const connectionString = buildNetezzaConnectionString(connectionOptions);
    const poolName = createPoolName('netezza', dataSource, preAggregations);

    this.pool = new Pool<odbc.Connection>(poolName, {
      create: async () => this.createConnection(connectionString, poolName, config),
      destroy: async (connection) => {
        try {
          await connection.close();
        } catch {
          // The vendor driver may already have closed the native handle.
        }
      },
    }, {
      min: config.minPoolSize || config.min || getEnv('dbMinPoolSize', { dataSource, preAggregations }) || 0,
      max: config.maxPoolSize || config.max || getEnv('dbMaxPoolSize', { dataSource, preAggregations }) || 8,
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
    this.queryTimeout = Number(
      config.queryTimeout
      || getEnv('dbQueryTimeout', { dataSource, preAggregations })
      || 60,
    );
    this.enabled = true;
  }

  protected async createConnection(
    connectionString: string,
    poolName: string,
    config: NetezzaDriverConfiguration,
  ): Promise<odbc.Connection> {
    try {
      return await odbc.connect({
        connectionString,
        connectionTimeout: config.connectionTimeout,
        loginTimeout: config.loginTimeout,
      });
    } catch (error) {
      throw new NetezzaConnectionError(error as Error, poolName);
    }
  }

  protected async withConnection<T>(fn: (connection: odbc.Connection) => Promise<T>): Promise<T> {
    const connection = await this.pool.acquire();
    try {
      return await fn(connection);
    } finally {
      await this.pool.release(connection);
    }
  }

  protected asOdbcParameters(values: unknown[] = []): Array<number | string> {
    return values as Array<number | string>;
  }

  protected async queryResponse<R = unknown>(
    query: string,
    values: unknown[] = [],
    options?: QueryOptions,
  ): Promise<odbc.Result<R>> {
    const timeout = Number(options?.queryTimeout || this.queryTimeout);
    return this.withConnection(async (connection) => connection.query<R>(
      query,
      this.asOdbcParameters(values),
      { timeout } as any,
    ) as unknown as Promise<odbc.Result<R>>);
  }

  public async query<R = unknown>(query: string, values: unknown[] = [], options?: QueryOptions): Promise<R[]> {
    const result = await this.queryResponse<R>(query, values, options);
    return Array.from(result);
  }

  public async testConnection(): Promise<void> {
    // eslint-disable-next-line no-underscore-dangle
    const connection = await this.pool._factory.create();
    try {
      await connection.query('SELECT 1');
    } finally {
      // eslint-disable-next-line no-underscore-dangle
      await this.pool._factory.destroy(connection);
    }
  }

  protected mapOdbcColumns(columns: odbc.ColumnDefinition[] = []): TableStructure {
    return columns.map((column) => ({
      name: column.name,
      type: this.toGenericType(column.dataTypeName, column.columnSize, column.decimalDigits),
    }));
  }

  public async downloadQueryResults(
    query: string,
    values: unknown[] = [],
    options: DownloadQueryResultsOptions,
  ): Promise<DownloadQueryResultsResult> {
    if (options.streamImport) {
      return this.stream(query, values, options);
    }

    const result = await this.queryResponse(query, values);
    return {
      rows: Array.from(result) as Record<string, unknown>[],
      types: this.mapOdbcColumns(result.columns),
    };
  }

  public async stream(
    query: string,
    values: unknown[] = [],
    { highWaterMark }: StreamOptions,
  ): Promise<StreamTableDataWithTypes> {
    const connection = await this.pool.acquire();
    let cursor: odbc.Cursor | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await cursor?.close();
      } catch {
        // The cursor is already closed after a complete fetch.
      } finally {
        await this.pool.release(connection);
      }
    };

    try {
      cursor = await connection.query(
        query,
        this.asOdbcParameters(values),
        { cursor: true, fetchSize: Math.max(highWaterMark, 1) },
      ) as unknown as odbc.Cursor;
      const activeCursor = cursor;
      const firstBatch = await activeCursor.fetch<CatalogRow>();
      const types = this.mapOdbcColumns(firstBatch.columns);

      const rows = async function* (): AsyncGenerator<CatalogRow> {
        try {
          for (const row of firstBatch) yield row;
          while (!activeCursor.noData) {
            const batch = await activeCursor.fetch<CatalogRow>();
            if (batch.length === 0) break;
            for (const row of batch) yield row;
          }
        } finally {
          await release();
        }
      };

      return {
        rowStream: Readable.from(rows(), { objectMode: true, highWaterMark }),
        types,
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  public override async queryColumnTypes(sql: string, params: unknown[] = []): Promise<{ name: any; type: string; }[]> {
    const statement = sql.trim().replace(/;+\s*$/, '');
    const result = await this.queryResponse(
      `SELECT * FROM (${statement}) AS "cube_netezza_column_types" WHERE 1 = 0`,
      params,
    );
    return this.mapOdbcColumns(result.columns);
  }

  protected normalizeCatalogField(row: CatalogRow, field: string): unknown {
    const normalized = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const key = Object.keys(row).find((candidate) => (
      candidate.replace(/[^a-z0-9]/gi, '').toLowerCase() === normalized
    ));
    return key ? row[key] : undefined;
  }

  protected catalogString(row: CatalogRow, field: string): string | undefined {
    const value = this.normalizeCatalogField(row, field);
    return value === undefined || value === null ? undefined : String(value);
  }

  protected ignoredSchema(schema: string | undefined): boolean {
    return !schema || IGNORED_SCHEMAS.has(schema.toUpperCase());
  }

  protected async catalogTables(): Promise<QueryTablesResult[]> {
    const rows = await this.withConnection((connection) => connection.tables<CatalogRow>(null, null, null, 'TABLE,VIEW'));
    return Array.from(rows).flatMap((row) => {
      const schemaName = this.catalogString(row, 'TABLE_SCHEM');
      const tableName = this.catalogString(row, 'TABLE_NAME');
      if (this.ignoredSchema(schemaName) || !tableName) return [];
      return [{ schema_name: schemaName as string, table_name: tableName }];
    });
  }

  protected async catalogColumns(schema?: string, table?: string): Promise<QueryColumnsResult[]> {
    const rows = await this.withConnection((connection) => connection.columns<CatalogRow>(
      null,
      schema || null,
      table || null,
      null,
    ));
    return Array.from(rows).flatMap((row) => {
      const schemaName = this.catalogString(row, 'TABLE_SCHEM');
      const tableName = this.catalogString(row, 'TABLE_NAME');
      const columnName = this.catalogString(row, 'COLUMN_NAME');
      const dataType = this.catalogString(row, 'TYPE_NAME');
      if (this.ignoredSchema(schemaName) || !tableName || !columnName || !dataType) return [];
      const precision = this.normalizeCatalogField(row, 'COLUMN_SIZE');
      const scale = this.normalizeCatalogField(row, 'DECIMAL_DIGITS');
      const position = this.normalizeCatalogField(row, 'ORDINAL_POSITION');
      return [{
        schema_name: schemaName as string,
        table_name: tableName,
        column_name: columnName,
        data_type: dataType,
        numeric_precision: precision === undefined ? undefined : Number(precision),
        numeric_scale: scale === undefined ? undefined : Number(scale),
        ordinal_position: position === undefined ? undefined : Number(position),
      }];
    }).sort((left, right) => {
      const leftPosition = (left as QueryColumnsResult & { ordinal_position?: number }).ordinal_position || 0;
      const rightPosition = (right as QueryColumnsResult & { ordinal_position?: number }).ordinal_position || 0;
      return leftPosition - rightPosition;
    });
  }

  protected async catalogPrimaryKeys(): Promise<{ table_schema: string; table_name: string; column_name: string; }[]> {
    try {
      const rows = await this.withConnection((connection) => connection.primaryKeys<CatalogRow>(null, null, null));
      return Array.from(rows).flatMap((row) => {
        const schemaName = this.catalogString(row, 'TABLE_SCHEM');
        const tableName = this.catalogString(row, 'TABLE_NAME');
        const columnName = this.catalogString(row, 'COLUMN_NAME');
        return this.ignoredSchema(schemaName) || !tableName || !columnName ? [] : [{
          table_schema: schemaName as string,
          table_name: tableName,
          column_name: columnName,
        }];
      });
    } catch (error) {
      this.logger?.('Netezza ODBC primary key metadata could not be read', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  protected async catalogForeignKeys(): Promise<ForeignKeysQueryResult[]> {
    try {
      const rows = await this.withConnection((connection) => connection.foreignKeys<CatalogRow>(
        null, null, null, null, null, null,
      ));
      return Array.from(rows).flatMap((row) => {
        const tableSchema = this.catalogString(row, 'FKTABLE_SCHEM');
        const tableName = this.catalogString(row, 'FKTABLE_NAME');
        const columnName = this.catalogString(row, 'FKCOLUMN_NAME');
        const targetTable = this.catalogString(row, 'PKTABLE_NAME');
        const targetColumn = this.catalogString(row, 'PKCOLUMN_NAME');
        return this.ignoredSchema(tableSchema) || !tableName || !columnName || !targetTable || !targetColumn ? [] : [{
          table_schema: tableSchema as string,
          table_name: tableName,
          column_name: columnName,
          target_table: targetTable,
          target_column: targetColumn,
        }];
      });
    } catch (error) {
      this.logger?.('Netezza ODBC foreign key metadata could not be read', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  public override async getSchemas(): Promise<QuerySchemasResult[]> {
    const tables = await this.catalogTables();
    return [...new Set(tables.map((table) => table.schema_name))]
      .sort()
      .map((schema_name) => ({ schema_name }));
  }

  public override async getTablesForSpecificSchemas(schemas: QuerySchemasResult[]): Promise<QueryTablesResult[]> {
    const requested = new Set(schemas.map((schema) => schema.schema_name));
    return (await this.catalogTables()).filter((table) => requested.has(table.schema_name));
  }

  public override async getColumnsForSpecificTables(tables: QueryTablesResult[]): Promise<QueryColumnsResult[]> {
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
        attributes: primaryKeys.some((key) => (
          key.table_schema === column.schema_name &&
          key.table_name === column.table_name &&
          key.column_name === column.column_name
        )) ? ['primaryKey'] : [],
        foreign_keys: foreignKeys
          .filter((key) => (
            key.table_schema === column.schema_name &&
            key.table_name === column.table_name &&
            key.column_name === column.column_name
          ))
          .map((key) => ({ target_table: key.target_table, target_column: key.target_column })),
      }));
  }

  public override async tablesSchema(): Promise<DatabaseStructure> {
    const tables = await this.catalogTables();
    const tableKeys = new Set(tables.map((table) => `${table.schema_name}\u0000${table.table_name}`));
    const columns = await this.catalogColumns();
    return columns
      .filter((column) => tableKeys.has(`${column.schema_name}\u0000${column.table_name}`))
      .reduce<DatabaseStructure>((result, column) => {
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

  public override async tablesSchemaV2(): Promise<DatabaseStructure> {
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
          (column as TableColumn & { foreign_keys?: { target_table: string; target_column: string }[] }).foreign_keys = foreignKeys
            .filter((key) => key.table_schema === schemaName && key.table_name === tableName && key.column_name === column.name)
            .map((key) => ({ target_table: key.target_table, target_column: key.target_column }));
        }
      }
    }
    return structure;
  }

  public override async getTablesQuery(schemaName: string): Promise<TableQueryResult[]> {
    return (await this.catalogTables())
      .filter((table) => table.schema_name === schemaName)
      .map((table) => ({ table_name: table.table_name }));
  }

  public override async createSchemaIfNotExists(schemaName: string): Promise<void> {
    const schemas = await this.getSchemas();
    if (!schemas.some((schema) => schema.schema_name === schemaName)) {
      await this.query(`CREATE SCHEMA ${this.quoteIdentifier(schemaName)}`, []);
    }
  }

  public override async tableColumnTypes(table: string): Promise<TableStructure> {
    const parts = table.split('.').map((part) => part.replace(/^"|"$/g, '').replace(/""/g, '"'));
    const tableName = parts.pop();
    const schemaName = parts.pop() || this.config.schema;
    if (!tableName) return [];
    const columns = await this.catalogColumns(schemaName, tableName);
    return columns.map((column) => ({
      name: column.column_name,
      type: this.toGenericType(column.data_type, column.numeric_precision, column.numeric_scale),
    }));
  }

  protected override toGenericType(
    columnType: string,
    precision?: number | null,
    scale?: number | null,
  ): GenericDataBaseType {
    const normalized = columnType.trim().toLowerCase().replace(/\s*\(.+\)$/, '');
    return NetezzaToGenericType[normalized] || super.toGenericType(normalized, precision, scale);
  }

  public override fromGenericType(columnType: string): string {
    if (columnType === 'HLL_POSTGRES') {
      throw new NetezzaError('Netezza does not support the PostgreSQL HLL pre-aggregation type.');
    }
    return GenericTypeToNetezza[columnType] || super.fromGenericType(columnType);
  }

  protected override createTableSql(quotedTableName: string, columns: TableColumn[]): string {
    const columnDefinitions = columns.map((column) => (
      `${this.quoteIdentifier(column.name)} ${this.fromGenericType(column.type)}`
    ));
    return `CREATE TABLE ${quotedTableName} (${columnDefinitions.join(', ')}) DISTRIBUTE ON RANDOM`;
  }

  public readOnly(): boolean {
    return !!this.config.readOnly;
  }

  public capabilities(): DriverCapabilities {
    return { incrementalSchemaLoading: true, streamImport: true };
  }

  public async release(): Promise<void> {
    if (!this.enabled) return;
    await this.pool.drain();
    await this.pool.clear();
    this.enabled = false;
  }
}
