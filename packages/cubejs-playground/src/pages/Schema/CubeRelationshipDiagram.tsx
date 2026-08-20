import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  Menu,
} from 'antd';
import {
  ApartmentOutlined,
  CubeIcon,
  MoreOutlined,
  PrimaryKeyFontAwesomeIcon,
  ReadmeOutlined,
  ReloadOutlined,
  RulerCombinedIcon,
  SearchOutlined,
  ViewIcon,
  ViewOffIcon,
} from '../../shared/icons/FontAwesomeIcons';
import {
  Background,
  BaseEdge,
  Connection,
  Controls,
  EdgeLabelRenderer,
  Edge,
  Handle,
  MiniMap,
  Node,
  Position,
  ReactFlow,
  ReactFlowInstance,
  getBezierPath,
  EdgeProps,
  useNodesState,
  useUpdateNodeInternals,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import styled from 'styled-components';

import { playgroundFetch, responseErrorMessage } from '../../shared/helpers';
import { CubeSampleDataModal } from './CubeSampleDataModal';
import { ConfirmPopover } from '../../components/ConfirmPopover';
import { expressionReferencesColumn, inferDimensionType, TablesSchema } from './cubeSchemaUtils';
import {
  CubeForm,
  DimensionForm,
  HierarchyForm,
  MeasureForm,
  normalizeMeasureFilters,
  PreAggregationForm,
  SegmentForm,
} from './SchemaEntityForms';

const { Text } = Typography;

type DiagramColumn = {
  name: string;
  type?: string;
  primaryKey?: boolean;
};

type DiagramDimension = {
  diagramItemId?: string;
  name: string;
  title?: string;
  sql?: string;
  type?: string;
  latitude?: { sql?: string };
  longitude?: { sql?: string };
  primaryKey?: boolean;
};

type DiagramMeasure = {
  diagramItemId?: string;
  name: string;
  title?: string;
  sql?: string;
  type?: string;
};

type DiagramHierarchy = {
  diagramItemId?: string;
  name: string;
  title?: string;
  levels: string[];
};

type DiagramCube = {
  name: string;
  title?: string;
  description?: string;
  extends?: string;
  public?: boolean;
  refresh_key?: string;
  fileName: string;
  fileType: 'yaml' | 'javascript';
  dataSource: string;
  sourceType: 'sql_table' | 'sql' | 'unknown';
  source?: string;
  hasPrimaryKey: boolean;
  dimensions?: DiagramDimension[];
  measures?: DiagramMeasure[];
  hierarchies?: DiagramHierarchy[];
  columns: DiagramColumn[];
  columnError?: string;
};

type DiagramRelationship = {
  sourceCube: string;
  targetCube: string;
  sourceColumn?: string;
  targetColumn?: string;
  sourceColumns?: string[];
  targetColumns?: string[];
  relationship: RelationshipType;
  sql: string;
};

type DiagramResponse = {
  cubes: DiagramCube[];
  relationships: DiagramRelationship[];
};

type CubeVisibilityRow = {
  key: string;
  name: string;
  title: string;
  visible: boolean;
};

type PendingDiagramChange = {
  endpoint: string;
  body: Record<string, any>;
};

type DiagramState = {
  version?: number;
  activeViewId?: string;
  views?: Record<string, DiagramViewState>;
  cubes?: Record<string, {
    name?: string;
    source?: string;
    position?: { x: number; y: number };
  }>;
};

type DiagramViewState = {
  id: string;
  name: string;
  backgroundColor: string;
  visibility: Record<string, boolean>;
  cubes: Record<string, {
    name?: string;
    source?: string;
    position?: { x: number; y: number };
  }>;
};

type DiagramViewEditorMode = 'create' | 'edit';

const DIAGRAM_VIEW_COLORS = [
  '#f7f8fc',
  '#f3efff',
  '#edf7ff',
  '#eaf8f0',
  '#fff8e8',
  '#fff0f3',
  '#f1f5e9',
  '#eaf4ff',
  '#f9f0ff',
  '#fff4ed',
  '#eef8f7',
  '#f5f2ea',
  '#f0f0ff',
  '#f2f8e9',
  '#fff0ee',
  '#eaf7f5',
  '#f8f1f8',
  '#eff4ff',
  '#fff8f0',
  '#eef7ee',
];

type RelationshipType = 'one_to_one' | 'one_to_many' | 'many_to_one';

type RelationshipDraft = {
  sourceCube: string;
  targetCube: string;
  sourceColumn?: string;
  targetColumn?: string;
  relationship: RelationshipType;
  operation: 'create' | 'update';
  customCondition?: boolean;
  declaredInCube?: string;
  requestedFromCube?: string;
};

type DimensionDraft = {
  cubeName: string;
  dimensionName?: string;
  diagramItemId?: string;
  itemIndex?: number;
  name: string;
  title: string;
  description?: string;
  sql: string;
  type: string;
  latitude?: string;
  longitude?: string;
  primaryKey: boolean;
  public?: boolean;
  shown?: boolean;
  case?: string;
  sub_query?: boolean;
  format?: string;
  meta?: string;
};

type SchemaItemSection = 'measures' | 'segments' | 'hierarchies' | 'pre_aggregations';
type ReorderableSchemaItemSection = 'dimensions' | 'measures' | 'hierarchies';

type DiagramDocumentationSection = 'cube' | 'dimensions' | SchemaItemSection | 'joins';

const DIAGRAM_EDITOR_DOCUMENTATION: Record<DiagramDocumentationSection, string> = {
  cube: 'https://docs.cube.dev/reference/data-modeling/cube',
  joins: 'https://docs.cube.dev/reference/data-modeling/joins',
  dimensions: 'https://docs.cube.dev/reference/data-modeling/dimensions',
  measures: 'https://docs.cube.dev/reference/data-modeling/measures',
  segments: 'https://docs.cube.dev/reference/data-modeling/segments',
  hierarchies: 'https://docs.cube.dev/docs/data-modeling/dimensions#hierarchies',
  pre_aggregations: 'https://docs.cube.dev/docs/pre-aggregations/getting-started-pre-aggregations',
};

function EditorModalTitle({
  title,
  section,
}: {
  title: string;
  section: DiagramDocumentationSection;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, width: '100%' }}>
      <span>{title}</span>
      <Typography.Link
        href={DIAGRAM_EDITOR_DOCUMENTATION[section]}
        target="_blank"
        rel="noreferrer"
        style={{ fontSize: 12, fontWeight: 400 }}
        onClick={(event) => event.stopPropagation()}
      >
        <ReadmeOutlined style={{ marginRight: 6 }} />
        Documentação
      </Typography.Link>
    </div>
  );
}

type SchemaItemDraft = {
  cubeName: string;
  section: SchemaItemSection;
  itemName?: string;
  values: Record<string, any>;
};

const DIAGRAM_DOCUMENTATION_LABEL = `Documenta${String.fromCharCode(231, 227)}o`;

function DiagramDocumentationLink({ section }: { section: DiagramDocumentationSection }) {
  return (
    <Typography.Link
      href={DIAGRAM_EDITOR_DOCUMENTATION[section]}
      target="_blank"
      rel="noreferrer"
      style={{ fontSize: 12, fontWeight: 400 }}
      onClick={(event) => event.stopPropagation()}
    >
      <ReadmeOutlined style={{ marginRight: 6 }} />
      {DIAGRAM_DOCUMENTATION_LABEL}
    </Typography.Link>
  );
}

function handleEditorFormShortcut(
  event: React.KeyboardEvent<HTMLElement>,
  save: () => void,
) {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  save();
}

function DiagramEditorModalTitle({
  title,
  section,
}: {
  title: string;
  section: DiagramDocumentationSection;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, width: '100%' }}>
      <span>{title}</span>
      <DiagramDocumentationLink section={section} />
    </div>
  );
}

type CubePropertiesDraft = {
  cubeName: string;
  sourceMode: 'sql_table' | 'sql';
  values: Record<string, any>;
};

type Props = {
  visible: boolean;
  datamartId?: string;
  tablesSchema?: TablesSchema;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
};

function memberReferencesColumn(member: { name: string; sql?: string }, columnName: string): boolean {
  const normalizedColumnName = columnName.toLowerCase();
  if (member.name.toLowerCase() === normalizedColumnName) return true;
  const sql = member.sql?.trim();
  if (!sql) return false;

  const normalizedSql = sql.replace(/;$/, '').replace(/\s+/g, '').toLowerCase();
  return [
    normalizedColumnName,
    `{cube}.${normalizedColumnName}`,
    `\${cube}.${normalizedColumnName}`,
    `cube.${normalizedColumnName}`,
  ].includes(normalizedSql);
}

function columnIsUsedInPrimaryKey(cube: DiagramCube, column: DiagramColumn): boolean {
  return Boolean(cube.dimensions?.some(dimension => (
    dimension.primaryKey && expressionReferencesColumn(dimension.sql, column.name)
  )));
}

function primaryKeyColumns(cube: DiagramCube, relationships: DiagramRelationship[]): string[] {
  const columns = new Set<string>();
  (cube.dimensions || []).filter(dimension => dimension.primaryKey).forEach(dimension => {
    cube.columns.forEach(column => {
      if (expressionReferencesColumn(dimension.sql, column.name)) {
        columns.add(column.name);
      }
    });
  });

  const normalizedColumns = new Set(Array.from(columns).map(column => column.toLowerCase()));
  if (normalizedColumns.size < 2) return [];

  const isCompositeRelationship = relationships.some(relationship => {
    const relationshipColumns = relationship.sourceCube === cube.name
      ? relationship.sourceColumns
      : relationship.targetCube === cube.name
        ? relationship.targetColumns
        : undefined;
    if (!relationshipColumns || relationshipColumns.length < 2) return false;
    const normalizedRelationshipColumns = new Set(relationshipColumns.map(column => column.toLowerCase()));
    return normalizedRelationshipColumns.size === normalizedColumns.size
      && Array.from(normalizedRelationshipColumns).every(column => normalizedColumns.has(column));
  });

  return isCompositeRelationship
    ? Array.from(columns).sort((left, right) => left.localeCompare(right))
    : [];
}

function dimensionForColumn(cube: DiagramCube, column: DiagramColumn): DiagramDimension | undefined {
  const dimensions = cube.dimensions || [];
  const directMatch = dimensions.find(dimension => (
    dimension.name.toLowerCase() === column.name.toLowerCase()
  ));
  if (directMatch) return directMatch;

  const matches = dimensions.filter(dimension => memberReferencesColumn(dimension, column.name));
  return matches.length === 1 ? matches[0] : undefined;
}

function columnIsPrimaryKey(cube: DiagramCube, column: DiagramColumn): boolean {
  const dimension = dimensionForColumn(cube, column);
  // A physical database column remains visible so it can be configured again,
  // but it is not a Cube primary key until a primary-key dimension exists in
  // the temporary schema snapshot.
  return Boolean(dimension?.primaryKey);
}

function measureForColumn(cube: DiagramCube, column: DiagramColumn): DiagramMeasure | undefined {
  const matches = cube.measures?.filter(measure => memberReferencesColumn(measure, column.name)) || [];
  return matches[0];
}

function uniqueDiagramColumns(columns: DiagramColumn[]): DiagramColumn[] {
  const columnsByName = new Map<string, DiagramColumn>();
  columns.forEach(column => {
    const name = column.name.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!columnsByName.has(key)) columnsByName.set(key, { ...column, name });
  });
  return Array.from(columnsByName.values());
}

function cloneDiagramDebugValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function relationshipColumnNamesForCube(
  relationships: DiagramRelationship[],
  cubeName: string,
): Set<string> {
  const names = new Set<string>();
  relationships.forEach(relationship => {
    if (relationship.sourceCube === cubeName) {
      relationship.sourceColumn && names.add(relationship.sourceColumn.toLowerCase());
      relationship.sourceColumns?.forEach(column => names.add(column.toLowerCase()));
    }
    if (relationship.targetCube === cubeName) {
      relationship.targetColumn && names.add(relationship.targetColumn.toLowerCase());
      relationship.targetColumns?.forEach(column => names.add(column.toLowerCase()));
    }
  });
  return names;
}

function dimensionBelongsToJoinGroup(
  cube: DiagramCube,
  dimension: DiagramDimension,
  relationships: DiagramRelationship[],
): boolean {
  const relationshipColumns = relationshipColumnNamesForCube(relationships, cube.name);
  return relationshipColumns.has(dimension.name.toLowerCase()) || cube.columns.some(column => (
    relationshipColumns.has(column.name.toLowerCase()) && memberReferencesColumn(dimension, column.name)
  ));
}

function dimensionBelongsToPrimaryKeyComponentGroup(
  cube: DiagramCube,
  dimension: DiagramDimension,
): boolean {
  if (dimension.primaryKey) return false;

  // Components of a primary-key expression are ordinary dimensions. They
  // must not be confused with a composite relationship, which is defined by
  // two or more columns in the same join condition.
  return cube.columns.some(column => (
    columnIsUsedInPrimaryKey(cube, column)
    && memberReferencesColumn(dimension, column.name)
  ));
}

type DimensionOrderGroup = 'primary' | 'join' | 'primary_key_component' | 'regular';

function dimensionOrderGroup(
  cube: DiagramCube,
  dimension: DiagramDimension,
  relationships: DiagramRelationship[],
): DimensionOrderGroup {
  if (dimension.primaryKey) return 'primary';
  // A join key has precedence over its role as a primary-key component.
  if (dimensionBelongsToJoinGroup(cube, dimension, relationships)) return 'join';
  if (dimensionBelongsToPrimaryKeyComponentGroup(cube, dimension)) return 'primary_key_component';
  return 'regular';
}

type ColumnKeyRole = 'primary' | 'join' | 'primary_key_component';

const COLUMN_KEY_ROLE_LABELS: Record<ColumnKeyRole, string> = {
  primary: 'Chave primária',
  primary_key_component: 'Componente de chave primária',
  join: 'Chave de junção',
};

const COLUMN_KEY_ROLE_COLORS: Record<ColumnKeyRole, string> = {
  primary: '#ad6800',
  primary_key_component: '#d8b56a',
  join: '#ad6800',
};

function columnKeyRole(
  cube: DiagramCube,
  column: DiagramColumn,
  relationships: DiagramRelationship[],
): ColumnKeyRole | undefined {
  if (columnIsPrimaryKey(cube, column)) return 'primary';

  const dimension = dimensionForColumn(cube, column);
  const relationshipNames = relationshipColumnNamesForCube(relationships, cube.name);
  const isJoin = relationshipNames.has(column.name.toLowerCase())
    || Boolean(dimension && dimensionBelongsToJoinGroup(cube, dimension, relationships));
  if (isJoin) return 'join';
  if (columnIsUsedInPrimaryKey(cube, column)) return 'primary_key_component';
  return undefined;
}

function canonicalDimensionOrder(
  cube: DiagramCube,
  dimensions: DiagramDimension[],
  relationships: DiagramRelationship[],
): DiagramDimension[] {
  return [...dimensions].sort((left, right) => (
    ['primary', 'join', 'primary_key_component', 'regular'].indexOf(
      dimensionOrderGroup(cube, left, relationships)
    ) - ['primary', 'join', 'primary_key_component', 'regular'].indexOf(
      dimensionOrderGroup(cube, right, relationships)
    )
  ));
}

function unquoteRelationshipColumn(value: string): string {
  const column = value.trim();
  if ((column.startsWith('"') && column.endsWith('"'))
    || (column.startsWith('`') && column.endsWith('`'))
    || (column.startsWith('[') && column.endsWith(']'))) {
    return column.slice(1, -1);
  }
  return column;
}

function relationshipColumnReference(
  reference: string,
  cubeNames: string[],
): string | undefined {
  const match = reference.trim().match(/^\{([^}]+)\}\s*\.\s*(.+)$/);
  if (!match) return undefined;
  const referenceCube = match[1].trim().toLowerCase();
  if (!cubeNames.some(cubeName => cubeName.toLowerCase() === referenceCube)) return undefined;
  return unquoteRelationshipColumn(match[2]);
}

/**
 * The API normally returns sourceColumn/targetColumn parsed from the join SQL.
 * Keep the SQL as the source of truth and recover those fields in the client
 * when an older server/compiler response omits them. Without this fallback
 * React Flow has no row handle to use and correctly falls back to the cube
 * header, even though the SQL names both columns.
 */
function hydrateRelationshipColumns(join: DiagramRelationship): DiagramRelationship {
  const parsedSourceColumns: string[] = [];
  const parsedTargetColumns: string[] = [];
  const conditions = join.sql.split(/\s+AND\s+/i);

  conditions.forEach(condition => {
    const equality = condition.match(/^(.+?)\s*=\s*(.+)$/);
    if (!equality) return;
    const [, left, right] = equality;
    const leftSource = relationshipColumnReference(left, [join.sourceCube, 'CUBE']);
    const rightTarget = relationshipColumnReference(right, [join.targetCube]);
    if (leftSource && rightTarget) {
      parsedSourceColumns.push(leftSource);
      parsedTargetColumns.push(rightTarget);
      return;
    }

    const leftTarget = relationshipColumnReference(left, [join.targetCube]);
    const rightSource = relationshipColumnReference(right, [join.sourceCube, 'CUBE']);
    if (leftTarget && rightSource) {
      parsedSourceColumns.push(rightSource);
      parsedTargetColumns.push(leftTarget);
    }
  });

  if (!parsedSourceColumns.length || parsedSourceColumns.length !== parsedTargetColumns.length) {
    return join;
  }

  return {
    ...join,
    sourceColumn: parsedSourceColumns[0],
    targetColumn: parsedTargetColumns[0],
    sourceColumns: parsedSourceColumns,
    targetColumns: parsedTargetColumns,
  };
}

function normalizeDiagramForDisplay(result: DiagramResponse): { diagram: DiagramResponse; changed: boolean } {
  let changed = false;
  const relationships = result.relationships.map(hydrateRelationshipColumns).map(join => {
    if (join.relationship !== 'one_to_many' || !join.sourceColumn || !join.targetColumn) return join;
    changed = true;
    return {
      ...join,
      sourceCube: join.targetCube,
      targetCube: join.sourceCube,
      sourceColumn: join.targetColumn,
      targetColumn: join.sourceColumn,
      sourceColumns: join.targetColumns,
      targetColumns: join.sourceColumns,
      relationship: 'many_to_one' as RelationshipType,
      sql: `{${join.targetCube}}.${join.targetColumn} = {${join.sourceCube}}.${join.sourceColumn}`,
    };
  });

  const cubes = result.cubes.map(cube => {
    const dimensions = (cube.dimensions || []).map((dimension, index) => ({
      ...dimension,
      diagramItemId: diagramItemId('dimension', cube.name, index),
    }));
    const measures = (cube.measures || []).map((measure, index) => ({
      ...measure,
      diagramItemId: diagramItemId('measure', cube.name, index),
    }));
    const hierarchies = (cube.hierarchies || []).map((hierarchy, index) => ({
      ...hierarchy,
      diagramItemId: diagramItemId('hierarchy', cube.name, index),
    }));
    const orderedDimensions = canonicalDimensionOrder(cube, dimensions, relationships);
    if (orderedDimensions.some((dimension, index) => dimension !== dimensions[index])) changed = true;
    return {
      ...cube,
      measures,
      hierarchies,
      dimensions: orderedDimensions,
    };
  });

  return { diagram: { cubes, relationships }, changed };
}

