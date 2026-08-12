/* eslint-disable global-require,no-restricted-syntax */
import dotenv from '@cubejs-backend/dotenv';
import {
  CubePreAggregationConverter,
  CubePrimaryKeyConverter,
  CubeRelationshipConverter,
  CubeRelationshipReader,
  CubeSchemaConverter,
  ScaffoldingTemplate,
  SchemaFormat,
} from '@cubejs-backend/schema-compiler';
import spawn from 'cross-spawn';
import path from 'path';
import fs from 'fs-extra';
import YAML from 'js-yaml';
import { getRequestIdFromRequest } from '@cubejs-backend/api-gateway';
import { LivePreviewWatcher } from '@cubejs-backend/cloud';
import { AppContainer, DependencyTree, PackageFetcher, DevPackageFetcher } from '@cubejs-backend/templates';
import jwt from 'jsonwebtoken';
import isDocker from 'is-docker';
import type { Application as ExpressApplication, Request, Response } from 'express';
import type { ChildProcess } from 'child_process';
import { executeCommand, getAnonymousId, getEnv, keyByDataSource, packageExists } from '@cubejs-backend/shared';
import crypto from 'crypto';

import type { BaseDriver } from '@cubejs-backend/query-orchestrator';

import { CubejsServerCore } from './server';
import { ExternalDbTypeFn, ServerCoreInitializedOptions, DatabaseType } from './types';
import DriverDependencies from './DriverDependencies';
import { MultiProjectRuntime } from './multi-project/MultiProjectRuntime';

const repo = {
  owner: 'cube-js',
  name: 'cubejs-playground-templates'
};

type DevServerOptions = {
  externalDbTypeFn: ExternalDbTypeFn;
  isReadyForQueryProcessing: () => boolean;
  dockerVersion?: string;
  multiProjectRuntime?: MultiProjectRuntime;
};

const JINJA_SYNTAX = /{%|%}|{{|}}/i;

function validateYamlSyntax(fileName: string, content: string): string | null {
  // Jinja templates are rendered by the compiler and cannot be parsed as
  // plain YAML before that step.
  if (JINJA_SYNTAX.test(content)) {
    return null;
  }

  try {
    const document = YAML.load(content);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return `O arquivo '${fileName}' precisa conter um documento YAML com um objeto na raiz.`;
    }
  } catch (error: any) {
    const line = error?.mark?.line == null ? null : error.mark.line + 1;
    const column = error?.mark?.column == null ? null : error.mark.column + 1;
    const location = line == null ? '' : ` (linha ${line}, coluna ${column})`;
    return `Sintaxe YAML inválida${location}: ${error?.reason || error?.message || String(error)}`;
  }

  return null;
}

function compilerValidationReason(error: any): string {
  return String(error?.message || error || 'O schema é inválido')
    .split('\n')
    .filter(line => line.trim() && !/^Compile errors:?$|^Errors:?$/i.test(line.trim()))
    .slice(0, 4)
    .join('\n')
    .trim();
}

export class DevServer {
  protected applyTemplatePackagesPromise: Promise<any> | null = null;

  protected dashboardAppProcess: ChildProcess & { dashboardUrlPromise?: Promise<any> } | null = null;

  protected livePreviewWatcher = new LivePreviewWatcher();

  public constructor(
    protected readonly cubejsServer: CubejsServerCore,
    protected readonly options: DevServerOptions
  ) {
  }

