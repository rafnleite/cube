export declare function odbcDiagnostics(cause: unknown): string;
export declare class NetezzaError extends Error {
    constructor(message: string, cause?: Error);
}
export declare class NetezzaConnectionError extends NetezzaError {
    constructor(cause: Error, poolName: string);
}
export declare class NetezzaQueryError extends NetezzaError {
    constructor(cause: Error);
}
//# sourceMappingURL=errors.d.ts.map