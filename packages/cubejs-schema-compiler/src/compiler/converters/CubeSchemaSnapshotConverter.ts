import * as t from '@babel/types';
import YAML, { isScalar, Pair, YAMLMap } from 'yaml';

import type { AstByCubeName, CubeConverterInterface, JsSet, YamlSet } from './CubeSchemaConverter';
import { insertJsCubeSection, insertYamlCubeSection, setYamlCubeProperty } from './CubeSchemaOrdering';

export type CubeSchemaSnapshot = {
  cubeName: string;
  cube?: Record<string, unknown>;
  dimensions?: Record<string, unknown>[];
  measures?: Record<string, unknown>[];
  hierarchies?: Record<string, unknown>[];
  joins?: Record<string, unknown>[];
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

function jsKey(name: string): t.Identifier | t.StringLiteral {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? t.identifier(name) : t.stringLiteral(name);
}

function isPersistableValue(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
}

function cleanPersistableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanPersistableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key !== 'diagramItemId' && isPersistableValue(item))
      .map(([key, item]) => [key, cleanPersistableValue(item)]));
  }
  return value;
}

function jsValue(value: unknown): t.Expression {
  if (value === null) return t.nullLiteral();
  if (typeof value === 'boolean') return t.booleanLiteral(value);
  if (typeof value === 'number') return t.numericLiteral(value);
  if (Array.isArray(value)) return t.arrayExpression(value.map(jsValue));
  if (value && typeof value === 'object') {
    return t.objectExpression(Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key !== 'diagramItemId' && isPersistableValue(item))
      .map(([key, item]) => t.objectProperty(jsKey(key), jsValue(item))));
  }
  return t.stringLiteral(String(value));
}

function yamlRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record)
    .filter(([key, value]) => key !== 'diagramItemId' && isPersistableValue(value))
    .map(([key, value]) => [
      key === 'primaryKey' ? 'primary_key' : key,
      cleanPersistableValue(value),
    ]));
}

function yamlSection(cubeDefinition: YAMLMap, yaml: YAML.Document, name: string, items: Record<string, unknown>[]): void {
  const value = yaml.createNode(items.map(item => yamlRecord(item)));
  const existing = cubeDefinition.items.find(item => (
    isScalar((item as Pair).key) && String(((item as Pair).key as any).value) === name
  ));
  if (existing) cubeDefinition.set(name, value);
  else insertYamlCubeSection(cubeDefinition, new Pair(name, value));
}

function jsSection(
  cubeDefinition: t.ObjectExpression,
  name: string,
  items: Record<string, unknown>[],
  defaultAsObject = false,
): void {
  const existing = jsProperty(cubeDefinition, [name]);
  const useObject = existing && t.isObjectExpression(existing.value) || (!existing && defaultAsObject);
  const value = useObject
    ? t.objectExpression(items.map(item => {
      const { name: itemName, ...properties } = item;
      return t.objectProperty(jsKey(String(itemName || '')), jsValue(properties));
    }))
    : t.arrayExpression(items.map(item => t.objectExpression(Object.entries(item)
      .filter(([key, itemValue]) => key !== 'diagramItemId' && isPersistableValue(itemValue))
      .map(([key, itemValue]) => t.objectProperty(jsKey(key), jsValue(itemValue))))));

  if (existing) existing.value = value;
  else insertJsCubeSection(cubeDefinition, t.objectProperty(jsKey(name), value));
}

function jsCubePropertyName(name: string): string {
  return {
    sql_table: 'sqlTable',
    data_source: 'dataSource',
    refresh_key: 'refreshKey',
  }[name] || name;
}

export class CubeSchemaSnapshotConverter implements CubeConverterInterface {
  public constructor(protected readonly snapshot: CubeSchemaSnapshot) {}

  public convert(astByCubeName: AstByCubeName): void {
    const cubeDefSet = astByCubeName[this.snapshot.cubeName];
    if (!cubeDefSet) throw new Error(`Cube '${this.snapshot.cubeName}' was not found`);
    if ('ast' in cubeDefSet) this.convertJS(cubeDefSet);
    else this.convertYaml(cubeDefSet);
  }

  protected convertJS(cubeDefSet: JsSet): void {
    const { cubeDefinition } = cubeDefSet;
    if (this.snapshot.cube) {
      Object.entries(this.snapshot.cube).forEach(([key, value]) => {
        const propertyName = jsCubePropertyName(key);
        const existing = jsProperty(cubeDefinition, [propertyName]);
        if (!isPersistableValue(value)) {
          cubeDefinition.properties = cubeDefinition.properties.filter(property => jsPropertyName(property) !== propertyName);
        } else if (existing) {
          existing.value = jsValue(value);
        } else {
          insertJsCubeSection(cubeDefinition, t.objectProperty(jsKey(propertyName), jsValue(value)));
        }
      });
    }
    if (this.snapshot.dimensions) jsSection(cubeDefinition, 'dimensions', this.snapshot.dimensions, true);
    if (this.snapshot.measures) jsSection(cubeDefinition, 'measures', this.snapshot.measures, true);
    if (this.snapshot.hierarchies) jsSection(cubeDefinition, 'hierarchies', this.snapshot.hierarchies, false);
    if (this.snapshot.joins) jsSection(cubeDefinition, 'joins', this.snapshot.joins, true);
  }

  protected convertYaml(cubeDefSet: YamlSet): void {
    const { cubeDefinition, yaml } = cubeDefSet;
    if (this.snapshot.cube) {
      Object.entries(this.snapshot.cube).forEach(([key, value]) => {
        if (!isPersistableValue(value)) cubeDefinition.delete(key);
        else setYamlCubeProperty(cubeDefinition, key, value);
      });
    }
    if (this.snapshot.dimensions) yamlSection(cubeDefinition, yaml, 'dimensions', this.snapshot.dimensions);
    if (this.snapshot.measures) yamlSection(cubeDefinition, yaml, 'measures', this.snapshot.measures);
    if (this.snapshot.hierarchies) yamlSection(cubeDefinition, yaml, 'hierarchies', this.snapshot.hierarchies);
    if (this.snapshot.joins) yamlSection(cubeDefinition, yaml, 'joins', this.snapshot.joins);
  }
}
