import type { Request as ExpressRequest } from 'express';
import path from 'path';

import { FileRepository } from '@cubejs-backend/shared';
import type { BaseDriver } from '@cubejs-backend/query-orchestrator';

import { lookupDriverClass } from '../DriverResolvers';
import type { DatabaseType, DriverConfig, DriverContext, RequestContext } from '../types';
import { EncryptedSessionStore } from './EncryptedSessionStore';
import { DatamartRegistry } from './DatamartRegistry';
import type {
  ConnectionField,
  ConnectionPreset,
  DatamartCredentials,
  MultiDatamartContext,
} from './types';

const DEFAULT_DRIVER_OPTIONS: Record<string, string> = {
  CUBEJS_DB_HOST: 'host',
  CUBEJS_DB_PORT: 'port',
  CUBEJS_DB_NAME: 'database',
  CUBEJS_DB_USER: 'user',
  CUBEJS_DB_PASS: 'password',
  CUBEJS_DB_URL: 'url',
};

export class MultiDatamartRuntime {
  public readonly registry: DatamartRegistry;

  public readonly sessions: EncryptedSessionStore;

  public static fromEnv(): MultiDatamartRuntime | undefined {
    const secret = process.env.CUBEJS_DATAMART_SESSION_SECRET;
    if (!secret) return undefined;
    return new MultiDatamartRuntime(
      path.resolve(process.env.CUBEJS_DATAMARTS_ROOT || 'datamarts'),
      path.resolve(process.env.CUBEJS_CONNECTIONS_FILE || 'config/connections.json'),
      secret,
    );
  }

  public constructor(datamartsRoot: string, connectionsFile: string, secret: string) {
    this.registry = new DatamartRegistry(datamartsRoot, connectionsFile);
    this.sessions = new EncryptedSessionStore(secret);
  }

  public contextFromRequest(req: ExpressRequest): MultiDatamartContext {
    const routeDatamartId = req.header('x-cube-datamart-id');
    const sessionId = this.cookie(req, 'cube_datamart_session');
    if (!sessionId) throw new Error('Datamart credentials are required');

    const sessionDatamartId = this.sessions.datamartId(sessionId);
    if (!sessionDatamartId) throw new Error('Datamart session is missing or expired');
    if (routeDatamartId && routeDatamartId !== sessionDatamartId) {
      throw new Error('Datamart route does not match the authenticated datamart session');
    }
    return { datamartId: sessionDatamartId, datamartSessionId: sessionId };
  }

  public activeDatamart(req: ExpressRequest): string | null {
    const sessionId = this.cookie(req, 'cube_datamart_session');
    return sessionId ? this.sessions.datamartId(sessionId) : null;
  }

  public datamartId(context: RequestContext | MultiDatamartContext): string {
    const datamartId = (context as Partial<MultiDatamartContext>).datamartId;
    if (!datamartId) throw new Error('Datamart context is required');
    return datamartId;
  }

  public repository(context: RequestContext | MultiDatamartContext): FileRepository {
    return new FileRepository(this.registry.modelPath(this.datamartId(context)));
  }

  public async driver(context: DriverContext): Promise<DriverConfig> {
    const datamartId = this.datamartId(context);
    const sessionId = (context as DriverContext & Partial<MultiDatamartContext>).datamartSessionId;
    if (!sessionId) throw new Error('Datamart session is required');
    const credentials = this.sessions.read(sessionId, datamartId);
    if (!credentials) throw new Error('Datamart session is missing or expired');
    const datamart = await this.registry.get(datamartId);
    const connection = (await this.registry.connections()).find(item => item.id === datamart.connectionId);
    if (!connection) throw new Error(`Unknown connection preset: ${datamart.connectionId}`);
    return this.createDriverConfig(connection, credentials, {
      dataSource: context.dataSource || 'default',
      preAggregations: context.preAggregations || false,
    });
  }

  public async testSession(sessionId: string, datamartId: string): Promise<void> {
    const credentials = this.sessions.read(sessionId, datamartId);
    if (!credentials) throw new Error('Datamart session is missing or expired');
    const driver = await this.createDriver(datamartId, credentials, {
      datamartId,
      datamartSessionId: sessionId,
      dataSource: 'default',
      securityContext: null,
      requestId: `datamart-session-${datamartId}`,
    } as DriverContext);
    try {
      await driver.testConnection();
    } finally {
      await driver.release?.();
    }
  }

  public async testConnectionPreset(
    connectionId: string,
    credentials: DatamartCredentials,
  ): Promise<void> {
    const connection = (await this.registry.connections()).find(item => item.id === connectionId);
    if (!connection) throw new Error(`Unknown connection preset: ${connectionId}`);
    const driver = await this.createDriverFromConnection(connection, credentials, {
      dataSource: 'default',
      preAggregations: false,
    });
    try {
      await driver.testConnection();
    } finally {
      await driver.release?.();
    }
  }

  protected async createDriver(
    datamartId: string,
    credentials: DatamartCredentials,
    context: DriverContext,
  ): Promise<BaseDriver> {
    const datamart = await this.registry.get(datamartId);
    const connection = (await this.registry.connections()).find(item => item.id === datamart.connectionId);
    if (!connection) throw new Error(`Unknown connection preset: ${datamart.connectionId}`);
    return this.createDriverFromConnection(connection, credentials, {
      dataSource: context.dataSource || 'default',
      preAggregations: context.preAggregations || false,
    });
  }

  protected async createDriverFromConnection(
    connection: ConnectionPreset,
    credentials: DatamartCredentials,
    context: {
      dataSource: string;
      preAggregations: boolean;
    },
  ): Promise<BaseDriver> {
    const config = this.createDriverConfig(connection, credentials, context);

    if (connection.dbType === 'odbc') {
      throw new Error('The ODBC Node binding is installed, but the Cube ODBC driver is not implemented yet');
    }

    const Driver = lookupDriverClass(connection.dbType as DatabaseType);
    return new Driver(config);
  }

  protected createDriverConfig(
    connection: ConnectionPreset,
    credentials: DatamartCredentials,
    context: {
      dataSource: string;
      preAggregations: boolean;
    },
  ): DriverConfig {
    if (connection.dbType === 'odbc') {
      throw new Error('The ODBC Node binding is installed, but the Cube ODBC driver is not implemented yet');
    }

    const config = Object.fromEntries(connection.fields.flatMap((field: ConnectionField) => {
      const value = credentials[field.name];
      if (value === undefined || value === '') return [];
      const option = field.driverOption || DEFAULT_DRIVER_OPTIONS[field.name];
      if (!option) throw new Error(`Connection field ${field.name} must declare driverOption`);
      return [[option, option === 'port' ? Number(value) : value]];
    }));

    return {
      type: connection.dbType as DatabaseType,
      ...config,
      dataSource: context.dataSource,
      preAggregations: context.preAggregations,
    };
  }

  protected cookie(req: ExpressRequest, name: string): string | undefined {
    for (const cookie of req.headers.cookie?.split(';') || []) {
      const [key, ...value] = cookie.trim().split('=');
      if (key === name) return decodeURIComponent(value.join('='));
    }
    return undefined;
  }
}
