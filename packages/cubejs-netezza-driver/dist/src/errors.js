"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetezzaQueryError = exports.NetezzaConnectionError = exports.NetezzaError = exports.odbcDiagnostics = void 0;
function odbcDiagnostics(cause) {
    const diagnostics = cause?.odbcErrors;
    return Array.isArray(diagnostics) && diagnostics.length
        ? ` (${diagnostics.map((item) => [item.state, item.code, item.message].filter(Boolean).join(': ')).join('; ')})`
        : '';
}
exports.odbcDiagnostics = odbcDiagnostics;
class NetezzaError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'NetezzaError';
        if (cause) {
            this.cause = cause;
        }
    }
}
exports.NetezzaError = NetezzaError;
class NetezzaConnectionError extends NetezzaError {
    constructor(cause, poolName) {
        super(`Unable to connect to Netezza using pool ${poolName}: ${cause.message}${odbcDiagnostics(cause)}`, cause);
        this.name = 'NetezzaConnectionError';
    }
}
exports.NetezzaConnectionError = NetezzaConnectionError;
class NetezzaQueryError extends NetezzaError {
    constructor(cause) {
        super(`Unable to execute Netezza query: ${cause.message}${odbcDiagnostics(cause)}`, cause);
        this.name = 'NetezzaQueryError';
    }
}
exports.NetezzaQueryError = NetezzaQueryError;
//# sourceMappingURL=errors.js.map