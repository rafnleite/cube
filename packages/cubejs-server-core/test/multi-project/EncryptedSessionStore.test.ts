import { EncryptedSessionStore } from '../../src/core/multi-project/EncryptedSessionStore';

describe('EncryptedSessionStore', () => {
  test('keeps credentials isolated by project', () => {
    const store = new EncryptedSessionStore('a-secure-test-key-with-at-least-32-characters');
    const id = store.create('finance', { CUBEJS_DB_PASS: 'secret' });

    expect(store.read(id, 'finance')).toEqual({ CUBEJS_DB_PASS: 'secret' });
    expect(store.projectId(id)).toBe('finance');
    expect(store.read(id, 'sales')).toBeNull();
  });

  test('rejects weak encryption keys', () => {
    expect(() => new EncryptedSessionStore('short')).toThrow(/at least 32/);
  });

  test('keeps sessions valid across server restarts with the same secret', () => {
    const secret = 'a-secure-test-key-with-at-least-32-characters';
    const firstServer = new EncryptedSessionStore(secret);
    const id = firstServer.create('finance', { CUBEJS_DB_PASS: 'secret' });
    const restartedServer = new EncryptedSessionStore(secret);

    expect(restartedServer.projectId(id)).toBe('finance');
    expect(restartedServer.read(id, 'finance')).toEqual({ CUBEJS_DB_PASS: 'secret' });
  });

  test('rejects tampered session tokens', () => {
    const store = new EncryptedSessionStore('a-secure-test-key-with-at-least-32-characters');
    const id = store.create('finance', { CUBEJS_DB_PASS: 'secret' });

    expect(store.projectId(`${id}tampered`)).toBeNull();
  });
});
