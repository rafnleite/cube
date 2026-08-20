import React, { useEffect, useRef, useState } from 'react';
import { TableColumn, TablesSchema } from './cubeSchemaUtils';
import { SqlExpressionAutocomplete } from './SqlExpressionAutocomplete';

type MeasureFilterEditorProps = {
  value?: unknown;
  onChange: (value: string | undefined) => void;
  columns?: TableColumn[];
  tablesSchema?: TablesSchema;
};

function filterText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(item => {
      if (item && typeof item === 'object' && 'sql' in item) {
        return String((item as { sql?: unknown }).sql || '');
      }
      return String(item);
    }).filter(Boolean).join('\nAND ');
  }
  if (value && typeof value === 'object' && 'sql' in value) {
    return String((value as { sql?: unknown }).sql || '');
  }
  return String(value);
}

export function MeasureFilterEditor({
  value,
  onChange,
  columns = [],
  tablesSchema = {},
}: MeasureFilterEditorProps) {
  const externalText = filterText(value);
  const [draft, setDraft] = useState(externalText);
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setDraft(externalText);
  }, [externalText]);

  return (
    <SqlExpressionAutocomplete
      value={draft}
      onChange={(nextValue) => {
        setDraft(nextValue);
        onChange(nextValue === '' ? undefined : nextValue);
      }}
      onFocus={() => { editingRef.current = true; }}
      onBlur={() => { editingRef.current = false; }}
      columns={columns}
      tablesSchema={tablesSchema}
      multiline
      placeholder="Ex.: {CUBE}.status = 'confirmed'"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
