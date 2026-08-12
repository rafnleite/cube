import fs from 'fs-extra';
import path from 'path';

import type { ConnectionPreset, DatamartProject } from './types';

const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class ProjectRegistry {
  public constructor(
    protected readonly projectsRoot: string,
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

  public async list(): Promise<DatamartProject[]> {
    await fs.ensureDir(this.projectsRoot);
    const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true });
    const projects = await Promise.all(entries
      .filter(entry => entry.isDirectory() && PROJECT_ID.test(entry.name))
      .map(async entry => this.get(entry.name).catch(() => null)));
    return projects.filter((project): project is DatamartProject => project !== null);
  }

  public async get(id: string): Promise<DatamartProject> {
    this.assertId(id);
    return fs.readJson(path.join(this.projectsRoot, id, 'project.json'));
  }

  public async create(input: Pick<DatamartProject, 'id' | 'name' | 'connectionId'>): Promise<DatamartProject> {
    this.assertId(input.id);
    const connection = (await this.connections()).find(item => item.id === input.connectionId);
    if (!connection) throw new Error(`Unknown connection preset: ${input.connectionId}`);

    const projectPath = path.join(this.projectsRoot, input.id);
    if (await fs.pathExists(projectPath)) throw new Error(`Project already exists: ${input.id}`);

    const now = new Date().toISOString();
    const project: DatamartProject = { ...input, createdAt: now, updatedAt: now };
    await fs.ensureDir(path.join(projectPath, 'model', 'cubes'));
    await fs.ensureDir(path.join(projectPath, 'model', 'views'));
    await fs.writeJson(path.join(projectPath, 'project.json'), project, { spaces: 2 });
    return project;
  }

  public modelPath(id: string): string {
    this.assertId(id);
    return path.join(this.projectsRoot, id, 'model');
  }

  protected assertId(id: string): void {
    if (!PROJECT_ID.test(id)) throw new Error('Project id must be a lowercase URL-safe slug');
  }
}
