import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Tabs, Select, Input, Button, Empty, Typography, Tooltip, message, Dropdown, Menu, Checkbox } from 'antd';
import { load, dump } from 'js-yaml';
import styled, { createGlobalStyle } from 'styled-components';
import autocompleteConfig from '../../config/schema-autocomplete.json';
import {
  CubeIcon,
  PlusOutlined,
  PrimaryKeyFontAwesomeIcon,
  QuestionOutlined,
  ReadmeOutlined,
  RulerCombinedIcon,
} from '../../shared/icons/FontAwesomeIcons';
import {
  expressionReferencesColumn,
  inferDimensionType,
  TableColumn,
  TablesSchema,
  resolveColumnsForTable,
} from './cubeSchemaUtils';
import {
  SchemaFieldCell as FieldCell,
  SchemaFieldHelp as FieldHelp,
  SchemaFieldInputCell as FieldInputCell,
  SchemaFieldLabel as FieldLabel,
  SchemaFieldRow as FieldRow,
} from './SchemaFieldComponents';
import {
  CubeForm,
  DimensionForm,
  HierarchyForm,
  JoinForm,
  MeasureForm,
  PreAggregationForm,
  SegmentForm,
} from './SchemaEntityForms';
import { SchemaItemList } from './SchemaItemList';

const { TabPane } = Tabs;
const { Text } = Typography;

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
const VISUAL_EDITOR_ID = '__visualEditorId';

const SECTION_TITLES: Record<ListSection, string> = {
  hierarchies: 'Hierarquias',
  joins: 'Junções',
  dimensions: 'Dimensões',
  measures: 'Medidas',
  segments: 'Segmentos',
  pre_aggregations: 'Pré-agregações',
};

const VISUAL_EDITOR_DOCUMENTATION: Record<string, { label: string; url: string }> = {
  cube: {
    label: 'Documentação de cubos',
    url: 'https://docs.cube.dev/reference/data-modeling/cube',
  },
  joins: {
    label: 'Documentação de junções',
    url: 'https://docs.cube.dev/reference/data-modeling/joins',
  },
  dimensions: {
    label: 'Documentação de dimensões',
    url: 'https://docs.cube.dev/reference/data-modeling/dimensions',
  },
  hierarchies: {
    label: 'Documentação de hierarquias',
    url: 'https://docs.cube.dev/docs/data-modeling/dimensions#hierarchies',
  },
  measures: {
    label: 'Documentação de medidas',
    url: 'https://docs.cube.dev/reference/data-modeling/measures',
  },
  segments: {
    label: 'Documentação de segmentos',
    url: 'https://docs.cube.dev/reference/data-modeling/segments',
  },
  pre_aggregations: {
    label: 'Documentação de pré-agregações',
    url: 'https://docs.cube.dev/docs/pre-aggregations/getting-started-pre-aggregations',
  },
};

type CubeItem = Record<string, any>;
type CubeDoc = { cubes?: CubeItem[]; [key: string]: any };

type ColumnUsage = {
  join: boolean;
  joinNames: string[];
  primaryKey: boolean;
  dimension: boolean;
  measure: boolean;
};

