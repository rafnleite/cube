import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import YAML from 'js-yaml';

type SchemaFormat = 'js' | 'yaml';

const JINJA_SYNTAX = /{%|%}|{{|}}/i;

function isYamlFile(fileName: string): boolean {
  return /\.(yml|yaml)$/i.test(fileName);
}

function isJavaScriptFile(fileName: string): boolean {
  return /\.js$/i.test(fileName);
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-zA-Z0-9])/g, (_match, character) => character.toUpperCase());
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function jsKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function yamlReferenceToJavaScript(value: string): string {
  return value.replace(/\{([^{}\r\n]+)\}/g, (match, expression) => {
    const trimmed = String(expression).trim();
    if (/^(?:CUBE|FILTER_PARAMS|SECURITY_CONTEXT|[A-Za-z_$][A-Za-z0-9_$]*)(?:[.\[]|$)/.test(trimmed)) {
      return `\u0000CUBE_REFERENCE_${trimmed}\u0000`;
    }
    return match;
  });
}

function escapeTemplateValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\u0000CUBE_REFERENCE_([^\u0000]+)\u0000/g, '${$1}');
}

function jsString(value: string): string {
  return `\`${escapeTemplateValue(yamlReferenceToJavaScript(value))}\``;
}

function yamlValueToJavaScript(value: unknown, level: number): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return jsString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return jsString(value.toISOString());
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const indent = '  '.repeat(level);
    const childIndent = '  '.repeat(level + 1);
    return `[\n${childIndent}${value.map(item => yamlValueToJavaScript(item, level + 1)).join(`,\n${childIndent}`)}\n${indent}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '{}';
    const indent = '  '.repeat(level);
    const childIndent = '  '.repeat(level + 1);
    return `{\n${childIndent}${entries
      .map(([key, item]) => `${jsKey(snakeToCamel(key))}: ${yamlValueToJavaScript(item, level + 1)}`)
      .join(`,\n${childIndent}`)}\n${indent}}`;
  }
  throw new Error(`Valor YAML não suportado: ${String(value)}`);
}

function convertYamlToJavaScript(content: string): string {
  if (JINJA_SYNTAX.test(content)) {
    throw new Error('Arquivos YAML com Jinja não podem ser convertidos automaticamente.');
  }

  const document = YAML.load(content) as { cubes?: unknown } | null;
  if (!document || !Array.isArray(document.cubes) || !document.cubes.length) {
    throw new Error("O YAML precisa conter uma lista 'cubes' com pelo menos um cubo.");
  }

  return document.cubes.map((cube: any) => {
    if (!cube || typeof cube !== 'object' || typeof cube.name !== 'string' || !cube.name) {
      throw new Error('Cada item de cubes precisa ter um nome válido.');
    }
    const { name, ...definition } = cube;
    return `cube(${jsString(name)}, ${yamlValueToJavaScript(definition, 0)});`;
  }).join('\n\n') + '\n';
}

function jsStringValue(node: any): string | null {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? '';
  }
  return null;
}

function jsTemplateValue(node: any): string {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type !== 'TemplateLiteral') {
    throw new Error('A conversão aceita apenas strings e template strings no modelo JavaScript.');
  }

  let value = '';
  node.quasis.forEach((quasi: any, index: number) => {
    value += quasi.value.cooked ?? quasi.value.raw ?? '';
    if (node.expressions[index]) {
      value += `\u0000CUBE_REFERENCE_${generate(node.expressions[index], { concise: true }).code}\u0000`;
    }
  });
  return value
    .replace(/\u0000CUBE_REFERENCE_([^\u0000]+)\u0000/g, '{$1}')
    .replace(/\$\{([^{}]+)\}/g, '{$1}');
}

function jsObjectKey(node: any): string {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'StringLiteral' || node?.type === 'NumericLiteral') return String(node.value);
  throw new Error('A conversão encontrou uma chave dinâmica no modelo JavaScript.');
}

function jsAstToYamlValue(node: any): unknown {
  switch (node?.type) {
    case 'StringLiteral':
      return jsTemplateValue(node).replace(/\$\{([^{}]+)\}/g, '{$1}');
    case 'TemplateLiteral':
      return jsTemplateValue(node);
    case 'NumericLiteral':
      return node.value;
    case 'BooleanLiteral':
      return node.value;
    case 'NullLiteral':
      return null;
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument?.type === 'NumericLiteral') return -node.argument.value;
      break;
    case 'ArrayExpression':
      return node.elements.map((item: any) => jsAstToYamlValue(item));
    case 'ObjectExpression': {
      const result: Record<string, unknown> = {};
      node.properties.forEach((property: any) => {
        if (property.type !== 'ObjectProperty' || property.computed) {
          throw new Error('A conversão não suporta propriedades dinâmicas ou métodos no modelo JavaScript.');
        }
        const key = camelToSnake(jsObjectKey(property.key));
        const value = jsAstToYamlValue(property.value);
        const arraySections = new Set(['joins', 'dimensions', 'measures', 'segments', 'hierarchies', 'pre_aggregations']);
        if (arraySections.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
          result[key] = Object.entries(value as Record<string, unknown>).map(([name, definition]) => (
            definition && typeof definition === 'object' && !Array.isArray(definition)
              ? { name, ...(definition as Record<string, unknown>) }
              : { name, value: definition }
          ));
        } else {
          result[key] = value;
        }
      });
      return result;
    }
    case 'Identifier':
      if (node.name === 'undefined') return null;
      break;
    default:
      break;
  }

  throw new Error('A conversão encontrou uma expressão JavaScript que não pode ser representada em YAML.');
}

function convertJavaScriptToYaml(content: string): string {
  const ast = parse(content, {
    sourceType: 'unambiguous',
    plugins: ['objectRestSpread'],
  });
  const cubes: Array<Record<string, unknown>> = [];

  traverse(ast, {
    CallExpression(path) {
      if (path.node.callee.type !== 'Identifier' || path.node.callee.name !== 'cube') return;
      const name = jsStringValue(path.node.arguments[0]);
      const definition = path.node.arguments[1];
      if (!name || definition?.type !== 'ObjectExpression') {
        throw new Error("Cada chamada cube precisa ter um nome estático e um objeto de definição.");
      }
      cubes.push({ name, ...(jsAstToYamlValue(definition) as Record<string, unknown>) });
    },
  });

  if (!cubes.length) {
    throw new Error('Não foi encontrada nenhuma chamada cube(...) no arquivo JavaScript.');
  }

  return YAML.dump({ cubes }, { lineWidth: -1, noRefs: true, sortKeys: false });
}

export function convertSchemaContent(content: string, sourceFormat: SchemaFormat, targetFormat: SchemaFormat): string {
  if (sourceFormat === targetFormat) return content;
  return sourceFormat === 'yaml'
    ? convertYamlToJavaScript(content)
    : convertJavaScriptToYaml(content);
}

export function schemaFormatFromFileName(fileName: string): SchemaFormat | null {
  if (isYamlFile(fileName)) return 'yaml';
  if (isJavaScriptFile(fileName)) return 'js';
  return null;
}
