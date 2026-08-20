import React, { useEffect, useMemo, useRef, useState } from 'react';
import MonacoEditor, { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { Button, Checkbox, Input, Modal, Typography } from 'antd';
import { dump, load } from 'js-yaml';
import styled from 'styled-components';
import {
  ApartmentOutlined,
  PlusOutlined,
  TrashOutlined,
} from '../../shared/icons/FontAwesomeIcons';
import { TableColumn, TablesSchema } from './cubeSchemaUtils';
import { SqlExpressionAutocomplete } from './SqlExpressionAutocomplete';
import {
  CASE_AUTOCOMPLETE,
  CompletionDefinition,
  toMonacoCompletionItems,
} from './autocomplete/autocompleteDefinitions';

const { Text } = Typography;

type CaseMode = 'dimension' | 'measure';
type CaseValue = Record<string, any>;
type ResultDraft = { value: string };

type DimensionCondition = {
  sql: string;
  result: ResultDraft;
};

type DimensionDraft = {
  conditions: DimensionCondition[];
  elseResult: ResultDraft;
  hasElse: boolean;
};

type MeasureCondition = {
  value: string;
  sql: string;
};

type MeasureDraft = {
  switchSql: string;
  conditions: MeasureCondition[];
  elseSql: string;
};

type CaseEditorProps = {
  value?: any;
  onChange: (value: any) => void;
  mode: CaseMode;
  columns?: TableColumn[];
  tablesSchema?: TablesSchema;
};

type CaseBuilderModalProps = {
  visible: boolean;
  mode: CaseMode;
  value: CaseValue;
  columns: TableColumn[];
  tablesSchema: TablesSchema;
  onCancel: () => void;
  onSave: (value: CaseValue) => void;
};

const EditorFrame = styled.div`
  position: relative;
  width: 100%;
  min-height: 40px;
  overflow: visible;
  background: #fff;

  .monaco-editor,
  .overflow-guard {
    border-radius: 0;
  }

  .monaco-editor .suggest-widget,
  .monaco-editor .suggest-details {
    z-index: 3000 !important;
  }
`;

const EditorAction = styled(Button)`
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 7px;
  color: rgba(0, 0, 0, 0.55);
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #d9d9d9;

  &:hover,
  &:focus {
    color: #7568d8;
    border-color: #7568d8;
    background: #fff;
  }
`;

const CaseError = styled.div`
  padding: 4px 8px 6px;
  color: #cf1322;
  font-size: 12px;
  line-height: 16px;
  background: #fff2f0;
  border-top: 1px solid #ffccc7;
`;

const BuilderContent = styled.div`
  max-height: 65vh;
  overflow-y: auto;
  padding: 2px;
`;

const ConditionCard = styled.div`
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid #e5e5e5;
  border-radius: 4px;
  background: #fafafa;
`;

const ConditionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
`;

const FieldBlock = styled.div`
  margin-bottom: 10px;

  &:last-child {
    margin-bottom: 0;
  }
`;

const FieldLabel = styled.div`
  margin-bottom: 4px;
  color: rgba(0, 0, 0, 0.65);
  font-size: 12px;
`;

const ResultRow = styled.div`
  display: flex;
  gap: 8px;
  align-items: stretch;

  & > .ant-select {
    flex: 0 0 150px;
  }

  & > .ant-input,
  & > .case-sql-editor {
    flex: 1 1 auto;
    min-width: 0;
  }
`;

let editorId = 0;
const CASE_EDITOR_MIN_HEIGHT = 40;
const CASE_EDITOR_MAX_HEIGHT = 240;
const caseEditorModels = new Set<string>();
let caseYamlCompletionProvider: Monaco.IDisposable | null = null;

function nextEditorPath() {
  editorId += 1;
  return `inmemory://cube-case/${editorId}.yaml`;
}

function caseCompletionRange(model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
}

function lineIndent(line: string): number {
  return line.match(/^\s*/)?.[0].length || 0;
}