  public initDevEnv(app: ExpressApplication, options: ServerCoreInitializedOptions) {
    const port = process.env.PORT || 4000; // TODO
    const apiUrl = process.env.CUBEJS_API_URL || `http://localhost:${port}`;
    const multiProject = this.options.multiProjectRuntime;

    // todo: empty/default `apiSecret` in dev mode to allow the DB connection wizard
    const cubejsToken = jwt.sign({}, options.apiSecret || 'secret', { expiresIn: '1d' });

    if (process.env.NODE_ENV !== 'production') {
      console.log('🔓 Authentication checks are disabled in developer mode. Please use NODE_ENV=production to enable it.');
    } else {
      console.log(`🔒 Your temporary cube.js token: ${cubejsToken}`);
    }
    console.log(`🦅 Dev environment available at ${apiUrl}`);

    if (
      (
        this.options.externalDbTypeFn({
          authInfo: null,
          securityContext: null,
          requestId: '',
        }) || ''
      ).toLowerCase() !== 'cubestore'
    ) {
      console.log('⚠️  Your pre-aggregations will be on an external database. It is recommended to use Cube Store for optimal performance');
    }

    this.cubejsServer.event('Dev Server Start');
    const serveStatic = require('serve-static');

    const catchErrors = (handler) => async (req, res, next) => {
      try {
        await handler(req, res, next);
      } catch (e) {
        const errorString = ((e as Error).stack || e).toString();
        console.error(errorString);
        this.cubejsServer.event('Dev Server Error', { error: errorString });

        // We don't know what state response is left at here:
        // It could be corked, headers could be sent, body could be sent completely or partially

        // Also, because we pass `next` to handler without any wrapper we don't know if it was called or not
        // Hence, we shouldn't call it for error handling

        try {
          while (res.writableCorked > 0) {
            res.uncork();
          }

          if (res.writableEnded) {
            // There's nothing we can do for response, error happened after call to end()
          } else if (res.headersSent) {
            // If header is already sent, we can't alter any of it, so best we can do is just terminate body
            res.end();
          } else {
            res.status(500).json({ error: errorString });
          }
        } catch (send500Error) {
          const send500ErrorString = ((send500Error as Error).stack || send500Error).toString();
          console.error(send500ErrorString);
          this.cubejsServer.event('Dev Server Error', { error: send500ErrorString });
          res.destroy(send500Error);
        }
      }
    };

    const pendingProjects = new Map<string, {
      id: string;
      name: string;
      connectionId: string;
    }>();

    const loadRelationshipDefinitions = async (req: Request) => {
      const requestId = getRequestIdFromRequest(req);
      const projectContext = multiProject?.contextFromRequest(req);
      const context = {
        authInfo: null,
        securityContext: null,
        requestId,
        ...(projectContext || {}),
      };
      const repository = multiProject
        ? multiProject.repository(projectContext!)
        : this.cubejsServer.repository;
      const reader = new CubeRelationshipReader();
      const schemaConverter = new CubeSchemaConverter(repository, [reader]);
      await schemaConverter.generate();

      return {
        requestId,
        projectContext,
        context,
        repository,
        models: reader.getModels(),
        relationships: reader.getRelationships(),
      };
    };

    const loadRelationshipDiagram = async (
      req: Request,
      modelNames?: Set<string>,
      preparedDefinitions?: Awaited<ReturnType<typeof loadRelationshipDefinitions>>
    ) => {
      const definitions = preparedDefinitions || await loadRelationshipDefinitions(req);
      const {
        requestId,
        context,
        models,
        relationships,
      } = definitions;

      const compilerApi = await this.cubejsServer.getCompilerApi(context);
      const compilers = await compilerApi.getCompilers({ requestId });
      const metaCubes = compilers.metaTransformer?.cubes || [];
      const drivers = new Map<string, BaseDriver>();

      try {
        const cubes: any[] = [];
        for (const model of models) {
          if (modelNames && !modelNames.has(model.name)) continue;
          const evaluatedCube = compilers.cubeEvaluator.cubeFromPath(model.name);
          if (evaluatedCube?.isView) continue;

          const dataSource = evaluatedCube?.dataSource || model.dataSource || 'default';
          const metaCube = metaCubes.find(cube => cube.config?.name === model.name)?.config;
          const primaryKeyNames = compilers.cubeEvaluator.primaryKeys?.[model.name] || [];
          const diagramCube: any = {
            ...model,
            title: metaCube?.title || model.title,
            dataSource,
            hasPrimaryKey: Boolean(primaryKeyNames.length),
            primaryKeyNames,
            columns: [],
          };

          try {
            let driver = drivers.get(dataSource);
            if (!driver) {
              driver = await this.cubejsServer.getDriver({
                ...context,
                dataSource,
              });
              drivers.set(dataSource, driver);
            }

            const loadCompiledColumns = async (): Promise<{ name: any; type: string }[]> => {
              const query: any = await compilerApi.createQueryByDataSource(
                compilers,
                { requestId } as any,
                dataSource
              );
              const [sql, params] = compilers.compiler.withQuery(query, () => {
                const sourceSql = query.evaluateSymbolSqlWithContext(
                  () => query.cubeSql(model.name),
                  { preAggregationQuery: true, collectOriginalSqlPreAggregations: [] }
                );
                return query.paramAllocator.buildSqlAndParams(
                  `SELECT * FROM ${sourceSql} ${query.asSyntaxTable} ${query.cubeAlias(model.name)} WHERE 1 = 0`
                );
              });

              let columns: { name: any; type: string }[] = [];
              try {
                columns = await driver.queryColumnTypes(sql, params);
              } catch (_e) {
                // Some drivers only expose column metadata through downloadQueryResults.
              }
              if (!columns?.length) {
                const result: any = await driver.downloadQueryResults(sql, params, {
                  highWaterMark: 1,
                  streamImport: false,
                  requestId,
                } as any);
                columns = result.types || [];
              }
              return columns;
            };

            let columns: { name: any; type: string }[] = [];
            if (model.sourceType === 'sql_table' && model.source) {
              try {
                columns = await driver.tableColumnTypes(model.source);
              } catch (_e) {
                // Dynamic, unqualified, or dialect-specific table names use the compiled probe below.
              }
            }
            if (!columns?.length) {
              columns = await loadCompiledColumns();
            }
            const dimensionColumns = Object.entries(evaluatedCube?.dimensions || {}).map(([name, dimension]: [string, any]) => ({
              name,
              type: dimension?.type ? String(dimension.type) : undefined,
            }));
            const columnNames = new Set((columns || []).map(column => String(column.name).toLowerCase()));
            const allColumns = [
              ...(columns || []),
              ...dimensionColumns.filter(column => !columnNames.has(column.name.toLowerCase())),
            ];

            if (!allColumns.length) {
              throw new Error('The database driver did not return column metadata');
            }
            diagramCube.columns = allColumns.map(column => {
              const name = String(column.name);
              const normalizedName = name.toLowerCase();
              return {
                name,
                type: column.type ? String(column.type) : undefined,
                primaryKey: primaryKeyNames.some(primaryKey => (
                  String(primaryKey).toLowerCase() === normalizedName
                )),
              };
            });
          } catch (e: any) {
            diagramCube.columnError = String(e?.message || e || 'Unable to load columns')
              .split('\n')[0]
              .slice(0, 300);
          }

          cubes.push(diagramCube);
        }

        return {
          cubes,
          relationships,
        };
      } finally {
        if (multiProject) {
          await Promise.allSettled(Array.from(drivers.values()).map(driver => driver.release?.()));
        }
      }
    };

    app.get('/playground/projects', catchErrors(async (_req, res) => {
      if (!multiProject) return res.status(404).json({ error: 'Multi-project mode is disabled' });
      const connections = (await multiProject.registry.connections()).map(connection => ({
        ...connection,
        fields: (connection.fields || []).filter(field => !connection.defaults?.[field.name]),
      }));
      return res.json({
        projects: await multiProject.registry.list(),
        connections,
      });
    }));

    app.post('/playground/projects', catchErrors(async (req, res) => {
      if (!multiProject) return res.status(404).json({ error: 'Multi-project mode is disabled' });
      const { id, name, connectionId, credentials = {} } = req.body || {};
      if (!id || !name || !connectionId || typeof credentials !== 'object') {
        return res.status(400).json({ error: 'id, name, connectionId, and credentials are required' });
      }

      const connection = (await multiProject.registry.connections())
        .find(item => item.id === connectionId);
      if (!connection) return res.status(400).json({ error: `Unknown connection preset: ${connectionId}` });

      const missing = (connection.fields || [])
        .filter(field => field.required && !credentials[field.name] && !connection.defaults?.[field.name])
        .map(field => field.name);
      if (missing.length) {
        pendingProjects.set(id, { id, name, connectionId });
        const pendingProject = {
          id,
          name,
          connectionId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pending: true,
        };
        return res.status(200).json({
          ...pendingProject,
          project: pendingProject,
        });
      }

      const fullCredentials = {
        ...(connection.defaults || {}),
        ...credentials,
        CUBEJS_DB_TYPE: connection.dbType || '',
      };

      try {
        await multiProject.testConnectionPreset(connection.id, fullCredentials);
      } catch (e) {
        let message = (e as Error).message || 'Connection failed';
        for (const credential of Object.values(credentials)) {
          if (typeof credential === 'string' && credential) {
            message = message.split(credential).join('[REDACTED]');
          }
        }
        throw new Error(message);
      }

      const project = await multiProject.registry.create({ id, name, connectionId });
      const sessionId = multiProject.sessions.create(project.id, fullCredentials);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `cube_project_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict${secure}`);
      return res.status(201).json({
        ...project,
        project,
        apiPath: `/cubejs-api/projects/${project.id}/v1`,
      });
    }));

