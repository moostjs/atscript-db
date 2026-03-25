import type { TDbCollation, TDbFieldMeta, TDbForeignKey, TFieldOps } from "@atscript/db";
import type { DbControls } from "@atscript/db";
import type { AtscriptQueryFieldRef, TViewColumnMapping, TViewPlan } from "@atscript/db";
import type { SqlDialect, TSqlFragment } from "@atscript/db-sql-tools";
import {
  buildInsert as _buildInsert,
  buildSelect as _buildSelect,
  buildUpdate as _buildUpdate,
  buildDelete as _buildDelete,
  buildCreateView as _buildCreateView,
  buildAggregateSelect as _buildAggregateSelect,
  buildAggregateCount as _buildAggregateCount,
  sqlStringLiteral,
  refActionToSql,
  defaultValueForType as _defaultValueForType,
  defaultValueToSqlLiteral as _defaultValueToSqlLiteral,
  finalizeParams,
  parseRegexString,
} from "@atscript/db-sql-tools";

// Re-export shared utilities for consumers that import from this package
export { sqlStringLiteral, refActionToSql, finalizeParams };

/**
 * PostgreSQL-aware default value for a given design type.
 * PG uses native BOOLEAN (not TINYINT), so defaults must be `false`/`true` not `0`/`1`.
 */
export function defaultValueForType(designType: string): string {
  if (designType === "boolean") {
    return "false";
  }
  // PG uses JSONB — empty string is not valid JSON
  if (designType === "json" || designType === "object") {
    return "'{}'";
  }
  if (designType === "array") {
    return "'[]'";
  }
  return _defaultValueForType(designType);
}

/**
 * PostgreSQL-aware default value literal.
 * Converts boolean defaults to `true`/`false` instead of `1`/`0`.
 */
export function defaultValueToSqlLiteral(designType: string, value: string): string {
  if (designType === "boolean") {
    return value === "true" || value === "1" ? "true" : "false";
  }
  return _defaultValueToSqlLiteral(designType, value);
}

// ── PostgreSQL table options (passed to buildCreateTable) ─────────────────────

export interface TPgTableOptions {
  incrementFields?: ReadonlySet<string>;
  autoIncrementStart?: number;
  /** Optional type mapper override (e.g., for vector field support). Falls back to `pgTypeFromField`. */
  typeMapper?: (field: TDbFieldMeta) => string;
}

// ── Identifier quoting ──────────────────────────────────────────────────────

