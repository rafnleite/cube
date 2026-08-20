import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Tabs, Select, Input, Button, Empty, Typography, Tooltip, message, Dropdown, Menu, Checkbox } from 'antd';
import { load, dump } from 'js-yaml';
import styled from 'styled-components';
import autocompleteConfig from '../../config/schema-autocomplete.json';
import {
  CubeIcon,
  PlusOutlined,
  PrimaryKeyFontAwesomeIcon,
  QuestionOutlined,
  ReadmeOutlined,
  RulerCombinedIcon,
  TrashOutlined,
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
  normalizeMeasureFilters,
  PreAggregationForm,
  SegmentForm,
  AccessPolicyForm,
} from './SchemaEntityForms';
import { SchemaItemList } from './SchemaItemList';
import { SqlExpressionAutocomplete } from './SqlExpressionAutocomplete';
import { ConfirmPopover } from '../../components/ConfirmPopover';

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

const CubeSelector = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
`;

const CubeSelectorLabel = styled.span`
  color: rgba(0, 0, 0, 0.55);
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
`;

const CubeSelectorOption = styled.span`
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
`;

const CubeSelectorTitle = styled.span`
  overflow: hidden;
  color: rgba(0, 0, 0, 0.88);
  font-size: 13px;
  font-weight: 400;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CubeSelectorName = styled.span`
  overflow: hidden;
  color: rgba(0, 0, 0, 0.45);
  font-size: 11px;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CubeSelectorControl = styled(Select)`
  width: 250px;

  .ant-select-selector {
    min-height: 32px;
  }

  .ant-select-selection-item {
    display: flex;
    align-items: center;
  }
`;

const ModalShortcutAction = styled.div`
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  margin-left: 8px;
  vertical-align: bottom;
`;

const ModalShortcutHint = styled.span`
  margin-top: 2px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 10px;
  line-height: 12px;
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

const LIST_SECTIONS = ['joins', 'dimensions', 'hierarchies', 'measures', 'segments', 'pre_aggregations', 'access_policy'] as const;
type ListSection = typeof LIST_SECTIONS[number];
const VISUAL_EDITOR_ID = '__visualEditorId';

const SECTION_TITLES: Record<ListSection, string> = {
  hierarchies: 'Hierarquias',
  joins: 'Junções',
  dimensions: 'Dimensões',
  measures: 'Medidas',
  segments: 'Segmentos',
  pre_aggregations: 'Pré-agregações',
  access_policy: 'Políticas de acesso',
};

