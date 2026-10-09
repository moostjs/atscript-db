import type { DbControls, UniquSelect, TFieldOps } from "@atscript/db";
import type { TDbDefaultFn, TDbFieldMeta } from "@atscript/db";

import type { SqlDialect, TSqlFragment } from "./dialect";
import { finalizeParams } from "./dialect";
import { fromSourceHint, fromSourceSql, type TSqlFromSource } from "./from-source";

/**
 * Builds an INSERT statement.
 */
export function buildInsert(
  dialect: SqlDialect,
  table: string,
  data: Record<string, unknown>,
): TSqlFragment {
  const keys = Object.keys(data);
  const cols = keys.map((k) => dialect.quoteIdentifier(k)).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  return finalizeParams(dialect, {
    sql: `INSERT INTO ${dialect.quoteTable(table)} (${cols}) VALUES (${placeholders})`,
    params: keys.map((k) => dialect.toValue(data[k])),
  });
}

/**
 * Single-row INSERT builder that reuses the statement text per column
 * signature — the same SQL {@link buildInsert} renders, built once per
 * distinct key list (in order) of the rows of one table instead of per row.
 * Bounded: once `max` signatures are held the cache starts over.
 * @since 0.1.151
 */
export class InsertSqlCache {
  private readonly _sql = new Map<string, string>();
  private _table?: string;
  /** The previous row's keys and SQL — a batch of one shape skips the signature. */
  private _lastKeys?: string[];
  private _lastSql = "";

  constructor(
    private readonly _dialect: SqlDialect,
    private readonly _max = 64,
  ) {}

  build(table: string, data: Record<string, unknown>): TSqlFragment {
    if (table !== this._table) {
      this._sql.clear();
      this._table = table;
      this._lastKeys = undefined;
    }
    const keys = Object.keys(data);
    let sql: string | undefined;
    if (this._lastKeys !== undefined && sameKeys(this._lastKeys, keys)) {
      sql = this._lastSql;
    } else {
      const signature = keys.join("\0");
      sql = this._sql.get(signature);
      if (sql === undefined) {
        sql = buildInsert(this._dialect, table, data).sql;
        if (this._sql.size >= this._max) this._sql.clear();
        this._sql.set(signature, sql);
      }
      this._lastKeys = keys;
      this._lastSql = sql;
    }
    const dialect = this._dialect;
    const params: unknown[] = [];
    for (const key of keys) params.push(dialect.toValue(data[key]));
    return { sql, params };
  }
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The columns of a multi-row INSERT: the union of the rows' keys, in
 * first-seen order (rows may differ in shape — an optional field omitted on
 * some).
 */
export function insertManyColumns(rows: readonly Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key);
  }
  return [...columns];
}

/**
 * Splits `rows` into batches that stay under the driver's bind-parameter limit
 * (PostgreSQL ~65535, MySQL packet size): `maxParams` (default 60000) divided
 * by the column count. Returns the shared column union and the batches.
 */
export function chunkInsertRows(
  rows: readonly Record<string, unknown>[],
  maxParams = 60000,
): { columns: string[]; batches: Record<string, unknown>[][] } {
  const columns = insertManyColumns(rows);
  const size =
    columns.length > 0 ? Math.max(1, Math.floor(maxParams / columns.length)) : rows.length;
  const batches: Record<string, unknown>[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    batches.push(rows.slice(offset, offset + size));
  }
  return { columns, batches };
}

/**
 * Builds a multi-row `INSERT … VALUES (…), (…)` statement over `columns`
 * (default: {@link insertManyColumns} of `rows`). A row lacking a column gets
 * `DEFAULT` — exactly what a single-row INSERT omitting it stores. Callers
 * split large inputs into batches themselves (passing the same `columns` to
 * each) and append any `RETURNING` clause.
 */
export function buildInsertMany(
  dialect: SqlDialect,
  table: string,
  rows: readonly Record<string, unknown>[],
  columns: readonly string[] = insertManyColumns(rows),
): TSqlFragment {
  const cols = columns.map((k) => dialect.quoteIdentifier(k)).join(", ");
  const fullRow = `(${columns.map(() => "?").join(", ")})`;
  const params: unknown[] = [];
  const clauses: string[] = [];
  for (const row of rows) {
    let missing = false;
    for (const k of columns) {
      if (k in row) params.push(dialect.toValue(row[k]));
      else missing = true;
    }
    clauses.push(
      missing ? `(${columns.map((k) => (k in row ? "?" : "DEFAULT")).join(", ")})` : fullRow,
    );
  }
  return finalizeParams(dialect, {
    sql: `INSERT INTO ${dialect.quoteTable(table)} (${cols}) VALUES ${clauses.join(", ")}`,
    params,
  });
}

