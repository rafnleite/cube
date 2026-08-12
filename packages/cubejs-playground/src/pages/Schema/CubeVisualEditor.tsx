import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Tabs, Collapse, Select, Input, Button, Popconfirm, AutoComplete, Empty, Typography, Tooltip, message, Dropdown, Menu } from 'antd';
import { load, dump } from 'js-yaml';
import styled, { createGlobalStyle } from 'styled-components';
import autocompleteConfig from '../../config/schema-autocomplete.json';
import {
  CubeIcon,
  PlusOutlined,
  PrimaryKeyFontAwesomeIcon,
  QuestionOutlined,
  RulerCombinedIcon,
} from '../../shared/icons/FontAwesomeIcons';
import { TableColumn, TablesSchema, resolveColumnsForTable } from './cubeSchemaUtils';

const { TabPane } = Tabs;
const { Panel } = Collapse;
const { Text } = Typography;
const FIELD_LABEL_WIDTH = 180;

const FieldTable = styled.div`
  width: 100%;
`;

const FieldRow = styled.div`
  display: grid;
  grid-template-columns: ${FIELD_LABEL_WIDTH}px minmax(0, 1fr) 36px;
  width: 100%;
  margin-top: -1px;
`;

const FieldCell = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 32px;
  border: 1px solid #d9d9d9;
  margin-left: -1px;
  background: #fff;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;

  &:focus-within {
    z-index: 2;
    border-color: #7568d8;
    box-shadow: 0 0 0 1px #7568d8, 0 3px 10px rgba(75, 70, 119, 0.16);
  }
`;

const FieldLabel = styled(FieldCell)`
  margin-left: 0;
  padding: 5px 11px;
  color: rgba(0, 0, 0, 0.65);
  background: #fafafa;
  font-size: 13px;
`;

const FieldInputCell = styled(FieldCell)`
  align-items: stretch;
  padding: 0;

  & > .ant-input,
  & > .ant-input-affix-wrapper,
  & > .ant-input-number,
  & > .ant-select,
  & > .ant-auto-complete {
    flex: 1;
    width: 100%;
  }

  & .ant-input,
  & .ant-input-affix-wrapper,
  & .ant-input-number,
  & .ant-select-selector,
  & .ant-auto-complete .ant-input {
    height: 100%;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }

  & .ant-select-selection-item,
  & .ant-select-selection-placeholder {
    color: rgba(0, 0, 0, 0.65) !important;
    font-size: 13px;
  }

  & > .ant-select .ant-select-selector {
    background: inherit !important;
  }

  & .ant-select-arrow {
    color: rgba(0, 0, 0, 0.45);
  }
`;

const FieldHelp = styled(FieldCell)`
  justify-content: center;
  align-items: center;
  color: rgba(0, 0, 0, 0.45);
  cursor: help;
`;

const ColumnUsageIcons = styled.span`
  display: inline-flex;
  flex: 0 0 44px;
  align-items: center;
  gap: 4px;
`;

const ColumnActionButton = styled(Button)`
  position: absolute;
  top: 50%;
  right: 0;
  z-index: 1;
  width: 22px;
  height: 22px;
  padding: 0;
  transform: translateY(-50%);
  color: rgba(0, 0, 0, 0.45);
`;

const EditorOverlayStyles = createGlobalStyle`
  .cube-remove-popconfirm .ant-popover-inner-content {
    min-width: 190px;
    padding: 14px 16px 12px;
  }

  .cube-remove-popconfirm .ant-popover-message {
    padding: 0 0 12px;
  }

  .cube-remove-popconfirm .ant-popover-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin: 0;
  }

  .cube-remove-popconfirm .ant-popover-buttons button {
    margin-left: 0;
  }
