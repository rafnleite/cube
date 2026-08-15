export declare class NetezzaError extends Error {
    constructor(message: string, cause?: Error);
}
export declare class NetezzaConnectionError extends NetezzaError {
    constructor(cause: Error, poolName: string);
}
//# sourceMappingURL=errors.d.ts.map