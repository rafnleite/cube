import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { MultiProjectRuntime } from '../../src/core/multi-project/MultiProjectRuntime';

describe('MultiProjectRuntime', () => {
  let root: string;
  let runtime: MultiProjectRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cube-runtime-'));
    const connections = path.join(root, 'connections.json');
    await fs.writeJson(connections, [{ id: 'pg', label: 'PG', dbType: 'postgres', fields: [] }]);
    runtime = new MultiProjectRuntime(
      path.join(root, 'projects'),
      connections,
      'a-secure-test-key-with-at-least-32-characters',
    );
    await runtime.registry.create({ id: 'sales', name: 'Sales', connectionId: 'pg' });
  });

  afterEach(async () => fs.remove(root));

  test('derives a project context from the encrypted session cookie', () => {
    const session = runtime.sessions.create('sales', { CUBEJS_DB_PASS: 'secret' });
    const req = {
      headers: { cookie: `cube_project_session=${session}` },
      header: () => 'sales',
    } as any;

    expect(runtime.contextFromRequest(req)).toEqual({
      projectId: 'sales',
      projectSessionId: session,
    });
  });

  test('rejects a route for a different project', () => {
    const session = runtime.sessions.create('sales', {});
    const req = {
      headers: { cookie: `cube_project_session=${session}` },
      header: () => 'finance',
    } as any;

    expect(() => runtime.contextFromRequest(req)).toThrow(/does not match/);
  });
});