`;

type SchemaSectionConfig = {
  keys: string[];
  values?: Record<string, string[]>;
  newItemLabel?: string;
  descriptions?: Record<string, string>;
};

type SchemaAutocompleteConfig = {
  yaml: {
    booleanKeys: string[];
    sections: Record<string, SchemaSectionConfig>;
  };
};

const schemaAutocomplete = autocompleteConfig as SchemaAutocompleteConfig;

const LIST_SECTIONS = ['joins', 'dimensions', 'hierarchies', 'measures', 'segments', 'pre_aggregations'] as const;
type ListSection = typeof LIST_SECTIONS[number];

const SECTION_TITLES: Record<ListSection, string> = {
  hierarchies: 'Hierarquias',
  joins: 'Junções',
  dimensions: 'Dimensões',
  measures: 'Medidas',
  segments: 'Segmentos',
  pre_aggregations: 'Pré-agregações',
};

const PROPERTY_LABELS: Record<string, string> = {
  hierarchies: 'Hierarquias',
  name: 'Nome',
  sql: 'SQL',
  sql_table: 'Tabela SQL',
  extends: 'Herda de',
  data_source: 'Fonte de dados',
  public: 'Público',
  shown: 'Exibido',
  title: 'Título',
  description: 'Descrição',
  type: 'Tipo',
  format: 'Formato',
  meta: 'Metadados',
  refresh_key: 'Chave de autorização',
  cubes: 'Cubos',
  joins: 'Junções',
  dimensions: 'Dimensões',
  measures: 'Medidas',
  segments: 'Segmentos',
  pre_aggregations: 'Pré-agregações',
  includes: 'Inclui',
  excludes: 'Exclui',
  relationship: 'Relacionamento',
  primary_key: 'Chave primária',
  case: 'Condição',
  sub_query: 'Subconsulta',
  drill_members: 'Membros de detalhamento',
  rolling_window: 'Janela móvel',
  filters: 'Filtros',
  time_dimension: 'Dimensão temporal',
  granularity: 'Granularidade',
  partition_granularity: 'Granularidade de particionamento',
  external: 'Externa',
  scheduled_refresh: 'Atualização agendada',
  indexes: 'Índices',
};

const SQL_COLUMN_SECTIONS = new Set(['dimensions', 'measures', 'segments']);

const FIELD_EXAMPLES: Record<string, Record<string, string>> = {
  cubes: {
    title: 'Cartoes de embarque',
    name: 'boarding_passes',
    description: 'Cartoes emitidos para cada voo.',
    sql_table: 'bookings.boarding_passes',
    sql: 'SELECT * FROM bookings.boarding_passes',
    extends: 'base_cube',
    data_source: 'default',
    public: 'true',
    refresh_key: 'every: 1 hour',
  },
  joins: {
    name: 'flights',
    sql: '{CUBE}.flight_id = {flights}.flight_id',
    relationship: 'many_to_one',
  },
  hierarchies: {
    name: 'location',
    title: 'Localizacao',
    public: 'true',
    levels: 'country, state, city',
  },
  dimensions: {
    title: 'Horario de embarque',
    name: 'boarding_time',
    description: 'Horario programado para o embarque.',
    sql: '{CUBE}.boarding_time',
    type: 'time',
    primary_key: 'true',
    public: 'true',
    shown: 'true',
    case: 'WHEN {CUBE}.status = \'cancelled\' THEN \'Cancelado\'',
    sub_query: 'true',
    format: 'currency',
    meta: '{ source: ERP }',
  },
  measures: {
    name: 'revenue',
    sql: '{CUBE}.amount',
    type: 'sum',
    public: 'true',
    title: 'Receita',
    description: 'Valor total das vendas.',
    format: 'currency',
    drill_members: 'id, customer_name',
    rolling_window: 'trailing: 7 day',
    filters: "{CUBE}.status = 'confirmed'",
    meta: '{ source: ERP }',
  },
  segments: {
    name: 'active',
    sql: "{CUBE}.status = 'active'",
    title: 'Ativos',
    description: 'Registros ativos.',
    public: 'true',
  },
  pre_aggregations: {
    name: 'daily_rollup',
    type: 'rollup',
    measures: 'count, revenue',
    dimensions: 'status, airport_code',
    time_dimension: 'boarding_time',
    granularity: 'day',
    partition_granularity: 'month',
    refresh_key: 'every: 1 hour',
    external: 'true',
    scheduled_refresh: 'true',
    indexes: 'status, airport_code',
  },
};

function inferDimensionType(columnType?: string): string {
  const normalizedType = String(columnType || '').toLowerCase();
  if (/timestamp|date|time/.test(normalizedType)) {
    return 'time';
  }
  if (/bool/.test(normalizedType)) {
    return 'boolean';
  }
  if (/int|numeric|decimal|real|double|float|number/.test(normalizedType)) {
    return 'number';
  }
  return 'string';
}

type CubeItem = Record<string, any>;
type CubeDoc = { cubes?: CubeItem[]; [key: string]: any };

type ColumnUsage = {
  join: boolean;
  joinNames: string[];
  primaryKey: boolean;
  dimension: boolean;
  measure: boolean;
};

function expressionReferencesColumn(expression: unknown, columnName: string): boolean {
  if (typeof expression !== 'string' || !expression.trim()) {
    return false;
  }

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

type Props = {
  visible: boolean;
  fileName: string;
  yamlContent: string;
  tablesSchema?: TablesSchema;
  onClose: () => void;
  onSave: (content: string) => Promise<void> | void;
};

export function CubeVisualEditor({ visible, fileName, yamlContent, tablesSchema, onClose, onSave }: Props) {
  const [doc, setDoc] = useState<CubeDoc | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dataSourceMode, setDataSourceMode] = useState<'sql_table' | 'sql'>('sql_table');
  const [activeTab, setActiveTab] = useState('cube');
  const [expandedItems, setExpandedItems] = useState<Partial<Record<ListSection, string[]>>>({});
  const scrollTarget = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    try {
      const parsed = load(yamlContent) as CubeDoc;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cubes) && parsed.cubes.length) {
        setDoc(parsed);
        setDataSourceMode(parsed.cubes[0]?.sql !== undefined ? 'sql' : 'sql_table');
        setActiveTab('cube');
        setExpandedItems({});
        scrollTarget.current = null;
        setParseError(null);
      } else {
        setDoc(null);
        setParseError('O editor visual funciona apenas para arquivos com pelo menos um cube.');
      }
    } catch (e: any) {
      setDoc(null);
      setParseError(`Não foi possível interpretar o YAML: ${e?.message || e}`);
    }
  }, [visible, yamlContent]);

  useEffect(() => {
    const target = scrollTarget.current;
    if (!target) {
      return;
    }

    const element = document.querySelector(`.${target}`);
    if (!element) {
      return;
    }

    requestAnimationFrame(() => {
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (scrollTarget.current === target) {
        scrollTarget.current = null;
      }
    });
  }, [activeTab, expandedItems, doc]);

  const cube: CubeItem | undefined = doc?.cubes?.[0];

  const columns = useMemo(
    () => resolveColumnsForTable(cube?.sql_table, tablesSchema),
    [cube?.sql_table, tablesSchema]
  );

  const columnUsages = useMemo<Record<string, ColumnUsage>>(() => {
    const usages: Record<string, ColumnUsage> = Object.fromEntries(
      columns.map((column) => [column.name, {
        join: false,
        joinNames: [],
        primaryKey: false,
        dimension: false,
        measure: false,
      }])
    );

    const markExpression = (expression: unknown, usage: keyof ColumnUsage) => {
      columns.forEach((column) => {
        if (expressionReferencesColumn(expression, column.name)) {
          usages[column.name][usage] = true;
        }
      });
    };

    (cube?.dimensions || []).forEach((dimension: CubeItem) => {
      const expression = dimension.sql || dimension.name;
      const isPrimaryKeyDimension = Boolean(dimension.primary_key || dimension.primaryKey);
      if (isPrimaryKeyDimension) {
        // A primary key can be composed from multiple columns, so every
        // column referenced by its SQL expression must receive the key icon.
        markExpression(expression, 'primaryKey');
      } else {
        markExpression(expression, 'dimension');
      }
    });
    (cube?.measures || []).forEach((measure: CubeItem) => {
      markExpression(measure.sql, 'measure');
    });
    (cube?.joins || []).forEach((join: CubeItem, index: number) => {
      columns.forEach((column) => {
        if (expressionReferencesColumn(join.sql, column.name)) {
          usages[column.name].join = true;
          usages[column.name].joinNames.push(String(join.name || `join ${index + 1}`));
        }
      });
    });

    return usages;
  }, [columns, cube]);

  function updateDoc(mutate: (next: CubeDoc) => void) {
    setDoc((prev) => {
      if (!prev) {
        return prev;
      }
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
  }

  function updateScalar(key: string, value: any) {
    updateDoc((next) => {
      const c = next.cubes![0];
      if (value === '' || value === undefined || value === null) {
        delete c[key];
      } else {
        c[key] = value;
      }
    });
  }

  function updateDataSourceMode(mode: 'sql_table' | 'sql') {
    setDataSourceMode(mode);
    updateDoc((next) => {
      const c = next.cubes![0];
      delete c[mode === 'sql' ? 'sql_table' : 'sql'];
    });
  }

  function updateItemField(section: ListSection, index: number, key: string, value: any) {
    updateDoc((next) => {
      const c = next.cubes![0];
      if (!Array.isArray(c[section])) {
        c[section] = [];
      }
      const item = c[section][index] || (c[section][index] = {});
      if (value === '' || value === undefined || value === null) {
        delete item[key];
      } else {
        item[key] = value;
      }
    });
  }

  function addItem(section: ListSection) {
    updateDoc((next) => {
      const c = next.cubes![0];
      if (!Array.isArray(c[section])) {
        c[section] = [];
      }
      c[section].push({ name: '' });
    });
  }

  function removeItem(section: ListSection, index: number) {
    updateDoc((next) => {
      next.cubes![0][section].splice(index, 1);
    });
  }

  function renderColumnActions(column: TableColumn) {
    const menu = (
      <Menu onClick={({ key }) => addColumnItem(key as 'dimensions' | 'joins' | 'measures', column)}>
        <Menu.Item key="dimensions">Nova dimensão</Menu.Item>
        <Menu.Item key="joins">Nova junção</Menu.Item>
        <Menu.Item key="measures">Nova medida</Menu.Item>
      </Menu>
    );

    return (
      <Dropdown overlay={menu} trigger={['click']} placement="bottomLeft">
        <ColumnActionButton
          type="text"
          size="small"
          aria-label={`Adicionar elemento para ${column.name}`}
          onClick={(event) => event.stopPropagation()}
        >
          <PlusOutlined />
        </ColumnActionButton>
      </Dropdown>
    );
  }

  function renderHelp(sectionName: string, key: string) {
    const description = schemaAutocomplete.yaml.sections[sectionName]?.descriptions?.[key];
    const example = FIELD_EXAMPLES[sectionName]?.[key];
    const tooltip = description || example ? (
      <div>
        {description ? <div>{description}</div> : null}
        {example ? <div style={{ marginTop: 6 }}><strong>Exemplo:</strong> {example}</div> : null}
      </div>
    ) : undefined;

    return (
      <Tooltip title={tooltip}>
        <FieldHelp>
          <QuestionOutlined />
        </FieldHelp>
      </Tooltip>
    );
  }

  function addColumnItem(section: Extract<ListSection, 'dimensions' | 'joins' | 'measures'>, column: TableColumn) {
    const columnReference = `{CUBE}.${column.name}`;
    const usage = columnUsages[column.name];
    const newIndex = Array.isArray(cube?.[section]) ? cube[section].length : 0;

    updateDoc((next) => {
      const c = next.cubes![0];
      if (!Array.isArray(c[section])) {
        c[section] = [];
      }

      const items = c[section] as CubeItem[];
      const baseName = section === 'measures' ? `${column.name}_count` : section === 'joins' ? `${column.name}_join` : column.name;
      let name = baseName;
      let suffix = 2;
      while (items.some((item) => item.name === name)) {
        name = `${baseName}_${suffix}`;
        suffix += 1;
      }

      const item: CubeItem = section === 'dimensions'
        ? {
          name,
          sql: columnReference,
          type: inferDimensionType(column.type),
          ...(usage?.primaryKey ? { primary_key: true } : {}),
        }
        : section === 'measures'
          ? { name, sql: columnReference, type: 'count' }
          : {
            name,
            sql: `${columnReference} = {joined_cube}.${column.name}`,
            relationship: 'many_to_one',
          };

      items.push(item);
    });

    setExpandedItems((previous) => ({
      ...previous,
      [section]: [...(previous[section] || []), String(newIndex)],
    }));
    scrollTarget.current = `visual-editor-item-${section}-${newIndex}`;
    setActiveTab(section);
  }

  function renderFieldRow(
    sectionName: string,
    key: string,
    item: CubeItem,
    onChange: (value: any) => void,
  ) {
    return (
      <FieldRow key={key}>
        <FieldLabel>{PROPERTY_LABELS[key] || key}</FieldLabel>
        <FieldInputCell>{renderField(sectionName, key, item, onChange)}</FieldInputCell>
        {renderHelp(sectionName, key)}
      </FieldRow>
    );
  }

  function renderField(sectionName: string, key: string, item: CubeItem, onChange: (value: any) => void) {
    const sectionConfig = schemaAutocomplete.yaml.sections[sectionName];
    const enumValues = sectionConfig?.values?.[key];
    const isBoolean = schemaAutocomplete.yaml.booleanKeys.includes(key);
    const isSqlColumn = key === 'sql' && SQL_COLUMN_SECTIONS.has(sectionName);
    const value = item[key];

    if (key === 'description') {
      return (
        <Input.TextArea
          rows={2}
          value={value ?? ''}
          placeholder="(vazio)"
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }

    if (key === 'levels') {
      return (
        <Input
          value={Array.isArray(value) ? value.join(', ') : value ?? ''}
          placeholder="dimensao 1, dimensao 2"
          onChange={(e) => {
            const levels = e.target.value.split(',').map((level) => level.trim()).filter(Boolean);
            onChange(levels.length ? levels : undefined);
          }}
        />
      );
    }

    if (enumValues) {
      return (
        <Select allowClear style={{ width: '100%' }} value={value} placeholder="(vazio)" onChange={onChange}>
          {enumValues.map((option) => <Select.Option key={option} value={option}>{option}</Select.Option>)}
        </Select>
      );
    }

    if (isBoolean) {
      return (
        <Select
          allowClear
          style={{ width: '100%' }}
          value={value === undefined ? undefined : String(value)}
          placeholder="(vazio)"
          onChange={(next) => onChange(next === undefined ? undefined : next === 'true')}
        >
          <Select.Option value="true">true</Select.Option>
          <Select.Option value="false">false</Select.Option>
        </Select>
      );
    }

    if (isSqlColumn) {
      return (
        <AutoComplete
          style={{ width: '100%' }}
          value={value}
          placeholder="coluna ou expressão sql"
          onChange={onChange}
          options={columns.map((column) => ({
            value: column.name,
            label: column.type ? `${column.name} (${column.type})` : column.name,
          }))}
          filterOption={(inputValue, option) =>
            String(option?.value || '').toLowerCase().includes(inputValue.toLowerCase())
          }
        />
      );
    }

    return <Input value={value ?? ''} placeholder="(vazio)" onChange={(e) => onChange(e.target.value)} />;
  }

  function renderListSection(section: ListSection) {
    const sectionConfig = schemaAutocomplete.yaml.sections[section];
    const items: CubeItem[] = (cube?.[section] || []) as CubeItem[];

    return (
      <div>
        <Button type="dashed" style={{ marginBottom: 12 }} onClick={() => addItem(section)}>
          + {sectionConfig?.newItemLabel || 'novo item'}
        </Button>
        {items.length === 0 ? (
          <Empty description={`Nenhum item em ${SECTION_TITLES[section]}`} />
        ) : (
          <Collapse
            activeKey={expandedItems[section] || []}
            onChange={(keys) => setExpandedItems((previous) => ({
              ...previous,
              [section]: Array.isArray(keys) ? keys : [keys],
            }))}
          >
            {items.map((item, idx) => (
              <Panel
                key={String(idx)}
                className={`visual-editor-item-${section}-${idx}`}
                header={(section === 'dimensions' ? item.title || item.name : item.name) || '(sem nome)'}
                extra={(
                  <Popconfirm
                    title="Remover este item?"
                    overlayClassName="cube-remove-popconfirm"
                    onConfirm={() => removeItem(section, idx)}
                  >
                    <Button danger size="small" onClick={(e) => e.stopPropagation()}>Remover</Button>
                  </Popconfirm>
                )}
              >
                <FieldTable>
                  {(sectionConfig?.keys || []).map((key) => renderFieldRow(
                    section,
                    key,
                    item,
                    (value) => updateItemField(section, idx, key, value),
                  ))}
                </FieldTable>
              </Panel>
            ))}
          </Collapse>
        )}
      </div>
    );
  }

  const cubeScalarKeys = [
    'title',
    'name',
    'description',
    'extends',
    'data_source',
    'public',
    'refresh_key',
  ];

  async function handleSave() {
    if (!doc || !cube) {
      return;
    }

    for (const section of LIST_SECTIONS) {
      const items: CubeItem[] = (cube[section] || []) as CubeItem[];
      if (items.some((item) => !item.name)) {
        message.error(`Todo item em ${SECTION_TITLES[section]} precisa de um nome`);
        return;
      }
    }

    const cleanDoc = structuredClone(doc);
    const cleanCube = cleanDoc.cubes![0];
    for (const section of LIST_SECTIONS) {
      if (!Array.isArray(cleanCube[section]) || cleanCube[section].length === 0) {
        delete cleanCube[section];
      }
    }

    const content = dump(cleanDoc, { lineWidth: -1, noRefs: true, sortKeys: false });

    setSaving(true);
    try {
      await onSave(content);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  function handleEditorKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void handleSave();
    }
  }

  return (
    <Modal
      title={`Editor visual — ${fileName}`}
      visible={visible}
      onCancel={onClose}
      width={1100}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onClose}>Cancelar</Button>,
        <Button key="save" type="primary" loading={saving} disabled={!cube} onClick={handleSave}>Salvar</Button>,
      ]}
    >
      <EditorOverlayStyles />
      <div onKeyDown={handleEditorKeyDown}>
        {parseError ? (
          <Empty description={parseError} />
        ) : !cube ? (
          <Empty description="Carregando..." />
        ) : (
          <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ width: 220, flexShrink: 0 }}>
            <Text strong>Colunas da tabela</Text>
            <div style={{ marginTop: 8, maxHeight: 480, overflowY: 'auto' }}>
              {columns.length === 0 ? (
                <Text type="secondary">Nenhuma coluna encontrada para {cube.sql_table}</Text>
              ) : (
                columns.map((column) => {
                  const usage = columnUsages[column.name];
                  const titledDimension = (cube.dimensions || []).find((dimension: CubeItem) =>
                    dimension.title && (
                      String(dimension.name || '').toLowerCase() === column.name.toLowerCase()
                      || expressionReferencesColumn(dimension.sql, column.name)
                    )
                  );
                  const columnTitle = titledDimension?.title || column.name;
                  const hasUsageIcons = Boolean(usage?.primaryKey || usage?.join || usage?.dimension || usage?.measure);
                  const joinTooltip = usage?.joinNames?.length
                    ? `. Usada nos joins: ${usage.joinNames.join(', ')}`
                    : '';
                  const keyTitle = usage?.primaryKey && usage.join
                    ? 'Chave primária e usada em join'
                    : usage?.primaryKey
                      ? 'Chave primária'
                      : 'Usada em join';

                  return (
                    <div key={column.name} style={{ position: 'relative', padding: '4px 28px 4px 0', borderBottom: '1px solid #f0f0f0' }}>
                      <div style={{ lineHeight: '20px' }}>{columnTitle}</div>
                      {hasUsageIcons ? (
                        <div style={{ display: 'flex', alignItems: 'center', minHeight: 22 }}>
                        <ColumnUsageIcons>
                          {usage?.primaryKey || usage?.join ? (
                            <Tooltip title={`${keyTitle}${joinTooltip}`}>
                              <PrimaryKeyFontAwesomeIcon style={{ color: '#ad6800', fontSize: 13 }} />
                            </Tooltip>
                          ) : null}
                          {usage?.dimension ? (
                            <Tooltip title="Usada como dimensão">
                              <CubeIcon style={{ color: '#7568d8', fontSize: 13 }} />
                            </Tooltip>
                          ) : null}
                          {usage?.measure ? (
                            <Tooltip title="Usada como medida">
                              <RulerCombinedIcon style={{ color: '#389e0d', fontSize: 13 }} />
                            </Tooltip>
                          ) : null}
                        </ColumnUsageIcons>
                        </div>
                      ) : null}
                      {renderColumnActions(column)}
                      {column.type ? <Text type="secondary" style={{ fontSize: 12 }}>{column.type}</Text> : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Tabs activeKey={activeTab} onChange={setActiveTab}>
              <TabPane tab="Cubo" key="cube">
                <FieldTable>
                  {cubeScalarKeys.slice(0, 3).map((key) => renderFieldRow(
                    'cubes',
                    key,
                    cube,
                    (value) => updateScalar(key, value),
                  ))}

                  <FieldRow>
                    <FieldInputCell style={{ marginLeft: 0, background: '#fafafa' }}>
                      <Select
                        value={dataSourceMode}
                        onChange={(mode) => updateDataSourceMode(mode as 'sql_table' | 'sql')}
                      >
                        <Select.Option value="sql_table">Tabela SQL</Select.Option>
                        <Select.Option value="sql">SQL</Select.Option>
                      </Select>
                    </FieldInputCell>
                    <FieldInputCell>
                      {dataSourceMode === 'sql' ? (
                        <Input.TextArea
                          rows={3}
                          value={cube.sql ?? ''}
                          placeholder="Consulta SQL"
                          onChange={(e) => updateScalar('sql', e.target.value)}
                        />
                      ) : (
                        <Input
                          value={cube.sql_table ?? ''}
                          placeholder="schema.tabela"
                          onChange={(e) => updateScalar('sql_table', e.target.value)}
                        />
                      )}
                    </FieldInputCell>
                    {renderHelp('cubes', dataSourceMode)}
                  </FieldRow>

                  {cubeScalarKeys.slice(3).map((key) => renderFieldRow(
                    'cubes',
                    key,
                    cube,
                    (value) => updateScalar(key, value),
                  ))}
                </FieldTable>
              </TabPane>
              {LIST_SECTIONS.map((section) => (
                <TabPane tab={SECTION_TITLES[section]} key={section}>
                  {renderListSection(section)}
                </TabPane>
              ))}
            </Tabs>
          </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
