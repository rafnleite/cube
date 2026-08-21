import {
  CubeDimensionConverter,
  CubePreAggregationConverter,
  CubePrimaryKeyConverter,
  CubeSchemaConverter,
  CubeSchemaItemConverter,
} from '../../src';
import {
  createCubeSchema,
  createCubeSchemaWithCustomGranularitiesAndTimeShift,
  createCubeSchemaYaml,
  createECommerceSchema,
  createSchemaYaml
} from './utils';

const repo = {
  localPath: () => __dirname,
  dataSchemaFiles: () => Promise.resolve([
    { fileName: 'single_cube_no_preaggs.js', content: createCubeSchema({ name: 'single_cube' }) },
    { fileName: 'single_cube_with_preaggs.js',
      content: createCubeSchema({
        name: 'single_preagg_cube',
        preAggregations: 'existing_pre_agg: {\n  measures: [\n    single_preagg_cube.count\n  ],\n  timeDimension: single_preagg_cube.createdAt,\n  granularity: `month`\n}'
      })
    },
    { fileName: 'orders_and_users.js', content: createCubeSchemaWithCustomGranularitiesAndTimeShift('js_orders') },
    { fileName: 'single_cube.yaml', content: createCubeSchemaYaml({ name: 'yml_orders', sqlTable: 'yml_orders' }) },
    { fileName: 'multi_ecom.yaml', content: createSchemaYaml(createECommerceSchema()) },
    { fileName: 'empty1.yaml', content: '       ' },
    { fileName: 'empty2.yaml', content: 'string     ' },
    { fileName: 'empty3.yaml', content: 'cubes: string     ' },
    { fileName: 'empty4.yaml', content: '# just comment  ' },
  ])
};

