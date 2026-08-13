import React, { Component } from 'react';
import { Layout, Modal, Empty, Typography, Button, Space, Popconfirm, message, notification, Input } from 'antd';
import { RouterProps } from 'react-router-dom';
import {
  ApartmentOutlined,
  CodeOutlined,
  CopyOutlined,
  EditOutlined,
  SearchOutlined,
  TableListOutlined,
  TrashOutlined,
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
import styled, { createGlobalStyle } from 'styled-components';

const { Content, Sider } = Layout;

const { TreeNode } = Tree;
const { TabPane } = Tabs;

const SCHEMA_EDITOR_DRAFT_KEY = 'cube-schema-editor-draft';

function cubeNameFromFileContent(fileName: string, content?: string): string | null {
  if (!content) return null;
  if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
    const match = content.match(/^\s*-\s+name:\s*["']?([^\s"'#]+)["']?\s*$/m);
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
  overflow: auto;
`;

const SchemaPageOverlayStyles = createGlobalStyle`
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

const schemasMap = {};
const schemaToTreeData = (schemas) =>
  Object.keys(schemas).map((schemaName) => ({
    title: schemaName,
    key: schemaName,
    treeData: Object.keys(schemas[schemaName]).map((tableName) => {
      const key = `${schemaName}.${tableName}`;
      schemasMap[key] = [schemaName, tableName];
      return {
        title: tableName,
        key,
      };
    }),
  }));

type SchemaPageProps = RouterProps;

export class SchemaPage extends Component<SchemaPageProps, any> {
  static contextType = AppContext;

  context!: React.ContextType<typeof AppContext>;

  constructor(props) {
    super(props);

    this.state = {
      expandedKeys: [],
      autoExpandParent: true,
      checkedKeys: [],
      selectedKeys: [],
      activeTab: 'schema',
      files: [],
      isDocker: null,
      shown: false,
      editingFileName: null,
      editingContent: '',
      savingFile: false,
      deletingFile: false,
      fileDialog: null,
      fileDialogName: '',
      fileDialogLoading: false,
      visualEditorFileName: null,
      sampleCubeName: null,
      relationshipDiagramVisible: false
    };
  }

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
    this.setState({ selectedKeys });
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
      return;
    }

    this.setState({
      files: result.files,
      activeTab: result.files && result.files.length > 0 ? 'files' : 'schema',
    });
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

    const { files } = this.state;
    this.setState({
      files: files.map((f) => (f.fileName === fileName ? { ...f, content } : f))
    });
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
    if (!/Project session is missing or expired|Project credentials are required/i.test(errorMessage)) {
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
    const { selectedFile, files } = this.state;
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
        <TablesTreeScroll>
          <Menu
            mode="inline"
            onClick={({ key }) => {
              playgroundAction('Select File');
              this.setState({ selectedFile: key });
            }}
            selectedKeys={selectedFile ? [selectedFile] : []}
          >
            {files.map((f) => (
              <Menu.Item key={f.fileName}>{f.fileName}</Menu.Item>
            ))}
          </Menu>
        </TablesTreeScroll>
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
      message.success('Cubo excluído');
      playgroundAction('Delete File Success', { fileName: selectedFile });
    } catch (e: any) {
      message.error('Não foi possível excluir o cubo');
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
      selectedFile,
      expandedKeys,
      autoExpandParent,
      checkedKeys,
      selectedKeys,
      activeTab,
      isDocker,
      editingFileName,
      editingContent,
      savingFile,
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

    const renderTree = () =>
      Object.keys(tablesSchema || {}).length > 0 ? (
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
          {renderTreeNodes(schemaToTreeData(tablesSchema || {}))}
        </Tree>
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

    return (
      <>
        <SchemaPageOverlayStyles />
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
            minHeight: 280,
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
                  <Button
                    icon={<CopyOutlined />}
                    disabled={Boolean(editingFileName) || deletingFile || fileDialogLoading}
                    onClick={() => this.openFileDialog('copy')}
                  >
                    Copiar cubo
                  </Button>
                  {(selectedFile.endsWith('.yml') || selectedFile.endsWith('.yaml')) && (
                    <Button
                      icon={<EditOutlined />}
                      disabled={Boolean(editingFileName) || deletingFile || fileDialogLoading}
                      onClick={() => this.openFileDialog('rename')}
                    >
                      Renomear arquivo
                    </Button>
                  )}
                </Space>
                <Space style={{ marginLeft: 'auto' }}>
                  <Button
                    icon={<SearchOutlined />}
                    disabled={Boolean(editingFileName) || deletingFile || fileDialogLoading}
                    onClick={() => this.openSampleData()}
                  >
                    Ver amostra de dados
                  </Button>
                  <Popconfirm
                    title="Excluir este cubo?"
                    overlayClassName="cube-remove-popconfirm"
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
                      disabled={savingFile || fileDialogLoading}
                    >
                      Excluir cubo
                    </Button>
                  </Popconfirm>
                </Space>
              </div>

              <Modal
                title={fileDialog === 'copy' ? 'Copiar cubo' : 'Renomear arquivo do cubo'}
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
                  tablesSchema={tablesSchema}
                  onClose={() => this.setState({ visualEditorFileName: null })}
                  onSave={async (content) => {
                    await this.saveVisualEditorContent(content);
                    if (editingFileName === selectedFile) {
                      this.setState({ editingContent: content });
                    }
                  }}
                />
              )}

            </>
          ) : (
            <Empty
              style={{ marginTop: 50 }}
              description="Selecione as tabelas para gerar o modelo de dados do Cube"
            />
          )}

          <CubeRelationshipDiagram
            visible={relationshipDiagramVisible}
            projectId={playgroundContext.multiProject?.activeProject?.id}
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
