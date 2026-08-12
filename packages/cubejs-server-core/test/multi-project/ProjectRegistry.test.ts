import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { ProjectRegistry } from '../../src/core/multi-project/ProjectRegistry';

describe('ProjectRegistry', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cube-projects-'));
    await fs.writeJson(path.join(root, 'connections.json'), [{
      id: 'postgres-main', label: 'Postgres', dbType: 'postgres', fields: [],
    }]);
  });

  afterEach(async () => fs.remove(root));

  test('creates an isolated model directory without credentials', async () => {
    const registry = new ProjectRegistry(path.join(root, 'projects'), path.join(root, 'connections.json'));
    const project = await registry.create({ id: 'sales', name: 'Sales', connectionId: 'postgres-main' });

    expect(project.connectionId).toBe('postgres-main');
    expect(await fs.pathExists(path.join(root, 'projects', 'sales', 'model', 'cubes'))).toBe(true);
    expect(await fs.readFile(path.join(root, 'projects', 'sales', 'project.json'), 'utf8')).not.toContain('password');
  });

  test('rejects traversal and unknown presets', async () => {
    const registry = new ProjectRegistry(path.join(root, 'projects'), path.join(root, 'connections.json'));
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
    const registry = new ProjectRegistry(path.join(root, 'projects'), connectionsFile);

    await expect(registry.connections()).rejects.toThrow(/cannot have a default/);
  });
});