    app.post('/playground/projects/:projectId/session', catchErrors(async (req, res) => {
      if (!multiProject) {
        return res.status(404).json({ error: 'Multi-project mode is disabled' });
      }
      const pendingProject = pendingProjects.get(req.params.projectId);
      let project = await multiProject.registry.get(req.params.projectId).catch(() => null);
      if (!project && !pendingProject) {
        return res.status(404).json({ error: `Unknown project: ${req.params.projectId}` });
      }

      const projectConnectionId = project?.connectionId || pendingProject?.connectionId || '';
      const connection = (await multiProject.registry.connections())
        .find(item => item.id === projectConnectionId);
      if (!connection) {
        return res.status(400).json({ error: `Unknown connection preset: ${projectConnectionId}` });
      }
      const credentials = req.body?.credentials || {};
      const missing = (connection?.fields || [])
        .filter(field => field.required && !credentials[field.name] && !connection?.defaults?.[field.name])
        .map(field => field.name);
      if (missing.length) return res.status(400).json({ error: `Missing credentials: ${missing.join(', ')}` });

      const fullCredentials = {
        ...(connection?.defaults || {}),
        ...credentials,
        CUBEJS_DB_TYPE: connection?.dbType || '',
      };

      try {
        await multiProject.testConnectionPreset(connection.id, fullCredentials);
      } catch (e) {
        let message = (e as Error).message || 'Connection failed';
        for (const credential of Object.values(credentials)) {
          if (typeof credential === 'string' && credential) {
            message = message.split(credential).join('[REDACTED]');
          }
        }
        throw new Error(message);
      }

      if (!project && pendingProject) {
        project = await multiProject.registry.create({
          id: pendingProject.id,
          name: pendingProject.name,
          connectionId: pendingProject.connectionId,
        });
        pendingProjects.delete(project.id);
      }

      if (!project) {
        return res.status(500).json({ error: `Unable to open project: ${req.params.projectId}` });
      }

      const sessionId = multiProject.sessions.create(project.id, fullCredentials);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `cube_project_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict${secure}`);
      return res.json({ project, apiPath: `/cubejs-api/projects/${project.id}/v1` });
    }));

    app.delete('/playground/projects/session', catchErrors((req, res) => {
      const sessionId = this.cookie(req, 'cube_project_session');
      if (sessionId) multiProject?.sessions.delete(sessionId);
      res.setHeader('Set-Cookie', 'cube_project_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return res.status(204).end();
    }));

    app.get('/playground/context', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Env Open');

      const activeProjectId = multiProject?.activeProject(req) || null;
      const activeProject = activeProjectId
        ? await multiProject?.registry.get(activeProjectId).catch(() => null)
        : null;

      res.json({
        cubejsToken,
        basePath: activeProject
          ? `${options.basePath}/projects/${activeProject.id}`
          : options.basePath,
        anonymousId: getAnonymousId(),
        coreServerVersion: this.cubejsServer.coreServerVersion,
        dockerVersion: this.options.dockerVersion || null,
        projectFingerprint: this.cubejsServer.projectFingerprint,
        dbType: null,
        shouldStartConnectionWizardFlow: !this.options.isReadyForQueryProcessing(),
        livePreview: options.livePreview,
        isDocker: isDocker(),
        telemetry: options.telemetry,
        identifier: this.getIdentifier(options.apiSecret),
        previewFeatures: getEnv('previewFeatures'),
        multiProject: {
          enabled: Boolean(multiProject),
          activeProject,
        },
      });
    }));

    app.get('/playground/db-schema', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server DB Schema Load');
      const projectContext = multiProject?.contextFromRequest(req);
      const driver = await this.cubejsServer.getDriver({
        dataSource: req.body.dataSource || 'default',
        authInfo: null,
        securityContext: null,
        requestId: getRequestIdFromRequest(req),
        ...(projectContext || {}),
      });
      let tablesSchema;
      try {
        tablesSchema = await driver.tablesSchema();
      } finally {
        if (multiProject) await driver.release?.();
      }

      this.cubejsServer.event('Dev Server DB Schema Load Success');
      if (Object.keys(tablesSchema || {}).length === 0) {
        this.cubejsServer.event('Dev Server DB Schema Load Empty');
      }
      res.json({ tablesSchema });
    }));

    app.get('/playground/schema/relationships', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Relationship Diagram Load');
      const diagram = await loadRelationshipDiagram(req);
      res.json(diagram);
    }));

    app.post('/playground/schema/primary-key', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Primary Key Save');
      const { cubeName, columnName } = req.body || {};
      if (typeof cubeName !== 'string' || typeof columnName !== 'string' || !cubeName || !columnName) {
        return res.status(400).json({ error: 'cubeName and columnName are required' });
      }
      if (/\r|\n|`|\$\{|\{|\}/.test(columnName)) {
        return res.status(400).json({ error: 'Unsupported column name' });
      }

      const definitions = await loadRelationshipDefinitions(req);
      const model = definitions.models.find(cube => cube.name === cubeName);
      if (!model) return res.status(404).json({ error: `Cube '${cubeName}' was not found` });

      const diagram = await loadRelationshipDiagram(req, new Set([cubeName]), definitions);
      const cube = diagram.cubes.find(item => item.name === cubeName);
      const column = cube?.columns.find(item => item.name === columnName);
      if (!column) return res.status(404).json({ error: `Column '${columnName}' was not found in '${cubeName}'` });
      if (column.primaryKey) return res.json({ status: 'ok', alreadyPrimaryKey: true });

      const { repository, context, requestId } = definitions;
      const originalFile = (await repository.dataSchemaFiles()).find(file => file.fileName === model.fileName);
      if (!originalFile) return res.status(404).json({ error: `File '${model.fileName}' was not found` });

      const converter = new CubeSchemaConverter(repository, [
        new CubePrimaryKeyConverter({ cubeName, columnName, columnType: column.type }),
      ]);
      await converter.generate(cubeName);
      const updatedFile = converter.getSourceFiles().find(file => file.cubeName === cubeName);
      if (!updatedFile) return res.status(404).json({ error: `Cube '${cubeName}' was not found` });

      const currentFile = (await repository.dataSchemaFiles()).find(file => file.fileName === updatedFile.fileName);
      if (!currentFile || currentFile.content !== originalFile.content) {
        return res.status(409).json({ error: 'The model file changed while the primary key was being prepared. Reload the diagram and try again.' });
      }

      repository.writeDataSchemaFile(updatedFile.fileName, updatedFile.source);
      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(context);
        await compilerApi.getCompilers({ requestId });
      } catch (e: any) {
        const fileAfterFailure = (await repository.dataSchemaFiles()).find(file => file.fileName === updatedFile.fileName);
        if (fileAfterFailure?.content === updatedFile.source) {
          repository.writeDataSchemaFile(originalFile.fileName, originalFile.content);
          try {
            const compilerApi = await this.cubejsServer.getCompilerApi(context);
            await compilerApi.getCompilers({ requestId: `${requestId}-primary-key-rollback` });
          } catch (_rollbackError) {
            // Keep the original source when rollback compilation also fails.
          }
        }
        const reason = String(e?.message || e || 'The model would be invalid')
          .split('\n')
          .filter(line => line.trim() && !/^Compile errors:?$|^Errors:?$/i.test(line.trim()))[0]
          ?.trim();
        return res.status(400).json({
          error: `The primary key was not saved because the model would be invalid${reason ? `: ${reason}` : ''}`,
        });
      }

      return res.json({ status: 'ok', fileName: updatedFile.fileName, content: updatedFile.source });
    }));

    app.post('/playground/schema/relationship', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Relationship Save');
      const {
        sourceCube,
        targetCube,
        sourceColumn,
        targetColumn,
        relationship,
        operation = 'create',
        replaceCustom = false,
      } = req.body || {};
      const validOperations = new Set(['create', 'update', 'delete']);
      const validRelationships = new Set(['one_to_one', 'one_to_many', 'many_to_one']);

      if (typeof sourceCube !== 'string' || typeof targetCube !== 'string') {
        return res.status(400).json({ error: 'sourceCube and targetCube are required' });
      }
      if (!validOperations.has(operation)) {
        return res.status(400).json({ error: 'Unknown relationship operation' });
      }
      if (sourceCube === targetCube) {
        return res.status(400).json({ error: 'Self relationships are not supported by the diagram' });
      }

      const definitions = await loadRelationshipDefinitions(req);
      const sourceModel = definitions.models.find(cube => cube.name === sourceCube);
      const targetModel = definitions.models.find(cube => cube.name === targetCube);
      const existing = definitions.relationships.find(join => (
        join.sourceCube === sourceCube && join.targetCube === targetCube
      ));
      const reverseExisting = definitions.relationships.find(join => (
        join.sourceCube === targetCube && join.targetCube === sourceCube
      ));
      if (!sourceModel || !targetModel) {
        return res.status(404).json({ error: 'Source or target cube was not found' });
      }

      const diagram = operation === 'delete'
        ? null
        : await loadRelationshipDiagram(req, new Set([sourceCube, targetCube]), definitions);
      const source = diagram?.cubes.find(cube => cube.name === sourceCube);
      const target = diagram?.cubes.find(cube => cube.name === targetCube);
      if (!source || !target) {
        if (operation !== 'delete') {
          return res.status(404).json({ error: 'Source or target cube was not found' });
        }
      }

      if (operation === 'create' && existing) {
        return res.status(409).json({ error: 'This relationship already exists' });
      }
      if (operation === 'create' && reverseExisting) {
        return res.status(409).json({
          error: `A relationship between '${sourceCube}' and '${targetCube}' already exists in the opposite direction`,
        });
      }
      if (operation === 'update' && !existing) {
        return res.status(404).json({ error: 'This relationship does not exist' });
      }

      if (operation !== 'delete') {
        if (
          typeof sourceColumn !== 'string' ||
          typeof targetColumn !== 'string' ||
          !validRelationships.has(relationship)
        ) {
          return res.status(400).json({
            error: 'sourceColumn, targetColumn, and a valid relationship are required',
          });
        }
        if (/\r|\n|`|\$\{|\{|\}/.test(sourceColumn) || /\r|\n|`|\$\{|\{|\}/.test(targetColumn)) {
          return res.status(400).json({ error: 'Unsupported column name' });
        }
        if (!source!.columns.some(column => column.name === sourceColumn)) {
          return res.status(400).json({ error: `Column '${sourceColumn}' was not found in '${sourceCube}'` });
        }
        if (!target!.columns.some(column => column.name === targetColumn)) {
          return res.status(400).json({ error: `Column '${targetColumn}' was not found in '${targetCube}'` });
        }
        if (operation === 'update' && existing && (!existing.sourceColumn || !existing.targetColumn) && !replaceCustom) {
          return res.status(409).json({
            error: 'This relationship has a custom SQL condition and requires explicit replacement',
            customRelationship: true,
          });
        }
      }

      const { repository, context, requestId } = definitions;
      const originalFile = (await repository.dataSchemaFiles())
        .find(file => file.fileName === sourceModel.fileName);
      if (!originalFile) {
        return res.status(404).json({ error: `File '${sourceModel.fileName}' was not found` });
      }

      const converter = new CubeSchemaConverter(repository, [
        new CubeRelationshipConverter({
          sourceCube,
          targetCube,
          sourceColumn,
          targetColumn,
          relationship,
          operation,
        }),
      ]);
      await converter.generate(sourceCube);
      const updatedFile = converter.getSourceFiles().find(file => file.cubeName === sourceCube);
      if (!updatedFile) {
        return res.status(404).json({ error: `Cube '${sourceCube}' was not found` });
      }

      const currentFile = (await repository.dataSchemaFiles())
        .find(file => file.fileName === updatedFile.fileName);
      if (!currentFile) {
        return res.status(404).json({ error: `File '${updatedFile.fileName}' was not found` });
      }
      if (currentFile.content !== originalFile.content) {
        return res.status(409).json({
          error: 'The model file changed while the relationship was being prepared. Reload the diagram and try again.',
        });
      }

      repository.writeDataSchemaFile(updatedFile.fileName, updatedFile.source);
      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(context);
        await compilerApi.getCompilers({ requestId });
      } catch (e: any) {
        const fileAfterFailure = (await repository.dataSchemaFiles())
          .find(file => file.fileName === updatedFile.fileName);
        if (fileAfterFailure?.content === updatedFile.source) {
          repository.writeDataSchemaFile(originalFile.fileName, originalFile.content);
          try {
            const compilerApi = await this.cubejsServer.getCompilerApi(context);
            await compilerApi.getCompilers({ requestId: `${requestId}-relationship-rollback` });
          } catch (_rollbackError) {
            // The original model may already be invalid. The source file was still restored.
          }
        } else {
          return res.status(409).json({
            error: 'The model file changed while the relationship was being validated. Reload the diagram before editing it again.',
          });
        }
        const reason = String(e?.message || e || 'The model would be invalid')
          .split('\n')
          .filter(line => line.trim() && !/^Compile errors:?$|^Errors:?$/i.test(line.trim()))[0]
          ?.trim();
        return res.status(400).json({
          error: `The relationship was not saved because the model would be invalid${reason ? `: ${reason}` : ''}`,
        });
      }

      const savedFile = (await repository.dataSchemaFiles())
        .find(file => file.fileName === updatedFile.fileName);
      if (savedFile?.content !== updatedFile.source) {
        return res.status(409).json({
          error: 'The model file changed while the relationship was being validated. Reload the diagram to see the current version.',
        });
      }

      return res.json({
        status: 'ok',
        fileName: updatedFile.fileName,
        content: updatedFile.source,
      });
    }));

    app.get('/playground/files', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Files Load');
      const repository = multiProject
        ? multiProject.repository(multiProject.contextFromRequest(req))
        : this.cubejsServer.repository;
      const files = await repository.dataSchemaFiles();
      res.json({
        files: files.map(f => ({
          ...f,
          absPath: path.resolve(path.join(repository.localPath(), f.fileName))
        }))
      });
    }));

    app.post('/playground/files', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server File Save');

      if (!req.body) {
        throw new Error('Request body is required');
      }

      const { fileName, content } = req.body;

      if (typeof fileName !== 'string' || typeof content !== 'string') {
        return res.status(400).json({
          error: 'Both fileName and content must be strings'
        });
      }

      if (path.isAbsolute(fileName) || fileName.includes('..') || fileName.includes('\\')) {
        return res.status(400).json({
          error: 'Invalid fileName'
        });
      }

      const repository = multiProject
        ? multiProject.repository(multiProject.contextFromRequest(req))
        : this.cubejsServer.repository;
      const files = await repository.dataSchemaFiles();

      const originalFile = files.find((f) => f.fileName === fileName);
      if (!originalFile) {
        return res.status(404).json({
          error: `File '${fileName}' was not found`
        });
      }

      if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
        const syntaxError = validateYamlSyntax(fileName, content);
        if (syntaxError) {
          return res.status(400).json({
            error: 'O arquivo não foi salvo porque o YAML é inválido',
            details: syntaxError,
          });
        }
      }

      repository.writeDataSchemaFile(fileName, content);

      const requestId = getRequestIdFromRequest(req);
      const projectContext = multiProject?.contextFromRequest(req);
      const compilerContext = {
        authInfo: null,
        securityContext: null,
        requestId,
        ...(projectContext || {}),
      };
      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(compilerContext);
        await compilerApi.getCompilers({ requestId });
      } catch (error: any) {
        const fileAfterFailure = (await repository.dataSchemaFiles())
          .find((file) => file.fileName === fileName);
        if (fileAfterFailure?.content === content) {
          repository.writeDataSchemaFile(fileName, originalFile.content);
          try {
            const compilerApi = await this.cubejsServer.getCompilerApi({
              ...compilerContext,
              requestId: `${requestId}-file-rollback`,
            });
            await compilerApi.getCompilers({ requestId: `${requestId}-file-rollback` });
          } catch (_rollbackError) {
            // The previous source is restored even if the rollback compiler also fails.
          }
        } else {
          return res.status(409).json({
            error: 'O arquivo mudou durante a validação. Recarregue o arquivo e tente novamente.',
          });
        }

        return res.status(400).json({
          error: 'O arquivo não foi salvo porque a validação do schema falhou',
          details: compilerValidationReason(error),
        });
      }

      return res.json({
        status: 'ok',
        fileName
      });
    }));

    app.delete('/playground/files', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server File Delete');

      if (!req.body) {
        throw new Error('Request body is required');
      }

      const { fileName } = req.body;

      if (typeof fileName !== 'string') {
        return res.status(400).json({
          error: 'fileName must be a string'
        });
      }

      if (path.isAbsolute(fileName) || fileName.includes('..') || fileName.includes('\\')) {
        return res.status(400).json({
          error: 'Invalid fileName'
        });
      }

      const repository = multiProject
        ? multiProject.repository(multiProject.contextFromRequest(req))
        : this.cubejsServer.repository;
      const files = await repository.dataSchemaFiles();

      if (!files.find((f) => f.fileName === fileName)) {
        return res.status(404).json({
          error: `File '${fileName}' was not found`
        });
      }

      const repositoryPath = path.resolve(repository.localPath());
      const filePath = path.resolve(repositoryPath, fileName);
      if (!filePath.startsWith(`${repositoryPath}${path.sep}`)) {
        return res.status(400).json({
          error: 'Invalid fileName'
        });
      }

      await fs.remove(filePath);

      return res.json({
        status: 'ok',
        fileName
      });
    }));

    app.post('/playground/generate-schema', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Generate Schema');
      if (!req.body) {
        throw new Error('Your express app config is missing body-parser middleware. Typical config can look like: `app.use(bodyParser.json({ limit: \'50mb\' }));`');
      }

      if (!req.body.tables) {
        throw new Error('You have to select at least one table');
      }

      const dataSource = req.body.dataSource || 'default';
      const projectContext = multiProject?.contextFromRequest(req);

      const driver = await this.cubejsServer.getDriver({
        dataSource,
        authInfo: null,
        securityContext: null,
        requestId: getRequestIdFromRequest(req),
        ...(projectContext || {}),
      });
      const tablesSchema = req.body.tablesSchema || (await driver.tablesSchema());

      if (!Object.values(SchemaFormat).includes(req.body.format)) {
        throw new Error(`Unknown schema format. Must be one of ${Object.values(SchemaFormat)}`);
      }

      const scaffoldingTemplate = new ScaffoldingTemplate(tablesSchema, driver, {
        format: req.body.format,
        snakeCase: true
      });
      const files = scaffoldingTemplate.generateFilesByTableNames(req.body.tables, { dataSource });

      const schemaPath = multiProject
        ? multiProject.registry.modelPath(projectContext!.projectId)
        : options.schemaPath;
      await fs.emptyDir(path.join(schemaPath, 'cubes'));
      await fs.emptyDir(path.join(schemaPath, 'views'));

      await fs.writeFile(path.join(schemaPath, 'views', 'example_view.yml'), `# In Cube, views are used to expose slices of your data graph and act as data marts.
# You can control which measures and dimensions are exposed to BIs or data apps,
# as well as the direction of joins between the exposed cubes.
# You can learn more about views in documentation here - https://cube.dev/docs/schema/reference/view


# The following example shows a view defined on top of orders and customers cubes.
# Both orders and customers cubes are exposed using the "includes" parameter to
# control which measures and dimensions are exposed.
# Prefixes can also be applied when exposing measures or dimensions.
# In this case, the customers' city dimension is prefixed with the cube name,
# resulting in "customers_city" when querying the view.

# views:
#   - name: example_view
#
#     cubes:
#       - join_path: orders
#         includes:
#           - status
#           - created_date
#
#           - total_amount
#           - count
#
#       - join_path: orders.customers
#         prefix: true
#         includes:
#           - city`);
      await Promise.all(files.map(file => fs.writeFile(path.join(schemaPath, 'cubes', file.fileName), file.content)));

      if (multiProject) await driver.release?.();

      res.json({ files });
    }));

    let lastApplyTemplatePackagesError = null;

    app.get('/playground/dashboard-app-create-status', catchErrors(async (req, res) => {
      const sourcePath = path.join(options.dashboardAppPath, 'src');

      if (lastApplyTemplatePackagesError) {
        const toThrow = lastApplyTemplatePackagesError;
        lastApplyTemplatePackagesError = null;
        throw toThrow;
      }

      if (this.applyTemplatePackagesPromise) {
        if (req.query.instant) {
          res.status(404).json({ error: 'Dashboard app creating' });
          return;
        }

        await this.applyTemplatePackagesPromise;
      }

      // docker-compose share a volume for /dashboard-app and directory will be empty
      if (!fs.pathExistsSync(options.dashboardAppPath) || fs.readdirSync(options.dashboardAppPath).length === 0) {
        res.status(404).json({
          error: `Dashboard app not found in '${path.resolve(options.dashboardAppPath)}' directory`
        });

        return;
      }

      if (!fs.pathExistsSync(sourcePath)) {
        res.status(404).json({
          error: `Dashboard app corrupted. Please remove '${path.resolve(options.dashboardAppPath)}' directory and recreate it`
        });

        return;
      }

      res.json({
        status: 'created',
        installedTemplates: AppContainer.getPackageVersions(options.dashboardAppPath)
      });
    }));

    app.get('/playground/start-dashboard-app', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Start Dashboard App');

      if (!this.dashboardAppProcess) {
        const { dashboardAppPort = 3000 } = options;
        this.dashboardAppProcess = spawn('npm', [
          'run',
          'start',
          '--',
          '--port',
          dashboardAppPort.toString(),
          ...(isDocker() ? ['--host', '0.0.0.0'] : [])
        ], {
          cwd: options.dashboardAppPath,
          env: <any>{
            ...process.env,
            PORT: dashboardAppPort
          }
        });

        this.dashboardAppProcess.dashboardUrlPromise = new Promise((resolve) => {
          this.dashboardAppProcess.stdout.on('data', (data) => {
            console.log(data.toString());
            if (data.toString().match(/Compiled/)) {
              resolve(options.dashboardAppPort);
            }
          });
        });

        this.dashboardAppProcess.on('close', exitCode => {
          if (exitCode !== 0) {
            console.log(`Dashboard react-app failed with exit code ${exitCode}`);
            this.cubejsServer.event('Dev Server Dashboard App Failed', { exitCode });
          }
          this.dashboardAppProcess = null;
        });
      }

      await this.dashboardAppProcess.dashboardUrlPromise;
      res.json({ dashboardPort: options.dashboardAppPort });
    }));

    app.get('/playground/dashboard-app-status', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Dashboard App Status');
      const dashboardPort = this.dashboardAppProcess && await this.dashboardAppProcess.dashboardUrlPromise;
      res.json({
        running: !!dashboardPort,
        dashboardPort,
        dashboardAppPath: path.resolve(options.dashboardAppPath)
      });
    }));

    let driverPromise: Promise<void> | null = null;
    let driverError: Error | null = null;

    app.get('/playground/driver', catchErrors(async (req: Request, res: Response) => {
      const { driver } = req.query;

      if (!driver || typeof driver !== 'string' || !DriverDependencies[driver as keyof typeof DriverDependencies]) {
        return res.status(400).json('Wrong driver');
      }

      if (packageExists(DriverDependencies[driver as keyof typeof DriverDependencies])) {
        return res.json({ status: 'installed' });
      } else if (driverPromise) {
        return res.json({ status: 'installing' });
      } else if (driverError) {
        return res.status(500).json({
          status: 'error',
          error: driverError.toString()
        });
      }

      return res.json({ status: null });
    }));

    app.post('/playground/driver', catchErrors((req, res) => {
      const { driver } = req.body;

      if (!driver || typeof driver !== 'string' || !DriverDependencies[driver as keyof typeof DriverDependencies]) {
        return res.status(400).json(`'${driver}' driver dependency not found`);
      }

      const driverKey = driver as keyof typeof DriverDependencies;

      async function installDriver() {
        driverError = null;

        try {
          await executeCommand(
            'npm',
            ['install', DriverDependencies[driverKey], '--save-dev'],
            { cwd: path.resolve('.') }
          );
        } catch (error) {
          driverError = error as Error;
        } finally {
          driverPromise = null;
        }
      }

      if (!driverPromise) {
        driverPromise = installDriver();
      }

      return res.json({
        dependency: DriverDependencies[driverKey]
      });
    }));

    app.post('/playground/apply-template-packages', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Download Template Packages');

      const fetcher = process.env.TEST_TEMPLATES ? new DevPackageFetcher(repo) : new PackageFetcher(repo);

      this.cubejsServer.event('Dev Server App File Write');
      const { toApply, templateConfig } = req.body;

      const applyTemplates = async () => {
        const manifestJson = await fetcher.manifestJSON();
        const response = await fetcher.downloadPackages();

        let templatePackages: string[];
        if (typeof toApply === 'string') {
          const template = manifestJson.templates.find(({ name }) => name === toApply);
          templatePackages = template.templatePackages;
        } else {
          templatePackages = toApply;
        }

        const dt = new DependencyTree(manifestJson, templatePackages);

        const appContainer = new AppContainer(
          dt.getRootNode(),
          {
            appPath: options.dashboardAppPath,
            packagesPath: response.packagesPath
          },
          templateConfig
        );

        this.cubejsServer.event('Dev Server Create Dashboard App');
        await appContainer.applyTemplates();
        this.cubejsServer.event('Dev Server Create Dashboard App Success');

        this.cubejsServer.event('Dev Server Dashboard Npm Install');

        await appContainer.ensureDependencies();
        this.cubejsServer.event('Dev Server Dashboard Npm Install Success');

        fetcher.cleanup();
      };

      if (this.applyTemplatePackagesPromise) {
        this.applyTemplatePackagesPromise = this.applyTemplatePackagesPromise.then(applyTemplates);
      } else {
        this.applyTemplatePackagesPromise = applyTemplates();
      }
      const promise = this.applyTemplatePackagesPromise;

      promise.then(() => {
        if (promise === this.applyTemplatePackagesPromise) {
          this.applyTemplatePackagesPromise = null;
        }
      }, (err) => {
        lastApplyTemplatePackagesError = err;
        if (promise === this.applyTemplatePackagesPromise) {
          this.applyTemplatePackagesPromise = null;
        }
      });
      res.json(true); // TODO
    }));

    app.get('/playground/manifest', catchErrors(async (_, res) => {
      const fetcher = process.env.TEST_TEMPLATES ? new DevPackageFetcher(repo) : new PackageFetcher(repo);
      res.json(await fetcher.manifestJSON());
    }));

    app.get('/playground/live-preview/start/:token', catchErrors(async (req: Request, res: Response) => {
      this.livePreviewWatcher.setAuth(req.params.token);
      this.livePreviewWatcher.startWatch();

      res.setHeader('Content-Type', 'text/html');
      res.write('<html><body><script>window.close();</script></body></html>');
      res.end();
    }));

    app.get('/playground/live-preview/stop', catchErrors(async (req, res) => {
      this.livePreviewWatcher.stopWatch();
      res.json({ active: false });
    }));

    app.get('/playground/live-preview/status', catchErrors(async (req, res) => {
      const statusObj = await this.livePreviewWatcher.getStatus();
      res.json(statusObj);
    }));

    app.post('/playground/live-preview/token', catchErrors(async (req, res) => {
      const token = await this.livePreviewWatcher.createTokenWithPayload(req.body);
      res.json({ token });
    }));

    app.use(serveStatic(path.join(__dirname, '../../../playground'), {
      lastModified: false,
      etag: false,
      setHeaders: (res, url) => {
        if (url.indexOf('/index.html') !== -1) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    }));

    /**
     * The `/playground/test-connection` endpoint request.
     */
    type TestConnectionRequest = {
      body: {
        dataSource?: string,
        variables: {
          [env: string]: string,
        },
      },
    };

    app.post('/playground/test-connection', catchErrors(
      async (req: TestConnectionRequest, res) => {
        if (multiProject) {
          return res.status(409).json({
            error: 'Use the project session endpoint to test connections in multi-project mode',
          });
        }
        const { dataSource, variables } = req.body || {};

        // With multiple data sources enabled, we need to use
        // CUBEJS_DS_<dataSource>_DB_TYPE environment variable
        // instead of CUBEJS_DB_TYPE.
        const type = keyByDataSource('CUBEJS_DB_TYPE', dataSource);

        let driver: BaseDriver | null = null;

        try {
          if (!variables || !variables[type]) {
            throw new Error(`${type} is required`);
          }

          // Backup env variables and set new ones in-place.
          // We must mutate the existing process.env object (not replace it)
          // because env-var holds a reference to the original object.
          const backup: Record<string, string | undefined> = {};

          for (const [envName, envValue] of Object.entries(variables)) {
            backup[envName] = process.env[envName];
            process.env[envName] = <string>envValue;
          }

          // With multiple data sources enabled, we need to put the dataSource
          // parameter to the driver instance to read an appropriate set of
          // driver configuration parameters. It can be undefined if multiple
          // data source is disabled.
          driver = CubejsServerCore.createDriver(
            <DatabaseType>variables[type],
            { dataSource },
          );

          // Restore original env values
          for (const [envName, envValue] of Object.entries(backup)) {
            if (envValue === undefined) {
              delete process.env[envName];
            } else {
              process.env[envName] = envValue;
            }
          }

          await driver.testConnection();

          this.cubejsServer.event('test_database_connection_success');

          return res.json('ok');
        } catch (error) {
          this.cubejsServer.event('test_database_connection_error');

          return res.status(400).json({
            error: error.toString()
          });
        } finally {
          if (driver && (<any>driver).release) {
            await (<any>driver).release();
          }
        }
      }
    ));

    app.post('/playground/env', catchErrors(async (req, res) => {
      if (multiProject) {
        return res.status(409).json({
          error: 'The /playground/env endpoint is disabled in multi-project mode because it writes credentials to disk',
        });
      }
      let { variables = {} } = req.body || {};

      if (!variables.CUBEJS_API_SECRET) {
        variables.CUBEJS_API_SECRET = options.apiSecret;
      }

      let envs: Record<string, string> = {};
      const envPath = path.join(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        envs = dotenv.parse(fs.readFileSync(envPath));
      }

      const schemaPath = envs.CUBEJS_SCHEMA_PATH || process.env.CUBEJS_SCHEMA_PATH || 'model';

      variables.CUBEJS_EXTERNAL_DEFAULT = 'true';
      variables.CUBEJS_SCHEDULED_REFRESH_DEFAULT = 'true';
      variables.CUBEJS_DEV_MODE = 'true';
      variables.CUBEJS_SCHEMA_PATH = schemaPath;
      variables = Object.entries(variables).map(([key, value]) => ([key, value].join('=')));

      const repositoryPath = path.join(process.cwd(), schemaPath);

      if (!fs.existsSync(repositoryPath)) {
        fs.mkdirSync(repositoryPath);
      }

      fs.writeFileSync(path.join(process.cwd(), '.env'), variables.join('\n'));

      if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
        fs.writeFileSync(
          path.join(process.cwd(), 'package.json'),
          JSON.stringify({
            name: 'cube-docker',
            version: '0.0.1',
            private: true,
            createdAt: new Date().toJSON(),
            dependencies: {}
          }, null, 2)
        );
      }

      dotenv.config({ override: true });

      await this.cubejsServer.resetInstanceState();

      res.status(200).json(req.body.variables || {});
    }));

    app.post('/playground/token', catchErrors(async (req, res) => {
      const { payload = {} } = req.body;
      const jwtOptions: jwt.SignOptions = payload.exp != null ? {} : { expiresIn: '1d' };

      const token = jwt.sign(payload, options.apiSecret, jwtOptions);

      res.json({ token });
    }));

    app.post('/playground/schema/pre-aggregation', catchErrors(async (req: Request, res: Response) => {
      const { cubeName, preAggregationName, code } = req.body;
      const repository = multiProject
        ? multiProject.repository(multiProject.contextFromRequest(req))
        : this.cubejsServer.repository;

      /**
       * Important note:
       * JS code for pre-agg includes the content of the pre-aggregation object
       * without name, which is passed as preAggregationName.
       * While yaml code for pre-agg includes whole yaml object including name.
       */
      const schemaConverter = new CubeSchemaConverter(repository, [
        new CubePreAggregationConverter({
          cubeName,
          preAggregationName,
          code
        })
      ]);

      try {
        await schemaConverter.generate(cubeName);
      } catch (error) {
        return res.status(400).json({ error: (error as Error).message || error });
      }

      const file = schemaConverter.getSourceFiles().find(
        ({ cubeName: currentCubeName }) => currentCubeName === cubeName
      );

      if (!file) {
        return res.status(400).json({ error: `The schema file for "${cubeName}" cube was not found or could not be updated. Only JS and non-templated YAML files are supported.` });
      }

      repository.writeDataSchemaFile(file.fileName, file.source);
      return res.json('ok');
    }));
  }

  protected getIdentifier(apiSecret: string): string {
    return crypto.createHash('md5')
      .update(apiSecret)
      .digest('hex')
      .replace(/[^\d]/g, '')
      .slice(0, 10);
  }

  protected cookie(req: Request, name: string): string | undefined {
    const cookies = req.headers.cookie?.split(';') || [];
    for (const cookie of cookies) {
      const [key, ...value] = cookie.trim().split('=');
      if (key === name) return decodeURIComponent(value.join('='));
    }
    return undefined;
  }
}
