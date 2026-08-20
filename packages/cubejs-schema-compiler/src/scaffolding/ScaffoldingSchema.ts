import inflection from 'inflection';
import R from 'ramda';
import { notEmpty } from '@cubejs-backend/shared';
import { UserError } from '../compiler';
import { toSnakeCase } from './utils';

enum ColumnType {
  Time = 'time',
  Number = 'number',
  String = 'string',
  Boolean = 'boolean',
}

export enum MemberType {
  Measure = 'measure',
  Dimension = 'dimension',
  None = 'none',
}

export type Dimension = {
  name: string;
  types: any[];
  title: string;
  isPrimaryKey?: boolean;
  type?: any;
  sql?: string;
  compositeKeyColumns?: string[];
};

export type TableName = string | [string, string];

export type JoinRelationship = 'hasOne' | 'hasMany' | 'belongsTo';

type ColumnsToJoin = {
  cubeToJoin: string;
  columnToJoin: string;
  tableName: TableName;
};

export type CubeDescriptorMember = {
  name: string;
  title: string;
  memberType: MemberType;
  type?: string;
  types: string[];
  isId?: boolean;
  included?: boolean;
  isPrimaryKey?: boolean;
};

export type Join = {
  thisTableColumn: string;
  thisTableColumnIncludedAsDimension?: boolean;
  tableName: TableName;
  cubeToJoin: string;
  columnToJoin: string;
  columnToJoinIncludedAsDimension?: boolean;
  relationship: JoinRelationship;
};

export type CubeDescriptor = {
  cube: string;
  tableName: TableName;
  table: string;
  schema: string;
  members: CubeDescriptorMember[];
  joins: Join[];
};

export type TableSchema = {
  cube: string;
  tableName: TableName;
  schema: any;
  table: any;
  measures: any[];
  dimensions: Dimension[];
  drillMembers?: Dimension[];
  joins: Join[];
};

const MEASURE_DICTIONARY = [
  'amount',
  'price',
  'count',
  'balance',
  'total',
  'number',
  'cost',
  'qty',
  'quantity',
  'duration',
  'value',
];

const idRegex = '_id$|id$';

type ForeignKey = {
  // eslint-disable-next-line camelcase
  target_table: string;
  // eslint-disable-next-line camelcase
  target_column: string;
};

type ColumnData = {
  name: string,
  type: string,
  attributes: string[],
  // eslint-disable-next-line camelcase
  foreign_keys?: ForeignKey[],
};

export type DatabaseSchema = Record<string, { [key: string]: ColumnData[] }>;

type TableData = {
  schema: string,
  table: string,
  tableName: TableName;
  tableDefinition: ColumnData[],
};

type ScaffoldingSchemaOptions = {
  includeNonDictionaryMeasures?: boolean;
  snakeCase?: boolean;
};

export class ScaffoldingSchema {
  private tableNamesToTables: Record<string, TableData[]> = {};

  public constructor(
    private readonly dbSchema: DatabaseSchema,
    private readonly options: ScaffoldingSchemaOptions = {}
  ) {}

