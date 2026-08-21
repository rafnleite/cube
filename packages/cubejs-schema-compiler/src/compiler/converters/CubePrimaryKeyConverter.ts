import * as t from '@babel/types';
import YAML, { isMap, isScalar, isSeq, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

import type { AstByCubeName, CubeConverterInterface, JsSet, YamlSet } from './CubeSchemaConverter';
import { insertJsCubeSection, insertYamlCubeSection } from './CubeSchemaOrdering';

export type CubePrimaryKeyDefinition = {
  cubeName: string;
  columnName: string;
  columnType?: string;
};

function jsPropertyName(property: t.ObjectMethod | t.ObjectProperty | t.SpreadElement): string | null {
  if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) return null;
  if (property.computed) return null;
  if (t.isIdentifier(property.key)) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return null;
}

function jsProperty(object: t.ObjectExpression, names: string[]): t.ObjectProperty | undefined {
  return object.properties.find(
    (property): property is t.ObjectProperty => t.isObjectProperty(property) && names.includes(jsPropertyName(property) || '')
  );
}

function jsStaticString(node: t.Node | null | undefined): string | undefined {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('');
  }
  return undefined;
}

function setJsProperty(object: t.ObjectExpression, name: string, value: t.Expression): void {
  const existing = jsProperty(object, [name]);
  if (existing) {
    existing.value = value;
  } else {
    object.properties.push(t.objectProperty(t.identifier(name), value));
  }
}

function inferDimensionType(columnType?: string): string {
  const type = String(columnType || '').toLowerCase();
  if (/timestamp|date|time/.test(type)) return 'time';
  if (/bool/.test(type)) return 'boolean';
  if (/int|numeric|decimal|real|double|float|number/.test(type)) return 'number';
  return 'string';
}

function yamlPair(object: YAMLMap, names: string[]): Pair | undefined {
  return object.items.find(
    (item): item is Pair => isScalar(item.key) && names.includes(String(item.key.value))
  );
}

function yamlScalar(object: YAMLMap, names: string[]): string | undefined {
  const pair = yamlPair(object, names);
  return pair && isScalar(pair.value) && pair.value.value != null ? String(pair.value.value) : undefined;
}

