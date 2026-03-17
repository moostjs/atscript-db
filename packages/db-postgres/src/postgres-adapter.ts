import type { TMetadataMap } from "@atscript/typescript/utils";
import { BaseDbAdapter, AtscriptDbView, DbError } from "@atscript/db";
import type { TFieldOps } from "@atscript/db";
import type {
  TDbDeleteResult,
  TDbIndex,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
  TExistingColumn,
  TColumnDiff,
  TSyncColumnResult,
  TDbFieldMeta,
  TDbDefaultFn,
  TValueFormatterPair,
} from "@atscript/db";
import type { DbQuery, FilterExpr, TSearchIndexInfo } from "@atscript/db";

import { buildWhere } from "./filter-builder";
import {
  buildCreateTable,
  buildCreateView,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  buildAggregateSelect,
  buildAggregateCount,
  defaultValueForType,
  defaultValueToSqlLiteral,
  pgTypeFromField,
  qi,
  quoteTableName,
  collationToPg,
  refActionToSql,
  pgDialect,
  finalizeParams,
  offsetPlaceholders,
} from "./sql-builder";
import type { TPgConnection, TPgDriver } from "./types";

/** PostgreSQL COUNT() may return string (bigint) — parse to number. */
function parseCount(value: number | string | undefined): number {
  if (typeof value === "string") {
    return Number.parseInt(value, 10);
  }
  return value ?? 0;
}

/**
 * PostgreSQL adapter for {@link AtscriptDbTable}.
 *
 * Accepts any {@link TPgDriver} implementation — the actual PostgreSQL driver
 * is fully swappable (pg Pool, custom implementations, etc.).
 *
 * Usage:
 * ```typescript
 * import { PgDriver, PostgresAdapter } from '@atscript/db-postgres'
 * import { DbSpace } from '@atscript/db'
 *
 * const driver = new PgDriver('postgresql://user@localhost:5432/mydb')
 * const space = new DbSpace(() => new PostgresAdapter(driver))
 * const users = space.getTable(UsersType)
 * ```
 */
export class PostgresAdapter extends BaseDbAdapter {
  override supportsColumnModify = true;

  // PostgreSQL supports native UUID generation via gen_random_uuid() and can
  // return the value via RETURNING, so 'uuid' is included unlike MySQL.
  // 'now' maps to BIGINT (epoch ms) with DEFAULT (extract(epoch from now()) * 1000)::bigint.
  private static readonly NATIVE_DEFAULT_FNS: ReadonlySet<TDbDefaultFn> = new Set([
    "now",
    "uuid",
    "increment",
  ]);

  // ── PostgreSQL-specific state from annotations ────────────────────────────
  private _incrementFields = new Set<string>();
  private _autoIncrementStart?: number;

  // ── Nocase columns (for CITEXT extension provisioning) ─────────────────
  /** Physical column names with @db.collate 'nocase'. Used to trigger CITEXT extension. */
  private _nocaseColumns = new Set<string>();
  /** Whether citext extension has been provisioned (avoids redundant round-trips). */
  private _citextProvisioned = false;

  // ── Vector search state ─────────────────────────────────────────────────
  /** Whether the connected PostgreSQL instance has the pgvector extension. */
  private _supportsVector: boolean | undefined;
  /** Vector fields: physical field name → { dimensions, similarity, indexName }. */
  private _vectorFields = new Map<
    string,
    { dimensions: number; similarity: string; indexName: string }
  >();
  /** Default similarity thresholds per vector field (from @db.search.vector.threshold). */
  private _vectorThresholds = new Map<string, number>();

  /** Schema name for queries (null falls through to 'public'). */
  private get _schema(): string | null {
    return this._table.schema ?? null;
  }

  constructor(protected readonly driver: TPgDriver) {
    super();
  }

  // ── Transaction primitives ──────────────────────────────────────────────

  protected override async _beginTransaction(): Promise<TPgConnection> {
    const conn = await this.driver.getConnection();
    try {
      await conn.exec("BEGIN");
      this._log("BEGIN");
      return conn;
    } catch (err) {
      conn.release();
      throw err;
    }
  }

  protected override async _commitTransaction(state: unknown): Promise<void> {
    const conn = state as TPgConnection;
    try {
      this._log("COMMIT");
      await conn.exec("COMMIT");
    } finally {
      conn.release();
    }
  }

  protected override async _rollbackTransaction(state: unknown): Promise<void> {
    const conn = state as TPgConnection;
    try {
      this._log("ROLLBACK");
      await conn.exec("ROLLBACK");
    } finally {
      conn.release();
    }
  }

  /**
   * Returns the active executor: dedicated connection if inside a transaction,
   * otherwise the pool-based driver.
   */
  private _exec(): Pick<TPgDriver, "run" | "all" | "get" | "exec"> {
    const txState = this._getTransactionState() as TPgConnection | undefined;
    return txState ?? this.driver;
  }

  // ── Capability flags ──────────────────────────────────────────────────────

  /** PostgreSQL enforces FK constraints natively. */
  override supportsNativeForeignKeys(): boolean {
    return true;
  }

  override prepareId(id: unknown, _fieldType: unknown): unknown {
    return id;
  }

  override supportsNativeValueDefaults(): boolean {
    return true;
  }

  override nativeDefaultFns(): ReadonlySet<TDbDefaultFn> {
    return PostgresAdapter.NATIVE_DEFAULT_FNS;
  }

  // ── Annotation hooks ──────────────────────────────────────────────────────

  override onBeforeFlatten(_type: unknown): void {
    // PostgreSQL tables have no engine/charset/collation table-level options
  }

  override onAfterFlatten(): void {
    // Scan field descriptors for @db.collate 'nocase' — maps to CITEXT column type
    // (case-insensitive text). Extension is provisioned in ensureTable().
    for (const fd of this._table.fieldDescriptors) {
      if (fd.collate === "nocase") {
        this._nocaseColumns.add(fd.physicalName);
      }
    }
  }

  override onFieldScanned(
    field: string,
    _type: unknown,
    metadata: TMetadataMap<AtscriptMetadata>,
  ): void {
    // Track @db.default.increment fields + optional start value
    if (metadata.has("db.default.increment")) {
      this._incrementFields.add(field);
      const startVal = metadata.get("db.default.increment");
      if (typeof startVal === "number") {
        this._autoIncrementStart = startVal;
      }
    }
    // @db.search.vector — vector embedding field
    const vectorMeta = metadata.get("db.search.vector") as
      | { dimensions: number; similarity?: string; indexName?: string }
      | undefined;
    if (vectorMeta) {
      const indexName = vectorMeta.indexName || field;
      this._vectorFields.set(field, {
        dimensions: vectorMeta.dimensions,
        similarity: vectorMeta.similarity || "cosine",
        indexName,
      });
      // @db.search.vector.threshold
      const threshold = metadata.get("db.search.vector.threshold") as number | undefined;
      if (threshold !== undefined) {
        this._vectorThresholds.set(indexName, threshold);
      }
    }
  }

