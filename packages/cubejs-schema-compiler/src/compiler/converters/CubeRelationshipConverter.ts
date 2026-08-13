import generator from '@babel/generator';
import * as t from '@babel/types';
import { isMap, isScalar, isSeq, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

import { UserError } from '../UserError';
import type {
  AstByCubeName,
  CubeConverterInterface,
  JsSet,
  YamlSet,
} from './CubeSchemaConverter';

export type CubeRelationshipOperation = 'create' | 'update' | 'delete';

export type CubeRelationshipDefinition = {
  sourceCube: string;
  targetCube: string;
  sourceColumn?: string;
  targetColumn?: string;
  sourceColumnSql?: string;
  targetColumnSql?: string;
  relationship?: 'one_to_one' | 'one_to_many' | 'many_to_one';
  operation?: CubeRelationshipOperation;
};

export type CubeDiagramRelationship = {
  sourceCube: string;
  targetCube: string;
  sourceColumn?: string;
  targetColumn?: string;
  relationship: string;
  sql: string;
};

export type CubeDiagramMember = {
  name: string;
  title?: string;
  sql?: string;
  type?: string;
  primaryKey?: boolean;
};

export type CubeDiagramModel = {
  name: string;
  title?: string;
  fileName: string;
  fileType: 'yaml' | 'javascript';
  dataSource: string;
  sourceType: 'sql_table' | 'sql' | 'unknown';
  source?: string;
  dimensions?: CubeDiagramMember[];
  measures?: CubeDiagramMember[];
};

function jsPropertyName(property: t.ObjectMethod | t.ObjectProperty | t.SpreadElement): string | null {
  if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) {
    return null;
  }
  if (property.computed) {
    return null;
  }
  if (t.isIdentifier(property.key)) {
    return property.key.name;
  }
  if (t.isStringLiteral(property.key)) {
    return property.key.value;
  }
  return null;
}

function jsProperty(object: t.ObjectExpression, names: string[]): t.ObjectProperty | undefined {
  return object.properties.find(
    (property): property is t.ObjectProperty => t.isObjectProperty(property) && names.includes(jsPropertyName(property) || '')
  );
}

function normalizeRelationship(relationship: string): string {
  if (['belongsTo', 'belongs_to', 'manyToOne'].includes(relationship)) return 'many_to_one';
  if (['hasMany', 'has_many', 'oneToMany'].includes(relationship)) return 'one_to_many';
  if (['hasOne', 'has_one', 'oneToOne'].includes(relationship)) return 'one_to_one';
  return relationship;
}

function jsStaticString(node: t.Node | null | undefined): string | undefined {
  if (t.isStringLiteral(node)) {
    return node.value;
  }
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('');
  }
  return undefined;
}

function yamlPair(object: YAMLMap, names: string[]): Pair | undefined {
  return object.items.find(
    (item): item is Pair => isScalar(item.key) && names.includes(String(item.key.value))
  );
}

function yamlStaticString(pair: Pair | undefined): string | undefined {
  return pair && isScalar(pair.value) && pair.value.value != null
    ? String(pair.value.value)
    : undefined;
}

function jsStaticBoolean(node: t.Node | null | undefined): boolean | undefined {
  return t.isBooleanLiteral(node) ? node.value : undefined;
}

function readJsMembers(cubeDefinition: t.ObjectExpression, section: string): CubeDiagramMember[] {
  const sectionProperty = jsProperty(cubeDefinition, [section]);
  if (!sectionProperty || !t.isObjectExpression(sectionProperty.value) && !t.isArrayExpression(sectionProperty.value)) {
    return [];
  }

  const members: CubeDiagramMember[] = [];
  const readMember = (name: string | undefined, value: t.Node | null | undefined) => {
    if (!name || !t.isObjectExpression(value)) return;
    const primaryKey = jsStaticBoolean(jsProperty(value, ['primaryKey', 'primary_key'])?.value);
    members.push({
      name,
      title: jsStaticString(jsProperty(value, ['title'])?.value),
      sql: jsStaticString(jsProperty(value, ['sql'])?.value),
      type: jsStaticString(jsProperty(value, ['type'])?.value),
      ...(primaryKey === undefined ? {} : { primaryKey }),
    });
  };

  if (t.isObjectExpression(sectionProperty.value)) {
    sectionProperty.value.properties.forEach(property => {
      if (t.isObjectProperty(property)) readMember(jsPropertyName(property) || undefined, property.value);
    });
  } else {
    sectionProperty.value.elements.forEach(element => {
      if (!t.isObjectExpression(element)) return;
      readMember(jsStaticString(jsProperty(element, ['name'])?.value), element);
    });
  }
  return members;
}