function isDirectColumnSql(value: string | undefined, columnName: string): boolean {
  if (!value) return false;
  const normalized = value.trim().replace(/^(?:\{\s*CUBE\s*\}|\$\{\s*CUBE\s*\}|CUBE)\s*\.\s*/i, '');
  return normalized.replace(/^['"`]|['"`]$/g, '') === columnName;
}

export class CubePrimaryKeyConverter implements CubeConverterInterface {
  public constructor(protected readonly definition: CubePrimaryKeyDefinition) {}

  public convert(astByCubeName: AstByCubeName): void {
    const cubeDefSet = astByCubeName[this.definition.cubeName];
    if (!cubeDefSet) throw new Error(`Cube '${this.definition.cubeName}' was not found`);
    if ('ast' in cubeDefSet) this.convertJS(cubeDefSet);
    else this.convertYaml(cubeDefSet);
  }

  protected convertJS(cubeDefSet: JsSet): void {
    const { cubeDefinition } = cubeDefSet;
    const dimensionsProperty = jsProperty(cubeDefinition, ['dimensions']);
    const type = inferDimensionType(this.definition.columnType);

    if (!dimensionsProperty) {
      insertJsCubeSection(cubeDefinition, t.objectProperty(
        t.identifier('dimensions'),
        t.objectExpression([
          t.objectProperty(t.identifier(this.definition.columnName), t.objectExpression([
            t.objectProperty(t.identifier('sql'), t.stringLiteral(this.definition.columnName)),
            t.objectProperty(t.identifier('type'), t.stringLiteral(type)),
            t.objectProperty(t.identifier('primaryKey'), t.booleanLiteral(true)),
          ])),
        ])
      ));
      return;
    }

    if (t.isObjectExpression(dimensionsProperty.value)) {
      const existing = dimensionsProperty.value.properties.find(
        property => jsPropertyName(property) === this.definition.columnName
      );
      if (existing && t.isObjectProperty(existing) && t.isObjectExpression(existing.value)) {
        if (!jsProperty(existing.value, ['type'])) {
          setJsProperty(existing.value, 'type', t.stringLiteral(type));
        }
        setJsProperty(existing.value, 'primaryKey', t.booleanLiteral(true));
        return;
      }

      const property = t.objectProperty(
        t.identifier(this.definition.columnName),
        t.objectExpression([
          t.objectProperty(t.identifier('sql'), t.stringLiteral(this.definition.columnName)),
          t.objectProperty(t.identifier('type'), t.stringLiteral(type)),
          t.objectProperty(t.identifier('primaryKey'), t.booleanLiteral(true)),
        ])
      );
      const firstNonPrimary = dimensionsProperty.value.properties.findIndex(candidate => (
        !t.isObjectProperty(candidate)
        || !t.isObjectExpression(candidate.value)
        || !Boolean((jsProperty(candidate.value, ['primaryKey', 'primary_key'])?.value as t.BooleanLiteral | undefined)?.value)
      ));
      if (firstNonPrimary >= 0) dimensionsProperty.value.properties.splice(firstNonPrimary, 0, property);
      else dimensionsProperty.value.properties.push(property);
      return;
    }

    if (t.isArrayExpression(dimensionsProperty.value)) {
      const existing = dimensionsProperty.value.elements.find(element => {
        if (!t.isObjectExpression(element)) return false;
        return jsStaticString(jsProperty(element, ['name'])?.value) === this.definition.columnName;
      });
      if (t.isObjectExpression(existing)) {
        setJsProperty(existing, 'primaryKey', t.booleanLiteral(true));
        return;
      }
      const dimension = t.objectExpression([
        t.objectProperty(t.identifier('name'), t.stringLiteral(this.definition.columnName)),
        t.objectProperty(t.identifier('sql'), t.stringLiteral(this.definition.columnName)),
        t.objectProperty(t.identifier('type'), t.stringLiteral(type)),
        t.objectProperty(t.identifier('primaryKey'), t.booleanLiteral(true)),
      ]);
      const firstNonPrimary = dimensionsProperty.value.elements.findIndex(element => !(
        t.isObjectExpression(element)
        && Boolean((jsProperty(element, ['primaryKey', 'primary_key'])?.value as t.BooleanLiteral | undefined)?.value)
      ));
      if (firstNonPrimary >= 0) dimensionsProperty.value.elements.splice(firstNonPrimary, 0, dimension);
      else dimensionsProperty.value.elements.push(dimension);
      return;
    }

    throw new Error("'dimensions' must be a static object or array in JavaScript cube files");
  }

  protected convertYaml(cubeDefSet: YamlSet): void {
    const { cubeDefinition, yaml } = cubeDefSet;
    const type = inferDimensionType(this.definition.columnType);
    let dimensionsPair = yamlPair(cubeDefinition, ['dimensions']);
    let dimensions = dimensionsPair && isSeq(dimensionsPair.value) ? dimensionsPair.value : null;

    if (dimensionsPair && !dimensions) throw new Error("'dimensions' must be a sequence in YAML cube files");
    if (!dimensions) {
      dimensions = yaml.createNode([]) as YAMLSeq;
      dimensionsPair = new Pair(new Scalar('dimensions'), dimensions);
      insertYamlCubeSection(cubeDefinition, dimensionsPair);
    }

    let dimension: YAMLMap | undefined = dimensions.items.find((item): item is YAMLMap => {
      return isMap(item) && (
        yamlScalar(item, ['name']) === this.definition.columnName
        || isDirectColumnSql(yamlScalar(item, ['sql']), this.definition.columnName)
      );
    });

    if (!dimension) {
      dimension = yaml.createNode({
        name: this.definition.columnName,
        sql: this.definition.columnName,
        type,
      }) as YAMLMap;
      const firstNonPrimary = dimensions.items.findIndex(item => !(
        isMap(item) && yamlScalar(item, ['primary_key', 'primaryKey']) === 'true'
      ));
      if (firstNonPrimary >= 0) dimensions.items.splice(firstNonPrimary, 0, dimension);
      else dimensions.items.push(dimension);
    }

    if (!yamlPair(dimension, ['type'])) {
      dimension.set('type', type);
    }
    dimension.set('primary_key', true);
  }
}