/**
 * Builds a SELECT statement with optional sort, limit, offset, projection.
 * `table` may be a derived source (a pruned view read, since 0.1.153).
 */
export function buildSelect(
  dialect: SqlDialect,
  table: TSqlFromSource,
  where: TSqlFragment,
  controls?: DbControls,
): TSqlFragment {
  const cols = buildProjection(dialect, controls?.$select);
  let sql = `SELECT ${fromSourceHint(table)}${cols} FROM ${fromSourceSql(dialect, table)} WHERE ${where.sql}`;
  const params = [...where.params];

  const orderBy = orderByList(dialect, controls?.$sort);
  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  if (controls?.$limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(controls.$limit);
  }

  if (controls?.$skip !== undefined) {
    if (controls.$limit === undefined) {
      sql += ` LIMIT ${dialect.unlimitedLimit}`;
    }
    sql += ` OFFSET ?`;
    params.push(controls.$skip);
  }

  return finalizeParams(dialect, { sql, params });
}

/** `"col" ASC, "other" DESC` of a physical `$sort` — `""` when it orders nothing. */
function orderByList(dialect: SqlDialect, sort: DbControls["$sort"]): string {
  if (!sort) {
    return "";
  }
  const parts: string[] = [];
  for (const [col, dir] of Object.entries(sort)) {
    parts.push(`${dialect.quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`);
  }
  return parts.join(", ");
}

/**
 * The row-number column {@link buildPartitionedSelect} adds to every row;
 * {@link stripPartitionRowNumber} removes it from the result rows.
 * @since 0.1.147
 */
export const PARTITION_ROW_NUMBER_ALIAS = "__atscript_rn";

/**
 * Builds a SELECT whose `$skip` / `$limit` apply to each partition — the rows
 * sharing the values of the `partitionBy` columns (physical names) — instead
 * of to the whole result: a `ROW_NUMBER() OVER (PARTITION BY … ORDER BY
 * <$sort>)` window in a derived table, filtered on the row number. The rows
 * of each partition come out in `$sort` order (partitions interleave); every
 * row carries {@link PARTITION_ROW_NUMBER_ALIAS}. Window functions need
 * SQLite ≥ 3.25, MySQL ≥ 8.0 or MariaDB ≥ 10.2.
 * @since 0.1.147
 */
export function buildPartitionedSelect(
  dialect: SqlDialect,
  table: TSqlFromSource,
  where: TSqlFragment,
  controls: DbControls,
  partitionBy: readonly string[],
): TSqlFragment {
  const rn = dialect.quoteIdentifier(PARTITION_ROW_NUMBER_ALIAS);
  const orderBy = orderByList(dialect, controls.$sort);
  const window =
    `PARTITION BY ${partitionBy.map((col) => dialect.quoteIdentifier(col)).join(", ")}` +
    (orderBy ? ` ORDER BY ${orderBy}` : "");
  const inner =
    `SELECT ${fromSourceHint(table)}${buildProjection(dialect, controls.$select)}, ROW_NUMBER() OVER (${window}) AS ${rn}` +
    ` FROM ${fromSourceSql(dialect, table)} WHERE ${where.sql}`;
  const skip = (controls.$skip as number | undefined) ?? 0;
  const limit = controls.$limit as number | undefined;
  const params = [...where.params, skip];
  let sql = `SELECT * FROM (${inner}) AS ${dialect.quoteIdentifier("__atscript_p")} WHERE ${rn} > ?`;
  if (limit !== undefined && limit !== null) {
    sql += ` AND ${rn} <= ?`;
    params.push(skip + limit);
  }
  sql += ` ORDER BY ${rn}`;
  return finalizeParams(dialect, { sql, params });
}

/** Removes {@link PARTITION_ROW_NUMBER_ALIAS} from rows read by {@link buildPartitionedSelect}. */
export function stripPartitionRowNumber<R extends Record<string, unknown>>(rows: R[]): R[] {
  for (const row of rows) {
    delete row[PARTITION_ROW_NUMBER_ALIAS];
  }
  return rows;
}

