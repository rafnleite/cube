# Painel Nota Fiscal Mineira

Aplicação Vite independente que consulta exclusivamente a API REST do Cube para o
datamart `nota_mineira_2`. Cada seção é carregada isoladamente e o botão
**Chamadas da API** mostra latência, linhas retornadas e a consulta de cada chamada.

```powershell
npm.cmd install
npm.cmd run dev
```

Abra <http://127.0.0.1:4174>. O Cube deve estar disponível em
`http://localhost:4000`. O Vite encaminha `/cubejs-api` e `/playground` para ele.

O intervalo padrão é de 04/08/2024 até a data atual. O relatório não acessa o
banco diretamente e não grava dados no Cube.
