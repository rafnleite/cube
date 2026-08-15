"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetezzaConnectionError = exports.NetezzaError = void 0;
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
        super(`Unable to connect to Netezza using pool ${poolName}: ${cause.message}`, cause);
        this.name = 'NetezzaConnectionError';
    }
}
exports.NetezzaConnectionError = NetezzaConnectionError;
//# sourceMappingURL=errors.js.map