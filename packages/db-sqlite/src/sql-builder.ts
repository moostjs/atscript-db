import type { TDbFieldMeta, TDbForeignKey, TFieldOps } from "@atscript/db";
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
export { sqlStringLiteral, defaultValueForType, defaultValueToSqlLiteral };
export { toSqlValue as toSqliteValue };

// ── SQLite identifier quoting ────────────────────────────────────────────────

export function esc(name: string): string {
  return name.replace(/"/g, '""');
}

// ── SQLite dialect ───────────────────────────────────────────────────────────

/**
 * Basic regex-to-LIKE conversion.
 * - `^abc` → `abc%`
 * - `abc$` → `%abc`
 * - `^abc$` → `abc`
 * - `abc` → `%abc%`
 */
function regexToLike(pattern: string): string {
  const hasStart = pattern.startsWith("^");
  const hasEnd = pattern.endsWith("$");
  let core = pattern;
  if (hasStart) {
    core = core.slice(1);
  }
  if (hasEnd) {
    core = core.slice(0, -1);
  }

  // Escape SQL LIKE special chars in the core
  core = core.replace(/%/g, "\\%").replace(/_/g, "\\_");
  // Convert regex . to _ and .* to %
  core = core.replace(/\.\*/g, "%").replace(/\./g, "_");

  if (hasStart && hasEnd) {
    return core;
  }
  if (hasStart) {
    return `${core}%`;
  }
  if (hasEnd) {
    return `%${core}`;
  }
  return `%${core}%`;
}

export const sqliteDialect: SqlDialect = {
  quoteIdentifier(name: string) {
    return `"${esc(name)}"`;
  },
  quoteTable(name: string) {
    return `"${esc(name)}"`;
  },
  unlimitedLimit: "-1",
  toValue: toSqlValue,
  toParam(value: unknown) {
    if (value === undefined) {
      return null;
    }
    return typeof value === "boolean" ? (value ? 1 : 0) : value;
  },
  regex(quotedCol: string, value: unknown): TSqlFragment {
    const pattern = regexToLike(value instanceof RegExp ? value.source : String(value));
    return { sql: `${quotedCol} LIKE ?`, params: [pattern] };
  },
  createViewPrefix: "CREATE VIEW IF NOT EXISTS",
};

// ── Pre-bound DML builders ──────────────────────────────────────────────────

/**
 * Builds an INSERT statement.
 *
 * @param table - Table name.
 * @param data - Column→value map.
 * @returns `{ sql, params }` ready for `driver.run()`.
 */
export function buildInsert(table: string, data: Record<string, unknown>): TSqlFragment {
  return _buildInsert(sqliteDialect, table, data);
}

/**
 * Builds a SELECT statement with optional sort, limit, offset, projection.
 */
export function buildSelect(
  table: string,
  where: TSqlFragment,
  controls?: DbControls,
): TSqlFragment {
  return _buildSelect(sqliteDialect, table, where, controls);
}

/**
 * Builds an UPDATE ... SET ... WHERE statement.
 */
export function buildUpdate(
  table: string,
  data: Record<string, unknown>,
  where: TSqlFragment,
  ops?: TFieldOps,
): TSqlFragment {
  return _buildUpdate(sqliteDialect, table, data, where, undefined, ops);
}

/**
 * Builds a DELETE ... WHERE statement.
 */
export function buildDelete(table: string, where: TSqlFragment): TSqlFragment {
  return _buildDelete(sqliteDialect, table, where);
}

/**
 * Builds a CREATE VIEW IF NOT EXISTS statement from a view plan and column mappings.
 *
 * @param viewName - The view name.
 * @param plan - Resolved view plan (entry table, joins, filter).
 * @param columns - Column mappings (view column → source table.column).
 * @param resolveFieldRef - Resolves a query field ref to `"table"."column"` SQL.
 */
export function buildCreateView(
  viewName: string,
  plan: TViewPlan,
  columns: TViewColumnMapping[],
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  return _buildCreateView(sqliteDialect, viewName, plan, columns, resolveFieldRef);
}

/**
 * Builds a SELECT ... GROUP BY statement with aggregate functions.
 */
export function buildAggregateSelect(
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return _buildAggregateSelect(sqliteDialect, table, where, controls);
}

/**
 * Builds a COUNT query for the number of distinct groups.
 */
export function buildAggregateCount(
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return _buildAggregateCount(sqliteDialect, table, where, controls);
}

// ── SQLite-specific DDL ──────────────────────────────────────────────────────

/**
 * Maps Atscript design types to SQLite storage types.
 */
export function sqliteTypeFromDesignType(designType: string): string {
  switch (designType) {
    case "number":
    case "integer":
    case "decimal": {
      return "REAL";
    }
    case "boolean": {
      return "INTEGER";
    }
    case "string": {
      return "TEXT";
    }
    default: {
      // Arrays, objects, etc. → store as JSON text
      return "TEXT";
    }
  }
}

/**
 * Builds a CREATE TABLE IF NOT EXISTS statement from field descriptors.
 * Uses pre-computed {@link TDbFieldMeta} — no raw type introspection needed.
 */
export function buildCreateTable(
  table: string,
  fields: readonly TDbFieldMeta[],
  foreignKeys?: ReadonlyMap<string, TDbForeignKey>,
): string {
  const colDefs: string[] = [];
  const primaryKeys = fields.filter((f) => f.isPrimaryKey);

  for (const field of fields) {
    if (field.ignored) {
      continue;
    }

    // Numeric primary keys must be INTEGER (not REAL) for SQLite rowid alias / auto-increment
    const sqlType =
      field.isPrimaryKey && (field.designType === "number" || field.designType === "integer")
        ? "INTEGER"
        : sqliteTypeFromDesignType(field.designType);

    let def = `"${esc(field.physicalName)}" ${sqlType}`;
    if (field.isPrimaryKey && primaryKeys.length === 1) {
      def += " PRIMARY KEY";
      // Add AUTOINCREMENT for integer PKs with @db.default.increment
      // (enables sqlite_sequence seeding for start values)
      if (
        field.defaultValue?.kind === "fn" &&
        field.defaultValue.fn === "increment" &&
        (field.designType === "number" || field.designType === "integer")
      ) {
        def += " AUTOINCREMENT";
      }
    }
    if (!field.optional && !field.isPrimaryKey) {
      def += " NOT NULL";
    }
    if (field.defaultValue?.kind === "value") {
      def += ` DEFAULT ${defaultValueToSqlLiteral(field.designType, field.defaultValue.value)}`;
    }
    if (field.collate) {
      def += ` COLLATE ${field.collate.toUpperCase()}`;
    }
    colDefs.push(def);
  }

  // Composite primary key
  if (primaryKeys.length > 1) {
    const pkCols = primaryKeys.map((pk) => `"${esc(pk.physicalName)}"`).join(", ");
    colDefs.push(`PRIMARY KEY (${pkCols})`);
  }

  // Foreign key constraints
  if (foreignKeys) {
    for (const fk of foreignKeys.values()) {
      const localCols = fk.fields.map((f) => `"${esc(f)}"`).join(", ");
      const targetCols = fk.targetFields.map((f) => `"${esc(f)}"`).join(", ");
      let constraint = `FOREIGN KEY (${localCols}) REFERENCES "${esc(fk.targetTable)}" (${targetCols})`;
      if (fk.onDelete) {
        constraint += ` ON DELETE ${refActionToSql(fk.onDelete)}`;
      }
      if (fk.onUpdate) {
        constraint += ` ON UPDATE ${refActionToSql(fk.onUpdate)}`;
      }
      colDefs.push(constraint);
    }
  }

  return `CREATE TABLE IF NOT EXISTS "${esc(table)}" (${colDefs.join(", ")})`;
}
