import * as t from '@babel/types';
import YAML, { isMap, isScalar, isSeq, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

import type { AstByCubeName, CubeConverterInterface, JsSet, YamlSet } from './CubeSchemaConverter';
import { insertJsCubeSection, insertYamlCubeSection } from './CubeSchemaOrdering';

export type CubeDimensionDefinition = {
  cubeName: string;
  dimensionName?: string;
  name: string;
  sql: string;
  type?: string;
  title?: string;
  primaryKey?: boolean;
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

function deleteJsProperty(object: t.ObjectExpression, names: string[]): void {
  object.properties = object.properties.filter(property => !names.includes(jsPropertyName(property) || ''));
}

function setJsDimensionName(property: t.ObjectProperty, name: string): void {
  if (t.isIdentifier(property.key)) {
    property.key = t.identifier(name);
  } else {
    property.key = t.stringLiteral(name);
  }
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

function setYamlValue(object: YAMLMap, name: string, value: string | boolean): void {
  object.set(name, value);
}

function deleteYamlValue(object: YAMLMap, names: string[]): void {
  names.forEach(name => object.delete(name));
}

function isPrimaryKeyValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function isPrimaryKeyJsDimension(value: t.Node | null | undefined): boolean {
  return t.isObjectExpression(value) && isPrimaryKeyValue(
    (jsProperty(value, ['primaryKey', 'primary_key'])?.value as t.BooleanLiteral | t.StringLiteral | undefined)?.value
  );
}

function isPrimaryKeyYamlDimension(value: unknown): boolean {
  return isMap(value) && isPrimaryKeyValue((yamlPair(value, ['primary_key', 'primaryKey'])?.value as any)?.value);
}

export class CubeDimensionConverter implements CubeConverterInterface {
  public constructor(protected readonly definition: CubeDimensionDefinition) {}

  public convert(astByCubeName: AstByCubeName): void {
    const cubeDefSet = astByCubeName[this.definition.cubeName];
    if (!cubeDefSet) throw new Error(`Cube '${this.definition.cubeName}' was not found`);
    if ('ast' in cubeDefSet) this.convertJS(cubeDefSet);
    else this.convertYaml(cubeDefSet);
  }

  protected convertJS(cubeDefSet: JsSet): void {
    const { cubeDefinition } = cubeDefSet;
    const dimensionsProperty = jsProperty(cubeDefinition, ['dimensions']);
    const dimensionValue = () => t.objectExpression([
      t.objectProperty(t.identifier('sql'), t.stringLiteral(this.definition.sql)),
      ...(this.definition.type ? [t.objectProperty(t.identifier('type'), t.stringLiteral(this.definition.type))] : []),
      ...(this.definition.title ? [t.objectProperty(t.identifier('title'), t.stringLiteral(this.definition.title))] : []),
      ...(this.definition.primaryKey ? [t.objectProperty(t.identifier('primaryKey'), t.booleanLiteral(true))] : []),
    ]);

    if (!dimensionsProperty) {
      insertJsCubeSection(cubeDefinition, t.objectProperty(
        t.identifier('dimensions'),
        t.objectExpression([t.objectProperty(t.identifier(this.definition.name), dimensionValue())])
      ));
      return;
    }

    if (t.isObjectExpression(dimensionsProperty.value)) {
      const existing = dimensionsProperty.value.properties.find(
        property => jsPropertyName(property) === (this.definition.dimensionName || this.definition.name)
      );
      if (existing && t.isObjectProperty(existing) && t.isObjectExpression(existing.value)) {
        setJsDimensionName(existing, this.definition.name);
        setJsProperty(existing.value, 'sql', t.stringLiteral(this.definition.sql));
        if (this.definition.type) setJsProperty(existing.value, 'type', t.stringLiteral(this.definition.type));
        else deleteJsProperty(existing.value, ['type']);
        if (this.definition.title) setJsProperty(existing.value, 'title', t.stringLiteral(this.definition.title));
        else deleteJsProperty(existing.value, ['title']);
        if (this.definition.primaryKey) setJsProperty(existing.value, 'primaryKey', t.booleanLiteral(true));
        else deleteJsProperty(existing.value, ['primaryKey', 'primary_key']);
        return;
      }
      const property = t.objectProperty(t.identifier(this.definition.name), dimensionValue());
      if (this.definition.primaryKey) {
        const firstNonPrimary = dimensionsProperty.value.properties.findIndex(candidate => (
          !isPrimaryKeyJsDimension(t.isObjectProperty(candidate) ? candidate.value : undefined)
        ));
        if (firstNonPrimary >= 0) dimensionsProperty.value.properties.splice(firstNonPrimary, 0, property);
        else dimensionsProperty.value.properties.push(property);
      } else {
        dimensionsProperty.value.properties.push(property);
      }
      return;
    }

    if (t.isArrayExpression(dimensionsProperty.value)) {
      const existing = dimensionsProperty.value.elements.find(element => (
        t.isObjectExpression(element)
        && jsStaticString(jsProperty(element, ['name'])?.value) === (this.definition.dimensionName || this.definition.name)
      ));
      if (t.isObjectExpression(existing)) {
        setJsProperty(existing, 'name', t.stringLiteral(this.definition.name));
        setJsProperty(existing, 'sql', t.stringLiteral(this.definition.sql));
        if (this.definition.type) setJsProperty(existing, 'type', t.stringLiteral(this.definition.type));
        else deleteJsProperty(existing, ['type']);
        if (this.definition.title) setJsProperty(existing, 'title', t.stringLiteral(this.definition.title));
        else deleteJsProperty(existing, ['title']);
        if (this.definition.primaryKey) setJsProperty(existing, 'primaryKey', t.booleanLiteral(true));
        else deleteJsProperty(existing, ['primaryKey', 'primary_key']);
        return;
      }
      const dimension = t.objectExpression([
        t.objectProperty(t.identifier('name'), t.stringLiteral(this.definition.name)),
        ...dimensionValue().properties,
      ]);
      if (this.definition.primaryKey) {
        const firstNonPrimary = dimensionsProperty.value.elements.findIndex(element => !isPrimaryKeyJsDimension(element));
        if (firstNonPrimary >= 0) dimensionsProperty.value.elements.splice(firstNonPrimary, 0, dimension);
        else dimensionsProperty.value.elements.push(dimension);
      } else {
        dimensionsProperty.value.elements.push(dimension);
      }
      return;
    }

    throw new Error("'dimensions' must be a static object or array in JavaScript cube files");
  }

  protected convertYaml(cubeDefSet: YamlSet): void {
    const { cubeDefinition, yaml } = cubeDefSet;
    let dimensionsPair = yamlPair(cubeDefinition, ['dimensions']);
    let dimensions = dimensionsPair && isSeq(dimensionsPair.value) ? dimensionsPair.value : null;

    if (dimensionsPair && !dimensions) throw new Error("'dimensions' must be a sequence in YAML cube files");
    if (!dimensions) {
      dimensions = yaml.createNode([]) as YAMLSeq;
      dimensionsPair = new Pair(new Scalar('dimensions'), dimensions);
      insertYamlCubeSection(cubeDefinition, dimensionsPair);
    }

    let dimension: YAMLMap | undefined = dimensions.items.find((item): item is YAMLMap => (
      isMap(item) && yamlScalar(item, ['name']) === (this.definition.dimensionName || this.definition.name)
    ));

    if (!dimension) {
      dimension = yaml.createNode({ name: this.definition.name }) as YAMLMap;
      if (this.definition.primaryKey) {
        const firstNonPrimary = dimensions.items.findIndex(item => !isPrimaryKeyYamlDimension(item));
        if (firstNonPrimary >= 0) dimensions.items.splice(firstNonPrimary, 0, dimension);
        else dimensions.items.push(dimension);
      } else {
        dimensions.items.push(dimension);
      }
    }

    setYamlValue(dimension, 'name', this.definition.name);
    setYamlValue(dimension, 'sql', this.definition.sql);
    if (this.definition.type) setYamlValue(dimension, 'type', this.definition.type);
    else deleteYamlValue(dimension, ['type']);
    if (this.definition.title) setYamlValue(dimension, 'title', this.definition.title);
    else deleteYamlValue(dimension, ['title']);
    if (this.definition.primaryKey) setYamlValue(dimension, 'primary_key', true);
    else deleteYamlValue(dimension, ['primary_key', 'primaryKey']);
  }
}
