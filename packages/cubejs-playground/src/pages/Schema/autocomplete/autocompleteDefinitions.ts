import type * as Monaco from 'monaco-editor';

export type CompletionDefinition = {
  label: string;
  insertText: string;
  detail: string;
  kind: 'property' | 'snippet';
  sortText?: string;
};

export const SCHEMA_AUTOCOMPLETE = {
  yamlSnippets: [
    {
      label: 'cube',
      insertText: 'cubes:\n  - name: ${1:orders}\n    sql_table: ${2:public.orders}\n\n    dimensions:\n      - name: ${3:id}\n        sql: ${4:id}\n        type: ${5:number}\n        primary_key: true\n\n    measures:\n      - name: ${6:count}\n        type: count\n',
      detail: 'Cube YAML skeleton',
      kind: 'snippet',
    },
    {
      label: 'dimension',
      insertText: '- name: ${1:created_at}\n  sql: ${2:created_at}\n  type: ${3:time}\n',
      detail: 'Dimension',
      kind: 'snippet',
    },
    {
      label: 'measure',
      insertText: '- name: ${1:total_amount}\n  sql: ${2:amount}\n  type: ${3:sum}\n',
      detail: 'Measure',
      kind: 'snippet',
    },
    {
      label: 'join',
      insertText: '- name: ${1:customers}\n  relationship: ${2:many_to_one}\n  sql: ${3:${CUBE}.customer_id} = ${4:${customers}.id}\n',
      detail: 'Join',
      kind: 'snippet',
    },
    {
      label: 'pre_aggregations',
      insertText: 'pre_aggregations:\n  - name: ${1:main}\n    measures:\n      - ${2:CUBE.count}\n    dimensions:\n      - ${3:CUBE.status}\n    time_dimension: ${4:CUBE.created_at}\n    granularity: ${5:day}\n',
      detail: 'Pre-aggregation',
      kind: 'snippet',
    },
  ] satisfies CompletionDefinition[],
  javascriptSnippets: [
    {
      label: 'cube',
      insertText: "cube('${1:Orders}', {\n  sql: `SELECT * FROM public.orders`,\n\n  measures: {\n    count: {\n      type: 'count'\n    }\n  },\n\n  dimensions: {\n    id: {\n      sql: 'id',\n      type: 'number',\n      primaryKey: true\n    },\n    createdAt: {\n      sql: 'created_at',\n      type: 'time'\n    }\n  }\n});\n",
      detail: 'Cube JS skeleton',
      kind: 'snippet',
    },
    {
      label: 'dimension',
      insertText: "${1:name}: {\n  sql: '${2:column_name}',\n  type: '${3:string}'\n}",
      detail: 'Dimension',
      kind: 'snippet',
    },
    {
      label: 'measure',
      insertText: "${1:totalAmount}: {\n  sql: '${2:amount}',\n  type: '${3:sum}'\n}",
      detail: 'Measure',
      kind: 'snippet',
    },
    {
      label: 'join',
      insertText: "${1:Customers}: {\n  relationship: '${2:many_to_one}',\n  sql: `${CUBE}.customer_id = ${Customers}.id`\n}",
      detail: 'Join',
      kind: 'snippet',
    },
    {
      label: 'preAggregations',
      insertText: "preAggregations: {\n  ${1:main}: {\n    type: 'rollup',\n    measureReferences: [count],\n    dimensionReferences: [status],\n    timeDimensionReference: createdAt,\n    granularity: '${2:day}'\n  }\n}",
      detail: 'Pre-aggregation',
      kind: 'snippet',
    },
  ] satisfies CompletionDefinition[],
};

export const CASE_AUTOCOMPLETE = {
  root: [
    {
      label: 'Case completo (1 when)',
      insertText: 'when:\n  - sql: "${1:{CUBE}.status = \'active\'}"\n    label: ${2:Ativo}\nelse:\n  label: ${3:Outro}',
      detail: 'Estrutura completa com when, sql, label e else',
      kind: 'snippet',
      sortText: '0000',
    },
    {
      label: 'when',
      insertText: 'when: ',
      detail: 'Propriedade do case',
      kind: 'property',
    },
    {
      label: 'else com label',
      insertText: 'else:\n  label: ${1:Outro}',
      detail: 'Estrutura do caso padrão',
      kind: 'snippet',
    },
    {
      label: 'else',
      insertText: 'else: ',
      detail: 'Propriedade do case',
      kind: 'property',
    },
  ] satisfies CompletionDefinition[],
  whenValue: [
    {
      label: 'Adicionar condição',
      insertText: "\n  - sql: \"${1:{CUBE}.status = 'active'}\"\n    label: ${2:Ativo}",
      detail: 'Condição SQL e resultado do case',
      kind: 'snippet',
      sortText: '0000',
    },
  ] satisfies CompletionDefinition[],
  whenItemStart: [
    {
      label: 'Adicionar condição (when)',
      insertText: "- sql: \"${1:{CUBE}.status = 'active'}\"\n  label: ${2:Ativo}",
      detail: 'Estrutura de uma condição com sql e label',
      kind: 'snippet',
      sortText: '0000',
    },
  ] satisfies CompletionDefinition[],
  whenItemProperties: [
    {
      label: 'sql',
      insertText: 'sql: ',
      detail: 'Expressão SQL da condição',
      kind: 'property',
    },
    {
      label: 'label',
      insertText: 'label: ',
      detail: 'Resultado da condição',
      kind: 'property',
    },
  ] satisfies CompletionDefinition[],
  elseValue: [
    {
      label: 'Adicionar resultado padrão',
      insertText: '\n  label: ${1:Outro}',
      detail: 'Resultado usado quando nenhuma condição for atendida',
      kind: 'snippet',
      sortText: '0000',
    },
  ] satisfies CompletionDefinition[],
  elseProperties: [
    {
      label: 'label',
      insertText: 'label: ',
      detail: 'Resultado do caso padrão',
      kind: 'property',
    },
  ] satisfies CompletionDefinition[],
};

function completionKind(monaco: typeof Monaco, kind: CompletionDefinition['kind']) {
  return kind === 'snippet'
    ? monaco.languages.CompletionItemKind.Snippet
    : monaco.languages.CompletionItemKind.Property;
}

export function toMonacoCompletionItems(
  monaco: typeof Monaco,
  range: Monaco.IRange,
  definitions: CompletionDefinition[],
): Monaco.languages.CompletionItem[] {
  return definitions.map((definition) => ({
    label: definition.label,
    kind: completionKind(monaco, definition.kind),
    insertText: definition.insertText,
    ...(definition.kind === 'snippet'
      ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      : {}),
    detail: definition.detail,
    documentation: definition.detail,
    ...(definition.sortText ? { sortText: definition.sortText } : {}),
    range,
  }));
}
