import * as t from '@babel/types';
import YAML, { isMap, isScalar, isSeq, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

import type { AstByCubeName, CubeConverterInterface, JsSet, YamlSet } from './CubeSchemaConverter';
import { insertJsCubeSection, insertYamlCubeSection, setYamlCubeProperty } from './CubeSchemaOrdering';

export type CubeSchemaItemSection =
  | 'dimensions'
  | 'measures'
  | 'segments'
  | 'hierarchies'
  | 'pre_aggregations'
  | 'cube';

export type CubeSchemaItemDefinition = {
  cubeName: string;
  section: CubeSchemaItemSection;
  itemName?: string;
  /** Zero-based occurrence among items with the same name, ignoring case. */
  itemIndex?: number;
  values: Record<string, unknown>;
  operation?: 'upsert' | 'delete';
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

function jsSectionNames(section: CubeSchemaItemSection): string[] {
  if (section === 'pre_aggregations') return ['preAggregations', 'pre_aggregations'];
  if (section === 'cube') return [];
  return [section];
}

function jsCubePropertyName(name: string): string {
  return {
    sql_table: 'sqlTable',
    data_source: 'dataSource',
  }[name] || name;
}

function jsKey(name: string): t.Identifier | t.StringLiteral {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? t.identifier(name) : t.stringLiteral(name);
}

function jsValue(value: unknown): t.Expression {
  if (value === null) return t.nullLiteral();
  if (typeof value === 'boolean') return t.booleanLiteral(value);
  if (typeof value === 'number') return t.numericLiteral(value);
  if (Array.isArray(value)) return t.arrayExpression(value.map(jsValue));
  if (typeof value === 'object') {
    return t.objectExpression(Object.entries(value as Record<string, unknown>).map(([key, item]) => (
      t.objectProperty(jsKey(key), jsValue(item))
    )));
  }
  return t.stringLiteral(String(value));
}

function setJsProperty(object: t.ObjectExpression, name: string, value: unknown): void {
  const existing = jsProperty(object, [name]);
  if (value === null || value === undefined || value === '') {
    object.properties = object.properties.filter(property => jsPropertyName(property) !== name);
    return;
  }
  if (existing) existing.value = jsValue(value);
  else object.properties.push(t.objectProperty(jsKey(name), jsValue(value)));
}

function updateJsObject(
  object: t.ObjectExpression,
  values: Record<string, unknown>,
  includeName: boolean,
  orderedProperties = false,
): void {
  Object.entries(values).forEach(([key, value]) => {
    if (orderedProperties && !jsProperty(object, [key]) && value !== null && value !== undefined && value !== '') {
      insertJsCubeSection(object, t.objectProperty(jsKey(key), jsValue(value)));
    } else {
      setJsProperty(object, key, value);
    }
  });
  if (includeName && typeof values.name === 'string') setJsProperty(object, 'name', values.name);
}

function yamlPair(object: YAMLMap, names: string[]): Pair | undefined {
  return object.items.find((item): item is Pair => (
    isScalar(item.key) && names.includes(String(item.key.value))
  ));
}

function yamlName(item: YAMLMap): string | undefined {
  const pair = yamlPair(item, ['name']);
  return pair?.value && typeof (pair.value as any).value !== 'undefined' ? String((pair.value as any).value) : undefined;
}

function sameMemberName(left: unknown, right: unknown): boolean {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function isPrimaryKeyValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function isPrimaryKeyJsItem(value: t.Node | null | undefined): boolean {
  return t.isObjectExpression(value) && isPrimaryKeyValue(
    (jsProperty(value, ['primaryKey', 'primary_key'])?.value as t.BooleanLiteral | t.StringLiteral | undefined)?.value
  );
}

function isPrimaryKeyYamlItem(value: unknown): boolean {
  return isMap(value) && isPrimaryKeyValue((yamlPair(value, ['primary_key', 'primaryKey'])?.value as any)?.value);
}

function yamlSectionName(section: CubeSchemaItemSection): string {
  return section;
}

export class CubeSchemaItemConverter implements CubeConverterInterface {
  public constructor(protected readonly definition: CubeSchemaItemDefinition) {}

  public convert(astByCubeName: AstByCubeName): void {
    const cubeDefSet = astByCubeName[this.definition.cubeName];
    if (!cubeDefSet) throw new Error(`Cube '${this.definition.cubeName}' was not found`);
    if ('ast' in cubeDefSet) this.convertJS(cubeDefSet);
    else this.convertYaml(cubeDefSet);
  }

  protected convertJS(cubeDefSet: JsSet): void {
    const { cubeDefinition } = cubeDefSet;
    if (this.definition.section === 'cube') {
      const values = Object.fromEntries(
        Object.entries(this.definition.values).map(([key, value]) => [jsCubePropertyName(key), value])
      );
      updateJsObject(cubeDefinition, values, false, true);
      return;
    }

    const sectionProperty = jsProperty(cubeDefinition, jsSectionNames(this.definition.section));
    if (this.definition.operation === 'delete') {
      if (!sectionProperty) return;
      const lookupName = this.definition.itemName;
      if (!lookupName) throw new Error('A schema item name is required for deletion');
      if (t.isObjectExpression(sectionProperty.value)) {
        sectionProperty.value.properties = sectionProperty.value.properties.filter(
          property => !sameMemberName(jsPropertyName(property), lookupName)
        );
      } else if (t.isArrayExpression(sectionProperty.value)) {
        let occurrence = 0;
        let removed = false;
        sectionProperty.value.elements = sectionProperty.value.elements.filter(element => {
          const isMatch = t.isObjectExpression(element) && jsProperty(element, ['name'])
            && sameMemberName((jsProperty(element, ['name'])!.value as t.StringLiteral).value, lookupName);
          if (!isMatch) return true;
          if (this.definition.itemIndex === undefined) return false;
          if (occurrence++ === this.definition.itemIndex && !removed) {
            removed = true;
            return false;
          }
          return true;
        });
      }
      return;
    }
    const values = this.definition.values;
    const requestedName = String(values.name || this.definition.itemName || '');
    if (!requestedName) throw new Error('A schema item name is required');

    if (!sectionProperty) {
      const item = t.objectExpression([]);
      updateJsObject(item, values, true);
      insertJsCubeSection(cubeDefinition, t.objectProperty(jsKey(jsSectionNames(this.definition.section)[0]), t.objectExpression([
        t.objectProperty(jsKey(requestedName), item),
      ])));
      return;
    }

    if (t.isObjectExpression(sectionProperty.value)) {
      const lookupName = this.definition.itemName || requestedName;
      const existing = sectionProperty.value.properties.find(property => sameMemberName(jsPropertyName(property), lookupName));
      if (existing && t.isObjectProperty(existing) && t.isObjectExpression(existing.value)) {
        existing.key = jsKey(requestedName);
        updateJsObject(existing.value, values, false);
      } else {
        const item = t.objectExpression([]);
        updateJsObject(item, values, true);
        const property = t.objectProperty(jsKey(requestedName), item);
        if (this.definition.section === 'dimensions' && isPrimaryKeyValue(values.primary_key ?? values.primaryKey)) {
          const firstNonPrimary = sectionProperty.value.properties.findIndex(candidate => (
            !isPrimaryKeyJsItem(t.isObjectProperty(candidate) ? candidate.value : undefined)
          ));
          if (firstNonPrimary >= 0) sectionProperty.value.properties.splice(firstNonPrimary, 0, property);
          else sectionProperty.value.properties.push(property);
        } else {
          sectionProperty.value.properties.push(property);
        }
      }
      return;
    }

    if (t.isArrayExpression(sectionProperty.value)) {
      const lookupName = this.definition.itemName || requestedName;
      let occurrence = 0;
      const existing = sectionProperty.value.elements.find(element => {
        const isMatch = t.isObjectExpression(element) && jsProperty(element, ['name'])
          && sameMemberName((jsProperty(element, ['name'])!.value as t.StringLiteral).value, lookupName);
        if (!isMatch) return false;
        if (this.definition.itemIndex === undefined || occurrence++ === this.definition.itemIndex) return true;
        return false;
      });
      if (t.isObjectExpression(existing)) {
        updateJsObject(existing, values, true);
      } else {
        const item = t.objectExpression([]);
        updateJsObject(item, values, true);
        if (this.definition.section === 'dimensions' && isPrimaryKeyValue(values.primary_key ?? values.primaryKey)) {
          const firstNonPrimary = sectionProperty.value.elements.findIndex(candidate => !isPrimaryKeyJsItem(candidate));
          if (firstNonPrimary >= 0) sectionProperty.value.elements.splice(firstNonPrimary, 0, item);
          else sectionProperty.value.elements.push(item);
        } else {
          sectionProperty.value.elements.push(item);
        }
      }
      return;
    }

    throw new Error(`'${this.definition.section}' must be a static object or array in JavaScript cube files`);
  }

  protected convertYaml(cubeDefSet: YamlSet): void {
    const { cubeDefinition, yaml } = cubeDefSet;
    if (this.definition.section === 'cube') {
      Object.entries(this.definition.values).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') cubeDefinition.delete(key);
        else setYamlCubeProperty(cubeDefinition, key, value);
      });
      return;
    }

    const section = yamlSectionName(this.definition.section);
    let sectionPair = yamlPair(cubeDefinition, [section]);
    let sequence = sectionPair && isSeq(sectionPair.value) ? sectionPair.value : null;
    if (sectionPair && !sequence) throw new Error(`'${section}' must be a sequence in YAML cube files`);
    if (this.definition.operation === 'delete') {
      if (!sequence) return;
      const lookupName = this.definition.itemName;
      if (!lookupName) throw new Error('A schema item name is required for deletion');
      let occurrence = 0;
      let removed = false;
      sequence.items = sequence.items.filter(candidate => {
        const isMatch = isMap(candidate) && sameMemberName(yamlName(candidate), lookupName);
        if (!isMatch) return true;
        if (this.definition.itemIndex === undefined) return false;
        if (occurrence++ === this.definition.itemIndex && !removed) {
          removed = true;
          return false;
        }
        return true;
      });
      if (sequence.items.length === 0 && sectionPair) cubeDefinition.delete(section);
      return;
    }
    if (!sequence) {
      sequence = yaml.createNode([]) as YAMLSeq;
      sectionPair = new Pair(new Scalar(section), sequence);
      insertYamlCubeSection(cubeDefinition, sectionPair);
    }

    const values = this.definition.values;
    const requestedName = String(values.name || this.definition.itemName || '');
    if (!requestedName) throw new Error('A schema item name is required');
    const lookupName = this.definition.itemName || requestedName;
    let occurrence = 0;
    let item = sequence.items.find(candidate => {
      const isMatch = isMap(candidate) && sameMemberName(yamlName(candidate), lookupName);
      if (!isMatch) return false;
      if (this.definition.itemIndex === undefined || occurrence++ === this.definition.itemIndex) return true;
      return false;
    }) as YAMLMap | undefined;
    if (!item) {
      item = yaml.createNode({}) as YAMLMap;
      if (this.definition.section === 'dimensions' && isPrimaryKeyValue(values.primary_key ?? values.primaryKey)) {
        const firstNonPrimary = sequence.items.findIndex(candidate => !isPrimaryKeyYamlItem(candidate));
        if (firstNonPrimary >= 0) sequence.items.splice(firstNonPrimary, 0, item);
        else sequence.items.push(item);
      } else {
        sequence.items.push(item);
      }
    }

    Object.entries(values).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '') item!.delete(key);
      else item!.set(key, value);
    });
    item.set('name', requestedName);
  }
}
