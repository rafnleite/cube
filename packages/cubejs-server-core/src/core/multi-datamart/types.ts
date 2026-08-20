export type ConnectionField = {
  name: string;
  label: string;
  driverOption?: string;
  secret?: boolean;
  required?: boolean;
};

export type MultiDatamartContext = {
  datamartId: string;
  datamartSessionId: string;
};

export type ConnectionPreset = {
  id: string;
  label: string;
  dbType: string;
  fields: ConnectionField[];
  defaults?: Record<string, string>;
};

export type Datamart = {
  id: string;
  name: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
};

export type DatamartCredentials = Record<string, string>;