// ── Full replace (since 0.1.128) ────────────────────────────────────────────

/**
 * Marker value for {@link buildUpdate}: the column is assigned its DDL
 * `DEFAULT` (`SET "col" = DEFAULT`, no bound parameter). Produced by
 * {@link fillReplacePayload} for columns whose function default the engine
 * owns; never appears in a patch.
 */
export const SQL_DEFAULT: unique symbol = Symbol("SQL_DEFAULT");

/** One physical column a full replace must assign. */
export interface TReplaceColumn {
  /** Physical column name. */
  name: string;
  /**
   * `true` when the engine owns this column's function default (`now`,
   * `uuid`, `increment` listed in the adapter's `nativeDefaultFns()`): an
   * omitted value re-applies the DDL `DEFAULT` instead of storing NULL.
   */
  useDefault: boolean;
}

/**
 * The columns a full replace assigns on a SQL adapter: the readable's
 * `storedDescriptors` (non-ignored, not derived — a generated column is
 * never assigned) except the primary key — the row is matched by the filter,
 * and an omitted PK must never be nulled or re-defaulted. Static value
 * defaults are filled SDK-side before the adapter sees the row, so only
 * native function defaults are flagged. Ignored and derived descriptors in
 * `fields` are skipped, so `fieldDescriptors` works too.
 */
export function replaceColumnsFor(
  fields: readonly TDbFieldMeta[],
  nativeFns: ReadonlySet<TDbDefaultFn>,
): TReplaceColumn[] {
  const out: TReplaceColumn[] = [];
  for (const fd of fields) {
    if (fd.ignored || fd.isPrimaryKey || fd.derived) continue;
    const def = fd.defaultValue;
    out.push({
      name: fd.physicalName,
      useDefault: def?.kind === "fn" && nativeFns.has(def.fn),
    });
  }
  return out;
}

/**
 * Turns a (physical-name) replace payload into a FULL row assignment: every
 * column in `columns` the payload omits becomes `null` — or {@link SQL_DEFAULT}
 * when the engine owns its function default — so an UPDATE-based replace never
 * retains a value the caller left out. This is the SQL counterpart of the
 * whole-document replace the memory and MongoDB adapters do natively. The
 * version column is excluded (`buildUpdate` appends the OCC bump itself).
 * Returns a new object; `data` is not mutated.
 */
export function fillReplacePayload(
  data: Record<string, unknown>,
  columns: readonly TReplaceColumn[],
  versionColumn?: string,
): Record<string, unknown> {
  const full: Record<string, unknown> = { ...data };
  for (const col of columns) {
    if (col.name === versionColumn || col.name in full) continue;
    full[col.name] = col.useDefault ? SQL_DEFAULT : null;
  }
  return full;
}

/**
 * Builds an UPDATE ... SET ... WHERE statement with optional LIMIT.
 *
 * A value of {@link SQL_DEFAULT} renders as `<col> = DEFAULT` (full replace).
 *
 * Optimistic concurrency control (OCC) hooks:
 * - `versionColumn` — when supplied, the builder appends
 *   `<col> = <col> + 1` to the SET list. The bump is **mandatory** whenever
 *   `versionColumn` is set, regardless of whether `expectedVersion` is
 *   supplied. If the version column doesn't auto-increment on every write,
 *   OCC silently degrades to no protection. A caller that must not bump (a
 *   version-exempt patch, `TDbUpdateOptions.keepVersion`) passes
 *   `versionColumn: undefined`, which also drops the CAS predicate — callers
 *   never combine that with `expectedVersion`.
 * - `expectedVersion` — when supplied, the builder appends
 *   `AND <col> = ?` to the WHERE clause and pushes the value. Requires
 *   `versionColumn` (CAS targets that column); supplying `expectedVersion`
 *   without `versionColumn` is a programmer error and throws.
 */
