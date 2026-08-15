import { ParamAllocator, PostgresQuery } from '@cubejs-backend/schema-compiler';

class NetezzaParamAllocator extends ParamAllocator {
  public override paramPlaceHolder(_paramIndex: number): string {
    return '?';
  }
}

/**
 * Netezza shares much of PostgreSQL's SQL syntax, but its ODBC driver uses
 * positional question-mark parameters instead of PostgreSQL protocol binds.
 */
export class NetezzaQuery extends PostgresQuery {
  public override newParamAllocator(expressionParams: unknown[]) {
    return new NetezzaParamAllocator(expressionParams);
  }

  /**
   * Netezza TIMESTAMP has no time-zone component. Cube therefore treats source
   * timestamps as already normalized (normally UTC) instead of adding a
   * PostgreSQL-specific AT TIME ZONE expression.
   */
  public override convertTz(field: string): string {
    return field;
  }

  public override timeStampCast(value: string): string {
    return `CAST(${value} AS TIMESTAMP)`;
  }

  public override dateTimeCast(value: string): string {
    return `CAST(${value} AS TIMESTAMP)`;
  }

  public override castToString(sql: string): string {
    return `CAST(${sql} AS VARCHAR(64000))`;
  }

  public override sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.params.param = '?';
    templates.types.string = 'VARCHAR(64000)';
    templates.types.binary = 'VARBINARY(64000)';
    templates.types.timestamp = 'TIMESTAMP';
    templates.expressions.timestamp_literal = 'CAST(\'{{ value | replace("T", " ") | replace("Z", "") }}\' AS TIMESTAMP)';
    return templates;
  }

  public override get shouldReuseParams() {
    // An ODBC placeholder represents one value occurrence; it cannot reuse a
    // prior bind position in the way $1 can with the PostgreSQL protocol.
    return false;
  }
}
