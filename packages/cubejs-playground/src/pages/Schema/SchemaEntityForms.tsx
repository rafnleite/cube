import React from 'react';
import { TableColumn, TablesSchema } from './cubeSchemaUtils';
import { CUBE_PROPERTY_FIELDS, SchemaFormLayout } from './SchemaFormLayout';

export type SchemaEntityFormProps = {
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
  columns?: TableColumn[];
  tablesSchema?: TablesSchema;
  examples?: Record<string, string>;
};

export type CubeFormProps = SchemaEntityFormProps & {
  source?: {
    mode: 'sql_table' | 'sql';
    onModeChange: (mode: 'sql_table' | 'sql') => void;
  };
};

export const DIMENSION_FIELDS = [
  'title', 'name', 'description', 'sql', 'type', 'primary_key', 'public', 'shown',
  'case', 'sub_query', 'format', 'meta',
];

export const MEASURE_FIELDS = [
  'title', 'name', 'description', 'sql', 'type', 'public', 'format', 'drill_members',
  'rolling_window', 'filters', 'case', 'meta',
];

export const HIERARCHY_FIELDS = ['name', 'title', 'public', 'levels'];
export const SEGMENT_FIELDS = ['name', 'sql', 'title', 'description', 'public'];
export const JOIN_FIELDS = ['name', 'sql', 'relationship'];
export const PRE_AGGREGATION_FIELDS = [
  'name', 'type', 'measures', 'dimensions', 'time_dimension', 'granularity',
  'partition_granularity', 'refresh_key', 'external', 'scheduled_refresh', 'indexes',
];

export const FORM_EXAMPLES: Record<string, Record<string, string>> = {
  cubes: {
    title: 'Cartoes de embarque', name: 'boarding_passes', description: 'Cartoes emitidos para cada voo.',
    sql_table: 'bookings.boarding_passes', sql: 'SELECT * FROM bookings.boarding_passes',
    extends: 'base_cube', data_source: 'default', public: 'true', refresh_key: 'every: 1 hour',
  },
  joins: { name: 'flights', sql: '{CUBE}.flight_id = {flights}.flight_id', relationship: 'many_to_one' },
  hierarchies: { name: 'location', title: 'Localizacao', public: 'true', levels: 'country, state, city' },
  dimensions: {
    title: 'Horario de embarque', name: 'boarding_time', description: 'Horario programado para o embarque.',
    sql: '{CUBE}.boarding_time', type: 'time', primary_key: 'true', public: 'true', shown: 'true',
    case: "when:\n  - sql: \"{CUBE}.status = 'cancelled'\"\n    label: Cancelado\nelse:\n  label: Outro", sub_query: 'true', format: 'currency', meta: '{ source: ERP }',
  },
  measures: {
    name: 'revenue', sql: '{CUBE}.amount', type: 'sum', public: 'true', title: 'Receita',
    description: 'Valor total das vendas.', format: 'currency', drill_members: 'id, customer_name',
    rolling_window: 'trailing: 7 day', filters: "{CUBE}.status = 'confirmed'", case: "switch: \"{CUBE}.currency\"\nwhen:\n  - value: EUR\n    sql: \"{CUBE}.amount_eur\"\nelse:\n  sql: \"{CUBE}.amount_usd\"", meta: '{ source: ERP }',
  },
  segments: { name: 'active', sql: "{CUBE}.status = 'active'", title: 'Ativos', description: 'Registros ativos.', public: 'true' },
  pre_aggregations: {
    name: 'daily_rollup', type: 'rollup', measures: 'count, revenue', dimensions: 'status, airport_code',
    time_dimension: 'boarding_time', granularity: 'day', partition_granularity: 'month',
    refresh_key: 'every: 1 hour', external: 'true', scheduled_refresh: 'true', indexes: 'status, airport_code',
  },
};

function formProps(section: string, props: SchemaEntityFormProps): SchemaEntityFormProps {
  return { ...props, examples: props.examples || FORM_EXAMPLES[section] };
}

export function CubeForm({ source, ...props }: CubeFormProps) {
  return (
    <SchemaFormLayout
      section="cubes"
      fields={CUBE_PROPERTY_FIELDS}
      {...formProps('cubes', props)}
      cubeSource={source}
    />
  );
}

export function DimensionForm(props: SchemaEntityFormProps) {
  const isGeo = props.values.type === 'geo';
  const fields = isGeo
    ? ['title', 'name', 'description', 'type', 'latitude', 'longitude', 'primary_key', 'public', 'shown',
      'case', 'sub_query', 'format', 'meta']
    : DIMENSION_FIELDS;
  const values = isGeo
    ? {
      ...props.values,
      latitude: typeof props.values.latitude === 'object' ? props.values.latitude?.sql || '' : props.values.latitude || '',
      longitude: typeof props.values.longitude === 'object' ? props.values.longitude?.sql || '' : props.values.longitude || '',
    }
    : props.values;

  function onChange(key: string, value: any) {
    if (key === 'latitude' || key === 'longitude') {
      // Keep the editor draft as text. The schema shape ({ sql: value }) is
      // created when the dimension is saved.
      props.onChange(key, value || undefined);
      return;
    }

    if (key === 'type') {
      props.onChange(key, value);
      if (value === 'geo') {
        props.onChange('sql', undefined);
      } else {
        props.onChange('latitude', undefined);
        props.onChange('longitude', undefined);
      }
      return;
    }

    props.onChange(key, value);
  }

  return <SchemaFormLayout section="dimensions" fields={fields} {...formProps('dimensions', { ...props, values, onChange })} />;
}

export function MeasureForm(props: SchemaEntityFormProps) {
  return <SchemaFormLayout section="measures" fields={MEASURE_FIELDS} {...formProps('measures', props)} />;
}

export function HierarchyForm(props: SchemaEntityFormProps) {
  return <SchemaFormLayout section="hierarchies" fields={HIERARCHY_FIELDS} {...formProps('hierarchies', props)} />;
}

export function SegmentForm(props: SchemaEntityFormProps) {
  return <SchemaFormLayout section="segments" fields={SEGMENT_FIELDS} {...formProps('segments', props)} />;
}

export function JoinForm(props: SchemaEntityFormProps) {
  return <SchemaFormLayout section="joins" fields={JOIN_FIELDS} {...formProps('joins', props)} />;
}

export function PreAggregationForm(props: SchemaEntityFormProps) {
  return <SchemaFormLayout section="pre_aggregations" fields={PRE_AGGREGATION_FIELDS} {...formProps('pre_aggregations', props)} />;
}

function policyText(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function policyGroups(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

export function AccessPolicyForm({ values, onChange }: SchemaEntityFormProps) {
  const fields = [
    'group', 'groups', 'conditions', 'member_level', 'row_level', 'member_masking',
  ];
  const multilineFields = new Set(['conditions', 'member_level', 'row_level', 'member_masking']);
  const displayValues = Object.fromEntries(fields.map(key => [
    key,
    key === 'groups' ? policyGroups(values[key]) : policyText(values[key]),
  ]));

  return (
    <SchemaFormLayout
      section="access_policy"
      fields={fields}
      values={displayValues}
      onChange={onChange}
      multilineFields={multilineFields}
    />
  );
}