function caseCompletionContext(model: Monaco.editor.ITextModel, position: Monaco.Position) {
  const line = model.getLineContent(position.lineNumber);
  const linePrefix = line.slice(0, position.column - 1);
  const lines = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  }).split('\n');

  let whenLine = -1;
  let whenIndent = -1;
  let elseLine = -1;
  let elseIndent = -1;
  lines.slice(0, -1).forEach((sourceLine, index) => {
    const whenMatch = sourceLine.match(/^(\s*)when:\s*$/);
    const elseMatch = sourceLine.match(/^(\s*)else:\s*$/);
    if (whenMatch) {
      whenLine = index;
      whenIndent = whenMatch[1].length;
    }
    if (elseMatch) {
      elseLine = index;
      elseIndent = elseMatch[1].length;
    }
  });

  const inWhen = whenLine > elseLine && whenLine >= 0 && lineIndent(linePrefix) > whenIndent;
  const inElse = elseLine > whenLine && elseLine >= 0 && lineIndent(linePrefix) > elseIndent;
  const previousLine = lines.length > 1 ? lines[lines.length - 2] : '';
  const previousTrimmed = previousLine.trim();
  const previousIndent = lineIndent(previousLine);
  // A case key can be completed while its name is being typed. A colon marks
  // the transition to a value, so only lines before that colon are considered
  // key positions.
  const isKeyPosition = !linePrefix.includes(':');
  const isAfterWhen = previousTrimmed === 'when:';
  const isAfterElse = previousTrimmed === 'else:';
  const isInsideWhenItem = inWhen && /^\s*-\s+/.test(previousLine)
    && previousIndent === whenIndent + 2;

  return {
    linePrefix,
    isKeyPosition,
    inWhen,
    inElse,
    isAfterWhen,
    isAfterElse,
    isInsideWhenItem,
    isRoot: !inWhen && !inElse && lineIndent(linePrefix) === 0,
  };
}

function caseBlockIndent(model: Monaco.editor.ITextModel, position: Monaco.Position): number | null {
  if (model.uri.toString().startsWith('inmemory://cube-case/')) {
    return -1;
  }

  if (!model.uri.toString().startsWith('inmemory://cube-schema/')) {
    return null;
  }

  const lines = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  }).split('\n');

  let activeIndent: number | null = null;
  lines.forEach((sourceLine) => {
    const trimmed = sourceLine.trim();
    if (!trimmed) return;

    const indent = lineIndent(sourceLine);
    if (/^case:\s*$/.test(trimmed)) {
      activeIndent = indent;
      return;
    }

    if (activeIndent !== null && indent <= activeIndent) {
      activeIndent = null;
    }
  });

  return activeIndent;
}

function registerLegacyCaseYamlCompletionProvider(monaco: typeof Monaco) {
  if (caseYamlCompletionProvider) return;

  const keySuggestion = (
    label: string,
    range: Monaco.IRange,
    detail = 'Propriedade do case',
  ): Monaco.languages.CompletionItem => ({
    label,
    kind: monaco.languages.CompletionItemKind.Property,
    insertText: `${label}: `,
    detail,
    range,
  });

  const snippetSuggestion = (
    label: string,
    insertText: string,
    range: Monaco.IRange,
    detail: string,
    sortText = '1000',
  ): Monaco.languages.CompletionItem => ({
    label,
    kind: monaco.languages.CompletionItemKind.Snippet,
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    detail,
    sortText,
    range,
  });

  caseYamlCompletionProvider = monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [':', '-', ' '],
    provideCompletionItems: (model, position) => {
      if (!caseEditorModels.has(model.uri.toString())) {
        return { suggestions: [] };
      }

      const context = caseCompletionContext(model, position);
      const range = caseCompletionRange(model, position);
      const suggestions: Monaco.languages.CompletionItem[] = [];
      const trimmedPrefix = context.linePrefix.trim();

      if (trimmedPrefix === 'when:') {
        suggestions.push(
          snippetSuggestion(
            'Adicionar condição',
            "\n  - sql: \"${1:{CUBE}.status = 'active'}\"\n    label: ${2:Ativo}",
            range,
            'Condição SQL e resultado do case',
            '0000',
          ),
        );
      } else if (trimmedPrefix === 'else:') {
        suggestions.push(
          snippetSuggestion(
            'Adicionar resultado padrão',
            '\n  label: ${1:Outro}',
            range,
            'Resultado usado quando nenhuma condição for atendida',
            '0000',
          ),
        );
      }

      if (!suggestions.length && context.isRoot && context.isKeyPosition) {
        suggestions.push(
          snippetSuggestion(
            'Case completo (1 when)',
            'when:\n  - sql: "${1:{CUBE}.status = \'active\'}"\n    label: ${2:Ativo}\nelse:\n  label: ${3:Outro}',
            range,
            'Estrutura completa com when, sql, label e else',
            '0000',
          ),
          keySuggestion('when', range),
          snippetSuggestion(
            'else com label',
            'else:\n  label: ${1:Outro}',
            range,
            'Estrutura do caso padrão',
          ),
          keySuggestion('else', range),
        );
      } else if (context.inWhen && context.isKeyPosition) {
        if (context.isAfterWhen || /^\s*-\s*$/.test(context.linePrefix)) {
          suggestions.push(
            snippetSuggestion(
              'Adicionar condição (when)',
              '- sql: "${1:{CUBE}.status = \'active\'}"\n  label: ${2:Ativo}',
              range,
              'Estrutura de uma condição com sql e label',
              '0000',
            ),
          );
        }

        if (context.isInsideWhenItem) {
          suggestions.push(
            keySuggestion('sql', range, 'Expressão SQL da condição'),
            keySuggestion('label', range, 'Resultado da condição'),
          );
        }
      } else if (context.inElse && context.isKeyPosition) {
        if (context.isAfterElse) {
          suggestions.push(keySuggestion('label', range, 'Resultado do caso padrão'));
        }
      }

      return { suggestions };
    },
  });
}