function readYamlMembers(cubeDefinition: YAMLMap, section: string): CubeDiagramMember[] {
  const sectionPair = yamlPair(cubeDefinition, [section]);
  if (!sectionPair || !isSeq(sectionPair.value)) return [];

  return sectionPair.value.items.flatMap((item) => {
    if (!isMap(item)) return [];
    const primaryKeyPair = yamlPair(item, ['primary_key', 'primaryKey']);
    const primaryKey = primaryKeyPair && isScalar(primaryKeyPair.value)
      ? Boolean(primaryKeyPair.value.value)
      : undefined;
    return [{
      name: yamlStaticString(yamlPair(item, ['name'])) || '',
      title: yamlStaticString(yamlPair(item, ['title'])),
      sql: yamlStaticString(yamlPair(item, ['sql'])),
      type: yamlStaticString(yamlPair(item, ['type'])),
      ...(primaryKey === undefined ? {} : { primaryKey }),
    }].filter(member => member.name);
  });
}

function setYamlScalar(object: YAMLMap, name: string, value: string): void {
  const existing = yamlPair(object, [name]);
  if (existing && isScalar(existing.value)) {
    existing.value.value = value;
  } else {
    object.set(name, value);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseColumnIdentifier(value: string): string | undefined {
  const identifier = value.match(/^([A-Za-z_][A-Za-z0-9_$]*)$/);
  if (identifier) return identifier[1];

  const doubleQuoted = value.match(/^"((?:[^"]|"")+)"$/);
  if (doubleQuoted) return doubleQuoted[1].replace(/""/g, '"');

  const backtickQuoted = value.match(/^`((?:[^`]|``)+)`$/);
  if (backtickQuoted) return backtickQuoted[1].replace(/``/g, '`');

  const bracketQuoted = value.match(/^\[((?:[^\]]|\]\])+)]$/);
  if (bracketQuoted) return bracketQuoted[1].replace(/]]/g, ']');

  return undefined;
}

function parseColumnReference(reference: string, cubeName: string): string | undefined {
  const cube = escapeRegExp(cubeName);
  const identifier = '([A-Za-z_][A-Za-z0-9_$]*)';
  const rawReference = new RegExp(`^(?:\\{${cube}\\}|\\$\\{${cube}\\})\\.(.+)$`);
  const memberReference = new RegExp(
    `^(?:\\{${cube}\\.${identifier}\\}|\\$\\{${cube}\\.${identifier}\\})$`
  );
  const rawMatch = reference.trim().match(rawReference);

  if (rawMatch) {
    return parseColumnIdentifier(rawMatch[1].trim());
  }

  const memberMatch = reference.trim().match(memberReference);
  return memberMatch?.[1] || memberMatch?.[2];
}