  // ── Table options ────────────────────────────────────────────────────────

  // PostgreSQL tables have no engine/charset/collation options
  override getDesiredTableOptions() {
    return [];
  }
  override async getExistingTableOptions() {
    return [];
  }

  /**
   * Converts vector fields between JavaScript `number[]` and pgvector text format `[1,2,3]`.
   * The pg driver serializes JS arrays as PostgreSQL array literals `{1,2,3}` which is
   * invalid for the pgvector `vector` type — it expects bracket-delimited `[1,2,3]`.
   */
  override formatValue(field: TDbFieldMeta): TValueFormatterPair | undefined {
    if (!this._vectorFields.has(field.path)) {
      return undefined;
    }
    return {
      toStorage: (value: unknown) => (Array.isArray(value) ? `[${value.join(",")}]` : value),
      fromStorage: (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value),
    };
  }

  // ── Error mapping ─────────────────────────────────────────────────────────

  /**
   * Wraps an async write operation to catch PostgreSQL constraint errors
   * and rethrow as structured `DbError`.
   *
   * PostgreSQL uses SQLSTATE codes:
   * - 23505 = unique_violation
   * - 23503 = foreign_key_violation
   */
  private async _wrapConstraintError<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error) {
        const err = error as {
          code: string;
          detail?: string;
          constraint?: string;
          message: string;
        };

        // Unique constraint violation
        if (err.code === "23505") {
          const field = this._extractFieldFromConstraint(err.constraint) ?? "";
          throw new DbError("CONFLICT", [{ path: field, message: err.detail ?? err.message }]);
        }

        // FK violation
        if (err.code === "23503") {
          const errors = this._mapFkError(err.detail ?? err.message, err.constraint);
          throw new DbError("FK_VIOLATION", errors);
        }
      }
      throw error;
    }
  }

  private _extractFieldFromConstraint(constraint?: string): string | undefined {
    if (!constraint) {
      return undefined;
    }
    // PG auto-generated: tablename_columnname_key (single-column unique)
    const tableName = this._table.tableName;
    if (constraint.startsWith(`${tableName}_`) && constraint.endsWith("_key")) {
      const fieldPart = constraint.slice(tableName.length + 1, -4);
      // Only return if it matches a known field (avoids mangled names for composite constraints)
      const fd = this._table.fieldDescriptors.find((f) => f.physicalName === fieldPart);
      if (fd) {
        return fd.path;
      }
    }
    return constraint;
  }

  private _mapFkError(
    detail: string,
    constraint?: string,
  ): Array<{ path: string; message: string }> {
    // PostgreSQL detail format: Key (col)=(val) or Key (col1, col2)=(val1, val2)
    const fkMatch = detail.match(/Key \(([^)]+)\)/);
    if (fkMatch) {
      // May be composite: "col1, col2" — extract first column
      const physicalCol = fkMatch[1].split(",")[0].trim();
      const field = this._table.fieldDescriptors.find((f) => f.physicalName === physicalCol);
      return [{ path: field?.path ?? physicalCol, message: detail }];
    }
    return [{ path: constraint ?? "", message: detail }];
  }

  // ── CRUD: Insert ──────────────────────────────────────────────────────────

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    let { sql, params } = buildInsert(this.resolveTableName(), data);
    // Append RETURNING clause for PK fields
    const pkCols = this._table.primaryKeys.map((pk) => qi(pk));
    if (pkCols.length > 0) {
      sql += ` RETURNING ${pkCols.join(", ")}`;
    }
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    const returned = result.rows?.[0];
    return {
      insertedId: this._resolveInsertedId(data, returned ? Object.values(returned)[0] : undefined),
    };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    if (data.length === 0) {
      return { insertedCount: 0, insertedIds: [] };
    }

    return this.withTransaction(async () => {
      const tableName = this.resolveTableName();
      const pkCols = this._table.primaryKeys;
      const returningSuffix =
        pkCols.length > 0 ? ` RETURNING ${pkCols.map((pk) => qi(pk)).join(", ")}` : "";

      // Use column keys from the first row (all rows should have the same shape after flattening)
      const keys = Object.keys(data[0]);
      const colsClause = keys.map((k) => qi(k)).join(", ");

      // Batch rows into multi-row INSERT statements.
      // PG max params is ~65535; chunk to stay well under the limit.
      const paramsPerRow = keys.length;
      const maxRowsPerBatch = paramsPerRow > 0 ? Math.floor(60000 / paramsPerRow) : data.length;
      const allIds: unknown[] = [];

      for (let offset = 0; offset < data.length; offset += maxRowsPerBatch) {
        const batchEnd = Math.min(offset + maxRowsPerBatch, data.length);
        const batchSize = batchEnd - offset;
        const params: unknown[] = [];
        const valuesClauses: string[] = [];

        for (let i = offset; i < batchEnd; i++) {
          const row = data[i];
          const rowPlaceholders: string[] = [];
          for (const k of keys) {
            params.push(pgDialect.toValue(row[k]));
            rowPlaceholders.push(`$${params.length}`);
          }
          valuesClauses.push(`(${rowPlaceholders.join(", ")})`);
        }

        const sql = `INSERT INTO ${quoteTableName(tableName)} (${colsClause}) VALUES ${valuesClauses.join(", ")}${returningSuffix}`;
        this._log(sql, params);
        const result = await this._wrapConstraintError(() => this._exec().run(sql, params));

        // Map RETURNING rows back to insertedIds
        for (let i = 0; i < batchSize; i++) {
          const returned = result.rows?.[i];
          allIds.push(
            this._resolveInsertedId(
              data[offset + i],
              returned ? Object.values(returned)[0] : undefined,
            ),
          );
        }
      }

      return { insertedCount: allIds.length, insertedIds: allIds };
    });
  }

  // ── CRUD: Read ────────────────────────────────────────────────────────────

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const where = buildWhere(query.filter);
    const controls = { ...query.controls, $limit: 1 };
    const { sql, params } = buildSelect(this.resolveTableName(), where, controls);
    this._log(sql, params);
    return this._exec().get(sql, params);
  }

  async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    const where = buildWhere(query.filter);
    const { sql, params } = buildSelect(this.resolveTableName(), where, query.controls);
    this._log(sql, params);
    return this._exec().all(sql, params);
  }

  async count(query: DbQuery): Promise<number> {
    const where = buildWhere(query.filter);
    const tableName = this.resolveTableName();
    const raw = {
      sql: `SELECT COUNT(*) as cnt FROM ${quoteTableName(tableName)} WHERE ${where.sql}`,
      params: where.params,
    };
    const { sql, params } = finalizeParams(pgDialect, raw);
    this._log(sql, params);
    const row = await this._exec().get<{ cnt: number | string }>(sql, params);
    return parseCount(row?.cnt);
  }

  async aggregate(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    const where = buildWhere(query.filter);
    const tableName = this.resolveTableName();

    if (query.controls.$count) {
      const { sql, params } = buildAggregateCount(tableName, where, query.controls);
      this._log(sql, params);
      const row = await this._exec().get<{ count: number | string }>(sql, params);
      const count = parseCount(row?.count);
      return [{ count }];
    }

    const { sql, params } = buildAggregateSelect(tableName, where, query.controls);
    this._log(sql, params);
    return this._exec().all(sql, params);
  }

  // ── CRUD: Update ──────────────────────────────────────────────────────────

  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): Promise<TDbUpdateResult> {
    // PostgreSQL does not support UPDATE ... LIMIT 1.
    // Use ctid subquery: UPDATE t SET ... WHERE ctid = (SELECT ctid FROM t WHERE ... LIMIT 1)
    const where = buildWhere(filter);
    const tableName = this.resolveTableName();
    const limitedWhere = {
      sql: `ctid = (SELECT ctid FROM ${quoteTableName(tableName)} WHERE ${where.sql} LIMIT 1)`,
      params: where.params,
    };
    const { sql, params } = buildUpdate(tableName, data, limitedWhere, undefined, ops);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { matchedCount: result.affectedRows, modifiedCount: result.affectedRows };
  }

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): Promise<TDbUpdateResult> {
    const where = buildWhere(filter);
    const { sql, params } = buildUpdate(this.resolveTableName(), data, where, undefined, ops);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { matchedCount: result.affectedRows, modifiedCount: result.affectedRows };
  }

  // ── CRUD: Replace ─────────────────────────────────────────────────────────

  async replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    // Use UPDATE (set all columns) instead of DELETE+INSERT to avoid triggering CASCADE deletes
    return this.updateOne(filter, data);
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    return this.updateMany(filter, data);
  }

  // ── CRUD: Delete ──────────────────────────────────────────────────────────

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    // PostgreSQL does not support DELETE ... LIMIT 1.
    // Use ctid subquery: DELETE FROM t WHERE ctid = (SELECT ctid FROM t WHERE ... LIMIT 1)
    const where = buildWhere(filter);
    const tableName = this.resolveTableName();
    const raw = {
      sql: `DELETE FROM ${quoteTableName(tableName)} WHERE ctid = (SELECT ctid FROM ${quoteTableName(tableName)} WHERE ${where.sql} LIMIT 1)`,
      params: where.params,
    };
    const { sql, params } = finalizeParams(pgDialect, raw);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { deletedCount: result.affectedRows };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    const where = buildWhere(filter);
    const { sql, params } = buildDelete(this.resolveTableName(), where);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { deletedCount: result.affectedRows };
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  async ensureTable(): Promise<void> {
    // Provision citext extension for @db.collate 'nocase' columns (once per instance)
    if (this._nocaseColumns.size > 0 && !this._citextProvisioned) {
      try {
        await this._exec().exec("CREATE EXTENSION IF NOT EXISTS citext");
        this._citextProvisioned = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to create citext extension for @db.collate 'nocase' columns: ${msg}. ` +
            `Either run 'CREATE EXTENSION citext' as a superuser, or use @db.pg.type "CITEXT" after provisioning the extension manually.`,
          { cause: err },
        );
      }
    }
    if (this._supportsVector === undefined && this._vectorFields.size > 0) {
      await this._detectVectorSupport();
    }
    if (this._table instanceof AtscriptDbView) {
      return this._ensureView();
    }
    const sql = buildCreateTable(
      this.resolveTableName(),
      this._table.fieldDescriptors,
      this._table.foreignKeys,
      {
        incrementFields: this._incrementFields,
        autoIncrementStart: this._autoIncrementStart,
        typeMapper: (field) => this.typeMapper(field),
      },
    );
    this._log(sql);
    await this._exec().exec(sql);
  }

  private async _ensureView(): Promise<void> {
    const view = this._table as AtscriptDbView;
    const sql = buildCreateView(
      this.resolveTableName(),
      view.viewPlan,
      view.getViewColumnMappings(),
      (ref) => view.resolveFieldRef(ref, qi),
    );
    this._log(sql);
    await this._exec().exec(sql);
  }

  async getExistingColumns(): Promise<TExistingColumn[]> {
    return this.getExistingColumnsForTable(this._table.tableName);
  }

  async getExistingColumnsForTable(tableName: string): Promise<TExistingColumn[]> {
    const schema = this._schema;
    const rows = await this._exec().all<{
      column_name: string;
      data_type: string;
      udt_name: string;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
      formatted_type: string;
    }>(
      `SELECT c.column_name, c.data_type, c.udt_name, c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.is_nullable, c.column_default, c.is_identity,
              format_type(a.atttypid, a.atttypmod) AS formatted_type
       FROM information_schema.columns c
       JOIN pg_attribute a ON a.attname = c.column_name
         AND a.attrelid = (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = COALESCE($2, 'public')))
       WHERE c.table_name = $1 AND c.table_schema = COALESCE($2, 'public')
       ORDER BY c.ordinal_position`,
      [tableName, schema],
    );

    // Query primary key columns
    const pkRows = await this._exec().all<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_name = $1 AND tc.table_schema = COALESCE($2, 'public')
         AND tc.constraint_type = 'PRIMARY KEY'`,
      [tableName, schema],
    );
    const pkSet = new Set(pkRows.map((r) => r.column_name));

    return rows.map((r) => ({
      name: r.column_name,
      type: normalizePgType(
        r.data_type,
        r.character_maximum_length,
        r.numeric_precision,
        r.numeric_scale,
        r.udt_name,
        r.formatted_type,
      ),
      notnull: r.is_nullable === "NO",
      pk: pkSet.has(r.column_name),
      dflt_value: normalizePgDefault(r.column_default, r.is_identity),
    }));
  }

  async syncColumns(diff: TColumnDiff): Promise<TSyncColumnResult> {
    // Provision citext extension before any DDL that may reference the CITEXT type
    if (this._nocaseColumns.size > 0) {
      await this._exec().exec("CREATE EXTENSION IF NOT EXISTS citext");
    }

    const tableName = this.resolveTableName();
    const added: string[] = [];
    const renamed: string[] = [];

    // Renames first
    for (const { field, oldName } of diff.renamed ?? []) {
      const ddl = `ALTER TABLE ${quoteTableName(tableName)} RENAME COLUMN ${qi(oldName)} TO ${qi(field.physicalName)}`;
      this._log(ddl);
      await this._exec().exec(ddl);
      renamed.push(field.physicalName);
    }

    // Adds
    for (const field of diff.added) {
      const sqlType = this.typeMapper(field);
      let ddl = `ALTER TABLE ${quoteTableName(tableName)} ADD COLUMN ${qi(field.physicalName)} ${sqlType}`;
      // GENERATED BY DEFAULT AS IDENTITY for increment fields
      if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "increment") {
        ddl += " GENERATED BY DEFAULT AS IDENTITY";
      } else {
        if (!field.optional && !field.isPrimaryKey) {
          ddl += " NOT NULL";
        }
        if (field.defaultValue?.kind === "value") {
          ddl += ` DEFAULT ${defaultValueToSqlLiteral(field.designType, field.defaultValue.value)}`;
        } else if (field.defaultValue?.kind === "fn") {
          if (field.defaultValue.fn === "uuid") {
            ddl += " DEFAULT gen_random_uuid()";
          } else if (field.defaultValue.fn === "now") {
            ddl += " DEFAULT (extract(epoch from now()) * 1000)::bigint";
          }
        } else if (!field.optional && !field.isPrimaryKey) {
          ddl += ` DEFAULT ${defaultValueForType(field.designType)}`;
        }
      }
      if (field.collate) {
        const nativeCollate = field.type?.metadata?.get("db.pg.collate") as string | undefined;
        if (nativeCollate) {
          ddl += ` COLLATE "${nativeCollate}"`;
        } else {
          const pgCollate = collationToPg(field.collate);
          if (pgCollate) {
            ddl += ` COLLATE ${pgCollate}`;
          }
        }
      }
      this._log(ddl);
      await this._exec().exec(ddl);
      added.push(field.physicalName);
    }

    // Type changes — PostgreSQL supports ALTER TABLE ALTER COLUMN TYPE
    // USING clause required when no implicit cast exists (e.g., TEXT → INTEGER)
    // Double-cast via TEXT as intermediate handles most non-trivial transitions
    for (const { field } of diff.typeChanged ?? []) {
      const sqlType = this.typeMapper(field);
      const col = qi(field.physicalName);
      const ddl = `ALTER TABLE ${quoteTableName(tableName)} ALTER COLUMN ${col} TYPE ${sqlType} USING ${col}::text::${sqlType}`;
      this._log(ddl);
      await this._exec().exec(ddl);
    }

    // Nullable changes
    for (const { field } of diff.nullableChanged ?? []) {
      if (!field.optional) {
        // Backfill NULL values before SET NOT NULL — PG rejects the ALTER if any NULLs exist
        const fallback =
          field.defaultValue?.kind === "value"
            ? defaultValueToSqlLiteral(field.designType, field.defaultValue.value)
            : defaultValueForType(field.designType);
        const backfill = `UPDATE ${quoteTableName(tableName)} SET ${qi(field.physicalName)} = ${fallback} WHERE ${qi(field.physicalName)} IS NULL`;
        this._log(backfill);
        await this._exec().exec(backfill);
      }
      const nullability = field.optional ? "DROP NOT NULL" : "SET NOT NULL";
      const ddl = `ALTER TABLE ${quoteTableName(tableName)} ALTER COLUMN ${qi(field.physicalName)} ${nullability}`;
      this._log(ddl);
      await this._exec().exec(ddl);
    }

    // Default value changes
    for (const { field } of diff.defaultChanged ?? []) {
      let ddl: string;
      if (field.defaultValue?.kind === "value") {
        ddl = `ALTER TABLE ${quoteTableName(tableName)} ALTER COLUMN ${qi(field.physicalName)} SET DEFAULT ${defaultValueToSqlLiteral(field.designType, field.defaultValue.value)}`;
      } else if (field.defaultValue?.kind === "fn") {
        const fnExpr =
          field.defaultValue.fn === "now"
            ? "(extract(epoch from now()) * 1000)::bigint"
            : field.defaultValue.fn === "uuid"
              ? "gen_random_uuid()"
              : `${field.defaultValue.fn}()`;
        ddl = `ALTER TABLE ${quoteTableName(tableName)} ALTER COLUMN ${qi(field.physicalName)} SET DEFAULT ${fnExpr}`;
      } else {
        ddl = `ALTER TABLE ${quoteTableName(tableName)} ALTER COLUMN ${qi(field.physicalName)} DROP DEFAULT`;
      }
      this._log(ddl);
      await this._exec().exec(ddl);
    }

    return { added, renamed };
  }

  async recreateTable(): Promise<void> {
    const tableName = this.resolveTableName();
    // Use schema-qualified temp name so it stays in the correct schema
    const schema = this._schema;
    const baseTempName = `${this._table.tableName}__tmp_${Date.now()}`;
    const tempName = schema ? `${schema}.${baseTempName}` : baseTempName;

    // Use a dedicated connection with a transaction — PostgreSQL DDL is transactional,
    // so the entire recreate is atomic (partial failure rolls back cleanly).
    const conn = await this.driver.getConnection();
    try {
      await conn.exec("BEGIN");

      // Save and drop FK constraints from OTHER tables that reference this table
      const fkRefs = await conn.all<{
        constraint_name: string;
        table_name: string;
        table_schema: string;
        column_name: string;
        ref_column_name: string;
        delete_rule: string;
        update_rule: string;
      }>(
        `SELECT tc.constraint_name, tc.table_name, tc.table_schema,
                kcu.column_name, kcur.column_name AS ref_column_name,
                rc.delete_rule, rc.update_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         JOIN information_schema.key_column_usage kcur
           ON kcur.constraint_name = rc.unique_constraint_name AND kcur.table_schema = rc.unique_constraint_schema
              AND kcur.ordinal_position = kcu.ordinal_position
         WHERE rc.unique_constraint_schema = COALESCE($1, 'public')
           AND rc.unique_constraint_name IN (
             SELECT constraint_name FROM information_schema.table_constraints
             WHERE table_name = $2 AND table_schema = COALESCE($1, 'public') AND constraint_type = 'PRIMARY KEY'
           )`,
        [schema, this._table.tableName],
      );

      // Group FK refs by constraint name for multi-column FKs
      const fkByName = new Map<
        string,
        {
          schema: string;
          table: string;
          cols: string[];
          refCols: string[];
          onDelete: string;
          onUpdate: string;
        }
      >();
      for (const fk of fkRefs) {
        let entry = fkByName.get(fk.constraint_name);
        if (!entry) {
          entry = {
            schema: fk.table_schema,
            table: fk.table_name,
            cols: [],
            refCols: [],
            onDelete: fk.delete_rule,
            onUpdate: fk.update_rule,
          };
          fkByName.set(fk.constraint_name, entry);
        }
        entry.cols.push(fk.column_name);
        entry.refCols.push(fk.ref_column_name);
      }

      // Drop FK constraints
      for (const [name, fk] of fkByName) {
        const ddl = `ALTER TABLE ${qi(fk.schema)}.${qi(fk.table)} DROP CONSTRAINT IF EXISTS ${qi(name)}`;
        this._log(ddl);
        await conn.exec(ddl);
      }

      // 1. Create new table with temp name
      const createSql = buildCreateTable(
        tempName,
        this._table.fieldDescriptors,
        this._table.foreignKeys,
        {
          incrementFields: this._incrementFields,
          autoIncrementStart: this._autoIncrementStart,
          typeMapper: (field) => this.typeMapper(field),
        },
      );
      this._log(createSql);
      await conn.exec(createSql);

      // 2. Get columns that exist in both old and new (query via conn, not pool)
      const oldColRows = await conn.all<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = COALESCE($2, 'public')
         ORDER BY ordinal_position`,
        [this._table.tableName, schema],
      );
      const newCols = this._table.fieldDescriptors
        .filter((f) => !f.ignored)
        .map((f) => f.physicalName);
      const oldColSet = new Set(oldColRows.map((c) => c.column_name));
      const commonCols = newCols.filter((c) => oldColSet.has(c));

      if (commonCols.length > 0) {
        // 3. Copy data
        const fieldsByName = new Map(this._table.fieldDescriptors.map((f) => [f.physicalName, f]));
        const colNames = commonCols.map((c) => qi(c)).join(", ");
        const selectExprs = commonCols
          .map((c) => {
            const field = fieldsByName.get(c);
            if (field && !field.optional && !field.isPrimaryKey) {
              const fallback =
                field.defaultValue?.kind === "value"
                  ? defaultValueToSqlLiteral(field.designType, field.defaultValue.value)
                  : defaultValueForType(field.designType);
              return `COALESCE(${qi(c)}, ${fallback}) AS ${qi(c)}`;
            }
            return qi(c);
          })
          .join(", ");
        const copySql = `INSERT INTO ${quoteTableName(tempName)} (${colNames}) SELECT ${selectExprs} FROM ${quoteTableName(tableName)}`;
        this._log(copySql);
        await conn.exec(copySql);
      }

      // 4. Drop old, rename new
      await conn.exec(`DROP TABLE IF EXISTS ${quoteTableName(tableName)} CASCADE`);
      await conn.exec(
        `ALTER TABLE ${quoteTableName(tempName)} RENAME TO ${qi(this._table.tableName)}`,
      );

      // 5. Restore FK constraints from other tables (PG-M5)
      const resolvedTable = this.resolveTableName();
      for (const [, fk] of fkByName) {
        const localCols = fk.cols.map((c) => qi(c)).join(", ");
        const refCols = fk.refCols.map((c) => qi(c)).join(", ");
        let ddl = `ALTER TABLE ${qi(fk.schema)}.${qi(fk.table)} ADD FOREIGN KEY (${localCols}) REFERENCES ${quoteTableName(resolvedTable)} (${refCols})`;
        if (fk.onDelete !== "NO ACTION") {
          ddl += ` ON DELETE ${fk.onDelete}`;
        }
        if (fk.onUpdate !== "NO ACTION") {
          ddl += ` ON UPDATE ${fk.onUpdate}`;
        }
        this._log(ddl);
        await conn.exec(ddl);
      }

      await conn.exec("COMMIT");

      // Reset identity sequences after data copy — the INSERT INTO ... SELECT
      // uses explicit values, so the sequence doesn't advance.
      await this._resetIdentitySequences();
    } catch (err) {
      await conn.exec("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async afterSyncTable(): Promise<void> {
    await this._resetIdentitySequences();
  }

  /**
   * Resets IDENTITY sequences to MAX(column) so that the next auto-generated
   * value doesn't conflict with existing data. PostgreSQL's GENERATED BY DEFAULT
   * AS IDENTITY does not advance the sequence when rows are inserted with explicit
   * values, so this is needed after data seeding, bulk imports, or recreateTable().
   */
  private async _resetIdentitySequences(): Promise<void> {
    if (this._incrementFields.size === 0) {
      return;
    }
    const tableName = this.resolveTableName();
    // Use configured start value as the empty-table fallback (default 1)
    const emptyFallback = this._autoIncrementStart ?? 1;
    for (const field of this._incrementFields) {
      const col = this._table.fieldDescriptors.find((f) => f.path === field)?.physicalName ?? field;
      // setval(seq, value, is_called):
      //   is_called=true  → nextval returns value+1 (sequence was used up to this point)
      //   is_called=false → nextval returns value   (sequence hasn't been used yet)
      // When table is empty MAX is NULL → use the configured start value with is_called=false
      const sql = `SELECT setval(pg_get_serial_sequence('${tableName}', '${col}'), COALESCE(MAX(${qi(col)}), ${emptyFallback}), MAX(${qi(col)}) IS NOT NULL) FROM ${quoteTableName(tableName)}`;
      this._log(sql);
      await this._exec().run(sql);
    }
  }

  async tableExists(): Promise<boolean> {
    const row = await this._exec().get<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = COALESCE($2, 'public')) AS "exists"`,
      [this._table.tableName, this._schema],
    );
    return row?.exists ?? false;
  }

  async dropTable(): Promise<void> {
    const ddl = `DROP TABLE IF EXISTS ${quoteTableName(this.resolveTableName())} CASCADE`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  async dropColumns(columns: string[]): Promise<void> {
    const tableName = this.resolveTableName();
    const drops = columns.map((col) => `DROP COLUMN ${qi(col)}`).join(", ");
    const ddl = `ALTER TABLE ${quoteTableName(tableName)} ${drops}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  async dropTableByName(tableName: string): Promise<void> {
    const ddl = `DROP TABLE IF EXISTS ${quoteTableName(tableName)} CASCADE`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  async dropViewByName(viewName: string): Promise<void> {
    const ddl = `DROP VIEW IF EXISTS ${quoteTableName(viewName)}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  async renameTable(oldName: string): Promise<void> {
    const newName = this._table.tableName;
    const ddl = `ALTER TABLE ${quoteTableName(oldName)} RENAME TO ${qi(newName)}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  typeMapper(field: TDbFieldMeta): string {
    // Vector fields → vector(N) when pgvector is available, JSONB otherwise
    if (this._vectorFields.has(field.path)) {
      const vec = this._vectorFields.get(field.path)!;
      return this._supportsVector ? `vector(${vec.dimensions})` : "JSONB";
    }
    return pgTypeFromField(field);
  }

  // ── Index sync ────────────────────────────────────────────────────────────

  async syncIndexes(): Promise<void> {
    const tableName = this._table.tableName;
    const schema = this._schema;

    await this.syncIndexesWithDiff({
      listExisting: async () =>
        this._exec().all<{ name: string }>(
          `SELECT indexname AS name FROM pg_indexes
           WHERE tablename = $1 AND schemaname = COALESCE($2, 'public')`,
          [tableName, schema],
        ),
      createIndex: async (index: TDbIndex) => {
        if (index.type === "fulltext") {
          // GIN index on tsvector expression
          const tsvectorExpr = this._buildTsvectorExpr(index.fields);
          const sql = `CREATE INDEX IF NOT EXISTS ${qi(index.key)} ON ${quoteTableName(this.resolveTableName())} USING gin(to_tsvector('english', ${tsvectorExpr}))`;
          this._log(sql);
          await this._exec().exec(sql);
          return;
        }

        const unique = index.type === "unique" ? "UNIQUE " : "";
        const cols = index.fields
          .map((f) => `${qi(f.name)} ${f.sort === "desc" ? "DESC" : "ASC"}`)
          .join(", ");
        const sql = `CREATE ${unique}INDEX IF NOT EXISTS ${qi(index.key)} ON ${quoteTableName(this.resolveTableName())} (${cols})`;
        this._log(sql);
        await this._exec().exec(sql);
      },
      dropIndex: async (name: string) => {
        const schemaPrefix = schema ? `${qi(schema)}.` : "";
        const sql = `DROP INDEX IF EXISTS ${schemaPrefix}${qi(name)}`;
        this._log(sql);
        await this._exec().exec(sql);
      },
    });

    // Create HNSW vector indexes when pgvector is available
    if (this._supportsVector) {
      for (const [field, vec] of this._vectorFields) {
        const indexName = `atscript__vec_${vec.indexName}`;
        const opsClass = similarityToPgOps(vec.similarity);
        const sql = `CREATE INDEX IF NOT EXISTS ${qi(indexName)} ON ${quoteTableName(this.resolveTableName())} USING hnsw (${qi(field)} ${opsClass})`;
        this._log(sql);
        await this._exec().exec(sql);
      }
    }
  }

  // ── FK sync ───────────────────────────────────────────────────────────────

  async syncForeignKeys(): Promise<void> {
    const existingByName = await this._getExistingFkConstraints();

    // Build desired FK set (keyed by sorted local column names)
    const desiredFkKeys = new Set<string>();
    for (const fk of this._table.foreignKeys.values()) {
      desiredFkKeys.add([...fk.fields].toSorted().join(","));
    }

    // Drop stale FKs
    for (const [constraintName, columns] of existingByName) {
      const key = [...columns].toSorted().join(",");
      if (!desiredFkKeys.has(key)) {
        const ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} DROP CONSTRAINT ${qi(constraintName)}`;
        this._log(ddl);
        await this._exec().exec(ddl);
      }
    }

    // Add missing FKs
    const existingKeys = new Set(
      [...existingByName.values()].map((cols) => cols.toSorted().join(",")),
    );
    for (const fk of this._table.foreignKeys.values()) {
      const key = [...fk.fields].toSorted().join(",");
      if (!existingKeys.has(key)) {
        const localCols = fk.fields.map((f) => qi(f)).join(", ");
        const targetCols = fk.targetFields.map((f) => qi(f)).join(", ");
        let ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} ADD FOREIGN KEY (${localCols}) REFERENCES ${qi(fk.targetTable)} (${targetCols})`;
        if (fk.onDelete) {
          ddl += ` ON DELETE ${refActionToSql(fk.onDelete)}`;
        }
        if (fk.onUpdate) {
          ddl += ` ON UPDATE ${refActionToSql(fk.onUpdate)}`;
        }
        this._log(ddl);
        await this._exec().exec(ddl);
      }
    }
  }

  async dropForeignKeys(fkFieldKeys: string[]): Promise<void> {
    if (fkFieldKeys.length === 0) {
      return;
    }
    const keySet = new Set(fkFieldKeys);
    const existingByName = await this._getExistingFkConstraints();

    for (const [constraintName, cols] of existingByName) {
      const key = cols.toSorted().join(",");
      if (keySet.has(key)) {
        const ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} DROP CONSTRAINT ${qi(constraintName)}`;
        this._log(ddl);
        await this._exec().exec(ddl);
      }
    }
  }

  /** Queries information_schema for existing FK constraints. */
  private async _getExistingFkConstraints(): Promise<Map<string, string[]>> {
    const rows = await this._exec().all<{
      constraint_name: string;
      column_name: string;
    }>(
      `SELECT kcu.constraint_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_name = $1 AND tc.table_schema = COALESCE($2, 'public')
         AND tc.constraint_type = 'FOREIGN KEY'`,
      [this._table.tableName, this._schema],
    );
    const byName = new Map<string, string[]>();
    for (const row of rows) {
      let cols = byName.get(row.constraint_name);
      if (!cols) {
        cols = [];
        byName.set(row.constraint_name, cols);
      }
      cols.push(row.column_name);
    }
    return byName;
  }

  // ── Fulltext search ───────────────────────────────────────────────────────

  override getSearchIndexes(): TSearchIndexInfo[] {
    const indexes: TSearchIndexInfo[] = [];
    for (const index of this._table.indexes.values()) {
      if (index.type === "fulltext") {
        indexes.push({
          name: index.key,
          description: `GIN tsvector index on ${index.fields.map((f) => f.name).join(", ")}`,
          type: "text",
        });
      }
    }
    // Add vector indexes
    for (const [field, vec] of this._vectorFields) {
      indexes.push({
        name: vec.indexName,
        description: `vector(${vec.dimensions}) on ${field}, ${vec.similarity}`,
        type: "vector",
      });
    }
    return indexes;
  }

  override async search(
    text: string,
    query: DbQuery,
    indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (!text.trim()) {
      return [];
    }
    const combinedWhere = this._buildSearchWhere(text, query, indexName);
    const { sql, params } = buildSelect(this.resolveTableName(), combinedWhere, query.controls);
    this._log(sql, params);
    return this._exec().all(sql, params);
  }

  override async searchWithCount(
    text: string,
    query: DbQuery,
    indexName?: string,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    if (!text.trim()) {
      return { data: [], count: 0 };
    }
    const combinedWhere = this._buildSearchWhere(text, query, indexName);
    const tableName = this.resolveTableName();

    const selectPromise = (async () => {
      const { sql, params } = buildSelect(tableName, combinedWhere, query.controls);
      this._log(sql, params);
      return this._exec().all(sql, params);
    })();

    const countPromise = (async () => {
      const raw = {
        sql: `SELECT COUNT(*) as cnt FROM ${quoteTableName(tableName)} WHERE ${combinedWhere.sql}`,
        params: combinedWhere.params,
      };
      const { sql, params } = finalizeParams(pgDialect, raw);
      this._log(sql, params);
      const row = await this._exec().get<{ cnt: number | string }>(sql, params);
      return parseCount(row?.cnt);
    })();

    const [data, count] = await Promise.all([selectPromise, countPromise]);
    return { data, count };
  }

  private _buildSearchWhere(
    text: string,
    query: DbQuery,
    indexName?: string,
  ): { sql: string; params: unknown[] } {
    const fulltextIndex = this._getFulltextIndex(indexName);
    if (!fulltextIndex) {
      throw new Error("No fulltext index found for search");
    }
    const tsvectorExpr = this._buildTsvectorExpr(fulltextIndex.fields);
    const where = buildWhere(query.filter);
    const tsqueryClause = `to_tsvector('english', ${tsvectorExpr}) @@ plainto_tsquery('english', ?)`;
    return {
      sql: where.sql === "1=1" ? tsqueryClause : `${where.sql} AND ${tsqueryClause}`,
      params: [...where.params, text],
    };
  }

  /** Builds the tsvector SQL expression for a fulltext index's fields. Must match between index DDL and queries. */
  private _buildTsvectorExpr(fields: TDbIndex["fields"]): string {
    return fields.map((f) => `coalesce(${qi(f.name)}, '')`).join(" || ' ' || ");
  }

  private _getFulltextIndex(indexName?: string): TDbIndex | undefined {
    for (const index of this._table.indexes.values()) {
      if (index.type === "fulltext") {
        if (!indexName || index.key === indexName) {
          return index;
        }
      }
    }
    return undefined;
  }

  // ── Vector search ──────────────────────────────────────────────────────

  /**
   * Detects pgvector support by attempting to enable the extension.
   * Idempotent — safe to call multiple times.
   */
  private async _detectVectorSupport(): Promise<boolean> {
    if (this._supportsVector !== undefined) {
      return this._supportsVector;
    }
    try {
      await this._exec().exec("CREATE EXTENSION IF NOT EXISTS vector");
      this._supportsVector = true;
    } catch {
      this._supportsVector = false;
    }
    return this._supportsVector;
  }

  override isVectorSearchable(): boolean {
    return this._supportsVector === true && this._vectorFields.size > 0;
  }

  override async vectorSearch(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    await this._detectVectorSupport();
    if (!this._supportsVector) {
      throw new Error("Vector search requires the pgvector extension");
    }
    const { sql, params } = this._buildVectorSearchQuery(vector, query, indexName);
    this._log(sql, params);
    return this._exec().all(sql, params);
  }

  override async vectorSearchWithCount(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    await this._detectVectorSupport();
    if (!this._supportsVector) {
      throw new Error("Vector search requires the pgvector extension");
    }
    const { sql, params } = this._buildVectorSearchQuery(vector, query, indexName);
    const { sql: countSql, params: countParams } = this._buildVectorSearchCountQuery(
      vector,
      query,
      indexName,
    );
    this._log(sql, params);
    this._log(countSql, countParams);
    const [data, countRow] = await Promise.all([
      this._exec().all(sql, params),
      this._exec().get<{ cnt: number | string }>(countSql, countParams),
    ]);
    const count = parseCount(countRow?.cnt);
    return { data, count };
  }

  /** Resolves vector field and computes shared context for vector search SQL builders. */
  private _prepareVectorSearch(vector: number[], query: DbQuery, indexName?: string) {
    let field!: string;
    let vec!: { dimensions: number; similarity: string; indexName: string };
    if (indexName) {
      let found = false;
      for (const [f, v] of this._vectorFields) {
        if (v.indexName === indexName) {
          field = f;
          vec = v;
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(`Vector index "${indexName}" not found`);
      }
    } else {
      const first = this._vectorFields.entries().next();
      if (first.done) {
        throw new Error("No vector fields defined");
      }
      field = first.value[0];
      vec = first.value[1];
    }
    const distanceOp = similarityToPgOp(vec.similarity);
    const where = buildWhere(query.filter);
    const controls = query.controls || {};
    const threshold = this._resolveVectorThreshold(
      controls as Record<string, unknown>,
      vec.indexName,
    );
    return {
      field,
      vec,
      distanceOp,
      where,
      controls,
      threshold,
      tableName: this.resolveTableName(),
      vectorStr: vectorToString(vector),
    };
  }

  private _buildVectorSearchQuery(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): { sql: string; params: unknown[] } {
    const ctx = this._prepareVectorSearch(vector, query, indexName);

    // Subquery computes distance once per row, then filter/sort on the alias
    let inner = `SELECT *, (${qi(ctx.field)} ${ctx.distanceOp} $1::vector) AS _distance FROM ${quoteTableName(ctx.tableName)} WHERE ${offsetPlaceholders(finalizeParams(pgDialect, ctx.where), 1).sql}`;
    const params: unknown[] = [ctx.vectorStr, ...ctx.where.params];

    let sql = `SELECT * FROM (${inner}) _v`;
    if (ctx.threshold !== undefined) {
      sql += ` WHERE _distance <= $${params.length + 1}`;
      params.push(thresholdToDistance(ctx.threshold, ctx.vec.similarity));
    }
    sql += ` ORDER BY _distance ASC`;
    if (ctx.controls.$skip) {
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(ctx.controls.$limit || 1000, ctx.controls.$skip);
    } else {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(ctx.controls.$limit || 20);
    }

    return { sql, params };
  }

  private _buildVectorSearchCountQuery(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): { sql: string; params: unknown[] } {
    const ctx = this._prepareVectorSearch(vector, query, indexName);

    let inner = `SELECT (${qi(ctx.field)} ${ctx.distanceOp} $1::vector) AS _distance FROM ${quoteTableName(ctx.tableName)} WHERE ${offsetPlaceholders(finalizeParams(pgDialect, ctx.where), 1).sql}`;
    const params: unknown[] = [ctx.vectorStr, ...ctx.where.params];

    let sql = `SELECT COUNT(*) AS cnt FROM (${inner}) _v`;
    if (ctx.threshold !== undefined) {
      sql += ` WHERE _distance <= $${params.length + 1}`;
      params.push(thresholdToDistance(ctx.threshold, ctx.vec.similarity));
    }

    return { sql, params };
  }

  /** Resolves threshold: query-time $threshold > schema-level @db.search.vector.threshold. */
  private _resolveVectorThreshold(
    controls: Record<string, unknown>,
    indexName: string,
  ): number | undefined {
    const queryThreshold = controls.$threshold as number | undefined;
    if (queryThreshold !== undefined) {
      return queryThreshold;
    }
    return this._vectorThresholds.get(indexName);
  }
}