const ITEM_FIELD_ORDER: Record<string, string[]> = {
  joins: ['name', 'sql', 'relationship'],
  dimensions: ['title', 'name', 'description', 'sql', 'type', 'latitude', 'longitude', 'primary_key', 'public', 'shown', 'case', 'sub_query', 'format', 'meta'],
  measures: ['title', 'name', 'description', 'sql', 'type', 'public', 'format', 'drill_members', 'rolling_window', 'filters', 'case', 'meta'],
  hierarchies: ['title', 'name', 'public', 'levels'],
  segments: ['title', 'name', 'sql', 'description', 'public'],
  pre_aggregations: ['name', 'type', 'measures', 'dimensions', 'time_dimension', 'granularity', 'partition_granularity', 'refresh_key', 'external', 'scheduled_refresh', 'indexes'],
  access_policy: ['group', 'groups', 'conditions', 'member_level', 'row_level', 'member_masking'],
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
type VisualSchemaFile = { fileName: string; content?: string };
type VisualSchemaChange = { fileName: string; content: string };

const REMOTE_JOIN_FILE = '__visualEditorJoinFile';
const REMOTE_JOIN_CUBE = '__visualEditorJoinCube';

function parseVisualJoinColumns(sql: unknown, targetCube: string): { sourceColumn?: string; targetColumn?: string } {
  if (typeof sql !== 'string') return {};
  const expression = sql.trim().replace(/^`|`$/g, '');
  const escapedTarget = targetCube.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = expression.match(new RegExp(`^\\{CUBE\\}\\.([A-Za-z_][A-Za-z0-9_$]*)\\s*=\\s*\\{${escapedTarget}\\}\\.([A-Za-z_][A-Za-z0-9_$]*)$`));
  if (direct) return { sourceColumn: direct[1], targetColumn: direct[2] };
  const reverse = expression.match(new RegExp(`^\\{${escapedTarget}\\}\\.([A-Za-z_][A-Za-z0-9_$]*)\\s*=\\s*\\{CUBE\\}\\.([A-Za-z_][A-Za-z0-9_$]*)$`));
  if (reverse) return { sourceColumn: reverse[2], targetColumn: reverse[1] };
  return {};
}

function normalizeVisualRelationships(documents: Array<{ fileName: string; doc: CubeDoc }>): Set<string> {
  const cubes = new Map<string, { fileName: string; cube: CubeItem }>();
  documents.forEach(({ fileName, doc }) => {
    (doc.cubes || []).forEach(cube => {
      if (cube.name) cubes.set(String(cube.name), { fileName, cube });
    });
  });

  const moves: Array<{
    source: CubeItem;
    target: CubeItem;
    join: CubeItem;
    sourceColumn: string;
    targetColumn: string;
  }> = [];
  cubes.forEach(({ cube: source }) => {
    (source.joins || []).forEach((join: CubeItem) => {
      if (join.relationship !== 'one_to_many' || !join.name) return;
      const target = cubes.get(String(join.name))?.cube;
      const columns = parseVisualJoinColumns(join.sql, String(join.name));
      if (target && columns.sourceColumn && columns.targetColumn) {
        moves.push({
          source,
          target,
          join,
          sourceColumn: columns.sourceColumn,
          targetColumn: columns.targetColumn,
        });
      }
    });
  });

  const changedFiles = new Set<string>();
  moves.forEach(({ source, target, join, sourceColumn, targetColumn }) => {
    source.joins = (source.joins || []).filter((item: CubeItem) => item !== join);
    target.joins = Array.isArray(target.joins) ? target.joins : [];
    const movedJoin = {
      ...join,
      name: source.name,
      sql: `{CUBE}.${targetColumn} = {${source.name}}.${sourceColumn}`,
      relationship: 'many_to_one',
    };
    const existingIndex = target.joins.findIndex((item: CubeItem) => item.name === source.name);
    if (existingIndex >= 0) target.joins[existingIndex] = movedJoin;
    else target.joins.push(movedJoin);
    documents.forEach(({ fileName, doc }) => {
      if (doc.cubes?.includes(source) || doc.cubes?.includes(target)) changedFiles.add(fileName);
    });
  });
  return changedFiles;
}

/**
 * The scaffolding generator separates structural YAML blocks with blank
 * lines. Keep the visual editor output consistent with that generated style
 * while retaining js-yaml's safe scalar escaping and key ordering.
 */
function formatYamlLikeGeneratedModel(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const formatted: string[] = [];
  const listItemIndents = new Set<number>();

  const addBlankLine = () => {
    if (formatted.length > 0 && formatted[formatted.length - 1] !== '') {
      formatted.push('');
    }
  };

  const indentOf = (line: string) => (line.match(/^ */)?.[0].length || 0);
  const previousNonBlank = () => {
    for (let index = formatted.length - 1; index >= 0; index -= 1) {
      if (formatted[index].trim()) return formatted[index];
    }
    return null;
  };

  const cubeHasDataSource = (index: number) => {
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^ {2}-\s/.test(lines[next])) return false;
      if (/^ {4}data_source:/.test(lines[next])) return true;
    }
    return false;
  };

  lines.forEach((line, index) => {
    if (!line.trim()) {
      formatted.push(line);
      return;
    }

    const previous = previousNonBlank();
    const currentIndent = indentOf(line);
    const listItem = line.match(/^( *)-\s/);

    if (previous && listItem) {
      const previousIndent = indentOf(previous);
      if (listItemIndents.has(currentIndent) && previousIndent > currentIndent) {
        addBlankLine();
      }
      listItemIndents.add(currentIndent);
    } else if (previous && currentIndent < indentOf(previous)) {
      // A list or nested object has ended and the next property starts.
      addBlankLine();
    }

    formatted.push(line);

    const cubeProperty = line.match(/^ {4}(sql_table|data_source):/);
    const needsGeneratedBreak = cubeProperty
      && (cubeProperty[1] === 'data_source'
        || (cubeProperty[1] === 'sql_table' && !cubeHasDataSource(index)));
    if (needsGeneratedBreak && lines[index + 1]?.trim()) {
      addBlankLine();
    }
  });

  return formatted.join('\n').replace(/\n+$/, '\n');
}

