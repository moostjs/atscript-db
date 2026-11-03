import type { SqlDialect } from "./dialect";

/**
 * A pre-rendered derived table — `(<select>) AS "alias"` — read in place of
 * a table name, plus the optimizer hint the SELECT that reads it carries
 * (`/*+ MERGE(…) *\/ `, or `""`).
 * @since 0.1.153
 */
export interface TSqlDerivedSource {
  readonly sql: string;
  readonly hint: string;
  /**
   * Bind parameters of `sql` (`?` placeholders, in text order) — set only by
   * the aggregate builders for the inner level of a two-level aggregate, which
   * place them where the source renders. Other builders take parameter-free
   * sources. @since 0.1.168
   */
  readonly params?: readonly unknown[];
}

/** The bind parameters of `source` (a table name has none). */
export function fromSourceParams(source: TSqlFromSource): readonly unknown[] {
  return typeof source === "string" ? [] : (source.params ?? []);
}

/**
 * The FROM source of a read builder: a table / view name (quoted by the
 * dialect) or a {@link TSqlDerivedSource}.
 * @since 0.1.153
 */
export type TSqlFromSource = string | TSqlDerivedSource;

/** The FROM text of `source`: the quoted table name, or the derived table. */
export function fromSourceSql(dialect: SqlDialect, source: TSqlFromSource): string {
  return typeof source === "string" ? dialect.quoteTable(source) : source.sql;
}

/** The hint the SELECT directly reading `source` carries (`""` for a table). */
export function fromSourceHint(source: TSqlFromSource): string {
  return typeof source === "string" ? "" : source.hint;
}