function parseJoinColumns(
  sql: string,
  targetCube: string
): { sourceColumn?: string; targetColumn?: string } {
  const trimmed = sql.trim();
  const expression = trimmed.startsWith('`') && trimmed.endsWith('`')
    ? trimmed.slice(1, -1).replace(/\\`/g, '`').replace(/\\\\/g, '\\').trim()
    : trimmed;
  const equality = expression.match(/^(.+?)\s*=\s*(.+)$/);

  if (!equality) return {};

  const [, left, right] = equality;
  const leftSource = parseColumnReference(left, 'CUBE');
  const rightTarget = parseColumnReference(right, targetCube);
  if (leftSource && rightTarget) {
    return { sourceColumn: leftSource, targetColumn: rightTarget };
  }

  const leftTarget = parseColumnReference(left, targetCube);
  const rightSource = parseColumnReference(right, 'CUBE');
  if (leftTarget && rightSource) {
    return { sourceColumn: rightSource, targetColumn: leftTarget };
  }

  return {};
}

function createJoinSql(
  sourceColumn: string,
  targetCube: string,
  targetColumn: string,
  sourceColumnSql?: string,
  targetColumnSql?: string
): string {
  const source = sourceColumnSql || (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(sourceColumn)
    ? sourceColumn
    : `"${sourceColumn.replace(/"/g, '""')}"`);
  const target = targetColumnSql || (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(targetColumn)
    ? targetColumn
    : `"${targetColumn.replace(/"/g, '""')}"`);
  return `{CUBE}.${source} = {${targetCube}}.${target}`;
}

function templateRaw(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function createJoinTemplate(
  sourceColumn: string,
  targetCube: string,
  targetColumn: string,
  sourceColumnSql?: string,
  targetColumnSql?: string
): t.TemplateLiteral {
  const source = sourceColumnSql || (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(sourceColumn)
    ? sourceColumn
    : `"${sourceColumn.replace(/"/g, '""')}"`);
  const target = targetColumnSql || (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(targetColumn)
    ? targetColumn
    : `"${targetColumn.replace(/"/g, '""')}"`);
  const middle = `.${source} = `;
  const suffix = `.${target}`;
  return t.templateLiteral(
    [
      t.templateElement({ raw: '', cooked: '' }),
      t.templateElement({ raw: templateRaw(middle), cooked: middle }),
      t.templateElement({ raw: templateRaw(suffix), cooked: suffix }, true),
    ],
    [t.identifier('CUBE'), t.identifier(targetCube)]
  );
}

function setJsObjectProperty(object: t.ObjectExpression, name: string, value: t.Expression): void {
  const existing = jsProperty(object, [name]);
  if (existing) {
    t.inheritsComments(value, existing.value);
    existing.value = value;
  } else {
    object.properties.push(t.objectProperty(t.identifier(name), value));
  }
}

function assertStaticJsObject(object: t.ObjectExpression, description: string): void {
  if (object.properties.some(property => t.isSpreadElement(property) || property.computed)) {
    throw new UserError(`Cannot safely edit ${description} because it contains dynamic or spread properties`);
  }

  const names = object.properties.map(jsPropertyName).filter((name): name is string => Boolean(name));
  if (new Set(names).size !== names.length) {
    throw new UserError(`Cannot safely edit ${description} because it contains duplicate properties`);
  }
}

function jsArrayJoinName(element: t.Expression | t.SpreadElement | null): string | undefined {
  return t.isObjectExpression(element)
    ? jsStaticString(jsProperty(element, ['name'])?.value)
    : undefined;
}

type JsObjectJoinEntry = {
  name: string;
  property: t.ObjectProperty;
  join: t.ObjectExpression;
};

function staticJsObjectJoins(joins: t.ObjectExpression, sourceCube: string): JsObjectJoinEntry[] {
  assertStaticJsObject(joins, `relationships of cube '${sourceCube}'`);

  return joins.properties.map((property) => {
    const name = jsPropertyName(property);
    if (!name || !t.isObjectProperty(property) || !t.isObjectExpression(property.value)) {
      throw new UserError(
        `Cannot safely edit relationships of cube '${sourceCube}' because they contain dynamic definitions`
      );
    }
    assertStaticJsObject(property.value, `relationship '${sourceCube}' -> '${name}'`);
    return { name, property, join: property.value };
  });
}

type JsArrayJoinEntry = {
  name: string;
  join: t.ObjectExpression;
};

function staticJsArrayJoins(joins: t.ArrayExpression, sourceCube: string): JsArrayJoinEntry[] {
  return joins.elements.map((element) => {
    const name = jsArrayJoinName(element);
    if (!name || !t.isObjectExpression(element)) {
      throw new UserError(
        `Cannot safely edit relationships of cube '${sourceCube}' because they contain dynamic definitions or spreads`
      );
    }
    assertStaticJsObject(element, `relationship '${sourceCube}' -> '${name}'`);
    return { name, join: element };
  });
}

export class CubeRelationshipConverter implements CubeConverterInterface {
  public constructor(protected readonly definition: CubeRelationshipDefinition) {}

  public convert(astByCubeName: AstByCubeName): void {
    const cubeDefSet = astByCubeName[this.definition.sourceCube];
    if (!cubeDefSet) {
      throw new UserError(`Cube '${this.definition.sourceCube}' was not found`);
    }

    if ('ast' in cubeDefSet) {
      this.convertJS(cubeDefSet);
    } else {
      this.convertYaml(cubeDefSet);
    }
  }

  protected convertJS(cubeDefSet: JsSet): void {
    const {
      targetCube,
      sourceColumn,
      targetColumn,
      sourceColumnSql,
      targetColumnSql,
      relationship,
      operation = 'create',
    } = this.definition;
    const { cubeDefinition } = cubeDefSet;
    assertStaticJsObject(cubeDefinition, `cube '${this.definition.sourceCube}'`);
    let joinsProperty = jsProperty(cubeDefinition, ['joins']);
    let joins: t.ObjectExpression | t.ArrayExpression | null = joinsProperty && (
      t.isObjectExpression(joinsProperty.value) || t.isArrayExpression(joinsProperty.value)
    ) ? joinsProperty.value : null;

    if (joinsProperty && !joins) {
      throw new UserError("'joins' must be a static object or array in JavaScript cube files");
    }

    const objectEntries = joins && t.isObjectExpression(joins)
      ? staticJsObjectJoins(joins, this.definition.sourceCube)
      : [];
    const arrayEntries = joins && t.isArrayExpression(joins)
      ? staticJsArrayJoins(joins, this.definition.sourceCube)
      : [];
    const existingEntries = objectEntries.length ? objectEntries : arrayEntries;
    const matchingEntries = existingEntries.filter(entry => entry.name === targetCube);

    if (matchingEntries.length > 1) {
      throw new UserError(`Relationship '${this.definition.sourceCube}' -> '${targetCube}' is defined more than once`);
    }

    if (operation === 'delete') {
      if (joins && t.isObjectExpression(joins)) {
        joins.properties = joins.properties.filter(property => jsPropertyName(property) !== targetCube);
      } else if (joins && t.isArrayExpression(joins)) {
        joins.elements = joins.elements.filter(element => jsArrayJoinName(element) !== targetCube);
      }
      return;
    }

    if (!sourceColumn || !targetColumn || !relationship) {
      throw new UserError('Source column, target column, and relationship are required');
    }

    if (!t.isValidIdentifier(targetCube)) {
      throw new UserError(`Cube '${targetCube}' cannot be referenced safely from JavaScript`);
    }

    if (!joins) {
      if (operation === 'update') {
        throw new UserError(`Relationship '${this.definition.sourceCube}' -> '${targetCube}' was not found`);
      }
      joins = t.objectExpression([]);
      joinsProperty = t.objectProperty(t.identifier('joins'), joins);
      cubeDefinition.properties.push(joinsProperty);
    }

    const existingJoin = matchingEntries[0]?.join;
    if (operation === 'create' && existingJoin) {
      throw new UserError(`Relationship '${this.definition.sourceCube}' -> '${targetCube}' already exists`);
    }
    if (operation === 'update' && !existingJoin) {
      throw new UserError(`Relationship '${this.definition.sourceCube}' -> '${targetCube}' was not found`);
    }
    let joinObject = existingJoin;
    if (!joinObject) {
      joinObject = t.objectExpression([]);
      if (t.isObjectExpression(joins)) {
        joins.properties.push(t.objectProperty(t.identifier(targetCube), joinObject));
      } else {
        joinObject.properties.push(t.objectProperty(t.identifier('name'), t.stringLiteral(targetCube)));
        joins.elements.push(joinObject);
      }
    }

    setJsObjectProperty(
      joinObject,
      'sql',
      createJoinTemplate(sourceColumn, targetCube, targetColumn, sourceColumnSql, targetColumnSql)
    );
    setJsObjectProperty(joinObject, 'relationship', t.stringLiteral(relationship));
  }

  protected convertYaml(cubeDefSet: YamlSet): void {
    const {
      targetCube,
      sourceColumn,
      targetColumn,
      sourceColumnSql,
      targetColumnSql,
      relationship,
      operation = 'create',
    } = this.definition;
    const { cubeDefinition, yaml } = cubeDefSet;
    let joinsPair = yamlPair(cubeDefinition, ['joins']);
    let joins = joinsPair && isSeq(joinsPair.value) ? joinsPair.value : null;

    if (joinsPair && !joins) {
      throw new UserError("'joins' must be a sequence in YAML cube files");
    }

    if (operation === 'delete') {
      if (joins) {
        joins.items = joins.items.filter((item) => {
          if (!isMap(item)) return true;
          return yamlStaticString(yamlPair(item, ['name'])) !== targetCube;
        });
      }
      return;
    }

    if (!sourceColumn || !targetColumn || !relationship) {
      throw new UserError('Source column, target column, and relationship are required');
    }

    if (!joins) {
      if (operation === 'update') {
        throw new UserError(`Relationship '${this.definition.sourceCube}' -> '${targetCube}' was not found`);
      }
      joins = yaml.createNode([]) as YAMLSeq;
      joinsPair = new Pair(new Scalar('joins'), joins);
      cubeDefinition.items.push(joinsPair);
    }

    let join: any = joins.items.find(
      item => isMap(item) && yamlStaticString(yamlPair(item, ['name'])) === targetCube
    );
    if (operation === 'create' && join) {
      throw new UserError(`Relationship '${this.definition.sourceCube}' -> '${targetCube}' already exists`);
    }
    if (operation === 'update' && !join) {
      throw new UserError(`Relationship '${this.definition.sourceCube}' -> '${targetCube}' was not found`);
    }
    if (!join || !isMap(join)) {
      joins.flow = false;
      join = yaml.createNode({ name: targetCube }) as YAMLMap;
      joins.items.push(join);
    }

    setYamlScalar(join, 'name', targetCube);
    setYamlScalar(
      join,
      'sql',
      createJoinSql(sourceColumn, targetCube, targetColumn, sourceColumnSql, targetColumnSql)
    );
    setYamlScalar(join, 'relationship', relationship);
  }
}

export class CubeRelationshipReader implements CubeConverterInterface {
  protected models: CubeDiagramModel[] = [];

  protected relationships: CubeDiagramRelationship[] = [];

  public convert(astByCubeName: AstByCubeName): void {
    this.models = [];
    this.relationships = [];

    Object.entries(astByCubeName).forEach(([cubeName, cubeDefSet]) => {
      if ('ast' in cubeDefSet) {
        this.readJS(cubeName, cubeDefSet);
      } else {
        this.readYaml(cubeName, cubeDefSet);
      }
    });
  }

  public getModels(): CubeDiagramModel[] {
    return this.models;
  }

  public getRelationships(): CubeDiagramRelationship[] {
    return this.relationships;
  }

  protected readJS(cubeName: string, cubeDefSet: JsSet): void {
    const { cubeDefinition, fileName } = cubeDefSet;
    const title = jsStaticString(jsProperty(cubeDefinition, ['title'])?.value);
    const sqlTable = jsProperty(cubeDefinition, ['sqlTable', 'sql_table']);
    const sql = jsProperty(cubeDefinition, ['sql']);
    const sourceProperty = sqlTable || sql;
    const source = sourceProperty
      ? (jsStaticString(sourceProperty.value) || generator(sourceProperty.value as t.Node).code)
      : undefined;
    const dataSource = jsStaticString(jsProperty(cubeDefinition, ['dataSource', 'data_source'])?.value) || 'default';

    this.models.push({
      name: cubeName,
      title,
      fileName,
      fileType: 'javascript',
      dataSource,
      sourceType: sqlTable ? 'sql_table' : sql ? 'sql' : 'unknown',
      source,
      dimensions: readJsMembers(cubeDefinition, 'dimensions'),
      measures: readJsMembers(cubeDefinition, 'measures'),
    });

    const joinsProperty = jsProperty(cubeDefinition, ['joins']);
    if (!joinsProperty) {
      return;
    }

    if (t.isObjectExpression(joinsProperty.value)) {
      joinsProperty.value.properties.forEach((joinProperty) => {
        if (!t.isObjectProperty(joinProperty) || !t.isObjectExpression(joinProperty.value)) {
          return;
        }
        const targetCube = jsPropertyName(joinProperty);
        if (targetCube) {
          this.readJSRelationship(cubeName, targetCube, joinProperty.value);
        }
      });
    } else if (t.isArrayExpression(joinsProperty.value)) {
      joinsProperty.value.elements.forEach((joinNode) => {
        const targetCube = jsArrayJoinName(joinNode);
        if (targetCube && t.isObjectExpression(joinNode)) {
          this.readJSRelationship(cubeName, targetCube, joinNode);
        }
      });
    }
  }

  protected readJSRelationship(
    sourceCube: string,
    targetCube: string,
    joinDefinition: t.ObjectExpression
  ): void {
    const relationship = normalizeRelationship(
      jsStaticString(jsProperty(joinDefinition, ['relationship'])?.value) || ''
    );
    const sqlProperty = jsProperty(joinDefinition, ['sql']);
    const sqlValue = sqlProperty
      ? (jsStaticString(sqlProperty.value) || generator(sqlProperty.value as t.Node).code)
      : '';

    this.relationships.push({
      sourceCube,
      targetCube,
      relationship,
      sql: sqlValue,
      ...parseJoinColumns(sqlValue, targetCube),
    });
  }

  protected readYaml(cubeName: string, cubeDefSet: YamlSet): void {
    const { cubeDefinition, fileName } = cubeDefSet;
    const title = yamlStaticString(yamlPair(cubeDefinition, ['title']));
    const sqlTable = yamlPair(cubeDefinition, ['sql_table', 'sqlTable']);
    const sql = yamlPair(cubeDefinition, ['sql']);
    const dataSource = yamlStaticString(yamlPair(cubeDefinition, ['data_source', 'dataSource'])) || 'default';

    this.models.push({
      name: cubeName,
      title,
      fileName,
      fileType: 'yaml',
      dataSource,
      sourceType: sqlTable ? 'sql_table' : sql ? 'sql' : 'unknown',
      source: yamlStaticString(sqlTable || sql),
      dimensions: readYamlMembers(cubeDefinition, 'dimensions'),
      measures: readYamlMembers(cubeDefinition, 'measures'),
    });

    const joinsPair = yamlPair(cubeDefinition, ['joins']);
    if (!joinsPair || !isSeq(joinsPair.value)) {
      return;
    }

    joinsPair.value.items.forEach((joinNode) => {
      if (!isMap(joinNode)) return;
      const targetCube = yamlStaticString(yamlPair(joinNode, ['name']));
      if (!targetCube) return;
      const relationship = normalizeRelationship(
        yamlStaticString(yamlPair(joinNode, ['relationship'])) || ''
      );
      const sqlValue = yamlStaticString(yamlPair(joinNode, ['sql'])) || '';

      this.relationships.push({
        sourceCube: cubeName,
        targetCube,
        relationship,
        sql: sqlValue,
        ...parseJoinColumns(sqlValue, targetCube),
      });
    });
  }
}
