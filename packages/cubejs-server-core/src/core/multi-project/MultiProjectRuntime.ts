import type { Request as ExpressRequest } from 'express';
import path from 'path';

import { FileRepository } from '@cubejs-backend/shared';
import type { BaseDriver } from '@cubejs-backend/query-orchestrator';

import { lookupDriverClass } from '../DriverResolvers';
import type { DatabaseType, DriverConfig, DriverContext, RequestContext } from '../types';
import { EncryptedSessionStore } from './EncryptedSessionStore';
import { ProjectRegistry } from './ProjectRegistry';
import type {
  ConnectionField,
  ConnectionPreset,
  MultiProjectContext,
  ProjectCredentials,
} from './types';

const DEFAULT_DRIVER_OPTIONS: Record<string, string> = {
  CUBEJS_DB_HOST: 'host',
  CUBEJS_DB_PORT: 'port',
  CUBEJS_DB_NAME: 'database',
  CUBEJS_DB_USER: 'user',
  CUBEJS_DB_PASS: 'password',
  CUBEJS_DB_URL: 'url',
};

export class MultiProjectRuntime {
  public readonly registry: ProjectRegistry;

  public readonly sessions: EncryptedSessionStore;

  public static fromEnv(): MultiProjectRuntime | undefined {
    const secret = process.env.CUBEJS_PROJECT_SESSION_SECRET;
    if (!secret) return undefined;
    return new MultiProjectRuntime(
      path.resolve(process.env.CUBEJS_PROJECTS_ROOT || 'projects'),
      path.resolve(process.env.CUBEJS_CONNECTIONS_FILE || 'config/connections.json'),
      secret,
    );
  }

  public constructor(projectsRoot: string, connectionsFile: string, secret: string) {
    this.registry = new ProjectRegistry(projectsRoot, connectionsFile);
    this.sessions = new EncryptedSessionStore(secret);
  }

  public contextFromRequest(req: ExpressRequest): MultiProjectContext {
    const routeProjectId = req.header('x-cube-project-id');
    const sessionId = this.cookie(req, 'cube_project_session');
    if (!sessionId) throw new Error('Project credentials are required');

    const sessionProjectId = this.sessions.projectId(sessionId);
    if (!sessionProjectId) throw new Error('Project session is missing or expired');
    if (routeProjectId && routeProjectId !== sessionProjectId) {
      throw new Error('Project route does not match the authenticated project session');
    }
    return { projectId: sessionProjectId, projectSessionId: sessionId };
  }

  public activeProject(req: ExpressRequest): string | null {
    const sessionId = this.cookie(req, 'cube_project_session');
    return sessionId ? this.sessions.projectId(sessionId) : null;
  }

  public projectId(context: RequestContext | MultiProjectContext): string {
    const projectId = (context as Partial<MultiProjectContext>).projectId;
    if (!projectId) throw new Error('Project context is required');
    return projectId;
  }

  public repository(context: RequestContext | MultiProjectContext): FileRepository {
    return new FileRepository(this.registry.modelPath(this.projectId(context)));
  }

  public async driver(context: DriverContext): Promise<DriverConfig> {
    const projectId = this.projectId(context);
    const sessionId = (context as DriverContext & Partial<MultiProjectContext>).projectSessionId;
    if (!sessionId) throw new Error('Project session is required');
    const credentials = this.sessions.read(sessionId, projectId);
    if (!credentials) throw new Error('Project session is missing or expired');
    const project = await this.registry.get(projectId);
    const connection = (await this.registry.connections()).find(item => item.id === project.connectionId);
    if (!connection) throw new Error(`Unknown connection preset: ${project.connectionId}`);
    return this.createDriverConfig(connection, credentials, {
      dataSource: context.dataSource || 'default',
      preAggregations: context.preAggregations || false,
    });
  }

  public async testSession(sessionId: string, projectId: string): Promise<void> {
    const credentials = this.sessions.read(sessionId, projectId);
    if (!credentials) throw new Error('Project session is missing or expired');
    const driver = await this.createDriver(projectId, credentials, {
      projectId,
      projectSessionId: sessionId,
      dataSource: 'default',
      securityContext: null,
      requestId: `project-session-${projectId}`,
    } as DriverContext);
    try {
      await driver.testConnection();
    } finally {
      await driver.release?.();
    }
  }

  public async testConnectionPreset(
    connectionId: string,
    credentials: ProjectCredentials,
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
    projectId: string,
    credentials: ProjectCredentials,
    context: DriverContext,
  ): Promise<BaseDriver> {
    const project = await this.registry.get(projectId);
    const connection = (await this.registry.connections()).find(item => item.id === project.connectionId);
    if (!connection) throw new Error(`Unknown connection preset: ${project.connectionId}`);
    return this.createDriverFromConnection(connection, credentials, {
      dataSource: context.dataSource || 'default',
      preAggregations: context.preAggregations || false,
    });
  }

  protected async createDriverFromConnection(
    connection: ConnectionPreset,
    credentials: ProjectCredentials,
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
    credentials: ProjectCredentials,
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
