import fs from 'fs-extra';
import path from 'path';

import type { ConnectionPreset, Datamart } from './types';

const DATAMART_ID = /^[a-z0-9_-]{1,63}$/;

export class DatamartRegistry {
  public constructor(
    protected readonly datamartsRoot: string,
    protected readonly connectionsFile: string,
  ) {}

  public async connections(): Promise<ConnectionPreset[]> {
    const value = await fs.readJson(this.connectionsFile);
    if (!Array.isArray(value)) throw new Error('Connections configuration must be an array');
    for (const connection of value as ConnectionPreset[]) {
      for (const field of connection.fields || []) {
        if (field.secret && connection.defaults?.[field.name]) {
          throw new Error(`Secret field ${field.name} cannot have a default value in connections configuration`);
        }
      }
    }
    return value;
  }

  public async list(): Promise<Datamart[]> {
    await fs.ensureDir(this.datamartsRoot);
    const entries = await fs.readdir(this.datamartsRoot, { withFileTypes: true });
    const datamarts = await Promise.all(entries
      .filter(entry => entry.isDirectory() && DATAMART_ID.test(entry.name))
      .map(async entry => this.get(entry.name).catch(() => null)));
    return datamarts.filter((datamart): datamart is Datamart => datamart !== null);
  }

  public async get(id: string): Promise<Datamart> {
    this.assertId(id);
    return fs.readJson(path.join(this.datamartsRoot, id, 'datamart.json'));
  }

  public async create(input: Pick<Datamart, 'id' | 'name' | 'connectionId'>): Promise<Datamart> {
    this.assertId(input.id);
    const connection = (await this.connections()).find(item => item.id === input.connectionId);
    if (!connection) throw new Error(`Unknown connection preset: ${input.connectionId}`);

    const datamartPath = path.join(this.datamartsRoot, input.id);
    if (await fs.pathExists(datamartPath)) throw new Error(`Datamart already exists: ${input.id}`);

    const now = new Date().toISOString();
    const datamart: Datamart = { ...input, createdAt: now, updatedAt: now };
    await fs.ensureDir(path.join(datamartPath, 'model', 'cubes'));
    await fs.ensureDir(path.join(datamartPath, 'model', 'views'));
    await fs.writeJson(path.join(datamartPath, 'datamart.json'), datamart, { spaces: 2 });
    return datamart;
  }

  public modelPath(id: string): string {
    this.assertId(id);
    return path.join(this.datamartsRoot, id, 'model');
  }

  protected assertId(id: string): void {
    if (!DATAMART_ID.test(id)) throw new Error('Datamart id must use lowercase letters, numbers, hyphens, or underscores');
  }
}
