"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetezzaQuery = void 0;
const schema_compiler_1 = require("@cubejs-backend/schema-compiler");
class NetezzaParamAllocator extends schema_compiler_1.ParamAllocator {
    paramPlaceHolder(_paramIndex) {
        return '?';
    }
}
/**
 * Netezza shares much of PostgreSQL's SQL syntax, but its ODBC driver uses
 * positional question-mark parameters instead of PostgreSQL protocol binds.
 */
class NetezzaQuery extends schema_compiler_1.PostgresQuery {
    newParamAllocator(expressionParams) {
        return new NetezzaParamAllocator(expressionParams);
    }
    /**
     * Netezza TIMESTAMP has no time-zone component. Cube therefore treats source
     * timestamps as already normalized (normally UTC) instead of adding a
     * PostgreSQL-specific AT TIME ZONE expression.
     */
    convertTz(field) {
        return field;
    }
    timeStampCast(value) {
        return `CAST(${value} AS TIMESTAMP)`;
    }
    dateTimeCast(value) {
        return `CAST(${value} AS TIMESTAMP)`;
    }
    castToString(sql) {
        return `CAST(${sql} AS VARCHAR(64000))`;
    }
    sqlTemplates() {
        const templates = super.sqlTemplates();
        templates.params.param = '?';
        templates.types.string = 'VARCHAR(64000)';
        templates.types.binary = 'VARBINARY(64000)';
        templates.types.timestamp = 'TIMESTAMP';
        templates.expressions.timestamp_literal = 'CAST(\'{{ value | replace("T", " ") | replace("Z", "") }}\' AS TIMESTAMP)';
        return templates;
    }
    get shouldReuseParams() {
        // An ODBC placeholder represents one value occurrence; it cannot reuse a
        // prior bind position in the way $1 can with the PostgreSQL protocol.
        return false;
    }
}
exports.NetezzaQuery = NetezzaQuery;
//# sourceMappingURL=NetezzaQuery.js.map