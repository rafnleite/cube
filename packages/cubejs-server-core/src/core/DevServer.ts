/* eslint-disable global-require,no-restricted-syntax */
import dotenv from '@cubejs-backend/dotenv';
import {
  CubePreAggregationConverter,
  CubeDimensionConverter,
  CubeDimensionOrderConverter,
  CubePrimaryKeyConverter,
  CubeRelationshipConverter,
  CubeRelationshipReader,
  CubeSchemaConverter,
  CubeSchemaItemConverter,
  CubeSchemaSnapshotConverter,
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
import { MultiDatamartRuntime } from './multi-datamart/MultiDatamartRuntime';

const repo = {
  owner: 'cube-js',
  name: 'cubejs-playground-templates'
};

type DevServerOptions = {
  externalDbTypeFn: ExternalDbTypeFn;
  isReadyForQueryProcessing: () => boolean;
  dockerVersion?: string;
  multiDatamartRuntime?: MultiDatamartRuntime;
};

class SchemaMutationError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function repairUtf8Mojibake(value: string): string {
  let repaired = value;
  for (let attempt = 0; attempt < 3 && /[ÃÂ]/.test(repaired); attempt += 1) {
    const decoded = Buffer.from(repaired, 'latin1').toString('utf8');
    if (decoded === repaired || decoded.includes('\uFFFD')) break;
    repaired = decoded;
  }
  return repaired;
}

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
    const reason = error?.reason || error?.message || String(error);
    if (/duplicated mapping key/i.test(reason)) {
      const topLevelCubeDeclarations = content.match(/^[ \t]*cubes[ \t]*:/gm) || [];
      if (topLevelCubeDeclarations.length > 1) {
        return `O arquivo '${fileName}' declara 'cubes:' mais de uma vez. Use uma única chave 'cubes:' e coloque os cubos como itens da mesma lista.`;
      }
    }

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

function isSafeSchemaFileName(fileName: unknown): fileName is string {
  return typeof fileName === 'string'
    && fileName.length > 0
    && !path.isAbsolute(fileName)
    && !fileName.includes('..')
    && !fileName.includes('\\');
}

function isSafeCubeFileName(fileName: unknown): fileName is string {
  return isSafeSchemaFileName(fileName)
    && path.dirname(fileName) === 'cubes';
}

function isSafeCubeFileBaseName(fileName: unknown): fileName is string {
  return isSafeSchemaFileName(fileName)
    && path.basename(fileName) === fileName
    && !fileName.includes('/');
}

const DIAGRAM_STATE_FILE = '.cube-diagram.json';

function diagramStatePath(repository: { localPath(): string }): string {
  return path.resolve(repository.localPath(), DIAGRAM_STATE_FILE);
}

function sanitizeDiagramCubes(input: any): Record<string, any> {
  const cubes: Record<string, any> = {};
  if (input?.cubes && typeof input.cubes === 'object' && !Array.isArray(input.cubes)) {
    for (const [key, value] of Object.entries(input.cubes)) {
      const item = value as any;
      if (!key || !item || typeof item !== 'object') continue;
      const position = item.position;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      cubes[key] = {
        name: typeof item.name === 'string' ? item.name : undefined,
        source: typeof item.source === 'string' ? item.source : undefined,
        position: { x: position.x, y: position.y },
      };
    }
  }
  return cubes;
}

function sanitizeDiagramState(input: any): any {
  const views: Record<string, any> = {};
  if (input?.views && typeof input.views === 'object' && !Array.isArray(input.views)) {
    for (const [key, value] of Object.entries(input.views)) {
      const view = value as any;
      if (!key || !view || typeof view !== 'object') continue;

      const visibility: Record<string, boolean> = {};
      if (view.visibility && typeof view.visibility === 'object' && !Array.isArray(view.visibility)) {
        for (const [cubeName, visible] of Object.entries(view.visibility)) {
          if (cubeName && typeof visible === 'boolean') visibility[cubeName] = visible;
        }
      }

      const backgroundColor = typeof view.backgroundColor === 'string'
        && /^#[0-9a-f]{6}$/i.test(view.backgroundColor)
        ? view.backgroundColor
        : '#f7f8fc';
      views[key] = {
        id: key,
        name: typeof view.name === 'string' && view.name.trim() ? view.name.trim().slice(0, 120) : key,
        backgroundColor,
        visibility,
        cubes: sanitizeDiagramCubes(view),
      };
    }
  }

  return {
    version: Object.keys(views).length ? 2 : 1,
    activeViewId: typeof input?.activeViewId === 'string' && views[input.activeViewId]
      ? input.activeViewId
      : Object.keys(views)[0],
    views,
    cubes: sanitizeDiagramCubes(input),
  };
}

function copiedCubeName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/\.(yml|yaml)$/i, '');
  const normalized = baseName.replace(/[^A-Za-z0-9_]/g, '_');
  return normalized.match(/^\d/) ? `cube_${normalized}` : normalized || 'cube_copy';
}

function renameYamlCubeInSource(source: string, currentName: unknown, nextName: string): string | null {
  const cubeNameLine = /^(\s*-\s+name:\s*)(?:(['"])(.*?)\2|([^\r\n#]+?))(\s*(?:#.*)?)$/m;
  const match = source.match(cubeNameLine);
  if (!match) return null;

  const parsedName = match[3] ?? match[4]?.trim();
  if (parsedName !== String(currentName)) return null;

  const replacementName = match[2] ? `${match[2]}${nextName}${match[2]}` : nextName;
  return source.replace(match[0], `${match[1]}${replacementName}${match[5]}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInts);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeBigInts(item)])
    );
  }
  return value;
}

function postgresSampleCastType(type: unknown): string {
  const normalized = String(type || '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    bpchar: 'char',
    float4: 'real',
    float8: 'double precision',
    int2: 'smallint',
    int4: 'integer',
    int8: 'bigint',
    timestamptz: 'timestamp with time zone',
    timestamp: 'timestamp without time zone',
    timetz: 'time with time zone',
  };
  const canonical = aliases[normalized] || normalized;
  const allowedTypes = new Set([
    'bigint', 'boolean', 'char', 'character', 'character varying', 'date',
    'double precision', 'integer', 'numeric', 'real', 'smallint', 'text',
    'time', 'time without time zone', 'time with time zone', 'timestamp',
    'timestamp without time zone', 'timestamp with time zone', 'uuid', 'varchar',
  ]);
  return allowedTypes.has(canonical) ? canonical : 'text';
}

async function postgresSampleRows(
  driver: BaseDriver,
  source: string,
  projection: string,
  limit: number,
  requestId: string,
): Promise<Record<string, unknown>[]> {
  let canUseTableSample = false;
  let estimatedRows: number | null = null;
  const sourceParts = source.split('.').map(part => part.replace(/^"|"$/g, ''));

  if (sourceParts.length === 2) {
    const relationInfo = await driver.query<{ relkind: string; reltuples: number | string }>(
      `SELECT c.relkind, c.reltuples
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [sourceParts[0], sourceParts[1]],
      { requestId } as any
    );
    const relation = relationInfo.find(row => ['r', 'm', 'p'].includes(String(row.relkind)));
    canUseTableSample = Boolean(relation);
    const relationEstimate = relation ? Number(relation.reltuples) : NaN;
    if (Number.isFinite(relationEstimate) && relationEstimate >= 0) {
      estimatedRows = relationEstimate;
    }
  }

  let rows: Record<string, unknown>[] = [];
  if (canUseTableSample && (estimatedRows === null || estimatedRows > limit)) {
    for (const percentage of [1, 5, 10]) {
      try {
        rows = await driver.query<Record<string, unknown>>(
          `SELECT ${projection} FROM ${source} TABLESAMPLE SYSTEM (${percentage}) LIMIT ${limit}`,
          [],
          { requestId } as any
        );
        if (rows.length >= limit) break;
      } catch {
        // Views and PostgreSQL-compatible sources can reject TABLESAMPLE.
        rows = [];
        break;
      }
    }
  }

  if (rows.length < limit) {
    rows = await driver.query<Record<string, unknown>>(
      `SELECT ${projection} FROM ${source} LIMIT ${limit}`,
      [],
      { requestId } as any
    );
  }

  return rows;
}

async function netezzaSampleRows(
  driver: BaseDriver,
  source: string,
  projection: string,
  limit: number,
  requestId: string,
): Promise<Record<string, unknown>[]> {
  // Netezza does not support PostgreSQL's TABLESAMPLE syntax. A narrow
  // projection with LIMIT is still substantially cheaper than executing the
  // complete cube query with every join and measure just to obtain 25 rows.
  return driver.query<Record<string, unknown>>(
    `SELECT ${projection} FROM ${source} LIMIT ${limit}`,
    [],
    { requestId } as any,
  );
}

function rowValue(row: Record<string, unknown>, column: string): unknown {
  const key = Object.keys(row).find(item => item.toLowerCase() === column.toLowerCase());
  return key === undefined ? undefined : row[key];
}

function sampleKeyIdentity(values: unknown[]): string {
  return JSON.stringify(values, (_key, value) => (
    typeof value === 'bigint' ? `${value}n` : value
  ));
}

function uniqueSampleKeyRows(
  rows: Record<string, unknown>[],
  columns: string[],
  limit: number,
): unknown[][] {
  const unique = new Map<string, unknown[]>();
  rows.forEach(row => {
    const values = columns.map(column => rowValue(row, column));
    const identity = sampleKeyIdentity(values);
    if (!unique.has(identity)) unique.set(identity, values);
  });
  return [...unique.values()].slice(0, limit);
}

function topLevelClauseIndex(
  sql: string,
  clauses: string[],
): { index: number; clause: string } | null {
  let depth = 0;
  let quote: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || (index > 0 && /[A-Za-z0-9_$]/.test(sql[index - 1]))) continue;

    const remaining = sql.slice(index);
    const clause = clauses.find(candidate => (
      remaining.slice(0, candidate.length).toUpperCase() === candidate
      && (remaining[candidate.length] === undefined || /\s|[;(]/.test(remaining[candidate.length]))
    ));
    if (clause) return { index, clause };
  }
  return null;
}

function parameterCountBefore(sql: string, end: number): number {
  let count = 0;
  let quote: string | null = null;
  for (let index = 0; index < end; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
    } else if (character === '?') {
      count += 1;
    }
  }
  return count;
}

