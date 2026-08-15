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
  Popconfirm,
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
  ReloadOutlined,
  RulerCombinedIcon,
  SearchOutlined,
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
  useEdgesState,
  useNodesState,
  useUpdateNodeInternals,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import styled, { createGlobalStyle } from 'styled-components';

import { playgroundFetch, responseErrorMessage } from '../../shared/helpers';
import { CubeSampleDataModal } from './CubeSampleDataModal';
import { expressionReferencesColumn, inferDimensionType, TablesSchema } from './cubeSchemaUtils';
import {
  CubeForm,
  DimensionForm,
  HierarchyForm,
  MeasureForm,
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
  name: string;
  title?: string;
  sql?: string;
  type?: string;
  latitude?: { sql?: string };
  longitude?: { sql?: string };
  primaryKey?: boolean;
};

type DiagramMeasure = {
  name: string;
  title?: string;
  sql?: string;
  type?: string;
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
  columns: DiagramColumn[];
  columnError?: string;
};

type DiagramRelationship = {
  sourceCube: string;
  targetCube: string;
  sourceColumn?: string;
  targetColumn?: string;
  relationship: RelationshipType;
  sql: string;
};

type DiagramResponse = {
  cubes: DiagramCube[];
  relationships: DiagramRelationship[];
};

type PendingDiagramChange = {
  endpoint: string;
  body: Record<string, any>;
};

type DiagramState = {
  version?: number;
  cubes?: Record<string, {
    name?: string;
    source?: string;
    position?: { x: number; y: number };
  }>;
};

type RelationshipType = 'one_to_one' | 'one_to_many' | 'many_to_one';

type RelationshipDraft = {
  sourceCube: string;
  targetCube: string;
  sourceColumn?: string;
  targetColumn?: string;
  relationship: RelationshipType;
  operation: 'create' | 'update';
  customCondition?: boolean;
};