export function buildUpdate(
  dialect: SqlDialect,
  table: string,
  data: Record<string, unknown>,
  where: TSqlFragment,
  limit?: number,
  ops?: TFieldOps,
  versionColumn?: string,
  expectedVersion?: number,
): TSqlFragment {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === SQL_DEFAULT) {
      // Full-replace fill: hand the column back to its DDL DEFAULT (no param).
      setClauses.push(`${dialect.quoteIdentifier(key)} = DEFAULT`);
      continue;
    }
    setClauses.push(`${dialect.quoteIdentifier(key)} = ?`);
    params.push(dialect.toValue(value));
  }

  // Append pre-separated field operations
  if (ops?.inc) {
    for (const key in ops.inc) {
      const col = dialect.quoteIdentifier(key);
      setClauses.push(`${col} = ${col} + ?`);
      params.push(ops.inc[key]!);
    }
  }
  if (ops?.mul) {
    for (const key in ops.mul) {
      const col = dialect.quoteIdentifier(key);
      setClauses.push(`${col} = ${col} * ?`);
      params.push(ops.mul[key]!);
    }
  }

  // Programmer-error guard: CAS targets the version column, so it's meaningless without one.
  if (expectedVersion !== undefined && versionColumn === undefined) {
    throw new Error("buildUpdate: expectedVersion requires versionColumn");
  }

  let whereSql = where.sql;
  const whereParams: unknown[] = [];

  if (versionColumn !== undefined) {
    const vcol = dialect.quoteIdentifier(versionColumn);
    // OCC: auto-bump goes at the end of the SET list so it's grouped visually
    // after user data and field ops in logs.
    setClauses.push(`${vcol} = ${vcol} + 1`);
    // OCC: CAS predicate. If the row's stored version doesn't match, the
    // driver reports zero affected rows.
    if (expectedVersion !== undefined) {
      whereSql += ` AND ${vcol} = ?`;
      whereParams.push(expectedVersion);
    }
  }

  let sql = `UPDATE ${dialect.quoteTable(table)} SET ${setClauses.join(", ")} WHERE ${whereSql}`;
  if (limit !== undefined) {
    sql += ` LIMIT ${limit}`;
  }

  return finalizeParams(dialect, {
    sql,
    params: [...params, ...where.params, ...whereParams],
  });
}

/**
 * Builds a DELETE ... WHERE statement with optional LIMIT.
 */
export function buildDelete(
  dialect: SqlDialect,
  table: string,
  where: TSqlFragment,
  limit?: number,
): TSqlFragment {
  let sql = `DELETE FROM ${dialect.quoteTable(table)} WHERE ${where.sql}`;
  if (limit !== undefined) {
    sql += ` LIMIT ${limit}`;
  }
  return finalizeParams(dialect, { sql, params: where.params });
}

/**
 * The expression a `@db.column.derived` column is generated from: the
 * dialect's typed {@link SqlDialect.jsonExtract} over the (unqualified,
 * quoted) JSON source column — the same extraction a view's JSON leaf uses,
 * so both read a leaf identically. Parameter-free by contract; rendered in
 * `CREATE TABLE` / `ADD COLUMN` as `GENERATED ALWAYS AS (<expr>)`.
 *
 * @throws when `field` is not derived or the dialect has no `jsonExtract`.
 * @since 0.1.141
 */
export function derivedColumnExpr(dialect: SqlDialect, field: TDbFieldMeta): string {
  const derived = field.derived;
  if (!derived) {
    throw new Error(`Column "${field.physicalName}" is not a derived column`);
  }
  if (!dialect.jsonExtract) {
    throw new Error(
      `Derived column "${field.physicalName}": JSON extraction is not supported by this adapter`,
    );
  }
  return dialect.jsonExtract(
    dialect.quoteIdentifier(derived.sourceColumn),
    derived.jsonPath,
    derived.type,
  );
}

/**
 * Builds a column projection (SELECT clause fields).
 *
 * @param qualifier - optional table alias every column (and the `*`
 *   fallback) is qualified with (`"t"."col"`), for projections over a joined
 *   or aliased source such as the geo / vector search subqueries (since 0.1.143).
 */
export function buildProjection(
  dialect: SqlDialect,
  select?: UniquSelect,
  qualifier?: string,
): string {
  const prefix = qualifier === undefined ? "" : `${dialect.quoteTable(qualifier)}.`;
  const fields = select?.asArray;
  if (!fields) {
    return `${prefix}*`;
  }
  let sql = "";
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) {
      sql += ", ";
    }
    sql += prefix + dialect.quoteIdentifier(fields[i]);
  }
  return sql || `${prefix}*`;
}

export { buildCreateView } from "./view-builder";