function injectNetezzaSampleKeyFilter(
  sql: string,
  source: string,
  cubeName: string,
  keyColumns: string[],
  keyRows: unknown[][],
  params: unknown[],
): [string, unknown[]] | null {
  if (!keyRows.length || !keyColumns.length) return null;

  const relationPattern = source
    .replace(/"/g, '')
    .split('.')
    .map(part => `"?${escapeRegExp(part)}"?`)
    .join('\\s*\\.\\s*');
  const aliasPattern = `(?:AS\\s+)?"?${escapeRegExp(cubeName)}"?`;
  const fromPattern = new RegExp(`FROM\\s+${relationPattern}\\s+${aliasPattern}`, 'i');
  if (!fromPattern.test(sql)) return null;

  const whereClause = topLevelClauseIndex(sql, ['WHERE']);
  const nextClause = topLevelClauseIndex(sql, [
    'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION',
  ]);
  const insertionIndex = whereClause
    ? whereClause.index + whereClause.clause.length
    : nextClause?.index ?? sql.length;
  const cubeAlias = quoteIdentifier(cubeName);
  const condition = keyRows.map(row => {
    const parts = keyColumns.map((column, index) => {
      const value = row[index];
      if (value === null || value === undefined) return `${cubeAlias}.${quoteIdentifier(column)} IS NULL`;
      return `${cubeAlias}.${quoteIdentifier(column)} = ?`;
    });
    return `(${parts.join(' AND ')})`;
  }).join(' OR ');
  const filterSql = `(${condition})`;
  const updatedSql = whereClause
    ? `${sql.slice(0, insertionIndex)} (${filterSql}) AND${sql.slice(insertionIndex)}`
    : `${sql.slice(0, insertionIndex)} WHERE ${filterSql}${sql.slice(insertionIndex)}`;
  const values = keyRows.flatMap(row => row.filter(value => value !== null && value !== undefined));
  const parameterIndex = parameterCountBefore(sql, insertionIndex);
  const updatedParams = [
    ...params.slice(0, parameterIndex),
    ...values,
    ...params.slice(parameterIndex),
  ];
  return [updatedSql, updatedParams];
}

function cubeExpressionColumns(sql: unknown): string[] {
  if (typeof sql !== 'string') return [];
  return [...sql.matchAll(/\{CUBE\}\.((?:"[^"]+")|(?:[A-Za-z_][A-Za-z0-9_]*))/g)]
    .map(match => match[1].replace(/^"|"$/g, ''))
    .filter((column, index, columns) => columns.indexOf(column) === index);
}

function cubeDimensionExpressionColumns(dimensions: Array<{ sql?: unknown }> = []): string[] {
  return dimensions
    .flatMap(dimension => cubeExpressionColumns(dimension.sql))
    .filter((column, index, columns) => columns.indexOf(column) === index);
}

function injectSampleKeyJoin(
  sql: string,
  source: string,
  cubeName: string,
  keyColumns: string[],
  keyRows: unknown[][],
  params: unknown[],
  columnTypes: Map<string, string>,
): [string, unknown[]] | null {
  if (!keyRows.length || !keyColumns.length) return null;

  const relationPattern = source
    .replace(/"/g, '')
    .split('.')
    .map(part => `"?${escapeRegExp(part)}"?`)
    .join('\\s*\\.\\s*');
  const aliasPattern = `(?:AS\\s+)?"?${escapeRegExp(cubeName)}"?`;
  const fromPattern = new RegExp(`FROM\\s+${relationPattern}\\s+${aliasPattern}`, 'i');
  const fromMatch = sql.match(fromPattern);
  if (!fromMatch || fromMatch.index == null) return null;

  let nextParameter = params.length;
  const valuesSql = keyRows.map(row => (
    `(${keyColumns.map(column => `$${++nextParameter}::${postgresSampleCastType(columnTypes.get(column.toLowerCase()))}`).join(', ')})`
  )).join(', ');
  const sampleAlias = '__cube_sample_keys';
  const keyList = keyColumns.map(quoteIdentifier).join(', ');
  const cubeAlias = quoteIdentifier(cubeName);
  const joinConditions = keyColumns.map(column => (
    `${cubeAlias}.${quoteIdentifier(column)} = ${sampleAlias}.${quoteIdentifier(column)}`
  )).join(' AND ');
  const sampleJoin = ` JOIN (VALUES ${valuesSql}) AS ${sampleAlias} (${keyList}) ON ${joinConditions}`;
  const insertionPoint = fromMatch.index + fromMatch[0].length;
  const updatedSql = `${sql.slice(0, insertionPoint)}${sampleJoin}${sql.slice(insertionPoint)}`;
  return [updatedSql, [...params, ...keyRows.flatMap(row => row)]];
}

function renameYamlCubeReferences(source: string, currentName: string, nextName: string): string {
  const escapedName = escapeRegExp(currentName);
  return source
    .replace(
      new RegExp(`^(\\s*-\\s+name:\\s*)${escapedName}(\\s*(?:#.*)?)$`, 'gm'),
      `$1${nextName}$2`,
    )
    .replace(new RegExp(`\\{${escapedName}\\}`, 'g'), `{${nextName}}`);
}

export class DevServer {
  protected applyTemplatePackagesPromise: Promise<any> | null = null;

  protected dashboardAppProcess: ChildProcess & { dashboardUrlPromise?: Promise<any> } | null = null;

  protected livePreviewWatcher = new LivePreviewWatcher();

  protected projectLocks = new Map<string, {
    token: string;
    acquiredAt: number;
    expiresAt: number;
  }>();

  public constructor(
    protected readonly cubejsServer: CubejsServerCore,
    protected readonly options: DevServerOptions
  ) {
  }

  public initDevEnv(app: ExpressApplication, options: ServerCoreInitializedOptions) {
    const port = process.env.PORT || 4000; // TODO
    const apiUrl = process.env.CUBEJS_API_URL || `http://localhost:${port}`;
    const multiDatamart = this.options.multiDatamartRuntime;

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
        const expiredDatamartSession = /Datamart session is missing or expired|Datamart credentials are required/i.test(errorString);
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
            if (expiredDatamartSession) {
              res.status(401).json({ error: errorString });
            } else {
              res.status(500).json({ error: errorString });
            }
          }
        } catch (send500Error) {
          const send500ErrorString = ((send500Error as Error).stack || send500Error).toString();
          console.error(send500ErrorString);
          this.cubejsServer.event('Dev Server Error', { error: send500ErrorString });
          res.destroy(send500Error);
        }
      }
    };

    const pendingDatamarts = new Map<string, {
      id: string;
      name: string;
      connectionId: string;
    }>();

    const loadRelationshipDefinitions = async (req: Request) => {
      const requestId = getRequestIdFromRequest(req);
      const datamartContext = multiDatamart?.contextFromRequest(req);
      const context = {
        authInfo: null,
        securityContext: null,
        requestId,
        ...(datamartContext || {}),
      };
      const repository = multiDatamart
        ? multiDatamart.repository(datamartContext!)
        : this.cubejsServer.repository;
      const reader = new CubeRelationshipReader();
      const schemaConverter = new CubeSchemaConverter(repository, [reader]);
      await schemaConverter.generate();

      return {
        requestId,
        datamartContext,
        context,
        repository,
        models: reader.getModels(),
        relationships: reader.getRelationships(),
      };
    };

    const projectLockTtlMs = 90_000;
    const projectLockKey = (req: Request): string => {
      if (multiDatamart) {
        return `datamart:${multiDatamart.activeDatamart(req) || 'default'}`;
      }
      return `repository:${path.resolve(this.cubejsServer.repository.localPath())}`;
    };
    const projectLockToken = (req: Request): string | undefined => {
      const header = req.header('x-cube-project-lock');
      return typeof header === 'string' && header ? header : undefined;
    };
    const requireProjectLock = (req: Request): void => {
      const key = projectLockKey(req);
      const lock = this.projectLocks.get(key);
      const token = projectLockToken(req);
      if (!lock || lock.expiresAt <= Date.now()) {
        this.projectLocks.delete(key);
        throw new SchemaMutationError(423, 'O projeto não está bloqueado para esta sessão. Reabra o diagrama.');
      }
      if (!token || token !== lock.token) {
        throw new SchemaMutationError(423, 'O projeto está sendo editado por outra sessão.');
      }
      lock.expiresAt = Date.now() + projectLockTtlMs;
    };

    app.post('/playground/schema/lock', catchErrors(async (req: Request, res: Response) => {
      const key = projectLockKey(req);
      const now = Date.now();
      const current = this.projectLocks.get(key);
      if (current && current.expiresAt > now) {
        const requestedToken = projectLockToken(req);
        if (requestedToken && requestedToken === current.token) {
          current.expiresAt = now + projectLockTtlMs;
          return res.json({ token: current.token, expiresAt: current.expiresAt, ttlMs: projectLockTtlMs });
        }
        return res.status(423).json({
          error: 'O projeto já está sendo editado por outra sessão.',
          expiresAt: current.expiresAt,
        });
      }

      const lock = {
        token: crypto.randomUUID(),
        acquiredAt: now,
        expiresAt: now + projectLockTtlMs,
      };
      this.projectLocks.set(key, lock);
      return res.json({ token: lock.token, expiresAt: lock.expiresAt, ttlMs: projectLockTtlMs });
    }));

    app.post('/playground/schema/lock/heartbeat', catchErrors((req: Request, res: Response) => {
      const key = projectLockKey(req);
      const lock = this.projectLocks.get(key);
      const token = projectLockToken(req);
      if (!lock || lock.expiresAt <= Date.now() || !token || token !== lock.token) {
        this.projectLocks.delete(key);
        return res.status(423).json({ error: 'O lock do projeto expirou ou pertence a outra sessão.' });
      }
      lock.expiresAt = Date.now() + projectLockTtlMs;
      return res.json({ expiresAt: lock.expiresAt, ttlMs: projectLockTtlMs });
    }));

    app.delete('/playground/schema/lock', catchErrors((req: Request, res: Response) => {
      const key = projectLockKey(req);
      const lock = this.projectLocks.get(key);
      if (lock && projectLockToken(req) === lock.token) this.projectLocks.delete(key);
      return res.status(204).end();
    }));

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

      let compilerApi: any = null;
      let compilers: any = null;
      try {
        compilerApi = await this.cubejsServer.getCompilerApi(context);
        compilers = await compilerApi.getCompilers({ requestId });
      } catch (error: any) {
        // The relationship diagram must remain usable while a YAML file is
        // temporarily invalid, so the raw model reader is used below.
        console.warn(`Unable to compile schema for relationship diagram: ${String(error?.message || error).split('\n')[0]}`);
      }
      const metaCubes = compilers?.metaTransformer?.cubes || [];
      const drivers = new Map<string, BaseDriver>();

      try {
        const cubes: any[] = [];
        for (const model of models) {
          if (modelNames && !modelNames.has(model.name)) continue;
          const evaluatedCube = compilers?.cubeEvaluator?.cubeFromPath(model.name);
          if (evaluatedCube?.isView) continue;

          const dataSource = evaluatedCube?.dataSource || model.dataSource || 'default';
          const metaCube = metaCubes.find(cube => cube.config?.name === model.name)?.config;
          const primaryKeyNames = compilers?.cubeEvaluator?.primaryKeys?.[model.name]
            || (model.dimensions || [])
              .filter((dimension: any) => Boolean(dimension.primaryKey))
              .map((dimension: any) => dimension.name);
          const configuredDimensions = Array.isArray(model.dimensions) && model.dimensions.length
            ? model.dimensions
            : Array.isArray(metaCube?.dimensions)
            ? metaCube.dimensions
            : Object.entries(evaluatedCube?.dimensions || {}).map(([name, dimension]) => ({ name, ...(dimension as any) }));
          const configuredMeasures = Array.isArray(model.measures) && model.measures.length
            ? model.measures
            : Array.isArray(metaCube?.measures)
            ? metaCube.measures
            : Object.entries(evaluatedCube?.measures || {}).map(([name, measure]) => ({ name, ...(measure as any) }));
          const diagramCube: any = {
            ...model,
            title: metaCube?.title || model.title,
            dataSource,
            hasPrimaryKey: Boolean(primaryKeyNames.length),
            primaryKeyNames,
            dimensions: configuredDimensions.map((dimension: any) => ({
              ...dimension,
              name: String(dimension?.name || ''),
              title: typeof dimension?.title === 'string' ? dimension.title : undefined,
              sql: typeof dimension?.sql === 'string' ? dimension.sql : undefined,
              type: typeof dimension?.type === 'string' ? dimension.type : undefined,
              latitude: dimension?.latitude && typeof dimension.latitude === 'object'
                ? { sql: typeof dimension.latitude.sql === 'string' ? dimension.latitude.sql : undefined }
                : undefined,
              longitude: dimension?.longitude && typeof dimension.longitude === 'object'
                ? { sql: typeof dimension.longitude.sql === 'string' ? dimension.longitude.sql : undefined }
                : undefined,
              primaryKey: Boolean(dimension?.primaryKey || dimension?.primary_key),
            })).filter(dimension => dimension.name),
            measures: configuredMeasures.map((measure: any) => ({
              ...measure,
              name: String(measure?.name || ''),
              title: typeof measure?.title === 'string' ? measure.title : undefined,
              sql: typeof measure?.sql === 'string' ? measure.sql : undefined,
              type: typeof measure?.type === 'string' ? measure.type : undefined,
            })).filter(measure => measure.name),
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
            if (!columns?.length && compilerApi && compilers) {
              columns = await loadCompiledColumns();
            }
            if (!columns?.length) {
              columns = (model.dimensions || []).map((dimension: any) => ({
                name: dimension.name,
                type: dimension.type,
              }));
            }
            const physicalColumnsByName = new Map(
              (columns || []).map(column => [String(column.name).trim().toLowerCase(), column])
            );
            const dimensionNames = new Set<string>();
            const dimensionColumns = Object.entries(evaluatedCube?.dimensions || {}).map(([name, dimension]: [string, any]) => {
              const normalizedName = name.trim().toLowerCase();
              const physicalColumn = physicalColumnsByName.get(normalizedName);
              dimensionNames.add(normalizedName);

              return physicalColumn || {
                name,
                type: dimension?.type ? String(dimension.type) : undefined,
              };
            });
            const allColumns = [
              ...dimensionColumns,
              ...(columns || []).filter(column => !dimensionNames.has(String(column.name).toLowerCase())),
            ];
            const uniqueColumns = allColumns;

            if (!uniqueColumns.length) {
              throw new Error('The database driver did not return column metadata');
            }
            diagramCube.columns = uniqueColumns.map(column => {
              const name = String(column.name).trim();
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
        if (multiDatamart) {
          await Promise.allSettled(Array.from(drivers.values()).map(driver => driver.release?.()));
        }
      }
    };

    const saveValidatedSchemaChange = async (options: {
      definitions: Awaited<ReturnType<typeof loadRelationshipDefinitions>>;
      cubeName: string;
      originalFile: any;
      converter: CubeSchemaConverter;
      invalidMessage: (error: any) => string;
      rollbackRequestId: string;
      changedDuringValidationMessage?: string;
    }) => {
      const {
        definitions,
        cubeName,
        originalFile,
        converter,
        invalidMessage,
        rollbackRequestId,
      } = options;
      const { repository, context, requestId } = definitions;

      await converter.generate(cubeName);
      const updatedFile = converter.getSourceFiles().find(file => file.cubeName === cubeName);
      if (!updatedFile) {
        throw new SchemaMutationError(404, `Cube '${cubeName}' was not found`);
      }

      const currentFile = (await repository.dataSchemaFiles())
        .find(file => file.fileName === updatedFile.fileName);
      if (!currentFile || currentFile.content !== originalFile.content) {
        throw new SchemaMutationError(409, 'O arquivo mudou enquanto a alteração era preparada. Recarregue o diagrama e tente novamente.');
      }

      repository.writeDataSchemaFile(updatedFile.fileName, updatedFile.source);
      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(context);
        await compilerApi.getCompilers({ requestId });
      } catch (error: any) {
        const fileAfterFailure = (await repository.dataSchemaFiles())
          .find(file => file.fileName === updatedFile.fileName);
        if (fileAfterFailure?.content === updatedFile.source) {
          repository.writeDataSchemaFile(originalFile.fileName, originalFile.content);
          try {
            const compilerApi = await this.cubejsServer.getCompilerApi(context);
            await compilerApi.getCompilers({ requestId: rollbackRequestId });
          } catch (_rollbackError) {
            // Preserve the original source even if rollback compilation fails.
          }
        } else {
          throw new SchemaMutationError(
            409,
            options.changedDuringValidationMessage
              || 'O arquivo mudou enquanto a alteração era validada. Recarregue o diagrama e tente novamente.'
          );
        }
        throw new SchemaMutationError(400, repairUtf8Mojibake(invalidMessage(error)));
      }

      const savedFile = (await repository.dataSchemaFiles())
        .find(file => file.fileName === updatedFile.fileName);
      if (savedFile?.content !== updatedFile.source) {
        throw new SchemaMutationError(409, 'O arquivo mudou enquanto a alteração era validada. Recarregue o diagrama para ver a versão atual.');
      }

      return updatedFile;
    };

    const saveValidatedSchemaChanges = async (options: {
      definitions: Awaited<ReturnType<typeof loadRelationshipDefinitions>>;
      cubeNames: string[];
      originalFiles: any[];
      converter: CubeSchemaConverter;
      invalidMessage: (error: any) => string;
      rollbackRequestId: string;
      changedDuringValidationMessage?: string;
    }) => {
      const {
        definitions,
        cubeNames,
        originalFiles,
        converter,
        invalidMessage,
        rollbackRequestId,
      } = options;
      const { repository, context, requestId } = definitions;

      await converter.generate();
      const requestedCubes = new Set(cubeNames);
      const updatedByFile = new Map<string, { fileName: string; source: string }>();
      converter.getSourceFiles().forEach(file => {
        if (requestedCubes.has(file.cubeName)) {
          updatedByFile.set(file.fileName, file);
        }
      });
      const updatedFiles = Array.from(updatedByFile.values());
      if (!updatedFiles.length) {
        throw new SchemaMutationError(404, 'The relationship cubes were not found');
      }

      const originalByFile = new Map(originalFiles.map(file => [file.fileName, file]));
      const currentFiles = await repository.dataSchemaFiles();
      for (const originalFile of originalByFile.values()) {
        const currentFile = currentFiles.find(file => file.fileName === originalFile.fileName);
        if (!currentFile || currentFile.content !== originalFile.content) {
        throw new SchemaMutationError(409, 'O arquivo mudou enquanto a alteração era preparada. Recarregue o diagrama e tente novamente.');
        }
      }

      updatedFiles.forEach(file => repository.writeDataSchemaFile(file.fileName, file.source));
      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(context);
        await compilerApi.getCompilers({ requestId });
      } catch (error: any) {
        const filesAfterFailure = await repository.dataSchemaFiles();
        const allFilesStillUpdated = updatedFiles.every(updatedFile => (
          filesAfterFailure.find(file => file.fileName === updatedFile.fileName)?.content === updatedFile.source
        ));
        if (allFilesStillUpdated) {
          originalByFile.forEach(originalFile => {
            repository.writeDataSchemaFile(originalFile.fileName, originalFile.content);
          });
          try {
            const compilerApi = await this.cubejsServer.getCompilerApi(context);
            await compilerApi.getCompilers({ requestId: rollbackRequestId });
          } catch (_rollbackError) {
            // Preserve the original sources even if rollback compilation fails.
          }
        } else {
          throw new SchemaMutationError(
            409,
            options.changedDuringValidationMessage
              || 'O arquivo mudou enquanto a alteração era validada. Recarregue o diagrama e tente novamente.'
          );
        }
        throw new SchemaMutationError(400, repairUtf8Mojibake(invalidMessage(error)));
      }

      const savedFiles = await repository.dataSchemaFiles();
      if (!updatedFiles.every(updatedFile => (
        savedFiles.find(file => file.fileName === updatedFile.fileName)?.content === updatedFile.source
      ))) {
        throw new SchemaMutationError(409, 'O arquivo mudou enquanto a alteração era validada. Recarregue o diagrama para ver a versão atual.');
      }

      return updatedFiles[0];
    };

    app.get('/playground/datamarts', catchErrors(async (_req, res) => {
      if (!multiDatamart) return res.status(404).json({ error: 'Multi-datamart mode is disabled' });
      const connections = (await multiDatamart.registry.connections()).map(connection => ({
        ...connection,
        fields: (connection.fields || []).filter(field => !connection.defaults?.[field.name]),
      }));
      return res.json({
        datamarts: await multiDatamart.registry.list(),
        connections,
      });
    }));

    app.post('/playground/datamarts', catchErrors(async (req, res) => {
      if (!multiDatamart) return res.status(404).json({ error: 'Multi-datamart mode is disabled' });
      const { id, name, connectionId, credentials = {} } = req.body || {};
      if (!id || !name || !connectionId || typeof credentials !== 'object') {
        return res.status(400).json({ error: 'id, name, connectionId, and credentials are required' });
      }

      const connection = (await multiDatamart.registry.connections())
        .find(item => item.id === connectionId);
      if (!connection) return res.status(400).json({ error: `Unknown connection preset: ${connectionId}` });

      const missing = (connection.fields || [])
        .filter(field => field.required && !credentials[field.name] && !connection.defaults?.[field.name])
        .map(field => field.name);
      if (missing.length) {
        pendingDatamarts.set(id, { id, name, connectionId });
        const pendingDatamart = {
          id,
          name,
          connectionId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pending: true,
        };
        return res.status(200).json({
          ...pendingDatamart,
          datamart: pendingDatamart,
        });
      }

      const fullCredentials = {
        ...(connection.defaults || {}),
        ...credentials,
        CUBEJS_DB_TYPE: connection.dbType || '',
      };

      try {
        await multiDatamart.testConnectionPreset(connection.id, fullCredentials);
      } catch (e) {
        let message = (e as Error).message || 'Connection failed';
        for (const credential of Object.values(credentials)) {
          if (typeof credential === 'string' && credential) {
            message = message.split(credential).join('[REDACTED]');
          }
        }
        throw new Error(message);
      }

      const datamart = await multiDatamart.registry.create({ id, name, connectionId });
      const sessionId = multiDatamart.sessions.create(datamart.id, fullCredentials);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `cube_datamart_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict${secure}`);
      return res.status(201).json({
        ...datamart,
        datamart,
        apiPath: `/cubejs-api/datamarts/${datamart.id}/v1`,
      });
    }));

    app.post('/playground/datamarts/:datamartId/session', catchErrors(async (req, res) => {
      if (!multiDatamart) {
        return res.status(404).json({ error: 'Multi-datamart mode is disabled' });
      }
      const pendingDatamart = pendingDatamarts.get(req.params.datamartId);
      let datamart = await multiDatamart.registry.get(req.params.datamartId).catch(() => null);
      if (!datamart && !pendingDatamart) {
        return res.status(404).json({ error: `Unknown datamart: ${req.params.datamartId}` });
      }

      const datamartConnectionId = datamart?.connectionId || pendingDatamart?.connectionId || '';
      const connection = (await multiDatamart.registry.connections())
        .find(item => item.id === datamartConnectionId);
      if (!connection) {
        return res.status(400).json({ error: `Unknown connection preset: ${datamartConnectionId}` });
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
        await multiDatamart.testConnectionPreset(connection.id, fullCredentials);
      } catch (e) {
        let message = (e as Error).message || 'Connection failed';
        for (const credential of Object.values(credentials)) {
          if (typeof credential === 'string' && credential) {
            message = message.split(credential).join('[REDACTED]');
          }
        }
        throw new Error(message);
      }

      if (!datamart && pendingDatamart) {
        datamart = await multiDatamart.registry.create({
          id: pendingDatamart.id,
          name: pendingDatamart.name,
          connectionId: pendingDatamart.connectionId,
        });
        pendingDatamarts.delete(datamart.id);
      }

      if (!datamart) {
        return res.status(500).json({ error: `Unable to open datamart: ${req.params.datamartId}` });
      }

      const sessionId = multiDatamart.sessions.create(datamart.id, fullCredentials);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `cube_datamart_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict${secure}`);
      return res.json({ datamart, apiPath: `/cubejs-api/datamarts/${datamart.id}/v1` });
    }));

    app.delete('/playground/datamarts/session', catchErrors((req, res) => {
      const sessionId = this.cookie(req, 'cube_datamart_session');
      if (sessionId) multiDatamart?.sessions.delete(sessionId);
      res.setHeader('Set-Cookie', 'cube_datamart_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return res.status(204).end();
    }));

    app.get('/playground/context', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Env Open');

      const datamartSession = multiDatamart ? this.cookie(req, 'cube_datamart_session') : undefined;
      const activeDatamartId = multiDatamart?.activeDatamart(req) || null;
      const activeDatamart = activeDatamartId
        ? await multiDatamart?.registry.get(activeDatamartId).catch(() => null)
        : null;
      if (multiDatamart && datamartSession && !activeDatamart) {
        res.setHeader('Set-Cookie', 'cube_datamart_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      }

      res.json({
        cubejsToken,
        basePath: activeDatamart
          ? `${options.basePath}/datamarts/${activeDatamart.id}`
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
        multiDatamart: {
          enabled: Boolean(multiDatamart),
          activeDatamart,
        },
      });
    }));

    app.get('/playground/db-schema', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server DB Schema Load');
      const datamartContext = multiDatamart?.contextFromRequest(req);
      const driver = await this.cubejsServer.getDriver({
        dataSource: req.body.dataSource || 'default',
        authInfo: null,
        securityContext: null,
        requestId: getRequestIdFromRequest(req),
        ...(datamartContext || {}),
      });
      let tablesSchema;
      try {
        tablesSchema = await driver.tablesSchema();
      } finally {
        if (multiDatamart) await driver.release?.();
      }

      this.cubejsServer.event('Dev Server DB Schema Load Success');
      if (Object.keys(tablesSchema || {}).length === 0) {
        this.cubejsServer.event('Dev Server DB Schema Load Empty');
      }
      res.json({ tablesSchema });
    }));

    app.post('/playground/schema/table-preview', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Table Preview Load');
      const { schemaName, tableName, dataSource = 'default' } = req.body || {};
      if (typeof schemaName !== 'string' || !schemaName
        || typeof tableName !== 'string' || !tableName) {
        return res.status(400).json({ error: 'schemaName and tableName are required' });
      }

      const datamartContext = multiDatamart?.contextFromRequest(req);
      const requestId = getRequestIdFromRequest(req);
      const driver = await this.cubejsServer.getDriver({
        dataSource,
        authInfo: null,
        securityContext: null,
        requestId,
        ...(datamartContext || {}),
      });
      try {
        const qualifiedTable = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
        const rows = await driver.query<Record<string, unknown>>(
          `SELECT * FROM ${qualifiedTable} LIMIT 25`,
          [],
          { requestId } as any,
        );
        return res.json({
          columns: rows.length ? Object.keys(rows[0]) : [],
          rows: serializeBigInts(rows.slice(0, 25)),
        });
      } finally {
        if (multiDatamart) await driver.release?.();
      }
    }));

    app.post('/playground/schema/table-count', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Table Count Load');
      const { schemaName, tableName, dataSource = 'default' } = req.body || {};
      if (typeof schemaName !== 'string' || !schemaName
        || typeof tableName !== 'string' || !tableName) {
        return res.status(400).json({ error: 'schemaName and tableName are required' });
      }

      const datamartContext = multiDatamart?.contextFromRequest(req);
      const requestId = getRequestIdFromRequest(req);
      const driver = await this.cubejsServer.getDriver({
        dataSource,
        authInfo: null,
        securityContext: null,
        requestId,
        ...(datamartContext || {}),
      });
      try {
        const qualifiedTable = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
        const result = await driver.query<{ total_count: string | number }>(
          `SELECT COUNT(*) AS "total_count" FROM ${qualifiedTable}`,
          [],
          { requestId } as any,
        );
        const countRow = result[0] || {};
        const countKey = Object.keys(countRow).find((key) => key.toLocaleLowerCase() === 'total_count');
        const total = countKey ? countRow[countKey] : Object.values(countRow)[0];
        return res.json({ total: total == null ? null : String(total) });
      } finally {
        if (multiDatamart) await driver.release?.();
      }
    }));

    app.get('/playground/schema/relationships', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Relationship Diagram Load');
      const diagram = await loadRelationshipDiagram(req);
      res.json(diagram);
    }));

    app.post('/playground/schema/sample/count', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Schema Sample Count Load');
      const { cubeName, mode = 'raw' } = req.body || {};
      if (typeof cubeName !== 'string' || !cubeName) {
        return res.status(400).json({ error: 'cubeName is required' });
      }
      if (mode !== 'raw' && mode !== 'cube') {
        return res.status(400).json({ error: 'mode must be raw or cube' });
      }

      const definitions = await loadRelationshipDefinitions(req);
      const model = definitions.models.find(cube => cube.name === cubeName);
      if (!model) return res.status(404).json({ error: `Cube '${cubeName}' was not found` });
      if (mode === 'raw' && !model.source) {
        return res.status(400).json({ error: `Cube '${cubeName}' has no SQL source` });
      }

      const dataSource = model.dataSource || 'default';
      const driver = await this.cubejsServer.getDriver({
        ...definitions.context,
        dataSource,
      });
      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(definitions.context, { forceRefresh: true });
        let countSql: string;
        let countParams: unknown[] = [];

        if (mode === 'raw') {
          const source = model.source!.trim().replace(/;$/, '');
          const from = model.sourceType === 'sql' ? `(${source}) AS cube_sample_count` : source;
          // Keep this expression portable. PostgreSQL accepts the explicit
          // ::bigint cast, but Netezza does not use PostgreSQL's cast syntax.
          countSql = `SELECT COUNT(*) AS total_count FROM ${from}`;
        } else {
          const dimensions = (model.dimensions || []).map(dimension => `${cubeName}.${dimension.name}`);
          const measures = (model.measures || []).map(measure => `${cubeName}.${measure.name}`);
          if (!dimensions.length && !measures.length) {
            return res.status(400).json({ error: `Cube '${cubeName}' has no dimensions or measures` });
          }
          const compilers = await compilerApi.getCompilers({ requestId: definitions.requestId });
          const query = await compilerApi.createQueryByDataSource(compilers, {
            cube: cubeName,
            dimensions,
            measures,
            timezone: 'UTC',
            requestId: definitions.requestId,
          } as any, dataSource);
          let cubeSql: string;
          [cubeSql, countParams] = compilers.compiler.withQuery(query, () => query.buildSqlAndParams());
          // The count must be applied after Cube's GROUP BY, so it represents
          // the number of configured cube rows rather than source records.
          // Keep this expression portable. PostgreSQL accepts the explicit
          // ::bigint cast, but Netezza does not use PostgreSQL's cast syntax.
          countSql = `SELECT COUNT(*) AS total_count FROM (${cubeSql}) AS cube_sample_count`;
        }

        let result: { total_count?: string | number }[];
        try {
          result = await driver.query<{ total_count?: string | number }>(
            countSql,
            countParams,
            { requestId: definitions.requestId } as any
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Falha ao contar os registros do cubo "${cubeName}".\nSQL gerado:\n${countSql}\nErro do driver: ${message}`);
        }
        const countRow = result[0] || {};
        const countKey = Object.keys(countRow).find(key => key.toLowerCase() === 'total_count');
        const total = countKey ? countRow[countKey] : Object.values(countRow)[0];
        return res.json({
          total: total == null ? '0' : String(total),
          sql: countSql,
          params: serializeBigInts(countParams),
        });
      } finally {
        if (multiDatamart) await driver.release?.();
      }
    }));

    app.post('/playground/schema/sample', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Schema Sample Load');
      const { cubeName, mode = 'raw', queryOnly = false } = req.body || {};
      if (typeof cubeName !== 'string' || !cubeName) {
        return res.status(400).json({ error: 'cubeName is required' });
      }
      if (mode !== 'raw' && mode !== 'cube') {
        return res.status(400).json({ error: 'mode must be raw or cube' });
      }

      const definitions = await loadRelationshipDefinitions(req);
      const model = definitions.models.find(cube => cube.name === cubeName);
      if (!model) return res.status(404).json({ error: `Cube '${cubeName}' was not found` });
      if (mode === 'raw' && !model.source) {
        return res.status(400).json({ error: `Cube '${cubeName}' has no SQL source` });
      }

      const dataSource = model.dataSource || 'default';
      const driver = await this.cubejsServer.getDriver({
        ...definitions.context,
        dataSource,
      });
      const executeSampleQuery = async <R = Record<string, unknown>>(
        statement: string,
        values: unknown[],
        stage: string,
      ): Promise<R[]> => {
        try {
          return await driver.query<R>(
            statement,
            values,
            { requestId: definitions.requestId } as any,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Falha ao executar a etapa "${stage}" da amostra do cubo "${cubeName}".\n`
            + `SQL gerado:\n${statement}\n`
            + `Erro do driver: ${message}`,
          );
        }
      };
      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(definitions.context, { forceRefresh: true });
        const dbType = await compilerApi.getDbType(dataSource);
        const isPostgres = ['postgres', 'postgresql'].includes(dbType.toLowerCase());
        const isNetezza = dbType.toLowerCase() === 'netezza';
        const dimensionSampleLimit = 1000;
        const modelSource = model.source?.trim().replace(/;$/, '');
        let sql: string;
        let params: unknown[] = [];
        let columnLabels: Record<string, string> = {};
        let columnTypes: Record<string, string> = {};

        if (mode === 'cube') {
          const compilers = await compilerApi.getCompilers({ requestId: definitions.requestId });
          const dimensions = (model.dimensions || []).map(dimension => `${cubeName}.${dimension.name}`);
          const measures = (model.measures || []).map(measure => `${cubeName}.${measure.name}`);
          if (!dimensions.length && !measures.length) {
            return res.status(400).json({ error: `Cube '${cubeName}' has no dimensions or measures` });
          }
          [...(model.dimensions || []), ...(model.measures || [])].forEach(member => {
            const label = member.title || member.name;
            columnLabels[`${cubeName}.${member.name}`.toLowerCase()] = label;
            columnLabels[`${cubeName}__${member.name}`.toLowerCase()] = label;
            columnLabels[member.name.toLowerCase()] = label;
            if (member.type) {
              columnTypes[`${cubeName}.${member.name}`.toLowerCase()] = String(member.type);
              columnTypes[`${cubeName}__${member.name}`.toLowerCase()] = String(member.type);
              columnTypes[member.name.toLowerCase()] = String(member.type);
            }
          });

          const primaryKeyNames = compilers.cubeEvaluator.primaryKeys?.[cubeName] || [];
          const normalizedPrimaryKeyNames = new Set(
            primaryKeyNames.map((name: string) => name.split('.').pop()!.toLowerCase())
          );
          // A Cube primary key can repeat in an aggregated fact. Use every
          // physical source column referenced by a dimension to preserve the
          // dimensional grain represented by the sample.
          const dimensionColumns = cubeDimensionExpressionColumns(model.dimensions || []);
          let usedSampleKeyRestriction = false;

          if (isPostgres && model.sourceType === 'sql_table' && modelSource && dimensionColumns.length >= 1) {
            const source = modelSource;
            const quotedColumns = dimensionColumns.map(quoteIdentifier).join(', ');
            const sourceParts = source.split('.').map(part => part.replace(/^"|"$/g, ''));
            const physicalColumnTypes = new Map<string, string>();
            if (sourceParts.length === 2) {
              const physicalColumns = await driver.query<{ column_name: string; udt_name: string }>(
                'SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
                [sourceParts[0], sourceParts[1]],
                { requestId: definitions.requestId } as any
              );
              physicalColumns.forEach(column => physicalColumnTypes.set(
                column.column_name.toLowerCase(),
                column.udt_name,
              ));
            }
            if (!physicalColumnTypes.size) {
              (await driver.tableColumnTypes(source)).forEach(column => physicalColumnTypes.set(
                String(column.name).toLowerCase(),
                String(column.type),
              ));
            }
            const sampledRows = await postgresSampleRows(
              driver,
              source,
              quotedColumns,
              dimensionSampleLimit,
              definitions.requestId,
            );
            const keyRows = sampledRows.map(row => dimensionColumns.map(column => rowValue(row, column)));

            const uniqueKeyRows = [...new Map(
              keyRows.map(row => [JSON.stringify(row), row])
            ).values()];
            const query = await compilerApi.createQueryByDataSource(compilers, {
              cube: cubeName,
              dimensions,
              measures,
              timezone: 'UTC',
              limit: 25,
              requestId: definitions.requestId,
            } as any, dataSource);
            [sql, params] = compilers.compiler.withQuery(query, () => query.buildSqlAndParams());
            const joinedQuery = injectSampleKeyJoin(
              sql,
              source,
              cubeName,
              dimensionColumns,
              uniqueKeyRows,
              params,
              physicalColumnTypes,
            );
            if (joinedQuery) {
              [sql, params] = joinedQuery;
              usedSampleKeyRestriction = true;
            }
          } else if (isNetezza && model.sourceType === 'sql_table' && modelSource && dimensionColumns.length >= 1) {
            try {
              const source = modelSource;
              const quotedColumns = dimensionColumns.map(quoteIdentifier).join(', ');
              const sampledRows = await netezzaSampleRows(
                driver,
                source,
                quotedColumns,
                250,
                definitions.requestId,
              );
              const keyRows = uniqueSampleKeyRows(sampledRows, dimensionColumns, 250);
              const query = await compilerApi.createQueryByDataSource(compilers, {
                cube: cubeName,
                dimensions,
                measures,
                timezone: 'UTC',
                limit: 25,
                requestId: definitions.requestId,
              } as any, dataSource);
              [sql, params] = compilers.compiler.withQuery(query, () => query.buildSqlAndParams());
              const restrictedQuery = injectNetezzaSampleKeyFilter(
                sql,
                source,
                cubeName,
                dimensionColumns,
                keyRows,
                params,
              );
              if (restrictedQuery) {
                [sql, params] = restrictedQuery;
                usedSampleKeyRestriction = true;
              }
            } catch {
              // Fall back to the regular cube sample if the physical key
              // projection or predicate is not accepted by this Netezza
              // version. The optimization must never make sampling fail.
            }
          }

          if (!usedSampleKeyRestriction) {
            let filters: any[] = [];
            if (!isNetezza) {
              const sampleQuery = await compilerApi.createQueryByDataSource(compilers, {
              cube: cubeName,
              dimensions,
              measures: [],
              timezone: 'UTC',
              ungrouped: true,
              allowUngroupedWithoutPrimaryKey: true,
              limit: dimensionSampleLimit,
              requestId: definitions.requestId,
            } as any, dataSource);

            const [sampleSql, sampleParams] = compilers.compiler.withQuery(sampleQuery, () => (
              sampleQuery.buildSqlAndParams()
            ));
            const dimensionSampleRows = await executeSampleQuery<Record<string, unknown>>(
              `SELECT * FROM (${sampleSql}) AS dimension_sample LIMIT ${dimensionSampleLimit}`,
              sampleParams,
              'seleção dos valores de referência das dimensões',
            );
            const filterDimensions = normalizedPrimaryKeyNames.size
              ? dimensions.filter(dimension => normalizedPrimaryKeyNames.has(dimension.split('.').pop()!.toLowerCase()))
              : dimensions;
            const dimensionSampleFilters = dimensionSampleRows
              .map(row => {
                const conditions = filterDimensions.map(member => {
                  const memberName = member.split('.').pop()!;
                  const aliases = [
                    `${cubeName}__${memberName}`,
                    `${cubeName}_${memberName}`,
                    member,
                    memberName,
                  ].map(alias => alias.toLowerCase());
                  const entry = Object.entries(row).find(([key]) => aliases.includes(key.toLowerCase()));
                  return entry ? { member, value: entry[1] } : null;
                });
                if (conditions.some(condition => !condition)) return null;

                return {
                  and: conditions.map(condition => condition!.value == null
                    ? { member: condition!.member, operator: 'not_set' }
                    : { member: condition!.member, operator: 'equals', values: [String(condition!.value)] }),
                };
              })
              .filter(Boolean);
              filters = dimensionSampleFilters.length
                ? [{ or: dimensionSampleFilters }]
                : [];
            }

            // The dimension-only query is only used to narrow the sample to
            // representative primary-key values. If those values cannot be
            // mapped back because the driver/compiler returned an unexpected
            // column alias, the cube query is still valid without filters.
            // Returning an empty response here made the UI show "No Data"
            // while the count endpoint correctly reported records.
            const query = await compilerApi.createQueryByDataSource(compilers, {
              cube: cubeName,
              dimensions,
              measures,
              filters,
              timezone: 'UTC',
              limit: 25,
              requestId: definitions.requestId,
            } as any, dataSource);
            [sql, params] = compilers.compiler.withQuery(query, () => query.buildSqlAndParams());
          }
        } else {
          const source = model.source!.trim().replace(/;$/, '');
          const from = model.sourceType === 'sql' ? `(${source}) AS cube_sample` : source;
          sql = `SELECT * FROM ${from}`;
        }

        if (queryOnly) {
          return res.json({
            sql: `SELECT * FROM (${sql}) AS sample_rows LIMIT 25`,
            params: serializeBigInts(params),
          });
        }

        if (mode === 'raw' && model.sourceType === 'sql_table') {
          try {
            let nativeTypesLoaded = false;
            const sourceParts = modelSource
              ?.split('.')
              .map(part => part.replace(/^"|"$/g, ''));

            if (isPostgres && sourceParts?.length === 2) {
              const nativeColumns = await driver.query<{ column_name: string; postgres_type: string }>(
                `SELECT a.attname AS column_name,
                        format_type(a.atttypid, a.atttypmod) AS postgres_type
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1
                   AND c.relname = $2
                   AND a.attnum > 0
                   AND NOT a.attisdropped
                 ORDER BY a.attnum`,
                sourceParts,
                { requestId: definitions.requestId } as any,
              );
              nativeColumns.forEach(column => {
                columnTypes[String(column.column_name).toLowerCase()] = String(column.postgres_type);
              });
              nativeTypesLoaded = nativeColumns.length > 0;
            }

            if (!nativeTypesLoaded) {
              (await driver.tableColumnTypes(model.source!)).forEach(column => {
                columnTypes[String(column.name).toLowerCase()] = String(column.type);
              });
            }
          } catch {
            // Column metadata is optional; it must not prevent the sample query.
          }
        }

        let rows: Record<string, unknown>[];
        const source = modelSource;
        if (mode === 'raw' && model.sourceType === 'sql_table' && isPostgres && source) {
          rows = await postgresSampleRows(
            driver,
            source,
            '*',
            dimensionSampleLimit,
            definitions.requestId,
          );

        } else if (mode === 'raw' && model.sourceType === 'sql_table' && isNetezza && source) {
          rows = await netezzaSampleRows(
            driver,
            source,
            '*',
            25,
            definitions.requestId,
          );

        } else {
          rows = await executeSampleQuery<Record<string, unknown>>(
            `SELECT * FROM (${sql}) AS sample_rows LIMIT 25`,
            params,
            'seleção da amostra final',
          );
        }
        const sampleRows = (rows || []).slice(0, 25);
        const columns = sampleRows.length
          ? Object.keys(sampleRows[0])
          : mode === 'raw'
            ? (await driver.tableColumnTypes(model.source!)).map(column => String(column.name))
            : [];

        return res.json({
          columns,
          columnLabels,
          columnTypes,
          rows: serializeBigInts(sampleRows),
          sql,
          params: serializeBigInts(params),
        });
      } finally {
        if (multiDatamart) await driver.release?.();
      }
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
        new CubeDimensionOrderConverter(),
      ]);
      let updatedFile;
      try {
        updatedFile = await saveValidatedSchemaChange({
          definitions,
          cubeName,
          originalFile,
          converter,
          rollbackRequestId: `${requestId}-primary-key-rollback`,
          invalidMessage: error => {
            const reason = compilerValidationReason(error);
            return `The primary key was not saved because the model would be invalid${reason ? `: ${reason}` : ''}`;
          },
        });
      } catch (error: any) {
        if (error?.status) return res.status(error.status).json({ error: error.message });
        throw error;
      }

      return res.json({ status: 'ok', fileName: updatedFile.fileName, content: updatedFile.source });
    }));

    app.post('/playground/schema/dimension', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Dimension Save');
      const {
        cubeName,
        dimensionName,
        name,
        sql,
        type,
        title,
        primaryKey = false,
      } = req.body || {};

      if (typeof cubeName !== 'string' || !cubeName
        || (dimensionName !== undefined && typeof dimensionName !== 'string')
        || typeof name !== 'string' || !name
        || typeof sql !== 'string' || !sql) {
        return res.status(400).json({ error: 'cubeName, name, and sql are required' });
      }
      if (/\r|\n/.test(cubeName) || /\r|\n/.test(name) || (dimensionName && /\r|\n/.test(dimensionName))) {
        return res.status(400).json({ error: 'Invalid cube or dimension name' });
      }
      if (typeof primaryKey !== 'boolean') {
        return res.status(400).json({ error: 'primaryKey must be boolean' });
      }

      const definitions = await loadRelationshipDefinitions(req);
      const model = definitions.models.find(cube => cube.name === cubeName);
      if (!model) return res.status(404).json({ error: `Cube '${cubeName}' was not found` });

      const { repository, context, requestId } = definitions;
      const originalFile = (await repository.dataSchemaFiles()).find(file => file.fileName === model.fileName);
      if (!originalFile) return res.status(404).json({ error: `File '${model.fileName}' was not found` });

      const converter = new CubeSchemaConverter(repository, [
        new CubeDimensionConverter({
          cubeName,
          dimensionName: dimensionName || undefined,
          name,
          sql,
          type: typeof type === 'string' && type ? type : undefined,
          title: typeof title === 'string' && title ? title : undefined,
          primaryKey,
        }),
      ]);
      let updatedFile;
      try {
        updatedFile = await saveValidatedSchemaChange({
          definitions,
          cubeName,
          originalFile,
          converter,
          rollbackRequestId: `${requestId}-dimension-rollback`,
          invalidMessage: error => `A dimensão não foi salva porque o schema é inválido: ${compilerValidationReason(error)}`,
        });
      } catch (error: any) {
        if (error?.status) return res.status(error.status).json({ error: error.message });
        throw error;
      }

      return res.json({ status: 'ok', fileName: updatedFile.fileName, content: updatedFile.source });
    }));

    app.post('/playground/schema/item', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Schema Item Save');
      const { cubeName, section, itemName, itemIndex, values = {}, operation = 'upsert' } = req.body || {};
      const validSections = new Set(['dimensions', 'measures', 'segments', 'hierarchies', 'pre_aggregations', 'cube']);
      if (typeof cubeName !== 'string' || !cubeName
        || typeof section !== 'string' || !validSections.has(section)
        || !['upsert', 'delete'].includes(operation)
        || (operation === 'delete' && (!itemName || section === 'cube'))
        || (itemName !== undefined && typeof itemName !== 'string')
        || (itemIndex !== undefined && (!Number.isInteger(itemIndex) || itemIndex < 0))
        || !values || typeof values !== 'object' || Array.isArray(values)) {
        return res.status(400).json({ error: 'cubeName, section, operation, and values are required' });
      }
      if (/\r|\n/.test(cubeName) || (itemName && /\r|\n/.test(itemName))) {
        return res.status(400).json({ error: 'Invalid cube or item name' });
      }

      const definitions = await loadRelationshipDefinitions(req);
      const model = definitions.models.find(cube => cube.name === cubeName);
      if (!model) return res.status(404).json({ error: `Cube '${cubeName}' was not found` });

      const { repository, context, requestId } = definitions;
      const originalFile = (await repository.dataSchemaFiles()).find(file => file.fileName === model.fileName);
      if (!originalFile) return res.status(404).json({ error: `File '${model.fileName}' was not found` });

      const converter = new CubeSchemaConverter(repository, [
        new CubeSchemaItemConverter({
          cubeName,
          section: section as any,
          itemName: itemName || undefined,
          itemIndex,
          values,
          operation,
        }),
      ]);
      let updatedFile;
      try {
        updatedFile = await saveValidatedSchemaChange({
          definitions,
          cubeName,
          originalFile,
          converter,
          rollbackRequestId: `${requestId}-schema-item-rollback`,
          invalidMessage: error => `O item não foi salvo porque o schema é inválido: ${compilerValidationReason(error)}`,
        });
      } catch (error: any) {
        if (error?.status) return res.status(error.status).json({ error: error.message });
        throw error;
      }

      return res.json({ status: 'ok', fileName: updatedFile.fileName, content: updatedFile.source });
    }));

    app.post('/playground/schema/snapshot', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Schema Snapshot Save');
      requireProjectLock(req);
      const snapshots = req.body?.cubes;
      if (!Array.isArray(snapshots) || snapshots.length === 0 || snapshots.length > 200) {
        return res.status(400).json({ error: 'cubes must be a non-empty array with at most 200 items' });
      }

      const definitions = await loadRelationshipDefinitions(req);
      const cubeNames: string[] = [];
      snapshots.forEach((snapshot: any) => {
        if (!snapshot || typeof snapshot.cubeName !== 'string' || !snapshot.cubeName
          || !definitions.models.some(cube => cube.name === snapshot.cubeName)) {
          throw new SchemaMutationError(400, 'Invalid schema snapshot cube');
        }
        cubeNames.push(snapshot.cubeName);
        if (!Array.isArray(snapshot.joins)) {
          throw new SchemaMutationError(400, 'Invalid schema snapshot joins: the diagram must send the complete relationship state');
        }
        ['dimensions', 'measures', 'hierarchies', 'joins'].forEach(section => {
          if (snapshot[section] !== undefined && !Array.isArray(snapshot[section])) {
            throw new SchemaMutationError(400, `Invalid schema snapshot section '${section}'`);
          }
        });
      });

      const { repository, requestId } = definitions;
      const files = await repository.dataSchemaFiles();
      const fileNames = new Set(cubeNames.map(cubeName => (
        definitions.models.find(cube => cube.name === cubeName)?.fileName
      )).filter((fileName): fileName is string => Boolean(fileName)));
      const originalFiles = files.filter(file => fileNames.has(file.fileName));
      if (originalFiles.length !== fileNames.size) {
        throw new SchemaMutationError(404, 'The schema snapshot file was not found');
      }

      const converter = new CubeSchemaConverter(repository, snapshots.map((snapshot: any) => (
        new CubeSchemaSnapshotConverter(snapshot)
      )));
      await converter.generate();
      const originalByFile = new Map(originalFiles.map(file => [file.fileName, file]));
      const generatedFiles = converter.getSourceFiles()
        .filter(file => originalByFile.has(file.fileName));
      const sourceChanged = generatedFiles.length !== originalFiles.length || generatedFiles.some(file => (
        file.source !== originalByFile.get(file.fileName)?.content
      ));
      if (!sourceChanged) {
        return res.json({ status: 'ok', changed: false, files: [] });
      }
      let updatedFiles;
      try {
        updatedFiles = await saveValidatedSchemaChanges({
          definitions,
          cubeNames: Array.from(new Set(cubeNames)),
          originalFiles,
          converter,
          rollbackRequestId: `${requestId}-schema-snapshot-rollback`,
          invalidMessage: error => {
            const reason = compilerValidationReason(error);
            return `A estrutura de dados não foi salva porque o modelo ficaria inválido${reason ? `: ${reason}` : ''}`;
          },
        });
      } catch (error: any) {
        if (error?.status) return res.status(error.status).json({ error: error.message });
        throw error;
      }

      return res.json({ status: 'ok', changed: true, files: updatedFiles });
    }));

    app.post('/playground/schema/changes', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Schema Changes Save');
      const changes = req.body?.changes;
      if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) {
        return res.status(400).json({ error: 'changes must be a non-empty array with at most 100 items' });
      }

      const definitions = await loadRelationshipDefinitions(req);
      const { repository, requestId } = definitions;
      const converters: any[] = [];
      const cubeNames = new Set<string>();
      const relationshipState = [...definitions.relationships];
      const diagramCache = new Map<string, any>();
      const validSections = new Set(['dimensions', 'measures', 'segments', 'hierarchies', 'pre_aggregations', 'cube']);
      const validRelationships = new Set(['one_to_one', 'one_to_many', 'many_to_one']);

      const addCube = (cubeName: unknown) => {
        if (typeof cubeName !== 'string' || !cubeName || /\r|\n/.test(cubeName)) {
          throw new SchemaMutationError(400, 'Invalid cube name');
        }
        if (!definitions.models.some(cube => cube.name === cubeName)) {
          throw new SchemaMutationError(404, `Cube '${cubeName}' was not found`);
        }
        cubeNames.add(cubeName);
      };

      const getDiagram = async (names: string[]) => {
        const key = [...names].sort().join('|');
        const cached = diagramCache.get(key);
        if (cached) return cached;
        const diagram = await loadRelationshipDiagram(req, new Set(names), definitions);
        diagramCache.set(key, diagram);
        return diagram;
      };

      for (const change of changes) {
        const endpoint = change?.endpoint;
        const body = change?.body || {};

        if (endpoint === 'playground/schema/item') {
          const { cubeName, section, itemName, itemIndex, values = {}, operation = 'upsert' } = body;
          if (typeof cubeName !== 'string' || !cubeName
            || typeof section !== 'string' || !validSections.has(section)
            || !['upsert', 'delete'].includes(operation)
            || (operation === 'delete' && (!itemName || section === 'cube'))
            || (itemName !== undefined && typeof itemName !== 'string')
            || (itemIndex !== undefined && (!Number.isInteger(itemIndex) || itemIndex < 0))
            || !values || typeof values !== 'object' || Array.isArray(values)) {
            throw new SchemaMutationError(400, 'Invalid schema item change');
          }
          addCube(cubeName);
          converters.push(new CubeSchemaItemConverter({
            cubeName,
            section: section as any,
            itemName,
            itemIndex,
            values,
            operation: operation as any,
          }));
          continue;
        }

        if (endpoint === 'playground/schema/primary-key') {
          const { cubeName, columnName } = body;
          addCube(cubeName);
          if (typeof columnName !== 'string' || !columnName || /\r|\n|`|\$\{|\{|\}/.test(columnName)) {
            throw new SchemaMutationError(400, 'Unsupported column name');
          }
          const diagram = await getDiagram([cubeName]);
          const cube = diagram.cubes.find(item => item.name === cubeName);
          const column = cube?.columns.find(item => item.name === columnName);
          if (!column) throw new SchemaMutationError(404, `Column '${columnName}' was not found in '${cubeName}'`);
          if (!column.primaryKey) {
            converters.push(new CubePrimaryKeyConverter({ cubeName, columnName, columnType: column.type }));
            converters.push(new CubeDimensionOrderConverter());
          }
          continue;
        }

        if (endpoint === 'playground/schema/relationship') {
          const {
            sourceCube,
            targetCube,
            sourceColumn,
            targetColumn,
            relationship,
            operation = 'create',
            replaceCustom = false,
          } = body;
          addCube(sourceCube);
          addCube(targetCube);
          if (!['create', 'update', 'delete'].includes(operation)
            || (operation !== 'delete' && !validRelationships.has(relationship))) {
            throw new SchemaMutationError(400, 'Invalid relationship change');
          }
          if (sourceCube === targetCube) throw new SchemaMutationError(400, 'Self relationships are not supported');

          const existing = relationshipState.find(join => (
            join.sourceCube === sourceCube && join.targetCube === targetCube
          ));
          const reverseExisting = relationshipState.find(join => (
            join.sourceCube === targetCube && join.targetCube === sourceCube
          ));
          const existingRelationship = existing || reverseExisting;
          if (operation === 'create' && (existing || reverseExisting)) {
            throw new SchemaMutationError(409, 'This relationship already exists');
          }
          if (operation === 'update' && !existingRelationship) {
            throw new SchemaMutationError(404, 'This relationship does not exist');
          }

          if (operation !== 'delete') {
            if (typeof sourceColumn !== 'string' || typeof targetColumn !== 'string') {
              throw new SchemaMutationError(400, 'sourceColumn and targetColumn are required');
            }
            if (/\r|\n|`|\$\{|\{|\}/.test(sourceColumn) || /\r|\n|`|\$\{|\{|\}/.test(targetColumn)) {
              throw new SchemaMutationError(400, 'Unsupported column name');
            }
            const diagram = await getDiagram([sourceCube, targetCube]);
            const source = diagram.cubes.find(item => item.name === sourceCube);
            const target = diagram.cubes.find(item => item.name === targetCube);
            if (!source?.columns.some(column => column.name === sourceColumn)) {
              throw new SchemaMutationError(400, `Column '${sourceColumn}' was not found in '${sourceCube}'`);
            }
            if (!target?.columns.some(column => column.name === targetColumn)) {
              throw new SchemaMutationError(400, `Column '${targetColumn}' was not found in '${targetCube}'`);
            }
            if (operation === 'update' && existingRelationship && (!existingRelationship.sourceColumn || !existingRelationship.targetColumn) && !replaceCustom) {
              throw new SchemaMutationError(409, 'This relationship has a custom SQL condition and requires explicit replacement');
            }
          }

          const storedRelationship = relationship === 'one_to_many' ? 'many_to_one' : relationship;
          const storedSourceCube = relationship === 'one_to_many' ? targetCube : sourceCube;
          const storedTargetCube = relationship === 'one_to_many' ? sourceCube : targetCube;
          const storedSourceColumn = relationship === 'one_to_many' ? targetColumn : sourceColumn;
          const storedTargetColumn = relationship === 'one_to_many' ? sourceColumn : targetColumn;
          const storageMatchesExisting = Boolean(
            existingRelationship
            && existingRelationship.sourceCube === storedSourceCube
            && existingRelationship.targetCube === storedTargetCube
          );

          if (existingRelationship && !storageMatchesExisting) {
            converters.push(new CubeRelationshipConverter({
              sourceCube: existingRelationship.sourceCube,
              targetCube: existingRelationship.targetCube,
              operation: 'delete',
            }));
            cubeNames.add(existingRelationship.sourceCube);
          }
          if (operation === 'delete') {
            if (!existingRelationship) throw new SchemaMutationError(404, 'This relationship does not exist');
            converters.push(new CubeRelationshipConverter({
              sourceCube: existingRelationship.sourceCube,
              targetCube: existingRelationship.targetCube,
              operation: 'delete',
            }));
            relationshipState.splice(relationshipState.indexOf(existingRelationship), 1);
          } else {
            converters.push(new CubeRelationshipConverter({
              sourceCube: storedSourceCube,
              targetCube: storedTargetCube,
              sourceColumn: storedSourceColumn,
              targetColumn: storedTargetColumn,
              relationship: storedRelationship,
              operation: storageMatchesExisting ? 'update' : 'create',
            }));
            if (existingRelationship) relationshipState.splice(relationshipState.indexOf(existingRelationship), 1);
            relationshipState.push({
              sourceCube: storedSourceCube,
              targetCube: storedTargetCube,
              sourceColumn: storedSourceColumn,
              targetColumn: storedTargetColumn,
              relationship: storedRelationship,
              sql: '',
            } as any);
            cubeNames.add(storedSourceCube);
          }
          continue;
        }

        if (endpoint === 'playground/schema/normalize-diagram') {
          const relationshipsToMove = relationshipState.filter(join => (
            join.relationship === 'one_to_many' && join.sourceColumn && join.targetColumn
          ));
          relationshipsToMove.forEach(join => {
            cubeNames.add(join.sourceCube);
            cubeNames.add(join.targetCube);
            converters.push(new CubeRelationshipConverter({
              sourceCube: join.sourceCube,
              targetCube: join.targetCube,
              operation: 'delete',
            }));
            const canonicalAlreadyExists = relationshipState.some(existing => (
              existing.sourceCube === join.targetCube && existing.targetCube === join.sourceCube
            ));
            if (!canonicalAlreadyExists) {
              converters.push(new CubeRelationshipConverter({
                sourceCube: join.targetCube,
                targetCube: join.sourceCube,
                sourceColumn: join.targetColumn,
                targetColumn: join.sourceColumn,
                relationship: 'many_to_one',
                operation: 'create',
              }));
            }
          });
          definitions.models.forEach(model => {
            let sawNonPrimary = false;
            const outOfOrder = (model.dimensions || []).some(dimension => {
              if (dimension.primaryKey) return sawNonPrimary;
              sawNonPrimary = true;
              return false;
            });
            if (outOfOrder) {
              addCube(model.name);
              converters.push(new CubeDimensionOrderConverter());
            }
          });
          continue;
        }

        throw new SchemaMutationError(400, `Unsupported schema change endpoint: ${endpoint}`);
      }

      if (!converters.length) return res.json({ status: 'ok', changed: false });
      const files = await repository.dataSchemaFiles();
      const fileNames = new Set(Array.from(cubeNames).map(cubeName => (
        definitions.models.find(cube => cube.name === cubeName)?.fileName
      )).filter((fileName): fileName is string => Boolean(fileName)));
      const originalFiles = files.filter(file => fileNames.has(file.fileName));
      if (!originalFiles.length || originalFiles.length !== fileNames.size) {
        throw new SchemaMutationError(404, 'The schema change file was not found');
      }

      const converter = new CubeSchemaConverter(repository, converters);
      const updatedFiles = await saveValidatedSchemaChanges({
        definitions,
        cubeNames: Array.from(cubeNames),
        originalFiles,
        converter,
        rollbackRequestId: `${requestId}-schema-changes-rollback`,
        invalidMessage: error => {
          const reason = compilerValidationReason(error);
          return `As alterações não foram salvas porque o estado final do modelo é inválido${reason ? `: ${reason}` : ''}`;
        },
      });

      return res.json({ status: 'ok', changed: true, files: updatedFiles });
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
      const existingRelationship = existing || reverseExisting;
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
      if (operation === 'update' && !existingRelationship) {
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
        if (operation === 'update' && existingRelationship && (!existingRelationship.sourceColumn || !existingRelationship.targetColumn) && !replaceCustom) {
          return res.status(409).json({
            error: 'This relationship has a custom SQL condition and requires explicit replacement',
            customRelationship: true,
          });
        }
      }

      const { repository, requestId } = definitions;
      const storedRelationship = relationship === 'one_to_many'
        ? 'many_to_one'
        : relationship;
      const storedSourceCube = relationship === 'one_to_many' ? targetCube : sourceCube;
      const storedTargetCube = relationship === 'one_to_many' ? sourceCube : targetCube;
      const storedSourceColumn = relationship === 'one_to_many' ? targetColumn : sourceColumn;
      const storedTargetColumn = relationship === 'one_to_many' ? sourceColumn : targetColumn;
      const storageMatchesExisting = Boolean(
        existingRelationship
        && existingRelationship.sourceCube === storedSourceCube
        && existingRelationship.targetCube === storedTargetCube
      );
      const relationshipConverters: CubeRelationshipConverter[] = [];

      if (operation === 'delete') {
        if (!existingRelationship) {
          return res.status(404).json({ error: 'This relationship does not exist' });
        }
        relationshipConverters.push(new CubeRelationshipConverter({
          sourceCube: existingRelationship.sourceCube,
          targetCube: existingRelationship.targetCube,
          operation: 'delete',
        }));
      } else {
        if (!storageMatchesExisting && existingRelationship) {
          relationshipConverters.push(new CubeRelationshipConverter({
            sourceCube: existingRelationship.sourceCube,
            targetCube: existingRelationship.targetCube,
            operation: 'delete',
          }));
        }
        relationshipConverters.push(new CubeRelationshipConverter({
          sourceCube: storedSourceCube,
          targetCube: storedTargetCube,
          sourceColumn: storedSourceColumn,
          targetColumn: storedTargetColumn,
          relationship: storedRelationship,
          operation: storageMatchesExisting ? 'update' : 'create',
        }));
      }

      const files = await repository.dataSchemaFiles();
      const cubeNames = Array.from(new Set([
        ...(existingRelationship ? [existingRelationship.sourceCube] : []),
        ...(operation === 'delete' ? [] : [storedSourceCube]),
      ]));
      const originalFiles = Array.from(new Map(
        cubeNames
          .map(name => definitions.models.find(cube => cube.name === name)?.fileName)
          .filter((fileName): fileName is string => Boolean(fileName))
          .map(fileName => [fileName, files.find(file => file.fileName === fileName)])
          .filter((entry): entry is [string, any] => Boolean(entry[1]))
      ).values());
      if (!originalFiles.length || originalFiles.length !== new Set(cubeNames.map(name => (
        definitions.models.find(cube => cube.name === name)?.fileName
      ))).size) {
        return res.status(404).json({ error: 'The relationship file was not found' });
      }

      const converter = new CubeSchemaConverter(repository, relationshipConverters);
      let updatedFile;
      try {
        updatedFile = await saveValidatedSchemaChanges({
          definitions,
          cubeNames,
          originalFiles,
          converter,
          rollbackRequestId: `${requestId}-relationship-rollback`,
          changedDuringValidationMessage: 'The model file changed while the relationship was being validated. Reload the diagram before editing it again.',
          invalidMessage: error => {
            const reason = compilerValidationReason(error);
            return `The relationship was not saved because the model would be invalid${reason ? `: ${reason}` : ''}`;
          },
        });
      } catch (error: any) {
        if (error?.status) return res.status(error.status).json({ error: error.message });
        throw error;
      }

      return res.json({
        status: 'ok',
        fileName: updatedFile.fileName,
        content: updatedFile.source,
      });
    }));

    app.post('/playground/schema/normalize-diagram', catchErrors(async (req: Request, res: Response) => {
      this.cubejsServer.event('Dev Server Diagram Normalization');
      const definitions = await loadRelationshipDefinitions(req);
      const relationshipsToMove = definitions.relationships.filter(join => (
        join.relationship === 'one_to_many'
        && join.sourceColumn
        && join.targetColumn
      ));
      const cubesWithOutOfOrderKeys = definitions.models.filter(model => {
        let sawNonPrimary = false;
        return (model.dimensions || []).some(dimension => {
          if (dimension.primaryKey) return sawNonPrimary;
          sawNonPrimary = true;
          return false;
        });
      });
      const cubeNames = new Set<string>(cubesWithOutOfOrderKeys.map(cube => cube.name));
      relationshipsToMove.forEach(join => {
        cubeNames.add(join.sourceCube);
        cubeNames.add(join.targetCube);
      });

      if (!cubeNames.size) {
        return res.json({ status: 'ok', changed: false });
      }

      const relationshipConverters: CubeRelationshipConverter[] = [];
      relationshipsToMove.forEach(join => {
        relationshipConverters.push(new CubeRelationshipConverter({
          sourceCube: join.sourceCube,
          targetCube: join.targetCube,
          operation: 'delete',
        }));
        const canonicalAlreadyExists = definitions.relationships.some(existing => (
          existing.sourceCube === join.targetCube && existing.targetCube === join.sourceCube
        ));
        if (!canonicalAlreadyExists) {
          relationshipConverters.push(new CubeRelationshipConverter({
            sourceCube: join.targetCube,
            targetCube: join.sourceCube,
            sourceColumn: join.targetColumn,
            targetColumn: join.sourceColumn,
            relationship: 'many_to_one',
            operation: 'create',
          }));
        }
      });

      const { repository, requestId } = definitions;
      const files = await repository.dataSchemaFiles();
      const fileNames = new Set(Array.from(cubeNames).map(cubeName => (
        definitions.models.find(cube => cube.name === cubeName)?.fileName
      )).filter((fileName): fileName is string => Boolean(fileName)));
      const originalFiles = files.filter(file => fileNames.has(file.fileName));
      const converter = new CubeSchemaConverter(repository, [
        new CubeDimensionOrderConverter(),
        ...relationshipConverters,
      ]);

      let updatedFile;
      try {
        updatedFile = await saveValidatedSchemaChanges({
          definitions,
          cubeNames: Array.from(cubeNames),
          originalFiles,
          converter,
          rollbackRequestId: `${requestId}-diagram-normalization-rollback`,
          changedDuringValidationMessage: 'Os arquivos do diagrama mudaram enquanto a normalização era validada. Recarregue o diagrama e tente novamente.',
          invalidMessage: error => {
            const reason = compilerValidationReason(error);
            return `A normalização do diagrama não foi salva porque o modelo ficaria inválido${reason ? `: ${reason}` : ''}`;
          },
        });
      } catch (error: any) {
        if (error?.status) return res.status(error.status).json({ error: error.message });
        throw error;
      }

      return res.json({
        status: 'ok',
        changed: true,
        fileName: updatedFile.fileName,
        content: updatedFile.source,
      });
    }));

    app.get('/playground/schema/diagram-state', catchErrors(async (req, res) => {
      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
        : this.cubejsServer.repository;
      const statePath = diagramStatePath(repository);

      try {
        const state = await fs.readJson(statePath);
        return res.json(sanitizeDiagramState(state));
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        return res.json({ version: 1, cubes: {} });
      }
    }));

    app.put('/playground/schema/diagram-state', catchErrors(async (req, res) => {
      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
        : this.cubejsServer.repository;
      const statePath = diagramStatePath(repository);
      const state = sanitizeDiagramState(req.body || {});
      await fs.writeJson(statePath, state, { spaces: 2 });
      return res.json({ status: 'ok', fileName: DIAGRAM_STATE_FILE });
    }));

    app.get('/playground/files', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Files Load');
      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
        : this.cubejsServer.repository;
      const files = await repository.dataSchemaFiles();
      res.json({
        files: files.map(f => ({
          ...f,
          absPath: path.resolve(path.join(repository.localPath(), f.fileName))
        }))
      });
    }));

    app.get('/playground/schema/validation', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Schema Validation Load');
      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
        : this.cubejsServer.repository;
      const files = await repository.dataSchemaFiles();
      const requestId = getRequestIdFromRequest(req);
      const datamartContext = multiDatamart?.contextFromRequest(req);
      const context = {
        authInfo: null,
        securityContext: null,
        requestId,
        ...(datamartContext || {}),
      };

      const fileByCube = new Map<string, string>();
      files.forEach(file => {
        try {
          if (file.fileName.endsWith('.yml') || file.fileName.endsWith('.yaml')) {
            const document = YAML.load(file.content) as any;
            (Array.isArray(document?.cubes) ? document.cubes : [])
              .filter((cube: any) => typeof cube?.name === 'string')
              .forEach((cube: any) => fileByCube.set(cube.name, file.fileName));
          } else {
            const cubeNames = [...file.content.matchAll(/\bcube\s*\(\s*[`'\"]([^`'\"]+)[`'\"]/g)];
            cubeNames.forEach(match => fileByCube.set(match[1], file.fileName));
          }
        } catch (_error) {
          // The compiler response below contains the useful syntax error.
        }
      });

      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(context, { forceRefresh: true });
        await compilerApi.getCompilers({ requestId });
        return res.json({ valid: true, errors: {}, globalError: null });
      } catch (error: any) {
        const details = String(error?.plainMessage || error?.message || error || 'O schema é inválido');
        if (/Datamart session is missing or expired|Datamart credentials are required/i.test(details)) {
          throw error;
        }
        const errors: Record<string, string> = {};
        let matched = false;

        files.forEach(file => {
          if (details.includes(file.fileName)) {
            errors[file.fileName] = details.slice(0, 1200);
            matched = true;
          }
        });

        fileByCube.forEach((fileName, cubeName) => {
          if (details.includes(cubeName)) {
            errors[fileName] = details.slice(0, 1200);
            matched = true;
          }
        });

        return res.json({
          valid: false,
          errors,
          globalError: matched ? null : details.slice(0, 1200),
        });
      }
    }));

    app.post('/playground/files/copy', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server File Copy');

      const { sourceFileName, targetFileName } = req.body || {};
      if (!isSafeCubeFileName(sourceFileName) || !isSafeCubeFileBaseName(targetFileName)) {
        return res.status(400).json({ error: 'Invalid file name' });
      }
      const cubeTargetFileName = path.join('cubes', targetFileName);

      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
        : this.cubejsServer.repository;
      const files = await repository.dataSchemaFiles();
      const sourceFile = files.find(file => file.fileName === sourceFileName);
      if (!sourceFile) {
        return res.status(404).json({ error: `File '${sourceFileName}' was not found` });
      }
      if (files.some(file => file.fileName === cubeTargetFileName)) {
        return res.status(409).json({ error: `File '${cubeTargetFileName}' already exists` });
      }

      const repositoryPath = path.resolve(repository.localPath());
      const sourcePath = path.resolve(repositoryPath, sourceFileName);
      const targetPath = path.resolve(repositoryPath, cubeTargetFileName);
      if (![sourcePath, targetPath].every(filePath => filePath.startsWith(`${repositoryPath}${path.sep}`))) {
        return res.status(400).json({ error: 'Invalid file name' });
      }

      let copiedContent = sourceFile.content;
      if ((targetFileName.endsWith('.yml') || targetFileName.endsWith('.yaml'))
        && !JINJA_SYNTAX.test(sourceFile.content)) {
        try {
          const document = YAML.load(sourceFile.content) as any;
          if (document && Array.isArray(document.cubes) && document.cubes.length === 1) {
            const nextCubeName = copiedCubeName(targetFileName);
            copiedContent = renameYamlCubeInSource(
              sourceFile.content,
              document.cubes[0].name,
              nextCubeName,
            ) || YAML.dump({
              ...document,
              cubes: [{ ...document.cubes[0], name: nextCubeName }, ...document.cubes.slice(1)],
            }, { lineWidth: -1, noRefs: true, sortKeys: false });
          }
        } catch (_error) {
          // The compiler below will return the useful validation error.
        }
      }

      await fs.ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, copiedContent, 'utf-8');

      try {
        const requestId = getRequestIdFromRequest(req);
        const datamartContext = multiDatamart?.contextFromRequest(req);
        const compilerApi = await this.cubejsServer.getCompilerApi({
          authInfo: null,
          securityContext: null,
          requestId,
          ...(datamartContext || {}),
        });
        await compilerApi.getCompilers({ requestId });
      } catch (error: any) {
        await fs.remove(targetPath);
        return res.status(400).json({
          error: 'A cópia não foi criada porque o schema é inválido',
          details: compilerValidationReason(error),
        });
      }

      return res.json({ status: 'ok', sourceFileName, targetFileName: cubeTargetFileName });
    }));

    app.post('/playground/files/rename', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server File Rename');

      const { sourceFileName, targetFileName } = req.body || {};
      if (!isSafeCubeFileName(sourceFileName) || !isSafeCubeFileBaseName(targetFileName)) {
        return res.status(400).json({ error: 'Invalid file name' });
      }
      const cubeTargetFileName = path.join('cubes', targetFileName);
      if (sourceFileName === cubeTargetFileName) {
        return res.status(400).json({ error: 'The new file name must be different' });
      }

      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
        : this.cubejsServer.repository;
      const files = await repository.dataSchemaFiles();
      const sourceFile = files.find(file => file.fileName === sourceFileName);
      if (!sourceFile) {
        return res.status(404).json({ error: `File '${sourceFileName}' was not found` });
      }
      if (files.some(file => file.fileName === cubeTargetFileName)) {
        return res.status(409).json({ error: `File '${cubeTargetFileName}' already exists` });
      }

      const repositoryPath = path.resolve(repository.localPath());
      const sourcePath = path.resolve(repositoryPath, sourceFileName);
      const targetPath = path.resolve(repositoryPath, cubeTargetFileName);
      if (![sourcePath, targetPath].every(filePath => filePath.startsWith(`${repositoryPath}${path.sep}`))) {
        return res.status(400).json({ error: 'Invalid file name' });
      }

      const originalContents = new Map<string, string>();
      let renamedSourceContent = sourceFile.content;
      let currentCubeName: string | null = null;
      let nextCubeName: string | null = null;

      if ((sourceFileName.endsWith('.yml') || sourceFileName.endsWith('.yaml'))
        && !JINJA_SYNTAX.test(sourceFile.content)) {
        try {
          const document = YAML.load(sourceFile.content) as any;
          if (document && Array.isArray(document.cubes) && document.cubes.length === 1
            && typeof document.cubes[0].name === 'string') {
            currentCubeName = document.cubes[0].name;
            nextCubeName = copiedCubeName(cubeTargetFileName);
            renamedSourceContent = renameYamlCubeInSource(
              sourceFile.content,
              currentCubeName,
              nextCubeName,
            ) || sourceFile.content;
          }
        } catch (_error) {
          // The compiler below will return the useful validation error.
        }
      }

      const allFiles = await repository.dataSchemaFiles();
      if (currentCubeName && nextCubeName) {
        for (const file of allFiles) {
          if (file.fileName === sourceFileName
            || (!file.fileName.endsWith('.yml') && !file.fileName.endsWith('.yaml'))
            || JINJA_SYNTAX.test(file.content)) {
            continue;
          }
          const updatedContent = renameYamlCubeReferences(file.content, currentCubeName, nextCubeName);
          if (updatedContent !== file.content) {
            originalContents.set(file.fileName, file.content);
            repository.writeDataSchemaFile(file.fileName, updatedContent);
          }
        }
      }

      await fs.ensureDir(path.dirname(targetPath));
      await fs.move(sourcePath, targetPath);
      if (renamedSourceContent !== sourceFile.content) {
        originalContents.set(sourceFileName, sourceFile.content);
        await fs.writeFile(targetPath, renamedSourceContent, 'utf-8');
      }

      try {
        const requestId = getRequestIdFromRequest(req);
        const datamartContext = multiDatamart?.contextFromRequest(req);
        const compilerApi = await this.cubejsServer.getCompilerApi({
          authInfo: null,
          securityContext: null,
          requestId,
          ...(datamartContext || {}),
        });
        await compilerApi.getCompilers({ requestId });
      } catch (error: any) {
        await fs.move(targetPath, sourcePath);
        for (const [fileName, content] of originalContents) {
          repository.writeDataSchemaFile(fileName, content);
        }
        return res.status(400).json({
          error: 'O arquivo não foi renomeado porque o schema é inválido',
          details: compilerValidationReason(error),
        });
      }

      return res.json({ status: 'ok', sourceFileName, targetFileName: cubeTargetFileName });
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

      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
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
      const datamartContext = multiDatamart?.contextFromRequest(req);
      const compilerContext = {
        authInfo: null,
        securityContext: null,
        requestId,
        ...(datamartContext || {}),
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

      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
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
      const datamartContext = multiDatamart?.contextFromRequest(req);

      const driver = await this.cubejsServer.getDriver({
        dataSource,
        authInfo: null,
        securityContext: null,
        requestId: getRequestIdFromRequest(req),
        ...(datamartContext || {}),
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

      const schemaPath = multiDatamart
        ? multiDatamart.registry.modelPath(datamartContext!.datamartId)
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

      if (multiDatamart) await driver.release?.();

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
        if (multiDatamart) {
          return res.status(409).json({
            error: 'Use the datamart session endpoint to test connections in multi-datamart mode',
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
      if (multiDatamart) {
        return res.status(409).json({
          error: 'The /playground/env endpoint is disabled in multi-datamart mode because it writes credentials to disk',
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
      const repository = multiDatamart
        ? multiDatamart.repository(multiDatamart.contextFromRequest(req))
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