type PrimaryKeyDraft = {
  name: string;
  selectedColumns: string[];
  customSql: boolean;
  sql: string;
};

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
  const [primaryKeyDraft, setPrimaryKeyDraft] = useState<PrimaryKeyDraft | null>(null);
  const editorIdCounter = useRef(0);
  const scrollTarget = useRef<string | null>(null);

  function ensureEditorIds(next: CubeDoc) {
    const firstCube = next.cubes?.[0];
    if (!firstCube) {
      return;
    }

    LIST_SECTIONS.forEach((section) => {
      const items = firstCube[section];
      if (!Array.isArray(items)) {
        return;
      }

      items.forEach((item: CubeItem) => {
        if (!item[VISUAL_EDITOR_ID]) {
          item[VISUAL_EDITOR_ID] = `${section}-${editorIdCounter.current}`;
          editorIdCounter.current += 1;
        }
      });
    });
  }

  useEffect(() => {
    if (!visible) {
      return;
    }

    try {
      const parsed = load(yamlContent) as CubeDoc;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cubes) && parsed.cubes.length) {
        ensureEditorIds(parsed);
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
      ensureEditorIds(next);
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

  function reorderItem(section: ListSection, fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) {
      return;
    }

    updateDoc((next) => {
      const items = next.cubes![0][section] as CubeItem[];
      const [item] = items.splice(fromIndex, 1);
      items.splice(toIndex, 0, item);
    });

    setExpandedItems((previous) => {
      const expanded = previous[section] || [];
      const remapped = expanded.map((key) => {
        const index = Number(key);
        if (index === fromIndex) return String(toIndex);
        if (fromIndex < toIndex && index > fromIndex && index <= toIndex) return String(index - 1);
        if (fromIndex > toIndex && index >= toIndex && index < fromIndex) return String(index + 1);
        return key;
      });
      return { ...previous, [section]: remapped };
    });
  }

  function toggleItem(section: ListSection, index: number) {
    setExpandedItems((previous) => {
      const key = String(index);
      const expanded = previous[section] || [];
      return {
        ...previous,
        [section]: expanded.includes(key)
          ? expanded.filter((itemKey) => itemKey !== key)
          : [...expanded, key],
      };
    });
  }

  function renderColumnActions(column: TableColumn) {
    const menu = (
      <Menu onClick={({ key }) => {
        if (key === 'primary-key') {
          openPrimaryKeyModal([column.name]);
          return;
        }
        addColumnItem(key as 'dimensions' | 'joins' | 'measures', column);
      }}>
        <Menu.Item key="dimensions">Nova dimensão</Menu.Item>
        <Menu.Item key="primary-key">Nova chave primária</Menu.Item>
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

  function addColumnItem(section: Extract<ListSection, 'dimensions' | 'joins' | 'measures'>, column: TableColumn) {
    const columnReference = `{CUBE}.${column.name}`;
    const usage = columnUsages[column.name];
    const isPrimaryKeyDimension = section === 'dimensions' && Boolean(usage?.primaryKey);
    const newIndex = isPrimaryKeyDimension
      ? 0
      : (Array.isArray(cube?.[section]) ? cube[section].length : 0);

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

      if (section === 'dimensions' && item.primary_key) {
        items.unshift(item);
      } else {
        items.push(item);
      }
    });

    setExpandedItems((previous) => ({
      ...previous,
      [section]: isPrimaryKeyDimension
        ? ['0', ...(previous[section] || []).map((index) => String(Number(index) + 1))]
        : [...(previous[section] || []), String(newIndex)],
    }));
    scrollTarget.current = `visual-editor-item-${section}-${newIndex}`;
    setActiveTab(section);
  }

  function defaultPrimaryKeySql(selectedColumns: string[]) {
    if (selectedColumns.length === 0) {
      return '';
    }
    if (selectedColumns.length === 1) {
      return `{CUBE}.${selectedColumns[0]}`;
    }
    return `CONCAT(${selectedColumns.map((column, index) => (
      index === 0 ? `{CUBE}.${column}` : `'-', {CUBE}.${column}`
    )).join(', ')})`;
  }

  function openPrimaryKeyModal(selectedColumns: string[] = []) {
    setPrimaryKeyDraft({
      name: selectedColumns.length === 1 ? selectedColumns[0] : 'primary_key',
      selectedColumns,
      customSql: false,
      sql: '',
    });
  }

  function createPrimaryKeyDimension() {
    if (!primaryKeyDraft || !cube) {
      return;
    }

    const selectedColumns = primaryKeyDraft.selectedColumns;
    const sql = primaryKeyDraft.customSql ? primaryKeyDraft.sql.trim() : defaultPrimaryKeySql(selectedColumns);
    if (selectedColumns.length === 0) {
      message.error('Selecione pelo menos uma coluna para a chave primária.');
      return;
    }
    if (!sql) {
      message.error('Informe o SQL da chave primária.');
      return;
    }
    if (!primaryKeyDraft.name.trim()) {
      message.error('Informe o nome da dimensão da chave primária.');
      return;
    }

    const requestedName = primaryKeyDraft.name.trim();
    updateDoc((next) => {
      const c = next.cubes![0];
      const dimensions = Array.isArray(c.dimensions) ? c.dimensions as CubeItem[] : [];
      let name = requestedName;
      let suffix = 2;
      while (dimensions.some((dimension) => dimension.name === name)) {
        name = `${requestedName}_${suffix}`;
        suffix += 1;
      }

      dimensions.unshift({
        name,
        sql,
        type: selectedColumns.length > 1
          ? 'string'
          : inferDimensionType(columns.find((column) => column.name === selectedColumns[0])?.type),
        primary_key: true,
      });
      c.dimensions = dimensions;
    });

    setExpandedItems((previous) => ({
      ...previous,
      dimensions: ['0', ...(previous.dimensions || []).map((index) => String(Number(index) + 1))],
    }));
    scrollTarget.current = 'visual-editor-item-dimensions-0';
    setActiveTab('dimensions');
    setPrimaryKeyDraft(null);
  }

  function renderListSection(section: ListSection) {
    const sectionConfig = schemaAutocomplete.yaml.sections[section];
    const items: CubeItem[] = (cube?.[section] || []) as CubeItem[];

    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Button type="dashed" onClick={() => addItem(section)}>
            + {sectionConfig?.newItemLabel || 'novo item'}
          </Button>
          {section === 'dimensions' ? (
            <Button type="dashed" onClick={() => openPrimaryKeyModal()} disabled={columns.length === 0}>
              + Nova chave primária
            </Button>
          ) : null}
          <span style={{ marginLeft: 'auto' }}>{renderDocumentationLink(section)}</span>
        </div>
        <SchemaItemList
          section={section}
          items={items}
          expandedKeys={expandedItems[section] || []}
          droppableId={`visual-editor-${section}`}
          emptyDescription={`Nenhum item em ${SECTION_TITLES[section]}`}
          getItemKey={(item) => String(item[VISUAL_EDITOR_ID])}
          getItemTitle={(item) => section === 'dimensions' ? item.title || item.name : item.name}
          isPrimaryKey={(item) => section === 'dimensions' && Boolean(item.primary_key || item.primaryKey)}
          onToggle={(index) => toggleItem(section, index)}
          onRemove={(index) => removeItem(section, index)}
          onReorder={(fromIndex, toIndex) => reorderItem(section, fromIndex, toIndex)}
          renderItemForm={(item, index) => {
            const formProps = {
              values: item,
              columns,
              onChange: (key: string, value: any) => updateItemField(section, index, key, value),
            };
            if (section === 'dimensions') return <DimensionForm {...formProps} />;
            if (section === 'measures') return <MeasureForm {...formProps} />;
            if (section === 'hierarchies') return <HierarchyForm {...formProps} />;
            if (section === 'joins') return <JoinForm {...formProps} />;
            if (section === 'segments') return <SegmentForm {...formProps} />;
            return <PreAggregationForm {...formProps} />;
          }}
        />
      </div>
    );
  }

  function renderDocumentationLink(section: string) {
    const documentation = VISUAL_EDITOR_DOCUMENTATION[section];
    if (!documentation) return null;

    return (
      <Typography.Link href={documentation.url} target="_blank" rel="noreferrer">
        <ReadmeOutlined style={{ marginRight: 6 }} />
        Ver documentação
      </Typography.Link>
    );
  }

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
        continue;
      }

      cleanCube[section].forEach((item: CubeItem) => {
        delete item[VISUAL_EDITOR_ID];
      });
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
    <>
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
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                  {renderDocumentationLink('cube')}
                </div>
                <CubeForm
                  values={cube}
                  columns={columns}
                  onChange={(key, value) => updateScalar(key, value)}
                  source={{ mode: dataSourceMode, onModeChange: updateDataSourceMode }}
                />
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
    <Modal
      title="Nova chave primária"
      visible={Boolean(primaryKeyDraft)}
      onCancel={() => setPrimaryKeyDraft(null)}
      maskClosable={false}
      destroyOnClose
      width={620}
      footer={[
        <Button key="cancel" onClick={() => setPrimaryKeyDraft(null)}>Cancelar</Button>,
        <Button key="create" type="primary" onClick={createPrimaryKeyDimension}>Criar dimensão</Button>,
      ]}
    >
      {primaryKeyDraft ? (
        <div>
          <FieldRow>
            <FieldLabel>Nome da dimensão</FieldLabel>
            <FieldInputCell>
              <Input
                value={primaryKeyDraft.name}
                placeholder="primary_key"
                onChange={(event) => setPrimaryKeyDraft({ ...primaryKeyDraft, name: event.target.value })}
              />
            </FieldInputCell>
            <FieldHelp>
              <Tooltip title="A dimensão será criada com primary_key: true.">
                <QuestionOutlined />
              </Tooltip>
            </FieldHelp>
          </FieldRow>
          <FieldRow>
            <FieldLabel>Colunas da chave</FieldLabel>
            <FieldInputCell>
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                value={primaryKeyDraft.selectedColumns}
                placeholder="Selecione uma ou mais colunas"
                onChange={(selected) => setPrimaryKeyDraft({
                  ...primaryKeyDraft,
                  selectedColumns: selected as string[],
                })}
                options={columns.map((column) => ({
                  value: column.name,
                  label: column.type ? `${column.name} (${column.type})` : column.name,
                }))}
              />
            </FieldInputCell>
            <FieldHelp />
          </FieldRow>
          <div style={{ marginTop: 14 }}>
            <Checkbox
              checked={primaryKeyDraft.customSql}
              onChange={(event) => setPrimaryKeyDraft({ ...primaryKeyDraft, customSql: event.target.checked })}
            >
              Escrever meu próprio SQL
            </Checkbox>
          </div>
          <div style={{ marginTop: 14 }}>
            <Text strong>{primaryKeyDraft.customSql ? 'SQL da dimensão' : 'SQL gerado'}</Text>
            <Input.TextArea
              rows={3}
              value={primaryKeyDraft.customSql ? primaryKeyDraft.sql : defaultPrimaryKeySql(primaryKeyDraft.selectedColumns)}
              readOnly={!primaryKeyDraft.customSql}
              placeholder={primaryKeyDraft.customSql ? 'Ex.: CONCAT({CUBE}.airplane_code, \'-\', {CUBE}.seat_no)' : 'Selecione as colunas para visualizar o SQL'}
              onChange={(event) => setPrimaryKeyDraft({ ...primaryKeyDraft, sql: event.target.value })}
              style={{ marginTop: 6, fontFamily: 'monospace' }}
            />
          </div>
        </div>
      ) : null}
    </Modal>
    </>
  );
}