export function registerCaseYamlCompletionProvider(monaco: typeof Monaco) {
  if (caseYamlCompletionProvider) return;

  caseYamlCompletionProvider = monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [':', '-', ' '],
    provideCompletionItems: (model, position) => {
      const caseIndent = caseBlockIndent(model, position);
      if (caseIndent === null) {
        return { suggestions: [] };
      }

      const context = caseCompletionContext(model, position);
      const range = caseCompletionRange(model, position);
      const trimmedPrefix = context.linePrefix.trim();
      let definitions: CompletionDefinition[] = [];
      const isCaseRoot = caseIndent >= 0
        && !context.inWhen
        && !context.inElse
        && lineIndent(context.linePrefix) > caseIndent;

      if (trimmedPrefix === 'when:') {
        definitions = CASE_AUTOCOMPLETE.whenValue;
      } else if (trimmedPrefix === 'else:') {
        definitions = CASE_AUTOCOMPLETE.elseValue;
      } else if ((context.isRoot || isCaseRoot) && context.isKeyPosition) {
        definitions = CASE_AUTOCOMPLETE.root;
      } else if (context.inWhen && context.isKeyPosition) {
        if (context.isAfterWhen || /^\s*-\s*$/.test(context.linePrefix)) {
          definitions = CASE_AUTOCOMPLETE.whenItemStart;
        } else if (context.isInsideWhenItem) {
          definitions = CASE_AUTOCOMPLETE.whenItemProperties;
        }
      } else if (context.inElse && context.isKeyPosition && context.isAfterElse) {
        definitions = CASE_AUTOCOMPLETE.elseProperties;
      }

      return { suggestions: toMonacoCompletionItems(monaco, range, definitions) };
    },
  });
}

function serializeCase(value: any): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  return dump(value, { lineWidth: -1, noRefs: true, sortKeys: false }).trim();
}

function parseCase(text: string): CaseValue {
  const parsed = load(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('O conteúdo precisa ser um objeto YAML de case.');
  }
  return parsed as CaseValue;
}

function containsNull(value: any): boolean {
  if (value === null) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(containsNull);
  }

  if (value && typeof value === 'object') {
    return Object.values(value).some(containsNull);
  }

  return false;
}

function resultDraft(value: any): ResultDraft {
  return { value: value === undefined || value === null ? '' : String(value) };
}

function resultValue(value: ResultDraft): any {
  const text = value.value.trim();
  if (!text) return undefined;
  return text;
}

function dimensionDraft(value: CaseValue): DimensionDraft {
  const conditions = Array.isArray(value.when) && value.when.length
    ? value.when.map((item: any) => ({
      sql: typeof item?.sql === 'string' ? item.sql : '',
      result: resultDraft(item?.label),
    }))
    : [{ sql: '', result: { value: '' } }];
  const hasElse = Boolean(value.else);
  return {
    conditions,
    elseResult: resultDraft(value.else?.label),
    hasElse,
  };
}

function measureDraft(value: CaseValue): MeasureDraft {
  const conditions = Array.isArray(value.when) && value.when.length
    ? value.when.map((item: any) => ({
      value: item?.value === undefined || item?.value === null ? '' : String(item.value),
      sql: typeof item?.sql === 'string' ? item.sql : '',
    }))
    : [{ value: '', sql: '' }];
  return {
    switchSql: typeof value.switch === 'string' ? value.switch : '',
    conditions,
    elseSql: typeof value.else?.sql === 'string' ? value.else.sql : '',
  };
}