type DimensionDraft = {
  cubeName: string;
  dimensionName?: string;
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

type SchemaItemDraft = {
  cubeName: string;
  section: SchemaItemSection;
  itemName?: string;
  values: Record<string, any>;
};

type CubePropertiesDraft = {
  cubeName: string;
  sourceMode: 'sql_table' | 'sql';
  values: Record<string, any>;
};

type Props = {
  visible: boolean;
  projectId?: string;
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

function dimensionForColumn(cube: DiagramCube, column: DiagramColumn): DiagramDimension | undefined {
  const matches = cube.dimensions?.filter(dimension => memberReferencesColumn(dimension, column.name)) || [];
  return matches.length === 1 ? matches[0] : undefined;
}

function measureForColumn(cube: DiagramCube, column: DiagramColumn): DiagramMeasure | undefined {
  const matches = cube.measures?.filter(measure => memberReferencesColumn(measure, column.name)) || [];
  return matches.length === 1 ? matches[0] : undefined;
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
): DiagramResponse {
  return updateDiagramCube(diagram, cubeName, cube => {
    if (section === 'dimensions') {
      const members = [...(cube.dimensions || [])];
      const index = itemName ? members.findIndex(member => member.name === itemName) : -1;
      if (operation === 'delete') return { ...cube, dimensions: members.filter(member => member.name !== itemName) };
      const member: DiagramDimension = {
        name: String(values.name || itemName || ''),
        ...(index >= 0 ? members[index] : {}),
        ...values,
        ...(values.primary_key !== undefined ? { primaryKey: Boolean(values.primary_key) } : {}),
      };
      delete (member as any).primary_key;
      if (index >= 0) members[index] = member;
      else members.push(member);
      return { ...cube, dimensions: members };
    }

    const members = [...(cube.measures || [])];
    const index = itemName ? members.findIndex(member => member.name === itemName) : -1;
    if (operation === 'delete') return { ...cube, measures: members.filter(member => member.name !== itemName) };
    const member: DiagramMeasure = {
      name: String(values.name || itemName || ''),
      ...(index >= 0 ? members[index] : {}),
      ...values,
    };
    if (index >= 0) members[index] = member;
    else members.push(member);
    return { ...cube, measures: members };
  });
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

const Canvas = styled.div`
  height: calc(100vh - 184px);
  min-height: 260px;
  border-top: 1px solid #e8e8f0;
  background: #f7f8fc;

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
  padding: 11px 14px 10px;
  color: #fff;
  background: #4b4677;
`;

const ColumnRow = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 6px 17px;
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

const ColumnActionButton = styled(Button)`
  display: none !important;
`;

const COLUMN_ROW_HEIGHT = 34;
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

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  padding: 10px 14px;
  background: #fff;
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

const RelationshipDiagramOverlayStyles = createGlobalStyle`
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

function handleId(kind: 'source' | 'target', column?: string): string {
  return `${kind}:${column || '__cube'}`;
}

function handleColumn(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const [, ...parts] = id.split(':');
  const column = parts.join(':');
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
  const error = await responseErrorMessage(response, false);

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
  const selectedCubeName = data.selectedCubeName as string | null;
  const relationshipColumnNames = new Set(
    ((data.relationshipColumnNames || []) as string[]).map(columnName => columnName.toLowerCase())
  );
  const primaryKeySaving = data.primaryKeySaving as string | null;
  const markColumnAsPrimaryKey = data.markColumnAsPrimaryKey as (cubeName: string, column: DiagramColumn) => void;
  const openDimensionEditor = data.openDimensionEditor as (cube: DiagramCube, column: DiagramColumn, dimension?: DiagramDimension) => void;
  const openSchemaItemEditor = data.openSchemaItemEditor as (action: string, cube: DiagramCube, column?: DiagramColumn, item?: any) => void;
  const openCubePropertiesEditor = data.openCubePropertiesEditor as (cube: DiagramCube) => void;
  const cubeActionMenuKey = data.cubeActionMenuKey as string | null;
  const setCubeActionMenuKey = data.setCubeActionMenuKey as (key: string | null) => void;
  const columnMenuKey = data.columnMenuKey as string | null;
  const setColumnMenuKey = data.setColumnMenuKey as (key: string | null) => void;
  const updateNodeInternals = useUpdateNodeInternals();
  const canConnectColumns = !cube.columnError && cube.columns.length > 0;
  const orderedColumns = [...cube.columns].sort((left, right) => {
    const leftIsPrimaryKey = left.primaryKey || Boolean(dimensionForColumn(cube, left)?.primaryKey);
    const rightIsPrimaryKey = right.primaryKey || Boolean(dimensionForColumn(cube, right)?.primaryKey);
    return Number(!leftIsPrimaryKey) - Number(!rightIsPrimaryKey);
  });
  const columnListRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const previousColumnCountRef = useRef(cube.columns.length);
  const columnCount = Math.max(cube.columns.length, 1);
  const columnListContentHeight = columnCount * COLUMN_ROW_HEIGHT;
  const columnListMaxHeight = columnListContentHeight + COLUMN_RESIZE_HANDLE_HEIGHT;
  const columnListDefaultHeight = Math.min(columnCount, 10) * COLUMN_ROW_HEIGHT
    + COLUMN_RESIZE_HANDLE_HEIGHT;
  const [columnListHeight, setColumnListHeight] = useState(columnListDefaultHeight);

  useEffect(() => {
    if (previousColumnCountRef.current === cube.columns.length) return;

    previousColumnCountRef.current = cube.columns.length;
    setColumnListHeight(columnListDefaultHeight);
  }, [cube.columns.length, columnListDefaultHeight]);

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

  useEffect(() => {
    const columnList = columnListRef.current;
    if (!columnList || typeof ResizeObserver === 'undefined') return undefined;

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => updateNodeInternals(id));
    });
    resizeObserver.observe(columnList);

    return () => resizeObserver.disconnect();
  }, [id, updateNodeInternals, columnListHeight]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  return (
    <CubeCard
      data-testid={`relationship-cube-${cube.name}`}
      style={selectedCubeName === cube.name ? { boxShadow: '0 0 0 2px #7568d8, 0 5px 18px rgba(55, 48, 107, 0.18)' } : undefined}
    >
      <CubeHeader>
        <Handle
          id={handleId('target')}
          type="target"
          position={Position.Left}
          isConnectable={false}
          style={{ width: 8, height: 8, background: '#b7b4cd' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
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
                  else openSchemaItemEditor(key, cube);
                }}>
                  <Menu.Item key="properties">Editar propriedades</Menu.Item>
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
              shape="circle"
              icon={<MoreOutlined />}
              aria-label={`Ações do cubo ${cube.name}`}
              onMouseDown={(event) => event.stopPropagation()}
              style={{
                width: 30,
                height: 30,
                color: '#fff',
                background: 'rgba(255, 255, 255, 0.2)',
                border: '1px solid rgba(255, 255, 255, 0.45)',
                fontSize: 18,
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
        <div style={{ marginTop: 5, opacity: 0.78, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {cube.sourceType === 'sql_table' ? cube.source : 'Consulta SQL'}
        </div>
        <Handle
          id={handleId('source')}
          type="source"
          position={Position.Right}
          isConnectable={false}
          style={{ width: 8, height: 8, background: '#b7b4cd' }}
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
        ) : cube.columns.length === 0 ? (
          <div style={{ padding: 12, color: '#8c8c8c', fontSize: 12 }}>Nenhuma coluna encontrada</div>
        ) : (
          orderedColumns.map((column) => {
            const dimension = dimensionForColumn(cube, column);
            const measure = measureForColumn(cube, column);
            const isPrimaryKey = column.primaryKey || Boolean(dimension?.primaryKey);
            const isKeyUsed = isPrimaryKey
              || columnIsUsedInPrimaryKey(cube, column)
              || relationshipColumnNames.has(column.name.toLowerCase());
            const Row = isPrimaryKey ? PrimaryKeyColumnRow : ColumnRow;
            const displayName = dimension?.title || dimension?.name || measure?.title || measure?.name || column.name;
            const displayType = dimension?.type || measure?.type || column.type;
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
                  id={handleId('target', column.name)}
                  type="target"
                  position={Position.Left}
                  isConnectable={canConnectColumns}
                  style={{ left: 5, width: 9, height: 9, background: '#8f86e8' }}
                />
                <Space size={6} style={{ minWidth: 0, flex: 1 }}>
                  {isKeyUsed ? (
                    <Tooltip title="Chave primária">
                      <PrimaryKeyFontAwesomeIcon style={{ color: '#ad6800', fontSize: 13 }} />
                    </Tooltip>
                  ) : null}
                  {dimension ? (
                    <Tooltip title={`Dimensão: ${dimension.title || dimension.name}`}>
                      <CubeIcon style={{ color: '#7568d8', fontSize: 13 }} />
                    </Tooltip>
                  ) : null}
                  {measure ? (
                    <Tooltip title={`Medida: ${measure.title || measure.name}`}>
                      <RulerCombinedIcon style={{ color: '#389e0d', fontSize: 13 }} />
                    </Tooltip>
                  ) : null}
                  <Text ellipsis style={{ maxWidth: 190, fontSize: 12 }}>{displayName}</Text>
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
                  id={handleId('source', column.name)}
                  type="source"
                  position={Position.Right}
                  isConnectable={canConnectColumns}
                  style={{ right: 5, width: 9, height: 9, background: '#8f86e8' }}
                />
              </Row>
              </Dropdown>
            );
          })
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
  const direct = storedPositions[cube.fileName] || storedPositions[cube.name];
  if (direct) return direct;

  const stateEntry = Object.values(storedState?.cubes || {}).find(item => (
    item.name === cube.name || (item.source && item.source === cube.source)
  ));
  return stateEntry?.position;
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
      ...row.map(cube => 125 + Math.min(Math.max(cube.columns.length, 1) * 34, 340)),
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

function relationshipEdges(relationships: DiagramRelationship[], cubes: DiagramCube[]): Edge[] {
  const cubesByName = new Map(cubes.map(cube => [cube.name, cube]));

  return relationships
    .filter(join => cubesByName.has(join.sourceCube) && cubesByName.has(join.targetCube))
    .map((join) => {
      const source = cubesByName.get(join.sourceCube)!;
      const target = cubesByName.get(join.targetCube)!;
      const sourceColumn = source.columns.some(column => column.name === join.sourceColumn)
        ? join.sourceColumn
        : undefined;
      const targetColumn = target.columns.some(column => column.name === join.targetColumn)
        ? join.targetColumn
        : undefined;

      return {
        id: `${join.sourceCube}->${join.targetCube}`,
        source: join.sourceCube,
        target: join.targetCube,
        sourceHandle: handleId('source', sourceColumn),
        targetHandle: handleId('target', targetColumn),
        type: 'relationship',
        data: { relationship: join },
        style: { stroke: '#6f63d9', strokeWidth: 2 },
      };
    });
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

export function CubeRelationshipDiagram({ visible, projectId, tablesSchema, onClose, onChanged }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [primaryKeySaving, setPrimaryKeySaving] = useState<string | null>(null);
  const [columnMenuKey, setColumnMenuKey] = useState<string | null>(null);
  const [cubeActionMenuKey, setCubeActionMenuKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diagram, setDiagram] = useState<DiagramResponse>({ cubes: [], relationships: [] });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [draft, setDraft] = useState<RelationshipDraft | null>(null);
  const [dimensionDraft, setDimensionDraft] = useState<DimensionDraft | null>(null);
  const [schemaItemDraft, setSchemaItemDraft] = useState<SchemaItemDraft | null>(null);
  const [cubePropertiesDraft, setCubePropertiesDraft] = useState<CubePropertiesDraft | null>(null);
  const [search, setSearch] = useState('');
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<any, any> | null>(null);
  const [selectedCubeName, setSelectedCubeName] = useState<string | null>(null);
  const [sampleCube, setSampleCube] = useState<DiagramCube | null>(null);
  const [pendingChanges, setPendingChanges] = useState<PendingDiagramChange[]>([]);
  const nodesRef = useRef<Node[]>([]);

  const positionsKey = `cube-relationship-diagram:${projectId || window.location.pathname}`;

  const readStoredPositions = useCallback(() => {
    try {
      return JSON.parse(window.localStorage.getItem(positionsKey) || '{}');
    } catch (_e) {
      return {};
    }
  }, [positionsKey]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    setEdges(relationshipEdges(diagram.relationships, diagram.cubes));
    setNodes(previous => previous.map(node => {
      const cube = diagram.cubes.find(item => item.name === node.id);
      return cube ? { ...node, data: { ...node.data, cube } } : node;
    }));
  }, [diagram, setEdges, setNodes]);

  const stageChange = useCallback((change: PendingDiagramChange) => {
    setPendingChanges(previous => [...previous, change]);
  }, []);

  const persistDiagramState = useCallback(async (
    nextNodes?: Node[],
  ) => {
    const currentNodes = nextNodes || nodesRef.current;
    const positionEntries: Array<[string, { name: string; source?: string; position: { x: number; y: number } }]> = [];
    diagram.cubes.forEach(cube => {
      const node = currentNodes.find(item => item.id === cube.name);
      if (node) {
        positionEntries.push([
          cube.fileName,
          { name: cube.name, source: cube.source, position: { x: node.position.x, y: node.position.y } },
        ]);
      }
    });
    const positions: Record<string, { name: string; source?: string; position: { x: number; y: number } }> = Object.fromEntries(positionEntries);
    const state: DiagramState = {
      version: 1,
      cubes: positions,
    };

    try {
      window.localStorage.setItem(
        positionsKey,
        JSON.stringify(Object.fromEntries(Object.entries(positions).map(([key, value]) => [
          value.name || key,
          value.position,
        ]))),
      );
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
  }, [diagram.cubes, positionsKey]);

  const loadDiagram = useCallback(async () => {
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
      const storedState = stateResponse?.ok ? await stateResponse.json() as DiagramState : undefined;
      const legacyPositions = readStoredPositions();
      const storedPositions = Object.fromEntries(
        Object.entries(storedState?.cubes || {}).map(([key, item]) => [key, item.position])
      ) as Record<string, { x: number; y: number }>;
      setDiagram(result);
      setNodes(layoutNodes(result.cubes, { ...legacyPositions, ...storedPositions }, storedState));
      setEdges(relationshipEdges(result.relationships, result.cubes));
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [readStoredPositions, setEdges, setNodes]);

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
          name: column.name,
          sql: column.name,
          type: inferDimensionType(column.type),
          primaryKey: true,
        });
      }
      return {
        ...cube,
        hasPrimaryKey: true,
        dimensions,
        columns: cube.columns.map(item => item.name === column.name ? { ...item, primaryKey: true } : item),
      };
    }));
    message.info(`'${column.name}' foi marcada como chave primária. Clique em Salvar para validar.`);
    setPrimaryKeySaving(null);
  }, [stageChange]);

  useEffect(() => {
    if (visible) {
      setPendingChanges([]);
      void loadDiagram();
    }
  }, [visible, loadDiagram]);

  const openDimensionEditor = useCallback((cube: DiagramCube, column?: DiagramColumn, dimension?: DiagramDimension, forcePrimaryKey = false) => {
    setColumnMenuKey(null);
    setCubeActionMenuKey(null);
    setDimensionDraft({
      cubeName: cube.name,
      dimensionName: dimension?.name,
      name: dimension?.name || column?.name || 'new_dimension',
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

  const visibleNodes = useMemo(() => {
    const filter = search.trim().toLocaleLowerCase();
    return nodes.map(node => {
      const cube = node.data.cube as DiagramCube;
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
          primaryKeySaving,
          markColumnAsPrimaryKey,
          openDimensionEditor,
          openSchemaItemEditor,
          openCubePropertiesEditor,
          cubeActionMenuKey,
          setCubeActionMenuKey,
          columnMenuKey,
          setColumnMenuKey,
          relationshipColumnNames,
          selectedCubeName,
        },
        hidden: filter ? !matches : false,
      };
    });
  }, [columnMenuKey, cubeActionMenuKey, diagram.relationships, markColumnAsPrimaryKey, nodes, openCubePropertiesEditor, openDimensionEditor, openSchemaItemEditor, primaryKeySaving, search, selectedCubeName]);

  useEffect(() => {
    if (!flowInstance || !visible) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const filter = search.trim().toLocaleLowerCase();
      const matching = flowInstance.getNodes().filter((node) => {
        const cube = node.data.cube as DiagramCube;
        return cube.name.toLocaleLowerCase().includes(filter)
          || cube.title?.toLocaleLowerCase().includes(filter)
          || cube.columns.some(column => column.name.toLocaleLowerCase().includes(filter));
      });
      if (matching.length > 0) {
        void flowInstance.fitView({
          nodes: search.trim() ? matching : undefined,
          padding: search.trim() ? 0.28 : 0.18,
          maxZoom: search.trim() ? 1.1 : 1,
          duration: 220,
        });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [diagram, flowInstance, search, visible]);

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

    const change = {
      ...draft,
      replaceCustom: Boolean(draft.customCondition),
    };
    stageChange({ endpoint: 'playground/schema/relationship', body: change });
    setDiagram(previous => {
      const relationship: DiagramRelationship = {
        sourceCube: draft.sourceCube,
        targetCube: draft.targetCube,
        sourceColumn: draft.sourceColumn,
        targetColumn: draft.targetColumn,
        relationship: draft.relationship,
        sql: `{${draft.sourceCube}}.${draft.sourceColumn} = {${draft.targetCube}}.${draft.targetColumn}`,
      };
      const relationships = previous.relationships.filter(item => !(
        item.sourceCube === draft.sourceCube && item.targetCube === draft.targetCube
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
    setDiagram(previous => ({
      ...previous,
      relationships: previous.relationships.filter(item => !(
        item.sourceCube === draft.sourceCube && item.targetCube === draft.targetCube
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
        values,
      },
    });
    setDiagram(previous => updateDiagramCubeMembers(
      previous,
      dimensionDraft.cubeName,
      'dimensions',
      dimensionDraft.dimensionName,
      { ...values, primaryKey: dimensionDraft.primaryKey },
    ));
    message.info(`${dimensionDraft.dimensionName ? 'Dimensão atualizada' : 'Dimensão criada'} localmente. Clique em Salvar para validar.`);
    setDimensionDraft(null);
  }, [dimensionDraft, stageChange]);

  const deleteDimension = useCallback(() => {
    if (!dimensionDraft?.dimensionName) return;

    stageChange({
      endpoint: 'playground/schema/item',
      body: {
        cubeName: dimensionDraft.cubeName,
        section: 'dimensions',
        itemName: dimensionDraft.dimensionName,
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

  const savePendingChanges = useCallback(async () => {
    if (saving) return;
    if (!pendingChanges.length) {
      await persistDiagramState();
      onClose();
      return;
    }

    setSaving(true);
    let appliedChanges = 0;
    try {
      for (const change of pendingChanges) {
        const response = await playgroundFetch(change.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(change.body),
        });
        if (!response.ok) {
          throw new Error(await relationshipResponseError(response));
        }
        appliedChanges += 1;
      }

      setPendingChanges([]);
      await loadDiagram();
      await persistDiagramState();
      try {
        await onChanged();
      } catch (_e) {
        message.warning('As alterações foram salvas, mas a lista de arquivos não pôde ser atualizada.');
      }
      message.success('Alterações salvas e validadas');
      onClose();
    } catch (e: any) {
      setPendingChanges(previous => previous.slice(appliedChanges));
      message.error(e?.message || 'Não foi possível salvar as alterações');
    } finally {
      setSaving(false);
    }
  }, [loadDiagram, onChanged, onClose, pendingChanges, persistDiagramState, saving]);

  const handleCancel = useCallback(() => {
    setPendingChanges([]);
    setDraft(null);
    setDimensionDraft(null);
    setSchemaItemDraft(null);
    setCubePropertiesDraft(null);
    setSampleCube(null);
    onClose();
  }, [onClose]);

  function handleDiagramShortcut(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      handleCancel();
      return;
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void savePendingChanges();
    }
  }

  useEffect(() => {
    if (!visible) return undefined;

    const handleModalShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;

      if (event.key === 'Enter' && event.ctrlKey && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        handleCancel();
        return;
      }

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        void savePendingChanges();
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
      <RelationshipDiagramOverlayStyles />
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
                <DiagramModalShortcutHint>Ctrl + Shift + Enter</DiagramModalShortcutHint>
              </DiagramModalAction>
              <DiagramModalAction>
                <Button type="primary" onClick={savePendingChanges} loading={saving}>Salvar</Button>
                <DiagramModalShortcutHint>Ctrl + Enter</DiagramModalShortcutHint>
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
        bodyStyle={{ height: 'calc(100vh - 110px)', padding: 0, overflow: 'hidden' }}
        destroyOnClose
        footer={null}
      >
        <div onKeyDownCapture={handleDiagramShortcut}>
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
              Arraste entre colunas para criar. Clique em uma ligação para editar ou remover. 1 = um, N = muitos.
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
          <Canvas>
            <ReactFlow
              nodes={visibleNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
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
          )}
        </div>
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
        onCancel={() => setSchemaItemDraft(null)}
        maskClosable={false}
        destroyOnClose
        width={780}
        footer={[
          <Button key="cancel" onClick={() => setSchemaItemDraft(null)} disabled={saving}>Cancelar</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveSchemaItem}>Salvar</Button>,
        ]}
      >
        {schemaItemDraft ? renderSchemaItemFields() : null}
      </Modal>

      <Modal
        title="Editar propriedades"
        visible={Boolean(cubePropertiesDraft)}
        onCancel={() => setCubePropertiesDraft(null)}
        maskClosable={false}
        destroyOnClose
        width={780}
        footer={[
          <Button key="cancel" onClick={() => setCubePropertiesDraft(null)} disabled={saving}>Cancelar</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveCubeProperties}>Salvar</Button>,
        ]}
      >
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
      </Modal>

      <Modal
        title={dimensionDraft?.dimensionName ? 'Editar dimensão' : 'Criar dimensão'}
        visible={Boolean(dimensionDraft)}
        onCancel={() => setDimensionDraft(null)}
        maskClosable={false}
        destroyOnClose
        width={780}
        footer={[
          dimensionDraft?.dimensionName ? (
            <Popconfirm
              key="delete"
              title="Remover esta dimensão?"
              overlayClassName="cube-remove-popconfirm"
              onConfirm={deleteDimension}
              okText="Remover"
              cancelText="Cancelar"
            >
              <Button danger loading={saving} style={{ float: 'left' }}>Remover</Button>
            </Popconfirm>
          ) : null,
          <Button key="cancel" onClick={() => setDimensionDraft(null)} disabled={saving}>Cancelar</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveDimension}>Salvar</Button>,
        ]}
      >
        {dimensionDraft ? (
          <DimensionForm
            values={{ ...dimensionDraft, primary_key: dimensionDraft.primaryKey }}
            columns={diagram.cubes.find(cube => cube.name === dimensionDraft.cubeName)?.columns}
            tablesSchema={tablesSchema}
            onChange={updateDimensionValue}
          />
        ) : null}
      </Modal>

      <Modal
        title={draft?.operation === 'create' ? 'Criar relacionamento' : 'Editar relacionamento'}
        visible={Boolean(draft)}
        onCancel={() => setDraft(null)}
        width={620}
        destroyOnClose
        footer={[
          draft?.operation === 'update' ? (
            <Popconfirm
              key="delete"
              title="Remover este relacionamento?"
              overlayClassName="cube-remove-popconfirm"
              onConfirm={deleteRelationship}
              okText="Remover"
              cancelText="Cancelar"
            >
              <Button danger loading={saving} style={{ float: 'left' }}>Remover</Button>
            </Popconfirm>
          ) : null,
          <Button key="cancel" onClick={() => setDraft(null)} disabled={saving}>Cancelar</Button>,
          <Button key="save" type="primary" loading={saving} onClick={saveRelationship}>Salvar</Button>,
        ]}
      >
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
              O relacionamento será salvo somente em <strong>{source?.fileName}</strong>, pois o arraste começou no cubo de origem.
            </Text>
          </Form>
        ) : null}
      </Modal>
    </>
  );
}