/** Escapes a PostgreSQL identifier by doubling double-quotes. */
export function esc(name: string): string {
  return name.replace(/"/g, '""');
}

/** Double-quote-quotes a single identifier. */
export function qi(name: string): string {
  return `"${esc(name)}"`;
}

/**
 * Double-quote-quotes a table name, handling `schema.table` format.
 * Input is a raw name like `public.users` or just `users`.
 */
export function quoteTableName(name: string): string {
  const dot = name.indexOf(".");
  if (dot >= 0) {
    return `${qi(name.slice(0, dot))}.${qi(name.slice(dot + 1))}`;
  }
  return qi(name);
}

// ── PostgreSQL dialect ───────────────────────────────────────────────────────

/** Converts JS values to SQL-bindable params, keeping booleans native. */
function toPgValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

export const pgDialect: SqlDialect = {
  quoteIdentifier(name: string) {
    return qi(name);
  },
  quoteTable(name: string) {
    return quoteTableName(name);
  },
  unlimitedLimit: "ALL",
  toValue: toPgValue,
  toParam(value: unknown) {
    if (value === undefined) {
      return null;
    }
    return value;
  },
  regex(quotedCol: string, value: unknown): TSqlFragment {
    const { pattern, flags } = parseRegexString(value);
    const op = flags.includes("i") ? "~*" : "~";
    return { sql: `${quotedCol} ${op} ?`, params: [pattern] };
  },
  createViewPrefix: "CREATE OR REPLACE VIEW",
  paramPlaceholder(index: number) {
    return `$${index}`;
  },
};

// ── Pre-bound DML builders ──────────────────────────────────────────────────

export function buildInsert(table: string, data: Record<string, unknown>): TSqlFragment {
  return _buildInsert(pgDialect, table, data);
}

export function buildSelect(
  table: string,
  where: TSqlFragment,
  controls?: DbControls,
): TSqlFragment {
  return _buildSelect(pgDialect, table, where, controls);
}

export function buildUpdate(
  table: string,
  data: Record<string, unknown>,
  where: TSqlFragment,
  limit?: number,
  ops?: TFieldOps,
): TSqlFragment {
  return _buildUpdate(pgDialect, table, data, where, limit, ops);
}

export function buildDelete(table: string, where: TSqlFragment, limit?: number): TSqlFragment {
  return _buildDelete(pgDialect, table, where, limit);
}

export function buildCreateView(
  viewName: string,
  plan: TViewPlan,
  columns: TViewColumnMapping[],
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  return _buildCreateView(pgDialect, viewName, plan, columns, resolveFieldRef);
}

export function buildAggregateSelect(
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return _buildAggregateSelect(pgDialect, table, where, controls);
}

export function buildAggregateCount(
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return _buildAggregateCount(pgDialect, table, where, controls);
}

// ── PostgreSQL-specific ──────────────────────────────────────────────────────

/**
 * Maps portable collation values to PostgreSQL collation names.
 *
 * Returns `null` for `'nocase'` — case-insensitive columns use CITEXT type instead
 * (provisioned via `CREATE EXTENSION IF NOT EXISTS citext` in `ensureTable`).
 * Users can also opt into ICU collation explicitly via `@db.pg.collate "und-u-ks-level2"`.
 */
export function collationToPg(collation: TDbCollation): string | null {
  switch (collation) {
    case "binary": {
      return '"C"';
    }
    case "nocase": {
      return null;
    }
    case "unicode": {
      return '"und-x-icu"';
    }
    default: {
      return '"und-x-icu"';
    }
  }
}

/** Maps integer primitive tags to PostgreSQL integer types.
 * Unsigned types are promoted to the next-larger PG type because
 * PostgreSQL only has signed integer types:
 *   uint16 (0-65535) → INTEGER (not SMALLINT which caps at 32767)
 *   uint32 (0-4.3B)  → BIGINT  (not INTEGER which caps at ~2.1B)
 */
function intTypeFromTags(tags: Set<string> | undefined): string {
  if (tags?.has("int8") || tags?.has("byte")) {
    return "SMALLINT";
  }
  if (tags?.has("uint8")) {
    return "SMALLINT";
  }
  if (tags?.has("int16") || tags?.has("port")) {
    return "SMALLINT";
  }
  if (tags?.has("uint16")) {
    return "INTEGER";
  }
  if (tags?.has("int32")) {
    return "INTEGER";
  }
  if (tags?.has("uint32")) {
    return "BIGINT";
  }
  if (tags?.has("int64") || tags?.has("uint64")) {
    return "BIGINT";
  }
  return "INTEGER";
}

/**
 * Maps an Atscript field descriptor to a PostgreSQL column type.
 *
 * For FK fields, delegates to the target PK's type via `field.fkTargetField`
 * so the FK column type always matches the referenced column.
 */
export function pgTypeFromField(field: TDbFieldMeta): string {
  if (field.fkTargetField) {
    return pgTypeFromField(field.fkTargetField);
  }

  const tags = field.type?.type?.tags as Set<string> | undefined;
  const metadata = field.type?.metadata;

  // PostgreSQL-specific type override: @db.pg.type "CITEXT"
  const pgTypeOverride = metadata?.get("db.pg.type") as string | undefined;
  if (pgTypeOverride) {
    return pgTypeOverride;
  }

  const precision = metadata?.get("db.column.precision") as
    | { precision: number; scale: number }
    | undefined;

  switch (field.designType) {
    case "number": {
      if (precision) {
        return `NUMERIC(${precision.precision},${precision.scale})`;
      }
      if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "increment") {
        return "BIGINT";
      }
      // @db.default.now → BIGINT (store raw epoch ms, consistent with SQLite/MongoDB)
      // TIMESTAMPTZ would require type conversion at every driver.run() call site,
      // but SchemaSync and test factories bypass adapter-level formatters.
      if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "now") {
        return "BIGINT";
      }
      if (tags?.has("int")) {
        return intTypeFromTags(tags);
      }
      return "DOUBLE PRECISION";
    }
    case "integer": {
      return intTypeFromTags(tags);
    }
    case "decimal": {
      if (precision) {
        return `NUMERIC(${precision.precision},${precision.scale})`;
      }
      return "NUMERIC(10,2)";
    }
    case "boolean": {
      return "BOOLEAN";
    }
    case "string": {
      // @db.column.collate 'nocase' → CITEXT (case-insensitive text type)
      // Handles equality, sorting, UNIQUE, LIKE, range, and aggregation correctly.
      // Only when no native @db.pg.collate override is set.
      if (field.collate === "nocase" && !metadata?.get("db.pg.collate")) {
        return "CITEXT";
      }
      if (tags?.has("char")) {
        return "CHAR(1)";
      }
      const maxLen = (metadata?.get("expect.maxLength") as { length: number } | undefined)?.length;
      if (maxLen !== undefined) {
        return `VARCHAR(${maxLen})`;
      }
      if (field.isPrimaryKey || field.defaultValue) {
        return "VARCHAR(255)";
      }
      return "TEXT";
    }
    case "json":
    case "object":
    case "array": {
      return "JSONB";
    }
    default: {
      if (field.isPrimaryKey || field.defaultValue) {
        return "VARCHAR(255)";
      }
      return "TEXT";
    }
  }
}

