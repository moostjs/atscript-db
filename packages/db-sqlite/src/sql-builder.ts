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
  parseRegexString,
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
 * Regex characters whose backslash form means "literal char". The walker emits
 * the unescaped char (with re-escaping for SQL LIKE wildcards). Anything outside
 * this set — `\d`, `\w`, `\s`, `\b`, etc. — is rejected as an unsupported feature.
 */
const REGEX_LITERAL_ESCAPES = new Set(".^$()[]{}|/+*?-\\");

/**
 * Unescaped regex metacharacters with no LIKE equivalent. Subset of
 * {@link REGEX_LITERAL_ESCAPES}: the same chars are rejected unescaped here
 * but accepted as literals when preceded by `\`.
 */
const REGEX_UNSUPPORTED = new Set("()[]{}|*+?");

/**
 * Re-escape a literal char for SQL LIKE under `ESCAPE '\'`. `%`, `_`, and `\`
 * are LIKE metachars and need a backslash prefix; everything else passes through.
 */
function likeEscape(ch: string): string {
  return ch === "%" || ch === "_" || ch === "\\" ? `\\${ch}` : ch;
}

/**
 * Translates a regex pattern into a SQLite LIKE pattern. The dialect emits the
 * resulting SQL with `ESCAPE '\'`, so `\%` and `\_` in the output denote literal
 * `%` / `_`, and `\\` denotes a literal backslash.
 *
 * Supported subset:
 * - anchors `^` and `$` (must appear at the very start / end of the pattern)
 * - `.` (any single char) and `.*` (any run of chars)
 * - escaped literals: `\.`, `\^`, `\$`, `\(`, `\)`, `\[`, `\]`, `\{`, `\}`,
 *   `\|`, `\/`, `\+`, `\*`, `\?`, `\-`, `\\`
 *
 * Throws on character classes, alternation, groups, quantifiers other than `.*`,
 * and shorthand classes (`\d`, `\w`, `\s`, `\b`, …) — these would silently match
 * the wrong rows under a naive translation, and a Node-side fallback would break
 * pagination, ordering, and aggregation pushdown.
 *
 * `^` and `$` outside the start/end of the pattern are treated as literal chars
 * (multiline anchors aren't supported).
 */
function regexToLike(pattern: string): string {
  const hasStart = pattern.startsWith("^");
  const hasEnd = endsWithUnescapedDollar(pattern);
  const start = hasStart ? 1 : 0;
  const end = hasEnd ? pattern.length - 1 : pattern.length;

  let out = "";
  for (let i = start; i < end; i++) {
    const c = pattern[i]!;

    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        throw new Error(`Trailing backslash in regex pattern: ${pattern}`);
      }
      if (!REGEX_LITERAL_ESCAPES.has(next)) {
        throw new Error(
          `Unsupported regex escape '\\${next}' in pattern '${pattern}' — only literal-meaning escapes are supported by the SQLite LIKE translation`,
        );
      }
      out += likeEscape(next);
      i++;
      continue;
    }

    if (c === ".") {
      if (pattern[i + 1] === "*") {
        out += "%";
        i++;
      } else {
        out += "_";
      }
      continue;
    }

    if (REGEX_UNSUPPORTED.has(c)) {
      throw new Error(
        `Unsupported regex feature '${c}' in pattern '${pattern}' — only anchors, '.', '.*', and escaped literals are supported by the SQLite LIKE translation`,
      );
    }

    out += likeEscape(c);
  }

  if (hasStart && hasEnd) return out;
  if (hasStart) return `${out}%`;
  if (hasEnd) return `%${out}`;
  return `%${out}%`;
}

/**
 * `$` at the end of the pattern is the end-anchor only if it is not preceded by
 * an odd number of backslashes (i.e. not escaped). `\$` and `\\\$` are literal,
 * `$` and `\\$` are anchors.
 */
function endsWithUnescapedDollar(s: string): boolean {
  const m = s.match(/(\\*)\$$/);
  return m !== null && m[1]!.length % 2 === 0;
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
    const { pattern, flags } = parseRegexString(value);
    const likePattern = regexToLike(pattern);
    const collate = flags.includes("i") ? " COLLATE NOCASE" : "";
    return { sql: `${quotedCol} LIKE ? ESCAPE '\\'${collate}`, params: [likePattern] };
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
 * Converts an Atlas-style similarity score (1 = exact, 0 = orthogonal) to a
 * vec0 distance threshold.
 *
 * - cosine / dotProduct (mapped to cosine in DDL): vec0 distance = 1 - cos_sim,
 *   normalized score = (1 + cos_sim) / 2, so distance = 2 * (1 - score).
 * - euclidean (l2): vec0 distance is unbounded; the value is treated as a max
 *   distance directly (same convention as pgvector).
 */
export function thresholdToVecDistance(threshold: number, similarity: string | undefined): number {
  if (similarity === "euclidean") {
    return threshold;
  }
  return 2 * (1 - threshold);
}

/**
 * Maps an Atscript `@db.search.vector` similarity value to a sqlite-vec `vec0` metric.
 * `dotProduct` falls back to `cosine` because vec0 has no dedicated dot-product metric.
 */
export function similarityToVecMetric(s: string | undefined): "cosine" | "l2" | "l1" {
  if (s === "euclidean") {
    return "l2";
  }
  return "cosine";
}

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
  options?: { typeMapper?: (field: TDbFieldMeta) => string },
): string {
  const colDefs: string[] = [];
  const primaryKeys = fields.filter((f) => f.isPrimaryKey);

  for (const field of fields) {
    if (field.ignored) {
      continue;
    }

    // Numeric primary keys must be INTEGER (not REAL) for SQLite rowid alias / auto-increment
    const sqlType =
      options?.typeMapper?.(field) ??
      (field.isPrimaryKey && (field.designType === "number" || field.designType === "integer")
        ? "INTEGER"
        : sqliteTypeFromDesignType(field.designType));

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
