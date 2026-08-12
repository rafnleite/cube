import crypto from 'crypto';

import type { ProjectCredentials } from './types';

type SessionPayload = {
  projectId: string;
  expiresAt: number;
  credentials: ProjectCredentials;
};

const TOKEN_VERSION = 'v1';
const TOKEN_AAD = Buffer.from('cube-project-session-v1', 'utf8');

export class EncryptedSessionStore {
  protected readonly key: Buffer;

  protected readonly revoked = new Set<string>();

  public constructor(secret: string, protected readonly ttlMs = 8 * 60 * 60 * 1000) {
    if (!secret || secret.length < 32) {
      throw new Error('CUBEJS_PROJECT_SESSION_SECRET must contain at least 32 characters');
    }
    this.key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  }

  public create(projectId: string, credentials: ProjectCredentials): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(TOKEN_AAD);
    const payload: SessionPayload = {
      projectId,
      expiresAt: Date.now() + this.ttlMs,
      credentials,
    };
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);

    return [
      TOKEN_VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  public read(id: string, projectId: string): ProjectCredentials | null {
    const session = this.decode(id);
    if (!session || session.projectId !== projectId) return null;
    return session.credentials;
  }

  public projectId(id: string): string | null {
    return this.decode(id)?.projectId || null;
  }

  public delete(id: string): void {
    this.revoked.add(id);
  }

  protected decode(id: string): SessionPayload | null {
    if (!id || this.revoked.has(id)) return null;

    try {
      const [version, ivValue, authTagValue, encryptedValue, ...extra] = id.split('.');
      if (
        version !== TOKEN_VERSION ||
        !ivValue ||
        !authTagValue ||
        !encryptedValue ||
        extra.length
      ) {
        return null;
      }

      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivValue, 'base64url')
      );
      decipher.setAAD(TOKEN_AAD);
      decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));
      const cleartext = Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      const payload = JSON.parse(cleartext) as SessionPayload;

      if (
        !payload ||
        typeof payload.projectId !== 'string' ||
        typeof payload.expiresAt !== 'number' ||
        payload.expiresAt <= Date.now() ||
        !payload.credentials ||
        typeof payload.credentials !== 'object'
      ) {
        return null;
      }

      return payload;
    } catch (_e) {
      return null;
    }
  }
}
