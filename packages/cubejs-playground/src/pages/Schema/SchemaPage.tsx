import React, { Component, useLayoutEffect, useRef, useState } from 'react';
import { Layout, Modal, Empty, Typography, Button, Space, message, notification, Input, Tooltip, Table, Spin } from 'antd';
import { RouterProps } from 'react-router-dom';
import {
  ApartmentOutlined,
  CheckCircleFilled,
  CodeOutlined,
  CopyOutlined,
  EditOutlined,
  SearchOutlined,
  TableListOutlined,
  TrashOutlined,
  LoadingOutlined,
  ReloadOutlined,
  RightOutlined,
  SyncOutlined,
  WarningFilled,
} from '../../shared/icons/FontAwesomeIcons';

import { playgroundAction } from '../../events';
import { Menu, Tabs, Tree } from '../../components';
import { Alert, CubeLoader } from '../../atoms';
import { playgroundFetch, responseErrorMessage } from '../../shared/helpers';
import { AppContext, AppContextConsumer } from '../../components/AppContext';
import { ButtonDropdown } from '../../QueryBuilder/ButtonDropdown';
import { SchemaFormat } from '../../types';
import { SchemaFileEditor } from './SchemaFileEditor';
import { CubeVisualEditor } from './CubeVisualEditor';
import { CubeRelationshipDiagram } from './CubeRelationshipDiagram';
import { CubeSampleDataModal } from './CubeSampleDataModal';
import { ConfirmPopover } from '../../components/ConfirmPopover';
import styled from 'styled-components';
import { load } from 'js-yaml';

const { Content, Sider } = Layout;

const { TreeNode } = Tree;
const { TabPane } = Tabs;

const SCHEMA_EDITOR_DRAFT_KEY = 'cube-schema-editor-draft';