describe('CubeSchemaConverter', () => {
  it('converts all schema repository models (no changes, without additional converters)', async () => {
    const schemaConverter = new CubeSchemaConverter(repo, []);
    await schemaConverter.generate();
    const regeneratedFiles = schemaConverter.getSourceFiles();
    regeneratedFiles.forEach((regeneratedFile) => {
      expect(regeneratedFile.source).toMatchSnapshot(regeneratedFile.fileName);
    });
  });

  it('serializes geo SQL entered without YAML quotes', async () => {
    const geoRepository = {
      localPath: () => __dirname,
      dataSchemaFiles: () => Promise.resolve([{
        fileName: 'locations.yml',
        content: `cubes:
  - name: locations
    sql_table: public.locations
`
      }])
    };
    const schemaConverter = new CubeSchemaConverter(geoRepository, [new CubeSchemaItemConverter({
      cubeName: 'locations',
      section: 'dimensions',
      values: {
        name: 'coordinates',
        type: 'geo',
        latitude: { sql: '{CUBE}.latitude' },
        longitude: { sql: '({CUBE}.coordinates)[0]' },
      },
    })]);

    await schemaConverter.generate('locations');

    const source = schemaConverter.getSourceFiles()[0].source;
    expect(source).toContain('sql: "{CUBE}.latitude"');
    expect(source).toContain('sql: ({CUBE}.coordinates)[0]');
  });

  it('appends new items and keeps primary dimensions before regular dimensions', async () => {
    const orderingRepository = {
      localPath: () => __dirname,
      dataSchemaFiles: () => Promise.resolve([{
        fileName: 'ordering.yml',
        content: `cubes:
  - name: ordering
    sql_table: public.ordering
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: status
        sql: status
        type: string
    measures:
      - name: count
        type: count
`
      }])
    };

    const schemaConverter = new CubeSchemaConverter(orderingRepository, [
      new CubeSchemaItemConverter({
        cubeName: 'ordering',
        section: 'dimensions',
        values: { name: 'created_at', sql: 'created_at', type: 'time' },
      }),
      new CubeSchemaItemConverter({
        cubeName: 'ordering',
        section: 'dimensions',
        values: { name: 'tenant_id', sql: 'tenant_id', type: 'number', primary_key: true },
      }),
      new CubeSchemaItemConverter({
        cubeName: 'ordering',
        section: 'measures',
        values: { name: 'total', type: 'sum', sql: 'amount' },
      }),
    ]);

    await schemaConverter.generate('ordering');
    const source = schemaConverter.getSourceFiles()[0].source;
    expect(source.indexOf('name: id')).toBeLessThan(source.indexOf('name: tenant_id'));
    expect(source.indexOf('name: tenant_id')).toBeLessThan(source.indexOf('name: status'));
    expect(source.indexOf('name: status')).toBeLessThan(source.indexOf('name: created_at'));
    expect(source.indexOf('name: count')).toBeLessThan(source.indexOf('name: total'));
  });

  it('appends dimensions created through the dedicated dimension converter', async () => {
    const dimensionRepository = {
      localPath: () => __dirname,
      dataSchemaFiles: () => Promise.resolve([{
        fileName: 'dimension-order.yml',
        content: `cubes:
  - name: dimension_order
    sql_table: public.dimension_order
    dimensions:
      - name: sk_regiao_fiscal
        sql: sk_regiao_fiscal
        primary_key: true
      - name: nm_regiao_fiscal
        sql: nm_regiao_fiscal
`
      }])
    };

    const schemaConverter = new CubeSchemaConverter(dimensionRepository, [new CubeDimensionConverter({
      cubeName: 'dimension_order',
      name: 'populacao',
      sql: 'populacao',
      type: 'number',
    })]);

    await schemaConverter.generate('dimension_order');
    const source = schemaConverter.getSourceFiles()[0].source;
    expect(source.indexOf('name: nm_regiao_fiscal')).toBeLessThan(source.indexOf('name: populacao'));
    expect(source.indexOf('name: sk_regiao_fiscal')).toBeLessThan(source.indexOf('name: populacao'));
  });

  it('inserts new sections in documented order and primary keys at the end of the primary group', async () => {
    const orderingRepository = {
      localPath: () => __dirname,
    dataSchemaFiles: () => Promise.resolve([{
      fileName: 'section-order.yml',
      content: `cubes:
  - name: section_order
    sql_table: public.section_order
    measures:
      - name: count
        type: count
`
      }])
    };

    const schemaConverter = new CubeSchemaConverter(orderingRepository, [
      new CubeDimensionConverter({
        cubeName: 'section_order',
        name: 'created_at',
        sql: 'created_at',
        type: 'time',
      }),
      new CubePrimaryKeyConverter({
        cubeName: 'section_order',
        columnName: 'tenant_id',
        columnType: 'number',
      }),
    ]);

    await schemaConverter.generate('section_order');
    const source = schemaConverter.getSourceFiles()[0].source;
    expect(source.indexOf('dimensions:')).toBeLessThan(source.indexOf('measures:'));
    expect(source.indexOf('name: tenant_id')).toBeLessThan(source.indexOf('name: created_at'));
  });

  it('throws error if can not parse source schema js file (syntax error)', async () => {
    const lRepo = {
      localPath: () => __dirname,
      dataSchemaFiles: () => Promise.resolve([
        { fileName: 'model.js', content: 'cube(\'name, {\n        description: \'test cube from createCubeSchema\',' }
      ])
    };
    const schemaConverter = new CubeSchemaConverter(lRepo, []);

    try {
      await schemaConverter.generate();
      throw new Error('should throw earlier');
    } catch (e: any) {
      expect(e.toString()).toMatch(/Syntax error during 'model.js' parsing/);
    }
  });

  it('throws error if can not parse source schema js file (no cube name)', async () => {
    const lRepo = {
      localPath: () => __dirname,
      dataSchemaFiles: () => Promise.resolve([
        { fileName: 'model.js', content: 'cube({}, {\n        description: \'test cube from createCubeSchema\'});' }
      ])
    };
    const schemaConverter = new CubeSchemaConverter(lRepo, []);

    try {
      await schemaConverter.generate();
      throw new Error('should throw earlier');
    } catch (e: any) {
      expect(e.toString()).toMatch(/Error parsing model.js/);
    }
  });

  it('adds a pre-aggregation to YAML model (w/o pre-agg) using CubePreAggregationConverter', async () => {
    const cubeName = 'yml_orders';
    const preAggregationName = 'yml_orders_main';
    const code = `
name: yml_orders_main
measures:
  - yml_orders.count
timeDimension: yml_orders.createdAt
granularity: day
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    await schemaConverter.generate(cubeName);
    const regeneratedFiles = schemaConverter.getSourceFiles();
    regeneratedFiles.forEach((regeneratedFile) => {
      expect(regeneratedFile.source).toMatchSnapshot(regeneratedFile.fileName);
    });
  });

  it('adds a pre-aggregation to JS model (w/o pre-agg) using CubePreAggregationConverter', async () => {
    const cubeName = 'js_orders';
    const preAggregationName = 'js_orders_main';
    const code = `{
  measures: [
    js_orders.count
  ],
  timeDimension: js_orders.createdAt,
  granularity: \`day\`
}
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    await schemaConverter.generate(cubeName);
    const regeneratedFiles = schemaConverter.getSourceFiles();
    regeneratedFiles.forEach((regeneratedFile) => {
      expect(regeneratedFile.source).toMatchSnapshot(regeneratedFile.fileName);
    });
  });

  it('adds a pre-aggregation to JS model (with empty pre-aggs property) using CubePreAggregationConverter', async () => {
    const cubeName = 'single_cube';
    const preAggregationName = 'single_cube_main';
    const code = `{
  measures: [
    js_orders.count
  ],
  timeDimension: js_orders.createdAt,
  granularity: \`day\`
}
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    await schemaConverter.generate(cubeName);
    const regeneratedFiles = schemaConverter.getSourceFiles();
    regeneratedFiles.forEach((regeneratedFile) => {
      expect(regeneratedFile.source).toMatchSnapshot(regeneratedFile.fileName);
    });
  });

  it('adds a pre-aggregation to JS model (with existing pre-aggs) using CubePreAggregationConverter', async () => {
    const cubeName = 'single_preagg_cube';
    const preAggregationName = 'single_preagg_cube_main';
    const code = `{
  measures: [
    single_preagg_cube.count
  ],
  timeDimension: single_preagg_cube.createdAt,
  granularity: \`day\`
}
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    await schemaConverter.generate(cubeName);
    const regeneratedFiles = schemaConverter.getSourceFiles();
    regeneratedFiles.forEach((regeneratedFile) => {
      expect(regeneratedFile.source).toMatchSnapshot(regeneratedFile.fileName);
    });
  });

  it('adds a pre-aggregation to YAML model (with pre-aggs) using CubePreAggregationConverter', async () => {
    const cubeName = 'orders';
    const preAggregationName = 'orders_main';
    const code = `
name: orders_main
measures:
  - orders.count
timeDimension: orders.created_at
granularity: day
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    await schemaConverter.generate(cubeName);
    const regeneratedFiles = schemaConverter.getSourceFiles();
    regeneratedFiles.forEach((regeneratedFile) => {
      expect(regeneratedFile.source).toMatchSnapshot(regeneratedFile.fileName);
    });
  });

  it('throws error for malformed (not object) yaml pre-agg code', async () => {
    const cubeName = 'orders';
    const preAggregationName = 'orders_main';
    const code = `
- name: orders_main
  measures:
    - orders.count
  timeDimension: orders.created_at
  granularity: day
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    try {
      await schemaConverter.generate(cubeName);
      throw new Error('should throw earlier');
    } catch (e: any) {
      expect(e.toString()).toMatch(/Pre-aggregation YAML must be a map\/object/);
    }
  });

  it('throws error if can not parse source schema yaml file (pre-aggs is not a map)', async () => {
    const lRepo = {
      localPath: () => __dirname,
      dataSchemaFiles: () => Promise.resolve([
        { fileName: 'model.yaml', content: `
    cubes:
      - name: orders
        sql_table: table
        pre_aggregations:
          name: pre-agg1
        ` }
      ])
    };

    const cubeName = 'orders';
    const preAggregationName = 'orders_main';
    const code = `
name: orders_main
measures:
  - orders.count
timeDimension: orders.created_at
granularity: day
`;

    const schemaConverter = new CubeSchemaConverter(lRepo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    try {
      await schemaConverter.generate();
      throw new Error('should throw earlier');
    } catch (e: any) {
      expect(e.toString()).toMatch(/'pre_aggregations' must be a sequence/);
    }
  });

  it('throws error for malformed (not object) js pre-agg code', async () => {
    const cubeName = 'single_cube';
    const preAggregationName = 'orders_main';
    const code = `[{
  measures: [
    js_orders.count
  ],
  timeDimension: js_orders.createdAt,
  granularity: \`day\`
}]
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    try {
      await schemaConverter.generate(cubeName);
      throw new Error('should throw earlier');
    } catch (e: any) {
      expect(e.toString()).toMatch(/Pre-aggregation definition is malformed/);
    }
  });

  it('throws error if pre-aggregation with the same name exists (yaml model)', async () => {
    const cubeName = 'orders';
    const preAggregationName = 'orders_by_day_with_day';
    const code = `
name: orders_by_day_with_day
measures:
  - orders.count
timeDimension: orders.created_at
granularity: day
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    try {
      await schemaConverter.generate(cubeName);
      throw new Error('should throw earlier');
    } catch (e: any) {
      expect(e.toString()).toMatch(/Pre-aggregation 'orders_by_day_with_day' is already defined/);
    }
  });

  it('throws error if pre-aggregation with the same name exists (js model)', async () => {
    const cubeName = 'single_preagg_cube';
    const preAggregationName = 'existing_pre_agg';
    const code = `{
  measures: [
    single_preagg_cube.count
  ],
  timeDimension: single_preagg_cube.createdAt,
  granularity: \`day\`
}
`;

    const schemaConverter = new CubeSchemaConverter(repo, [new CubePreAggregationConverter({
      cubeName,
      preAggregationName,
      code
    })]);

    try {
      await schemaConverter.generate(cubeName);
      throw new Error('should throw earlier');
    } catch (e: any) {
      expect(e.toString()).toMatch(/Pre-aggregation 'existing_pre_agg' is already defined/);
    }
  });
});