/**
 * Builds a CREATE TABLE IF NOT EXISTS statement with PostgreSQL syntax.
 */
export function buildCreateTable(
  table: string,
  fields: readonly TDbFieldMeta[],
  foreignKeys?: ReadonlyMap<string, TDbForeignKey>,
  options?: TPgTableOptions,
): string {
  const colDefs: string[] = [];
  const primaryKeys = fields.filter((f) => f.isPrimaryKey);

  for (const field of fields) {
    if (field.ignored) {
      continue;
    }

    const sqlType = options?.typeMapper?.(field) ?? pgTypeFromField(field);
    let def = `${qi(field.physicalName)} ${sqlType}`;

    // GENERATED BY DEFAULT AS IDENTITY for @db.default.increment
    if (options?.incrementFields?.has(field.physicalName)) {
      const start = options.autoIncrementStart;
      def +=
        start !== undefined
          ? ` GENERATED BY DEFAULT AS IDENTITY (START WITH ${start})`
          : " GENERATED BY DEFAULT AS IDENTITY";
    }

    if (
      !field.optional &&
      !field.isPrimaryKey &&
      !options?.incrementFields?.has(field.physicalName)
    ) {
      def += " NOT NULL";
    }
    if (field.defaultValue?.kind === "value") {
      def += ` DEFAULT ${defaultValueToSqlLiteral(field.designType, field.defaultValue.value)}`;
    } else if (field.defaultValue?.kind === "fn") {
      if (field.defaultValue.fn === "uuid") {
        def += " DEFAULT gen_random_uuid()";
      } else if (field.defaultValue.fn === "now") {
        // Epoch ms as BIGINT — matches the BIGINT column type for @db.default.now
        def += " DEFAULT (extract(epoch from now()) * 1000)::bigint";
      }
      // increment is handled via GENERATED AS IDENTITY above
    }

    // Collation (portable or native override)
    const nativeCollate = field.type?.metadata?.get("db.pg.collate") as string | undefined;
    if (nativeCollate) {
      def += ` COLLATE "${nativeCollate}"`;
    } else if (field.collate) {
      const pgCollate = collationToPg(field.collate);
      if (pgCollate) {
        def += ` COLLATE ${pgCollate}`;
      }
    }

    colDefs.push(def);
  }

  // Primary key constraint
  if (primaryKeys.length === 1) {
    const pkCol = qi(primaryKeys[0].physicalName);
    for (let i = 0; i < colDefs.length; i++) {
      if (colDefs[i].startsWith(`${pkCol} `)) {
        colDefs[i] += " PRIMARY KEY";
        break;
      }
    }
  } else if (primaryKeys.length > 1) {
    const pkCols = primaryKeys.map((pk) => qi(pk.physicalName)).join(", ");
    colDefs.push(`PRIMARY KEY (${pkCols})`);
  }

  // Foreign key constraints
  if (foreignKeys) {
    for (const fk of foreignKeys.values()) {
      const localCols = fk.fields.map((f) => qi(f)).join(", ");
      const targetCols = fk.targetFields.map((f) => qi(f)).join(", ");
      let constraint = `FOREIGN KEY (${localCols}) REFERENCES ${qi(fk.targetTable)} (${targetCols})`;
      if (fk.onDelete) {
        constraint += ` ON DELETE ${refActionToSql(fk.onDelete)}`;
      }
      if (fk.onUpdate) {
        constraint += ` ON UPDATE ${refActionToSql(fk.onUpdate)}`;
      }
      colDefs.push(constraint);
    }
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteTableName(table)} (${colDefs.join(", ")})`;
}

/**
 * Offsets numbered placeholders ($1, $2, ...) in a SQL fragment by a given amount.
 * Used when WHERE params follow SET params in UPDATE statements.
 */
export function offsetPlaceholders(fragment: TSqlFragment, offset: number): TSqlFragment {
  if (offset === 0) {
    return fragment;
  }
  const sql = fragment.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
  return { sql, params: fragment.params };
}
