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
    super(`Unable to connect to Netezza using pool ${poolName}: ${cause.message}`, cause);
    this.name = 'NetezzaConnectionError';
  }
}
