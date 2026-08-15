import React from 'react';
import { Input, Select, Tooltip } from 'antd';
import schemaAutocomplete from '../../config/schema-autocomplete.json';
import { QuestionOutlined } from '../../shared/icons/FontAwesomeIcons';
import { TableColumn, TablesSchema } from './cubeSchemaUtils';
import { SCHEMA_BOOLEAN_KEYS, SCHEMA_PROPERTY_LABELS } from './schemaFieldMetadata';
import {
  SchemaFieldHelp,
  SchemaFieldInputCell,
  SchemaFieldLabel,
  SchemaFieldRow,
  SchemaFieldTable,
} from './SchemaFieldComponents';
import { SqlExpressionAutocomplete } from './SqlExpressionAutocomplete';
import { CaseEditor } from './CaseEditor';

export type SchemaFormLayoutProps = {
  section: string;
  fields: string[];
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
  columns?: TableColumn[];
  tablesSchema?: TablesSchema;
  examples?: Record<string, string>;
  optionOverrides?: Record<string, string[]>;
  multilineFields?: Set<string>;
  cubeSource?: {
    mode: 'sql_table' | 'sql';
    onModeChange: (mode: 'sql_table' | 'sql') => void;
  };
};

const SQL_COLUMN_SECTIONS = new Set(['joins', 'dimensions', 'measures', 'segments']);
export const CUBE_SOURCE_FIELD = '__cube_source__';
export const CUBE_PROPERTY_FIELDS = [
  'title',
  'name',
  'description',
  CUBE_SOURCE_FIELD,
  'extends',
  'data_source',
  'public',
  'refresh_key',
];

function fieldControl(
  section: string,
  key: string,
  value: any,
  onChange: (value: any) => void,
  columns: TableColumn[],
  tablesSchema: TablesSchema,
  optionOverrides?: Record<string, string[]>,
  multilineFields: Set<string> = new Set<string>(),
) {
  const enumValues = optionOverrides?.[key] || schemaAutocomplete.yaml.sections[section]?.values?.[key];
  if (SCHEMA_BOOLEAN_KEYS.has(key)) {
    return (
      <Select
        allowClear
        style={{ width: '100%' }}
        value={value === undefined || value === null ? undefined : String(value)}
        placeholder="(vazio)"
        onChange={(next) => onChange(next === undefined ? undefined : next === 'true')}
      >
        <Select.Option value="true">Verdadeiro</Select.Option>
        <Select.Option value="false">Falso</Select.Option>
      </Select>
    );
  }

  if (enumValues?.length) {
    return (
      <Select allowClear style={{ width: '100%' }} value={value} placeholder="(vazio)" onChange={onChange}>
        {enumValues.map((option) => <Select.Option key={option} value={option}>{option}</Select.Option>)}
      </Select>
    );
  }

  if (key === 'case' && (section === 'dimensions' || section === 'measures')) {
    return (
      <CaseEditor
        value={value}
        mode={section === 'dimensions' ? 'dimension' : 'measure'}
        onChange={onChange}
        columns={columns}
        tablesSchema={tablesSchema}
      />
    );
  }

  if (key === 'description' || key === 'case') {
    return (
      <Input.TextArea
        rows={key === 'description' ? 2 : 1}
        value={value ?? ''}
        placeholder="(vazio)"
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (multilineFields.has(key)) {
    return (
      <Input.TextArea
        value={value ?? ''}
        placeholder="(vazio)"
        rows={key === 'member_level' || key === 'row_level' ? 4 : 3}
        onChange={(event) => onChange(event.target.value)}
        style={{ fontFamily: 'monospace' }}
      />
    );
  }

  if (key === 'levels') {
    return (
      <Input
        value={Array.isArray(value) ? value.join(', ') : value ?? ''}
        placeholder="dimensão 1, dimensão 2"
        onChange={(event) => {
          const levels = event.target.value.split(',').map(level => level.trim()).filter(Boolean);
          onChange(levels.length ? levels : undefined);
        }}
      />
    );
  }

  if (key === 'sql' && SQL_COLUMN_SECTIONS.has(section)) {
    return (
      <SqlExpressionAutocomplete
        value={value ?? ''}
        onChange={onChange}
        columns={columns}
        tablesSchema={tablesSchema}
      />
    );
  }

  if (key === 'sql_table') {
    return (
      <SqlExpressionAutocomplete
        value={value ?? ''}
        onChange={onChange}
        tablesSchema={tablesSchema}
        tableReference
        placeholder="schema.tabela"
      />
    );
  }

  return (
    <Input
      value={Array.isArray(value) ? value.join(', ') : value ?? ''}
      placeholder="(vazio)"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function SchemaFormLayout({
  section,
  fields,
  values,
  onChange,
  columns = [],
  tablesSchema = {},
  examples = {},
  optionOverrides,
  multilineFields = new Set<string>(),
  cubeSource,
}: SchemaFormLayoutProps) {
  const descriptions = schemaAutocomplete.yaml.sections[section]?.descriptions || {};

  return (
    <SchemaFieldTable>
      {fields.map(key => {
        if (key === CUBE_SOURCE_FIELD && cubeSource) {
          return (
            <SchemaFieldRow key={key}>
              <SchemaFieldInputCell style={{ marginLeft: 0, background: '#fafafa' }}>
                <Select
                  style={{ width: '100%', flex: 1 }}
                  value={cubeSource.mode}
                  onChange={(mode) => cubeSource.onModeChange(mode as 'sql_table' | 'sql')}
                >
                  <Select.Option value="sql_table">Tabela SQL</Select.Option>
                  <Select.Option value="sql">SQL</Select.Option>
                </Select>
              </SchemaFieldInputCell>
              <SchemaFieldInputCell>
                {cubeSource.mode === 'sql' ? (
                  <SqlExpressionAutocomplete
                    value={values.sql ?? ''}
                    columns={columns}
                    tablesSchema={tablesSchema}
                    multiline
                    placeholder="Consulta SQL"
                    onChange={(value) => onChange('sql', value)}
                  />
                ) : (
                  <SqlExpressionAutocomplete
                    value={values.sql_table ?? ''}
                    tablesSchema={tablesSchema}
                    tableReference
                    placeholder="schema.tabela"
                    onChange={(value) => onChange('sql_table', value)}
                  />
                )}
              </SchemaFieldInputCell>
              <Tooltip title="Fonte SQL do cubo">
                <SchemaFieldHelp><QuestionOutlined /></SchemaFieldHelp>
              </Tooltip>
            </SchemaFieldRow>
          );
        }

        const label = SCHEMA_PROPERTY_LABELS[key] || key;
        const description = descriptions[key];
        const example = examples[key];
        const tooltip = description || example ? (
          <div>
            {description ? <div>{description}</div> : null}
            {example ? <div style={{ marginTop: 6 }}><strong>Exemplo:</strong> {example}</div> : null}
          </div>
        ) : `Editar ${label}`;

        return (
          <SchemaFieldRow key={key}>
            <SchemaFieldLabel>{label}</SchemaFieldLabel>
            <SchemaFieldInputCell>
              {fieldControl(section, key, values[key], value => onChange(key, value), columns, tablesSchema, optionOverrides, multilineFields)}
            </SchemaFieldInputCell>
            <Tooltip title={tooltip}>
              <SchemaFieldHelp><QuestionOutlined /></SchemaFieldHelp>
            </Tooltip>
          </SchemaFieldRow>
        );
      })}
    </SchemaFieldTable>
  );
}