function cubeNameFromFileContent(fileName: string, content?: string): string | null {
  if (!content) return null;
  if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
    try {
      const parsed = load(content) as { cubes?: unknown } | null;
      const cubes = parsed && Array.isArray(parsed.cubes)
        ? parsed.cubes as Array<{ name?: unknown }>
        : [];
      const cube = cubes.find(item => item && typeof item.name === 'string');
      const cubeName = cube?.name;
      if (typeof cubeName === 'string' && cubeName) return cubeName;
    } catch (_error) {
      // Fall back to the simple format below while the YAML is being edited.
    }

    // Keep the fallback restricted to the cubes list indentation. A generic
    // "- name" search can accidentally select a join, such as `seats` in
    // the airplanes cube.
    const match = content.match(/^\s{2}-\s+name:\s*["']?([^\s"'#]+)["']?\s*$/m);
    return match?.[1] || null;
  }
  const match = content.match(/\bcube\s*\(\s*[`'\"]([^`'\"]+)[`'\"]/);
  return match?.[1] || null;
}

const TablesPaneContent = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
`;

const TablesTreeScroll = styled.div`
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;

  .ant-tree {
    width: 100%;
    min-width: 0;
    overflow-x: hidden;
  }

  .ant-tree-list,
  .ant-tree-list-holder,
  .ant-tree-list-holder-inner,
  .ant-tree-treenode,
  .ant-tree-node-content-wrapper,
  .ant-tree-title {
    min-width: 0;
    max-width: 100%;
  }

  .ant-tree-list-holder {
    overflow-x: hidden !important;
  }

  .ant-tree-treenode {
    width: 100%;
  }

  .ant-tree-node-content-wrapper {
    flex: 1;
    overflow: hidden;
  }
`;

const FilesListScroll = styled(TablesTreeScroll)`
  overflow-x: hidden;
  overflow-y: auto;
`;

const SchemaDetails = styled.div`
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 0 24px;
`;

const SchemaDetailsHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
`;

const SchemaDetailsTitle = styled(Typography.Title)`
  margin: 0 !important;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SchemaTableCard = styled.div`
  border: 1px solid #f0f0f0;
  border-radius: 6px;
  margin-bottom: 16px;
  overflow: hidden;
`;

const SchemaTableHeader = styled.button`
  align-items: center;
  background: #fafafa;
  border-bottom: 1px solid #f0f0f0;
  border-left: 0;
  border-right: 0;
  border-top: 0;
  cursor: pointer;
  display: flex;
  font-weight: 600;
  gap: 8px;
  overflow: hidden;
  padding: 10px 12px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;

  &:hover {
    background: #f5f5f5;
  }
`;

const SchemaTableName = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SchemaColumnRow = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(100px, 180px);
  gap: 16px;
  padding: 8px 12px;

  &:not(:last-child) {
    border-bottom: 1px solid #f5f5f5;
  }
`;

const SchemaColumnCell = styled.div`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const TableDetailsToolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
`;

const TableDetailsSectionTitle = styled(Typography.Title)`
  margin: 24px 0 12px !important;
`;

const TableSampleScroll = styled.div`
  min-width: 0;
  overflow-x: auto;
`;

const TableMetadataCard = styled.div`
  border: 1px solid #f0f0f0;
  border-radius: 6px;
  overflow: hidden;
`;

const schemasMap = {};
const TreeItemTitle = styled.span`
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

function TreeItemLabel({ name }: { name: string }) {
  return (
    <Tooltip title={name} placement="topLeft">
      <TreeItemTitle>{name}</TreeItemTitle>
    </Tooltip>
  );
}

function previewValue(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function tableRowValue(row: Record<string, unknown>, columnName: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, columnName)) return row[columnName];
  const normalizedColumnName = columnName.toLocaleLowerCase();
  const entry = Object.entries(row).find(([key]) => key.toLocaleLowerCase() === normalizedColumnName);
  return entry?.[1];
}

function formatRecordCount(value: string): string {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? new Intl.NumberFormat('pt-BR').format(numericValue) : value;
}

function previewColumnWidth(
  columnName: string,
  columnType: string | undefined,
  rows: Record<string, unknown>[],
): number {
  const longestValue = Math.max(
    columnName.length,
    columnType?.length || 0,
    ...rows.map(row => previewValue(tableRowValue(row, columnName)).length),
  );
  return Math.min(420, Math.max(120, longestValue * 8 + 32));
}

const schemaToTreeData = (schemas, search = '') => {
  const normalizedSearch = search.trim().toLocaleLowerCase();

  return Object.keys(schemas).flatMap((schemaName) => {
    const tables = Object.keys(schemas[schemaName]);
    const schemaMatches = !normalizedSearch
      || schemaName.toLocaleLowerCase().includes(normalizedSearch);
    const matchingTables = schemaMatches
      ? tables
      : tables.filter(tableName => tableName.toLocaleLowerCase().includes(normalizedSearch));

    if (!schemaMatches && matchingTables.length === 0) return [];

    return [{
      title: <TreeItemLabel name={schemaName} />,
      key: schemaName,
      treeData: matchingTables.map((tableName) => {
        const key = `${schemaName}.${tableName}`;
        schemasMap[key] = [schemaName, tableName];
        return {
          title: <TreeItemLabel name={tableName} />,
          key,
        };
      }),
    }];
  });
};

function FileNameWithTooltip({ name }: { name: string }) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const updateTruncation = () => {
      const element = nameRef.current;
      setTruncated(Boolean(element && element.scrollWidth > element.clientWidth));
    };

    updateTruncation();
    window.addEventListener('resize', updateTruncation);
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateTruncation)
      : null;
    if (nameRef.current) observer?.observe(nameRef.current);

    return () => {
      window.removeEventListener('resize', updateTruncation);
      observer?.disconnect();
    };
  }, [name]);

  return (
    <Tooltip title={truncated ? name : undefined}>
      <span
        ref={nameRef}
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
    </Tooltip>
  );
}

type SchemaPageProps = RouterProps;

export class SchemaPage extends Component<SchemaPageProps, any> {
  static contextType = AppContext;

  context!: React.ContextType<typeof AppContext>;

  constructor(props) {
    super(props);

    this.state = {
      expandedKeys: [],
      autoExpandParent: true,
      schemaSearch: '',
      selectedSchema: null,
      selectedTable: null,
      expandedSchemaTables: {},
      tablePreview: null,
      tablePreviewLoading: false,
      tablePreviewError: null,
      tablePreviewCount: null,
      tablePreviewCountLoading: false,
      tablePreviewCountError: null,
      checkedKeys: [],
      selectedKeys: [],
      activeTab: 'schema',
      files: [],
      isDocker: null,
      shown: false,
      editingFileName: null,
      editingContent: '',
      savingFile: false,
      convertingFile: false,
      deletingFile: false,
      fileDialog: null,
      fileDialogName: '',
      fileDialogLoading: false,
      visualEditorFileName: null,
      sampleCubeName: null,
      relationshipDiagramVisible: false,
      fileValidationErrors: {},
      fileValidationGlobalError: null,
      fileValidationLoading: false,
      fileValidationCompleted: false,
    };

    this.validationRun = 0;
  }

  validationRun: number;

  async componentDidMount() {
    await this.loadDBSchema();
    await this.loadFiles();
  }

  onExpand(expandedKeys) {
    playgroundAction('Expand Tables');
    this.setState({
      expandedKeys,
      autoExpandParent: false,
    });
  }

  onCheck(checkedKeys) {
    playgroundAction('Check Tables');
    this.setState({ checkedKeys });
  }

  onSelect(selectedKeys) {
    const selectedKey = selectedKeys?.[0];
    const tablesSchema = this.state.tablesSchema || {};
    const selectedSchema = selectedKey && Object.prototype.hasOwnProperty.call(tablesSchema, selectedKey)
      ? selectedKey
      : null;
    const tableParts = selectedKey && schemasMap[selectedKey];
    const selectedTable = tableParts && tablesSchema[tableParts[0]]?.[tableParts[1]]
      ? { schemaName: tableParts[0], tableName: tableParts[1] }
      : null;

    this.setState({
      selectedKeys,
      selectedSchema,
      selectedTable,
      selectedFile: null,
      tablePreview: null,
      tablePreviewError: null,
      tablePreviewCount: null,
      tablePreviewCountError: null,
      tablePreviewLoading: Boolean(selectedTable),
      tablePreviewCountLoading: Boolean(selectedTable),
    }, () => {
      if (selectedTable) {
        void this.loadTablePreview(selectedTable);
        void this.loadTableCount(selectedTable);
      }
    });
  }

  onSchemaSearchChange(event) {
    this.setState({ schemaSearch: event.target.value });
  }

  toggleSchemaTable(schemaName: string, tableName: string) {
    const tableKey = `${schemaName}.${tableName}`;
    this.setState((state) => ({
      expandedSchemaTables: {
        ...state.expandedSchemaTables,
        [tableKey]: !state.expandedSchemaTables[tableKey],
      },
    }));
  }

  tablePreviewRun = 0;

  tableCountRun = 0;

  async loadTablePreview(table: { schemaName: string; tableName: string }) {
    const previewRun = ++this.tablePreviewRun;
    this.setState({ tablePreviewLoading: true, tablePreviewError: null });
    try {
      const response = await playgroundFetch('playground/schema/table-preview', {
        method: 'POST',
        recoverSession: false,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(table),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const result = await response.json();
      if (previewRun !== this.tablePreviewRun) return;
      this.setState({ tablePreview: result });
    } catch (error: any) {
      if (previewRun === this.tablePreviewRun) {
        this.setState({ tablePreviewError: error?.message || String(error) });
      }
    } finally {
      if (previewRun === this.tablePreviewRun) {
        this.setState({ tablePreviewLoading: false });
      }
    }
  }

  async loadTableCount(table: { schemaName: string; tableName: string }) {
    const countRun = ++this.tableCountRun;
    this.setState({ tablePreviewCountLoading: true, tablePreviewCountError: null });
    try {
      const response = await playgroundFetch('playground/schema/table-count', {
        method: 'POST',
        recoverSession: false,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(table),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const result = await response.json();
      if (countRun !== this.tableCountRun) return;
      this.setState({ tablePreviewCount: result.total == null ? null : String(result.total) });
    } catch (error: any) {
      if (countRun === this.tableCountRun) {
        this.setState({ tablePreviewCountError: error?.message || String(error) });
      }
    } finally {
      if (countRun === this.tableCountRun) {
        this.setState({ tablePreviewCountLoading: false });
      }
    }
  }

  refreshTablePreview() {
    const { selectedTable } = this.state;
    if (!selectedTable) return;
    void this.loadTablePreview(selectedTable);
    void this.loadTableCount(selectedTable);
  }

  async loadDBSchema() {
    this.setState({ schemaLoading: true });
    try {
      const res = await playgroundFetch('playground/db-schema');
      const result = await res.json();
      this.setState({
        tablesSchema: result.tablesSchema,
      });
    } catch (e: any) {
      this.setState({ schemaLoadingError: e });
    } finally {
      this.setState({ schemaLoading: false });
    }
  }

  async loadFiles() {
    const res = await playgroundFetch('playground/files');
    const result = await res.json();

    let draft: { fileName?: string; content?: string } | null = null;
    try {
      const storedDraft = window.sessionStorage.getItem(SCHEMA_EDITOR_DRAFT_KEY);
      draft = storedDraft ? JSON.parse(storedDraft) : null;
    } catch (_e) {
      window.sessionStorage.removeItem(SCHEMA_EDITOR_DRAFT_KEY);
    }

    const draftFile = draft?.fileName && result.files?.find((file) => file.fileName === draft?.fileName);
    if (draftFile && typeof draft?.content === 'string') {
      window.sessionStorage.removeItem(SCHEMA_EDITOR_DRAFT_KEY);
      this.setState({
        files: result.files,
        fileValidationErrors: {},
        fileValidationGlobalError: null,
        fileValidationCompleted: false,
        activeTab: 'files',
        selectedFile: draftFile.fileName,
        editingFileName: draftFile.fileName,
        editingContent: draft.content,
      });
      notification.info({
        message: 'Rascunho restaurado',
        description: 'Revise a alteração e salve o arquivo novamente.',
        placement: 'bottomRight',
        duration: 5,
      });
      void this.validateFiles();
      return;
    }

    const availableFileNames = new Set((result.files || []).map((file) => file.fileName));
    const selectedFile = availableFileNames.has(this.state.selectedFile)
      ? this.state.selectedFile
      : null;
    const editingFileName = this.state.editingFileName
      && availableFileNames.has(this.state.editingFileName)
      ? this.state.editingFileName
      : null;
    const visualEditorFileName = this.state.visualEditorFileName
      && availableFileNames.has(this.state.visualEditorFileName)
      ? this.state.visualEditorFileName
      : null;

    this.setState({
      files: result.files,
      fileValidationErrors: {},
      fileValidationGlobalError: null,
      fileValidationCompleted: false,
      activeTab: result.files && result.files.length > 0 ? 'files' : 'schema',
      selectedFile,
      editingFileName,
      editingContent: editingFileName ? this.state.editingContent : '',
      visualEditorFileName,
    });
    void this.validateFiles();
  }

  async validateFiles() {
    const validationRun = ++this.validationRun;
    this.setState({
      fileValidationLoading: true,
      fileValidationCompleted: false,
    });
    try {
      // Validation is informational. It must not invalidate an otherwise
      // usable datamart session when compiler initialization is still settling.
      const response = await fetch('playground/schema/validation');
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response));
      }
      const result = await response.json();
      const validationError = [result.globalError, ...Object.values(result.errors || {})]
        .filter(Boolean)
        .join('\n');
      if (/Datamart session is missing or expired|Datamart credentials are required/i.test(validationError)) {
        this.setState({
          fileValidationErrors: {},
          fileValidationGlobalError: validationError,
          fileValidationCompleted: false,
        });
        return;
      }
      if (validationRun !== this.validationRun) return;
      this.setState({
        fileValidationErrors: result.errors || {},
        fileValidationGlobalError: result.globalError || null,
        fileValidationCompleted: true,
      });
    } catch (error) {
      // Validation is best-effort and must not log out the user, but its
      // failure must remain visible for diagnosis.
      const validationError = error instanceof Error ? error.message : String(error);
      if (validationRun === this.validationRun) {
        this.setState({
          fileValidationErrors: {},
          fileValidationGlobalError: validationError,
          fileValidationCompleted: false,
        });
      }
    } finally {
      if (validationRun === this.validationRun) {
        this.setState({ fileValidationLoading: false });
      }
    }
  }

  async generateSchema(format: SchemaFormat = SchemaFormat.js) {
    const { checkedKeys, tablesSchema } = this.state;
    const { history } = this.props;

    const options = { format };

    playgroundAction('Generate Schema', options);
    const res = await playgroundFetch('playground/generate-schema', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        format,
        tables: checkedKeys
          .filter((k) => !!schemasMap[k])
          .map((e) => schemasMap[e]),
        tablesSchema,
      }),
    });

    if (res.status === 200) {
      playgroundAction('Generate Schema Success', options);
      await this.loadFiles();
      this.setState({ checkedKeys: [], activeTab: 'files' });
      Modal.success({
        title: 'Arquivos do modelo de dados gerados com sucesso!',
        content:
          'Agora você pode explorar o modelo de dados e criar gráficos.',
        okText: 'Criar gráfico',
        cancelText: 'Fechar',
        okCancel: true,
        onOk() {
          history.push('/build');
        },
      });
    } else {
      playgroundAction('Generate Schema Fail', {
        error: await res.text(),
        ...options,
      });
    }
  }

  selectedFileContent() {
    const file = this.selectedFile();
    return file && file.content;
  }

  selectedFile() {
    const { files, selectedFile } = this.state;
    return files.find((f) => f.fileName === selectedFile);
  }

  fileLanguage(fileName: string) {
    if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
      return 'YAML';
    }

    return 'JavaScript';
  }

  startEditing() {
    const file = this.selectedFile();
    if (!file) {
      return;
    }

    this.setState({
      editingFileName: file.fileName,
      editingContent: file.content || ''
    });
    notification.info({
      message: 'Atalho do editor',
      description: 'Use Ctrl+Espaço para abrir as sugestões de preenchimento.',
      placement: 'bottomRight',
      duration: 4,
    });
  }

  cancelEditing() {
    this.setState({
      editingFileName: null,
      editingContent: ''
    });
  }

  async persistFileContent(fileName: string, content: string) {
    const res = await playgroundFetch('playground/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fileName, content })
    });

    if (res.status !== 200) {
      throw new Error(await responseErrorMessage(res));
    }

    this.setState((previousState) => ({
      files: previousState.files.map((f) => (f.fileName === fileName ? { ...f, content } : f))
    }));
    void this.validateFiles();
  }

  openSampleData() {
    const file = this.selectedFile();
    if (!file) return;
    const cubeName = cubeNameFromFileContent(file.fileName, file.content);
    if (!cubeName) {
      message.error('Não foi possível identificar o cubo neste arquivo');
      return;
    }
    this.setState({ sampleCubeName: cubeName });
  }

  recoverFromExpiredProjectSession(fileName: string, content: string, error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!/Datamart session is missing or expired|Datamart credentials are required/i.test(errorMessage)) {
      return false;
    }

    window.sessionStorage.setItem(
      SCHEMA_EDITOR_DRAFT_KEY,
      JSON.stringify({ fileName, content })
    );
    notification.warning({
      message: 'Sessão do projeto expirada',
      description: 'Reconecte ao projeto. Seu rascunho foi preservado.',
      placement: 'bottomRight',
      duration: 5,
    });
    window.setTimeout(() => window.location.reload(), 800);
    return true;
  }

  async saveEditing() {
    const { editingFileName, editingContent } = this.state;
    if (!editingFileName) {
      return;
    }

    this.setState({ savingFile: true });
    try {
      await this.persistFileContent(editingFileName, editingContent);
      this.setState({ editingFileName: null, editingContent: '' });
      message.success('Arquivo salvo');
      playgroundAction('Save File Success', { fileName: editingFileName });
    } catch (e: any) {
      if (!this.recoverFromExpiredProjectSession(editingFileName, editingContent, e)) {
        message.error(e?.message || 'Não foi possível salvar o arquivo');
      }
      playgroundAction('Save File Fail', { fileName: editingFileName, error: e?.toString?.() || String(e) });
    } finally {
      this.setState({ savingFile: false });
    }
  }

  async saveVisualEditorContent(content: string) {
    const { visualEditorFileName } = this.state;
    if (!visualEditorFileName) {
      return;
    }

    try {
      await this.persistFileContent(visualEditorFileName, content);
      message.success('Arquivo salvo');
      playgroundAction('Save File Success', { fileName: visualEditorFileName, source: 'visual-editor' });
    } catch (e: any) {
      if (this.recoverFromExpiredProjectSession(visualEditorFileName, content, e)) {
        return;
      }
      message.error(e?.message || 'Não foi possível salvar o arquivo');
      playgroundAction('Save File Fail', { fileName: visualEditorFileName, error: e?.toString?.() || String(e) });
      throw e;
    }
  }

  async convertSelectedFile() {
    const { selectedFile } = this.state;
    if (!selectedFile) return;

    const sourceIsYaml = selectedFile.endsWith('.yml') || selectedFile.endsWith('.yaml');
    const sourceBaseName = this.cubeFileName(selectedFile);
    const sourceExtension = sourceBaseName.match(/\.(yml|yaml|js)$/i)?.[0] || '';
    if (!sourceExtension) return;
    const targetFileName = `${sourceBaseName.slice(0, -sourceExtension.length)}${sourceIsYaml ? '.js' : '.yml'}`;
    const targetPath = `cubes/${targetFileName}`;

    this.setState({ convertingFile: true });
    try {
      const response = await playgroundFetch('playground/files/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceFileName: selectedFile, targetFileName }),
      });
      if (response.status !== 200) {
        throw new Error(await responseErrorMessage(response));
      }

      await this.loadFiles();
      this.setState({
        selectedFile: targetPath,
        editingFileName: null,
        editingContent: '',
        visualEditorFileName: null,
      });
      message.success(`Arquivo convertido para ${sourceIsYaml ? 'JavaScript' : 'YAML'}`);
      playgroundAction('Convert File Success', {
        sourceFileName: selectedFile,
        targetFileName: targetPath,
      });
    } catch (e: any) {
      message.error(e?.message || 'Não foi possível converter o arquivo');
      playgroundAction('Convert File Fail', {
        sourceFileName: selectedFile,
        targetFileName: targetPath,
        error: e?.toString?.() || String(e),
      });
    } finally {
      this.setState({ convertingFile: false });
    }
  }

  cubeFileName(fileName: string) {
    const separator = fileName.lastIndexOf('/');
    return separator >= 0 ? fileName.slice(separator + 1) : fileName;
  }

  copyFileName(fileName: string) {
    const baseName = this.cubeFileName(fileName);
    const extensionMatch = baseName.match(/\.(yml|yaml|js)$/i);
    const extension = extensionMatch ? extensionMatch[0] : '';
    const stem = extension ? baseName.slice(0, -extension.length) : baseName;
    const { files } = this.state;
    let candidate = `${stem}_copy${extension}`;
    let suffix = 2;
    while (files.some((file) => file.fileName === `cubes/${candidate}`)) {
      candidate = `${stem}_copy_${suffix}${extension}`;
      suffix += 1;
    }
    return candidate;
  }

  openFileDialog(type: 'copy' | 'rename') {
    const { selectedFile } = this.state;
    if (!selectedFile) return;
    this.setState({
      fileDialog: type,
      fileDialogName: type === 'copy' ? this.copyFileName(selectedFile) : this.cubeFileName(selectedFile),
    });
  }

  closeFileDialog() {
    if (this.state.fileDialogLoading) return;
    this.setState({ fileDialog: null, fileDialogName: '' });
  }

  async submitFileDialog() {
    const { selectedFile, fileDialog, fileDialogName } = this.state;
    if (!selectedFile || !fileDialog) return;

    const targetBaseName = fileDialogName.trim();
    if (!targetBaseName || targetBaseName.includes('..') || targetBaseName.includes('/') || targetBaseName.includes('\\')) {
      message.error('Informe um nome de arquivo válido');
      return;
    }
    const targetFileName = `cubes/${targetBaseName}`;
    if (targetFileName === selectedFile) {
      message.error('O novo nome precisa ser diferente do atual');
      return;
    }
    if (this.state.files.some((file) => file.fileName === targetFileName)) {
      message.error('Já existe um arquivo com esse nome');
      return;
    }
    if ((selectedFile.endsWith('.yml') || selectedFile.endsWith('.yaml'))
      && !targetBaseName.endsWith('.yml') && !targetBaseName.endsWith('.yaml')) {
      message.error('O arquivo YAML precisa manter a extensão .yml ou .yaml');
      return;
    }

    this.setState({ fileDialogLoading: true });
    try {
      const endpoint = fileDialog === 'copy' ? 'playground/files/copy' : 'playground/files/rename';
      const response = await playgroundFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceFileName: selectedFile, targetFileName: targetBaseName }),
      });
      if (response.status !== 200) {
        throw new Error(await responseErrorMessage(response));
      }

      await this.loadFiles();
      this.setState({
        selectedFile: targetFileName,
        editingFileName: null,
        editingContent: '',
        visualEditorFileName: null,
        fileDialog: null,
        fileDialogName: '',
      });
      message.success(fileDialog === 'copy' ? 'Cubo copiado' : 'Arquivo renomeado');
    } catch (e: any) {
      message.error(e?.message || 'Não foi possível concluir a operação');
    } finally {
      this.setState({ fileDialogLoading: false });
    }
  }

  renderFilesMenu() {
    const {
      selectedFile,
      files,
      fileValidationErrors = {},
      fileValidationGlobalError,
      fileValidationLoading = false,
      fileValidationCompleted = false,
    } = this.state;
    return (
      <TablesPaneContent>
        <div
          style={{
            display: 'flex',
            flexShrink: 0,
            justifyContent: 'center',
            padding: '12px 16px',
          }}
        >
          <Button
            type="primary"
            icon={<ApartmentOutlined />}
            onClick={() => this.setState({ relationshipDiagramVisible: true })}
          >
            Diagrama de relacionamentos
          </Button>
        </div>
        <FilesListScroll>
          <Menu
            mode="inline"
            onClick={({ key }) => {
              playgroundAction('Select File');
              this.setState({ selectedFile: key });
            }}
            selectedKeys={selectedFile ? [selectedFile] : []}
          >
            {files.map((f) => (
              <Menu.Item key={f.fileName}>
                <span style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                  <FileNameWithTooltip name={f.fileName} />
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>
                    {fileValidationLoading ? (
                      <Tooltip title="Validando o schema...">
                        <LoadingOutlined spin color="#7568d8" />
                      </Tooltip>
                    ) : (fileValidationErrors[f.fileName] || fileValidationGlobalError) ? (
                      <Tooltip title={fileValidationErrors[f.fileName] || fileValidationGlobalError}>
                        <WarningFilled color="#ff4d4f" />
                      </Tooltip>
                    ) : fileValidationCompleted ? (
                      <Tooltip title="Schema validado">
                        <CheckCircleFilled color="#b7eb8f" />
                      </Tooltip>
                    ) : null}
                  </span>
                </span>
              </Menu.Item>
            ))}
          </Menu>
        </FilesListScroll>
      </TablesPaneContent>
    );
  }

  async deleteSelectedFile() {
    const { selectedFile } = this.state;
    if (!selectedFile) {
      return;
    }

    this.setState({ deletingFile: true });
    try {
      const res = await playgroundFetch('playground/files', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fileName: selectedFile })
      });

      if (res.status !== 200) {
        throw new Error(await res.text());
      }

      this.setState({
        selectedFile: null,
        editingFileName: null,
        editingContent: '',
        visualEditorFileName: null,
      });
      await this.loadFiles();
      message.success('Arquivo excluído');
      playgroundAction('Delete File Success', { fileName: selectedFile });
    } catch (e: any) {
      message.error('Não foi possível excluir o arquivo');
      playgroundAction('Delete File Fail', {
        fileName: selectedFile,
        error: e?.toString?.() || String(e),
      });
    } finally {
      this.setState({ deletingFile: false });
    }
  }

  render() {
    const {
      schemaLoading,
      schemaLoadingError,
      tablesSchema,
      schemaSearch,
      selectedFile,
      expandedKeys,
      autoExpandParent,
      checkedKeys,
      selectedKeys,
      selectedSchema,
      selectedTable,
      expandedSchemaTables,
      tablePreview,
      tablePreviewLoading,
      tablePreviewError,
      tablePreviewCount,
      tablePreviewCountLoading,
      tablePreviewCountError,
      activeTab,
      isDocker,
      editingFileName,
      editingContent,
      savingFile,
      convertingFile,
      deletingFile,
      fileDialog,
      fileDialogName,
      fileDialogLoading,
      visualEditorFileName,
      sampleCubeName,
      relationshipDiagramVisible,
    } = this.state;

    const { playgroundContext } = this.context;

    const [major, minor] = playgroundContext.coreServerVersion
      ? playgroundContext.coreServerVersion.split('.')
      : [];
    const isYamlFormatSupported: boolean = (Number(major) > 0) || (!minor || Number(minor) >= 31);

    const renderTreeNodes = (data) =>
      data.map((item) => {
        if (item.treeData) {
          return (
            // @ts-ignore
            <TreeNode title={item.title} key={item.key} dataRef={item}>
              {renderTreeNodes(item.treeData)}
            </TreeNode>
          );
        }
        return <TreeNode {...item} />;
      });

    const filteredTreeData = schemaToTreeData(tablesSchema || {}, schemaSearch);

    const renderTree = () =>
      filteredTreeData.length > 0 ? (
        <Tree
          checkable
          onExpand={this.onExpand.bind(this)}
          expandedKeys={expandedKeys}
          autoExpandParent={autoExpandParent}
          onCheck={this.onCheck.bind(this)}
          checkedKeys={checkedKeys}
          onSelect={this.onSelect.bind(this)}
          selectedKeys={selectedKeys}
        >
          {renderTreeNodes(filteredTreeData)}
        </Tree>
      ) : schemaSearch.trim() ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nenhum schema ou tabela encontrado" />
      ) : (
        <Alert
          message="Schema do banco vazio"
          description="Verifique as configurações da conexão"
          type="warning"
        />
      );

    const renderTreeOrError = () =>
      schemaLoadingError ? (
        <Alert
          data-testid="schema-error"
          message="Erro ao carregar o schema do banco"
          description={schemaLoadingError.toString()}
          type="error"
        />
      ) : (
        renderTree()
      );

    const renderSchemaDetails = () => {
      if (!selectedSchema || !tablesSchema?.[selectedSchema]) return null;

      const tables = tablesSchema[selectedSchema];
      const tableEntries = Object.entries(tables);

      return (
        <SchemaDetails>
          <SchemaDetailsHeader>
            <SchemaDetailsTitle level={3}>{selectedSchema}</SchemaDetailsTitle>
            <Typography.Text type="secondary">
              {tableEntries.length} {tableEntries.length === 1 ? 'tabela' : 'tabelas'}
            </Typography.Text>
          </SchemaDetailsHeader>

          {tableEntries.map(([tableName, columns]) => (
            <SchemaTableCard key={tableName}>
              <SchemaTableHeader
                type="button"
                title={tableName}
                aria-expanded={Boolean(expandedSchemaTables[`${selectedSchema}.${tableName}`])}
                onClick={() => this.toggleSchemaTable(selectedSchema, tableName)}
              >
                <RightOutlined
                  rotate={expandedSchemaTables[`${selectedSchema}.${tableName}`] ? 90 : 0}
                  style={{ flexShrink: 0 }}
                />
                <SchemaTableName>{tableName}</SchemaTableName>
              </SchemaTableHeader>
              {expandedSchemaTables[`${selectedSchema}.${tableName}`] ? (
                <>
                  <SchemaColumnRow style={{ color: '#8c8c8c', fontSize: 12, fontWeight: 600 }}>
                    <SchemaColumnCell>ATRIBUTO</SchemaColumnCell>
                    <SchemaColumnCell>TIPO</SchemaColumnCell>
                  </SchemaColumnRow>
                  {columns.length > 0 ? columns.map((column) => (
                    <SchemaColumnRow key={`${tableName}.${column.name}`}>
                      <SchemaColumnCell title={column.name}>{column.name}</SchemaColumnCell>
                      <SchemaColumnCell title={column.type || 'Desconhecido'}>
                        {column.type || 'Desconhecido'}
                      </SchemaColumnCell>
                    </SchemaColumnRow>
                  )) : (
                    <SchemaColumnRow>
                      <SchemaColumnCell>Sem atributos</SchemaColumnCell>
                    </SchemaColumnRow>
                  )}
                </>
              ) : null}
            </SchemaTableCard>
          ))}
        </SchemaDetails>
      );
    };

    const renderTableDetails = () => {
      if (!selectedTable || !tablesSchema?.[selectedTable.schemaName]?.[selectedTable.tableName]) return null;

      const metadataColumns = tablesSchema[selectedTable.schemaName][selectedTable.tableName] || [];
      const sampleRows = tablePreview?.rows || [];
      const sampleColumns = tablePreview?.columns?.length
        ? tablePreview.columns
        : metadataColumns.map((column) => column.name);

      return (
        <SchemaDetails>
          <SchemaDetailsHeader>
            <SchemaDetailsTitle level={3} style={{ marginBottom: 0 }}>
              {selectedTable.schemaName}.{selectedTable.tableName}
            </SchemaDetailsTitle>
          </SchemaDetailsHeader>

          <TableDetailsSectionTitle level={4}>Metadados</TableDetailsSectionTitle>
          <TableMetadataCard>
            <SchemaColumnRow style={{ color: '#8c8c8c', fontSize: 12, fontWeight: 600 }}>
              <SchemaColumnCell>COLUNA</SchemaColumnCell>
              <SchemaColumnCell>TIPO</SchemaColumnCell>
            </SchemaColumnRow>
            {metadataColumns.length > 0 ? metadataColumns.map((column) => (
              <SchemaColumnRow key={column.name}>
                <SchemaColumnCell title={column.name}>{column.name}</SchemaColumnCell>
                <SchemaColumnCell title={column.type || 'Desconhecido'}>
                  {column.type || 'Desconhecido'}
                </SchemaColumnCell>
              </SchemaColumnRow>
            )) : (
              <SchemaColumnRow>
                <SchemaColumnCell>Sem colunas disponíveis</SchemaColumnCell>
              </SchemaColumnRow>
            )}
          </TableMetadataCard>

          <TableDetailsSectionTitle level={4}>Amostra de dados</TableDetailsSectionTitle>
          <TableDetailsToolbar>
            <Typography.Text type="secondary">
              {tablePreviewCountLoading ? 'Contando registros...' : tablePreviewCount !== null
                ? Number(tablePreviewCount) <= 25
                  ? `Mostrando ${formatRecordCount(tablePreviewCount)} Registros`
                  : (
                    <>Mostrando {sampleRows.length} de <strong>{formatRecordCount(tablePreviewCount)}</strong> registros</>
                  )
                : tablePreviewCountError
                  ? `Mostrando ${sampleRows.length} registros (total indisponível)`
                  : `Mostrando ${sampleRows.length} registros`}
            </Typography.Text>
            <Button
              style={{ marginLeft: 'auto' }}
              icon={<ReloadOutlined />}
              loading={tablePreviewLoading || tablePreviewCountLoading}
              onClick={() => this.refreshTablePreview()}
            >
              Gerar nova amostra
            </Button>
          </TableDetailsToolbar>
          {tablePreviewError ? (
            <Alert
              type="error"
              showIcon
              message="Não foi possível carregar a amostra"
              description={tablePreviewError}
            />
          ) : tablePreviewLoading && !tablePreview ? (
            <div style={{ minHeight: 160, display: 'grid', placeItems: 'center' }}>
              <Spin tip="Consultando dados..." />
            </div>
          ) : (
            <TableSampleScroll>
              <Table
                size="small"
                bordered
                loading={tablePreviewLoading}
                pagination={false}
                scroll={{ x: 'max-content' }}
                rowKey={(_row, index) => String(index)}
                dataSource={sampleRows}
                locale={{ emptyText: 'Nenhum registro encontrado' }}
                columns={sampleColumns.map((columnName) => {
                  const columnType = metadataColumns.find((column) => (
                    column.name.toLocaleLowerCase() === columnName.toLocaleLowerCase()
                  ))?.type;
                  return {
                    title: (
                      <div style={{ lineHeight: 1.2 }}>
                        <div>{columnName}</div>
                        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 3, fontSize: 11, fontWeight: 400 }}>
                          {columnType || ''}
                        </Typography.Text>
                      </div>
                    ),
                    key: columnName,
                    width: previewColumnWidth(columnName, columnType, sampleRows),
                    render: (_value, row) => previewValue(tableRowValue(row, columnName)),
                  };
                })}
              />
            </TableSampleScroll>
          )}
        </SchemaDetails>
      );
    };

    return (
      <>
        <Layout style={{ height: '100%' }}>
        <Sider width={340} className="schema-sidebar">
          <Tabs
            activeKey={activeTab}
            onChange={(tab) => this.setState({ activeTab: tab })}
          >
            <TabPane tab="Tabelas" key="schema">
              <TablesPaneContent>
                {checkedKeys.length ? (
                  <div
                    style={{
                      display: 'flex',
                      flexShrink: 0,
                      justifyContent: 'center',
                      padding: '12px 16px',
                    }}
                  >
                    <ButtonDropdown
                      show={this.state.shown}
                      type="primary"
                      data-testid="chart-type-btn"
                      overlay={
                        <Menu data-testid="generate-schema">
                          <Menu.Item
                            title={
                              !isYamlFormatSupported
                                ? 'O formato de schema YAML é compatível com o Cube 0.31.0 ou posterior'
                                : ''
                            }
                            disabled={!isYamlFormatSupported}
                            onClick={() => this.generateSchema(SchemaFormat.yaml)}
                          >
                            YAML
                          </Menu.Item>
                          <Menu.Item onClick={() => this.generateSchema()}>
                            JavaScript
                          </Menu.Item>
                        </Menu>
                      }
                      onOverlayOpen={() => this.setState({ shown: true })}
                      onOverlayClose={() => this.setState({ shown: false })}
                      onItemClick={() => this.setState({ shown: false })}
                    >
                      Gerar modelo de dados
                    </ButtonDropdown>
                  </div>
                ) : null}
                <div style={{ padding: '8px 12px', flexShrink: 0 }}>
                  <Input
                    allowClear
                    prefix={<SearchOutlined />}
                    placeholder="Buscar schemas e tabelas"
                    value={schemaSearch}
                    onChange={this.onSchemaSearchChange.bind(this)}
                  />
                </div>
                <TablesTreeScroll>
                  {schemaLoading ? <CubeLoader /> : renderTreeOrError()}
                </TablesTreeScroll>
              </TablesPaneContent>
            </TabPane>

            <TabPane tab="Arquivos" key="files">
              {this.renderFilesMenu()}
            </TabPane>
          </Tabs>
        </Sider>

        <Content
          style={{
            height: '100%',
            minHeight: 0,
            overflow: 'hidden',
            padding: 24,
          }}
        >
          {selectedFile ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, width: '100%' }}>
                <Space>
                {editingFileName === selectedFile ? (
                  <>
                    <Button
                      type="primary"
                      loading={savingFile}
                      onClick={() => this.saveEditing()}
                    >
                      Salvar
                    </Button>
                    <Button onClick={() => this.cancelEditing()} disabled={savingFile}>
                      Cancelar
                    </Button>
                  </>
                ) : (
                  <Button type="primary" onClick={() => this.startEditing()}>
                    <Space size={8}>
                      <CodeOutlined />
                      <span>Editor de código ({this.fileLanguage(selectedFile)})</span>
                    </Space>
                  </Button>
                )}
                {(selectedFile.endsWith('.yml') || selectedFile.endsWith('.yaml'))
                  && editingFileName !== selectedFile && (
                  <Button
                    icon={<TableListOutlined />}
                    onClick={() => this.setState({ visualEditorFileName: selectedFile })}
                  >
                    Editor visual
                  </Button>
                )}
                {(selectedFile.endsWith('.yml') || selectedFile.endsWith('.yaml') || selectedFile.endsWith('.js')) ? (
                  <Button
                    icon={<SyncOutlined />}
                    loading={convertingFile}
                    disabled={Boolean(editingFileName) || deletingFile || fileDialogLoading}
                    onClick={() => this.convertSelectedFile()}
                  >
                    Converter para {selectedFile.endsWith('.yml') || selectedFile.endsWith('.yaml')
                      ? 'JavaScript'
                      : 'YAML'}
                  </Button>
                ) : null}
                  <Button
                    icon={<CopyOutlined />}
                    disabled={Boolean(editingFileName) || convertingFile || deletingFile || fileDialogLoading}
                    onClick={() => this.openFileDialog('copy')}
                  >
                    Copiar arquivo
                  </Button>
                  {(selectedFile.endsWith('.yml') || selectedFile.endsWith('.yaml')) && (
                    <Button
                      icon={<EditOutlined />}
                      disabled={Boolean(editingFileName) || convertingFile || deletingFile || fileDialogLoading}
                      onClick={() => this.openFileDialog('rename')}
                    >
                      Renomear arquivo
                    </Button>
                  )}
                </Space>
                <Space style={{ marginLeft: 'auto' }}>
                  <Button
                    icon={<SearchOutlined />}
                    disabled={Boolean(editingFileName) || convertingFile || deletingFile || fileDialogLoading}
                    onClick={() => this.openSampleData()}
                  >
                    Ver amostra de dados
                  </Button>
                  <ConfirmPopover
                    title="Excluir este arquivo?"
                    okText="Excluir"
                    cancelText="Cancelar"
                    okButtonProps={{ danger: true, loading: deletingFile }}
                    onConfirm={() => this.deleteSelectedFile()}
                    disabled={deletingFile || savingFile || fileDialogLoading}
                  >
                    <Button
                      danger
                      icon={<TrashOutlined />}
                      loading={deletingFile}
                      disabled={savingFile || convertingFile || fileDialogLoading}
                    >
                      Excluir arquivo
                    </Button>
                  </ConfirmPopover>
                </Space>
              </div>

              <Modal
                title={fileDialog === 'copy' ? 'Copiar arquivo' : 'Renomear arquivo do cubo'}
                visible={Boolean(fileDialog)}
                onCancel={() => this.closeFileDialog()}
                onOk={() => this.submitFileDialog()}
                okText={fileDialog === 'copy' ? 'Copiar' : 'Renomear'}
                cancelText="Cancelar"
                confirmLoading={fileDialogLoading}
                destroyOnClose
              >
                <Input
                  autoFocus
                  value={fileDialogName}
                  onChange={(event) => this.setState({ fileDialogName: event.target.value })}
                  onPressEnter={() => this.submitFileDialog()}
                />
              </Modal>

              <CubeSampleDataModal
                visible={Boolean(sampleCubeName)}
                cubeName={sampleCubeName}
                title={selectedFile}
                onClose={() => this.setState({ sampleCubeName: null })}
              />

              <div style={{ marginTop: 16 }}>
                <SchemaFileEditor
                  key={selectedFile}
                  fileName={selectedFile}
                  value={editingFileName === selectedFile ? editingContent : this.selectedFileContent()}
                  readOnly={editingFileName !== selectedFile}
                  tablesSchema={tablesSchema}
                  onChange={(value) => {
                    if (editingFileName === selectedFile) {
                      this.setState({ editingContent: value });
                    }
                  }}
                  onSave={() => this.saveEditing()}
                />
              </div>

              {visualEditorFileName === selectedFile && (
                <CubeVisualEditor
                  visible
                  fileName={selectedFile}
                  yamlContent={editingFileName === selectedFile ? editingContent : this.selectedFileContent()}
                  files={this.state.files}
                  tablesSchema={tablesSchema}
                  onClose={() => this.setState({ visualEditorFileName: null })}
                  onSave={async (content) => {
                    await this.saveVisualEditorContent(content);
                    if (editingFileName === selectedFile) {
                      this.setState({ editingContent: content });
                    }
                  }}
                  onSaveFiles={async (changes) => {
                    for (const change of changes) {
                      await this.persistFileContent(change.fileName, change.content);
                    }
                  }}
                />
              )}

            </>
          ) : selectedTable ? (
            renderTableDetails()
          ) : selectedSchema ? (
            renderSchemaDetails()
          ) : (
            <Empty
              style={{ marginTop: 50 }}
              description="Selecione as tabelas para gerar o modelo de dados do Cube"
            />
          )}

          <CubeRelationshipDiagram
            visible={relationshipDiagramVisible}
            datamartId={playgroundContext.multiDatamart?.activeDatamart?.id}
            tablesSchema={tablesSchema}
            onClose={() => this.setState({ relationshipDiagramVisible: false })}
            onChanged={() => this.loadFiles()}
          />

          <AppContextConsumer
            onReady={({ playgroundContext }) =>
              this.setState({ isDocker: playgroundContext?.isDocker })
            }
          />
        </Content>
        </Layout>
      </>
    );
  }
}