/**
 * Normalizes PostgreSQL information_schema data_type values
 * to match the format produced by `pgTypeFromField()`.
 */
function normalizePgType(
  dataType: string,
  maxLength: number | null,
  numericPrecision: number | null,
  numericScale: number | null,
  udtName: string,
  formattedType: string,
): string {
  const dt = dataType.toLowerCase();
  switch (dt) {
    case "character varying":
      return maxLength ? `VARCHAR(${maxLength})` : "VARCHAR(255)";
    case "character":
      return maxLength ? `CHAR(${maxLength})` : "CHAR(1)";
    case "integer":
      return "INTEGER";
    case "smallint":
      return "SMALLINT";
    case "bigint":
      return "BIGINT";
    case "double precision":
      return "DOUBLE PRECISION";
    case "numeric":
      return numericPrecision != null && numericScale != null
        ? `NUMERIC(${numericPrecision},${numericScale})`
        : "NUMERIC";
    case "boolean":
      return "BOOLEAN";
    case "text":
      return "TEXT";
    case "jsonb":
      return "JSONB";
    case "json":
      return "JSON";
    case "timestamp with time zone":
      return "TIMESTAMPTZ";
    case "timestamp without time zone":
      return "TIMESTAMP";
    case "uuid":
      return "UUID";
    case "user-defined": {
      // Use format_type() output for extension types (e.g., pgvector: "vector(128)")
      if (udtName === "vector") {
        return formattedType;
      }
      // CITEXT extension for @db.collate 'nocase'
      if (udtName === "citext") {
        return "CITEXT";
      }
      return udtName?.toUpperCase() ?? "USER-DEFINED";
    }
    default:
      return dataType.toUpperCase();
  }
}

