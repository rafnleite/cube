type OdbcDiagnostic = {
  state?: string;
  code?: number | string;
  message?: string;
};

export function odbcDiagnostics(cause: unknown): string {
  const diagnostics = (cause as { odbcErrors?: OdbcDiagnostic[] } | undefined)?.odbcErrors;
  return Array.isArray(diagnostics) && diagnostics.length
    ? ` (${diagnostics.map((item) => [item.state, item.code, item.message].filter(Boolean).join(': ')).join('; ')})`
    : '';
}

export class NetezzaError extends Error {
  public constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'NetezzaError';
    if (cause) {
      (this as Error & { cause?: Error }).cause = cause;
    }
  }
}

export class NetezzaConnectionError extends NetezzaError {
  public constructor(cause: Error, poolName: string) {
    super(`Unable to connect to Netezza using pool ${poolName}: ${cause.message}${odbcDiagnostics(cause)}`, cause);
    this.name = 'NetezzaConnectionError';
  }
}

export class NetezzaQueryError extends NetezzaError {
  public constructor(cause: Error) {
    super(`Unable to execute Netezza query: ${cause.message}${odbcDiagnostics(cause)}`, cause);
    this.name = 'NetezzaQueryError';
  }
}
