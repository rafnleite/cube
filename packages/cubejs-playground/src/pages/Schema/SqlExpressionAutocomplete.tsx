import React, { useEffect, useMemo, useRef, useState } from 'react';
import MonacoEditor, { useMonaco } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import styled from 'styled-components';
import { TableColumn, TablesSchema } from './cubeSchemaUtils';

type SqlExpressionAutocompleteProps = {
  value?: string;
  onChange: (value: string) => void;
  columns?: TableColumn[];
  tablesSchema?: TablesSchema;
  multiline?: boolean;
  tableReference?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
  onFocus?: React.FocusEventHandler<HTMLDivElement>;
  onBlur?: React.FocusEventHandler<HTMLDivElement>;
};

type SqlCompletionContext = {
  columns: TableColumn[];
  tablesSchema: TablesSchema;
  tableReference: boolean;
};

const EditorFrame = styled.div`
  width: 100%;
  position: relative;
  overflow: hidden;
  resize: vertical;
  min-height: 34px;
  max-height: 420px;
  box-sizing: border-box;
  z-index: 1;
  border: 1px solid #d9d9d9;
  border-radius: 2px;
  background: #fff;
  transition: border-color 0.2s, box-shadow 0.2s;

  &:focus-within {
    border-color: #40a9ff;
    box-shadow: 0 0 0 2px rgba(24, 144, 255, 0.2);
    z-index: 1000;
  }

  .monaco-editor,
  .overflow-guard {
    border-radius: 2px;
  }

  .monaco-editor .suggest-widget,
  .monaco-editor .suggest-details {
    z-index: 2000 !important;
  }
`;

const contexts = new Map<string, SqlCompletionContext>();
let completionProvider: Monaco.IDisposable | null = null;
let editorId = 0;

function nextEditorPath() {
  editorId += 1;
  return `inmemory://cube-sql/${editorId}.sql`;
}

function completionRange(model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: position.column,
  };
}

function qualifierBeforeCursor(model: Monaco.editor.ITextModel, position: Monaco.Position) {
  return model.getLineContent(position.lineNumber)
    .slice(0, position.column - 1)
    .match(/(?:^|[\s,(])((?:\{?\$?CUBE\}?|[A-Za-z_][\w$]*))\.$/)?.[1];
}

function isCubeQualifier(value?: string) {
  return Boolean(value && /^(?:\{?\$?CUBE\}?)$/i.test(value));
}

function registerCompletionProvider(monaco: typeof Monaco) {
  if (completionProvider) return;

  completionProvider = monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', '{', '_'],
    provideCompletionItems: (model, position) => {
      const context = contexts.get(model.uri.toString());
      if (!context) return { suggestions: [] };

      const range = completionRange(model, position);
      const qualifier = qualifierBeforeCursor(model, position);
      const suggestions: Monaco.languages.CompletionItem[] = [];

      const schemaNames = Object.keys(context.tablesSchema);
      if (qualifier && context.tablesSchema[qualifier]) {
        Object.keys(context.tablesSchema[qualifier] || {}).forEach(tableName => suggestions.push({
          label: `${qualifier}.${tableName}`,
          insertText: tableName,
          filterText: tableName,
          kind: monaco.languages.CompletionItemKind.Class,
          detail: 'Tabela',
          documentation: `Tabela ${qualifier}.${tableName}`,
          range,
        }));
      } else {
        schemaNames.forEach(schemaName => {
          suggestions.push({
            label: schemaName,
            insertText: `${schemaName}.`,
            kind: monaco.languages.CompletionItemKind.Module,
            detail: 'Schema',
            command: {
              id: 'editor.action.triggerSuggest',
              title: 'Sugerir tabelas do schema',
            },
            range,
          });
        });
      }

      if (context.tableReference) return { suggestions };

      const cubeQualifier = isCubeQualifier(qualifier);
      context.columns.forEach(column => suggestions.push({
        label: cubeQualifier ? `{CUBE}.${column.name}` : column.name,
        insertText: column.name,
        kind: monaco.languages.CompletionItemKind.Field,
        detail: column.type ? `Coluna · ${column.type}` : 'Coluna',
        range,
      }));

      context.columns.forEach(column => suggestions.push({
        label: `{CUBE}.${column.name}`,
        insertText: `{CUBE}.${column.name}`,
        kind: monaco.languages.CompletionItemKind.Field,
        detail: column.type ? `Coluna · ${column.type}` : 'Coluna',
        range,
      }));

      const sqlFunctions = [
        ['COALESCE', 'COALESCE(${1:expression}, ${2:default_value})', 'Primeiro valor não nulo'],
        ['NULLIF', 'NULLIF(${1:value}, ${2:comparison})', 'Retorna NULL quando os valores forem iguais'],
        ['CONCAT', 'CONCAT(${1:value1}, ${2:value2})', 'Concatena valores'],
        ['CAST', 'CAST(${1:value} AS ${2:type})', 'Converte o tipo de um valor'],
        ['CASE WHEN', 'CASE WHEN ${1:condition} THEN ${2:value} ELSE ${3:alternative} END', 'Expressão condicional'],
        ['DATE_TRUNC', "DATE_TRUNC('${1:day}', ${2:date})", 'Trunca uma data para uma unidade'],
        ['LOWER', 'LOWER(${1:text})', 'Converte texto para minúsculas'],
        ['UPPER', 'UPPER(${1:text})', 'Converte texto para maiúsculas'],
      ];
      sqlFunctions.forEach(([label, insertText, detail]) => suggestions.push({
        label,
        insertText,
        kind: monaco.languages.CompletionItemKind.Function,
        detail: `SQL · ${detail}`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
      }));

      return { suggestions };
    },
  });
}