function SqlEditor({
  value,
  onChange,
  columns,
  tablesSchema,
  multiline = false,
}: {
  value: string;
  onChange: (value: string) => void;
  columns: TableColumn[];
  tablesSchema: TablesSchema;
  multiline?: boolean;
}) {
  return (
    <div className="case-sql-editor">
      <SqlExpressionAutocomplete
        value={value}
        onChange={onChange}
        columns={columns}
        tablesSchema={tablesSchema}
        multiline={multiline}
      />
    </div>
  );
}

function ResultControl({
  value,
  onChange,
}: {
  value: ResultDraft;
  onChange: (value: ResultDraft) => void;
}) {
  return (
    <ResultRow>
      <Input
        value={value.value}
        placeholder="Rótulo retornado"
        onChange={(event) => onChange({ value: event.target.value })}
      />
    </ResultRow>
  );
}

function CaseBuilderModal({
  visible,
  mode,
  value,
  columns,
  tablesSchema,
  onCancel,
  onSave,
}: CaseBuilderModalProps) {
  const [dimension, setDimension] = useState<DimensionDraft>(() => dimensionDraft(value));
  const [measure, setMeasure] = useState<MeasureDraft>(() => measureDraft(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDimension(dimensionDraft(value));
    setMeasure(measureDraft(value));
    setError(null);
  }, [value, visible]);

  function saveDimension() {
    if (dimension.conditions.some((condition) => !condition.sql.trim() || !condition.result.value.trim())) {
      setError('Cada condição precisa informar o SQL e o resultado.');
      return;
    }

    const next: CaseValue = {
      when: dimension.conditions.map((condition) => ({
        sql: condition.sql.trim(),
        label: resultValue(condition.result),
      })),
    };
    const elseValue = dimension.hasElse ? resultValue(dimension.elseResult) : undefined;
    if (dimension.hasElse && elseValue !== undefined) {
      next.else = { label: elseValue };
    }
    onSave(next);
  }

  function saveMeasure() {
    if (!measure.switchSql.trim()) {
      setError('Informe a dimensão usada no campo switch.');
      return;
    }
    if (measure.conditions.some((condition) => !condition.value.trim() || !condition.sql.trim())) {
      setError('Cada condição precisa informar o valor e o SQL.');
      return;
    }
    if (!measure.elseSql.trim()) {
      setError('Informe o SQL do caso Senão.');
      return;
    }

    onSave({
      switch: measure.switchSql.trim(),
      when: measure.conditions.map((condition) => ({
        value: condition.value.trim(),
        sql: condition.sql.trim(),
      })),
      else: { sql: measure.elseSql.trim() },
    });
  }

  function save() {
    setError(null);
    if (mode === 'dimension') saveDimension();
    else saveMeasure();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    }
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <Modal
      visible={visible}
      title={mode === 'dimension' ? 'Editor visual do case da dimensão' : 'Editor visual do case da medida'}
      onCancel={onCancel}
      className="case-builder-modal"
      width={820}
      maskClosable={false}
      keyboard={false}
      footer={[
        <Button key="cancel" onClick={onCancel}>Cancelar</Button>,
        <Button key="save" type="primary" onClick={save}>Salvar</Button>,
      ]}
    >
      <div onKeyDownCapture={handleKeyDown}>
        <BuilderContent>
          {mode === 'dimension' ? (
            <>
              <Text type="secondary">Cada condição devolve um rótulo para a dimensão.</Text>
              <div style={{ marginTop: 12 }}>
                {dimension.conditions.map((condition, index) => (
                  <ConditionCard key={`dimension-condition-${index}`}>
                    <ConditionHeader>
                      <Text strong>Quando {index + 1}</Text>
                      <Button
                        type="text"
                        danger
                        icon={<TrashOutlined />}
                        disabled={dimension.conditions.length === 1}
                        onClick={() => setDimension({
                          ...dimension,
                          conditions: dimension.conditions.filter((_, itemIndex) => itemIndex !== index),
                        })}
                      >
                        Remover
                      </Button>
                    </ConditionHeader>
                    <FieldBlock>
                      <FieldLabel>Condição SQL</FieldLabel>
                      <SqlEditor
                        value={condition.sql}
                        onChange={(sql) => setDimension({
                          ...dimension,
                          conditions: dimension.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, sql } : item),
                        })}
                        columns={columns}
                        tablesSchema={tablesSchema}
                        multiline
                      />
                    </FieldBlock>
                    <FieldBlock>
                      <FieldLabel>Então — rótulo fixo</FieldLabel>
                      <ResultControl
                        value={condition.result}
                        onChange={(result) => setDimension({
                          ...dimension,
                          conditions: dimension.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, result } : item),
                        })}
                      />
                    </FieldBlock>
                  </ConditionCard>
                ))}
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => setDimension({
                    ...dimension,
                    conditions: [...dimension.conditions, { sql: '', result: { value: '' } }],
                  })}
                >
                  Adicionar condição
                </Button>
              </div>
              <ConditionCard style={{ marginTop: 16 }}>
                <ConditionHeader>
                  <Text strong>Senão</Text>
                  <Checkbox
                    checked={dimension.hasElse}
                    onChange={(event) => setDimension({ ...dimension, hasElse: event.target.checked })}
                  >
                    Usar caso padrão
                  </Checkbox>
                </ConditionHeader>
                {dimension.hasElse ? (
                  <ResultControl
                    value={dimension.elseResult}
                    onChange={(elseResult) => setDimension({ ...dimension, elseResult })}
                  />
                ) : <Text type="secondary">Nenhum resultado padrão será gerado.</Text>}
              </ConditionCard>
            </>
          ) : (
            <>
              <Text type="secondary">O case da medida escolhe um SQL de acordo com uma dimensão switch.</Text>
              <FieldBlock style={{ marginTop: 12 }}>
                <FieldLabel>Dimensão switch</FieldLabel>
                <SqlEditor
                  value={measure.switchSql}
                  onChange={(switchSql) => setMeasure({ ...measure, switchSql })}
                  columns={columns}
                  tablesSchema={tablesSchema}
                />
              </FieldBlock>
              <div style={{ marginTop: 16 }}>
                {measure.conditions.map((condition, index) => (
                  <ConditionCard key={`measure-condition-${index}`}>
                    <ConditionHeader>
                      <Text strong>Quando {index + 1}</Text>
                      <Button
                        type="text"
                        danger
                        icon={<TrashOutlined />}
                        disabled={measure.conditions.length === 1}
                        onClick={() => setMeasure({
                          ...measure,
                          conditions: measure.conditions.filter((_, itemIndex) => itemIndex !== index),
                        })}
                      >
                        Remover
                      </Button>
                    </ConditionHeader>
                    <FieldBlock>
                      <FieldLabel>Valor da dimensão</FieldLabel>
                      <Input
                        value={condition.value}
                        placeholder="Ex.: EUR"
                        onChange={(event) => setMeasure({
                          ...measure,
                          conditions: measure.conditions.map((item, itemIndex) => itemIndex === index
                            ? { ...item, value: event.target.value }
                            : item),
                        })}
                      />
                    </FieldBlock>
                    <FieldBlock>
                      <FieldLabel>SQL retornado</FieldLabel>
                      <SqlEditor
                        value={condition.sql}
                        onChange={(sql) => setMeasure({
                          ...measure,
                          conditions: measure.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, sql } : item),
                        })}
                        columns={columns}
                        tablesSchema={tablesSchema}
                        multiline
                      />
                    </FieldBlock>
                  </ConditionCard>
                ))}
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => setMeasure({
                    ...measure,
                    conditions: [...measure.conditions, { value: '', sql: '' }],
                  })}
                >
                  Adicionar condição
                </Button>
              </div>
              <ConditionCard style={{ marginTop: 16 }}>
                <FieldLabel>Senão — SQL retornado</FieldLabel>
                <SqlEditor
                  value={measure.elseSql}
                  onChange={(elseSql) => setMeasure({ ...measure, elseSql })}
                  columns={columns}
                  tablesSchema={tablesSchema}
                  multiline
                />
              </ConditionCard>
            </>
          )}
          {error ? <CaseError>{error}</CaseError> : null}
        </BuilderContent>
      </div>
    </Modal>
  );
}

