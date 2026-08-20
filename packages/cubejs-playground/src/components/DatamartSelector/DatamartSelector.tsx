import { Alert, Button, Card, Descriptions, Form, Input, Select, Space, Spin, Tabs, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { FaPlug } from 'react-icons/fa6';
import styled from 'styled-components';

type ConnectionField = {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
};

type ConnectionPreset = {
  id: string;
  label: string;
  dbType: string;
  fields: ConnectionField[];
  defaults?: Record<string, string>;
};

type Datamart = {
  id: string;
  name: string;
  connectionId: string;
};

const Page = styled.div`
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background: #f7f8fa;
`;

const Panel = styled(Card)`
  width: min(640px, 100%);
`;

const ConnectionCard = styled(Card)`
  background: #e6f7ff;
  border-color: #91d5ff;
  margin-bottom: 16px;

  .ant-descriptions-row > th,
  .ant-descriptions-row > td {
    padding-bottom: 4px;
  }

  .ant-descriptions-row:last-child > th,
  .ant-descriptions-row:last-child > td {
    padding-bottom: 0;
  }
`;

function ConnectionSummary({ connection }: { connection?: ConnectionPreset }) {
  if (!connection?.defaults) return null;
  const dsn = connection.defaults.CUBEJS_DB_NETEZZA_DSN;
  const isDsnConnection = connection.dbType === 'odbc' || Boolean(dsn);

  return (
    <ConnectionCard
      size="small"
      title={(
        <Space size={8}>
          <FaPlug />
          <Typography.Text strong>{connection.label}</Typography.Text>
        </Space>
      )}
    >
      <Descriptions column={1} size="small" colon>
        {isDsnConnection ? (
          <Descriptions.Item label="DSN">
            {dsn || 'Configurado no backend'}
          </Descriptions.Item>
        ) : (
          <>
            <Descriptions.Item label="Host">
              {connection.defaults.CUBEJS_DB_HOST || '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Porta">
              {connection.defaults.CUBEJS_DB_PORT || '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Banco">
              {connection.defaults.CUBEJS_DB_NAME || '—'}
            </Descriptions.Item>
          </>
        )}
      </Descriptions>
    </ConnectionCard>
  );
}

export function DatamartSelector({ onReady }: { onReady: () => void }) {
  const [openDatamartForm] = Form.useForm();
  const [createDatamartForm] = Form.useForm();
  const [datamarts, setDatamarts] = useState<Datamart[]>([]);
  const [connections, setConnections] = useState<ConnectionPreset[]>([]);
  const [selectedDatamart, setSelectedDatamart] = useState<Datamart | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCreateConnectionId, setSelectedCreateConnectionId] = useState<string | undefined>();

  const connection = useMemo(
    () => connections.find(item => item.id === selectedDatamart?.connectionId),
    [connections, selectedDatamart]
  );

  const hasConnectionDefaults = useMemo(
    () => Boolean(connection?.defaults && Object.keys(connection.defaults).length > 0),
    [connection]
  );

  const openCredentialFields = useMemo(
    () => (connection?.fields || []).filter(field => !connection?.defaults?.[field.name]),
    [connection]
  );

  const createConnection = useMemo(
    () => connections.find(item => item.id === selectedCreateConnectionId),
    [connections, selectedCreateConnectionId]
  );

  const hasCreateConnectionDefaults = useMemo(
    () => Boolean(createConnection?.defaults && Object.keys(createConnection.defaults).length > 0),
    [createConnection]
  );

  const createCredentialFields = useMemo(
    () => (createConnection?.fields || []).filter(field => !createConnection?.defaults?.[field.name]),
    [createConnection]
  );

  useEffect(() => {
    fetch('playground/datamarts')
      .then(async response => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Não foi possível carregar os projetos');
        setDatamarts(value.datamarts);
        setConnections(value.connections);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    openDatamartForm.resetFields();
    if (connection?.defaults) {
      openDatamartForm.setFieldsValue(connection.defaults);
    }
  }, [connection, openDatamartForm]);

  useEffect(() => {
    const currentConnectionId = createDatamartForm.getFieldValue('connectionId');
    if (!currentConnectionId && connections.length === 1) {
      createDatamartForm.setFieldsValue({ connectionId: connections[0].id });
      setSelectedCreateConnectionId(connections[0].id);
      return;
    }

    if (currentConnectionId && currentConnectionId !== selectedCreateConnectionId) {
      setSelectedCreateConnectionId(currentConnectionId);
    }

    if (!createConnection) {
      return;
    }

    const clearedCredentialValues = Object.fromEntries(
      createConnection.fields.map(field => [field.name, undefined])
    );

    createDatamartForm.setFieldsValue({
      ...clearedCredentialValues,
      ...(createConnection.defaults || {}),
    });
  }, [connections, createConnection, createDatamartForm]);

  async function createDatamart(values) {
    setError(null);
    setSubmitting(true);
    try {
      const { id, name, connectionId, ...credentials } = values;
      const response = await fetch('playground/datamarts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, connectionId, credentials }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Não foi possível validar conexão e criar o projeto');
      setDatamarts(current => [...current, value.datamart]);
      onReady();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function openDatamart(credentials) {
    if (!selectedDatamart) return;
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`playground/datamarts/${selectedDatamart.id}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Não foi possível conectar ao banco');
      onReady();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Page><Spin size="large" /></Page>;

  return (
    <Page>
      <Panel>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Typography.Title level={2}>Datamarts</Typography.Title>
            <Typography.Text type="secondary">
              Crie ou abra datamarts. A criação agora só acontece após conexão bem-sucedida no banco.
            </Typography.Text>
          </div>

          {error ? <Alert type="error" message={error} showIcon /> : null}

          {selectedDatamart ? (
            <>
              <Typography.Title level={4}>{selectedDatamart.name}</Typography.Title>
              {hasConnectionDefaults ? (
                <ConnectionSummary connection={connection} />
              ) : null}
              <Form
                form={openDatamartForm}
                layout="vertical"
                onFinish={openDatamart}
                initialValues={connection?.defaults}
              >
                {openCredentialFields.map(field => (
                  <Form.Item
                    key={field.name}
                    name={field.name}
                    label={field.label}
                    rules={
                      field.required
                        ? [{ required: true, message: `${field.label} é obrigatório` }]
                        : []
                    }
                  >
                    {field.secret ? <Input.Password autoComplete="current-password" /> : <Input autoComplete="off" />}
                  </Form.Item>
                ))}
                <Space>
                  <Button onClick={() => setSelectedDatamart(null)}>Voltar</Button>
                  <Button type="primary" htmlType="submit" loading={submitting}>Conectar e abrir</Button>
                </Space>
              </Form>
            </>
          ) : (
            <Tabs defaultActiveKey={datamarts.length ? 'open' : 'create'}>
              <Tabs.TabPane tab="Abrir datamart" key="open" disabled={!datamarts.length}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Select
                    style={{ width: '100%' }}
                    placeholder="Selecione um datamart"
                    onChange={id => setSelectedDatamart(datamarts.find(datamart => datamart.id === id) || null)}
                    options={datamarts.map(datamart => ({ value: datamart.id, label: datamart.name }))}
                  />
                </Space>
              </Tabs.TabPane>
              <Tabs.TabPane tab="Criar datamart" key="create">
                <Form
                  form={createDatamartForm}
                  layout="vertical"
                  autoComplete="off"
                  onFinish={createDatamart}
                  onValuesChange={(changedValues) => {
                    if ('connectionId' in changedValues) {
                      setSelectedCreateConnectionId(changedValues.connectionId);
                    }
                  }}
                >
                  <Form.Item name="name" label="Nome" rules={[{ required: true }]}> 
                    <Input autoComplete="off" placeholder="Financeiro" />
                  </Form.Item>
                  <Form.Item
                    name="id"
                    label="Identificador"
                    rules={[
                      { required: true },
                      { pattern: /^[a-z0-9_-]{1,63}$/, message: 'Use letras minúsculas, números, hífens e sublinhados' },
                    ]}
                  >
                    <Input autoComplete="off" placeholder="financeiro" />
                  </Form.Item>
                  <Form.Item name="connectionId" label="Conexão" rules={[{ required: true }]}>
                    <Select options={connections.map(item => ({ value: item.id, label: item.label }))} />
                  </Form.Item>

                  {hasCreateConnectionDefaults ? (
                    <ConnectionSummary connection={createConnection} />
                  ) : null}

                  {createCredentialFields.map(field => (
                    <Form.Item
                      key={`create-${field.name}`}
                      name={field.name}
                      label={field.label}
                      rules={
                        field.required
                          ? [{ required: true, message: `${field.label} é obrigatório` }]
                          : []
                      }
                    hidden={!createConnection}
                    >
                      {field.secret ? <Input.Password autoComplete="current-password" /> : <Input autoComplete="off" />}
                    </Form.Item>
                  ))}

                  <Button type="primary" htmlType="submit" loading={submitting}>
                    Validar conexão e criar datamart
                  </Button>
                </Form>
              </Tabs.TabPane>
            </Tabs>
          )}
        </Space>
      </Panel>
    </Page>
  );
}