export function SqlExpressionAutocomplete({
  value = '',
  onChange,
  columns = [],
  tablesSchema = {},
  multiline = false,
  tableReference = false,
  placeholder,
  style,
  onFocus,
  onBlur,
}: SqlExpressionAutocompleteProps) {
  const monaco = useMonaco();
  const path = useMemo(nextEditorPath, []);
  const latestOnChange = useRef(onChange);
  const frameRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState(multiline ? 92 : 34);

  latestOnChange.current = onChange;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;

    const updateHeight = () => {
      const nextHeight = Math.round(frame.getBoundingClientRect().height);
      if (nextHeight >= 34 && nextHeight <= 420) setEditorHeight(nextHeight);
    };

    const observer = new ResizeObserver(updateHeight);
    observer.observe(frame);
    updateHeight();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setEditorHeight(multiline ? 92 : 34);
  }, [multiline]);

  useEffect(() => {
    contexts.set(path, { columns, tablesSchema, tableReference });
    return () => {
      contexts.delete(path);
    };
  }, [columns, path, tableReference, tablesSchema]);

  useEffect(() => {
    if (monaco) registerCompletionProvider(monaco);
  }, [monaco]);

  return (
    <EditorFrame
      ref={frameRef}
      style={{ ...style, height: editorHeight }}
      title={placeholder}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <MonacoEditor
        path={path}
        language="sql"
        theme="vs"
        value={value}
        onChange={(nextValue) => latestOnChange.current(nextValue || '')}
        onMount={(editor, editorMonaco) => {
          editor.onKeyDown((event) => {
            if (event.keyCode !== editorMonaco.KeyCode.Space) return;

            event.preventDefault();
            event.stopPropagation();
            editor.trigger('cube-sql-editor', 'hideSuggestWidget', {});
            editor.trigger('cube-sql-editor', 'type', { text: ' ' });
          });
        }}
        height={editorHeight}
        options={{
          automaticLayout: true,
          fixedOverflowWidgets: true,
          minimap: { enabled: false },
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          overviewRulerLanes: 0,
          lineDecorationsWidth: 8,
          lineNumbersMinChars: 0,
          padding: { top: 6, bottom: 6 },
          tabSize: 2,
          insertSpaces: true,
          detectIndentation: false,
          formatOnPaste: false,
          formatOnType: false,
          scrollBeyondLastLine: false,
          wordWrap: multiline ? 'on' : 'off',
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnCommitCharacter: false,
          snippetSuggestions: 'top',
          renderLineHighlight: 'none',
          scrollbar: {
            vertical: 'hidden',
            horizontal: 'hidden',
            alwaysConsumeMouseWheel: false,
          },
          overviewRulerBorder: false,
        }}
      />
    </EditorFrame>
  );
}