/**
 * Normalizes PostgreSQL column_default values to match the format
 * produced by `serializeDefaultValue()`.
 */
function normalizePgDefault(value: string | null, isIdentity: string): string | undefined {
  if (isIdentity === "YES") {
    return "fn:increment";
  }
  if (value === null) {
    return undefined;
  }

  // Strip outer parentheses — PG sometimes wraps defaults: ('now'::text)::timestamptz
  let cleaned = value;
  while (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    cleaned = cleaned.slice(1, -1);
  }

  const lower = cleaned.toLowerCase();
  // Boolean round-trip: PG stores defaults as 'true'/'false', but the schema diff
  // engine compares against serialized form '1'/'0' (from serializeDefaultValue).
  // The DDL side (defaultValueToSqlLiteral) converts '1'→'true', '0'→'false' for PG.
  if (lower === "true") {
    return "1";
  }
  if (lower === "false") {
    return "0";
  }
  // DEFAULT CURRENT_TIMESTAMP / now() / epoch ms expression
  if (
    lower === "current_timestamp" ||
    lower === "now()" ||
    lower.startsWith("current_timestamp::") ||
    lower.startsWith("now()::")
  ) {
    return "fn:now";
  }
  // (extract(epoch from now()) * 1000)::bigint — epoch ms default for BIGINT timestamp columns
  if (lower.includes("extract") && lower.includes("epoch") && lower.includes("now()")) {
    return "fn:now";
  }
  // DEFAULT gen_random_uuid()
  if (lower === "gen_random_uuid()") {
    return "fn:uuid";
  }
  // nextval('sequence_name'::regclass) — auto-generated sequence for SERIAL
  if (lower.startsWith("nextval(")) {
    return "fn:increment";
  }
  // Strip ::type casts (e.g., 'value'::character varying → 'value')
  const castMatch = cleaned.match(/^'(.*)'::[\w\s]+$/);
  if (castMatch) {
    return castMatch[1].replace(/''/g, "'");
  }
  // Strip enclosing single quotes
  if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
    return cleaned.slice(1, -1).replace(/''/g, "'");
  }
  return cleaned;
}

