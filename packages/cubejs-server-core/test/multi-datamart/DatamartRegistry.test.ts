import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { DatamartRegistry } from '../../src/core/multi-datamart/DatamartRegistry';

describe('DatamartRegistry', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cube-projects-'));
    await fs.writeJson(path.join(root, 'connections.json'), [{
      id: 'postgres-main', label: 'Postgres', dbType: 'postgres', fields: [],
    }]);
  });

  afterEach(async () => fs.remove(root));

  test('creates an isolated model directory without credentials', async () => {
    const registry = new DatamartRegistry(path.join(root, 'datamarts'), path.join(root, 'connections.json'));
    const datamart = await registry.create({ id: 'sales', name: 'Sales', connectionId: 'postgres-main' });

    expect(datamart.connectionId).toBe('postgres-main');
    expect(await fs.pathExists(path.join(root, 'datamarts', 'sales', 'model', 'cubes'))).toBe(true);
    expect(await fs.readFile(path.join(root, 'datamarts', 'sales', 'datamart.json'), 'utf8')).not.toContain('password');
  });

  test('accepts underscores in datamart ids', async () => {
    const registry = new DatamartRegistry(path.join(root, 'datamarts'), path.join(root, 'connections.json'));
    const datamart = await registry.create({ id: 'sales_ops-2026', name: 'Sales Ops', connectionId: 'postgres-main' });

    expect(datamart.id).toBe('sales_ops-2026');
    expect(await fs.pathExists(path.join(root, 'datamarts', 'sales_ops-2026'))).toBe(true);
  });

  test('rejects traversal and unknown presets', async () => {
    const registry = new DatamartRegistry(path.join(root, 'datamarts'), path.join(root, 'connections.json'));
    await expect(registry.create({ id: '../escape', name: 'Bad', connectionId: 'postgres-main' })).rejects.toThrow();
    await expect(registry.create({ id: 'valid', name: 'Bad', connectionId: 'missing' })).rejects.toThrow();
  });

  test('rejects secret defaults in the connection catalog', async () => {
    const connectionsFile = path.join(root, 'connections.json');
    await fs.writeJson(connectionsFile, [{
      id: 'unsafe',
      label: 'Unsafe',
      dbType: 'postgres',
      fields: [{ name: 'CUBEJS_DB_PASS', label: 'Password', secret: true }],
      defaults: { CUBEJS_DB_PASS: 'must-not-be-stored' },
    }]);
    const registry = new DatamartRegistry(path.join(root, 'datamarts'), connectionsFile);

    await expect(registry.connections()).rejects.toThrow(/cannot have a default/);
  });
});
