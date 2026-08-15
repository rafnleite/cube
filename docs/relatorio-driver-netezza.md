# Relatório — driver IBM Netezza

## Objetivo

Foi criado o pacote `@cubejs-backend/netezza-driver` para conectar o Cube a IBM Netezza e registrado o tipo de banco `netezza` no servidor, no Docker e nos presets de conexão do projeto.

Embora o Netezza tenha herança arquitetural de PostgreSQL, o driver não reutiliza o cliente `pg`: a IBM determina que o acesso deve usar o driver ODBC específico do fornecedor, e não um driver ODBC de outro banco. Por isso, a implementação reaproveita a organização e as convenções do driver PostgreSQL, mas usa `odbc` para a comunicação.

## Arquivos criados e alterados

| Local | Alteração |
| --- | --- |
| `packages/cubejs-netezza-driver` | Novo pacote do driver, com implementação, dialeto SQL e testes unitários. |
| `packages/cubejs-server-core/src/core/DriverDependencies.ts` | Registro de `netezza` para resolver `@cubejs-backend/netezza-driver`. |
| `packages/cubejs-server-core/src/core/types.ts` | Inclusão de `netezza` no tipo de bancos reconhecidos. |
| `packages/cubejs-backend-shared/src/env.ts` | Variáveis de ambiente específicas do Netezza. |
| `config/connections.json` | Presets de conexão por host/porta e por connection string ODBC/DSN. |
| `packages/cubejs-docker/package.json` e `.local` | Inclusão do pacote na imagem Docker e no fluxo local. |

## O que o driver faz

- Conecta pelo pacote `odbc`, que por sua vez usa o driver ODBC oficial do Netezza instalado no ambiente.
- Aceita três formas de configuração, em ordem de prioridade:
  1. connection string ODBC completa;
  2. DSN ODBC configurado no sistema;
  3. host, porta, banco, schema, usuário e senha.
- Usa a porta padrão `5480` quando ela não é informada.
- Implementa pool de conexões, teste de conexão, consultas parametrizadas e cursor ODBC para importação em fluxo.
- Lê tabelas, colunas e chaves pelo catálogo ODBC (`tables`, `columns`, `primaryKeys` e `foreignKeys`). Isso evita supor que o `information_schema` tenha o mesmo comportamento em todas as versões do Netezza.
- Mapeia os tipos mais usuais do Netezza para os tipos genéricos do Cube e cria tabelas auxiliares usando `DISTRIBUTE ON RANDOM`.
- Cria o dialeto `NetezzaQuery`, derivado do dialeto PostgreSQL, mas com parâmetros `?` e sem reutilização de posições. Isto é necessário para ODBC: cada ocorrência de `?` recebe um valor ligado separadamente.
- Trata `TIMESTAMP` como valor já normalizado no banco (tipicamente UTC), pois Netezza oferece `TIMESTAMP` e `TIMETZ`, mas não o tipo PostgreSQL `timestamp with time zone` usado pelo dialeto original.

## Configuração

### Host, porta e credenciais

```dotenv
CUBEJS_DB_TYPE=netezza
CUBEJS_DB_HOST=netezza.exemplo.local
CUBEJS_DB_PORT=5480
CUBEJS_DB_NAME=warehouse
CUBEJS_DB_NETEZZA_SCHEMA=analytics
CUBEJS_DB_USER=cube
CUBEJS_DB_PASS=senha
# Opcional; o padrão gerado é NetezzaSQL.
CUBEJS_DB_NETEZZA_DRIVER=NetezzaSQL
```

### DSN

```dotenv
CUBEJS_DB_TYPE=netezza
CUBEJS_DB_NETEZZA_DSN=NZSQL
CUBEJS_DB_USER=cube
CUBEJS_DB_PASS=senha
```

### Connection string completa

```dotenv
CUBEJS_DB_TYPE=netezza
CUBEJS_DB_NETEZZA_CONNECTION_STRING=DSN=NZSQL;UID=cube;PWD=senha
```