function reorderObject(value: CubeItem, keys: string[]): CubeItem {
  const ordered: CubeItem = {};
  keys.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      ordered[key] = value[key];
    }
  });
  Object.keys(value).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
      ordered[key] = value[key];
    }
  });
  return ordered;
}

function reorderCubeForVisualEditor(value: CubeItem): CubeItem {
  const sourceKey = Object.prototype.hasOwnProperty.call(value, 'sql') ? 'sql' : 'sql_table';
  const cubeKeys = [
    'title',
    'name',
    'description',
    sourceKey,
    'extends',
    'data_source',
    'public',
    'refresh_key',
    ...LIST_SECTIONS,
  ];
  const ordered = reorderObject(value, cubeKeys);

  LIST_SECTIONS.forEach(section => {
    if (Array.isArray(ordered[section])) {
      ordered[section] = ordered[section].map((item: CubeItem) => (
        reorderObject(item, ITEM_FIELD_ORDER[section] || [])
      ));
    }
  });

  return ordered;
}

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
  files?: VisualSchemaFile[];
  tablesSchema?: TablesSchema;
  onClose: () => void;
  onSave: (content: string) => Promise<void> | void;
  onSaveFiles?: (changes: VisualSchemaChange[]) => Promise<void> | void;
};

export function CubeVisualEditor({ visible, fileName, yamlContent, files = [], tablesSchema, onClose, onSave, onSaveFiles }: Props) {
  const [doc, setDoc] = useState<CubeDoc | null>(null);
  const [externalDocs, setExternalDocs] = useState<Record<string, CubeDoc>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedCubeIndex, setSelectedCubeIndex] = useState<number | null>(null);
  const [dataSourceMode, setDataSourceMode] = useState<'sql_table' | 'sql'>('sql_table');
  const [activeTab, setActiveTab] = useState('cube');
  const [expandedItems, setExpandedItems] = useState<Partial<Record<ListSection, string[]>>>({});
  const [primaryKeyDraft, setPrimaryKeyDraft] = useState<PrimaryKeyDraft | null>(null);
  const editorIdCounter = useRef(0);
  const scrollTarget = useRef<string | null>(null);
  const dirtyExternalFiles = useRef(new Set<string>());

  function ensureEditorIds(next: CubeDoc) {
    (next.cubes || []).forEach((currentCube) => {
      LIST_SECTIONS.forEach((section) => {
        const items = currentCube[section];
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
        setSelectedCubeIndex(0);
        setDataSourceMode(parsed.cubes[0]?.sql !== undefined ? 'sql' : 'sql_table');
        setActiveTab('cube');
        setExpandedItems({});
        scrollTarget.current = null;
        setParseError(null);

        const parsedExternalDocs: Record<string, CubeDoc> = {};
        dirtyExternalFiles.current.clear();
        files.forEach(file => {
          if (file.fileName === fileName || !file.content || !/\.(ya?ml)$/i.test(file.fileName)) return;
          try {
            const external = load(file.content) as CubeDoc;
            if (external && Array.isArray(external.cubes) && external.cubes.length) {
              ensureEditorIds(external);
              parsedExternalDocs[file.fileName] = external;
            }
          } catch (_error) {
            // An unrelated invalid file should not prevent editing this file.
          }
        });
        setExternalDocs(parsedExternalDocs);
      } else {
        setDoc(null);
        setParseError('O editor visual funciona apenas para arquivos com pelo menos um cube.');
      }
    } catch (e: any) {
      setDoc(null);
      setParseError(`Não foi possível interpretar o YAML: ${e?.message || e}`);
    }
  }, [fileName, files, visible, yamlContent]);

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

  const cube: CubeItem | undefined = selectedCubeIndex === null
    ? undefined
    : doc?.cubes?.[selectedCubeIndex];

  const columns = useMemo(
    () => resolveColumnsForTable(cube?.sql_table, tablesSchema),
    [cube?.sql_table, tablesSchema]
  );

  const documentEntries = useMemo(
    () => [
      ...(doc ? [{ fileName, doc }] : []),
      ...Object.entries(externalDocs).map(([externalFileName, externalDoc]) => ({
        fileName: externalFileName,
        doc: externalDoc,
      })),
    ],
    [doc, externalDocs, fileName]
  );

  function originForJoin(item: CubeItem) {
    const originFileName = item[REMOTE_JOIN_FILE] as string | undefined;
    const originCubeName = item[REMOTE_JOIN_CUBE] as string | undefined;
    if (!originFileName || !originCubeName) {
      return cube;
    }
    return documentEntries
      .find(entry => entry.fileName === originFileName)
      ?.doc.cubes?.find(currentCube => currentCube.name === originCubeName);
  }

  function visibleItemsForSection(section: ListSection): CubeItem[] {
    if (section !== 'joins' || !cube?.name) {
      return (cube?.[section] || []) as CubeItem[];
    }

    const localJoins = ((cube.joins || []) as CubeItem[]);
    const remoteJoins = documentEntries.flatMap(entry => (
      entry.doc.cubes || []
    ).filter(otherCube => otherCube.name && otherCube.name !== cube.name).flatMap(otherCube => (
      ((otherCube.joins || []) as CubeItem[])
        .filter(join => join.name === cube.name)
        .map(join => ({
          ...join,
          [REMOTE_JOIN_FILE]: entry.fileName,
          [REMOTE_JOIN_CUBE]: otherCube.name,
        }))
    )));

    return [...localJoins, ...remoteJoins];
  }

  function locateVisualItem(section: ListSection, index: number, visualItem?: CubeItem) {
    const originFileName = visualItem?.[REMOTE_JOIN_FILE] as string | undefined;
    const originCubeName = visualItem?.[REMOTE_JOIN_CUBE] as string | undefined;
    if (!originFileName || !originCubeName) {
      return { fileName, cubeName: cube?.name, itemIndex: index };
    }

    const originDoc = originFileName === fileName ? doc : externalDocs[originFileName];
    const originCube = originDoc?.cubes?.find(currentCube => currentCube.name === originCubeName);
    const itemId = visualItem?.[VISUAL_EDITOR_ID];
    const itemIndex = (originCube?.[section] || []).findIndex((item: CubeItem) => item[VISUAL_EDITOR_ID] === itemId);
    return { fileName: originFileName, cubeName: originCubeName, itemIndex };
  }

  function updateExternalItem(section: ListSection, index: number, key: string, value: any, visualItem: CubeItem) {
    const location = locateVisualItem(section, index, visualItem);
    if (!location.fileName || !location.cubeName || location.itemIndex < 0) return;
    if (location.fileName === fileName) {
      updateDoc((next) => {
        const targetCube = next.cubes?.find(currentCube => currentCube.name === location.cubeName);
        const item = targetCube?.[section]?.[location.itemIndex];
        if (!item) return;
        if (value === '' || value === undefined || value === null) delete item[key];
        else item[key] = value;
      });
      message.info(`Esta junção está declarada em ${location.cubeName} e será salva nesse arquivo.`);
      return;
    }
    setExternalDocs(previous => {
      const next = structuredClone(previous);
      const targetCube = next[location.fileName]?.cubes?.find(currentCube => currentCube.name === location.cubeName);
      if (!targetCube) return previous;
      const item = targetCube[section]?.[location.itemIndex] || (targetCube[section] = [])[location.itemIndex] || {};
      if (value === '' || value === undefined || value === null) delete item[key];
      else item[key] = value;
      ensureEditorIds(next[location.fileName]);
      return next;
    });
    dirtyExternalFiles.current.add(location.fileName);
    message.info(`Esta junção está declarada em ${location.cubeName} e será salva no arquivo ${location.fileName}.`);
  }

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

    const markExpression = (expression: unknown, usage: Exclude<keyof ColumnUsage, 'joinNames'>) => {
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
      const c = next.cubes![selectedCubeIndex ?? 0];
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
      const c = next.cubes![selectedCubeIndex ?? 0];
      delete c[mode === 'sql' ? 'sql_table' : 'sql'];
    });
  }

  function addCube() {
    if (!doc) return;

    const existingNames = new Set((doc.cubes || []).map((currentCube) => String(currentCube.name || '')));
    let name = 'new_cube';
    let suffix = 2;
    while (existingNames.has(name)) {
      name = `new_cube_${suffix}`;
      suffix += 1;
    }

    const newIndex = doc.cubes?.length || 0;
    updateDoc((next) => {
      next.cubes = next.cubes || [];
      next.cubes.push({ name, sql_table: '' });
    });
    setSelectedCubeIndex(newIndex);
    setDataSourceMode('sql_table');
    setActiveTab('cube');
    setExpandedItems({});
  }

  function selectCube(index: number) {
    const selected = doc?.cubes?.[index];
    if (!selected) return;

    setSelectedCubeIndex(index);
    setDataSourceMode(selected.sql !== undefined ? 'sql' : 'sql_table');
    setActiveTab('cube');
    setExpandedItems({});
  }

  function removeCube(index: number) {
    if (!doc?.cubes || doc.cubes.length <= 1) {
      message.warning('O arquivo precisa manter pelo menos um cube.');
      return;
    }

    const next = structuredClone(doc);
    next.cubes!.splice(index, 1);
    setDoc(next);
    const nextIndex = Math.min(selectedCubeIndex ?? 0, next.cubes!.length - 1);
    setSelectedCubeIndex(nextIndex);
    setDataSourceMode(next.cubes![nextIndex]?.sql !== undefined ? 'sql' : 'sql_table');
    setActiveTab('cube');
    setExpandedItems({});
  }

  function renderCubeManager() {
    const cubes = doc?.cubes || [];

    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>Cubos do arquivo</Typography.Title>
            <Text type="secondary">Escolha um cubo para editar suas propriedades e componentes.</Text>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={addCube}>Adicionar cubo</Button>
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          {cubes.map((currentCube, index) => (
            <div
              key={`${currentCube[VISUAL_EDITOR_ID] || currentCube.name || 'cube'}-${index}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: 14,
                border: '1px solid #e5e5e5',
                borderRadius: 6,
                background: '#fafafa',
              }}
            >
              <CubeIcon style={{ color: '#7568d8', fontSize: 18 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Typography.Text strong>{currentCube.name || `Cubo ${index + 1}`}</Typography.Text>
                <div>
                  <Text type="secondary">
                    {currentCube.sql_table || currentCube.sql || 'Fonte SQL não definida'}
                  </Text>
                </div>
              </div>
              <Button onClick={() => selectCube(index)}>Gerenciar</Button>
              <ConfirmPopover
                title="Remover este cubo?"
                okText="Remover"
                cancelText="Cancelar"
                onConfirm={() => removeCube(index)}
              >
                <Button danger>Remover</Button>
              </ConfirmPopover>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function updateItemField(section: ListSection, index: number, key: string, value: any, visualItem?: CubeItem) {
    if (visualItem?.[REMOTE_JOIN_FILE]) {
      updateExternalItem(section, index, key, value, visualItem);
      return;
    }
    updateDoc((next) => {
      const c = next.cubes![selectedCubeIndex ?? 0];
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
      const c = next.cubes![selectedCubeIndex ?? 0];
      if (!Array.isArray(c[section])) {
        c[section] = [];
      }
      c[section].push(section === 'access_policy' ? { group: '*' } : { name: '' });
    });
  }

  function removeItem(section: ListSection, index: number, visualItem?: CubeItem) {
    if (visualItem?.[REMOTE_JOIN_FILE]) {
      const location = locateVisualItem(section, index, visualItem);
      if (!location.fileName || !location.cubeName || location.itemIndex < 0) return;
      if (location.fileName === fileName) {
        updateDoc((next) => {
          const targetCube = next.cubes?.find(currentCube => currentCube.name === location.cubeName);
          if (targetCube?.[section]) targetCube[section].splice(location.itemIndex, 1);
        });
        message.info(`Esta junção está declarada em ${location.cubeName} e será removida desse arquivo.`);
        return;
      }
      setExternalDocs(previous => {
        const next = structuredClone(previous);
        const targetCube = next[location.fileName]?.cubes?.find(currentCube => currentCube.name === location.cubeName);
        if (targetCube?.[section]) targetCube[section].splice(location.itemIndex, 1);
        return next;
      });
      dirtyExternalFiles.current.add(location.fileName);
      message.info(`Esta junção está declarada em ${location.cubeName} e será removida do arquivo ${location.fileName}.`);
      return;
    }
    updateDoc((next) => {
      next.cubes![selectedCubeIndex ?? 0][section].splice(index, 1);
    });
  }

  function reorderItem(section: ListSection, fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) {
      return;
    }

    updateDoc((next) => {
      const items = next.cubes![selectedCubeIndex ?? 0][section] as CubeItem[];
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
      : (cube && Array.isArray(cube[section]) ? cube[section].length : 0);

    updateDoc((next) => {
      const c = next.cubes![selectedCubeIndex ?? 0];
      if (!Array.isArray(c[section])) {
        c[section] = [];
      }

      const items = c[section] as CubeItem[];
      const baseName = section === 'measures'
        ? `${column.name}_count`
        : section === 'joins'
          ? `${column.name}_join`
          : column.name.toLowerCase();
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
      name: selectedColumns.length === 1 ? selectedColumns[0].toLowerCase() : 'primary_key',
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
      const c = next.cubes![selectedCubeIndex ?? 0];
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
    const items: CubeItem[] = visibleItemsForSection(section);

    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Button type="dashed" onClick={() => addItem(section)}>
            + {sectionConfig?.newItemLabel || 'Novo item'}
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
          getItemKey={(item, index) => `${item[REMOTE_JOIN_FILE] || fileName}:${item[REMOTE_JOIN_CUBE] || cube?.name || 'cube'}:${item[VISUAL_EDITOR_ID] || index}`}
          getItemTitle={(item) => section !== 'access_policy'
            ? item.title || item.name
            : section === 'access_policy'
              ? item.group || (Array.isArray(item.groups) ? item.groups.join(', ') : item.groups) || 'Política de acesso'
              : item.name}
          isPrimaryKey={(item) => section === 'dimensions' && Boolean(item.primary_key || item.primaryKey)}
          onToggle={(index) => toggleItem(section, index)}
          onRemove={(index) => removeItem(section, index, items[index])}
          onReorder={(fromIndex, toIndex) => {
            if (items[fromIndex]?.[REMOTE_JOIN_FILE] || items[toIndex]?.[REMOTE_JOIN_FILE]) return;
            reorderItem(section, fromIndex, toIndex);
          }}
          renderItemForm={(item, index) => {
            const itemOrigin = section === 'joins' ? originForJoin(item) : cube;
            const itemColumns = section === 'joins'
              ? resolveColumnsForTable(itemOrigin?.sql_table, tablesSchema)
              : columns;
            const formProps = {
              values: item,
              columns: itemColumns,
              tablesSchema,
              dimensionOptions: (cube?.dimensions || [])
                .map((dimension: any) => ({
                  name: String(dimension.name || ''),
                  title: typeof dimension.title === 'string' ? dimension.title : undefined,
                }))
                .filter((dimension: any) => dimension.name),
              onChange: (key: string, value: any) => updateItemField(section, index, key, value, item),
            };
            if (section === 'dimensions') return <DimensionForm {...formProps} />;
            if (section === 'measures') return <MeasureForm {...formProps} />;
            if (section === 'hierarchies') return <HierarchyForm {...formProps} />;
            if (section === 'joins') return (
              <>
                {item[REMOTE_JOIN_FILE] ? (
                  <div style={{ marginBottom: 12 }}>
                    <Text type="secondary">
                      Esta junção envolve este cubo, mas está declarada em <strong>{item[REMOTE_JOIN_CUBE]}</strong>.
                      As alterações serão salvas no arquivo <strong>{item[REMOTE_JOIN_FILE]}</strong>.
                    </Text>
                  </div>
                ) : null}
                <JoinForm {...formProps} />
              </>
            );
            if (section === 'segments') return <SegmentForm {...formProps} />;
            if (section === 'access_policy') return <AccessPolicyForm {...formProps} />;
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
    if (saving || !doc) {
      return;
    }

    const expressionText = (value: unknown): string => {
      if (typeof value === 'string') return value.trim();
      if (value && typeof value === 'object' && 'sql' in value) {
        return String((value as { sql?: unknown }).sql || '').trim();
      }
      return '';
    };

    for (const [cubeIndex, currentCube] of (doc.cubes || []).entries()) {
      for (const section of LIST_SECTIONS) {
        const items: CubeItem[] = (currentCube[section] || []) as CubeItem[];
      if (section !== 'access_policy' && items.some((item) => !item.name)) {
        message.error(`Todo item em ${SECTION_TITLES[section]} precisa de um nome`);
        return;
      }
      if (section === 'dimensions') {
        const invalidGeo = items.find(item => (
          item.type === 'geo'
          && (!expressionText(item.latitude) || !expressionText(item.longitude))
        ));
        if (invalidGeo) {
          message.error('Dimensões geo precisam informar o SQL da latitude e da longitude.');
          return;
        }
      }
      if (section === 'access_policy' && items.some((item) => !item.group && !item.groups)) {
        message.error('Toda política de acesso precisa informar group ou groups');
        return;
      }
      if ((section === 'dimensions' || section === 'measures') && items.some((item) => (
        item.case !== undefined
        && item.case !== null
        && (typeof item.case === 'string' || typeof item.case !== 'object' || Array.isArray(item.case))
      ))) {
        message.error(`O case de ${section === 'dimensions' ? 'uma dimensão' : 'uma medida'} precisa ser um objeto YAML válido.`);
        return;
      }
      }
    }

    const cleanDoc = structuredClone(doc);
    for (const cleanCube of cleanDoc.cubes || []) {
      for (const section of LIST_SECTIONS) {
      if (!Array.isArray(cleanCube[section]) || cleanCube[section].length === 0) {
        delete cleanCube[section];
        continue;
      }

      for (const item of cleanCube[section] as CubeItem[]) {
        if (section === 'measures') {
          const filters = normalizeMeasureFilters(item.filters);
          if (filters) item.filters = filters;
          else delete item.filters;
        }
        if (section === 'access_policy') {
          if (typeof item.groups === 'string') {
            item.groups = item.groups.split(',').map((group: string) => group.trim()).filter(Boolean);
          }
          for (const key of ['conditions', 'member_level', 'row_level', 'member_masking']) {
            if (typeof item[key] === 'string') {
              try {
                item[key] = load(item[key]);
              } catch (error: any) {
                message.error(`A política de acesso contém YAML/JSON inválido em '${key}': ${error?.message || error}`);
                return;
              }
            }
          }
        }
        delete item[VISUAL_EDITOR_ID];
      }
      }
      Object.assign(cleanCube, reorderCubeForVisualEditor(cleanCube));
    }
    const documentsToSave = documentEntries.map(entry => ({
      fileName: entry.fileName,
      doc: entry.fileName === fileName ? cleanDoc : structuredClone(entry.doc),
    }));
    documentsToSave.forEach(({ doc: document }) => {
      (document.cubes || []).forEach(currentCube => {
        LIST_SECTIONS.forEach(section => {
          if (!Array.isArray(currentCube[section])) return;
          currentCube[section].forEach((item: CubeItem) => delete item[VISUAL_EDITOR_ID]);
        });
      });
    });
    const normalizedFiles = normalizeVisualRelationships(documentsToSave);
    const filesToSave = new Set([fileName, ...dirtyExternalFiles.current, ...normalizedFiles]);
    const changes = documentsToSave
      .filter(entry => filesToSave.has(entry.fileName))
      .map(entry => ({
        fileName: entry.fileName,
        content: formatYamlLikeGeneratedModel(
          dump(entry.doc, { lineWidth: -1, noRefs: true, sortKeys: false })
        ),
      }));
    const content = changes.find(change => change.fileName === fileName)?.content || '';

    setSaving(true);
    try {
      if (changes.length > 1) {
        if (!onSaveFiles) {
          message.error('Este editor precisa salvar também o arquivo que declara a junção.');
          return;
        }
        await onSaveFiles(changes);
      } else {
        await onSave(content);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  function handleEditorKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSave();
    }
  }

  useEffect(() => {
    if (!visible) return undefined;

    const handleModalShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.case-builder-modal')) return;

      if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        void handleSave();
      }
    };

    document.addEventListener('keydown', handleModalShortcut, true);
    return () => document.removeEventListener('keydown', handleModalShortcut, true);
  }, [handleSave, onClose, visible]);

  return (
    <>
    <Modal
      title={(
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span>Editor visual — {fileName}</span>
          {doc && selectedCubeIndex !== null ? (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }} onClick={(event) => event.stopPropagation()}>
              <CubeSelector>
                <CubeSelectorLabel>Cubo em edição</CubeSelectorLabel>
              <CubeSelectorControl
                size="middle"
                value={selectedCubeIndex}
                optionLabelProp="label"
                aria-label="Selecionar cubo para editar"
                onChange={(value: any) => {
                  if (typeof value === 'number') selectCube(value);
                }}
                options={(doc.cubes || []).map((currentCube, index) => ({
                  value: index,
                  label: (
                    <CubeSelectorOption>
                      <CubeSelectorTitle>
                        {currentCube.title || currentCube.name || `Cubo ${index + 1}`}
                      </CubeSelectorTitle>
                      {currentCube.name ? (
                        <CubeSelectorName>{currentCube.name}</CubeSelectorName>
                      ) : null}
                    </CubeSelectorOption>
                  ),
                }))}
              />
              </CubeSelector>
              <Button
                type="dashed"
                size="middle"
                icon={<PlusOutlined />}
                title="Novo cubo"
                aria-label="Novo cubo"
                onClick={addCube}
              >
                Novo cubo
              </Button>
            </div>
          ) : null}
        </div>
      )}
      visible={visible}
      onCancel={onClose}
      closable={false}
      keyboard={false}
      className="cube-modal-wide"
      destroyOnClose
      footer={[
        <ModalShortcutAction key="cancel">
          <Button onClick={onClose}>Cancelar</Button>
          <ModalShortcutHint>Shift + Enter</ModalShortcutHint>
        </ModalShortcutAction>,
        <ModalShortcutAction key="save">
          <Button type="primary" loading={saving} disabled={!doc} onClick={handleSave}>Salvar</Button>
          <ModalShortcutHint>Ctrl + Enter</ModalShortcutHint>
        </ModalShortcutAction>,
      ]}
    >
      <div onKeyDownCapture={handleEditorKeyDown}>
        {parseError ? (
          <Empty description={parseError} />
        ) : !doc ? (
          <Empty description="Carregando..." />
        ) : !cube ? (
          <Empty description="Cubo não encontrado." />
        ) : (
          <>
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
                  {doc.cubes && doc.cubes.length > 1 ? (
                    <ConfirmPopover
                      title="Remover este cubo?"
                      okText="Remover"
                      cancelText="Cancelar"
                      onConfirm={() => removeCube(selectedCubeIndex ?? 0)}
                    >
                      <Button type="dashed" danger icon={<TrashOutlined />}>
                        Remover cubo
                      </Button>
                    </ConfirmPopover>
                  ) : <span />}
                  {renderDocumentationLink('cube')}
                </div>
                <CubeForm
                  values={cube}
                  columns={columns}
                  tablesSchema={tablesSchema}
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
          </>
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
            {primaryKeyDraft.customSql ? (
              <SqlExpressionAutocomplete
                value={primaryKeyDraft.sql}
                columns={columns}
                multiline
                placeholder="Ex.: CONCAT({CUBE}.airplane_code, '-', {CUBE}.seat_no)"
                style={{ marginTop: 6 }}
                onChange={(sql) => setPrimaryKeyDraft({ ...primaryKeyDraft, sql })}
              />
            ) : (
              <Input.TextArea
                rows={3}
                value={defaultPrimaryKeySql(primaryKeyDraft.selectedColumns)}
                readOnly
                placeholder="Selecione as colunas para visualizar o SQL"
                style={{ marginTop: 6, fontFamily: 'monospace' }}
              />
            )}
          </div>
        </div>
      ) : null}
    </Modal>
    </>
  );
}
