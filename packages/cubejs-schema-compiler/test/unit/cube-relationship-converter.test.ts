import {
  CubeRelationshipConverter,
  CubeRelationshipReader,
  CubeSchemaConverter,
} from '../../src';

const repository = (files: { fileName: string; content: string }[]) => ({
  localPath: () => __dirname,
  dataSchemaFiles: () => Promise.resolve(files),
});

describe('CubeRelationshipConverter', () => {
  test('creates, reads, updates, and deletes a YAML relationship', async () => {
    const original = `# keep this comment
cubes:
  - name: orders
    title: Pedidos
    sql_table: public.orders
    joins: []
`;
    const create = new CubeSchemaConverter(repository([
      { fileName: 'orders.yml', content: original },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'orders',
      targetCube: 'customers',
      sourceColumn: 'customer_id',
      targetColumn: 'id',
      relationship: 'many_to_one',
      operation: 'create',
    })]);

    await create.generate('orders');
    const created = create.getSourceFiles()[0].source;
    expect(created).toContain('# keep this comment');
    expect(created).toContain('name: customers');
    expect(created).toContain('{CUBE}.customer_id = {customers}.id');
    expect(created).toContain('relationship: many_to_one');

    const update = new CubeSchemaConverter(repository([
      { fileName: 'orders.yml', content: created },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'orders',
      targetCube: 'customers',
      sourceColumn: 'billing_customer_id',
      targetColumn: 'customer_id',
      relationship: 'one_to_one',
      operation: 'update',
    })]);
    await update.generate('orders');
    const updated = update.getSourceFiles()[0].source;
    expect(updated).toContain('{CUBE}.billing_customer_id = {customers}.customer_id');
    expect(updated).toContain('relationship: one_to_one');

    const remove = new CubeSchemaConverter(repository([
      { fileName: 'orders.yml', content: updated },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'orders',
      targetCube: 'customers',
      operation: 'delete',
    })]);
    await remove.generate('orders');
    expect(remove.getSourceFiles()[0].source).not.toContain('name: customers');
  });

  test('creates, updates, and deletes a JavaScript relationship', async () => {
    const original = `cube('Orders', {
  sql: \`SELECT * FROM public.orders\`,
  joins: {}
});`;
    const create = new CubeSchemaConverter(repository([
      { fileName: 'Orders.js', content: original },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'Orders',
      targetCube: 'Customers',
      sourceColumn: 'customer_id',
      targetColumn: 'id',
      relationship: 'many_to_one',
      operation: 'create',
    })]);

    await create.generate('Orders');
    const created = create.getSourceFiles()[0].source;
    expect(created).toContain('Customers: {');
    expect(created).toContain('${CUBE}.customer_id = ${Customers}.id');
    expect(created).toMatch(/relationship: ["']many_to_one["']/);

    const update = new CubeSchemaConverter(repository([
      { fileName: 'Orders.js', content: created },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'Orders',
      targetCube: 'Customers',
      sourceColumn: 'account_id',
      targetColumn: 'id',
      relationship: 'one_to_many',
      operation: 'update',
    })]);
    await update.generate('Orders');
    const updated = update.getSourceFiles()[0].source;
    expect(updated).toContain('${CUBE}.account_id = ${Customers}.id');
    expect(updated).toMatch(/relationship: ["']one_to_many["']/);

    const remove = new CubeSchemaConverter(repository([
      { fileName: 'Orders.js', content: updated },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'Orders',
      targetCube: 'Customers',
      operation: 'delete',
    })]);
    await remove.generate('Orders');
    expect(remove.getSourceFiles()[0].source).not.toContain('Customers: {');
  });

  test('does not overwrite an existing relationship during create', async () => {
    const existing = `cubes:
  - name: orders
    sql_table: public.orders
    joins:
      - name: customers
        sql: "{CUBE}.customer_id = {customers}.id"
        relationship: many_to_one
`;
    const converter = new CubeSchemaConverter(repository([
      { fileName: 'orders.yml', content: existing },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'orders',
      targetCube: 'customers',
      sourceColumn: 'other_id',
      targetColumn: 'id',
      relationship: 'one_to_one',
      operation: 'create',
    })]);

    await expect(converter.generate('orders')).rejects.toThrow(/already exists/);
  });

  test('reads YAML and JavaScript model metadata and join columns', async () => {
    const reader = new CubeRelationshipReader();
    const converter = new CubeSchemaConverter(repository([
      {
        fileName: 'orders.yml',
        content: `cubes:
  - name: orders
    title: Pedidos
    sql_table: public.orders
    joins:
      - name: customers
        sql: "{CUBE}.customer_id = {customers}.id"
        relationship: many_to_one
`,
      },
      {
        fileName: 'Customers.js',
        content: `cube('Customers', {
  title: 'Clientes',
  sql: \`SELECT id FROM public.customers\`
});`,
      },
    ]), [reader]);

    await converter.generate();
    expect(reader.getModels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'orders', title: 'Pedidos', fileType: 'yaml' }),
      expect.objectContaining({ name: 'Customers', title: 'Clientes', fileType: 'javascript' }),
    ]));
    expect(reader.getRelationships()).toContainEqual(expect.objectContaining({
      sourceCube: 'orders',
      targetCube: 'customers',
      sourceColumn: 'customer_id',
      targetColumn: 'id',
      relationship: 'many_to_one',
    }));
  });

  test('reads exact joins using raw columns and member references, but not composite conditions', async () => {
    const reader = new CubeRelationshipReader();
    const converter = new CubeSchemaConverter(repository([
      {
        fileName: 'orders.yml',
        content: `cubes:
  - name: orders
    sql_table: public.orders
    joins:
      - name: customers
        sql: "{CUBE.customer_id} = {customers.id}"
        relationship: many_to_one
      - name: tenants
        sql: "{CUBE}.tenant_id = {tenants}.id AND {CUBE}.active = {tenants}.active"
        relationship: many_to_one
`,
      },
      {
        fileName: 'LineItems.js',
        content: "cube('LineItems', { sql: `SELECT * FROM line_items`, joins: { Products: { sql: `${CUBE.product_id} = ${Products.id}`, relationship: 'many_to_one' } } });",
      },
    ]), [reader]);

    await converter.generate();
    expect(reader.getRelationships()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceCube: 'orders',
        targetCube: 'customers',
        sourceColumn: 'customer_id',
        targetColumn: 'id',
      }),
      expect.objectContaining({
        sourceCube: 'LineItems',
        targetCube: 'Products',
        sourceColumn: 'product_id',
        targetColumn: 'id',
      }),
    ]));
    const composite = reader.getRelationships().find(join => join.targetCube === 'tenants');
    expect(composite?.sourceColumn).toBeUndefined();
    expect(composite?.targetColumn).toBeUndefined();
  });

  test('creates and reads a relationship in a JavaScript joins array', async () => {
    const original = `cube('Orders', {
  sql: \`SELECT * FROM orders\`,
  joins: [{
    name: 'Suppliers',
    sql: \`\${CUBE}.supplier_id = \${Suppliers}.id\`,
    relationship: 'many_to_one'
  }]
});`;
    const create = new CubeSchemaConverter(repository([
      { fileName: 'Orders.js', content: original },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'Orders',
      targetCube: 'Customers',
      sourceColumn: 'customer_id',
      targetColumn: 'id',
      relationship: 'many_to_one',
      operation: 'create',
    })]);

    await create.generate('Orders');
    const created = create.getSourceFiles()[0].source;
    expect(created).toMatch(/name: ["']Suppliers["']/);
    expect(created).toMatch(/name: ["']Customers["']/);

    const reader = new CubeRelationshipReader();
    const read = new CubeSchemaConverter(repository([
      { fileName: 'Orders.js', content: created },
    ]), [reader]);
    await read.generate();
    expect(reader.getRelationships()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceCube: 'Orders', targetCube: 'Suppliers' }),
      expect.objectContaining({
        sourceCube: 'Orders',
        targetCube: 'Customers',
        sourceColumn: 'customer_id',
        targetColumn: 'id',
      }),
    ]));
  });

  test('updates and deletes a JavaScript array relationship while preserving extra properties', async () => {
    const original = `cube('Orders', {
  sql: \`SELECT * FROM orders\`,
  joins: [{
    name: 'Customers',
    sql: \`\${CUBE}.customer_id = \${Customers}.id\`,
    relationship: 'many_to_one',
    meta: { owner: 'manual' }
  }]
});`;
    const update = new CubeSchemaConverter(repository([
      { fileName: 'Orders.js', content: original },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'Orders',
      targetCube: 'Customers',
      sourceColumn: 'billing_customer_id',
      targetColumn: 'customer_id',
      relationship: 'one_to_one',
      operation: 'update',
    })]);

    await update.generate('Orders');
    const updated = update.getSourceFiles()[0].source;
    expect(updated).toContain('owner: \'manual\'');
    expect(updated).toContain('${CUBE}.billing_customer_id = ${Customers}.customer_id');

    const remove = new CubeSchemaConverter(repository([
      { fileName: 'Orders.js', content: updated },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'Orders',
      targetCube: 'Customers',
      operation: 'delete',
    })]);
    await remove.generate('Orders');
    expect(remove.getSourceFiles()[0].source).not.toMatch(/name: ["']Customers["']/);
  });

  test.each([
    {
      name: 'a top-level spread during create',
      operation: 'create' as const,
      content: `const baseCube = { joins: {} };
cube('Orders', { ...baseCube, sql: \`SELECT * FROM orders\` });`,
    },
    {
      name: 'a dynamic relationship during update',
      operation: 'update' as const,
      content: `const sharedJoin = { sql: \`\${CUBE}.customer_id = \${Customers}.id\`, relationship: 'many_to_one' };
cube('Orders', { sql: \`SELECT * FROM orders\`, joins: { Customers: sharedJoin } });`,
    },
    {
      name: 'a relationships spread during delete',
      operation: 'delete' as const,
      content: `const sharedJoins = {};
cube('Orders', { sql: \`SELECT * FROM orders\`, joins: { ...sharedJoins, Customers: { sql: \`\${CUBE}.customer_id = \${Customers}.id\`, relationship: 'many_to_one' } } });`,
    },
  ])('rejects $name instead of silently replacing model code', async ({ operation, content }) => {
    const converter = new CubeSchemaConverter(repository([
      { fileName: 'Orders.js', content },
    ]), [new CubeRelationshipConverter({
      sourceCube: 'Orders',
      targetCube: 'Customers',
      sourceColumn: 'customer_id',
      targetColumn: 'id',
      relationship: 'many_to_one',
      operation,
    })]);

    await expect(converter.generate('Orders')).rejects.toThrow(/Cannot safely edit|static object or array/);
  });
});
