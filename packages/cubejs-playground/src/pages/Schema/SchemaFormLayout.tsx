import React from 'react';
import { AutoComplete, Input, Select, Tooltip } from 'antd';
import schemaAutocomplete from '../../config/schema-autocomplete.json';
import { QuestionOutlined } from '../../shared/icons/FontAwesomeIcons';
import { TableColumn } from './cubeSchemaUtils';
import { SCHEMA_BOOLEAN_KEYS, SCHEMA_PROPERTY_LABELS } from './schemaFieldMetadata';
import {
  SchemaFieldHelp,
  SchemaFieldInputCell,
  SchemaFieldLabel,
  SchemaFieldRow,
  SchemaFieldTable,
} from './SchemaFieldComponents';

export type SchemaFormLayoutProps = {
  section: string;
  fields: string[];
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
  columns?: TableColumn[];
  examples?: Record<string, string>;
  optionOverrides?: Record<string, string[]>;
  cubeSource?: {
    mode: 'sql_table' | 'sql';
    onModeChange: (mode: 'sql_table' | 'sql') => void;
  };
};

const SQL_COLUMN_SECTIONS = new Set(['dimensions', 'measures', 'segments']);
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
  optionOverrides?: Record<string, string[]>,
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

  if (key === 'sql' && SQL_COLUMN_SECTIONS.has(section) && columns.length) {
    return (
      <AutoComplete
        style={{ width: '100%' }}
        value={value}
        placeholder="coluna ou expressão SQL"
        onChange={onChange}
        options={columns.map(column => ({
          value: column.name,
          label: column.type ? `${column.name} (${column.type})` : column.name,
        }))}
        filterOption={(inputValue, option) => (
          String(option?.value || '').toLowerCase().includes(inputValue.toLowerCase())
        )}
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
  examples = {},
  optionOverrides,
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
                  value={cubeSource.mode}
                  onChange={(mode) => cubeSource.onModeChange(mode as 'sql_table' | 'sql')}
                >
                  <Select.Option value="sql_table">Tabela SQL</Select.Option>
                  <Select.Option value="sql">SQL</Select.Option>
                </Select>
              </SchemaFieldInputCell>
              <SchemaFieldInputCell>
                {cubeSource.mode === 'sql' ? (
                  <Input.TextArea
                    rows={3}
                    value={values.sql ?? ''}
                    placeholder="Consulta SQL"
                    onChange={(event) => onChange('sql', event.target.value)}
                  />
                ) : (
                  <Input
                    value={values.sql_table ?? ''}
                    placeholder="schema.tabela"
                    onChange={(event) => onChange('sql_table', event.target.value)}
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
              {fieldControl(section, key, values[key], value => onChange(key, value), columns, optionOverrides)}
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
