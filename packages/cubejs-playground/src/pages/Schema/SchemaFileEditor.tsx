import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import MonacoEditor, { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import autocompleteConfig from '../../config/schema-autocomplete.json';
import { TablesSchema, resolveColumnsForTable, TableColumn } from './cubeSchemaUtils';

const SQL_COLUMN_SECTIONS = new Set(['dimensions', 'measures', 'segments']);

/** Resolves the current cube's table columns from its `sql_table` value. */
function resolveCubeColumns(model: Monaco.editor.ITextModel, tablesSchema?: TablesSchema): TableColumn[] {
  const match = model.getValue().match(/^\s*sql_table:\s*(.+?)\s*$/m);
  return resolveColumnsForTable(match?.[1], tablesSchema);
}

const CUBE_YAML_SNIPPETS = [
  {
    label: 'cube',
    insertText: 'cubes:\n  - name: ${1:orders}\n    sql_table: ${2:public.orders}\n\n    dimensions:\n      - name: ${3:id}\n        sql: ${4:id}\n        type: ${5:number}\n        primary_key: true\n\n    measures:\n      - name: ${6:count}\n        type: count\n',
    detail: 'Cube YAML skeleton'
  },
  {
    label: 'dimension',
    insertText: '- name: ${1:created_at}\n  sql: ${2:created_at}\n  type: ${3:time}\n',
    detail: 'Dimension'
  },
  {
    label: 'measure',
    insertText: '- name: ${1:total_amount}\n  sql: ${2:amount}\n  type: ${3:sum}\n',
    detail: 'Measure'
  },
  {
    label: 'join',
    insertText: '- name: ${1:customers}\n  relationship: ${2:many_to_one}\n  sql: ${3:${CUBE}.customer_id} = ${4:${customers}.id}\n',
    detail: 'Join'
  },
  {
    label: 'pre_aggregations',
    insertText: 'pre_aggregations:\n  - name: ${1:main}\n    measures:\n      - ${2:CUBE.count}\n    dimensions:\n      - ${3:CUBE.status}\n    time_dimension: ${4:CUBE.created_at}\n    granularity: ${5:day}\n',
    detail: 'Pre-aggregation'
  }
];

const CUBE_JS_SNIPPETS = [
  {
    label: 'cube',
    insertText: "cube('${1:Orders}', {\n  sql: `SELECT * FROM public.orders`,\n\n  measures: {\n    count: {\n      type: 'count'\n    }\n  },\n\n  dimensions: {\n    id: {\n      sql: 'id',\n      type: 'number',\n      primaryKey: true\n    },\n    createdAt: {\n      sql: 'created_at',\n      type: 'time'\n    }\n  }\n});\n",
    detail: 'Cube JS skeleton'
  },
  {
    label: 'dimension',
    insertText: "${1:name}: {\n  sql: '${2:column_name}',\n  type: '${3:string}'\n}",
    detail: 'Dimension'
  },
  {
    label: 'measure',
    insertText: "${1:totalAmount}: {\n  sql: '${2:amount}',\n  type: '${3:sum}'\n}",
    detail: 'Measure'
  },
  {
    label: 'join',
    insertText: "${1:Customers}: {\n  relationship: '${2:many_to_one}',\n  sql: `${CUBE}.customer_id = ${Customers}.id`\n}",
    detail: 'Join'
  },
  {
    label: 'preAggregations',
    insertText: "preAggregations: {\n  ${1:main}: {\n    type: 'rollup',\n    measureReferences: [count],\n    dimensionReferences: [status],\n    timeDimensionReference: createdAt,\n    granularity: '${2:day}'\n  }\n}",
    detail: 'Pre-aggregation'
  }
];

type SchemaSectionConfig = {
  keys: string[];
  values?: Record<string, string[]>;
  newItemLabel?: string;
};

type SchemaAutocompleteConfig = {
  yaml: {
    enableSnippets?: boolean;
    root: { keys: string[] };
    booleanKeys: string[];
    sections: Record<string, SchemaSectionConfig>;
  };
};

const schemaAutocomplete = autocompleteConfig as SchemaAutocompleteConfig;

function indentationSize(line: string): number {
  const match = line.match(/^(\s*)/);
  return match?.[1]?.length || 0;
}

type PathEntry = { indent: number; name: string };

/**
 * Walks every completed line above the cursor and rebuilds the nesting stack
 * of open "key:" mapping sections (e.g. cubes -> joins), purely from
 * indentation. Works for any depth without hardcoding section names.
 */
function resolveSectionStack(lines: string[], cursorIndent: number): PathEntry[] {
  const stack: PathEntry[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const indent = indentationSize(line);
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const sectionMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
    if (sectionMatch) {
      stack.push({ indent, name: sectionMatch[1].toLowerCase() });
    }
  }

  while (stack.length && stack[stack.length - 1].indent >= cursorIndent) {
    stack.pop();
  }

  return stack;
}

/**
 * Collects keys already set on the current list item / mapping block so they
 * aren't suggested again, without descending into nested child sections.
 */
function usedKeysInCurrentBlock(lines: string[], sectionIndent: number): Set<string> {
  const used = new Set<string>();
  const currentIndex = lines.length - 1;
  let itemStart = -1;

  for (let i = currentIndex; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const indent = indentationSize(line);
    if (indent <= sectionIndent) {
      break;
    }

    if (/^\s*-\s?/.test(line)) {
      itemStart = i;
      break;
    }
  }

  if (itemStart < 0) {
    return used;
  }

  let propertyIndent: number | null = null;

  for (let i = itemStart; i <= currentIndex; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const indent = indentationSize(line);
    if (i !== itemStart && indent <= sectionIndent) {
      break;
    }

    const listItemMatch = trimmed.match(/^-\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    const keyMatch = listItemMatch ? null : trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    const matchedKey = listItemMatch?.[1] || keyMatch?.[1];
    if (!matchedKey) {
      continue;
    }

    const matchedIndent = listItemMatch ? indent + 2 : indent;
    if (propertyIndent === null) {
      propertyIndent = matchedIndent;
    }

    if (matchedIndent === propertyIndent) {
      used.add(matchedKey.toLowerCase());
    }
  }

  return used;
}

function currentContext(model: Monaco.editor.ITextModel, position: Monaco.Position) {
  const line = model.getLineContent(position.lineNumber);
  const linePrefix = line.slice(0, position.column - 1);
  const cursorIndent = indentationSize(line);

  const beforeCurrentLine = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const lines = beforeCurrentLine.split('\n');

  const stack = resolveSectionStack(lines, cursorIndent);
  const sectionName = stack.length ? stack[stack.length - 1].name : null;
  const sectionIndent = stack.length ? stack[stack.length - 1].indent : -1;

  return { line, linePrefix, lines, sectionName, sectionIndent };
}

function shouldAutoSuggest(model: Monaco.editor.ITextModel, position: Monaco.Position): boolean {
  const { linePrefix, sectionName } = currentContext(model, position);

  if (!sectionName) {
    return false;
  }

  return !linePrefix.trim() || /^\s*-\s*$/.test(linePrefix) || /^\s+$/.test(linePrefix);
}

/**
 * Monaco's bundled YAML onEnterRules only indent after lines ending in ":",
 * so a fresh line after "- name: x" lands aligned with "-" instead of the
 * text after it. Correct that alignment ourselves right after Enter.
 */
function fixListItemIndentation(
  editor: Monaco.editor.IStandaloneCodeEditor,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position
): Monaco.Position {
  if (position.lineNumber <= 1) {
    return position;
  }

  const currentLine = model.getLineContent(position.lineNumber);
  if (currentLine.trim().length > 0) {
    return position;
  }

  const previousLine = model.getLineContent(position.lineNumber - 1);
  const listItemMatch = previousLine.match(/^(\s*-\s+)\S/);
  if (!listItemMatch) {
    return position;
  }

  const desiredIndent = listItemMatch[1].length;
  const currentIndent = currentLine.match(/^\s*/)?.[0]?.length || 0;
  if (currentIndent === desiredIndent) {
    return position;
  }

  editor.executeEdits('cube-schema-editor', [{
    range: {
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: currentIndent + 1,
    },
    text: ' '.repeat(desiredIndent),
  }]);

  const newPosition = { lineNumber: position.lineNumber, column: desiredIndent + 1 };
  editor.setPosition(newPosition);
  return newPosition as Monaco.Position;
}

function languageFromFileName(fileName: string): 'yaml' | 'javascript' {
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith('.yml') || normalized.endsWith('.yaml')) {
    return 'yaml';
  }

  return 'javascript';
}

type Props = {
  fileName: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  tablesSchema?: TablesSchema;
};

export function SchemaFileEditor({ fileName, value, onChange, readOnly = false, tablesSchema }: Props) {
  const language = useMemo(() => languageFromFileName(fileName), [fileName]);

  // `onMount` only runs once, so the latest `tablesSchema` must be read from a
  // ref inside completion callbacks instead of the closure (see readOnly bug).
  const tablesSchemaRef = useRef(tablesSchema);
  useEffect(() => {
    tablesSchemaRef.current = tablesSchema;
  }, [tablesSchema]);

  const onMount = useCallback<OnMount>((editor, monaco) => {
    // Preserves the bundled YAML config (comments/brackets/folding) and adds the
    // missing rule to indent after a populated "- " list item line.
    const languageConfig = language === 'yaml'
      ? monaco.languages.setLanguageConfiguration('yaml', {
        comments: { lineComment: '#' },
        brackets: [['{', '}'], ['[', ']'], ['(', ')']],
        autoClosingPairs: [
          { open: '{', close: '}' },
          { open: '[', close: ']' },
          { open: '(', close: ')' },
          { open: '"', close: '"' },
          { open: "'", close: "'" },
        ],
        surroundingPairs: [
          { open: '{', close: '}' },
          { open: '[', close: ']' },
          { open: '(', close: ')' },
          { open: '"', close: '"' },
          { open: "'", close: "'" },
        ],
        folding: { offSide: true },
        onEnterRules: [
          {
            beforeText: /:\s*$/,
            action: { indentAction: monaco.languages.IndentAction.Indent }
          },
          {
            beforeText: /^\s*-\s+\S.*$/,
            action: { indentAction: monaco.languages.IndentAction.Indent }
          }
        ]
      })
      : null;

    const completionRange = (model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange => {
      const word = model.getWordUntilPosition(position);
      return {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
    };

    const toSuggestions = (
      snippets: { label: string; insertText: string; detail: string }[],
      range: Monaco.IRange
    ): Monaco.languages.CompletionItem[] => snippets.map((snippet) => ({
      label: snippet.label,
      kind: monaco.languages.CompletionItemKind.Snippet,
      insertText: snippet.insertText,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: snippet.detail,
      detail: 'Cube snippet',
      range
    }));

    const valueSuggestions = (values: string[], linePrefix: string, range: Monaco.IRange): Monaco.languages.CompletionItem[] => values.map((item) => ({
      label: item,
      kind: monaco.languages.CompletionItemKind.Value,
      insertText: linePrefix.endsWith(':') ? ` ${item}` : item,
      detail: 'Cube value',
      range
    }));

    // Keys with known values (enum or boolean) re-open the suggest list right
    // after being inserted, so the user immediately sees the value options.
    const keySuggestions = (
      keys: string[],
      range: Monaco.IRange,
      keysWithValues?: Set<string>
    ): Monaco.languages.CompletionItem[] => keys.map((item) => ({
      label: item,
      kind: monaco.languages.CompletionItemKind.Property,
      insertText: `${item}: `,
      detail: 'Cube key',
      range,
      ...(keysWithValues?.has(item.toLowerCase())
        ? { command: { id: 'editor.action.triggerSuggest', title: 'Trigger Suggest' } }
        : {})
    }));

    // Monaco auto-prepends the current line's own indentation to continuation
    // lines of a multi-line insertText, which breaks a fixed target indent
    // when the cursor line is deeper than the new item's dash. Do the edit
    // ourselves via a command instead of relying on insertText for this.
    const insertNewItemCommandId = editor.addCommand(0, (_accessor, itemIndent: number) => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) {
        return;
      }

      const lineContent = model.getLineContent(position.lineNumber);
      editor.executeEdits('cube-schema-editor', [{
        range: {
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: lineContent.length + 1,
        },
        text: `\n${' '.repeat(itemIndent)}- name: `,
      }]);

      editor.setPosition({ lineNumber: position.lineNumber + 1, column: itemIndent + '- name: '.length + 1 });
    });

    // Always offered first: starts a fresh list item on its own separator
    // line, instead of only completing the properties of the current one.
    const newItemSuggestion = (label: string, itemIndent: number, range: Monaco.IRange): Monaco.languages.CompletionItem => ({
      label,
      kind: monaco.languages.CompletionItemKind.Snippet,
      insertText: '',
      detail: 'Cube snippet',
      sortText: '0000',
      preselect: true,
      range,
      ...(insertNewItemCommandId
        ? { command: { id: insertNewItemCommandId, title: 'Insert new item', arguments: [itemIndent] } }
        : {})
    });

    const yamlProvider = monaco.languages.registerCompletionItemProvider('yaml', {
      triggerCharacters: [':', '-', ' '],
      provideCompletionItems: (model, position) => {
        const { linePrefix, lines, sectionName, sectionIndent } = currentContext(model, position);
        const range = completionRange(model, position);

        const isListRowStart = /^\s*-\s*$/.test(linePrefix);
        const isIndentedNewPropertyLine = /^\s+$/.test(linePrefix);
        const isKeyPosition = isListRowStart || isIndentedNewPropertyLine || !linePrefix.trim();
        const hasColonInLine = linePrefix.includes(':');
        const isValuePosition = hasColonInLine && /:\s*[^:]*$/.test(linePrefix);

        const suggestions: Monaco.languages.CompletionItem[] = [];

        if (isKeyPosition) {
          if (sectionName) {
            const sectionConfig = schemaAutocomplete.yaml.sections[sectionName];
            if (sectionConfig) {
              if (sectionConfig.newItemLabel) {
                const itemIndent = sectionIndent + 2;
                suggestions.push(newItemSuggestion(sectionConfig.newItemLabel, itemIndent, range));
              }

              const usedKeys = usedKeysInCurrentBlock(lines, sectionIndent);
              const availableKeys = sectionConfig.keys.filter((key) => !usedKeys.has(key.toLowerCase()));
              const keysWithValues = new Set([
                ...Object.keys(sectionConfig.values || {}),
                ...schemaAutocomplete.yaml.booleanKeys,
                ...(SQL_COLUMN_SECTIONS.has(sectionName) ? ['sql'] : []),
              ].map((key) => key.toLowerCase()));
              suggestions.push(...keySuggestions(availableKeys, range, keysWithValues));
            }
          } else {
            suggestions.push(...keySuggestions(schemaAutocomplete.yaml.root.keys, range));
            if (schemaAutocomplete.yaml.enableSnippets) {
              suggestions.push(...toSuggestions(CUBE_YAML_SNIPPETS, range));
            }
          }
        }

        if (isValuePosition) {
          const keyBeingSetMatch = linePrefix.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[^:]*$/);
          const keyBeingSet = keyBeingSetMatch?.[1]?.toLowerCase();

          if (keyBeingSet) {
            const sectionConfig = sectionName ? schemaAutocomplete.yaml.sections[sectionName] : null;
            const enumValues = sectionConfig?.values?.[keyBeingSet];

            if (enumValues) {
              suggestions.push(...valueSuggestions(enumValues, linePrefix, range));
            } else if (schemaAutocomplete.yaml.booleanKeys.includes(keyBeingSet)) {
              suggestions.push(...valueSuggestions(['true', 'false'], linePrefix, range));
            } else if (keyBeingSet === 'sql' && sectionName && SQL_COLUMN_SECTIONS.has(sectionName)) {
              const columns = resolveCubeColumns(model, tablesSchemaRef.current);
              suggestions.push(...columns.map((column) => ({
                label: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: linePrefix.endsWith(':') ? ` ${column.name}` : column.name,
                detail: column.type ? `Column · ${column.type}` : 'Column',
                range,
              })));
            }
          }
        }

        if (!suggestions.length && !sectionName && schemaAutocomplete.yaml.enableSnippets) {
          suggestions.push(...toSuggestions(CUBE_YAML_SNIPPETS, range));
        }

        return { suggestions };
      }
    });

    const jsProvider = monaco.languages.registerCompletionItemProvider('javascript', {
      provideCompletionItems: (model, position) => {
        const range = completionRange(model, position);
        return {
          suggestions: toSuggestions(CUBE_JS_SNIPPETS, range)
        };
      }
    });

    // `onDidType` fires only for interactive keystrokes and always after
    // Monaco applies auto-indentation, so it lands at the final cursor spot.
    // NOTE: `onMount` only runs once when the editor is first created (while
    // still read-only), so the `readOnly` prop must be read live from the
    // editor here instead of from the closure, which would otherwise always
    // see the stale initial value.
    const typedEditor = editor as unknown as {
      onDidType: (callback: (text: string) => void) => Monaco.IDisposable;
    };
    const typeListener = typedEditor.onDidType((text) => {
      const isReadOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
      if (isReadOnly || language !== 'yaml' || text !== '\n') {
        return;
      }

      const model = editor.getModel();
      const initialPosition = editor.getPosition();
      if (!model || !initialPosition) {
        return;
      }

      // Deferred to the next tick: `@monaco-editor/react`'s controlled `value`
      // prop round-trips through React state on every keystroke and re-syncs
      // the model afterwards, which would otherwise clobber an immediate fix.
      setTimeout(() => {
        const currentModel = editor.getModel();
        let position = editor.getPosition();
        if (!currentModel || !position) {
          return;
        }

        position = fixListItemIndentation(editor, currentModel, position);

        if (shouldAutoSuggest(currentModel, position)) {
          editor.trigger('cube-schema-editor', 'editor.action.triggerSuggest', {});
        }
      }, 0);
    });

    editor.onDidDispose(() => {
      languageConfig?.dispose();
      yamlProvider.dispose();
      jsProvider.dispose();
      typeListener.dispose();
    });
  }, [language, readOnly]);

  return (
    <MonacoEditor
      language={language}
      theme="vs"
      value={value}
      onMount={onMount}
      onChange={(nextValue) => onChange(nextValue || '')}
      options={{
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: false,
        formatOnPaste: true,
        formatOnType: true,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
        snippetSuggestions: 'top'
      }}
      height="calc(100vh - 240px)"
    />
  );
}
