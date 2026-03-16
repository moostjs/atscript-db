import type { TDbCollation, TDbFieldMeta, TDbForeignKey } from "@atscript/db";
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
  toSqlValue,
  sqlStringLiteral,
  refActionToSql,
  defaultValueForType,
  defaultValueToSqlLiteral,
} from "@atscript/db-sql-tools";

// Re-export shared utilities for consumers that import from this package
export { sqlStringLiteral, refActionToSql, defaultValueForType, defaultValueToSqlLiteral };

// ── MySQL table options (passed to buildCreateTable) ─────────────────────────

export interface TMysqlTableOptions {
  engine?: string;
  charset?: string;
  collation?: string;
  autoIncrementStart?: number;
  incrementFields?: ReadonlySet<string>;
  onUpdateFields?: ReadonlyMap<string, string>;
}

// ── Identifier quoting ──────────────────────────────────────────────────────

/** Escapes a MySQL identifier by doubling backticks. */
export function esc(name: string): string {
  return name.replace(/`/g, "``");
}

/** Backtick-quotes a single identifier. */
export function qi(name: string): string {
  return `\`${esc(name)}\``;
}

/**
 * Backtick-quotes a table name, handling `schema.table` format.
 * Input is a raw name like `mydb.users` or just `users`.
 */
export function quoteTableName(name: string): string {
  const dot = name.indexOf(".");
  if (dot >= 0) {
    return `${qi(name.slice(0, dot))}.${qi(name.slice(dot + 1))}`;
  }
  return qi(name);
}

// ── MySQL dialect ───────────────────────────────────────────────────────────

export const mysqlDialect: SqlDialect = {
  quoteIdentifier(name: string) {
    return qi(name);
  },
  quoteTable(name: string) {
    return quoteTableName(name);
  },
  unlimitedLimit: "18446744073709551615",
  toValue: toSqlValue,
  toParam(value: unknown) {
    if (value === undefined) {
      return null;
    }
    return typeof value === "boolean" ? (value ? 1 : 0) : value;
  },
  regex(quotedCol: string, value: unknown): TSqlFragment {
    // MySQL supports native REGEXP — no LIKE conversion needed
    const pattern = value instanceof RegExp ? value.source : String(value);
    return { sql: `${quotedCol} REGEXP ?`, params: [pattern] };
  },
  createViewPrefix: "CREATE OR REPLACE VIEW",
};

// ── Pre-bound DML builders ──────────────────────────────────────────────────

/**
 * Builds an INSERT statement.
 */
export function buildInsert(table: string, data: Record<string, unknown>): TSqlFragment {
  return _buildInsert(mysqlDialect, table, data);
}

/**
 * Builds a SELECT statement with optional sort, limit, offset, projection.
 */
export function buildSelect(
  table: string,
  where: TSqlFragment,
  controls?: DbControls,
): TSqlFragment {
  return _buildSelect(mysqlDialect, table, where, controls);
}

/**
 * Builds an UPDATE ... SET ... WHERE statement with optional LIMIT.
 */
export function buildUpdate(
  table: string,
  data: Record<string, unknown>,
  where: TSqlFragment,
  limit?: number,
): TSqlFragment {
  return _buildUpdate(mysqlDialect, table, data, where, limit);
}

/**
 * Builds a DELETE ... WHERE statement with optional LIMIT.
 */
export function buildDelete(table: string, where: TSqlFragment, limit?: number): TSqlFragment {
  return _buildDelete(mysqlDialect, table, where, limit);
}

/**
 * Builds a CREATE OR REPLACE VIEW statement from a view plan and column mappings.
 */
export function buildCreateView(
  viewName: string,
  plan: TViewPlan,
  columns: TViewColumnMapping[],
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  return _buildCreateView(mysqlDialect, viewName, plan, columns, resolveFieldRef);
}

/**
 * Builds a SELECT ... GROUP BY statement with aggregate functions.
 */
export function buildAggregateSelect(
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return _buildAggregateSelect(mysqlDialect, table, where, controls);
}

/**
 * Builds a COUNT query for the number of distinct groups.
 */
export function buildAggregateCount(
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return _buildAggregateCount(mysqlDialect, table, where, controls);
}

// ── MySQL-specific ──────────────────────────────────────────────────────────

/**
 * Maps portable collation values to MySQL collation names.
 */
export function collationToMysql(collation: TDbCollation): string {
  switch (collation) {
    case "binary": {
      return "utf8mb4_bin";
    }
    case "nocase": {
      return "utf8mb4_general_ci";
    }
    case "unicode": {
      return "utf8mb4_unicode_ci";
    }
    default: {
      return "utf8mb4_unicode_ci";
    }
  }
}

/**
 * Maps an Atscript field descriptor to a MySQL column type.
 *
 * Reads `designType`, primitive tags (via `type.type.tags`), and annotations
 * from field metadata to produce the most specific MySQL type.
 *
 * For FK fields, delegates to the target PK's type via `field.fkTargetField`
 * so the FK column type always matches the referenced column.
 */
/** Maps integer primitive tags to MySQL integer types. */
function intTypeFromTags(tags: Set<string> | undefined, unsigned: boolean): string {
  if (tags?.has("int8")) {
    return unsigned ? "TINYINT UNSIGNED" : "TINYINT";
  }
  if (tags?.has("uint8") || tags?.has("byte")) {
    return "TINYINT UNSIGNED";
  }
  if (tags?.has("int16")) {
    return unsigned ? "SMALLINT UNSIGNED" : "SMALLINT";
  }
  if (tags?.has("uint16") || tags?.has("port")) {
    return "SMALLINT UNSIGNED";
  }
  if (tags?.has("int32")) {
    return unsigned ? "INT UNSIGNED" : "INT";
  }
  if (tags?.has("uint32")) {
    return "INT UNSIGNED";
  }
  if (tags?.has("int64")) {
    return unsigned ? "BIGINT UNSIGNED" : "BIGINT";
  }
  if (tags?.has("uint64")) {
    return "BIGINT UNSIGNED";
  }
  return unsigned ? "INT UNSIGNED" : "INT";
}

export function mysqlTypeFromField(field: TDbFieldMeta): string {
  // FK fields inherit their DB type from the referenced target column
  if (field.fkTargetField) {
    return mysqlTypeFromField(field.fkTargetField);
  }

  const tags = field.type?.type?.tags as Set<string> | undefined;
  const metadata = field.type?.metadata;

  // MySQL-specific type override: @db.mysql.type "MEDIUMTEXT"
  const mysqlTypeOverride = metadata?.get("db.mysql.type") as string | undefined;
  if (mysqlTypeOverride) {
    return mysqlTypeOverride;
  }

  // Unsigned modifier: @db.mysql.unsigned
  const unsigned = metadata?.has("db.mysql.unsigned") ?? false;

  // Precision for decimals: @db.column.precision 10, 2
  const precision = metadata?.get("db.column.precision") as
    | { precision: number; scale: number }
    | undefined;

  switch (field.designType) {
    case "number": {
      if (precision) {
        return `DECIMAL(${precision.precision},${precision.scale})`;
      }
      // AUTO_INCREMENT requires an integer type — DOUBLE is invalid
      if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "increment") {
        return unsigned ? "BIGINT UNSIGNED" : "BIGINT";
      }
      // @db.default.now fields are timestamps, not floats
      if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "now") {
        return "TIMESTAMP";
      }
      // number.int has designType "number" but carries the "int" tag —
      // delegate to integer type logic for sized int tags and unsigned
      if (tags?.has("int")) {
        return intTypeFromTags(tags, unsigned);
      }
      return "DOUBLE";
    }
    case "integer": {
      return intTypeFromTags(tags, unsigned);
    }
    case "decimal": {
      if (precision) {
        return `DECIMAL(${precision.precision},${precision.scale})`;
      }
      return "DECIMAL(10,2)";
    }
    case "boolean": {
      return "TINYINT(1)";
    }
    case "string": {
      // char primitive → CHAR(1)
      if (tags?.has("char")) {
        return "CHAR(1)";
      }
      // Check maxLength annotation to decide VARCHAR vs TEXT
      // Compiled format: { length: number; message?: string }
      const maxLen = (metadata?.get("expect.maxLength") as { length: number } | undefined)?.length;
      if (maxLen !== undefined && maxLen <= 65535) {
        return `VARCHAR(${maxLen})`;
      }
      if (maxLen !== undefined && maxLen > 65535) {
        return "LONGTEXT";
      }
      // MySQL requires VARCHAR for primary keys and columns with DEFAULT values
      if (field.isPrimaryKey || field.defaultValue) {
        return "VARCHAR(255)";
      }
      return "TEXT";
    }
    case "json":
    case "object":
    case "array": {
      return "JSON";
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
 * Builds a CREATE TABLE IF NOT EXISTS statement with MySQL options.
 */
export function buildCreateTable(
  table: string,
  fields: readonly TDbFieldMeta[],
  foreignKeys?: ReadonlyMap<string, TDbForeignKey>,
  options?: TMysqlTableOptions,
): string {
  const colDefs: string[] = [];
  const primaryKeys = fields.filter((f) => f.isPrimaryKey);

  for (const field of fields) {
    if (field.ignored) {
      continue;
    }

    const sqlType = mysqlTypeFromField(field);
    let def = `${qi(field.physicalName)} ${sqlType}`;

    // AUTO_INCREMENT for integer PKs with @db.default.increment
    if (options?.incrementFields?.has(field.physicalName)) {
      def += " AUTO_INCREMENT";
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
      // DB-level defaults for uuid and now
      if (field.defaultValue.fn === "uuid") {
        def += " DEFAULT (UUID())";
      } else if (field.defaultValue.fn === "now") {
        def += " DEFAULT CURRENT_TIMESTAMP";
      }
      // increment is handled via AUTO_INCREMENT above
    }

    // Collation (portable or native override)
    const nativeCollate = field.type?.metadata?.get("db.mysql.collate") as string | undefined;
    if (nativeCollate) {
      def += ` COLLATE ${nativeCollate}`;
    } else if (field.collate) {
      def += ` COLLATE ${collationToMysql(field.collate)}`;
    }

    // ON UPDATE expression
    const onUpdate = options?.onUpdateFields?.get(field.physicalName);
    if (onUpdate) {
      def += ` ON UPDATE ${onUpdate}`;
    }

    colDefs.push(def);
  }

  // Primary key constraint
  if (primaryKeys.length === 1) {
    const pkCol = qi(primaryKeys[0].physicalName);
    for (let i = 0; i < colDefs.length; i++) {
      if (colDefs[i].startsWith(pkCol)) {
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

  let sql = `CREATE TABLE IF NOT EXISTS ${quoteTableName(table)} (${colDefs.join(", ")})`;

  // Table options
  const engine = options?.engine ?? "InnoDB";
  const charset = options?.charset ?? "utf8mb4";
  const collation = options?.collation ?? "utf8mb4_unicode_ci";
  sql += ` ENGINE=${engine} DEFAULT CHARSET=${charset} COLLATE=${collation}`;

  if (options?.autoIncrementStart !== undefined) {
    sql += ` AUTO_INCREMENT=${options.autoIncrementStart}`;
  }

  return sql;
}