export function CaseEditor({
  value,
  onChange,
  mode,
  columns = [],
  tablesSchema = {},
}: CaseEditorProps) {
  const path = useMemo(nextEditorPath, []);
  const [text, setText] = useState(() => serializeCase(value));
  const [parseError, setParseError] = useState<string | null>(null);
  const [builderVisible, setBuilderVisible] = useState(false);
  const [builderValue, setBuilderValue] = useState<CaseValue>({});
  const [editorHeight, setEditorHeight] = useState(CASE_EDITOR_MIN_HEIGHT);
  const localEditRef = useRef(false);

  useEffect(() => {
    if (localEditRef.current) {
      localEditRef.current = false;
      return;
    }

    const nextText = serializeCase(value);
    setText(previous => (previous === nextText ? previous : nextText));
  }, [value]);

  function updateText(nextText: string) {
    setText(nextText);
    localEditRef.current = true;
    if (!nextText.trim()) {
      setParseError(null);
      onChange(undefined);
      return;
    }

    try {
      const parsed = parseCase(nextText);

      // Enquanto o usuário ainda está completando um mapeamento YAML, uma
      // chave sem valor (por exemplo, `when:`) é interpretada como null.
      // Preserve o rascunho para que o Monaco não o substitua por `null`.
      if (containsNull(parsed)) {
        setParseError(null);
        onChange(nextText);
        return;
      }

      setParseError(null);
      onChange(parsed);
    } catch (error: any) {
      setParseError(error?.message || 'YAML inválido.');
      // Keep the draft visible so the outer form can block saving instead of
      // silently reverting to the last valid case.
      onChange(nextText);
    }
  }

  function openBuilder() {
    try {
      const parsed = text.trim() ? parseCase(text) : {};
      setBuilderValue(parsed);
      setBuilderVisible(true);
    } catch (error: any) {
      setParseError(`Corrija o YAML antes de abrir o editor visual: ${error?.message || error}`);
    }
  }

  function saveBuilder(nextValue: CaseValue) {
    const nextText = serializeCase(nextValue);
    setText(nextText);
    setParseError(null);
    localEditRef.current = true;
    onChange(nextValue);
    setBuilderVisible(false);
  }

  const onMount: OnMount = (editor, monaco) => {
    const model = editor.getModel();
    if (!model) return;

    const modelPath = model.uri.toString();
    caseEditorModels.add(modelPath);
    registerCaseYamlCompletionProvider(monaco);

    const updateEditorHeight = () => {
      const contentHeight = editor.getContentHeight();
      setEditorHeight(Math.min(
        CASE_EDITOR_MAX_HEIGHT,
        Math.max(CASE_EDITOR_MIN_HEIGHT, contentHeight),
      ));
    };
    const contentSizeListener = editor.onDidContentSizeChange(updateEditorHeight);
    updateEditorHeight();
    requestAnimationFrame(updateEditorHeight);

    const languageConfig = monaco.languages.setLanguageConfiguration('yaml', {
      onEnterRules: [
        {
          beforeText: /:\s*$/,
          action: { indentAction: monaco.languages.IndentAction.Indent },
        },
        {
          beforeText: /^\s*-\s+\S.*$/,
          action: { indentAction: monaco.languages.IndentAction.Indent },
        },
      ],
    });

    editor.onDidDispose(() => {
      languageConfig.dispose();
      contentSizeListener.dispose();
    });
  };

  return (
    <>
      <EditorFrame>
        <EditorAction
          type="text"
          size="small"
          icon={<ApartmentOutlined />}
          title="Abrir editor visual do case"
          aria-label="Abrir editor visual do case"
          onClick={openBuilder}
        >
          Editor visual
        </EditorAction>
        <MonacoEditor
          path={path}
          language="yaml"
          theme="vs"
          value={text}
          onMount={onMount}
          onChange={(nextValue) => updateText(nextValue || '')}
          height={editorHeight}
          options={{
            automaticLayout: true,
            fixedOverflowWidgets: true,
            minimap: { enabled: false },
            lineNumbers: 'off',
            glyphMargin: false,
            folding: true,
            overviewRulerLanes: 0,
            lineDecorationsWidth: 4,
            padding: { top: 8, bottom: 8 },
            tabSize: 2,
            insertSpaces: true,
            detectIndentation: false,
            formatOnPaste: false,
            formatOnType: false,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderLineHighlight: 'none',
            scrollbar: {
              vertical: 'auto',
              horizontal: 'hidden',
              alwaysConsumeMouseWheel: false,
            },
          }}
        />
        {parseError ? <CaseError>{parseError}</CaseError> : null}
      </EditorFrame>
      <CaseBuilderModal
        visible={builderVisible}
        mode={mode}
        value={builderValue}
        columns={columns}
        tablesSchema={tablesSchema}
        onCancel={() => setBuilderVisible(false)}
        onSave={saveBuilder}
      />
    </>
  );
}
