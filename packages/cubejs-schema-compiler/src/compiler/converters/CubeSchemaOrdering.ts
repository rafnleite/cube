import * as t from '@babel/types';
import { isScalar, Pair, YAMLMap } from 'yaml';

/** The order of top-level cube properties and sections used by the visual model editor. */
export const CUBE_PROPERTY_ORDER = [
  'title',
  'name',
  'description',
  'sql',
  'sql_table',
  'extends',
  'data_source',
  'public',
  'refresh_key',
  'joins',
  'dimensions',
  'hierarchies',
  'measures',
  'segments',
  'pre_aggregations',
  'access_policy',
] as const;

function canonicalSectionName(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

function propertyOrder(name: string): number | undefined {
  return CUBE_PROPERTY_ORDER.indexOf(canonicalSectionName(name) as typeof CUBE_PROPERTY_ORDER[number]) >= 0
    ? CUBE_PROPERTY_ORDER.indexOf(canonicalSectionName(name) as typeof CUBE_PROPERTY_ORDER[number])
    : undefined;
}

function jsPropertyName(property: t.ObjectMethod | t.ObjectProperty | t.SpreadElement): string | undefined {
  if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) return undefined;
  if (property.computed) return undefined;
  if (t.isIdentifier(property.key)) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return undefined;
}

/** Adds a new cube section before later known sections, preserving all existing nodes. */
export function insertJsCubeSection(
  cubeDefinition: t.ObjectExpression,
  property: t.ObjectProperty,
): void {
  const targetOrder = propertyOrder(jsPropertyName(property) || '');
  if (targetOrder === undefined) {
    cubeDefinition.properties.push(property);
    return;
  }

  const insertionIndex = cubeDefinition.properties.findIndex(candidate => {
    const candidateOrder = propertyOrder(jsPropertyName(candidate) || '');
    return candidateOrder !== undefined && candidateOrder > targetOrder;
  });
  if (insertionIndex >= 0) cubeDefinition.properties.splice(insertionIndex, 0, property);
  else cubeDefinition.properties.push(property);
}

function yamlKey(pair: Pair): string | undefined {
  return isScalar(pair.key) && pair.key.value != null ? String(pair.key.value) : undefined;
}

/** Adds a new YAML cube section before later known sections, preserving comments and nodes. */
export function insertYamlCubeSection(cubeDefinition: YAMLMap, pair: Pair): void {
  const targetOrder = propertyOrder(yamlKey(pair) || '');
  if (targetOrder === undefined) {
    cubeDefinition.items.push(pair);
    return;
  }

  const insertionIndex = cubeDefinition.items.findIndex(item => {
    if (!('key' in item)) return false;
    const candidateOrder = propertyOrder(yamlKey(item as Pair) || '');
    return candidateOrder !== undefined && candidateOrder > targetOrder;
  });
  if (insertionIndex >= 0) cubeDefinition.items.splice(insertionIndex, 0, pair);
  else cubeDefinition.items.push(pair);
}

/** Sets a YAML cube property without appending a newly created property after its section. */
export function setYamlCubeProperty(cubeDefinition: YAMLMap, name: string, value: unknown): void {
  const existing = cubeDefinition.items.find(item => (
    'key' in item && canonicalSectionName(yamlKey(item as Pair) || '') === canonicalSectionName(name)
  ));
  if (existing) cubeDefinition.set(yamlKey(existing as Pair) || name, value);
  else insertYamlCubeSection(cubeDefinition, new Pair(name, value));
}