  public resolveTableName(tableName: TableName) {
    let tableParts;
    if (Array.isArray(tableName)) {
      tableParts = tableName;
    } else {
      tableParts = tableName.match(/(["`].*?["`]|[^`".]+)+(?=\s*|\s*$)/g);
    }

    if (tableParts.length === 2) {
      this.resolveTableDefinition(tableName);
      return tableName;
    } else if (tableParts.length === 1 && typeof tableName === 'string') {
      const schema = Object.keys(this.dbSchema).find(
        (tableSchema) => this.dbSchema[tableSchema][tableName] ||
          this.dbSchema[tableSchema][inflection.tableize(tableName)]
      );
      if (!schema) {
        throw new UserError(`Can't find any table with '${tableName}' name`);
      }
      if (this.dbSchema[schema][tableName]) {
        return `${schema}.${tableName}`;
      }
      if (this.dbSchema[schema][inflection.tableize(tableName)]) {
        return `${schema}.${inflection.tableize(tableName)}`;
      }
    }

    throw new UserError(
      'Table names should be in <table> or <schema>.<table> format'
    );
  }

  public cubeDescriptors(tableNames: TableName[]): CubeDescriptor[] {
    const cubes = this.generateForTables(tableNames);

    function member(type: MemberType) {
      return (value: Omit<CubeDescriptorMember, 'memberType'>) => ({
        memberType: type,
        ...R.pick(['name', 'title', 'types', 'isPrimaryKey', 'included', 'isId'], value)
      });
    }

    return cubes.map((cube) => ({
      cube: cube.cube,
      tableName: cube.tableName,
      table: cube.table,
      schema: cube.schema,
      members: (cube.measures || []).map(member(MemberType.Measure))
        .concat((cube.dimensions || []).map(member(MemberType.Dimension))),
      joins: cube.joins
    }));
  }

  public generateForTables(tableNames: TableName[]) {
    this.prepareTableNamesToTables(tableNames);
    return tableNames.map(tableName => this.tableSchema(tableName, true));
  }

  protected prepareTableNamesToTables(tableNames: TableName[]) {
    this.tableNamesToTables = R.pipe(
      // @ts-ignore
      R.unnest,
      R.groupBy(n => n[0]),
      R.map(groupedNameToDef => groupedNameToDef.map(nameToDef => nameToDef[1]))
    )(
      // @ts-ignore
      tableNames.map(tableName => {
        const [schema, table] = this.parseTableName(tableName);
        const tableDefinition = this.resolveTableDefinition(tableName);
        const definition: TableData = {
          schema, table, tableDefinition, tableName
        };
        const tableizeName = inflection.tableize(this.fixCase(table));
        const parts = tableizeName.split('_');
        const tableNamesFromParts = R.range(0, parts.length - 1).map(toDrop => inflection.tableize(R.drop(toDrop, parts).join('_')));
        const names = R.uniq([table, tableizeName].concat(tableNamesFromParts));
        return names.map(n => [n, definition]);
      })
    ) as any;
  }

  public resolveTableDefinition(tableName: TableName) {
    const [schema, table] = this.parseTableName(tableName);
    if (!this.dbSchema[schema]) {
      throw new UserError(`Can't resolve ${tableName}: '${schema}' does not exist`);
    }
    if (!this.dbSchema[schema][table]) {
      throw new UserError(`Can't resolve ${tableName}: '${table}' does not exist`);
    }
    return this.dbSchema[schema][table];
  }

  protected tableSchema(tableName: TableName, includeJoins: boolean): TableSchema {
    const [schema, table] = this.parseTableName(tableName);
    const tableDefinition = this.resolveTableDefinition(tableName);
    this.currentTableName = table;
    const dimensions = this.dimensions(tableDefinition);

    return {
      cube: this.options.snakeCase ? toSnakeCase(table) : inflection.camelize(table),
      tableName,
      schema,
      table,
      measures: this.numberMeasures(tableDefinition),
      dimensions,
      joins: includeJoins ? this.joins(tableName, tableDefinition) : []
    };
  }

  protected parseTableName(tableName: TableName): [string, string] {
    let schemaAndTable;
    if (Array.isArray(tableName)) {
      schemaAndTable = tableName;
    } else {
      schemaAndTable = tableName.match(/(["`].*?["`]|[^`".]+)+(?=\s*|\s*$)/g);
    }
    if (schemaAndTable.length !== 2) {
      throw new UserError(`Incorrect format for '${tableName}'. Should be in '<schema>.<table>' format`);
    }
    return schemaAndTable;
  }

  protected dimensions(tableDefinition: ColumnData[]): Dimension[] {
    const tableName = this.currentTableName;
    const isFactTable = this.isFactTable(tableName);
    const isDimensionTable = this.isDimensionTable(tableName);
    const keyColumns = tableDefinition.filter(column => this.isKeyColumn(column));
    const dimensionPrimaryKeyColumn = isDimensionTable && (
      keyColumns[0] || (keyColumns.length === 0 && this.isPeriodDimension(tableName)
        ? tableDefinition.find(column => this.isPeriodPrimaryKeyColumn(column))
        : undefined)
    );
    const dimensionPrimaryKey = dimensionPrimaryKeyColumn
      ? this.normalizedColumnName(dimensionPrimaryKeyColumn.name)
      : null;
    const hasCorporateDimensionKey = dimensionPrimaryKey !== null;
    const hasFactCompositeKey = isFactTable && keyColumns.length > 0;

    const dimensions = this.dimensionColumns(tableDefinition).map(column => {
      const res: Dimension = {
        name: column.name,
        types: [column.columnType || this.dimensionType(column)],
        title: inflection.titleize(column.name),
      };

      if (column.columnType !== 'time' || this.normalizedColumnName(column.name) === dimensionPrimaryKey) {
        res.isPrimaryKey = !hasFactCompositeKey && (hasCorporateDimensionKey
          ? this.normalizedColumnName(column.name) === dimensionPrimaryKey
          : column.attributes?.includes('primaryKey') || this.fixCase(column.name) === 'id');
      }
      return res;
    });

    if (!isFactTable || keyColumns.length === 0) return dimensions;

    const compositeKeyName = dimensions.some(dimension => this.fixCase(dimension.name) === 'id')
      ? 'composite_key'
      : 'id';
    return [{
      name: compositeKeyName,
      types: ['string'],
      type: 'string',
      title: compositeKeyName === 'id' ? 'ID' : 'Chave composta',
      isPrimaryKey: true,
      compositeKeyColumns: keyColumns.map(column => column.name),
    } as Dimension, ...dimensions];
  }

  protected numberMeasures(tableDefinition: ColumnData[]) {
    const corporateTable = this.isFactTable(this.currentTableName) || this.isDimensionTable(this.currentTableName);
    return tableDefinition.filter(
      column => (!column.name.startsWith('_') &&
        (this.columnType(column) === 'number') &&
        (corporateTable
          ? this.isCorporateMeasureColumn(column)
          : (this.options.includeNonDictionaryMeasures ? this.fixCase(column.name) !== 'id' : this.fromMeasureDictionary(column))))
    ).map(column => ({
      name: column.name,
      types: ['sum', 'avg', 'min', 'max'],
      title: inflection.titleize(column.name),
      ...(this.options.includeNonDictionaryMeasures ? { included: this.fromMeasureDictionary(column) } : null)
    }));
  }

  protected fromMeasureDictionary(column) {
    return !column.name.match(new RegExp(idRegex, 'i')) && !!MEASURE_DICTIONARY.find(word => this.fixCase(column.name).endsWith(word));
  }

  protected dimensionColumns(tableDefinition: ColumnData[]): Array<ColumnData & { columnType?: string }> {
    const corporateTable = this.isFactTable(this.currentTableName) || this.isDimensionTable(this.currentTableName);
    if (corporateTable) {
      return tableDefinition
        .filter(column => !column.name.startsWith('_') && (
          this.isKeyColumn(column)
          || this.isDescriptionColumn(column)
          || this.isFlagColumn(column)
          || this.isDateColumn(column)
          || ['string', 'boolean'].includes(this.columnType(column))
          || column.attributes?.includes('primaryKey')
        ))
        .map(column => this.isDateColumn(column) ? { ...column, columnType: 'time' } : column);
    }

    const dimensionColumns = tableDefinition.filter(
      column => !column.name.startsWith('_') && ['string', 'boolean'].includes(this.columnType(column)) ||
        column.attributes?.includes('primaryKey') ||
        this.fixCase(column.name) === 'id'
    );

    const timeColumns = R.pipe(
      // @ts-ignore
      R.filter(column => !column.name.startsWith('_') && this.columnType(column) === 'time'),
      R.sortBy(column => this.timeColumnIndex(column)),
      // @ts-ignore
      R.map(column => ({ ...column, columnType: 'time' })) // TODO do we need it?
      // @ts-ignore
    )(tableDefinition);

    return dimensionColumns.concat(timeColumns);
  }

  private fixCase(value: string) {
    if (this.options.snakeCase) {
      return toSnakeCase(value);
    }

    return value.toLocaleLowerCase();
  }

  private currentTableName = '';

  private normalizedName(value: string): string {
    return value.replace(/[^a-z0-9]/gi, '').toLocaleUpperCase();
  }

  private normalizedColumnName(value: string): string {
    return this.normalizedName(value);
  }

  private isFactTable(tableName: string): boolean {
    return this.normalizedName(tableName).startsWith('TF');
  }

  private isDimensionTable(tableName: string): boolean {
    return this.normalizedName(tableName).startsWith('TD');
  }

  private isPeriodDimension(tableName: string): boolean {
    return this.normalizedName(tableName) === 'TDPERIODO';
  }

  private isKeyColumn(column: ColumnData): boolean {
    return this.normalizedColumnName(column.name).startsWith('SK');
  }

  private isDescriptionColumn(column: ColumnData): boolean {
    return this.normalizedColumnName(column.name).startsWith('DS');
  }

  private isFlagColumn(column: ColumnData): boolean {
    return this.normalizedColumnName(column.name).startsWith('FL');
  }

  private isDateColumn(column: ColumnData): boolean {
    return this.normalizedColumnName(column.name).startsWith('DT') || this.columnType(column) === 'time';
  }

  private isPeriodPrimaryKeyColumn(column: ColumnData): boolean {
    return this.normalizedColumnName(column.name) === 'DATA';
  }

  private isFactDateColumn(column: ColumnData): boolean {
    return this.normalizedColumnName(column.name).startsWith('DT');
  }

  private isCorporateMeasureColumn(column: ColumnData): boolean {
    const name = this.normalizedColumnName(column.name);
    return ['VLR', 'VL', 'QTD', 'QT'].some(prefix => name.startsWith(prefix))
      && !this.isKeyColumn(column);
  }

  private dimensionType(column: ColumnData): string {
    return this.isDateColumn(column) ? 'time' : this.columnType(column);
  }

  protected joins(tableName: TableName, tableDefinition: ColumnData[]): Join[] {
    const cubeName = (name: string) => (this.options.snakeCase ? toSnakeCase(name) : inflection.camelize(name));

    return R.unnest(tableDefinition
      .map(column => {
        let columnsToJoin: ColumnsToJoin[] = [];

        if (column.foreign_keys?.length) {
          column.foreign_keys.forEach(fk => {
            const targetTableDefinition = this.tableNamesToTables[fk.target_table]?.find(t => t.table === fk.target_table);
            if (targetTableDefinition) {
              columnsToJoin.push({
                cubeToJoin: cubeName(fk.target_table),
                columnToJoin: fk.target_column,
                tableName: targetTableDefinition.tableName
              });
            }
          });
        } else if (this.isFactTable(this.tableNameFromTableName(tableName)) && this.isKeyColumn(column)) {
          const keyBase = this.normalizedColumnName(column.name).replace(/^SK/, '');
          const dimensionDefinitions = this.selectedTableDefinitions().filter(definition => (
            definition.table !== this.tableNameFromTableName(tableName)
            && this.isDimensionTable(definition.table)
            && this.dimensionMatchesKey(definition, column, keyBase)
          ));

          columnsToJoin = dimensionDefinitions.map(definition => ({
            cubeToJoin: cubeName(definition.table),
            columnToJoin: this.dimensionJoinColumn(definition.tableDefinition, column),
            tableName: definition.tableName,
          }));
        } else if (
          this.isFactTable(this.tableNameFromTableName(tableName))
          && this.isFactDateColumn(column)
          && tableDefinition.find(item => this.isFactDateColumn(item))?.name === column.name
        ) {
          const periodDefinitions = this.selectedTableDefinitions().filter(definition => (
            definition.table !== this.tableNameFromTableName(tableName)
            && this.isPeriodDimension(definition.table)
            && definition.tableDefinition.every(item => !this.isKeyColumn(item))
            && definition.tableDefinition.some(item => this.isPeriodPrimaryKeyColumn(item))
          ));

          columnsToJoin = periodDefinitions.map(definition => ({
            cubeToJoin: cubeName(definition.table),
            columnToJoin: definition.tableDefinition.find(item => this.isPeriodPrimaryKeyColumn(item))!.name,
            tableName: definition.tableName,
          }));
        } else if ((column.name.match(new RegExp(idRegex, 'i')) && this.fixCase(column.name) !== 'id')) {
          const withoutId = column.name.replace(new RegExp(idRegex, 'i'), '');
          const tablesToJoin = this.tableNamesToTables[withoutId] ||
          this.tableNamesToTables[inflection.tableize(withoutId)] ||
          this.tableNamesToTables[this.fixCase(withoutId)] ||
          this.tableNamesToTables[(inflection.tableize(this.fixCase(withoutId)))];

          if (!tablesToJoin) {
            return null;
          }

          columnsToJoin = tablesToJoin.map(definition => {
            if (this.sameTableName(tableName, definition.tableName)) {
              return null;
            }
            let columnForJoin = definition.tableDefinition.find(c => this.fixCase(c.name) === this.fixCase(column.name));
            columnForJoin = columnForJoin || definition.tableDefinition.find(c => this.fixCase(c.name) === 'id');
            if (!columnForJoin) {
              return null;
            }
            return {
              cubeToJoin: cubeName(definition.table),
              columnToJoin: columnForJoin.name,
              tableName: definition.tableName
            };
          }).filter(notEmpty);
        }

        if (!columnsToJoin.length) {
          return null;
        }

        return columnsToJoin.map<Join>(columnToJoin => ({
          thisTableColumn: column.name,
          tableName: columnToJoin.tableName,
          cubeToJoin: columnToJoin.cubeToJoin,
          columnToJoin: columnToJoin.columnToJoin,
          relationship: 'belongsTo'
        }));
      })
      .filter(notEmpty));
  }

  private selectedTableDefinitions(): TableData[] {
    const definitions = new Map<string, TableData>();
    Object.values(this.tableNamesToTables).flat().forEach(definition => {
      definitions.set(JSON.stringify(definition.tableName), definition);
    });
    return Array.from(definitions.values());
  }

  private tableNameFromTableName(tableName: TableName): string {
    return Array.isArray(tableName) ? tableName[1] : this.parseTableName(tableName)[1];
  }

  private sameTableName(left: TableName, right: TableName): boolean {
    const leftParts = Array.isArray(left) ? left : this.parseTableName(left);
    const rightParts = Array.isArray(right) ? right : this.parseTableName(right);
    return leftParts[0] === rightParts[0] && leftParts[1] === rightParts[1];
  }

  private dimensionMatchesKey(definition: TableData, factColumn: ColumnData, keyBase: string): boolean {
    const factColumnName = this.normalizedColumnName(factColumn.name);
    const primaryKey = definition.tableDefinition.find(column => this.isKeyColumn(column));
    if (!primaryKey) return false;

    const primaryKeyName = this.normalizedColumnName(primaryKey.name);
    const dimensionTableBase = this.normalizedName(definition.table).replace(/^TD/, '');
    const normalizedDimensionTableBase = inflection.singularize(dimensionTableBase);
    const normalizedKeyBase = inflection.singularize(keyBase);
    return primaryKeyName === factColumnName
      || normalizedDimensionTableBase === normalizedKeyBase;
  }

  private dimensionJoinColumn(columns: ColumnData[], factColumn: ColumnData): string {
    return columns.find(column => this.isKeyColumn(column))?.name || factColumn.name;
  }

  protected timeColumnIndex(column): number {
    const name = this.fixCase(column.name);
    if (name.indexOf('create') !== -1) {
      return 0;
    } else if (name.indexOf('update') !== -1) {
      return 1;
    } else {
      return 2;
    }
  }

  protected columnType(column): ColumnType {
    const type = this.fixCase(column.type);

    if (['time', 'date'].find(t => type.includes(t))) {
      return ColumnType.Time;
    } else if ([
      'int', // integer, bigint, smallint, tinyint, mediumint, uint8, uint16, uint32, uint64, uinteger, ubigint, usmallint, hugeint, byteint, etc.
      'dec', // decimal
      'double', // double, double precision
      'numb', // number, numeric, bignumeric
      'float', // float, float4, float8, float32, float64, binary_float
      'real', // real
      'serial', // serial, bigserial, smallserial
      'money', // money, smallmoney
    ].find(t => type.includes(t))) {
      // enums are not Numbers
      return ColumnType.Number;
    } else if (['bool'].find(t => type.includes(t))) {
      return ColumnType.Boolean;
    }

    return ColumnType.String;
  }
}
