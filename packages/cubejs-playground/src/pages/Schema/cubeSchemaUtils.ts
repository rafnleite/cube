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

function splitTableReference(reference: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let index = 0; index < reference.length; index += 1) {
    const character = reference[index];
    if (quote) {
      if (character === quote) {
        if (reference[index + 1] === quote) {
          current += character;
          index += 1;
        } else {
          quote = null;
        }
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character;
      continue;
    }
    if (character === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function findTableColumns(
  schema: Record<string, TableColumn[]> | undefined,
  tableName: string,
): TableColumn[] | undefined {
  if (!schema) return undefined;
  const tableKey = Object.keys(schema).find(key => key.toLowerCase() === tableName.toLowerCase());
  return tableKey ? schema[tableKey] : undefined;
}

function findSchema(
  tablesSchema: TablesSchema,
  schemaName: string,
): Record<string, TableColumn[]> | undefined {
  const schemaKey = Object.keys(tablesSchema).find(key => key.toLowerCase() === schemaName.toLowerCase());
  return schemaKey ? tablesSchema[schemaKey] : undefined;
}

/** Resolves a `schema.table` (or bare `table`) reference against the loaded DB schema. */
export function resolveColumnsForTable(sqlTable: string | undefined, tablesSchema?: TablesSchema): TableColumn[] {
  if (!tablesSchema || !sqlTable) {
    return [];
  }

  const parts = splitTableReference(sqlTable.trim());
  const tableName = parts[parts.length - 1];
  const schemaName = parts.length >= 2 ? parts[parts.length - 2] : null;

  if (schemaName) {
    const columns = findTableColumns(findSchema(tablesSchema, schemaName), tableName);
    if (columns) return columns;
  }

  for (const schema of Object.keys(tablesSchema)) {
    const columns = findTableColumns(tablesSchema[schema], tableName);
    if (columns) return columns;
  }

  return [];
}
