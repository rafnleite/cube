import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  MoreOutlined,
  PrimaryKeyFontAwesomeIcon,
  ReloadOutlined,
} from '../../shared/icons/FontAwesomeIcons';
import {
  Background,
  Connection,
  Controls,
  Edge,
  Handle,
  MarkerType,
  MiniMap,
  Node,
  Position,
  ReactFlow,
  ReactFlowInstance,
  useEdgesState,
  useNodesState,
  useUpdateNodeInternals,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import styled from 'styled-components';

import { playgroundFetch } from '../../shared/helpers';

const { Text } = Typography;

type DiagramColumn = {
  name: string;
  type?: string;
  primaryKey?: boolean;
};

type DiagramCube = {
  name: string;
  title?: string;
  fileName: string;
  fileType: 'yaml' | 'javascript';
  dataSource: string;
  sourceType: 'sql_table' | 'sql' | 'unknown';
  source?: string;
  hasPrimaryKey: boolean;
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

type Props = {
  visible: boolean;
  projectId?: string;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
};

const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  many_to_one: 'Muitos para um',
  one_to_many: 'Um para muitos',
  one_to_one: 'Um para um',
};

const RELATIONSHIP_EDGE_LABELS: Record<RelationshipType, string> = {
  many_to_one: 'N : 1',
  one_to_many: '1 : N',
  one_to_one: '1 : 1',
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

const ColumnList = styled.div`
  max-height: 340px;
  overflow-y: auto;
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

function handleId(kind: 'source' | 'target', column?: string): string {
  return `${kind}:${column || '__cube'}`;
}

function handleColumn(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const [, ...parts] = id.split(':');
  const column = parts.join(':');
  return column && column !== '__cube' ? column : undefined;
}

async function relationshipResponseError(response: Response): Promise<string> {
  const text = await response.text();
  let error = text;
  try {
    error = JSON.parse(text)?.error || text;
  } catch (_e) {
    // Keep the plain response body.
  }

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
  const primaryKeySaving = data.primaryKeySaving as string | null;
  const markColumnAsPrimaryKey = data.markColumnAsPrimaryKey as (cubeName: string, column: DiagramColumn) => Promise<void>;
  const columnMenuKey = data.columnMenuKey as string | null;
  const setColumnMenuKey = data.setColumnMenuKey as (key: string | null) => void;
  const updateNodeInternals = useUpdateNodeInternals();
  const canConnectColumns = !cube.columnError && cube.columns.length > 0;

  return (
    <CubeCard data-testid={`relationship-cube-${cube.name}`}>
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
          <Tag color={cube.fileType === 'yaml' ? 'blue' : 'purple'} style={{ marginRight: 0 }}>
            {cube.fileType === 'yaml' ? 'YAML' : 'JS'}
          </Tag>
        </div>
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
        className="nodrag nowheel"
        onScroll={() => updateNodeInternals(id)}
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
          cube.columns.map((column) => {
            const Row = column.primaryKey ? PrimaryKeyColumnRow : ColumnRow;
            const primaryKeyMenu = (
              <Menu>
                <Menu.Item
                  key="primary-key"
                  disabled={column.primaryKey || Boolean(primaryKeySaving)}
                  onClick={() => void markColumnAsPrimaryKey(cube.name, column)}
                >
                  {column.primaryKey ? 'Já é chave primária' : 'Transformar em chave primária'}
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
                  {column.primaryKey ? (
                    <Tooltip title="Chave primária">
                      <PrimaryKeyFontAwesomeIcon style={{ color: '#ad6800', fontSize: 13 }} />
                    </Tooltip>
                  ) : null}
                  <Text ellipsis style={{ maxWidth: 190, fontSize: 12 }}>{column.name}</Text>
                </Space>
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 10 }}>{column.type || ''}</Text>
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
      </ColumnList>
    </CubeCard>
  );
}

const nodeTypes = { cube: CubeDiagramNode };

function layoutNodes(cubes: DiagramCube[], storedPositions: Record<string, { x: number; y: number }>): Node[] {
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
        position: storedPositions[cube.name] || { x: 40 + index * 380, y },
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
        label: RELATIONSHIP_EDGE_LABELS[join.relationship] || join.relationship,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6f63d9' },
        data: { relationship: join },
        style: { stroke: '#6f63d9', strokeWidth: 2 },
        labelStyle: { fill: '#4b4677', fontWeight: 700, fontSize: 11 },
        labelBgStyle: { fill: '#fff', fillOpacity: 0.92 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 4,
      };
    });
}

export function CubeRelationshipDiagram({ visible, projectId, onClose, onChanged }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [primaryKeySaving, setPrimaryKeySaving] = useState<string | null>(null);
  const [columnMenuKey, setColumnMenuKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diagram, setDiagram] = useState<DiagramResponse>({ cubes: [], relationships: [] });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [draft, setDraft] = useState<RelationshipDraft | null>(null);
  const [search, setSearch] = useState('');
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);

  const positionsKey = `cube-relationship-diagram:${projectId || window.location.pathname}`;

  const readStoredPositions = useCallback(() => {
    try {
      return JSON.parse(window.localStorage.getItem(positionsKey) || '{}');
    } catch (_e) {
      return {};
    }
  }, [positionsKey]);

  const loadDiagram = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await playgroundFetch('playground/schema/relationships');
      if (!response.ok) {
        throw new Error(await relationshipResponseError(response));
      }
      const result = await response.json() as DiagramResponse;
      setDiagram(result);
      setNodes(layoutNodes(result.cubes, readStoredPositions()));
      setEdges(relationshipEdges(result.relationships, result.cubes));
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [readStoredPositions, setEdges, setNodes]);

  const markColumnAsPrimaryKey = useCallback(async (cubeName: string, column: DiagramColumn) => {
    const savingKey = `${cubeName}:${column.name}`;
    const statusMessageKey = `primary-key:${savingKey}`;
    setColumnMenuKey(null);
    setPrimaryKeySaving(savingKey);
    message.loading({
      key: statusMessageKey,
      content: `Processando a chave primária de '${column.name}'...`,
      duration: 0,
    });
    try {
      const response = await playgroundFetch('playground/schema/primary-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cubeName, columnName: column.name }),
      });
      if (!response.ok) {
        throw new Error(await relationshipResponseError(response));
      }
      message.success(`'${column.name}' marcada como chave primária`);
      message.destroy(statusMessageKey);
      await loadDiagram();
      await onChanged();
    } catch (e: any) {
      message.error(e?.message || 'Não foi possível marcar a coluna como chave primária');
    } finally {
      message.destroy(statusMessageKey);
      setPrimaryKeySaving(null);
    }
  }, [loadDiagram, onChanged]);

  useEffect(() => {
    if (visible) {
      void loadDiagram();
    }
  }, [visible, loadDiagram]);

  const visibleNodes = useMemo(() => {
    const filter = search.trim().toLocaleLowerCase();
    return nodes.map(node => {
      const cube = node.data.cube as DiagramCube;
      const matches = cube.name.toLocaleLowerCase().includes(filter)
        || cube.title?.toLocaleLowerCase().includes(filter)
        || cube.columns.some(column => column.name.toLocaleLowerCase().includes(filter));
      return {
        ...node,
        data: { ...node.data, primaryKeySaving, markColumnAsPrimaryKey, columnMenuKey, setColumnMenuKey },
        hidden: filter ? !matches : false,
      };
    });
  }, [columnMenuKey, markColumnAsPrimaryKey, nodes, primaryKeySaving, search]);

  useEffect(() => {
    if (!flowInstance || !visible) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const filter = search.trim().toLocaleLowerCase();
      const matching = flowInstance.getNodes().filter((node) => {
        if (!filter) return true;
        const cube = node.data.cube as DiagramCube;
        return cube.name.toLocaleLowerCase().includes(filter)
          || cube.title?.toLocaleLowerCase().includes(filter)
          || cube.columns.some(column => column.name.toLocaleLowerCase().includes(filter));
      });
      if (matching.length > 0) {
        void flowInstance.fitView({ nodes: matching, padding: 0.28, maxZoom: 1.1, duration: 220 });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [flowInstance, search, visible]);

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

  const markColumnAsPrimaryKeyLegacy = useCallback(async (cubeName: string, column: DiagramColumn) => {
    const savingKey = `${cubeName}:${column.name}`;
    setPrimaryKeySaving(savingKey);
    try {
      const response = await playgroundFetch('playground/schema/primary-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cubeName, columnName: column.name }),
      });
      if (!response.ok) {
        throw new Error(await relationshipResponseError(response));
      }
      message.success(`'${column.name}' marcada como chave primária`);
      await loadDiagram();
      await onChanged();
    } catch (e: any) {
      message.error(e?.message || 'Não foi possível marcar a coluna como chave primária');
    } finally {
      setPrimaryKeySaving(null);
    }
  }, [loadDiagram, onChanged]);

  const saveRelationship = useCallback(async () => {
    if (!draft?.sourceColumn || !draft.targetColumn) {
      message.error('Selecione uma coluna em cada cubo.');
      return;
    }

    setSaving(true);
    try {
      const response = await playgroundFetch('playground/schema/relationship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          replaceCustom: Boolean(draft.customCondition),
        }),
      });
      if (response.status !== 200) {
        throw new Error(await relationshipResponseError(response));
      }
    } catch (e: any) {
      message.error(e?.message || 'Não foi possível salvar o relacionamento');
      setSaving(false);
      return;
    }

    message.success(draft.operation === 'create' ? 'Relacionamento criado' : 'Relacionamento atualizado');
    setDraft(null);
    setSaving(false);
    await loadDiagram();
    try {
      await onChanged();
    } catch (_e) {
      message.warning('A junção foi salva, mas a lista de arquivos não pôde ser atualizada.');
    }
  }, [draft, loadDiagram, onChanged]);

  const deleteRelationship = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await playgroundFetch('playground/schema/relationship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceCube: draft.sourceCube,
          targetCube: draft.targetCube,
          operation: 'delete',
        }),
      });
      if (response.status !== 200) {
        throw new Error(await relationshipResponseError(response));
      }
    } catch (e: any) {
      message.error(e?.message || 'Não foi possível remover o relacionamento');
      setSaving(false);
      return;
    }

    message.success('Relacionamento removido');
    setDraft(null);
    setSaving(false);
    await loadDiagram();
    try {
      await onChanged();
    } catch (_e) {
      message.warning('A junção foi removida, mas a lista de arquivos não pôde ser atualizada.');
    }
  }, [draft, loadDiagram, onChanged]);

  const source = draft ? diagram.cubes.find(cube => cube.name === draft.sourceCube) : undefined;
  const target = draft ? diagram.cubes.find(cube => cube.name === draft.targetCube) : undefined;

  return (
    <>
      <Modal
        title={(
          <Space>
            <ApartmentOutlined />
            <span>Diagrama de relacionamentos</span>
          </Space>
        )}
        visible={visible}
        onCancel={onClose}
        width="calc(100vw - 32px)"
        style={{ top: 16, paddingBottom: 0 }}
        bodyStyle={{ height: 'calc(100vh - 110px)', padding: 0, overflow: 'hidden' }}
        destroyOnClose
        footer={null}
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
              Arraste entre colunas para criar. Clique em uma ligação para editar ou remover.
            </Text>
          </Space>
          <Button icon={<ReloadOutlined />} onClick={() => loadDiagram()} loading={loading}>
            Atualizar
          </Button>
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
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onInit={setFlowInstance}
              onMoveStart={() => setColumnMenuKey(null)}
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
                const positions = Object.fromEntries(
                  (draggedNodes?.length ? nodes.map(node => (
                    draggedNodes.find(dragged => dragged.id === node.id) || node
                  )) : nodes).map(node => [node.id, node.position])
                );
                try {
                  window.localStorage.setItem(positionsKey, JSON.stringify(positions));
                } catch (_e) {
                  // The diagram still works when browser storage is unavailable.
                }
              }}
              isValidConnection={(connection) => connection.source !== connection.target}
              edgesReconnectable={false}
              fitView
              fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.8}
              defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#d9d8e8" gap={22} />
              <MiniMap pannable zoomable nodeColor="#7a72b8" maskColor="rgba(245, 245, 252, 0.75)" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </Canvas>
        )}
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