/**
 * Converts a normalized similarity threshold (0-1) to a pgvector max distance.
 *
 * The threshold is a normalized score matching MongoDB Atlas semantics:
 *   cosine score = (1 + cosine_similarity) / 2, range [0, 1]
 * pgvector cosine distance = 1 - cosine_similarity, range [0, 2]
 *
 * Conversion: distance = 2 * (1 - score)
 */
function thresholdToDistance(threshold: number, similarity: string): number {
  switch (similarity) {
    case "euclidean":
      return threshold; // user provides max distance directly
    case "dotProduct":
      return -threshold; // pgvector uses negative inner product
    default:
      return 2 * (1 - threshold); // cosine: score → pgvector distance
  }
}

/** Maps generic similarity metric to PostgreSQL distance operator. */
function similarityToPgOp(similarity: string): string {
  switch (similarity) {
    case "euclidean":
      return "<->";
    case "dotProduct":
      return "<#>";
    default:
      return "<=>"; // cosine
  }
}

/** Maps generic similarity metric to pgvector index ops class. */
function similarityToPgOps(similarity: string): string {
  switch (similarity) {
    case "euclidean":
      return "vector_l2_ops";
    case "dotProduct":
      return "vector_ip_ops";
    default:
      return "vector_cosine_ops";
  }
}

/** Formats a number[] vector as pgvector input: '[1.0, 2.0, ...]'. */
function vectorToString(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