function schemaSnapshotForSave(cubes: DiagramCube[], relationships: DiagramRelationship[]) {
  const stripDiagramMetadata = (item: Record<string, any>) => {
    const { diagramItemId, ...persisted } = item;
    return persisted;
  };

  return cubes.map(cube => ({
    cubeName: cube.name,
    cube: {
      title: cube.title,
      description: cube.description,
      extends: cube.extends,
      public: cube.public,
      refresh_key: cube.refresh_key,
      data_source: cube.dataSource,
      ...(cube.sourceType === 'sql' ? { sql: cube.source } : { sql_table: cube.source }),
    },
    dimensions: (cube.dimensions || []).map(stripDiagramMetadata),
    measures: (cube.measures || []).map(measure => {
      const persisted = stripDiagramMetadata(measure);
      const filters = normalizeMeasureFilters(persisted.filters);
      if (filters) persisted.filters = filters;
      else delete persisted.filters;
      return persisted;
    }),
    hierarchies: (cube.hierarchies || []).map(stripDiagramMetadata),
    joins: relationships
      .filter(relationship => relationship.sourceCube === cube.name)
      .map(relationship => ({
        name: relationship.targetCube,
        sql: relationship.sql,
        relationship: relationship.relationship,
      })),
  }));
}

function schemaSnapshotSource(diagram: DiagramResponse): string {
  return JSON.stringify(schemaSnapshotForSave(diagram.cubes, diagram.relationships));
}

let diagramItemSequence = 0;

