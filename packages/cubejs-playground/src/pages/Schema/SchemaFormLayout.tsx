import React from 'react';
import { Button, Input, Select, Tooltip } from 'antd';
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
import { MeasureFilterEditor } from './MeasureFilterEditor';

export type SchemaFormLayoutProps = {
  section: string;
  fields: string[];
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
  columns?: TableColumn[];
  tablesSchema?: TablesSchema;
  dimensionOptions?: Array<{ name: string; title?: string }>;
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
  dimensionOptions: Array<{ name: string; title?: string }>,
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

  if (key === 'filters' && section === 'measures') {
    return (
      <MeasureFilterEditor
        value={value}
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

  if (key === 'levels' && dimensionOptions.length > 0) {
    const normalizeLevel = (level: any): string => {
      if (typeof level === 'string') return level.trim();
      if (level && typeof level === 'object') {
        return String(level.name || level.value || '').trim();
      }
      return level == null ? '' : String(level).trim();
    };
    const selectedLevels = Array.isArray(value)
      ? value.map(normalizeLevel).filter(Boolean)
      : String(value || '').split(',').map(level => level.trim()).filter(Boolean);
    const labels = new Map(dimensionOptions.map(dimension => [dimension.name, dimension]));
    const availableDimensions = dimensionOptions.filter(dimension => !selectedLevels.includes(dimension.name));
    const moveLevel = (index: number, offset: number) => {
      const next = [...selectedLevels];
      const targetIndex = index + offset;
      if (targetIndex < 0 || targetIndex >= next.length) return;
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      onChange(next.length ? next : undefined);
    };

    return (
      <div>
        <Select
          showSearch
          style={{ width: '100%' }}
          value={undefined}
          placeholder="Adicionar dimensão"
          optionFilterProp="children"
          onChange={(next) => {
            const normalized = normalizeLevel(next);
            if (normalized && !selectedLevels.includes(normalized)) {
              onChange([...selectedLevels, normalized]);
            }
          }}
        >
          {availableDimensions.map(dimension => (
            <Select.Option key={dimension.name} value={dimension.name}>
              {dimension.title && dimension.title !== dimension.name
                ? `${dimension.title} (${dimension.name})`
                : dimension.name}
            </Select.Option>
          ))}
        </Select>
        {selectedLevels.length ? (
          <div style={{ marginTop: 8, border: '1px solid #f0f0f0', borderRadius: 4 }}>
            {selectedLevels.map((level, index) => {
              const dimension = labels.get(level);
              return (
                <div
                  key={`${level}-${index}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '5px 8px',
                    borderBottom: index < selectedLevels.length - 1 ? '1px solid #f0f0f0' : undefined,
                  }}
                >
                  <span style={{ width: 22, color: '#8c8c8c', fontSize: 12 }}>{index + 1}.</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {dimension?.title && dimension.title !== dimension.name ? dimension.title : level}
                    {dimension?.title && dimension.title !== dimension.name ? (
                      <span style={{ marginLeft: 6, color: '#8c8c8c', fontSize: 11 }}>({level})</span>
                    ) : null}
                  </span>
                  <Button type="text" size="small" disabled={index === 0} onClick={() => moveLevel(index, -1)} aria-label="Mover nível para cima">↑</Button>
                  <Button type="text" size="small" disabled={index === selectedLevels.length - 1} onClick={() => moveLevel(index, 1)} aria-label="Mover nível para baixo">↓</Button>
                  <Button type="text" size="small" danger onClick={() => onChange(selectedLevels.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remover ${level}`}>×</Button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
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
  dimensionOptions = [],
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
              {fieldControl(section, key, values[key], value => onChange(key, value), columns, tablesSchema, dimensionOptions, optionOverrides, multilineFields)}
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
