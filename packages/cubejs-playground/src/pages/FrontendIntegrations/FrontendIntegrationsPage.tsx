import { Card, Layout, Space, Tabs, Typography, Table, Col, Row } from 'antd';
import { CodeSnippet } from '../../atoms';
import { Content, Header } from '../components/Ui';
import { CopiableInput } from '../../components/CopiableInput';
import { usePlaygroundContext } from '../../hooks';

const { Paragraph, Link, Title } = Typography;

export function FrontendIntegrationsPage() {
  const { basePath = '/cubejs-api' } = usePlaygroundContext();
  const token = 'token';
  const apiUrl = `${window.location.origin}${basePath}`;
  const restUrl = `${apiUrl}/v1/load`;
  const wsUrl = `${window.location.origin.replace(/^http/, 'ws')}/`;
  const graphqlUrl = `${apiUrl}/graphql`;

  const dataSource = [
    {
      key: '1',
      name: 'Endpoint da API REST',
      url: restUrl,
      docsUrl: 'https://cube.dev/reference/core-data-apis/rest-api',
    },
    {
      key: '2',
      name: 'Endpoint WebSocket',
      url: wsUrl,
      docsUrl: 'https://cube.dev/recipes/core-data-api/real-time-data-fetch',
    },
    {
      key: '2',
      name: 'Endpoint GraphQL',
      url: graphqlUrl,
      docsUrl: 'https://cube.dev/reference/core-data-apis/graphql-api',
    },
  ];
  
  const columns = [
    {
      title: 'Nome',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'URL',
      dataIndex: 'url',
      key: 'url',
      render: (text) => <CopiableInput wrapperStyle={{ margin: 0 }} value={text} />
    },
    {
      title: 'Documentação',
      dataIndex: 'docsUrl',
      key: 'docsUrl',
      render: (text) => <a href={text} target="_blank">Documentação</a>
    }
  ];

  return (
    <Layout>
      <Header>
        <Title>Integrações frontend</Title>
      </Header>

      <Content>
          <Row gutter={48}>
            <Col span={12}>
              <Paragraph>
                Consulte a documentação do Cube para saber mais sobre as APIs{' '}
                <Link href="https://cube.dev/reference/core-data-apis/rest-api" target="_blank">
                  REST
                </Link>
                ,{' '}
                <Link href="https://cube.dev/reference/core-data-apis/graphql-api" target="_blank">
                  GraphQL
                </Link>{' '}
                e{' '}
                <Link
                  href="https://cube.dev/reference/javascript-sdk"
                  target="_blank"
                >
                  integração com frameworks frontend
                </Link>
                .
              </Paragraph>
              <Paragraph>
                <Table dataSource={dataSource} columns={columns} pagination={false} showHeader={false} />
              </Paragraph>
            </Col>
            <Col span={12}>
            <Tabs defaultActiveKey="1" size="small">
            <Tabs.TabPane key="terminal" tab="Terminal">
              <Space direction="vertical" size="large">
                <Card>
                  <Paragraph>REST API</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`curl \\ 
  -H "Authorization: ${token}" \\ 
  -G \\ 
  --data-urlencode 'query={"measures":["LineItems.count"]}' \\ 
  ${apiUrl}/v1/load

`}
                  />
                </Card>

                <Card>
                  <Paragraph>GraphQL API</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`curl \\ 
  -H "Authorization: ${token}" \\ 
  -G \\ 
  --data-urlencode 'query={"measures":["LineItems.count"]}' \\ 
  ${apiUrl}/v1/graphql

`}
                  />
                </Card>
              </Space>
            </Tabs.TabPane>

            <Tabs.TabPane key="vanilla-js" tab="Vanilla JS">
              <Space direction="vertical" size="large">
                <div>
                  <Paragraph>Inicializar a API do Cube</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`import cube from '@cubejs-client/core';
const cubeApi = cube(
  '${token}',
  { apiUrl: '${apiUrl}/v1' }
);`}
                  />
                </div>

                <div>
                  <Paragraph>Obter o conjunto de resultados</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`const resultSet = await cubejsApi.load({
  "measures":["LineItems.count"]
});`}
                  />
                </div>
              </Space>
            </Tabs.TabPane>

            <Tabs.TabPane key="react" tab="React">
              <Space direction="vertical" size="large">
                <div>
                  <Paragraph>Inicializar a API do Cube</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`import cube from '@cubejs-client/core';
const cubeApi = cube(
  '${token}',
  { apiUrl: '${apiUrl}/v1' }
);`}
                  />
                </div>

                <div>
                  <Paragraph>Declarar o CubeProvider</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`import { CubeProvider } from '@cubejs-client/react';
// ...
<CubeProvider cubejsApi={cubejsApi}>...`}
                  />
                </div>

                <div>
                  <Paragraph>Obter o conjunto de resultados</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`import { useCubeQuery } from '@cubejs-client/react'; 
// ... 
const { resultSet, isLoading, error, progress } = useCubeQuery({ 
  "measures":["LineItems.count"] 
});`}
                  />
                </div>
              </Space>
            </Tabs.TabPane>

            <Tabs.TabPane key="angular" tab="Angular">
              <Space direction="vertical" size="large">
                <div>
                  <Paragraph>Configurar as opções do Cube</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`const cubejsOptions = { 
  token: '${token}', 
  options: { apiUrl: '${apiUrl}/v1' } 
}; `}
                  />
                </div>

                <Paragraph>
                  Encontre o tutorial completo e exemplos de Angular{' '}
                  <Link
                    href="https://cube.dev/reference/javascript-sdk/angular"
                    target="_blank"
                  >
                    neste guia da documentação
                  </Link>
                  .
                </Paragraph>
              </Space>
            </Tabs.TabPane>

            <Tabs.TabPane key="vue" tab="Vue">
              <Space direction="vertical" size="large">
                <div>
                  <Paragraph>Inicializar a API do Cube</Paragraph>

                  <CodeSnippet
                    theme="light"
                    code={`import cube from '@cubejs-client/core';
const cubeApi = cube(
  '${token}',
  { apiUrl: '${apiUrl}/v1' }
);`}
                  />
                </div>

                <Paragraph>
                  Encontre o tutorial completo e exemplos de Vue{' '}
                  <Link
                    href="https://cube.dev/reference/javascript-sdk/angular"
                    target="_blank"
                  >
                    neste guia da documentação
                  </Link>
                  .
                </Paragraph>
              </Space>
            </Tabs.TabPane>
          </Tabs>
            </Col>
          </Row>
      </Content>
    </Layout>
  );
}
