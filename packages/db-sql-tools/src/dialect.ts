export interface TSqlFragment {
  sql: string;
  params: unknown[];
}

export interface SqlDialect {
  /** Quotes a column/table name */
  quoteIdentifier(name: string): string;
  /** Quotes a possibly schema-qualified table name */
  quoteTable(name: string): string;
  /** SQL literal for unlimited LIMIT (SQLite: '-1', MySQL: '18446744073709551615') */
  unlimitedLimit: string;
  /** Convert JS value to SQL-bindable param for DML */
  toValue(value: unknown): unknown;
  /** Convert JS value to SQL-bindable param for filters (lighter) */
  toParam(value: unknown): unknown;
  /** Handle $regex filter */
  regex(quotedCol: string, value: unknown): TSqlFragment;
  /** e.g. 'CREATE VIEW IF NOT EXISTS' or 'CREATE OR REPLACE VIEW' */
  createViewPrefix: string;
  /** Returns a parameter placeholder for the given 1-based index. When absent, '?' is used. */
  paramPlaceholder?: (index: number) => string;
}

/**
 * Replaces positional `?` placeholders with dialect-specific numbered placeholders
 * (e.g. `$1, $2, ...` for PostgreSQL). No-op when `dialect.paramPlaceholder` is not set.
 */
export function finalizeParams(dialect: SqlDialect, fragment: TSqlFragment): TSqlFragment {
  if (!dialect.paramPlaceholder) {
    return fragment;
  }
  let idx = 0;
  const sql = fragment.sql.replace(/\?/g, () => dialect.paramPlaceholder!(++idx));
  return { sql, params: fragment.params };
}

export const EMPTY_AND: TSqlFragment = { sql: "1=1", params: [] };
export const EMPTY_OR: TSqlFragment = { sql: "0=1", params: [] };