`CUBEJS_DB_URL` também é aceito como alternativa de compatibilidade para uma connection string ODBC completa, mas a variável específica acima é mais clara.

Antes de iniciar o Cube, é preciso instalar o client/driver ODBC da IBM e configurar o driver manager/DSN no sistema que executa o Cube. Em Linux, o `node-odbc` também depende de um driver manager ODBC, normalmente unixODBC.

## Validações incluídas

Os testes unitários cobrem:

- montagem e escape de connection strings ODBC;
- precedência de connection string completa;
- marcadores `?` usados pelo driver;
- mapeamento dos tipos físicos usados nas tabelas auxiliares;
- repetição correta de parâmetros quando o mesmo valor aparece duas vezes no SQL.

Não há teste de integração contra Netezza porque não existe uma instância Netezza acessível neste workspace.

## Pontos que precisam ser validados em um ambiente Netezza

1. **Nome do driver ODBC:** o padrão usado é `NetezzaSQL`, mas instalações IBM podem registrar um nome diferente. Caso isso ocorra, usar `CUBEJS_DB_NETEZZA_DRIVER`, um DSN ou uma connection string completa.
2. **Metadados ODBC:** o driver usa as APIs padrão ODBC para tabelas, colunas e chaves. É necessário validar se a versão IBM instalada expõe os nomes de campos padrão (`TABLE_SCHEM`, `TYPE_NAME`, `PKTABLE_NAME` etc.) e se o usuário possui permissão para consultá-los.
3. **Fusos horários:** como `TIMESTAMP` no Netezza não carrega fuso, o driver não aplica conversão automática por consulta. Os timestamps precisam estar em uma convenção única, preferencialmente UTC, ou a modelagem deve fazer a conversão explícita.
4. **Pré-agregações e distribuição:** as tabelas criadas diretamente pelo driver usam distribuição aleatória. Operações `CREATE TABLE AS` geradas pelo Cube seguem a política de distribuição da instância Netezza. Se houver grande volume, deve-se medir e eventualmente definir distribuição/organização apropriadas para as tabelas de pré-agregação.
5. **Recursos PostgreSQL exclusivos:** HLL do PostgreSQL não é aceito. Funções SQL mais específicas, sobretudo de série temporal avançada, devem ser validadas contra a versão exata do Netezza antes de uso em produção.
6. **Tipos binários e menos comuns:** `VARBINARY`, `TIMETZ`, `INTERVAL`, tipos espaciais e tipos definidos pelo usuário não foram exercitados em uma instância real; os tipos temporalmente ambíguos são retornados como texto quando não há um equivalente seguro no Cube.

## Fontes consultadas

- IBM: [ODBC drivers](https://www.ibm.com/docs/en/netezza?topic=managers-odbc-drivers) — requer o driver específico do Netezza.
- IBM: [Setting up an ODBC environment](https://www.ibm.com/docs/en/netezza?topic=driver-setting-up-odbc-environment) — instalação do client, driver manager e configuração do ODBC.
- IBM: [Configuring the DSN and driver options](https://www.ibm.com/docs/en/netezza?topic=driver-configuring-dsn-options-odbc-setup) — servidor, banco, schema, credenciais e porta padrão 5480.
- IBM: [Data types](https://www.ibm.com/docs/en/netezza?topic=npse-data-types) — tipos suportados e limites.
- IBM: [CREATE TABLE](https://www.ibm.com/docs/en/netezza?topic=reference-create-table) e [distribution keys](https://www.ibm.com/docs/en/netezza?topic=skew-specify-distribution-keys) — distribuição e limitações das restrições.
- IBM: [Cast conversions](https://www.ibm.com/docs/en/netezza?topic=functions-cast-conversions) e [date/time functions](https://www.ibm.com/docs/en/netezza?topic=extensions-datetime-functions) — compatibilidade de conversões e funções temporais.