function diagramItemId(section: string, cubeName: string, index?: number): string {
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${++diagramItemSequence}`;
  return `diagram:${section}:${cubeName}:${index ?? 'new'}:${randomId}`;
}

function updateDiagramCube(
  diagram: DiagramResponse,
  cubeName: string,
  update: (cube: DiagramCube) => DiagramCube,
): DiagramResponse {
  return {
    ...diagram,
    cubes: diagram.cubes.map(cube => cube.name === cubeName ? update(cube) : cube),
  };
}

function updateDiagramCubeMembers(
  diagram: DiagramResponse,
  cubeName: string,
  section: 'dimensions' | 'measures',
  itemName: string | undefined,
  values: Record<string, any>,
  operation: 'upsert' | 'delete' = 'upsert',
  itemIndex?: number,
): DiagramResponse {
  return updateDiagramCube(diagram, cubeName, cube => {
    if (section === 'dimensions') {
      const members = [...(cube.dimensions || [])];
      const matchingIndexes = itemName
        ? members.map((member, index) => member.name.toLowerCase() === itemName.toLowerCase() ? index : -1).filter(index => index >= 0)
        : [];
      const index = itemName
        ? matchingIndexes[itemIndex === undefined ? 0 : itemIndex] ?? -1
        : -1;
      if (operation === 'delete') {
        if (itemIndex !== undefined && index >= 0) {
          return { ...cube, dimensions: members.filter((_member, memberIndex) => memberIndex !== index) };
        }
        return { ...cube, dimensions: members.filter(member => member.name.toLowerCase() !== itemName?.toLowerCase()) };
      }
      const member: DiagramDimension = {
        name: String(values.name || itemName || ''),
        diagramItemId: diagramItemId('dimension', cubeName),
        ...(index >= 0 ? members[index] : {}),
        ...values,
        ...(values.primary_key !== undefined ? { primaryKey: Boolean(values.primary_key) } : {}),
      };
      delete (member as any).primary_key;
      if (index >= 0) members[index] = member;
      else members.push(member);
      const primaryDimensions = members.filter(dimension => dimension.primaryKey);
      const otherDimensions = members.filter(dimension => !dimension.primaryKey);
      return {
        ...cube,
        hasPrimaryKey: primaryDimensions.length > 0,
        dimensions: [...primaryDimensions, ...otherDimensions],
      };
    }

    const members = [...(cube.measures || [])];
    const matchingIndexes = itemName
      ? members.map((member, index) => member.name.toLowerCase() === itemName.toLowerCase() ? index : -1).filter(index => index >= 0)
      : [];
    const index = itemName
      ? matchingIndexes[itemIndex === undefined ? 0 : itemIndex] ?? -1
      : -1;
    if (operation === 'delete') return { ...cube, measures: members.filter(member => member.name.toLowerCase() !== itemName?.toLowerCase()) };
    const member: DiagramMeasure = {
      name: String(values.name || itemName || ''),
      diagramItemId: diagramItemId('measure', cubeName),
      ...(index >= 0 ? members[index] : {}),
      ...values,
    };
    if (index >= 0) members[index] = member;
    else members.push(member);
    return { ...cube, measures: members };
  });
}

function schemaItemIndex(
  members: Array<{ name: string }>,
  itemName: string,
  itemIndex?: number,
): number {
  const matchingIndexes = members
    .map((member, index) => member.name.toLowerCase() === itemName.toLowerCase() ? index : -1)
    .filter(index => index >= 0);
  return matchingIndexes[itemIndex === undefined ? 0 : itemIndex] ?? -1;
}

function schemaItemGroupIndexes(
  cube: DiagramCube,
  members: Array<{ name: string }>,
  section: ReorderableSchemaItemSection,
  index: number,
  relationships: DiagramRelationship[],
): number[] {
  if (section !== 'dimensions') return members.map((_member, memberIndex) => memberIndex);

  const dimension = members[index] as DiagramDimension;
  const group = dimensionOrderGroup(cube, dimension, relationships);
  return members
    .map((member, memberIndex) => {
      const candidate = member as DiagramDimension;
      const candidateGroup = dimensionOrderGroup(cube, candidate, relationships);
      return candidateGroup === group ? memberIndex : -1;
    })
    .filter(memberIndex => memberIndex >= 0);
}

function schemaItemMoveTarget(
  cube: DiagramCube,
  section: ReorderableSchemaItemSection,
  itemName: string,
  direction: 'up' | 'down',
  itemIndex?: number,
  relationships: DiagramRelationship[] = [],
): number {
  const members = section === 'dimensions'
    ? [...(cube.dimensions || [])]
    : section === 'measures'
      ? [...(cube.measures || [])]
      : [...(cube.hierarchies || [])];
  const index = schemaItemIndex(members, itemName, itemIndex);
  if (index < 0) return -1;

  const groupIndexes = schemaItemGroupIndexes(cube, members, section, index, relationships);
  const groupPosition = groupIndexes.indexOf(index);
  const targetPosition = groupPosition + (direction === 'up' ? -1 : 1);
  return groupIndexes[targetPosition] ?? -1;
}

function canMoveSchemaItem(
  cube: DiagramCube,
  section: ReorderableSchemaItemSection,
  itemName: string,
  direction: 'up' | 'down',
  itemIndex?: number,
  relationships: DiagramRelationship[] = [],
): boolean {
  return schemaItemMoveTarget(cube, section, itemName, direction, itemIndex, relationships) >= 0;
}

function moveSchemaItemInDiagram(
  diagram: DiagramResponse,
  cubeName: string,
  section: ReorderableSchemaItemSection,
  itemName: string,
  direction: 'up' | 'down',
  itemIndex?: number,
  relationships: DiagramRelationship[] = [],
): DiagramResponse {
  return updateDiagramCube(diagram, cubeName, cube => {
    const members = section === 'dimensions'
      ? [...(cube.dimensions || [])]
      : section === 'measures'
        ? [...(cube.measures || [])]
        : [...(cube.hierarchies || [])];
    const index = schemaItemIndex(members, itemName, itemIndex);
    const targetIndex = schemaItemMoveTarget(cube, section, itemName, direction, itemIndex, relationships);
    if (index < 0 || targetIndex < 0) return cube;

    [members[index], members[targetIndex]] = [members[targetIndex], members[index]];
    if (section === 'dimensions') return { ...cube, dimensions: members as DiagramDimension[] };
    if (section === 'measures') return { ...cube, measures: members as DiagramMeasure[] };
    return { ...cube, hierarchies: members as DiagramHierarchy[] };
  });
}

function updateDiagramCubeHierarchy(
  diagram: DiagramResponse,
  cubeName: string,
  itemName: string | undefined,
  values: Record<string, any>,
  operation: 'upsert' | 'delete' = 'upsert',
): DiagramResponse {
  return updateDiagramCube(diagram, cubeName, cube => {
    const hierarchies = [...(cube.hierarchies || [])];
    const index = itemName ? hierarchies.findIndex(hierarchy => hierarchy.name === itemName) : -1;
    if (operation === 'delete') {
      return { ...cube, hierarchies: hierarchies.filter(hierarchy => hierarchy.name !== itemName) };
    }

    const hierarchy: DiagramHierarchy = {
      name: String(values.name || itemName || ''),
      diagramItemId: diagramItemId('hierarchy', cubeName),
      ...(index >= 0 ? hierarchies[index] : {}),
      ...values,
      levels: Array.isArray(values.levels)
        ? values.levels.map((level: any) => String(level)).filter(Boolean)
        : [],
    };
    if (index >= 0) hierarchies[index] = hierarchy;
    else hierarchies.push(hierarchy);
    return { ...cube, hierarchies };
  });
}

function replaceCubeMemberReference(sql: string, cubeName: string, oldName: string, newName: string): string {
  if (!sql || !oldName || oldName === newName) return sql;
  const escapedCube = cubeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedName = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reference = new RegExp(
    `(\\{\\s*${escapedCube}\\s*\\}|\\$\\{\\s*${escapedCube}\\s*\\}|\\b${escapedCube})\\s*\\.\\s*${escapedName}(?=$|[^A-Za-z0-9_$])`,
    'gi'
  );
  return sql.replace(reference, match => match.replace(new RegExp(escapedName, 'i'), newName));
}

function renameDimensionReferences(
  diagram: DiagramResponse,
  cubeName: string,
  oldName: string | undefined,
  newName: string,
): DiagramResponse {
  if (!oldName || oldName.toLowerCase() === newName.toLowerCase()) return diagram;
  const matches = (value: string | undefined) => value?.toLowerCase() === oldName.toLowerCase();
  const cubes = diagram.cubes.map(cube => ({
    ...cube,
    hierarchies: cube.name === cubeName
      ? (cube.hierarchies || []).map(hierarchy => ({
        ...hierarchy,
        levels: hierarchy.levels.map(level => matches(level) ? newName : level),
      }))
      : cube.hierarchies,
  }));
  const relationships = diagram.relationships.map(relationship => {
    const isSource = relationship.sourceCube === cubeName;
    const isTarget = relationship.targetCube === cubeName;
    if (!isSource && !isTarget) return relationship;
    return {
      ...relationship,
      sourceColumn: isSource && matches(relationship.sourceColumn) ? newName : relationship.sourceColumn,
      targetColumn: isTarget && matches(relationship.targetColumn) ? newName : relationship.targetColumn,
      sourceColumns: isSource
        ? relationship.sourceColumns?.map(column => matches(column) ? newName : column)
        : relationship.sourceColumns,
      targetColumns: isTarget
        ? relationship.targetColumns?.map(column => matches(column) ? newName : column)
        : relationship.targetColumns,
      sql: replaceCubeMemberReference(
        replaceCubeMemberReference(relationship.sql, relationship.sourceCube, oldName, newName),
        relationship.targetCube,
        oldName,
        newName,
      ),
    };
  });
  return { cubes, relationships };
}

function physicalColumnForRelationship(cube: DiagramCube, columnName?: string): string | undefined {
  if (!columnName) return undefined;
  const directColumn = cube.columns.find(column => column.name.toLowerCase() === columnName.toLowerCase());
  if (directColumn) return directColumn.name;
  const dimension = (cube.dimensions || []).find(item => item.name.toLowerCase() === columnName.toLowerCase());
  if (!dimension) return undefined;
  return cube.columns.find(column => expressionReferencesColumn(dimension.sql, column.name))?.name;
}

const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  many_to_one: 'Muitos para um',
  one_to_many: 'Um para muitos',
  one_to_one: 'Um para um',
};

const RELATIONSHIP_CARDINALITIES: Record<RelationshipType, [string, string]> = {
  many_to_one: ['N', '1'],
  one_to_many: ['1', 'N'],
  one_to_one: ['1', '1'],
};

const RELATIONSHIP_EDGE_LABELS: Record<RelationshipType, string> = {
  many_to_one: 'N:1',
  one_to_many: '1:N',
  one_to_one: '1:1',
};

const RELATIONSHIP_HELPERS: Record<RelationshipType, (source: string, target: string) => string> = {
  many_to_one: (source, target) => `Muitos(as) ${source} para Um(a) ${target}`,
  one_to_many: (source, target) => `Um(a) ${source} para Muitos(as) ${target}`,
  one_to_one: (source, target) => `Um(a) ${source} para Um(a) ${target}`,
};

function defaultRelationship(
  source: DiagramCube | undefined,
  target: DiagramCube | undefined,
  sourceColumn: string | undefined,
  targetColumn: string | undefined,
): RelationshipType {
  const sourceIsPrimaryKey = Boolean(source?.columns.find(column => column.name === sourceColumn)?.primaryKey);
  const targetIsPrimaryKey = Boolean(target?.columns.find(column => column.name === targetColumn)?.primaryKey);

  if (sourceIsPrimaryKey && !targetIsPrimaryKey) {
    return 'one_to_many';
  }

  if (!sourceIsPrimaryKey && targetIsPrimaryKey) {
    return 'many_to_one';
  }

  // Cube does not support many-to-many relationships. Two primary keys
  // describe a one-to-one relationship and must use the valid Cube type.
  if (sourceIsPrimaryKey && targetIsPrimaryKey) {
    return 'one_to_one';
  }

  return 'many_to_one';
}

function relationshipForStorage(draft: RelationshipDraft) {
  if (draft.relationship !== 'one_to_many') {
    return {
      sourceCube: draft.sourceCube,
      targetCube: draft.targetCube,
      sourceColumn: draft.sourceColumn,
      targetColumn: draft.targetColumn,
      relationship: draft.relationship,
    };
  }

  // Cube stores the relationship on the many side. The UI keeps the
  // natural 1:N wording, but writes the equivalent N:1 definition.
  return {
    sourceCube: draft.targetCube,
    targetCube: draft.sourceCube,
    sourceColumn: draft.targetColumn,
    targetColumn: draft.sourceColumn,
    relationship: 'many_to_one' as RelationshipType,
  };
}

function relationshipSqlForStorage(
  targetCube: string,
  sourceColumn?: string,
  targetColumn?: string,
): string {
  return `{CUBE}.${sourceColumn} = {${targetCube}}.${targetColumn}`;
}

const DiagramWorkspace = styled.div`
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  height: auto;
  border-top: 1px solid #e8e8f0;
  background: #f7f8fc;
`;

const CubeVisibilityPanel = styled.aside`
  display: flex;
  flex: 0 0 270px;
  flex-direction: column;
  min-height: 0;
  min-width: 220px;
  max-width: 310px;
  overflow: hidden;
  border-right: 1px solid #d9d8ea;
  background: #fff;
`;

const CubeVisibilityPanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 42px;
  padding: 8px 10px;
  border-bottom: 1px solid #eeecf6;
  color: #4b4677;
  font-size: 12px;
  font-weight: 700;
`;

const CubeVisibilityName = styled.div`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CubeVisibilityTable = styled.div`
  min-height: 0;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;

  &::-webkit-scrollbar:horizontal {
    display: none;
    height: 0;
  }
`;

const CubeVisibilityTableHeader = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px;
  align-items: center;
  min-width: 0;
  min-height: 28px;
  padding: 0 8px;
  color: #6f6a91;
  background: #faf9ff;
  font-size: 10px;
`;

const CubeVisibilityTableRow = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px;
  align-items: center;
  min-width: 0;
  min-height: 52px;
  padding: 4px 8px;
  border-top: 1px solid #f0eff6;

  &:hover {
    background: #f2f0ff;
  }
`;

const CubeVisibilityTableCell = styled.div`
  min-width: 0;
  overflow: hidden;
`;

const CubeVisibilityIconCell = styled.div`
  display: flex;
  align-items: center;
  gap: 1px;
  justify-content: center;
  min-width: 0;
`;

const Canvas = styled.div<{ $backgroundColor?: string }>`
  flex: 1;
  min-width: 0;
  height: 100%;
  min-height: 0;
  background: ${({ $backgroundColor }) => $backgroundColor || '#f7f8fc'};

  .react-flow__node {
    font-family: inherit;
  }

  .react-flow__edge-path {
    stroke: #6f63d9;
    stroke-width: 2;
  }

  .react-flow__edge.selected .react-flow__edge-path {
    stroke: #473caa;
    stroke-width: 3;
  }
`;

const CubeCard = styled.div`
  width: 310px;
  overflow: hidden;
  border: 1px solid #d9d8ea;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 5px 18px rgba(55, 48, 107, 0.1);
`;

const CubeHeader = styled.div`
  position: relative;
  min-height: 74px;
  box-sizing: border-box;
  padding: 12px 14px 30px;
  color: #fff;
  background: #4b4677;
`;

const ColumnRow = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 46px;
  padding: 5px 17px;
  border-top: 1px solid #f0eff6;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background: #f2f0ff;
  }
`;

const PrimaryKeyColumnRow = styled(ColumnRow)`
  background: #fffbe6;
  border-top-color: #f5e6b3;

  &:hover {
    background: #fff1b8;
  }
`;

const CompositeKeyRow = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  min-height: 42px;
  padding: 6px 17px;
  border-top: 1px solid #f5e6b3;
  color: #595959;
  background: #fff;
  font-size: 12px;
`;

const ColumnActionButton = styled(Button)`
  display: none !important;
`;

const COLUMN_ROW_HEIGHT = 46;
const COLUMN_RESIZE_HANDLE_HEIGHT = 14;

const ColumnList = styled.div`
  position: relative;
  overflow: hidden;
`;

const ColumnResizeHandle = styled.div`
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 5;
  height: 14px;
  cursor: ns-resize;
  background: linear-gradient(to bottom, transparent 0%, rgba(111, 99, 217, 0.04) 100%);

  &::after {
    position: absolute;
    right: 10px;
    bottom: 5px;
    left: 10px;
    height: 2px;
    border-top: 1px solid #c9c5ea;
    border-bottom: 1px solid #c9c5ea;
    content: '';
  }

  &:hover {
    background: rgba(111, 99, 217, 0.1);
  }
`;

const ColumnSection = styled.div``;
const ColumnSectionHeader = styled.div``;

const MeasureRow = styled.div`
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 46px;
  padding: 5px 14px;
  border-top: 1px solid #eeecf6;
  cursor: pointer;

  &:hover {
    background: #f2f0ff;
  }
`;

const HierarchyRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 46px;
  padding: 5px 14px;
  border-top: 1px solid #eeecf6;
  cursor: pointer;

  &:hover {
    background: #f2f0ff;
  }
`;

const HierarchyLevelPath = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 3px;
`;

const HierarchyLevel = styled.span`
  padding: 1px 5px;
  border: 1px solid #d9d8ea;
  border-radius: 3px;
  color: #4b4677;
  background: #faf9ff;
  font-size: 10px;
  line-height: 15px;
`;

const Toolbar = styled.div`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  padding: 10px 14px;
  background: #fff;
`;

const DiagramViewsBar = styled.div`
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 8px;
  padding: 7px 14px;
  border-top: 1px solid #eeecf6;
  border-bottom: 1px solid #e8e8f0;
  background: #faf9ff;
`;

const DiagramViewColorPalette = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px;
  max-width: 310px;
`;

const DiagramViewColorSwatch = styled.button<{ $selected?: boolean; $color: string }>`
  width: 20px;
  height: 20px;
  padding: 0;
  border: 2px solid ${({ $selected }) => ($selected ? '#7568d8' : '#fff')};
  border-radius: 4px;
  outline: 1px solid ${({ $selected }) => ($selected ? '#7568d8' : '#d9d8ea')};
  background: ${({ $color }) => $color};
  cursor: pointer;

  &:hover {
    transform: scale(1.12);
  }
`;

const DiagramModalTitle = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 16px;
`;

const DiagramModalActions = styled.div`
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  margin-right: 8px;
`;

const DiagramModalAction = styled.div`
  display: inline-flex;
  flex-direction: column;
  align-items: center;
`;

const DiagramModalShortcutHint = styled.span`
  margin-top: 2px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 10px;
  font-weight: 400;
  line-height: 12px;
`;

const RelationshipLabel = styled.span`
  position: absolute;
  padding: 2px 6px;
  border: 1px solid #d9d8ea;
  border-radius: 4px;
  color: #4b4677;
  background: #fff;
  box-shadow: 0 1px 4px rgba(55, 48, 107, 0.16);
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  pointer-events: none;
`;

function handleId(kind: 'source' | 'target', column?: string, side?: 'left' | 'right'): string {
  return `${kind}:${side ? `${side}:` : ''}${column || '__cube'}`;
}

function compositeHandleId(
  kind: 'source' | 'target',
  columns: string[],
  side: 'left' | 'right',
): string {
  const key = columns.map(column => column.trim()).sort((left, right) => left.localeCompare(right)).join(',');
  return `${kind}:${side}:composite:${key}`;
}

function handleColumn(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const [, ...parts] = id.split(':');
  const column = ['left', 'right'].includes(parts[0]) ? parts.slice(1).join(':') : parts.join(':');
  return column && column !== '__cube' ? column : undefined;
}

function manySymbolPath(x: number, y: number, position: Position): string {
  const direction = position === Position.Left ? [1, 0]
    : position === Position.Right ? [-1, 0]
      : position === Position.Top ? [0, 1]
        : [0, -1];
  const perpendicular = [-direction[1], direction[0]];
  // Keep the whole symbol outside the table card. The node is painted above
  // the edges, so a symbol placed directly on the handle gets hidden.
  const central = [x - direction[0] * 14, y - direction[1] * 14];
  const tip = [x - direction[0] * 4, y - direction[1] * 4];
  const upperTip = [tip[0] + perpendicular[0] * 8, tip[1] + perpendicular[1] * 8];
  const lowerTip = [tip[0] - perpendicular[0] * 8, tip[1] - perpendicular[1] * 8];

  return `M ${central[0]} ${central[1]} L ${upperTip[0]} ${upperTip[1]}`
    + ` M ${central[0]} ${central[1]} L ${tip[0]} ${tip[1]}`
    + ` M ${central[0]} ${central[1]} L ${lowerTip[0]} ${lowerTip[1]}`;
}

async function relationshipResponseError(response: Response): Promise<string> {
  const error = await responseErrorMessage(response, true);

  if (/needs a primary key|primary key .* required/i.test(error)) {
    return 'O Cube exige uma dimensão marcada como chave primária em um dos cubos para criar esta junção.';
  }
  if (/already exists/i.test(error)) {
    return 'Este relacionamento já existe.';
  }
  if (/would be invalid/i.test(error)) {
    return error.replace(
      /The relationship was not saved because the model would be invalid:?/i,
      'O relacionamento não foi salvo porque deixaria o modelo inválido:'
    );
  }
  return error || 'Não foi possível alterar o relacionamento';
}

function CubeDiagramNode({ id, data }: any) {
  const cube = data.cube as DiagramCube;
  const relationships = (data.relationships || []) as DiagramRelationship[];
  const updateNodeInternals = useUpdateNodeInternals();
  const selectedCubeName = data.selectedCubeName as string | null;
  const relationshipColumnNames = new Set(
    ((data.relationshipColumnNames || []) as string[]).map(columnName => columnName.toLowerCase())
  );
  const hierarchies = cube.hierarchies || [];
  const hierarchyDimensionLabels = new Map(
    (cube.dimensions || []).map(dimension => [dimension.name.toLowerCase(), dimension.title || dimension.name])
  );
  const primaryKeySaving = data.primaryKeySaving as string | null;
  const markColumnAsPrimaryKey = data.markColumnAsPrimaryKey as (cubeName: string, column: DiagramColumn) => void;
  const openDimensionEditor = data.openDimensionEditor as (cube: DiagramCube, column: DiagramColumn, dimension?: DiagramDimension) => void;
  const openSchemaItemEditor = data.openSchemaItemEditor as (action: string, cube: DiagramCube, column?: DiagramColumn, item?: any) => void;
  const confirmDeleteSchemaItem = data.confirmDeleteSchemaItem as (cubeName: string, section: 'dimensions' | 'measures' | 'hierarchies', itemName: string, label: string, itemIndex?: number) => void;
  const moveSchemaItem = data.moveSchemaItem as (cubeName: string, section: ReorderableSchemaItemSection, itemName: string, direction: 'up' | 'down', itemIndex?: number, relationships?: DiagramRelationship[]) => void;
  const openCubePropertiesEditor = data.openCubePropertiesEditor as (cube: DiagramCube) => void;
  const isolateCube = data.isolateCube as (cube: DiagramCube) => void;
  const cubeActionMenuKey = data.cubeActionMenuKey as string | null;
  const setCubeActionMenuKey = data.setCubeActionMenuKey as (key: string | null) => void;
  const columnMenuKey = data.columnMenuKey as string | null;
  const setColumnMenuKey = data.setColumnMenuKey as (key: string | null) => void;
  const diagramColumns = uniqueDiagramColumns(cube.columns);
  const compositeKeyColumns = primaryKeyColumns(cube, relationships);
  const compositeKeyColumnNames = new Set(compositeKeyColumns.map(column => column.toLowerCase()));
  const canConnectColumns = !cube.columnError && diagramColumns.length > 0;
  const dimensionOrder = new Map<string, number>();
  (cube.dimensions || []).forEach((dimension, index) => {
    const name = dimension.name.toLowerCase();
    if (!dimensionOrder.has(name)) dimensionOrder.set(name, index);
  });
  const originalColumnOrder = new Map(diagramColumns.map((column, index) => [column.name.toLowerCase(), index]));
  const orderedColumns = [...diagramColumns].sort((left, right) => {
    const leftDimension = dimensionForColumn(cube, left);
    const rightDimension = dimensionForColumn(cube, right);
    const leftIsPrimaryKey = columnIsPrimaryKey(cube, left);
    const rightIsPrimaryKey = columnIsPrimaryKey(cube, right);
    const leftKeyRole = columnKeyRole(cube, left, relationships);
    const rightKeyRole = columnKeyRole(cube, right, relationships);
    const leftIsDimension = Boolean(leftDimension) || leftKeyRole === 'primary_key_component';
    const rightIsDimension = Boolean(rightDimension) || rightKeyRole === 'primary_key_component';
    const leftIsMeasure = Boolean(measureForColumn(cube, left));
    const rightIsMeasure = Boolean(measureForColumn(cube, right));
    const leftGroup = leftKeyRole === 'primary' ? 0
      : leftKeyRole === 'join' ? 1
        : leftKeyRole === 'primary_key_component' ? 2
          : leftIsDimension ? 3
            : leftIsMeasure ? 4 : 5;
    const rightGroup = rightKeyRole === 'primary' ? 0
      : rightKeyRole === 'join' ? 1
        : rightKeyRole === 'primary_key_component' ? 2
          : rightIsDimension ? 3
            : rightIsMeasure ? 4 : 5;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    const leftDimensionIndex = leftDimension ? dimensionOrder.get(leftDimension.name.toLowerCase()) : undefined;
    const rightDimensionIndex = rightDimension ? dimensionOrder.get(rightDimension.name.toLowerCase()) : undefined;
    if (leftDimensionIndex !== undefined && rightDimensionIndex !== undefined && leftDimensionIndex !== rightDimensionIndex) {
      return leftDimensionIndex - rightDimensionIndex;
    }
    if (leftDimensionIndex !== undefined && rightDimensionIndex === undefined) return -1;
    if (leftDimensionIndex === undefined && rightDimensionIndex !== undefined) return 1;
    return (originalColumnOrder.get(left.name.toLowerCase()) || 0)
      - (originalColumnOrder.get(right.name.toLowerCase()) || 0);
  });
  const dimensionColumns = orderedColumns.filter(column => (
    Boolean(dimensionForColumn(cube, column))
  ));
  const duplicateDimensions = (cube.dimensions || []).flatMap((dimension, index, dimensions) => {
    const itemIndex = dimensions
      .slice(0, index)
      .filter(candidate => candidate.name.toLowerCase() === dimension.name.toLowerCase())
      .length;
    return itemIndex > 0 ? [{ dimension, itemIndex }] : [];
  });
  const duplicateDimensionsByName = new Map<string, Array<{ dimension: DiagramDimension; itemIndex: number }>>();
  duplicateDimensions.forEach((duplicate) => {
    const key = duplicate.dimension.name.toLowerCase();
    duplicateDimensionsByName.set(key, [
      ...(duplicateDimensionsByName.get(key) || []),
      duplicate,
    ]);
  });
  const dimensionOccurrenceIndex = (dimension: DiagramDimension): number => {
    const selectedIndex = dimension.diagramItemId
      ? (cube.dimensions || []).findIndex(candidate => candidate.diagramItemId === dimension.diagramItemId)
      : (cube.dimensions || []).findIndex(candidate => candidate === dimension);
    if (selectedIndex >= 0) {
      return (cube.dimensions || []).slice(0, selectedIndex)
        .filter(candidate => candidate.name.toLowerCase() === dimension.name.toLowerCase())
        .length;
    }
    let occurrence = 0;
    for (const candidate of cube.dimensions || []) {
      if (candidate.name.toLowerCase() !== dimension.name.toLowerCase()) continue;
      if (candidate === dimension) return occurrence;
      occurrence += 1;
    }
    return 0;
  };
  const measureColumns = orderedColumns.filter(column => (
    !compositeKeyColumnNames.has(column.name.toLowerCase())
    && (
    cube.measures?.some(measure => memberReferencesColumn(measure, column.name))
    )
  ));
  const modeledColumnNames = new Set([
    ...dimensionColumns.map(column => column.name.toLowerCase()),
    ...measureColumns.map(column => column.name.toLowerCase()),
  ]);
  const unusedColumns = orderedColumns.filter(column => (
    !compositeKeyColumnNames.has(column.name.toLowerCase())
    &&
    !modeledColumnNames.has(column.name.toLowerCase())
    && !columnIsUsedInPrimaryKey(cube, column)
    && !relationshipColumnNames.has(column.name.toLowerCase())
  ));
  const primaryDimensionColumns = dimensionColumns.filter(column => {
    return columnIsPrimaryKey(cube, column);
  });
  const secondaryKeyColumns = dimensionColumns.filter(column => {
    const isPrimary = columnIsPrimaryKey(cube, column);
    return !isPrimary && (
      columnIsUsedInPrimaryKey(cube, column)
    );
  });
  const regularDimensionColumns = dimensionColumns.filter(column => (
    !primaryDimensionColumns.includes(column) && !secondaryKeyColumns.includes(column)
  ));
  const compositeKeyInsertColumn = secondaryKeyColumns[0] || regularDimensionColumns[0];
  const totalItemCount = dimensionColumns.length
    + duplicateDimensions.length
    + (compositeKeyColumns.length > 1 ? 1 : 0)
    + hierarchies.length
    + (cube.measures?.length || 0)
    + unusedColumns.length;
  const columnListContentHeight = totalItemCount * COLUMN_ROW_HEIGHT;
  const columnListVisibleHeight = Math.min(totalItemCount, 10) * COLUMN_ROW_HEIGHT;
  const columnListRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const previousContentCountRef = useRef(totalItemCount);
  const columnListMaxHeight = columnListContentHeight + COLUMN_RESIZE_HANDLE_HEIGHT;
  const columnListDefaultHeight = columnListVisibleHeight + COLUMN_RESIZE_HANDLE_HEIGHT;
  const [columnListHeight, setColumnListHeight] = useState(columnListDefaultHeight);

  // The handles are rendered inside rows whose height changes with the
  // temporary schema. React Flow must recalculate their bounds after every
  // complete node render; otherwise edges can be present in state but have no
  // usable endpoint and therefore are not painted.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => updateNodeInternals(id));
    return () => window.cancelAnimationFrame(frame);
  }, [
    cube.columns.length,
    cube.dimensions?.length,
    cube.hierarchies?.length,
    cube.measures?.length,
    cube.name,
    columnListHeight,
    id,
    relationships.length,
    updateNodeInternals,
  ]);

  useEffect(() => {
    if (previousContentCountRef.current === totalItemCount) return;

    previousContentCountRef.current = totalItemCount;
    setColumnListHeight(columnListDefaultHeight);
  }, [columnListDefaultHeight, totalItemCount]);

  const startColumnResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const startY = event.clientY;
    const startHeight = columnListHeight;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextHeight = Math.max(
        columnListDefaultHeight,
        Math.min(columnListMaxHeight, startHeight + moveEvent.clientY - startY),
      );
      setColumnListHeight(nextHeight);
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', cleanup);
      document.body.style.userSelect = '';
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = cleanup;
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
  }, [columnListDefaultHeight, columnListHeight, columnListMaxHeight]);

  const expandColumnList = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setColumnListHeight(columnListMaxHeight);
  }, [columnListMaxHeight]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  function renderColumnRow(column: DiagramColumn, showKeyIndicator = true) {
    const dimension = dimensionForColumn(cube, column);
    const measure = measureForColumn(cube, column);
    const isPrimaryKey = columnIsPrimaryKey(cube, column);
    const keyRole = showKeyIndicator ? columnKeyRole(cube, column, relationships) : undefined;
    const Row = showKeyIndicator && isPrimaryKey ? PrimaryKeyColumnRow : ColumnRow;
    const displayTitle = dimension?.title || dimension?.name || column.name;
    const displayName = dimension?.name && dimension.name !== displayTitle ? dimension.name : null;
    const displayType = dimension?.type || column.type;
    const primaryKeyMenu = (
      <Menu>
        <Menu.Item
          key="dimension"
          onClick={() => openSchemaItemEditor('dimensions', cube, column, dimension)}
        >
          {dimension ? 'Editar dimensão' : 'Criar dimensão'}
        </Menu.Item>
        <Menu.Item
          key="measure"
          onClick={() => openSchemaItemEditor('measures', cube, column, measure)}
        >
          {measure ? 'Editar medida' : 'Criar medida'}
        </Menu.Item>
        {dimension ? (
          <Menu.Item
            key="delete-dimension"
            danger
            onClick={() => confirmDeleteSchemaItem(cube.name, 'dimensions', dimension.name, 'dimensão', dimensionOccurrenceIndex(dimension))}
          >
            Excluir dimensão
          </Menu.Item>
        ) : null}
        <Menu.Item
          key="primary-key"
          disabled={isPrimaryKey || Boolean(primaryKeySaving)}
          onClick={() => void markColumnAsPrimaryKey(cube.name, column)}
        >
          {isPrimaryKey ? 'Já é chave primária' : 'Transformar em chave primária'}
        </Menu.Item>
      </Menu>
    );
    const menuKey = `${cube.name}:${column.name}`;
    return (
      <Dropdown
        key={column.name}
        overlay={primaryKeyMenu}
        trigger={['click']}
        placement="bottomRight"
        visible={columnMenuKey === menuKey}
        onVisibleChange={(visible) => setColumnMenuKey(visible ? menuKey : null)}
      >
        <Row
          className="nodrag"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('.react-flow__handle')) return;
            setColumnMenuKey(menuKey);
          }}
        >
          <Handle
            id={handleId('target', column.name, 'left')}
            type="target"
            position={Position.Left}
            isConnectable={canConnectColumns}
            style={{ left: 5, width: 9, height: 9, background: '#8f86e8' }}
          />
          <Handle
            id={handleId('target', column.name, 'right')}
            type="target"
            position={Position.Right}
            isConnectable={canConnectColumns}
            style={{ right: 5, width: 9, height: 9, background: '#8f86e8', opacity: 0 }}
          />
          <Space size={6} style={{ minWidth: 0, flex: 1 }}>
            {keyRole ? (
              <Tooltip title={COLUMN_KEY_ROLE_LABELS[keyRole]}>
                <PrimaryKeyFontAwesomeIcon style={{ color: COLUMN_KEY_ROLE_COLORS[keyRole], fontSize: 13 }} />
              </Tooltip>
            ) : null}
            {dimension ? (
              <Tooltip title={`Dimensão: ${dimension.title || dimension.name}`}>
                <CubeIcon style={{ color: '#7568d8', fontSize: 13 }} />
              </Tooltip>
            ) : null}
            <div style={{ minWidth: 0, flex: 1 }}>
              <Text ellipsis style={{ maxWidth: 190, display: 'block', fontSize: 12 }}>
                {displayTitle}
              </Text>
              {displayName ? (
                <Text type="secondary" ellipsis style={{ maxWidth: 190, display: 'block', fontSize: 10 }}>
                  {displayName}
                </Text>
              ) : null}
            </div>
          </Space>
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 10 }}>{displayType || ''}</Text>
          <Dropdown overlay={primaryKeyMenu} trigger={['click']} placement="bottomRight">
            <ColumnActionButton
              type="text"
              size="small"
              style={{ display: 'none' }}
              loading={primaryKeySaving === `${cube.name}:${column.name}`}
              aria-label={`Ações da coluna ${column.name}`}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <MoreOutlined />
            </ColumnActionButton>
          </Dropdown>
          <Handle
            id={handleId('source', column.name, 'right')}
            type="source"
            position={Position.Right}
            isConnectable={canConnectColumns}
            style={{ right: 5, width: 9, height: 9, background: '#8f86e8' }}
          />
          <Handle
            id={handleId('source', column.name, 'left')}
            type="source"
            position={Position.Left}
            isConnectable={canConnectColumns}
            style={{ left: 5, width: 9, height: 9, background: '#8f86e8', opacity: 0 }}
          />
        </Row>
      </Dropdown>
    );
  }

  function renderDuplicateDimensionRow({ dimension, itemIndex }: { dimension: DiagramDimension; itemIndex: number }) {
    const displayTitle = dimension.title || dimension.name;
    const displayName = dimension.name !== displayTitle ? dimension.name : null;
    const duplicateMenu = (
      <Menu>
        <Menu.Item
          key="edit-duplicate-dimension"
          onClick={() => openSchemaItemEditor('dimensions', cube, undefined, { ...dimension, itemIndex })}
        >
          Editar dimensão
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          key="move-duplicate-dimension-up"
          disabled={!canMoveSchemaItem(cube, 'dimensions', dimension.name, 'up', itemIndex, relationships)}
          onClick={() => moveSchemaItem(cube.name, 'dimensions', dimension.name, 'up', itemIndex, relationships)}
        >
          Mover para cima
        </Menu.Item>
        <Menu.Item
          key="move-duplicate-dimension-down"
          disabled={!canMoveSchemaItem(cube, 'dimensions', dimension.name, 'down', itemIndex, relationships)}
          onClick={() => moveSchemaItem(cube.name, 'dimensions', dimension.name, 'down', itemIndex, relationships)}
        >
          Mover para baixo
        </Menu.Item>
        <Menu.Item
          key="delete-duplicate-dimension"
          danger
          onClick={() => confirmDeleteSchemaItem(cube.name, 'dimensions', dimension.name, 'dimensão', itemIndex)}
        >
          Excluir dimensão
        </Menu.Item>
      </Menu>
    );
    return (
      <Dropdown
        key={`${dimension.name}:duplicate:${itemIndex}`}
        overlay={duplicateMenu}
        trigger={['click']}
        placement="bottomRight"
      >
        <ColumnRow className="nodrag" onClick={(event) => {
          event.stopPropagation();
        }}>
          <Space size={6} style={{ minWidth: 0, flex: 1 }}>
            <Tooltip title={`Dimensão: ${displayTitle}`}>
              <CubeIcon style={{ color: '#cf1322', fontSize: 13 }} />
            </Tooltip>
            <div style={{ minWidth: 0, flex: 1 }}>
              <Text ellipsis style={{ maxWidth: 190, display: 'block', fontSize: 12 }}>
                {displayTitle}
              </Text>
              {displayName ? (
                <Text type="secondary" ellipsis style={{ maxWidth: 190, display: 'block', fontSize: 10 }}>
                  {displayName}
                </Text>
              ) : null}
            </div>
          </Space>
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 10 }}>{dimension.type || ''}</Text>
        </ColumnRow>
      </Dropdown>
    );
  }

  return (
    <CubeCard
      data-testid={`relationship-cube-${cube.name}`}
      style={selectedCubeName === cube.name ? { boxShadow: '0 0 0 2px #7568d8, 0 5px 18px rgba(55, 48, 107, 0.18)' } : undefined}
    >
      <CubeHeader>
        <Handle
          id={handleId('target', undefined, 'left')}
          type="target"
          position={Position.Left}
          isConnectable={false}
          style={{ left: 0, width: 8, height: 8, background: '#b7b4cd' }}
        />
        <Handle
          id={handleId('target', undefined, 'right')}
          type="target"
          position={Position.Right}
          isConnectable={false}
          style={{ right: 0, width: 8, height: 8, background: '#b7b4cd', opacity: 0 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingRight: 92 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {cube.title || cube.name}
            </div>
            {cube.title && cube.title !== cube.name ? (
              <div style={{ opacity: 0.72, fontSize: 11 }}>{cube.name}</div>
            ) : null}
          </div>
          <Dropdown
            visible={cubeActionMenuKey === cube.name}
            onVisibleChange={(nextVisible) => setCubeActionMenuKey(nextVisible ? cube.name : null)}
              trigger={['click']}
              placement="bottomRight"
              overlay={(
                <Menu onClick={({ key }) => {
                  if (key === 'properties') openCubePropertiesEditor(cube);
                  else if (key === 'isolate') isolateCube(cube);
                  else openSchemaItemEditor(key, cube);
                }}>
                  <Menu.Item key="properties">Editar propriedades</Menu.Item>
                  <Menu.Item key="isolate">Isolar cubo</Menu.Item>
                  <Menu.Item key="dimensions">Nova dimensão</Menu.Item>
                  <Menu.Item key="primary-key">Nova chave</Menu.Item>
                  <Menu.Item key="hierarchies">Nova hierarquia</Menu.Item>
                  <Menu.Item key="measures">Nova medida</Menu.Item>
                  <Menu.Item key="segments">Novo segmento</Menu.Item>
                  <Menu.Item key="pre_aggregations">Nova pré-agregação</Menu.Item>
                </Menu>
              )}
          >
            <Button
              className="nodrag"
              type="text"
              size="small"
              icon={<MoreOutlined />}
              aria-label={`Ações do cubo ${cube.name}`}
              onMouseDown={(event) => event.stopPropagation()}
              style={{
                position: 'absolute',
                top: 10,
                right: 12,
                width: 28,
                height: 28,
                padding: 0,
                color: '#fff',
                background: 'transparent',
                border: 0,
                fontSize: 20,
              }}
            />
          </Dropdown>
        </div>
        <Tag
          color={cube.fileType === 'yaml' ? 'blue' : 'purple'}
          style={{ position: 'absolute', right: 14, bottom: 10, marginRight: 0 }}
        >
          {cube.fileType === 'yaml' ? 'YAML' : 'JS'}
        </Tag>
        <Handle
          id={handleId('source', undefined, 'right')}
          type="source"
          position={Position.Right}
          isConnectable={false}
          style={{ right: 0, width: 8, height: 8, background: '#b7b4cd' }}
        />
        <Handle
          id={handleId('source', undefined, 'left')}
          type="source"
          position={Position.Left}
          isConnectable={false}
          style={{ left: 0, width: 8, height: 8, background: '#b7b4cd', opacity: 0 }}
        />
      </CubeHeader>

      {!cube.hasPrimaryKey ? (
        <Tooltip title="Dependendo das medidas envolvidas, o Cube pode exigir uma dimensão marcada como chave primária (primary_key).">
          <div style={{ padding: '7px 12px', color: '#ad6800', background: '#fffbe6', fontSize: 11 }}>
            Sem chave primária — algumas junções podem ser recusadas
          </div>
        </Tooltip>
      ) : null}

      <ColumnList
        ref={columnListRef}
        className="nodrag nowheel"
        style={{ height: columnListHeight }}
      >
        {cube.columnError ? (
          <Tooltip title={cube.columnError}>
            <div style={{ padding: 12, color: '#cf1322', fontSize: 12 }}>
              Não foi possível consultar as colunas
            </div>
          </Tooltip>
        ) : null}
        {diagramColumns.length === 0 && !cube.measures?.length ? (
          <div style={{ padding: 12, color: '#8c8c8c', fontSize: 12 }}>Nenhuma coluna encontrada</div>
        ) : (
          <>
          {dimensionColumns.map((column) => {
            const dimension = dimensionForColumn(cube, column);
            const measure = measureForColumn(cube, column);
            const isPrimaryKey = columnIsPrimaryKey(cube, column);
            const keyRole = columnKeyRole(cube, column, relationships);
            const Row = isPrimaryKey ? PrimaryKeyColumnRow : ColumnRow;
            const displayTitle = dimension?.title || dimension?.name || column.name;
            const displayName = dimension?.name && dimension.name !== displayTitle ? dimension.name : null;
            const displayType = dimension?.type || column.type;
            const dimensionItemIndex = dimension ? dimensionOccurrenceIndex(dimension) : undefined;
            const primaryKeyMenu = (
              <Menu>
                <Menu.Item
                  key="dimension"
                  onClick={() => openSchemaItemEditor(
                    'dimensions',
                    cube,
                    column,
                    dimension ? { ...dimension, itemIndex: dimensionOccurrenceIndex(dimension) } : undefined,
                  )}
                >
                  {dimension ? 'Editar dimensão' : 'Criar dimensão'}
                </Menu.Item>
                <Menu.Item
                  key="measure"
                  onClick={() => openSchemaItemEditor('measures', cube, column, measure)}
                >
                  {measure ? 'Editar medida' : 'Criar medida'}
                </Menu.Item>
                {dimension ? (
                  <Menu.Item
                    key="delete-dimension"
                    danger
                    onClick={() => confirmDeleteSchemaItem(cube.name, 'dimensions', dimension.name, 'dimensão', dimensionOccurrenceIndex(dimension))}
                  >
                    Excluir dimensão
                  </Menu.Item>
                ) : null}
                <Menu.Item
                  key="primary-key"
                  disabled={isPrimaryKey || Boolean(primaryKeySaving)}
                  onClick={() => void markColumnAsPrimaryKey(cube.name, column)}
                >
                  {isPrimaryKey ? 'Já é chave primária' : 'Transformar em chave primária'}
                </Menu.Item>
                {dimension ? (
                  <>
                    <Menu.Divider />
                    <Menu.Item
                      key="move-dimension-up"
                      disabled={!canMoveSchemaItem(cube, 'dimensions', dimension.name, 'up', dimensionItemIndex, relationships)}
                      onClick={() => moveSchemaItem(cube.name, 'dimensions', dimension.name, 'up', dimensionItemIndex, relationships)}
                    >
                      Mover dimensão para cima
                    </Menu.Item>
                    <Menu.Item
                      key="move-dimension-down"
                      disabled={!canMoveSchemaItem(cube, 'dimensions', dimension.name, 'down', dimensionItemIndex, relationships)}
                      onClick={() => moveSchemaItem(cube.name, 'dimensions', dimension.name, 'down', dimensionItemIndex, relationships)}
                    >
                      Mover dimensão para baixo
                    </Menu.Item>
                  </>
                ) : null}
              </Menu>
            );
            const menuKey = `${cube.name}:${column.name}`;

            return (
              <React.Fragment key={column.name}>
              {compositeKeyColumns.length > 1 && column === compositeKeyInsertColumn ? (
            <CompositeKeyRow>
              <Handle
                id={compositeHandleId('target', compositeKeyColumns, 'left')}
                type="target"
                position={Position.Left}
                isConnectable={false}
                style={{ left: 5, width: 9, height: 9, background: '#8f86e8' }}
              />
              <Handle
                id={compositeHandleId('target', compositeKeyColumns, 'right')}
                type="target"
                position={Position.Right}
                isConnectable={false}
                style={{ right: 5, width: 9, height: 9, background: '#8f86e8', opacity: 0 }}
              />
              <PrimaryKeyFontAwesomeIcon style={{ color: '#ad6800', fontSize: 13, marginRight: 8 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text ellipsis style={{ display: 'block', fontSize: 12, color: '#595959' }}>
                      ({compositeKeyColumns.join(', ')})
                    </Text>
                    <Text type="secondary" style={{ display: 'block', fontSize: 10 }}>
                      Chave composta
                    </Text>
              </div>
              <Handle
                id={compositeHandleId('source', compositeKeyColumns, 'right')}
                type="source"
                position={Position.Right}
                isConnectable={false}
                style={{ right: 5, width: 9, height: 9, background: '#8f86e8' }}
              />
              <Handle
                id={compositeHandleId('source', compositeKeyColumns, 'left')}
                type="source"
                position={Position.Left}
                isConnectable={false}
                style={{ left: 5, width: 9, height: 9, background: '#8f86e8', opacity: 0 }}
              />
            </CompositeKeyRow>
              ) : null}
              <Dropdown
                overlay={primaryKeyMenu}
                trigger={['click']}
                placement="bottomRight"
                visible={columnMenuKey === menuKey}
                onVisibleChange={(visible) => setColumnMenuKey(visible ? menuKey : null)}
              >
              <Row
                className="nodrag"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('.react-flow__handle')) return;
                  setColumnMenuKey(menuKey);
                }}
              >
                <Handle
                  id={handleId('target', column.name, 'left')}
                  type="target"
                  position={Position.Left}
                  isConnectable={canConnectColumns}
                  style={{ left: 5, width: 9, height: 9, background: '#8f86e8' }}
                />
                <Handle
                  id={handleId('target', column.name, 'right')}
                  type="target"
                  position={Position.Right}
                  isConnectable={canConnectColumns}
                  style={{ right: 5, width: 9, height: 9, background: '#8f86e8', opacity: 0 }}
                />
                <Space size={6} style={{ minWidth: 0, flex: 1 }}>
                  {keyRole ? (
                    <Tooltip title={COLUMN_KEY_ROLE_LABELS[keyRole]}>
                      <PrimaryKeyFontAwesomeIcon style={{ color: COLUMN_KEY_ROLE_COLORS[keyRole], fontSize: 13 }} />
                    </Tooltip>
                  ) : null}
                  {dimension ? (
                    <Tooltip title={`Dimensão: ${dimension.title || dimension.name}`}>
                      <CubeIcon style={{ color: '#7568d8', fontSize: 13 }} />
                    </Tooltip>
                  ) : null}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text ellipsis style={{ maxWidth: 190, display: 'block', fontSize: 12 }}>
                      {displayTitle}
                    </Text>
                    {displayName ? (
                      <Text type="secondary" ellipsis style={{ maxWidth: 190, display: 'block', fontSize: 10 }}>
                        {displayName}
                      </Text>
                    ) : null}
                  </div>
                </Space>
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 10 }}>{displayType || ''}</Text>
                <Dropdown overlay={primaryKeyMenu} trigger={['click']} placement="bottomRight">
                  <ColumnActionButton
                    type="text"
                    size="small"
                    style={{ display: 'none' }}
                    loading={primaryKeySaving === `${cube.name}:${column.name}`}
                    aria-label={`Ações da coluna ${column.name}`}
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <MoreOutlined />
                  </ColumnActionButton>
                </Dropdown>
                <Handle
                  id={handleId('source', column.name, 'right')}
                  type="source"
                  position={Position.Right}
                  isConnectable={canConnectColumns}
                  style={{ right: 5, width: 9, height: 9, background: '#8f86e8' }}
                />
                <Handle
                  id={handleId('source', column.name, 'left')}
                  type="source"
                  position={Position.Left}
                  isConnectable={canConnectColumns}
                  style={{ left: 5, width: 9, height: 9, background: '#8f86e8', opacity: 0 }}
                />
              </Row>
              </Dropdown>
              {(dimension ? duplicateDimensionsByName.get(dimension.name.toLowerCase()) : undefined)?.map(renderDuplicateDimensionRow)}
              </React.Fragment>
            );
          })}
            {hierarchies.map((hierarchy) => (
              <Dropdown
                overlay={(
                  <Menu>
                    <Menu.Item
                      key="edit-hierarchy"
                      onClick={() => openSchemaItemEditor('hierarchies', cube, undefined, hierarchy)}
                    >
                      Editar hierarquia
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item
                      key="move-hierarchy-up"
                      disabled={!canMoveSchemaItem(cube, 'hierarchies', hierarchy.name, 'up', undefined, relationships)}
                      onClick={() => moveSchemaItem(cube.name, 'hierarchies', hierarchy.name, 'up', undefined, relationships)}
                    >
                      Mover para cima
                    </Menu.Item>
                    <Menu.Item
                      key="move-hierarchy-down"
                      disabled={!canMoveSchemaItem(cube, 'hierarchies', hierarchy.name, 'down', undefined, relationships)}
                      onClick={() => moveSchemaItem(cube.name, 'hierarchies', hierarchy.name, 'down', undefined, relationships)}
                    >
                      Mover para baixo
                    </Menu.Item>
                    <Menu.Item
                      key="delete-hierarchy"
                      danger
                      onClick={() => confirmDeleteSchemaItem(cube.name, 'hierarchies', hierarchy.name, 'hierarquia')}
                    >
                      Excluir hierarquia
                    </Menu.Item>
                  </Menu>
                )}
                trigger={['click']}
                placement="bottomRight"
              >
              <HierarchyRow
                key={hierarchy.name}
                onClick={(event) => {
                  event.stopPropagation();
                }}
                title={`Hierarquia: ${hierarchy.title || hierarchy.name}`}
              >
                <ApartmentOutlined style={{ color: '#7568d8', fontSize: 13, marginTop: 2 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text ellipsis style={{ maxWidth: 245, display: 'block', fontSize: 12 }}>
                    {hierarchy.title || hierarchy.name}
                  </Text>
                  <HierarchyLevelPath>
                    {hierarchy.levels.map((level, index) => (
                      <React.Fragment key={`${hierarchy.name}:${level}:${index}`}>
                        {index > 0 ? <Text type="secondary" style={{ fontSize: 10 }}>›</Text> : null}
                        <HierarchyLevel title={level}>
                          {hierarchyDimensionLabels.get(level.toLowerCase()) || level}
                        </HierarchyLevel>
                      </React.Fragment>
                    ))}
                  </HierarchyLevelPath>
                </div>
              </HierarchyRow>
              </Dropdown>
            ))}
            {cube.measures?.map((measure) => (
              <Dropdown
                overlay={(
                  <Menu>
                    <Menu.Item
                      key="edit-measure"
                      onClick={() => openSchemaItemEditor('measures', cube, undefined, measure)}
                    >
                      Editar medida
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item
                      key="move-measure-up"
                      disabled={!canMoveSchemaItem(cube, 'measures', measure.name, 'up', undefined, relationships)}
                      onClick={() => moveSchemaItem(cube.name, 'measures', measure.name, 'up', undefined, relationships)}
                    >
                      Mover para cima
                    </Menu.Item>
                    <Menu.Item
                      key="move-measure-down"
                      disabled={!canMoveSchemaItem(cube, 'measures', measure.name, 'down', undefined, relationships)}
                      onClick={() => moveSchemaItem(cube.name, 'measures', measure.name, 'down', undefined, relationships)}
                    >
                      Mover para baixo
                    </Menu.Item>
                    <Menu.Item
                      key="delete-measure"
                      danger
                      onClick={() => confirmDeleteSchemaItem(cube.name, 'measures', measure.name, 'medida')}
                    >
                      Excluir medida
                    </Menu.Item>
                  </Menu>
                )}
                trigger={['click']}
                placement="bottomRight"
              >
                  <MeasureRow
                    key={measure.name}
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <RulerCombinedIcon style={{ color: '#389e0d', fontSize: 13 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Text ellipsis style={{ maxWidth: 190, display: 'block', fontSize: 12 }}>
                        {measure.title || measure.name}
                      </Text>
                      {measure.title && measure.title !== measure.name ? (
                        <Text type="secondary" ellipsis style={{ maxWidth: 190, display: 'block', fontSize: 10 }}>
                          {measure.name}
                        </Text>
                      ) : null}
                    </div>
                    <Text type="secondary" style={{ fontSize: 10 }}>{measure.type || ''}</Text>
                  </MeasureRow>
              </Dropdown>
            ))}
            {false && unusedColumns.length > 0 ? (
              <ColumnSection>
                <ColumnSectionHeader>
                  <span>Colunas não utilizadas ({unusedColumns.length})</span>
                </ColumnSectionHeader>
                {unusedColumns.map(column => renderColumnRow(column))}
              </ColumnSection>
            ) : null}
            {unusedColumns.map(column => renderColumnRow(column, true))}
          </>
        )}
        <ColumnResizeHandle
          className="nodrag"
          onMouseDown={startColumnResize}
          onDoubleClick={expandColumnList}
          title="Arraste para redimensionar a tabela"
          aria-label="Redimensionar tabela"
        />
      </ColumnList>
    </CubeCard>
  );
}

const nodeTypes = { cube: CubeDiagramNode };

function storedPositionForCube(
  cube: DiagramCube,
  storedPositions: Record<string, { x: number; y: number }>,
  storedState?: DiagramState,
): { x: number; y: number } | undefined {
  const direct = storedPositions[cube.name];
  if (direct) return direct;

  const stateEntries = Object.values(storedState?.cubes || {});
  const namedEntry = stateEntries.find(item => item.name === cube.name);
  return namedEntry?.position;
}

function layoutNodes(
  cubes: DiagramCube[],
  storedPositions: Record<string, { x: number; y: number }>,
  storedState?: DiagramState,
): Node[] {
  const nodes: Node[] = [];
  const columnsPerRow = 3;
  let y = 30;

  for (let rowStart = 0; rowStart < cubes.length; rowStart += columnsPerRow) {
    const row = cubes.slice(rowStart, rowStart + columnsPerRow);
    const rowHeight = Math.max(
      ...row.map(cube => {
        const itemCount = uniqueDiagramColumns(cube.columns).length + (cube.measures?.length || 0);
        return 125
          + Math.min(Math.max(itemCount, 1), 10) * COLUMN_ROW_HEIGHT
          + COLUMN_RESIZE_HANDLE_HEIGHT;
      }),
      240
    );
    row.forEach((cube, index) => {
      nodes.push({
        id: cube.name,
        type: 'cube',
        position: storedPositionForCube(cube, storedPositions, storedState) || { x: 40 + index * 380, y },
        data: { cube },
      });
    });
    y += rowHeight + 80;
  }

  return nodes;
}

function relationshipEdges(relationships: DiagramRelationship[], cubes: DiagramCube[], nodes: Node[]): Edge[] {
  const cubesByName = new Map(cubes.map(cube => [cube.name, cube]));
  const cubeNamesByKey = new Map(cubes.map(cube => [cube.name.toLowerCase(), cube.name]));
  const compositeColumnsByCube = new Map(
    cubes.map(cube => [cube.name, primaryKeyColumns(cube, relationships)])
  );

  return relationships
    .map<Edge | null>((rawJoin, relationshipIndex) => {
      const join = hydrateRelationshipColumns(rawJoin);
      const sourceName = cubeNamesByKey.get(join.sourceCube.toLowerCase());
      const targetName = cubeNamesByKey.get(join.targetCube.toLowerCase());
      if (!sourceName || !targetName) return null;
      const source = cubesByName.get(sourceName)!;
      const target = cubesByName.get(targetName)!;
      const sourceColumn = physicalColumnForRelationship(source, join.sourceColumn);
      const targetColumn = physicalColumnForRelationship(target, join.targetColumn);
      const { sourceSide, targetSide } = relationshipHandleSides({
        ...join,
        sourceCube: source.name,
        targetCube: target.name,
      }, nodes);
      const sourceColumns = join.sourceColumns?.length
        ? join.sourceColumns.map(column => physicalColumnForRelationship(source, column) || column)
        : sourceColumn ? [sourceColumn] : [];
      const targetColumns = join.targetColumns?.length
        ? join.targetColumns.map(column => physicalColumnForRelationship(target, column) || column)
        : targetColumn ? [targetColumn] : [];
      const sourceCompositeColumns = compositeColumnsByCube.get(source.name) || [];
      const targetCompositeColumns = compositeColumnsByCube.get(target.name) || [];
      const sourceHasDimension = Boolean(sourceColumn && dimensionForColumn(source, { name: sourceColumn }));
      const targetHasDimension = Boolean(targetColumn && dimensionForColumn(target, { name: targetColumn }));
      const sourceUsesCompositeRow = sourceColumns.length === 1 && !sourceHasDimension
        && sourceColumn
        && sourceCompositeColumns.some(column => column.toLowerCase() === sourceColumn.toLowerCase());
      const targetUsesCompositeRow = targetColumns.length === 1 && !targetHasDimension
        && targetColumn
        && targetCompositeColumns.some(column => column.toLowerCase() === targetColumn.toLowerCase());
      const sourceHandle = sourceColumns.length > 1 || sourceUsesCompositeRow
        ? compositeHandleId('source', sourceCompositeColumns.length > 1 ? sourceCompositeColumns : sourceColumns, sourceSide)
        : sourceHasDimension
          ? handleId('source', sourceColumn, sourceSide)
          : handleId('source', undefined, sourceSide);
      const targetHandle = targetColumns.length > 1 || targetUsesCompositeRow
        ? compositeHandleId('target', targetCompositeColumns.length > 1 ? targetCompositeColumns : targetColumns, targetSide)
        : targetHasDimension
          ? handleId('target', targetColumn, targetSide)
          : handleId('target', undefined, targetSide);
      return {
        // The pair is normally unique, but keeping the relationship index in
        // the React Flow id prevents one edge from replacing another when a
        // model has multiple joins between the same cubes.
        id: `${source.name}->${target.name}:${relationshipIndex}`,
        source: source.name,
        target: target.name,
        sourceHandle,
        targetHandle,
        type: 'relationship',
        data: { relationship: join },
        style: { stroke: '#6f63d9', strokeWidth: 2 },
      } as Edge;
    })
    .filter((edge): edge is Edge => edge !== null);
}

type HandleSide = 'left' | 'right';

function relationshipHandleSides(
  relationship: DiagramRelationship,
  nodes: Node[],
): { sourceSide: HandleSide; targetSide: HandleSide } {
  const positions = new Map(nodes.map(node => [node.id, node.position]));
  const sourcePosition = positions.get(relationship.sourceCube);
  const targetPosition = positions.get(relationship.targetCube);

  if (!sourcePosition || !targetPosition) {
    return { sourceSide: 'right', targetSide: 'left' };
  }

  // Cards have a fixed width, but their measured width is preferred when
  // React Flow already has it. Comparing the actual card intervals matters
  // when two vertically separated cards overlap horizontally: in that case
  // the nearest opposing handles point through the other card, so both ends
  // should use the same outer side.
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const sourceNode = nodeById.get(relationship.sourceCube);
  const targetNode = nodeById.get(relationship.targetCube);
  const sourceWidth = sourceNode?.width || 310;
  const targetWidth = targetNode?.width || 310;
  const sourceLeft = sourcePosition.x;
  const sourceRight = sourceLeft + sourceWidth;
  const targetLeft = targetPosition.x;
  const targetRight = targetLeft + targetWidth;
  const sourceIsLeftOfTarget = sourceLeft + sourceWidth / 2 <= targetLeft + targetWidth / 2;

  if (sourceIsLeftOfTarget) {
    return {
      sourceSide: 'right',
      targetSide: targetLeft >= sourceRight ? 'left' : 'right',
    };
  }

  return {
    sourceSide: 'left',
    targetSide: targetRight <= sourceLeft ? 'right' : 'left',
  };
}

function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const relationship = data?.relationship as DiagramRelationship | undefined;
  const [sourceCardinality, targetCardinality] = relationship
    ? RELATIONSHIP_CARDINALITIES[relationship.relationship]
    : ['1', '1'];
  const markerColor = '#6f63d9';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        interactionWidth={20}
        style={{
          stroke: markerColor,
          strokeWidth: selected ? 3 : 2,
          ...style,
        }}
      />
      {sourceCardinality === 'N' && (
        <path
          d={manySymbolPath(sourceX, sourceY, sourcePosition)}
          fill="none"
          stroke={markerColor}
          strokeWidth={selected ? 3 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}
      {targetCardinality === 'N' && (
        <path
          d={manySymbolPath(targetX, targetY, targetPosition)}
          fill="none"
          stroke={markerColor}
          strokeWidth={selected ? 3 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}
      <EdgeLabelRenderer>
        <RelationshipLabel
          className="nodrag nopan"
          aria-label={relationship ? `Relacionamento ${RELATIONSHIP_EDGE_LABELS[relationship.relationship]}` : 'Relacionamento'}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {relationship ? RELATIONSHIP_EDGE_LABELS[relationship.relationship] : '1:1'}
        </RelationshipLabel>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { relationship: RelationshipEdge };

function positionsForView(view: DiagramViewState): Record<string, { x: number; y: number }> {
  return Object.fromEntries(
    Object.entries(view.cubes || {})
      .filter(([, cube]) => Boolean(cube.position)
        && Number.isFinite(cube.position?.x)
        && Number.isFinite(cube.position?.y))
      .map(([name, cube]) => [name, cube.position as { x: number; y: number }])
  );
}

function createDiagramView(
  id: string,
  name: string,
  cubes: DiagramCube[],
  positions: Record<string, { x: number; y: number }> = {},
  visibility: Record<string, boolean> = {},
  backgroundColor = DIAGRAM_VIEW_COLORS[0],
): DiagramViewState {
  return {
    id,
    name,
    backgroundColor,
    visibility: Object.fromEntries(cubes.map(cube => [cube.name, visibility[cube.name] !== false])),
    cubes: Object.fromEntries(cubes.map(cube => {
      const position = positions[cube.name];
      return [cube.name, {
        name: cube.name,
        source: cube.source,
        ...(position ? { position } : {}),
      }];
    })),
  };
}

function normalizeDiagramViews(
  storedState: DiagramState | undefined,
  cubes: DiagramCube[],
  legacyPositions: Record<string, { x: number; y: number }>,
): { views: DiagramViewState[]; activeViewId: string } {
  const storedViews = Object.entries(storedState?.views || {})
    .filter(([id, view]) => Boolean(id && view && typeof view === 'object'))
    .map(([id, rawView], index) => {
      const view = rawView as DiagramViewState;
      const positions = positionsForView(view);
      const visibility = view.visibility || {};
      return createDiagramView(
        id,
        view.name || `View ${index + 1}`,
        cubes,
        positions,
        visibility,
        DIAGRAM_VIEW_COLORS.includes(view.backgroundColor) ? view.backgroundColor : DIAGRAM_VIEW_COLORS[index % DIAGRAM_VIEW_COLORS.length],
      );
    });

  if (storedViews.length > 0) {
    const activeViewId = storedViews.some(view => view.id === storedState?.activeViewId)
      ? storedState!.activeViewId!
      : storedViews[0].id;
    return { views: storedViews, activeViewId };
  }

  const storedPositions = Object.fromEntries(
    Object.entries(storedState?.cubes || {})
      .filter(([, cube]) => Boolean(cube.position))
      .map(([name, cube]) => [name, cube.position as { x: number; y: number }])
  );
  const defaultView = createDiagramView(
    'default',
    'Visão principal',
    cubes,
    { ...legacyPositions, ...storedPositions },
  );
  return { views: [defaultView], activeViewId: defaultView.id };
}

function captureDiagramView(
  view: DiagramViewState,
  cubes: DiagramCube[],
  currentNodes: Node[],
  visibility: Record<string, boolean>,
): DiagramViewState {
  const positions = Object.fromEntries(
    currentNodes
      .filter(node => node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
      .map(node => [node.id, node.position])
  );
  return createDiagramView(view.id, view.name, cubes, positions, visibility, view.backgroundColor);
}

export function CubeRelationshipDiagram({ visible, datamartId, tablesSchema, onClose, onChanged }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [primaryKeySaving, setPrimaryKeySaving] = useState<string | null>(null);
  const [columnMenuKey, setColumnMenuKey] = useState<string | null>(null);
  const [cubeActionMenuKey, setCubeActionMenuKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The editor source of truth is this temporary schema snapshot.
  // `diagram` remains a rendering alias while the visual projection is migrated.
  const [temporarySchemaSnapshot, setTemporarySchemaSnapshot] = useState<DiagramResponse>({ cubes: [], relationships: [] });
  const diagram = temporarySchemaSnapshot;
  const setDiagram = setTemporarySchemaSnapshot;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [draft, setDraft] = useState<RelationshipDraft | null>(null);
  const [dimensionDraft, setDimensionDraft] = useState<DimensionDraft | null>(null);
  const [schemaItemDraft, setSchemaItemDraft] = useState<SchemaItemDraft | null>(null);
  const [cubePropertiesDraft, setCubePropertiesDraft] = useState<CubePropertiesDraft | null>(null);
  const [search, setSearch] = useState('');
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<any, any> | null>(null);
  const [selectedCubeName, setSelectedCubeName] = useState<string | null>(null);
  const [cubeVisibility, setCubeVisibility] = useState<Record<string, boolean>>({});
  const [diagramViews, setDiagramViews] = useState<DiagramViewState[]>([]);
  const [activeViewId, setActiveViewId] = useState('default');
  const [viewEditorMode, setViewEditorMode] = useState<DiagramViewEditorMode | null>(null);
  const [viewEditorDraft, setViewEditorDraft] = useState({
    name: '',
    backgroundColor: DIAGRAM_VIEW_COLORS[0],
  });
  const [sampleCube, setSampleCube] = useState<DiagramCube | null>(null);
  const [pendingChanges, setPendingChanges] = useState<PendingDiagramChange[]>([]);
  const [relationshipsDirty, setRelationshipsDirty] = useState(false);
  const [projectLockToken, setProjectLockToken] = useState<string | null>(null);
  const [projectLockError, setProjectLockError] = useState<string | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const relationshipsRef = useRef<DiagramRelationship[]>([]);
  const originalSchemaSnapshotRef = useRef<string | null>(null);
  const relationshipsDirtyRef = useRef(false);
  const projectLockTokenRef = useRef<string | null>(null);
  const activeViewIdRef = useRef('default');
  const viewportInitializedRef = useRef(false);

  const positionsKey = `cube-relationship-diagram:${datamartId || window.location.pathname}`;
  const viewsKey = `${positionsKey}:views`;
  const projectLockStorageKey = `${positionsKey}:project-lock`;

  const releaseProjectLock = useCallback(() => {
    const token = projectLockTokenRef.current;
    projectLockTokenRef.current = null;
    setProjectLockToken(null);
    if (!token) return;
    void playgroundFetch('playground/schema/lock', {
      method: 'DELETE',
      headers: { 'X-Cube-Project-Lock': token },
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const acquireProjectLock = useCallback(async () => {
    setProjectLockError(null);
    let storedToken: string | null = null;
    try {
      storedToken = window.sessionStorage.getItem(projectLockStorageKey);
    } catch (_e) {
      // Session storage is optional; the server will issue a new lock.
    }
    const response = await playgroundFetch('playground/schema/lock', {
      method: 'POST',
      headers: storedToken ? { 'X-Cube-Project-Lock': storedToken } : undefined,
    });
    if (!response.ok) {
      if (response.status === 423) {
        try {
          window.sessionStorage.removeItem(projectLockStorageKey);
        } catch (_e) {
          // Ignore storage failures.
        }
      }
      throw new Error(await responseErrorMessage(response, true));
    }
    const result = await response.json() as { token: string };
    projectLockTokenRef.current = result.token;
    setProjectLockToken(result.token);
    try {
      window.sessionStorage.setItem(projectLockStorageKey, result.token);
    } catch (_e) {
      // Session storage is optional; the heartbeat still protects the session.
    }
  }, [projectLockStorageKey]);

  const readStoredPositions = useCallback(() => {
    try {
      return JSON.parse(window.localStorage.getItem(positionsKey) || '{}');
    } catch (_e) {
      return {};
    }
  }, [positionsKey]);

  const readStoredViewState = useCallback((): DiagramState | undefined => {
    try {
      return JSON.parse(window.localStorage.getItem(viewsKey) || 'null') || undefined;
    } catch (_e) {
      return undefined;
    }
  }, [viewsKey]);

  const activeView = useMemo(
    () => diagramViews.find(view => view.id === activeViewId) || diagramViews[0],
    [activeViewId, diagramViews]
  );

  useEffect(() => {
    activeViewIdRef.current = activeViewId;
  }, [activeViewId]);

  useEffect(() => {
    if (!diagramViews.length) return;
    try {
      window.localStorage.setItem(viewsKey, JSON.stringify({
        version: 2,
        activeViewId,
        views: Object.fromEntries(diagramViews.map(view => [view.id, view])),
      } satisfies DiagramState));
    } catch (_e) {
      // View preferences are best-effort and must not block diagram usage.
    }
  }, [activeViewId, diagramViews, viewsKey]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const renderDiagram = useCallback((
    snapshot: DiagramResponse,
    positionsOverride?: Record<string, { x: number; y: number }>,
  ) => {
    const positions = positionsOverride || Object.fromEntries(
      nodesRef.current
        .filter(node => node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
        .map(node => [node.id, node.position])
    );
    const renderedNodes = layoutNodes(snapshot.cubes, positions);
    nodesRef.current = renderedNodes;
    setNodes(renderedNodes);
  }, [setNodes]);

  useEffect(() => {
    relationshipsRef.current = diagram.relationships;
  }, [diagram.relationships]);

  useEffect(() => {
    renderDiagram(temporarySchemaSnapshot);
  }, [renderDiagram, temporarySchemaSnapshot]);

  useEffect(() => {
    relationshipsDirtyRef.current = relationshipsDirty;
  }, [relationshipsDirty]);

  const stageChange = useCallback((change: PendingDiagramChange) => {
    if (!projectLockTokenRef.current) {
      message.warning(projectLockError || 'O projeto está em modo somente leitura porque não foi possível adquirir o lock.');
      return false;
    }
    setPendingChanges(previous => [...previous, change]);
    return true;
  }, [projectLockError]);

  const moveSchemaItem = useCallback((
    cubeName: string,
    section: ReorderableSchemaItemSection,
    itemName: string,
    direction: 'up' | 'down',
    itemIndex?: number,
    relationships: DiagramRelationship[] = diagram.relationships,
  ) => {
    const cube = diagram.cubes.find(item => item.name === cubeName);
    if (!cube || !canMoveSchemaItem(cube, section, itemName, direction, itemIndex, relationships)) return;
    if (!stageChange({
      endpoint: 'playground/schema/reorder',
      body: { cubeName, section, itemName, direction, itemIndex },
    })) return;

    setDiagram(previous => moveSchemaItemInDiagram(
      previous,
      cubeName,
      section,
      itemName,
      direction,
      itemIndex,
      relationships,
    ));
    setColumnMenuKey(null);
    message.info('Ordem alterada localmente. Clique em Salvar para validar.');
  }, [diagram.cubes, diagram.relationships, stageChange]);

  const persistDiagramViews = useCallback(async (views: DiagramViewState[], nextActiveViewId: string) => {
    const state: DiagramState = {
      version: 2,
      activeViewId: nextActiveViewId,
      views: Object.fromEntries(views.map(view => [view.id, view])),
    };

    try {
      window.localStorage.setItem(viewsKey, JSON.stringify(state));
    } catch (_e) {
      // View preferences are best-effort and must not block diagram usage.
    }

    try {
      await playgroundFetch('playground/schema/diagram-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch (_e) {
      // Layout persistence must never prevent interacting with the diagram.
    }
  }, [viewsKey]);

  const persistDiagramState = useCallback(async (
    nextNodes?: Node[],
  ) => {
    const currentNodes = nextNodes || nodesRef.current;
    const currentView = diagramViews.find(view => view.id === activeViewId)
      || diagramViews[0]
      || createDiagramView('default', 'Visão principal', diagram.cubes);
    const capturedView = captureDiagramView(currentView, diagram.cubes, currentNodes, cubeVisibility);
    const nextViews = diagramViews.some(view => view.id === capturedView.id)
      ? diagramViews.map(view => view.id === capturedView.id ? capturedView : view)
      : [...diagramViews, capturedView];
    const state: DiagramState = {
      version: 2,
      activeViewId: activeViewId || capturedView.id,
      views: Object.fromEntries(nextViews.map(view => [view.id, view])),
    };

    setDiagramViews(nextViews);

    try {
      window.localStorage.setItem(
        positionsKey,
        JSON.stringify(Object.fromEntries(Object.entries(capturedView.cubes).map(([key, value]) => [
          value.name || key,
          value.position,
        ]))),
      );
      window.localStorage.setItem(viewsKey, JSON.stringify(state));
    } catch (_e) {
      // The project file is the source of truth; browser storage is only a legacy fallback.
    }

    try {
      await playgroundFetch('playground/schema/diagram-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch (_e) {
      // Layout persistence must never prevent interacting with the diagram.
    }
  }, [activeViewId, cubeVisibility, diagram.cubes, diagramViews, positionsKey, viewsKey]);

  const loadDiagram = useCallback(async (
    openDefaultView = false,
    relationshipOverride?: DiagramRelationship[],
  ) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [response, stateResponse] = await Promise.all([
        playgroundFetch('playground/schema/relationships'),
        playgroundFetch('playground/schema/diagram-state').catch(() => null),
      ]);
      if (!response.ok) {
        throw new Error(await relationshipResponseError(response));
      }
      const result = await response.json() as DiagramResponse;
      // Keep the file order as the persisted baseline. The temporary snapshot
      // may be normalized below and must then be saved back to the source files.
      const originalSource = schemaSnapshotSource(result);
      const normalized = normalizeDiagramForDisplay(result);
      // Keep the currently loaded relationships if a transient schema/compiler
      // failure causes the refresh endpoint to return an empty relationship
      // collection. A successful deletion still results in an empty ref here,
      // because local diagram state is updated before saving.
      const knownRelationships = relationshipsRef.current;
      const freshRelationships = normalized.diagram.relationships;
      const preserveKnownRelationships = !relationshipsDirtyRef.current
        && knownRelationships.length > freshRelationships.length;
      const loadedRelationships = relationshipOverride !== undefined
        ? relationshipOverride
        : preserveKnownRelationships
          ? knownRelationships
          : freshRelationships;
      const loadedDiagram = {
        ...normalized.diagram,
        relationships: loadedRelationships,
      };
      originalSchemaSnapshotRef.current = originalSource;
      const serverState = stateResponse?.ok ? await stateResponse.json() as DiagramState : undefined;
      const localState = readStoredViewState();
      const storedState = serverState?.views && Object.keys(serverState.views).length > 0
        ? serverState
        : localState?.views && Object.keys(localState.views).length > 0
          ? localState
          : serverState;
      const legacyPositions = readStoredPositions();
      const normalizedViews = normalizeDiagramViews(storedState, loadedDiagram.cubes, legacyPositions);
      const preferredViewId = openDefaultView ? 'default' : activeViewIdRef.current;
      const initialView = normalizedViews.views.find(view => view.id === preferredViewId)
        || normalizedViews.views.find(view => view.id === normalizedViews.activeViewId)
        || normalizedViews.views[0];
      setDiagram(loadedDiagram);
      setDiagramViews(normalizedViews.views);
      setActiveViewId(initialView.id);
      setCubeVisibility(initialView.visibility);
      renderDiagram(loadedDiagram, positionsForView(initialView));
      if (normalized.changed) {
        setRelationshipsDirty(true);
        setPendingChanges(previous => previous.some(change => change.endpoint === 'playground/schema/normalize-diagram')
          ? previous
          : [...previous, { endpoint: 'playground/schema/normalize-diagram', body: {} }]);
        message.info('O diagrama ajustou a ordem das chaves e a orientação das relações. Clique em Salvar para persistir.');
      }
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [readStoredPositions, readStoredViewState, renderDiagram]);

  const openSampleData = useCallback((cube: DiagramCube) => {
    setSelectedCubeName(cube.name);
    setSampleCube(cube);
  }, []);

  const markColumnAsPrimaryKey = useCallback((cubeName: string, column: DiagramColumn) => {
    const savingKey = `${cubeName}:${column.name}`;
    setColumnMenuKey(null);
    setPrimaryKeySaving(savingKey);
    stageChange({
      endpoint: 'playground/schema/primary-key',
      body: { cubeName, columnName: column.name },
    });
    setDiagram(previous => updateDiagramCube(previous, cubeName, cube => {
      const dimensions = [...(cube.dimensions || [])];
      const existingIndex = dimensions.findIndex(dimension => (
        dimension.name === column.name || memberReferencesColumn(dimension, column.name)
      ));
      if (existingIndex >= 0) {
        dimensions[existingIndex] = { ...dimensions[existingIndex], primaryKey: true };
      } else {
        dimensions.push({
          name: column.name.toLowerCase(),
          sql: column.name,
          type: inferDimensionType(column.type),
          primaryKey: true,
        });
      }
      const primaryDimensions = dimensions.filter(dimension => dimension.primaryKey);
      const otherDimensions = dimensions.filter(dimension => !dimension.primaryKey);
      return {
        ...cube,
        hasPrimaryKey: true,
        dimensions: [...primaryDimensions, ...otherDimensions],
        columns: cube.columns.map(item => item.name === column.name ? { ...item, primaryKey: true } : item),
      };
    }));
    message.info(`'${column.name}' foi marcada como chave primária. Clique em Salvar para validar.`);
    setPrimaryKeySaving(null);
  }, [stageChange]);

  useEffect(() => {
    if (visible) {
      setPendingChanges([]);
      setCubeVisibility({});
      setDiagramViews([]);
      setActiveViewId('default');
      setViewEditorMode(null);
      viewportInitializedRef.current = false;
      setDiagram({ cubes: [], relationships: [] });
      relationshipsRef.current = [];
      originalSchemaSnapshotRef.current = null;
      setNodes([]);
    } else {
      viewportInitializedRef.current = false;
    }
  }, [loadDiagram, setNodes, visible]);

  useEffect(() => {
    if (!visible) {
      releaseProjectLock();
      return undefined;
    }

    let cancelled = false;
    void acquireProjectLock()
      .then(() => {
        if (cancelled) {
          releaseProjectLock();
          return;
        }
        void loadDiagram(true);
      })
      .catch((error: any) => {
        if (cancelled) return;
        setProjectLockToken(null);
        projectLockTokenRef.current = null;
        setProjectLockError(error?.message || String(error));
        void loadDiagram(true);
      });

    return () => {
      cancelled = true;
      releaseProjectLock();
    };
  }, [acquireProjectLock, loadDiagram, releaseProjectLock, visible]);

  useEffect(() => {
    if (!visible || !projectLockToken) return undefined;
    const heartbeat = window.setInterval(() => {
      void playgroundFetch('playground/schema/lock/heartbeat', {
        method: 'POST',
        headers: { 'X-Cube-Project-Lock': projectLockToken },
      }).then(async response => {
        if (response.ok) return;
        const error = await responseErrorMessage(response, true);
        projectLockTokenRef.current = null;
        setProjectLockToken(null);
        try {
          window.sessionStorage.removeItem(projectLockStorageKey);
        } catch (_e) {
          // Ignore storage failures.
        }
        setProjectLockError(error || 'O lock do projeto expirou.');
        message.error(error || 'O lock do projeto expirou.');
      }).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(heartbeat);
  }, [projectLockStorageKey, projectLockToken, visible]);

  const openDimensionEditor = useCallback((cube: DiagramCube, column?: DiagramColumn, dimension?: DiagramDimension, forcePrimaryKey = false) => {
    setColumnMenuKey(null);
    setCubeActionMenuKey(null);
    setDimensionDraft({
      cubeName: cube.name,
      dimensionName: dimension?.name,
      diagramItemId: dimension?.diagramItemId,
      itemIndex: dimension ? (dimension as any).itemIndex : undefined,
      name: dimension?.name || column?.name.toLowerCase() || 'new_dimension',
      title: dimension?.title || '',
      description: (dimension as any)?.description || '',
      sql: dimension?.sql || (column ? `{CUBE}.${column.name}` : ''),
      type: dimension?.type || inferDimensionType(column?.type),
      latitude: dimension?.latitude?.sql || '',
      longitude: dimension?.longitude?.sql || '',
      primaryKey: forcePrimaryKey || Boolean(dimension?.primaryKey),
      public: (dimension as any)?.public,
      shown: (dimension as any)?.shown,
      case: (dimension as any)?.case || '',
      sub_query: (dimension as any)?.sub_query,
      format: (dimension as any)?.format || '',
      meta: (dimension as any)?.meta || '',
    });
  }, []);

  const openSchemaItemEditor = useCallback((
    action: string,
    cube: DiagramCube,
    column?: DiagramColumn,
    item?: any,
  ) => {
    setColumnMenuKey(null);
    setCubeActionMenuKey(null);
    if (action === 'dimensions') {
      openDimensionEditor(cube, column, item);
      return;
    }
    if (action === 'primary-key') {
      openDimensionEditor(cube, column, item, true);
      return;
    }

    const section = action as SchemaItemSection;
    if (!['measures', 'segments', 'hierarchies', 'pre_aggregations'].includes(section)) return;
    const defaults: Record<SchemaItemSection, Record<string, any>> = {
      measures: {
        name: item?.name || (column ? `${column.name}_measure` : 'new_measure'),
        title: item?.title || '',
        sql: item?.sql || (column ? `{CUBE}.${column.name}` : ''),
        type: item?.type || 'sum',
        description: item?.description || '',
        format: item?.format || '',
        public: item?.public,
        drill_members: Array.isArray(item?.drill_members) ? item.drill_members.join(', ') : item?.drill_members || '',
        rolling_window: item?.rolling_window || '',
        filters: item?.filters || '',
        meta: item?.meta || '',
      },
      segments: {
        name: item?.name || 'new_segment',
        title: item?.title || '',
        sql: item?.sql || '',
        description: item?.description || '',
        public: item?.public,
      },
      hierarchies: {
        name: item?.name || 'new_hierarchy',
        title: item?.title || '',
        levels: Array.isArray(item?.levels) ? item.levels.join(', ') : item?.levels || '',
        public: item?.public,
      },
      pre_aggregations: {
        name: item?.name || 'new_rollup',
        type: item?.type || 'rollup',
        measures: Array.isArray(item?.measures) ? item.measures.join(', ') : item?.measures || '',
        dimensions: Array.isArray(item?.dimensions) ? item.dimensions.join(', ') : item?.dimensions || '',
        time_dimension: item?.time_dimension || '',
        granularity: item?.granularity || 'day',
        partition_granularity: item?.partition_granularity || '',
        refresh_key: item?.refresh_key || '',
        external: item?.external,
        scheduled_refresh: item?.scheduled_refresh,
        indexes: Array.isArray(item?.indexes) ? item.indexes.join(', ') : item?.indexes || '',
      },
    };
    setSchemaItemDraft({
      cubeName: cube.name,
      section,
      itemName: item?.name,
      values: defaults[section],
    });
  }, [openDimensionEditor]);

  const openCubePropertiesEditor = useCallback((cube: DiagramCube) => {
    setColumnMenuKey(null);
    setCubeActionMenuKey(null);
    setCubePropertiesDraft({
      cubeName: cube.name,
      sourceMode: cube.sourceType === 'sql' ? 'sql' : 'sql_table',
      values: {
        name: cube.name,
        title: cube.title || '',
        description: cube.description || '',
        sql_table: cube.sourceType === 'sql_table' ? cube.source || '' : '',
        sql: cube.sourceType === 'sql' ? cube.source || '' : '',
        extends: cube.extends || '',
        data_source: cube.dataSource || 'default',
        public: cube.public,
        refresh_key: cube.refresh_key || '',
      },
    });
  }, []);

  const updateActiveView = useCallback((changes: Partial<DiagramViewState>) => {
    setDiagramViews(previous => previous.map(view => (
      view.id === activeViewId ? { ...view, ...changes } : view
    )));
  }, [activeViewId]);

  const applyViewVisibility = useCallback((visibility: Record<string, boolean>) => {
    setCubeVisibility(visibility);
    updateActiveView({ visibility });
  }, [updateActiveView]);

  const activateDiagramView = useCallback((viewId: string) => {
    const targetView = diagramViews.find(view => view.id === viewId);
    if (!targetView || targetView.id === activeViewId) return;

    const currentView = diagramViews.find(view => view.id === activeViewId);
    const capturedCurrentView = currentView
      ? captureDiagramView(currentView, diagram.cubes, nodesRef.current, cubeVisibility)
      : undefined;
    const nextViews = capturedCurrentView
      ? diagramViews.map(view => view.id === capturedCurrentView.id ? capturedCurrentView : view)
      : diagramViews;
    const nextView = nextViews.find(view => view.id === viewId) || targetView;
    setDiagramViews(nextViews);
    setActiveViewId(nextView.id);
    setCubeVisibility(nextView.visibility);
    renderDiagram(diagram, positionsForView(nextView));
    viewportInitializedRef.current = false;
    setSelectedCubeName(null);
    setCubeActionMenuKey(null);
    setColumnMenuKey(null);
  }, [activeViewId, cubeVisibility, diagram, diagramViews, renderDiagram]);

  const createDiagramViewFromCurrent = useCallback(async (name: string, backgroundColor: string) => {
    const currentView = activeView
      || createDiagramView('default', 'Visão principal', diagram.cubes);
    const capturedCurrentView = captureDiagramView(currentView, diagram.cubes, nodesRef.current, cubeVisibility);
    const newViewId = `view-${Date.now()}`;
    const newView = createDiagramView(
      newViewId,
      name.trim() || `View ${diagramViews.length + 1}`,
      diagram.cubes,
      positionsForView(capturedCurrentView),
      capturedCurrentView.visibility,
      DIAGRAM_VIEW_COLORS.includes(backgroundColor) ? backgroundColor : DIAGRAM_VIEW_COLORS[0],
    );
    const nextViews = diagramViews.map(view => view.id === capturedCurrentView.id ? capturedCurrentView : view);
    const createdViews = [...nextViews, newView];
    setDiagramViews(createdViews);
    setActiveViewId(newView.id);
    setCubeVisibility(newView.visibility);
    renderDiagram(diagram, positionsForView(newView));
    viewportInitializedRef.current = false;
    await persistDiagramViews(createdViews, newView.id);
  }, [activeView, cubeVisibility, diagram, diagramViews, persistDiagramViews, renderDiagram]);

  const openCreateDiagramView = useCallback(() => {
    setViewEditorDraft({
      name: `View ${diagramViews.length + 1}`,
      backgroundColor: DIAGRAM_VIEW_COLORS[diagramViews.length % DIAGRAM_VIEW_COLORS.length],
    });
    setViewEditorMode('create');
  }, [diagramViews.length]);

  const openEditDiagramView = useCallback(() => {
    if (!activeView) return;
    setViewEditorDraft({
      name: activeView.name,
      backgroundColor: activeView.backgroundColor,
    });
    setViewEditorMode('edit');
  }, [activeView]);

  const saveDiagramViewDraft = useCallback(async () => {
    const name = viewEditorDraft.name.trim() || 'View sem nome';
    if (viewEditorMode === 'create') {
      await createDiagramViewFromCurrent(name, viewEditorDraft.backgroundColor);
    } else if (viewEditorMode === 'edit' && activeView) {
      const updatedViews = diagramViews.map(view => view.id === activeView.id ? {
        ...view,
        name: activeView.id === 'default' ? activeView.name : name,
        backgroundColor: viewEditorDraft.backgroundColor,
      } : view);
      setDiagramViews(updatedViews);
      updateActiveView({
        name: activeView.id === 'default' ? activeView.name : name,
        backgroundColor: viewEditorDraft.backgroundColor,
      });
      await persistDiagramViews(updatedViews, activeViewId);
    }
    setViewEditorMode(null);
  }, [activeView, activeViewId, createDiagramViewFromCurrent, diagramViews, persistDiagramViews, updateActiveView, viewEditorDraft, viewEditorMode]);

  const deleteActiveDiagramView = useCallback(() => {
    if (diagramViews.length <= 1) return;
    const remainingViews = diagramViews.filter(view => view.id !== activeViewId);
    const nextView = remainingViews[0];
    setDiagramViews(remainingViews);
    setActiveViewId(nextView.id);
    setCubeVisibility(nextView.visibility);
    renderDiagram(diagram, positionsForView(nextView));
    viewportInitializedRef.current = false;
  }, [activeViewId, diagram, diagramViews, renderDiagram]);

  const isolateCube = useCallback((cube: DiagramCube) => {
    const visibleCubeNames = new Set<string>([cube.name]);
    diagram.relationships.forEach(relationship => {
      if (relationship.sourceCube === cube.name) visibleCubeNames.add(relationship.targetCube);
      if (relationship.targetCube === cube.name) visibleCubeNames.add(relationship.sourceCube);
    });
    applyViewVisibility(Object.fromEntries(
      diagram.cubes.map(item => [item.name, visibleCubeNames.has(item.name)])
    ));
    setSelectedCubeName(cube.name);
    setCubeActionMenuKey(null);
    setColumnMenuKey(null);
    viewportInitializedRef.current = false;
  }, [applyViewVisibility, diagram.cubes, diagram.relationships]);

  const isolateCubeByName = useCallback((cubeName: string) => {
    const cube = diagram.cubes.find(item => item.name === cubeName);
    if (cube) isolateCube(cube);
  }, [diagram.cubes, isolateCube]);

  const zoomCubeByName = useCallback((cubeName: string) => {
    const node = nodes.find(item => item.id === cubeName);
    if (!node || !flowInstance) return;

    if (cubeVisibility[cubeName] === false) {
      applyViewVisibility({ ...cubeVisibility, [cubeName]: true });
    }
    setSelectedCubeName(cubeName);
    window.requestAnimationFrame(() => {
      const targetNode = flowInstance.getNode(cubeName) || node;
      void flowInstance.fitView({
        nodes: [targetNode],
        padding: 0.35,
        maxZoom: 1.35,
        duration: 300,
      });
    });
  }, [applyViewVisibility, cubeVisibility, flowInstance, nodes]);

  const showFullDiagram = useCallback(() => {
    applyViewVisibility(Object.fromEntries(diagram.cubes.map(cube => [cube.name, true])));
    viewportInitializedRef.current = false;
  }, [applyViewVisibility, diagram.cubes]);

  const setCubeVisibilityForName = useCallback((cubeName: string, visibleCube: boolean) => {
    const nextVisibility = { ...cubeVisibility, [cubeName]: visibleCube };
    applyViewVisibility(nextVisibility);
    viewportInitializedRef.current = false;
  }, [applyViewVisibility, cubeVisibility]);

  const visibleCubeNames = useMemo(() => new Set(
    diagram.cubes
      .filter(cube => cubeVisibility[cube.name] !== false)
      .map(cube => cube.name)
  ), [cubeVisibility, diagram.cubes]);

  const hiddenCubeCount = diagram.cubes.length - visibleCubeNames.size;

  const cubeVisibilityRows = useMemo<CubeVisibilityRow[]>(() => diagram.cubes.map(cube => ({
    key: cube.name,
    name: cube.name,
    title: cube.title || cube.name,
    visible: cubeVisibility[cube.name] !== false,
  })), [cubeVisibility, diagram.cubes]);

  const cubeVisibilityColumns = useMemo(() => [
    {
      title: 'Cubo',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, row: CubeVisibilityRow) => (
        <div style={{ minWidth: 0 }}>
          <CubeVisibilityName title={title} style={{ fontWeight: 600 }}>{title}</CubeVisibilityName>
          {title !== row.name ? (
            <CubeVisibilityName title={row.name} style={{ color: 'rgba(0, 0, 0, 0.45)', fontSize: 11 }}>
              {row.name}
            </CubeVisibilityName>
          ) : null}
        </div>
      ),
    },
    {
      title: 'Visível',
      dataIndex: 'visible',
      key: 'visible',
      width: 62,
      align: 'center' as const,
      render: (visibleCube: boolean, row: CubeVisibilityRow) => (
        <Button
          type="text"
          size="small"
          icon={visibleCube
            ? <ViewIcon style={{ color: '#7568d8' }} />
            : <ViewOffIcon style={{ color: '#a6a2bb' }} />}
          onClick={() => setCubeVisibilityForName(row.name, !visibleCube)}
          title={visibleCube ? `Ocultar cubo ${row.name}` : `Mostrar cubo ${row.name}`}
          aria-label={visibleCube ? `Ocultar cubo ${row.name}` : `Mostrar cubo ${row.name}`}
        />
      ),
    },
  ], [setCubeVisibilityForName]);

  const visibleNodes = useMemo(() => {
    const filter = search.trim().toLocaleLowerCase();
    return nodes.map(node => {
      const cube = (diagram.cubes.find(item => item.name === node.id) || node.data.cube) as DiagramCube;
      const relationshipColumnNames = diagram.relationships.flatMap(relationship => [
        relationship.sourceCube === cube.name ? relationship.sourceColumn : undefined,
        relationship.targetCube === cube.name ? relationship.targetColumn : undefined,
      ]).filter((columnName): columnName is string => Boolean(columnName));
      const matches = cube.name.toLocaleLowerCase().includes(filter)
        || cube.title?.toLocaleLowerCase().includes(filter)
        || cube.columns.some(column => column.name.toLocaleLowerCase().includes(filter));
      return {
        ...node,
        data: {
          ...node.data,
          cube,
          relationships: diagram.relationships,
          primaryKeySaving,
          markColumnAsPrimaryKey,
          openDimensionEditor,
          openSchemaItemEditor,
          confirmDeleteSchemaItem,
          moveSchemaItem,
          openCubePropertiesEditor,
          isolateCube,
          cubeActionMenuKey,
          setCubeActionMenuKey,
          columnMenuKey,
          setColumnMenuKey,
          relationshipColumnNames,
          selectedCubeName,
        },
        hidden: (filter ? !matches : false)
          || !visibleCubeNames.has(node.id),
      };
    });
  }, [columnMenuKey, confirmDeleteSchemaItem, cubeActionMenuKey, diagram.cubes, diagram.relationships, isolateCube, markColumnAsPrimaryKey, moveSchemaItem, nodes, openCubePropertiesEditor, openDimensionEditor, openSchemaItemEditor, primaryKeySaving, search, selectedCubeName, visibleCubeNames]);

  const renderedEdges = useMemo(() => {
    return relationshipEdges(diagram.relationships, diagram.cubes, nodes);
  }, [diagram.cubes, diagram.relationships, nodes, visibleCubeNames]);

  const visibleEdges = useMemo(() => renderedEdges
    .filter(edge => visibleCubeNames.has(edge.source) && visibleCubeNames.has(edge.target)),
  [renderedEdges, visibleCubeNames]);

  useEffect(() => {
    if (!visible) return undefined;

    const debugFunction = (cubeName?: string) => {
      const snapshot = cubeName
        ? {
          cubes: diagram.cubes.filter(cube => cube.name === cubeName),
          relationships: diagram.relationships.filter(relationship => (
            relationship.sourceCube === cubeName || relationship.targetCube === cubeName
          )),
        }
        : diagram;
      const edgeByRelationshipIndex = new Map(
        renderedEdges.map(edge => [Number(String(edge.id).split(':').pop()), edge])
      );

      return {
        datamartId,
        temporarySchemaSnapshot: cloneDiagramDebugValue(snapshot),
        originalSchemaSnapshot: originalSchemaSnapshotRef.current
          ? JSON.parse(originalSchemaSnapshotRef.current)
          : null,
        pendingChanges: cloneDiagramDebugValue(pendingChanges),
        renderedNodes: nodes.map(node => ({
          id: node.id,
          position: node.position,
          hidden: node.hidden,
        })),
        renderedEdges: renderedEdges.map((edge, index) => ({
          index,
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          relationship: edge.data?.relationship,
        })),
        relationshipDiagnostics: snapshot.relationships.map((relationship, index) => {
          const source = diagram.cubes.find(cube => cube.name === relationship.sourceCube);
          const target = diagram.cubes.find(cube => cube.name === relationship.targetCube);
          const sourcePhysicalColumn = source
            ? physicalColumnForRelationship(source, relationship.sourceColumn)
            : undefined;
          const targetPhysicalColumn = target
            ? physicalColumnForRelationship(target, relationship.targetColumn)
            : undefined;
          const edge = edgeByRelationshipIndex.get(index);
          return {
            index,
            sourceCube: relationship.sourceCube,
            targetCube: relationship.targetCube,
            sourceColumn: relationship.sourceColumn,
            targetColumn: relationship.targetColumn,
            sourceColumns: relationship.sourceColumns,
            targetColumns: relationship.targetColumns,
            sourcePhysicalColumn,
            targetPhysicalColumn,
            sourceDimension: source && sourcePhysicalColumn
              ? dimensionForColumn(source, { name: sourcePhysicalColumn })?.name
              : undefined,
            targetDimension: target && targetPhysicalColumn
              ? dimensionForColumn(target, { name: targetPhysicalColumn })?.name
              : undefined,
            relationship: relationship.relationship,
            sql: relationship.sql,
            sourceHandle: edge?.sourceHandle,
            targetHandle: edge?.targetHandle,
          };
        }),
      };
    };

    const debugWindow = window as Window & {
      cubeDiagramDebug?: (cubeName?: string) => unknown;
    };
    debugWindow.cubeDiagramDebug = debugFunction;
    return () => {
      if (debugWindow.cubeDiagramDebug === debugFunction) delete debugWindow.cubeDiagramDebug;
    };
  }, [datamartId, diagram, nodes, pendingChanges, renderedEdges, visible]);

  useEffect(() => {
    if (!flowInstance || !visible || viewportInitializedRef.current) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const filter = search.trim().toLocaleLowerCase();
      const matching = flowInstance.getNodes().filter((node) => {
        const cube = node.data.cube as DiagramCube;
        return visibleCubeNames.has(node.id) && (cube.name.toLocaleLowerCase().includes(filter)
          || cube.title?.toLocaleLowerCase().includes(filter)
          || cube.columns.some(column => column.name.toLocaleLowerCase().includes(filter)));
      });
      if (matching.length > 0) {
        viewportInitializedRef.current = true;
        void flowInstance.fitView({
          nodes: search.trim() || hiddenCubeCount > 0 ? matching : undefined,
          padding: search.trim() || hiddenCubeCount > 0 ? 0.28 : 0.18,
          maxZoom: search.trim() || hiddenCubeCount > 0 ? 1.1 : 1,
          duration: 220,
        });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [diagram, flowInstance, hiddenCubeCount, search, visible, visibleCubeNames]);

  const openRelationship = useCallback((
    sourceCube: string,
    targetCube: string,
    sourceColumn?: string,
    targetColumn?: string
  ) => {
    if (sourceCube === targetCube) {
      message.warning('Conecte colunas de cubos diferentes.');
      return;
    }

    const existing = diagram.relationships.find(join => (
      join.sourceCube === sourceCube && join.targetCube === targetCube
    ));
    const reverse = existing ? undefined : diagram.relationships.find(join => (
      join.sourceCube === targetCube && join.targetCube === sourceCube
    ));

    if (reverse) {
      message.info('Já existe uma junção entre estes cubos. A definição existente será editada.');
      setDraft({
        sourceCube: reverse.sourceCube,
        targetCube: reverse.targetCube,
        sourceColumn: reverse.sourceColumn,
        targetColumn: reverse.targetColumn,
        relationship: reverse.relationship,
        operation: 'update',
        customCondition: !reverse.sourceColumn || !reverse.targetColumn,
        declaredInCube: reverse.sourceCube,
        requestedFromCube: sourceCube,
      });
      return;
    }
    const selectedSourceColumn = sourceColumn || existing?.sourceColumn;
    const selectedTargetColumn = targetColumn || existing?.targetColumn;

    setDraft({
      sourceCube,
      targetCube,
      sourceColumn: selectedSourceColumn,
      targetColumn: selectedTargetColumn,
      relationship: existing?.relationship || defaultRelationship(
        diagram.cubes.find(cube => cube.name === sourceCube),
        diagram.cubes.find(cube => cube.name === targetCube),
        selectedSourceColumn,
        selectedTargetColumn,
      ),
      operation: existing ? 'update' : 'create',
      customCondition: Boolean(existing && (!existing.sourceColumn || !existing.targetColumn)),
      declaredInCube: existing?.sourceCube,
      requestedFromCube: sourceCube,
    });
  }, [diagram.cubes, diagram.relationships]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    openRelationship(
      connection.source,
      connection.target,
      handleColumn(connection.sourceHandle),
      handleColumn(connection.targetHandle)
    );
  }, [openRelationship]);

  const saveRelationship = useCallback(() => {
    if (!draft?.sourceColumn || !draft.targetColumn) {
      message.error('Selecione uma coluna em cada cubo.');
      return;
    }

    const stored = relationshipForStorage(draft);
    const change = {
      ...stored,
      operation: draft.operation,
      replaceCustom: Boolean(draft.customCondition),
    };
    stageChange({ endpoint: 'playground/schema/relationship', body: change });
    setRelationshipsDirty(true);
    setDiagram(previous => {
      const relationship: DiagramRelationship = {
        sourceCube: stored.sourceCube,
        targetCube: stored.targetCube,
        sourceColumn: stored.sourceColumn,
        targetColumn: stored.targetColumn,
        relationship: stored.relationship,
        sql: relationshipSqlForStorage(
          stored.targetCube,
          stored.sourceColumn,
          stored.targetColumn,
        ),
      };
      const relationships = previous.relationships.filter(item => !(
        (item.sourceCube === draft.sourceCube && item.targetCube === draft.targetCube)
          || (item.sourceCube === draft.targetCube && item.targetCube === draft.sourceCube)
      ));
      return {
        ...previous,
        relationships: [...relationships, relationship],
      };
    });
    message.info(`${draft.operation === 'create' ? 'Relacionamento criado' : 'Relacionamento atualizado'} localmente. Clique em Salvar para validar.`);
    setDraft(null);
  }, [draft, stageChange]);

  const deleteRelationship = useCallback(() => {
    if (!draft) return;
    stageChange({
      endpoint: 'playground/schema/relationship',
      body: {
        sourceCube: draft.sourceCube,
        targetCube: draft.targetCube,
        operation: 'delete',
      },
    });
    setRelationshipsDirty(true);
    setDiagram(previous => ({
      ...previous,
      relationships: previous.relationships.filter(item => !(
        (item.sourceCube === draft.sourceCube && item.targetCube === draft.targetCube)
          || (item.sourceCube === draft.targetCube && item.targetCube === draft.sourceCube)
      )),
    }));
    message.info('Relacionamento removido localmente. Clique em Salvar para validar.');
    setDraft(null);
  }, [draft, stageChange]);

  const saveDimension = useCallback(() => {
    if (!dimensionDraft) return;
    const textValue = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && 'sql' in value) return String((value as any).sql || '');
      return value == null ? '' : String(value);
    };
    const name = textValue(dimensionDraft.name).trim();
    const title = textValue(dimensionDraft.title).trim();
    const sql = textValue(dimensionDraft.sql).trim();
    const latitude = textValue(dimensionDraft.latitude).trim();
    const longitude = textValue(dimensionDraft.longitude).trim();

    if (!name) {
      message.error('Informe o nome e o SQL da dimensão.');
      return;
    }

    const isGeo = dimensionDraft.type === 'geo';
    if (isGeo && (!latitude || !longitude)) {
      message.error('Informe o SQL da latitude e da longitude.');
      return;
    }
    if (!isGeo && !sql) {
      message.error('Informe o SQL da dimensão.');
      return;
    }

    const values = {
      name,
      title,
      description: dimensionDraft.description,
      type: dimensionDraft.type,
      primary_key: dimensionDraft.primaryKey ? true : null,
      public: dimensionDraft.public,
      shown: dimensionDraft.shown,
      case: dimensionDraft.case,
      sub_query: dimensionDraft.sub_query,
      format: dimensionDraft.format,
      meta: dimensionDraft.meta,
      ...(isGeo
        ? {
          latitude: { sql: latitude },
          longitude: { sql: longitude },
        }
        : { sql }),
    };
    stageChange({
      endpoint: 'playground/schema/item',
      body: {
        cubeName: dimensionDraft.cubeName,
        section: 'dimensions',
        itemName: dimensionDraft.dimensionName || undefined,
        ...(dimensionDraft.itemIndex !== undefined ? { itemIndex: dimensionDraft.itemIndex } : {}),
        values,
      },
    });
    setDiagram(previous => {
      const updated = updateDiagramCubeMembers(
        previous,
        dimensionDraft.cubeName,
        'dimensions',
        dimensionDraft.dimensionName,
        { ...values, primaryKey: dimensionDraft.primaryKey },
        'upsert',
        dimensionDraft.itemIndex,
      );
      return renameDimensionReferences(
        updated,
        dimensionDraft.cubeName,
        dimensionDraft.dimensionName,
        name,
      );
    });
    if (dimensionDraft.dimensionName && dimensionDraft.dimensionName.toLowerCase() !== name.toLowerCase()) {
      setRelationshipsDirty(true);
    }
    message.info(`${dimensionDraft.dimensionName ? 'Dimensão atualizada' : 'Dimensão criada'} localmente. Clique em Salvar para validar.`);
    setDimensionDraft(null);
  }, [dimensionDraft, stageChange]);

  function deleteSchemaItem(
    cubeName: string,
    section: 'dimensions' | 'measures' | 'hierarchies',
    itemName: string,
    label: string,
    itemIndex?: number,
  ) {
    stageChange({
      endpoint: 'playground/schema/item',
      body: {
        cubeName,
        section,
        itemName,
        ...(itemIndex !== undefined ? { itemIndex } : {}),
        operation: 'delete',
      },
    });
    setDiagram(previous => section === 'hierarchies'
      ? updateDiagramCubeHierarchy(previous, cubeName, itemName, {}, 'delete')
      : updateDiagramCubeMembers(previous, cubeName, section, itemName, {}, 'delete', itemIndex));
    message.info(`${label} removida localmente. Clique em Salvar para validar.`);
  }

  function confirmDeleteSchemaItem(
    cubeName: string,
    section: 'dimensions' | 'measures' | 'hierarchies',
    itemName: string,
    label: string,
    itemIndex?: number,
  ) {
    Modal.confirm({
      title: `Excluir ${label}?`,
      content: `A ${label} "${itemName}" será removida do arquivo de modelo.`,
      okText: 'Excluir',
      okType: 'danger',
      cancelText: 'Cancelar',
      onOk: () => deleteSchemaItem(cubeName, section, itemName, label, itemIndex),
    });
  }

  const deleteDimension = useCallback(() => {
    if (!dimensionDraft?.dimensionName) return;

    stageChange({
      endpoint: 'playground/schema/item',
      body: {
        cubeName: dimensionDraft.cubeName,
        section: 'dimensions',
        itemName: dimensionDraft.dimensionName,
        ...(dimensionDraft.itemIndex !== undefined ? { itemIndex: dimensionDraft.itemIndex } : {}),
        operation: 'delete',
      },
    });
    setDiagram(previous => updateDiagramCubeMembers(
      previous,
      dimensionDraft.cubeName,
      'dimensions',
      dimensionDraft.dimensionName,
      {},
      'delete',
      dimensionDraft.itemIndex,
    ));
    message.info('Dimensão removida localmente. Clique em Salvar para validar.');
    setDimensionDraft(null);
  }, [dimensionDraft, stageChange]);

  const saveSchemaItem = useCallback(() => {
    if (!schemaItemDraft) return;
    const values = { ...schemaItemDraft.values };
    if (!String(values.name || '').trim()) {
      message.error('Informe o nome do item.');
      return;
    }
    if (schemaItemDraft.section === 'hierarchies' && typeof values.levels === 'string') {
      values.levels = values.levels.split(',').map((value: string) => value.trim()).filter(Boolean);
    } else if (schemaItemDraft.section === 'hierarchies' && Array.isArray(values.levels)) {
      values.levels = values.levels
        .map((value: any) => {
          if (typeof value === 'string') return value.trim();
          if (value && typeof value === 'object') return String(value.name || value.value || '').trim();
          return value == null ? '' : String(value).trim();
        })
        .filter(Boolean);
    }
    if (schemaItemDraft.section === 'pre_aggregations') {
      ['measures', 'dimensions', 'indexes'].forEach((key) => {
        if (typeof values[key] === 'string') {
          values[key] = values[key].split(',').map((value: string) => value.trim()).filter(Boolean);
        }
      });
    }
    if (schemaItemDraft.section === 'measures' && typeof values.drill_members === 'string') {
      values.drill_members = values.drill_members.split(',').map((value: string) => value.trim()).filter(Boolean);
    }
    if (schemaItemDraft.section === 'measures') {
      const filters = normalizeMeasureFilters(values.filters);
      if (filters) values.filters = filters;
      else delete values.filters;
    }

    stageChange({
      endpoint: 'playground/schema/item',
      body: {
        cubeName: schemaItemDraft.cubeName,
        section: schemaItemDraft.section,
        itemName: schemaItemDraft.itemName,
        values,
      },
    });
    if (schemaItemDraft.section === 'measures') {
      setDiagram(previous => updateDiagramCubeMembers(
        previous,
        schemaItemDraft.cubeName,
        'measures',
        schemaItemDraft.itemName,
        values,
      ));
    }
    if (schemaItemDraft.section === 'hierarchies') {
      setDiagram(previous => updateDiagramCubeHierarchy(
        previous,
        schemaItemDraft.cubeName,
        schemaItemDraft.itemName,
        values,
      ));
    }
    message.info('Item alterado localmente. Clique em Salvar para validar.');
    setSchemaItemDraft(null);
  }, [schemaItemDraft, stageChange]);

  const saveCubeProperties = useCallback(() => {
    if (!cubePropertiesDraft) return;
    const values = Object.fromEntries(
      Object.entries(cubePropertiesDraft.values).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() : value,
      ])
    );
    delete values[cubePropertiesDraft.sourceMode === 'sql' ? 'sql_table' : 'sql'];
    if (!values.name) {
      message.error('Informe o nome do cubo.');
      return;
    }

    stageChange({
      endpoint: 'playground/schema/item',
      body: {
        cubeName: cubePropertiesDraft.cubeName,
        section: 'cube',
        values,
      },
    });
    setDiagram(previous => updateDiagramCube(previous, cubePropertiesDraft.cubeName, cube => ({
      ...cube,
      title: values.title,
      description: values.description,
      source: values.sql_table || values.sql || cube.source,
      sourceType: values.sql ? 'sql' : 'sql_table',
      dataSource: values.data_source || cube.dataSource,
      extends: values.extends,
      public: values.public,
      refresh_key: values.refresh_key,
    })));
    message.info('Propriedades alteradas localmente. Clique em Salvar para validar.');
    setCubePropertiesDraft(null);
  }, [cubePropertiesDraft, stageChange]);

  function updateSchemaItemValue(key: string, value: any) {
    setSchemaItemDraft(previous => previous ? {
      ...previous,
      values: { ...previous.values, [key]: value },
    } : previous);
  }

  function updateDimensionValue(key: string, value: any) {
    setDimensionDraft(previous => {
      if (!previous) return previous;
      if (key === 'primary_key') return { ...previous, primaryKey: Boolean(value) };
      return { ...previous, [key]: value };
    });
  }

  function renderSchemaItemFields() {
    if (!schemaItemDraft) return null;
    return (
      (() => {
        const formProps = {
          values: schemaItemDraft.values,
          columns: diagram.cubes.find(cube => cube.name === schemaItemDraft.cubeName)?.columns,
          tablesSchema,
          dimensionOptions: (diagram.cubes.find(cube => cube.name === schemaItemDraft.cubeName)?.dimensions || [])
            .map(dimension => ({ name: dimension.name, title: dimension.title }))
            .filter(dimension => dimension.name),
          onChange: updateSchemaItemValue,
        };
        if (schemaItemDraft.section === 'measures') return <MeasureForm {...formProps} />;
        if (schemaItemDraft.section === 'segments') return <SegmentForm {...formProps} />;
        if (schemaItemDraft.section === 'hierarchies') return <HierarchyForm {...formProps} />;
        return <PreAggregationForm {...formProps} />;
      })()
    );
  }

  const source = draft ? diagram.cubes.find(cube => cube.name === draft.sourceCube) : undefined;
  const target = draft ? diagram.cubes.find(cube => cube.name === draft.targetCube) : undefined;
  const selectedCube = selectedCubeName
    ? diagram.cubes.find(cube => cube.name === selectedCubeName)
    : undefined;

  const savePendingChanges = useCallback(async (closeAfterSave = false) => {
    if (saving) return;
    if (!projectLockTokenRef.current) {
      message.error(projectLockError || 'Não é possível salvar porque o projeto está bloqueado por outra sessão.');
      return;
    }
    const temporarySource = schemaSnapshotSource(diagram);
    const sourceChanged = originalSchemaSnapshotRef.current === null || originalSchemaSnapshotRef.current !== temporarySource;
    if (!pendingChanges.length || !sourceChanged) {
      setPendingChanges([]);
      await persistDiagramState();
      message.info('Nenhuma alteração na estrutura de dados para salvar');
      if (closeAfterSave) onClose();
      return;
    }

    setSaving(true);
    try {
      // Persist the current layout independently; the schema snapshot below is
      // the only source that changes the model files.
      await persistDiagramState();
      const response = await playgroundFetch('playground/schema/snapshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cube-Project-Lock': projectLockTokenRef.current || '',
        },
        body: JSON.stringify({
          cubes: schemaSnapshotForSave(diagram.cubes, diagram.relationships),
        }),
      });
      if (!response.ok) {
        throw new Error(await relationshipResponseError(response));
      }
      const result = await response.json() as { changed?: boolean };

      setPendingChanges([]);
      originalSchemaSnapshotRef.current = temporarySource;
      relationshipsDirtyRef.current = false;
      setRelationshipsDirty(false);
      // The temporary schema snapshot is already the render source of truth.
      // Saving only persists it; do not rebuild nodes, visibility, positions or
      // the viewport from a new server read here.
      try {
        await onChanged();
      } catch (_e) {
        message.warning('As alterações foram salvas, mas a lista de arquivos não pôde ser atualizada.');
      }
      message.success(result.changed === false
        ? 'Nenhuma alteração na estrutura de dados para salvar'
        : 'Estrutura de dados salva');
      if (closeAfterSave) onClose();
    } catch (e: any) {
      const errorMessage = typeof e === 'string'
        ? e
        : e?.message || e?.error || String(e || '');
      message.error(errorMessage || 'Não foi possível salvar as alterações');
    } finally {
      setSaving(false);
    }
  }, [diagram.cubes, diagram.relationships, onChanged, onClose, pendingChanges, persistDiagramState, projectLockError, relationshipsDirty, saving]);

  const handleCancel = useCallback(() => {
    setPendingChanges([]);
    setDraft(null);
    setDimensionDraft(null);
    setSchemaItemDraft(null);
    setCubePropertiesDraft(null);
    setSampleCube(null);
    setViewEditorMode(null);
    onClose();
  }, [onClose]);

  function handleDiagramShortcut(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void savePendingChanges(true);
      return;
    }

    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      handleCancel();
      return;
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void savePendingChanges(false);
    }
  }

  useEffect(() => {
    if (!visible) return undefined;

    const handleModalShortcut = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.cube-diagram-editor-modal')) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        void savePendingChanges(true);
        return;
      }

      if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        handleCancel();
        return;
      }

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        void savePendingChanges(false);
      }
    };

    document.addEventListener('keydown', handleModalShortcut, true);
    return () => document.removeEventListener('keydown', handleModalShortcut, true);
  }, [handleCancel, savePendingChanges, visible]);

  const sampleColumnTypes = useMemo(() => Object.fromEntries([
    ...(sampleCube?.columns || []).map(column => [column.name.toLowerCase(), column.type] as const),
    ...(sampleCube?.dimensions || []).map(dimension => [dimension.name.toLowerCase(), dimension.type] as const),
    ...(sampleCube?.measures || []).map(measure => [measure.name.toLowerCase(), measure.type] as const),
  ]), [sampleCube]);

  return (
    <>
      <Modal
        title={(
          <DiagramModalTitle>
            <Space>
              <ApartmentOutlined />
              <span>Diagrama de relacionamentos</span>
            </Space>
            <DiagramModalActions>
              <DiagramModalAction>
                <Button onClick={handleCancel} disabled={saving}>Cancelar</Button>
                <DiagramModalShortcutHint>Shift + Enter</DiagramModalShortcutHint>
              </DiagramModalAction>
              <DiagramModalAction>
                <Button onClick={() => savePendingChanges(false)} loading={saving} disabled={!projectLockToken}>Salvar</Button>
                <DiagramModalShortcutHint>Ctrl + Enter</DiagramModalShortcutHint>
              </DiagramModalAction>
              <DiagramModalAction>
                <Button type="primary" onClick={() => savePendingChanges(true)} loading={saving} disabled={!projectLockToken}>Salvar e fechar</Button>
                <DiagramModalShortcutHint>Ctrl + Shift + Enter</DiagramModalShortcutHint>
              </DiagramModalAction>
            </DiagramModalActions>
          </DiagramModalTitle>
        )}
        visible={visible}
        onCancel={handleCancel}
        closable={false}
        keyboard={false}
        maskClosable={false}
        className="cube-modal-wide"
        bodyStyle={{
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 110px)',
          padding: 0,
          overflow: 'hidden',
        }}
        destroyOnClose
        footer={null}
      >
        <div
          onKeyDownCapture={handleDiagramShortcut}
          style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}
        >
          <Toolbar>
          <Space size={12}>
            <Input.Search
              allowClear
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar cubo ou coluna"
              style={{ width: 280 }}
            />
            <Text type="secondary">
              Arraste entre colunas para criar junções. Clique em uma ligação para editar ou remover. 1 = um, N = muitos.
              {pendingChanges.length ? ` ${pendingChanges.length} alteração(ões) pendente(s).` : ''}
            </Text>
          </Space>
          <Space style={{ marginLeft: 'auto' }}>
            <Button
              icon={<SearchOutlined />}
              disabled={!selectedCube}
              onClick={() => selectedCube && openSampleData(selectedCube)}
            >
              Ver amostra de dados
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => loadDiagram()} loading={loading} disabled={Boolean(pendingChanges.length)}>
              Atualizar
            </Button>
          </Space>
          </Toolbar>

          {projectLockError ? (
            <Alert
              type="warning"
              showIcon
              message="Projeto em modo somente leitura"
              description={projectLockError}
              style={{ margin: '0 14px 8px' }}
            />
          ) : null}

          <DiagramViewsBar>
            <Text strong style={{ fontSize: 12 }}>Views:</Text>
            <Select
              size="small"
              value={activeView?.id}
              style={{ width: 300 }}
              placeholder="Selecione uma view"
              options={diagramViews.map(view => ({ label: view.name, value: view.id }))}
              onChange={activateDiagramView}
            />
            <Input
              size="small"
              value={activeView?.name || ''}
              disabled={!activeView || activeView.id === 'default'}
              onChange={event => updateActiveView({ name: event.target.value || 'View sem nome' })}
              style={{ width: 170, display: 'none' }}
              title={activeView?.id === 'default' ? 'A view principal não pode ser renomeada' : 'Nome da view'}
              aria-label="Nome da view"
            />
            <Tooltip title="Selecione a cor pastel da view">
              <DiagramViewColorPalette aria-label="Paleta de cores da view" style={{ display: 'none' }}>
                {DIAGRAM_VIEW_COLORS.map(color => (
                  <DiagramViewColorSwatch
                    key={color}
                    type="button"
                    $color={color}
                    $selected={activeView?.backgroundColor === color}
                    onClick={() => updateActiveView({ backgroundColor: color })}
                    title={color}
                    aria-label={`Usar cor ${color}`}
                  />
                ))}
              </DiagramViewColorPalette>
            </Tooltip>
            <Button size="small" onClick={openCreateDiagramView} disabled={!projectLockToken || !diagram.cubes.length}>
              Nova view
            </Button>
            {activeView?.id !== 'default' ? (
              <>
                <Button size="small" onClick={openEditDiagramView} disabled={!projectLockToken || !activeView}>
                  Editar view
                </Button>
                <ConfirmPopover
                  title="Excluir a view atual?"
                  okText="Excluir"
                  cancelText="Cancelar"
                  onConfirm={deleteActiveDiagramView}
                >
                  <Button size="small" danger disabled={!projectLockToken || diagramViews.length <= 1}>
                    Excluir
                  </Button>
                </ConfirmPopover>
              </>
            ) : null}
          </DiagramViewsBar>

        {loadError ? (
          <div style={{ padding: 24 }}>
            <Alert
              type="error"
              showIcon
              message="Não foi possível carregar o diagrama"
              description={loadError}
              action={<Button onClick={() => loadDiagram()}>Tentar novamente</Button>}
            />
          </div>
        ) : loading && diagram.cubes.length === 0 ? (
          <div style={{ height: 520, display: 'grid', placeItems: 'center' }}>
            <Spin tip="Consultando colunas dos cubos..." />
          </div>
        ) : diagram.cubes.length === 0 ? (
          <Empty style={{ marginTop: 100 }} description="Nenhum cubo disponível" />
        ) : (
          <DiagramWorkspace>
            <CubeVisibilityPanel>
              <CubeVisibilityPanelHeader>
                <span>Cubos</span>
                <Space size={6}>
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    {hiddenCubeCount > 0 ? `${hiddenCubeCount} oculto(s)` : 'Todos visíveis'}
                  </Text>
                  <Button
                    type="text"
                    size="small"
                    disabled={hiddenCubeCount === 0}
                    onClick={showFullDiagram}
                    title="Mostrar todos os cubos"
                  >
                    Todos
                  </Button>
                </Space>
              </CubeVisibilityPanelHeader>
              <CubeVisibilityTable>
                <CubeVisibilityTableHeader role="row">
                  <div>Cubo</div>
                  <div title="Visível">Vis.</div>
                </CubeVisibilityTableHeader>
                {cubeVisibilityRows.map(row => (
                  <CubeVisibilityTableRow key={row.key} role="row">
                    <CubeVisibilityTableCell>
                      <CubeVisibilityName title={row.title} style={{ fontWeight: 600 }}>{row.title}</CubeVisibilityName>
                      {row.title !== row.name ? (
                        <CubeVisibilityName title={row.name} style={{ color: 'rgba(0, 0, 0, 0.45)', fontSize: 11 }}>
                          {row.name}
                        </CubeVisibilityName>
                      ) : null}
                    </CubeVisibilityTableCell>
                    <CubeVisibilityIconCell>
                      <Button
                        type="text"
                        size="small"
                        icon={row.visible
                          ? <ViewIcon style={{ color: '#7568d8' }} />
                          : <ViewOffIcon style={{ color: '#a6a2bb' }} />}
                        onClick={() => setCubeVisibilityForName(row.name, !row.visible)}
                        title={row.visible ? `Ocultar cubo ${row.name}` : `Mostrar cubo ${row.name}`}
                        aria-label={row.visible ? `Ocultar cubo ${row.name}` : `Mostrar cubo ${row.name}`}
                      />
                      <Dropdown
                        trigger={['click']}
                        placement="bottomRight"
                        overlay={(
                          <Menu
                            onClick={({ key }) => {
                              if (key === 'isolate') isolateCubeByName(row.name);
                              if (key === 'zoom') zoomCubeByName(row.name);
                            }}
                          >
                            <Menu.Item key="isolate">Isolar cubo</Menu.Item>
                            <Menu.Item key="zoom">Dar zoom no cubo</Menu.Item>
                          </Menu>
                        )}
                      >
                        <Button
                          type="text"
                          size="small"
                          icon={<MoreOutlined />}
                          title={`Ações do cubo ${row.name}`}
                          aria-label={`Ações do cubo ${row.name}`}
                        />
                      </Dropdown>
                    </CubeVisibilityIconCell>
                  </CubeVisibilityTableRow>
                ))}
              </CubeVisibilityTable>
            </CubeVisibilityPanel>
            <Canvas $backgroundColor={activeView?.backgroundColor}>
            <ReactFlow
              nodes={visibleNodes}
              edges={visibleEdges}
              nodesDraggable={Boolean(projectLockToken)}
              nodesConnectable={Boolean(projectLockToken)}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={() => undefined}
              onConnect={onConnect}
              onInit={(instance) => {
                setFlowInstance(instance);
              }}
              onMoveStart={() => {
                setColumnMenuKey(null);
                setCubeActionMenuKey(null);
              }}
              onNodeClick={(_event, node) => setSelectedCubeName(node.id)}
              onPaneClick={() => setSelectedCubeName(null)}
              onEdgeClick={(_event, edge) => {
                const relationship = edge.data?.relationship as DiagramRelationship | undefined;
                if (relationship) {
                  openRelationship(
                    relationship.sourceCube,
                    relationship.targetCube,
                    relationship.sourceColumn,
                    relationship.targetColumn
                  );
                }
              }}
              onNodeDragStop={(_event, _node, draggedNodes) => {
                const nextNodes = draggedNodes?.length ? nodes.map(node => (
                  draggedNodes.find(dragged => dragged.id === node.id) || node
                )) : nodes;
                nodesRef.current = nextNodes;
                if (activeView) {
                  setDiagramViews(previous => previous.map(view => view.id === activeView.id
                    ? captureDiagramView(view, diagram.cubes, nextNodes, cubeVisibility)
                    : view));
                }
                try {
                  const positions = Object.fromEntries(nextNodes.map(node => [node.id, node.position]));
                  window.localStorage.setItem(positionsKey, JSON.stringify(positions));
                } catch (_e) {
                  // The diagram still works when browser storage is unavailable.
                }
              }}
              isValidConnection={(connection) => connection.source !== connection.target}
              edgesReconnectable={false}
              fitView={false}
              minZoom={0.2}
              maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#d9d8e8" gap={22} />
              <MiniMap pannable zoomable nodeColor="#7a72b8" maskColor="rgba(245, 245, 252, 0.75)" />
              <Controls showInteractive={false} />
            </ReactFlow>
            </Canvas>
          </DiagramWorkspace>
          )}
        </div>
      </Modal>

      <Modal
        title={viewEditorMode === 'create' ? 'Nova view' : 'Editar view'}
        visible={Boolean(viewEditorMode)}
        onCancel={() => setViewEditorMode(null)}
        maskClosable={false}
        destroyOnClose
        width={520}
        footer={[
          <Button key="cancel" onClick={() => setViewEditorMode(null)}>Cancelar</Button>,
          <Button key="save" type="primary" onClick={saveDiagramViewDraft}>Salvar</Button>,
        ]}
      >
        <Form layout="vertical">
          <Form.Item label="Nome da view">
            <Input
              value={viewEditorDraft.name}
              disabled={viewEditorMode === 'edit' && activeView?.id === 'default'}
              onChange={event => setViewEditorDraft(previous => ({ ...previous, name: event.target.value }))}
              placeholder="Informe o nome da view"
            />
          </Form.Item>
          <Form.Item label="Cor de fundo">
            <DiagramViewColorPalette>
              {DIAGRAM_VIEW_COLORS.map(color => (
                <DiagramViewColorSwatch
                  key={color}
                  type="button"
                  $color={color}
                  $selected={viewEditorDraft.backgroundColor === color}
                  onClick={() => setViewEditorDraft(previous => ({ ...previous, backgroundColor: color }))}
                  title={color}
                  aria-label={`Usar cor ${color}`}
                />
              ))}
            </DiagramViewColorPalette>
          </Form.Item>
        </Form>
      </Modal>

      <CubeSampleDataModal
        visible={Boolean(sampleCube)}
        cubeName={sampleCube?.name || null}
        title={sampleCube?.title || sampleCube?.name}
        columnTypes={sampleColumnTypes}
        onClose={() => setSampleCube(null)}
      />

      <Modal
        title={schemaItemDraft ? `${schemaItemDraft.itemName ? 'Editar' : 'Nova'} ${schemaItemDraft.section === 'measures' ? 'medida' : schemaItemDraft.section === 'segments' ? 'segmento' : schemaItemDraft.section === 'hierarchies' ? 'hierarquia' : 'pré-agregação'}` : ''}
        visible={Boolean(schemaItemDraft)}
        className="cube-diagram-editor-modal"
        onCancel={() => setSchemaItemDraft(null)}
        maskClosable={false}
        destroyOnClose
        width={780}
        footer={[
          <Button key="cancel" onClick={() => setSchemaItemDraft(null)} disabled={saving}>Cancelar</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveSchemaItem}>Salvar</Button>,
        ]}
      >
        <div onKeyDownCapture={(event) => handleEditorFormShortcut(event, saveSchemaItem)}>
        {schemaItemDraft ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <DiagramDocumentationLink section={schemaItemDraft.section} />
          </div>
        ) : null}
        {schemaItemDraft ? renderSchemaItemFields() : null}
        </div>
      </Modal>

      <Modal
        title={<DiagramEditorModalTitle title="Editar propriedades" section="cube" />}
        visible={Boolean(cubePropertiesDraft)}
        className="cube-diagram-editor-modal"
        onCancel={() => setCubePropertiesDraft(null)}
        maskClosable={false}
        destroyOnClose
        width={780}
        footer={[
          <Button key="cancel" onClick={() => setCubePropertiesDraft(null)} disabled={saving}>Cancelar</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveCubeProperties}>Salvar</Button>,
        ]}
      >
        <div onKeyDownCapture={(event) => handleEditorFormShortcut(event, saveCubeProperties)}>
        {cubePropertiesDraft ? (
          <CubeForm
            values={cubePropertiesDraft.values}
            tablesSchema={tablesSchema}
            onChange={(key, value) => setCubePropertiesDraft({
              ...cubePropertiesDraft,
              values: { ...cubePropertiesDraft.values, [key]: value },
            })}
            source={{
              mode: cubePropertiesDraft.sourceMode,
              onModeChange: (mode) => setCubePropertiesDraft(previous => {
                if (!previous) return previous;
                const values = { ...previous.values };
                delete values[mode === 'sql' ? 'sql_table' : 'sql'];
                return { ...previous, sourceMode: mode, values };
              }),
            }}
          />
        ) : null}
        </div>
      </Modal>

      <Modal
        title={dimensionDraft?.dimensionName ? 'Editar dimensão' : 'Criar dimensão'}
        visible={Boolean(dimensionDraft)}
        className="cube-diagram-editor-modal"
        onCancel={() => setDimensionDraft(null)}
        maskClosable={false}
        destroyOnClose
        width={780}
        footer={[
          dimensionDraft?.dimensionName ? (
            <ConfirmPopover
              key="delete"
              title="Remover esta dimensão?"
              onConfirm={deleteDimension}
              okText="Remover"
              cancelText="Cancelar"
            >
              <Button danger loading={saving} style={{ float: 'left' }}>Remover</Button>
            </ConfirmPopover>
          ) : null,
          <Button key="cancel" onClick={() => setDimensionDraft(null)} disabled={saving}>Cancelar</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveDimension}>Salvar</Button>,
        ]}
      >
        <div onKeyDownCapture={(event) => handleEditorFormShortcut(event, saveDimension)}>
        {dimensionDraft ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <DiagramDocumentationLink section="dimensions" />
          </div>
        ) : null}
        {dimensionDraft ? (
          <DimensionForm
            values={{ ...dimensionDraft, primary_key: dimensionDraft.primaryKey }}
            columns={diagram.cubes.find(cube => cube.name === dimensionDraft.cubeName)?.columns}
            tablesSchema={tablesSchema}
            onChange={updateDimensionValue}
          />
        ) : null}
        </div>
      </Modal>

      <Modal
        title={draft?.operation === 'create' ? 'Criar relacionamento' : 'Editar relacionamento'}
        visible={Boolean(draft)}
        className="cube-diagram-editor-modal"
        onCancel={() => setDraft(null)}
        width={620}
        destroyOnClose
        footer={[
          draft?.operation === 'update' ? (
            <ConfirmPopover
              key="delete"
              title="Remover este relacionamento?"
              onConfirm={deleteRelationship}
              okText="Remover"
              cancelText="Cancelar"
            >
              <Button danger loading={saving} style={{ float: 'left' }}>Remover</Button>
            </ConfirmPopover>
          ) : null,
          <Button key="cancel" onClick={() => setDraft(null)} disabled={saving}>Cancelar</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveRelationship}>Salvar</Button>,
        ]}
      >
        <div onKeyDownCapture={(event) => handleEditorFormShortcut(event, saveRelationship)}>
        {draft ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <DiagramDocumentationLink section="joins" />
          </div>
        ) : null}
        {draft ? (
          <Form layout="vertical">
            {draft.customCondition ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message="Esta junção possui uma condição SQL personalizada"
                description="Ao salvar, a condição atual será substituída pela igualdade entre as colunas selecionadas."
              />
            ) : null}
            {draft.declaredInCube && draft.requestedFromCube && draft.declaredInCube !== draft.requestedFromCube ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message={`Esta junção está declarada em ${draft.declaredInCube}`}
                description={`Você pode editá-la a partir de ${draft.requestedFromCube}; o arquivo continuará sendo salvo no cubo que declara a junção.`}
              />
            ) : null}
            {draft.relationship === 'one_to_many' ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="Relação 1:N salva no lado muitos"
                description={`O arquivo será gravado em ${draft.targetCube}, usando many_to_one para representar a mesma relação.`}
              />
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr', gap: 12, alignItems: 'end' }}>
              <Form.Item label={`Origem — ${source?.title || source?.name}`} style={{ marginBottom: 12 }}>
                <Select
                  showSearch
                  value={draft.sourceColumn}
                  placeholder="Selecione a coluna"
                  onChange={(sourceColumn) => setDraft({ ...draft, sourceColumn })}
                  optionFilterProp="children"
                >
                  {source?.columns.map(column => (
                    <Select.Option key={column.name} value={column.name}>
                      {column.name}{column.type ? ` (${column.type})` : ''}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <div style={{ paddingBottom: 22, textAlign: 'center', color: '#6f63d9', fontWeight: 700 }}>→</div>
              <Form.Item label={`Destino — ${target?.title || target?.name}`} style={{ marginBottom: 12 }}>
                <Select
                  showSearch
                  value={draft.targetColumn}
                  placeholder="Selecione a coluna"
                  onChange={(targetColumn) => setDraft({ ...draft, targetColumn })}
                  optionFilterProp="children"
                >
                  {target?.columns.map(column => (
                    <Select.Option key={column.name} value={column.name}>
                      {column.name}{column.type ? ` (${column.type})` : ''}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </div>

            <Form.Item label="Tipo de relacionamento" style={{ marginBottom: 8 }}>
              <Select
                value={draft.relationship}
                onChange={(relationship: RelationshipType) => setDraft({ ...draft, relationship })}
              >
                {(Object.keys(RELATIONSHIP_LABELS) as RelationshipType[]).map(value => (
                  <Select.Option key={value} value={value}>{RELATIONSHIP_LABELS[value]}</Select.Option>
                ))}
              </Select>
            </Form.Item>
            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              Exemplo: <strong>{RELATIONSHIP_HELPERS[draft.relationship](
                source?.title || source?.name || 'origem',
                target?.title || target?.name || 'destino'
              )}</strong>
            </Text>
            <Text type="secondary">
              Relações 1:N são gravadas preferencialmente no lado muitos. As demais ficam no cubo que aparece como origem.
            </Text>
          </Form>
        ) : null}
        </div>
      </Modal>
    </>
  );
}
