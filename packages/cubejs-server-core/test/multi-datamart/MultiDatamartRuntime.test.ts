import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { MultiDatamartRuntime } from '../../src/core/multi-datamart/MultiDatamartRuntime';

describe('MultiDatamartRuntime', () => {
  let root: string;
  let runtime: MultiDatamartRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cube-runtime-'));
    const connections = path.join(root, 'connections.json');
    await fs.writeJson(connections, [{ id: 'pg', label: 'PG', dbType: 'postgres', fields: [] }]);
    runtime = new MultiDatamartRuntime(
      path.join(root, 'datamarts'),
      connections,
      'a-secure-test-key-with-at-least-32-characters',
    );
    await runtime.registry.create({ id: 'sales', name: 'Sales', connectionId: 'pg' });
  });

  afterEach(async () => fs.remove(root));

  test('derives a datamart context from the encrypted session cookie', () => {
    const session = runtime.sessions.create('sales', { CUBEJS_DB_PASS: 'secret' });
    const req = {
      headers: { cookie: `cube_datamart_session=${session}` },
      header: () => 'sales',
    } as any;

    expect(runtime.contextFromRequest(req)).toEqual({
      datamartId: 'sales',
      datamartSessionId: session,
    });
  });

  test('rejects a route for a different datamart', () => {
    const session = runtime.sessions.create('sales', {});
    const req = {
      headers: { cookie: `cube_datamart_session=${session}` },
      header: () => 'finance',
    } as any;

    expect(() => runtime.contextFromRequest(req)).toThrow(/does not match/);
  });

  test('changes the schema version when a model file is saved', async () => {
    const context = { datamartId: 'sales', datamartSessionId: 'session' } as any;
    const cubeFile = path.join(root, 'datamarts', 'sales', 'model', 'cubes', 'orders.yml');
    await fs.writeFile(cubeFile, 'cubes:\n  - name: orders\n');

    const firstVersion = await runtime.schemaVersion(context);

    await fs.writeFile(cubeFile, 'cubes:\n  - name: orders\n    title: Orders\n');

    await expect(runtime.schemaVersion(context)).resolves.not.toBe(firstVersion);
  });
});
