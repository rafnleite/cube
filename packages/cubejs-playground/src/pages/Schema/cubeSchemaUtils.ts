export type TableColumn = { name: string; type?: string };
export type TablesSchema = Record<string, Record<string, TableColumn[]>>;

export function inferDimensionType(columnType?: string): string {
  const normalizedType = String(columnType || '').toLowerCase();
  if (/timestamp|date|time/.test(normalizedType)) return 'time';
  if (/bool/.test(normalizedType)) return 'boolean';
  if (/int|numeric|decimal|real|double|float|number/.test(normalizedType)) return 'number';
  return 'string';
}

export function expressionReferencesColumn(expression: unknown, columnName: string): boolean {
  if (typeof expression !== 'string' || !expression.trim()) return false;

  const escapedColumnName = columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const localReference = new RegExp(
    `(?:\\{\\s*CUBE\\s*\\}|\\$\\{\\s*CUBE\\s*\\}|\\bCUBE)\\s*\\.\\s*${escapedColumnName}(?=$|[^A-Za-z0-9_$])`,
    'i'
  );
  const bareReference = new RegExp(
    `(?:^|[^A-Za-z0-9_$])${escapedColumnName}(?=$|[^A-Za-z0-9_$])`,
    'i'
  );

  return localReference.test(expression) || bareReference.test(expression);
}

/** Resolves a `schema.table` (or bare `table`) reference against the loaded DB schema. */
export function resolveColumnsForTable(sqlTable: string | undefined, tablesSchema?: TablesSchema): TableColumn[] {
  if (!tablesSchema || !sqlTable) {
    return [];
  }

  const tableRef = sqlTable.trim().replace(/^['"]|['"]$/g, '');
  const parts = tableRef.split('.');
  const tableName = parts[parts.length - 1];
  const schemaName = parts.length >= 2 ? parts[parts.length - 2] : null;

  if (schemaName && tablesSchema[schemaName]?.[tableName]) {
    return tablesSchema[schemaName][tableName];
  }

  for (const schema of Object.keys(tablesSchema)) {
    if (tablesSchema[schema]?.[tableName]) {
      return tablesSchema[schema][tableName];
    }
  }

  return [];
}
