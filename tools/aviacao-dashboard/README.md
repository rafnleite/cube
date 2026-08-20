# Aviation Control Room

Dashboard independente do Playground. A aplicação é uma página HTML/JavaScript
que consome a API REST do Cube para o datamart `aviacao`.

## Executar localmente

A partir deste diretório:

```powershell
npm.cmd run dev
```

Abra <http://127.0.0.1:4173>.

O Vite faz proxy de `/cubejs-api` e `/playground` para `http://localhost:4000`.
Assim, a aplicação aproveita a sessão ativa do datamart sem depender do código
do Playground.

O servidor Cube precisa estar em execução na porta `4000`. O dashboard é apenas
o cliente HTTP; ele não inicia o Cube nem o banco de dados.

Se a sessão não estiver ativa, use o botão `Connection`: ele abre um formulário
temporário para iniciar a sessão do datamart. A senha não é persistida pelo
dashboard. Também é possível informar um token Cube no campo opcional ou outra
origem de API, por exemplo `http://localhost:4000`.

## Build estático

```powershell
npm.cmd run build
```

O dashboard usa somente endpoints HTTP: `meta`, `load`, `playground/context` e o
bootstrap opcional de sessão em `playground/datamarts/aviacao/session`. Não
acessa o banco diretamente, não importa componentes do Playground e não escreve
no modelo.

## O que explorar

- filtros por status e país de chegada;
- renovação explícita de cache pelo modo `Renew query cache`;
- tendência mensal com drill por período;
- distribuição de status clicável;
- mapa de aeroportos com coordenadas do cubo;
- drill por aeroporto, rota e membro da matriz status × aeronave;
- matriz cruzando `timetable` com `airplanes`;
- tabela paginada por `offset` e `limit`;
- painel de chamadas com latência, linhas, `requestId`, `slowQuery`,
  `lastRefreshTime` e `usedPreAggregations`;
- exportação das chamadas realizadas em JSON.
