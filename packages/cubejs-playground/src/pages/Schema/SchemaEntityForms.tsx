import React from 'react';
import { TableColumn } from './cubeSchemaUtils';
import { CUBE_PROPERTY_FIELDS, SchemaFormLayout } from './SchemaFormLayout';

export type SchemaEntityFormProps = {
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
  columns?: TableColumn[];
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
  'rolling_window', 'filters', 'meta',
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
    case: "WHEN {CUBE}.status = 'cancelled' THEN 'Cancelado'", sub_query: 'true', format: 'currency', meta: '{ source: ERP }',
  },
  measures: {
    name: 'revenue', sql: '{CUBE}.amount', type: 'sum', public: 'true', title: 'Receita',
    description: 'Valor total das vendas.', format: 'currency', drill_members: 'id, customer_name',
    rolling_window: 'trailing: 7 day', filters: "{CUBE}.status = 'confirmed'", meta: '{ source: ERP }',
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
      props.onChange(key, value ? { sql: value } : undefined);
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
