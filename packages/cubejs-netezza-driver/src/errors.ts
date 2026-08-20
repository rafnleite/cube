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
    const diagnostics = (cause as Error & {
      odbcErrors?: Array<{ state?: string; code?: number | string; message?: string }>;
    }).odbcErrors;
    const detail = Array.isArray(diagnostics) && diagnostics.length
      ? ` (${diagnostics.map((item) => [item.state, item.code, item.message].filter(Boolean).join(': ')).join('; ')})`
      : '';
    super(`Unable to connect to Netezza using pool ${poolName}: ${cause.message}${detail}`, cause);
    this.name = 'NetezzaConnectionError';
  }
}
