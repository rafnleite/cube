export type ConnectionField = {
  name: string;
  label: string;
  driverOption?: string;
  secret?: boolean;
  required?: boolean;
};

export type MultiProjectContext = {
  projectId: string;
  projectSessionId: string;
};

export type ConnectionPreset = {
  id: string;
  label: string;
  dbType: string;
  fields: ConnectionField[];
  defaults?: Record<string, string>;
};

export type DatamartProject = {
  id: string;
  name: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectCredentials = Record<string, string>;
