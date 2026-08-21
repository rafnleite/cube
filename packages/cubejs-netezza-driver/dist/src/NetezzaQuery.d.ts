import { BaseFilter, ParamAllocator, PostgresQuery } from '@cubejs-backend/schema-compiler';
declare class NetezzaFilter extends BaseFilter {
    likeIgnoreCase(column: string, not: boolean, param: unknown, type: string): string;
}
declare class NetezzaParamAllocator extends ParamAllocator {
    paramPlaceHolder(_paramIndex: number): string;
}
/**
 * Netezza shares much of PostgreSQL's SQL syntax, but its ODBC driver uses
 * positional question-mark parameters instead of PostgreSQL protocol binds.
 */
export declare class NetezzaQuery extends PostgresQuery {
    newFilter(filter: any): NetezzaFilter;
    newParamAllocator(expressionParams: unknown[]): NetezzaParamAllocator;
    /**
     * Netezza TIMESTAMP has no time-zone component. Cube therefore treats source
     * timestamps as already normalized (normally UTC) instead of adding a
     * PostgreSQL-specific AT TIME ZONE expression.
     */
    convertTz(field: string): string;
    timeStampCast(value: string): string;
    dateTimeCast(value: string): string;
    castToString(sql: string): string;
    sqlTemplates(): any;
    get shouldReuseParams(): boolean;
}
export {};
//# sourceMappingURL=NetezzaQuery.d.ts.map