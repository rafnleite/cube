export type TableColumn = { name: string; type?: string };
export type TablesSchema = Record<string, Record<string, TableColumn[]>>;

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
