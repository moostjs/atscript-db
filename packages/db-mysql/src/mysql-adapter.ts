import type { TAtscriptAnnotatedType, TMetadataMap } from "@atscript/typescript/utils";
import {
  ALL_AGGREGATE_FNS,
  ALL_VIEW_CAPABILITIES,
  ALL_BUCKET_UNITS,
  BaseDbAdapter,
  DbError,
  isConflict,
  NoopLogger,
  uniqueKeyTuple,
  bucketTimeZoneUnavailable,
  containsRelationFilter,
  forEachResolvedRelation,
  vectorIndexNotFoundMessage,
  fkColumns,
} from "@atscript/db";
import type {
  AtscriptDbView,
  TDbDeleteResult,
  TDbIndex,
  TDbInsertManyResult,
  TDbInsertIgnoreSlot,
  TDbInsertResult,
  TDbUpdateResult,
  TExistingColumn,
  TExistingTableOption,
  TColumnDiff,
  TTableOptionDiff,
  TSyncColumnResult,
  TDbFieldMeta,
  TDbDefaultFn,
  TDbObjectKind,
  TEnsureTableOptions,
  TPrimaryKeyChange,
  TReferencingForeignKey,
  TValueFormatterPair,
  TFieldOps,
} from "@atscript/db";
import type {
  AggregateFn,
  BucketUnit,
  DbQuery,
  FilterExpr,
  TSearchIndexInfo,
  TViewCapability,
} from "@atscript/db";
import { resolveAggregateSearch } from "@atscript/db/agg";
import {
  buildGeoSearchCount,
  buildPartitionedSelect,
  stripPartitionRowNumber,
  buildGeoSearchSelect,
  buildVectorSearchCount,
  buildVectorSearchSelect,
  vectorDistanceSource,
  type TGeoSearchControls,
  type TSqlFragment,
  fillReplacePayload,
  geoWindowFromControls,
  chunkInsertRows,
  normalizeGeoPointValue,
  renameGeoDistance,
  replaceColumnsFor,
  foreignKeySql,
  SEARCH_SOURCE_ALIAS,
  mapQueryErrors,
} from "@atscript/db-sql-tools";

import { buildWhere } from "./filter-builder";
import {
  buildColumnDefinition,
  buildCreateTable,
  buildCreateView,
  buildDelete,
  buildInsert,
  buildInsertMany,
  buildSelect,
  buildUpdate,
  buildAggregateSelect,
  buildAggregateCount,
  defaultValueForType,
  defaultValueToSqlLiteral,
  geoPointToMysqlInternal,
  isMysqlTimestampColumn,
  mysqlBytesPerChar,
  mysqlCharLength,
  mysqlDefaultLiteral,
  mysqlGeoDistanceExpr,
  mysqlGeoValueToPoint,
  mysqlIndexPrefix,
  mysqlTypeDefault,
  mysqlTypeFromField,
  qi,
  quoteTableName,
  mysqlDialect,
  type TMysqlColumnContext,
  type TMysqlTableOptions,
} from "./sql-builder";
import type { TMysqlConnection, TMysqlDriver } from "./types";

/** Parses a MySQL UTC datetime string ('YYYY-MM-DD HH:MM:SS') to epoch ms. Returns the original value if parsing fails. */
export function utcDatetimeToEpochMs(value: unknown): unknown {
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string") {
    const ms = Date.UTC(
      +value.slice(0, 4),
      +value.slice(5, 7) - 1,
      +value.slice(8, 10),
      +value.slice(11, 13),
      +value.slice(14, 16),
      +value.slice(17, 19),
    );
    return Number.isNaN(ms) ? value : ms;
  }
  return value;
}

/** Formats epoch ms as 'YYYY-MM-DD HH:MM:SS' in UTC for MySQL TIMESTAMP columns. */
function epochMsToUtcDatetime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

// ── Calendar-bucket time zone probe ──────────────────────────────────────────

/**
 * One statement answers both questions `CONVERT_TZ` never raises an error
 * for: `missing` — the named zone (bound as `?`) converts to NULL, i.e. the
 * time zone tables are not loaded or lack it; `shift` — a fixed `+01:00`
 * conversion after 2038 is not applied (0 instead of 60 minutes), i.e. the
 * server's `CONVERT_TZ` range ends in 2038 (before 8.0.28, or 32-bit).
 *
 * The range half deliberately uses a fixed offset, not the named zone: MySQL
 * tz tables hold no transitions after 2037, so a zone such as `Europe/London`
 * legitimately converts to +00:00 in June 2040 on a current server — an
 * "unchanged" named-zone result is not evidence of a limited range.
 */
const TZ_PROBE_SQL =
  "SELECT CONVERT_TZ('2040-06-01 12:00:00', '+00:00', ?) IS NULL AS missing, " +
  "TIMESTAMPDIFF(MINUTE, '2040-06-01 12:00:00', CONVERT_TZ('2040-06-01 12:00:00', '+00:00', '+01:00')) AS shift";

/**
 * Zones `CONVERT_TZ` is known to handle, per driver (adapters are per table
 * and share a driver). Positives only: a failed zone is probed again, so
 * loading the time zone tables fixes a running server without a restart.
 */
const isZero = (v: unknown) => v === 0 || v === "0";

/** The `sql_mode` text of a `SELECT @@SESSION.sql_mode AS mode` row. */
const modeText = (row: { mode: unknown } | null | undefined): string =>
  typeof row?.mode === "string" ? row.mode : "";

const nonStrictChecked = new WeakSet<TMysqlDriver>();

const convertibleZones = new WeakMap<TMysqlDriver, Set<string>>();

/**
 * The session's `@@auto_increment_increment`, read lazily (only when a
 * multi-row statement of generated ids needs it) and at most once per call —
 * it is per connection / session, and a transaction keeps one connection.
 */
type TIncrementStep = () => Promise<number>;

/**
 * Whether the session `sql_mode` has `NO_AUTO_VALUE_ON_ZERO` (an explicit 0 PK
 * is then a value, not a request for a generated id), read lazily — only when a
 * row carries a 0 / "0" PK — and at most once per call, on the call's connection.
 */
type TZeroIsExplicit = () => Promise<boolean>;

/** A run of consecutive rows of one chunk sharing an id kind (all explicit or all generated), with their input positions. */
interface TIdGroup {
  rows: Array<Record<string, unknown>>;
  at: number[];
  generated: boolean;
}

/**
 * MySQL adapter for {@link AtscriptDbTable}.
 *
 * Accepts any {@link TMysqlDriver} implementation — the actual MySQL driver
 * is fully swappable (mysql2/promise pool, custom implementations, etc.).
 *
 * Usage:
 * ```typescript
 * import { Mysql2Driver, MysqlAdapter } from '@atscript/db-mysql'
 * import { DbSpace } from '@atscript/db'
 *
 * const driver = new Mysql2Driver('mysql://root@localhost:3306/mydb')
 * const space = new DbSpace(() => new MysqlAdapter(driver))
 * const users = space.getTable(UsersType)
 * ```
 */
export class MysqlAdapter extends BaseDbAdapter {
  override supportsColumnModify = true;

  // 'uuid' is intentionally excluded: MySQL's DEFAULT (UUID()) generates the value
  // server-side, but the insertId in the result header is always 0 for non-AUTO_INCREMENT
  // columns, making it impossible to retrieve the generated UUID without a separate SELECT.
  // Client-side generation via crypto.randomUUID() avoids this round-trip.
  private static readonly NATIVE_DEFAULT_FNS: ReadonlySet<TDbDefaultFn> = new Set([
    "now",
    "increment",
  ]);

  // ── MySQL-specific state from annotations ────────────────────────────────
  private _engine = "InnoDB";
  private _charset = "utf8mb4";
  private _collation = "utf8mb4_unicode_ci";
  private _autoIncrementStart?: number;
  private _incrementFields = new Set<string>();
  private _onUpdateFields = new Map<string, string>();

  // ── Vector search state ─────────────────────────────────────────────────
  /** Whether the connected MySQL instance supports native VECTOR type (MySQL 9.0+). */
  private _supportsVector: boolean | undefined;
  /** Vector fields: physical field name → { dimensions, similarity, indexName }. */
  private _vectorFields = new Map<
    string,
    { dimensions: number; similarity: string; indexName: string }
  >();
  /** Default similarity thresholds per vector field (from @db.search.vector.threshold). */
  private _vectorThresholds = new Map<string, number>();

  /**
   * Schema name for INFORMATION_SCHEMA queries — `@db.schema` of the bound
   * table, or `null` (→ `DATABASE()`, the pool's database) when the table
   * declares none or the adapter is an administrative one with no readable
   * (the name-taking schema-sync primitives run on such an adapter).
   */
  private get _schema(): string | null {
    return this._table?.schema ?? null;
  }

  constructor(protected readonly driver: TMysqlDriver) {
    super();
  }

  // ── Transaction primitives ──────────────────────────────────────────────

  /** Every adapter over this pool shares one transaction (since 0.1.128). */
  protected override _transactionOwner(): unknown {
    return this.driver;
  }

  /** The dedicated connection of this pool's open transaction, if any. */
  private _txConnection(): TMysqlConnection | undefined {
    return this._getTransactionState() as TMysqlConnection | undefined;
  }

  protected override async _beginTransaction(): Promise<TMysqlConnection> {
    const conn = await this.driver.getConnection();
    await conn.exec("START TRANSACTION");
    this._log("START TRANSACTION");
    return conn;
  }

  protected override async _commitTransaction(state: unknown): Promise<void> {
    const conn = state as TMysqlConnection;
    try {
      this._log("COMMIT");
      await conn.exec("COMMIT");
    } finally {
      conn.release();
    }
  }

  protected override async _rollbackTransaction(state: unknown): Promise<void> {
    const conn = state as TMysqlConnection;
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
  private _exec(): Pick<TMysqlDriver, "run" | "all" | "get" | "exec"> {
    return this._txConnection() ?? this.driver;
  }

  /**
   * Runs `fn` on one connection (the transaction's, or a dedicated one) with
   * `STRICT_ALL_TABLES` added to the session `sql_mode`, restoring the
   * previous mode after. Schema sync's converting statements (`MODIFY
   * COLUMN`, the recreate copy) then fail on a value that does not convert
   * instead of coercing or truncating it — a non-strict server (RDS defaults
   * to `NO_ENGINE_SUBSTITUTION`) would turn `'abc'` into `0` silently.
   */
  private async _withStrictSession<T>(fn: (conn: TMysqlConnection) => Promise<T>): Promise<T> {
    const tx = this._txConnection();
    const conn = tx ?? (await this.driver.getConnection());
    try {
      await conn.exec(
        "SET @atscript_sql_mode = @@SESSION.sql_mode, SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'STRICT_ALL_TABLES')",
      );
      try {
        return await fn(conn);
      } finally {
        await conn.exec("SET SESSION sql_mode = @atscript_sql_mode");
      }
    } finally {
      if (!tx) {
        conn.release();
      }
    }
  }

  // ── Capability flags ──────────────────────────────────────────────────────

  /**
   * Relational predicates (`$some` / `$none`) render as correlated
   * `[NOT] EXISTS` subqueries — in reads and in mutation filters alike.
   * An UPDATE / DELETE whose predicate reads the mutated table itself is
   * rewritten through a materialized derived table (MySQL error 1093).
   *
   * @since 0.1.147
   */
  override supportsRelationFilters(_mode: "read" | "write"): boolean {
    return true;
  }

  /** MySQL InnoDB enforces FK constraints natively. */
  override supportsNativeForeignKeys(): boolean {
    return true;
  }

  // ── ID preparation ────────────────────────────────────────────────────────

  override prepareId(id: unknown, _fieldType: unknown): unknown {
    return id;
  }

  override supportsNativeValueDefaults(): boolean {
    return true;
  }

  override nativeDefaultFns(): ReadonlySet<TDbDefaultFn> {
    return MysqlAdapter.NATIVE_DEFAULT_FNS;
  }

  /**
   * Every unit: `mysqlCalendarBucket` renders them all; named zones need the
   * server's time zone tables (probed per zone in `aggregate()`).
   */
  override calendarBucketUnits(): ReadonlySet<BucketUnit> {
    return ALL_BUCKET_UNITS;
  }

  /** Every aggregate function: `countDistinct`, `first` and `last` included. */
  override aggregateFns(): ReadonlySet<AggregateFn> {
    return ALL_AGGREGATE_FNS;
  }

  /** Arithmetic in an aggregate `$select` (`{ $expr }`, `{ $fn, $expr }`). */
  override supportsAggregateExpressions(): boolean {
    return true;
  }

  /** Computed view columns and first-row joins. */
  override viewCapabilities(): ReadonlySet<TViewCapability> {
    return ALL_VIEW_CAPABILITIES;
  }

  // ── Annotation hooks ──────────────────────────────────────────────────────

  override onBeforeFlatten(_type: unknown): void {
    const type = _type as TAtscriptAnnotatedType;
    const meta = type.metadata;
    const engine = meta.get("db.mysql.engine") as string | undefined;
    if (engine) {
      this._engine = engine;
    }
    const charset = meta.get("db.mysql.charset") as string | undefined;
    if (charset) {
      this._charset = charset;
    }
    const collate = meta.get("db.mysql.collate") as string | undefined;
    if (collate) {
      this._collation = collate;
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
    // Track @db.mysql.onUpdate fields
    const onUpdate = metadata.get("db.mysql.onUpdate") as string | undefined;
    if (onUpdate) {
      this._onUpdateFields.set(field, onUpdate);
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
    // @db.search.filter — pre-filter field for vector index
    // Note: filter field metadata is stored but not yet used in SQL generation.
    // Future: use to add indexed WHERE clauses to vector search queries.
  }

  // ── Table options ────────────────────────────────────────────────────────

  override getDesiredTableOptions(): TExistingTableOption[] {
    return [
      { key: "engine", value: this._engine },
      { key: "charset", value: this._charset },
      { key: "collation", value: this._collation },
    ];
  }

  override async getExistingTableOptions(tableName?: string): Promise<TExistingTableOption[]> {
    const row = await this._exec().get<{
      ENGINE: string;
      TABLE_COLLATION: string;
    }>(
      `SELECT ENGINE, TABLE_COLLATION
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_NAME = ? AND TABLE_SCHEMA = COALESCE(?, DATABASE())`,
      [tableName ?? this._table.tableName, this._schema],
    );
    if (!row) {
      return [];
    }

    // Extract charset from collation (e.g., utf8mb4_unicode_ci → utf8mb4)
    const charset = row.TABLE_COLLATION?.split("_")[0] ?? "utf8mb4";

    return [
      { key: "engine", value: row.ENGINE ?? "InnoDB" },
      { key: "charset", value: charset },
      { key: "collation", value: row.TABLE_COLLATION ?? "utf8mb4_unicode_ci" },
    ];
  }

  override async applyTableOptions(changes: TTableOptionDiff["changed"]): Promise<void> {
    const tableName = this.resolveTableName();
    const clauses: string[] = [];

    for (const change of changes) {
      switch (change.key) {
        case "engine": {
          clauses.push(`ENGINE = ${change.newValue}`);
          break;
        }
        case "charset": {
          clauses.push(`CHARACTER SET = ${change.newValue}`);
          break;
        }
        case "collation": {
          clauses.push(`COLLATE = ${change.newValue}`);
          break;
        }
      }
    }

    if (clauses.length > 0) {
      const ddl = `ALTER TABLE ${quoteTableName(tableName)} ${clauses.join(", ")}`;
      this._log(ddl);
      await this._exec().exec(ddl);
    }
  }

  /**
   * Returns a value formatter for TIMESTAMP-mapped fields.
   * Number fields with @db.default.now map to MySQL TIMESTAMP — the formatter
   * converts epoch ms to a UTC datetime string for the wire protocol.
   */
  override formatValue(
    field: TDbFieldMeta,
  ): TValueFormatterPair | ((value: unknown) => unknown) | undefined {
    if (isMysqlTimestampColumn(field)) {
      return {
        toStorage: (value: unknown) =>
          typeof value === "number" ? epochMsToUtcDatetime(value) : value,
        fromStorage: utcDatetimeToEpochMs,
      };
    }
    // geoPoint ↔ POINT SRID 4326: internal-format binary in, `{x, y}` out.
    // Non-point shapes (e.g. `$geoWithin` circle objects) pass through.
    if (field.isGeoPoint && !field.encrypted) {
      return {
        toStorage: (value: unknown) => {
          const point = normalizeGeoPointValue(value);
          return point ? geoPointToMysqlInternal(point) : value;
        },
        fromStorage: (value: unknown) => mysqlGeoValueToPoint(value) ?? value,
      };
    }
    return undefined;
  }

  // ── Error mapping ─────────────────────────────────────────────────────────

  /**
   * Wraps an async write operation to catch MySQL constraint errors
   * and rethrow as structured `DbError`.
   *
   * MySQL uses numeric error codes:
   * - 1062 = ER_DUP_ENTRY (unique constraint violation)
   * - 1586 = ER_DUP_ENTRY_WITH_KEY_NAME (same, for a multi-row INSERT)
   * - 1451 = ER_ROW_IS_REFERENCED_2 (FK violation on delete)
   * - 1452 = ER_NO_REFERENCED_ROW_2 (FK violation on insert/update)
   */
  private async _wrapConstraintError<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error: unknown) {
      return this._mapConstraintError(error);
    }
  }

  /** Rethrows `error` as a structured `DbError` when it is a unique / FK violation, else as is. */
  private _mapConstraintError(error: unknown): never {
    if (error && typeof error === "object" && "errno" in error) {
      const err = error as { errno: number; message: string; sqlMessage?: string };

      // Duplicate key (unique constraint)
      if (err.errno === 1062 || err.errno === 1586) {
        const match = err.message?.match(/for key '(?:\w+\.)?(\w+)'/);
        const field = match?.[1] ?? "";
        throw new DbError("CONFLICT", [{ path: field, message: err.sqlMessage ?? err.message }]);
      }

      // FK violation
      if (err.errno === 1451 || err.errno === 1452) {
        const errors = this._mapFkError(err.message);
        throw new DbError("FK_VIOLATION", errors);
      }
    }
    throw error;
  }

  private _mapFkError(message: string): Array<{ path: string; message: string }> {
    const fkMatch = message.match(/FOREIGN KEY \(`(\w+)`\)/);
    if (fkMatch) {
      const physicalCol = fkMatch[1];
      const field = this._table.fieldDescriptors.find((f) => f.physicalName === physicalCol);
      return [{ path: field?.path ?? physicalCol, message }];
    }
    return [{ path: "", message }];
  }

  // ── CRUD: Insert ──────────────────────────────────────────────────────────

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    const { sql, params } = buildInsert(this.resolveTableName(), data);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { insertedId: this._resolveInsertedId(data, result.insertId) };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    if (data.length === 0) {
      return { insertedCount: 0, insertedIds: [] };
    }

    return this.withTransaction(async () => {
      const tableName = this.resolveTableName();

      // Batch rows into multi-row INSERT statements over the column union of
      // ALL rows, to reduce round-trips; chunked to stay under max packet size.
      const { columns, batches } = chunkInsertRows(data);
      const allIds: unknown[] = [];
      const step = this._incrementStep();
      const zero = this._zeroIsExplicit();

      for (const batch of batches) {
        const ids: unknown[] = Array.from({ length: batch.length });
        for (const group of await this._idGroups(batch, zero)) {
          const { sql, params } = buildInsertMany(tableName, group.rows, columns);
          this._log(sql, params);
          const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
          (await this._groupInsertedIds(group, result.insertId, step)).forEach((id, k) => {
            ids[group.at[k]!] = id;
          });
        }
        allIds.push(...ids);
      }

      return { insertedCount: allIds.length, insertedIds: allIds };
    });
  }

  /** Physical column of the single-column AUTO_INCREMENT primary key, if the table has one. */
  private _autoIncrementPk(): string | undefined {
    const pks = this._table.primaryKeys;
    if (pks.length !== 1 || !this._incrementFields.has(pks[0]!)) return undefined;
    return this._table.getMetadata().physicalPath(pks[0]!);
  }

  /**
   * Splits `rows` into runs that each map to ONE statement with a derivable
   * id sequence. MySQL reports only the first GENERATED id of a statement, and
   * an explicit auto-increment value above the counter bumps the counter, so a
   * statement mixing explicit and generated PKs cannot be mapped by
   * `insertId + i * step`: the chunk is cut into CONSECUTIVE runs of one kind,
   * executed in input order (so "an earlier row wins" a unique collision, even
   * under a case-insensitive collation). A table without an AUTO_INCREMENT PK,
   * or a chunk of one kind, stays one group.
   */
  private async _idGroups(
    rows: Array<Record<string, unknown>>,
    zeroIsExplicit: TZeroIsExplicit,
  ): Promise<TIdGroup[]> {
    const col = this._autoIncrementPk();
    if (!col) return [{ rows, at: rows.map((_, i) => i), generated: false }];
    const zeroExplicit = rows.some((r) => isZero(r[col])) && (await zeroIsExplicit());
    const groups: TIdGroup[] = [];
    rows.forEach((row, i) => {
      const v = row[col];
      const generated = v === undefined || v === null || (isZero(v) && !zeroExplicit);
      let last = groups.at(-1);
      if (!last || last.generated !== generated) {
        last = { rows: [], at: [], generated };
        groups.push(last);
      }
      last.rows.push(row);
      last.at.push(i);
    });
    return groups;
  }

  /** The {@link TZeroIsExplicit} of one `insertMany` / `insertManyIgnore` call. */
  private _zeroIsExplicit(): TZeroIsExplicit {
    let mode: Promise<boolean> | undefined;
    return () =>
      (mode ??= (async () => {
        const row = await this._exec().get<{ mode: unknown }>(
          "SELECT @@SESSION.sql_mode AS mode",
          [],
        );
        return modeText(row).includes("NO_AUTO_VALUE_ON_ZERO");
      })());
  }

  /**
   * Warns ONCE per driver when the session `sql_mode` is not strict: writes
   * (insert-ignore included) assume `STRICT_TRANS_TABLES` / `STRICT_ALL_TABLES`
   * (the MySQL 8 default); a non-strict mode coerces a NOT NULL violation to the
   * column default instead of failing. Only probes when the adapter has a logger.
   */
  private async _warnNonStrictMode(): Promise<void> {
    if (this.logger === NoopLogger || nonStrictChecked.has(this.driver)) return;
    nonStrictChecked.add(this.driver);
    try {
      const row = await this._exec().get<{ mode: unknown }>(
        "SELECT @@SESSION.sql_mode AS mode",
        [],
      );
      if (row && !/STRICT_(TRANS|ALL)_TABLES/.test(modeText(row))) {
        this.logger.warn(
          `MySQL session sql_mode lacks STRICT_TRANS_TABLES / STRICT_ALL_TABLES (${modeText(row)}): writes assume a strict mode and a non-strict server silently coerces NOT NULL violations`,
        );
      }
    } catch {
      nonStrictChecked.delete(this.driver);
    }
  }

  /** The {@link TIncrementStep} of one `insertMany` / `insertManyIgnore` call. */
  private _incrementStep(): TIncrementStep {
    let step: Promise<number> | undefined;
    return () =>
      (step ??= (async () => {
        const row = await this._exec().get<{ step: unknown }>(
          "SELECT @@auto_increment_increment AS step",
          [],
        );
        const n = Number(row?.step);
        return Number.isInteger(n) && n > 0 ? n : 1;
      })());
  }

  /**
   * Ids of the rows of ONE successful multi-row INSERT of a homogeneous
   * {@link _idGroups} group: generated rows get ids from `insertId` stepping by
   * the session's `@@auto_increment_increment` (consecutive within one
   * statement under `innodb_autoinc_lock_mode` 0 / 1, and — for a known row
   * count — mode 2, the 8.0 default), explicit rows keep their own value.
   */
  private async _groupInsertedIds(
    group: TIdGroup,
    insertId: unknown,
    step: TIncrementStep,
  ): Promise<unknown[]> {
    const first = Number(insertId);
    // one row has no stride: skip the read
    const stride = group.generated && group.rows.length > 1 && first > 0 ? await step() : 1;
    return group.rows.map((row, i) => {
      const generatedId = first > 0 ? first + i * stride : 0;
      return group.generated ? generatedId : this._resolveInsertedId(row, generatedId);
    });
  }

  override supportsInsertIgnore(): boolean {
    return true;
  }

  /**
   * Per chunk: ONE optimistic multi-row INSERT (an all-new batch costs a single
   * statement). Only when it hits a duplicate key (errno 1062 / 1586) does ONE
   * SELECT of the chunk's primary / unique key tuples find the stored rows
   * (skipped as conflicts) and the survivors go in as one more multi-row
   * INSERT — a dense-duplicate chunk is three statements, never O(rows). Only
   * if that INSERT still collides (a concurrent writer raced in, or a
   * collation-equal value the exact-match pre-check missed) are the survivors
   * bisected: each half is retried, recursively, and a single row that still
   * collides is skipped. A failed statement is rolled back by InnoDB alone, so
   * the transaction stays usable. A chunk mixing explicit and generated
   * auto-increment ids is processed as one such sequence per consecutive run of a kind. Deliberately
   * NOT `INSERT IGNORE` (it would downgrade NOT NULL / FK / truncation errors
   * to warnings) and not `ON DUPLICATE KEY UPDATE` (a no-op update is
   * indistinguishable from an insert in the affected-rows count).
   */
  override async insertManyIgnore(
    data: Array<Record<string, unknown>>,
  ): Promise<TDbInsertIgnoreSlot[]> {
    if (data.length === 0) return [];
    await this._warnNonStrictMode();
    return this.withTransaction(async () => {
      const tableName = this.resolveTableName();
      const { columns, batches } = chunkInsertRows(data);
      const slots: TDbInsertIgnoreSlot[] = [];
      const step = this._incrementStep();
      const zero = this._zeroIsExplicit();
      for (const batch of batches) {
        const out: TDbInsertIgnoreSlot[] = Array.from({ length: batch.length }, () => null);
        for (const group of await this._idGroups(batch, zero)) {
          const groupSlots = await this._insertIgnoringGroup(tableName, columns, group, step);
          groupSlots.forEach((slot, k) => {
            out[group.at[k]!] = slot;
          });
        }
        slots.push(...out);
      }
      return slots;
    });
  }

  /**
   * Indices of `rows` whose primary / unique-index key tuple is already stored
   * (a row with a null / missing key component never collides). One SELECT
   * covers every key set; it is split only to stay under the parameter limit.
   * Skipped entirely when no row carries a key value (generated PK, no unique
   * index values).
   */
  private async _findStoredKeyConflicts(
    tableName: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<Set<number>> {
    const keySets = this._table.uniqueKeySets.filter((f) => f.length > 0);
    const rowTuples = rows.map((row) => keySets.map((fields) => uniqueKeyTuple(row, fields)));
    const used = keySets.map((_, k) => rowTuples.some((t) => t[k] !== undefined));
    if (!used.includes(true)) return new Set();

    const width = keySets.reduce((n, f, k) => n + (used[k] ? f.length : 0), 0);
    const sliceSize = Math.max(1, Math.floor(60000 / width));
    const selectCols = [...new Set(keySets.flat())].map((c) => qi(c)).join(", ");
    const stored = keySets.map(() => new Set<string>());

    for (let offset = 0; offset < rows.length; offset += sliceSize) {
      const end = Math.min(rows.length, offset + sliceSize);
      const clauses: string[] = [];
      const params: unknown[] = [];
      keySets.forEach((fields, k) => {
        if (!used[k]) return;
        const group: Array<Record<string, unknown>> = [];
        for (let i = offset; i < end; i++) {
          if (rowTuples[i]![k] !== undefined) group.push(rows[i]!);
        }
        if (group.length === 0) return;
        const values = (row: Record<string, unknown>) =>
          fields.map((f) => mysqlDialect.toValue(row[f]));
        if (fields.length === 1) {
          clauses.push(`${qi(fields[0]!)} IN (${group.map(() => "?").join(", ")})`);
          for (const row of group) params.push(...values(row));
        } else {
          const tuple = `(${fields.map(() => "?").join(", ")})`;
          clauses.push(
            `(${fields.map((f) => qi(f)).join(", ")}) IN (${group.map(() => tuple).join(", ")})`,
          );
          for (const row of group) params.push(...values(row));
        }
      });
      if (clauses.length === 0) continue;
      const sql = `SELECT ${selectCols} FROM ${quoteTableName(tableName)} WHERE ${clauses.join(" OR ")}`;
      this._log(sql, params);
      const found = await this._exec().all(sql, params);
      for (const doc of found) {
        keySets.forEach((fields, k) => {
          const tuple = uniqueKeyTuple(doc, fields);
          if (tuple !== undefined) stored[k]!.add(tuple);
        });
      }
    }

    const skipped = new Set<number>();
    rowTuples.forEach((tuples, i) => {
      if (tuples.some((t, k) => t !== undefined && stored[k]!.has(t))) skipped.add(i);
    });
    return skipped;
  }

  /** Optimistic INSERT of a group, then pre-check + survivor INSERT (+ bisect on a race). */
  private async _insertIgnoringGroup(
    tableName: string,
    columns: string[],
    group: TIdGroup,
    step: TIncrementStep,
  ): Promise<TDbInsertIgnoreSlot[]> {
    const direct = await this._tryInsertGroup(tableName, columns, group, step);
    if (direct) return direct;
    if (group.rows.length === 1) return [null];

    const skipped = await this._findStoredKeyConflicts(tableName, group.rows);
    // Nothing known stored (a collation-equal value, or a race): bisect.
    if (skipped.size === 0) return this._bisectGroup(tableName, columns, group, step);

    const survivors: TIdGroup = {
      rows: group.rows.filter((_, i) => !skipped.has(i)),
      at: [],
      generated: group.generated,
    };
    const inserted =
      survivors.rows.length > 0
        ? ((await this._tryInsertGroup(tableName, columns, survivors, step)) ??
          (survivors.rows.length === 1
            ? [null]
            : await this._bisectGroup(tableName, columns, survivors, step)))
        : [];
    let next = 0;
    return group.rows.map((_, i) => (skipped.has(i) ? null : inserted[next++]!));
  }

  /** Retries the halves of a group whose one INSERT is known to collide; a lone colliding row is skipped. */
  private async _bisectGroup(
    tableName: string,
    columns: string[],
    group: TIdGroup,
    step: TIncrementStep,
  ): Promise<TDbInsertIgnoreSlot[]> {
    const mid = group.rows.length >> 1;
    const out: TDbInsertIgnoreSlot[] = [];
    for (const rows of [group.rows.slice(0, mid), group.rows.slice(mid)]) {
      const half: TIdGroup = { rows, at: [], generated: group.generated };
      out.push(
        ...((await this._tryInsertGroup(tableName, columns, half, step)) ??
          (rows.length === 1 ? [null] : await this._bisectGroup(tableName, columns, half, step))),
      );
    }
    return out;
  }

  /** ONE INSERT of a group's rows; `undefined` on a duplicate key (errno 1062 / 1586). */
  private async _tryInsertGroup(
    tableName: string,
    columns: string[],
    group: TIdGroup,
    step: TIncrementStep,
  ): Promise<TDbInsertIgnoreSlot[] | undefined> {
    const { sql, params } = buildInsertMany(tableName, group.rows, columns);
    this._log(sql, params);
    try {
      const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
      return (await this._groupInsertedIds(group, result.insertId, step)).map((insertedId) => ({
        insertedId,
      }));
    } catch (error) {
      if (!isConflict(error)) throw error;
      // A generated id colliding on PRIMARY (an exhausted AUTO_INCREMENT) is no
      // row-level conflict: the row carried no key, so skipping it would lose data.
      if (group.generated && error.errors.some((e) => e.path === "PRIMARY")) throw error;
      return undefined;
    }
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

  /**
   * `$skip` / `$limit` per partition in one statement: a `ROW_NUMBER()`
   * window over `partitionBy` (the generic `$with` loader's per-parent page).
   */
  override async findManyPerPartition(
    query: DbQuery,
    partitionBy: readonly string[],
  ): Promise<Array<Record<string, unknown>>> {
    const where = buildWhere(query.filter);
    const { sql, params } = buildPartitionedSelect(
      mysqlDialect,
      this.resolveTableName(),
      where,
      query.controls,
      partitionBy,
    );
    this._log(sql, params);
    return stripPartitionRowNumber(await this._exec().all(sql, params));
  }

  async count(query: DbQuery): Promise<number> {
    const where = buildWhere(query.filter);
    const tableName = this.resolveTableName();
    const sql = `SELECT COUNT(*) as cnt FROM ${quoteTableName(tableName)} WHERE ${where.sql}`;
    this._log(sql, where.params);
    const row = await this._exec().get<{ cnt: number }>(sql, where.params);
    return row?.cnt ?? 0;
  }

  async aggregate(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    // Grouped-search contract: see `resolveAggregateSearch`. `_buildSearchWhere`
    // is the leaf path's own predicate builder — it contributes a WHERE fragment
    // only, which the row query and the `$count` subquery then share.
    const search = resolveAggregateSearch(query.controls);
    const where = search
      ? this._buildSearchWhere(search.text, query, search.indexName)
      : buildWhere(query.filter);
    const tableName = this.resolveTableName();
    for (const bucket of query.controls.$select?.buckets ?? []) {
      await this._ensureBucketZone(bucket.tz);
    }

    if (query.controls.$count) {
      const { sql, params } = buildAggregateCount(tableName, where, query.controls);
      this._log(sql, params);
      const row = await mapQueryErrors(
        mysqlDialect,
        () => this._exec().get<{ count: number }>(sql, params),
        query.controls,
      );
      return [{ count: row?.count ?? 0 }];
    }

    const { sql, params } = buildAggregateSelect(tableName, where, query.controls);
    this._log(sql, params);
    return mapQueryErrors(mysqlDialect, () => this._exec().all(sql, params), query.controls);
  }

  /**
   * Verifies that `CONVERT_TZ` can convert to a calendar bucket's zone before
   * any bucket SQL runs — MySQL never fails loudly here: it returns NULL when
   * the time zone tables are not loaded (or lack the zone) and its input
   * unchanged outside its supported range (before 8.0.28 that range ends in
   * 2038). One probe ({@link TZ_PROBE_SQL}) detects both and raises
   * `BUCKET_TZ_UNAVAILABLE` with the fix. `UTC` needs no probe — its
   * expression skips `CONVERT_TZ`. Successes are cached per driver.
   */
  private async _ensureBucketZone(tz: string): Promise<void> {
    if (tz === "UTC" || convertibleZones.get(this.driver)?.has(tz)) {
      return;
    }
    this._log(TZ_PROBE_SQL, [tz]);
    const row = await this._exec().get<{ missing: unknown; shift: unknown }>(TZ_PROBE_SQL, [tz]);
    let problem: string | undefined;
    if (!row || Number(row.missing) !== 0) {
      problem =
        "its time zone tables are not loaded or lack this zone — load them with mysql_tzinfo_to_sql";
    } else if (Number(row.shift) !== 60) {
      problem =
        "its CONVERT_TZ does not convert instants after 2038 — MySQL 8.0.28 or later (64-bit) is required";
    }
    if (problem) {
      throw bucketTimeZoneUnavailable(`MySQL cannot convert to time zone "${tz}": ${problem}`);
    }
    let zones = convertibleZones.get(this.driver);
    if (!zones) {
      zones = new Set();
      convertibleZones.set(this.driver, zones);
    }
    zones.add(tz);
  }

  // ── CRUD: Update ──────────────────────────────────────────────────────────

  /**
   * The WHERE of an UPDATE / DELETE on this table. MySQL rejects a statement
   * whose WHERE reads the mutated table in a subquery (error 1093,
   * `ER_UPDATE_TABLE_USED`) — what a relational predicate (`$some` / `$none`)
   * does when its target or junction table, at any nesting level, is this
   * table (a self relation such as `parent`). Such a filter is re-keyed on the
   * primary key through a materialized derived table:
   *
   * ```sql
   * WHERE (<pk…>) IN (SELECT * FROM (SELECT DISTINCT <pk…> FROM t WHERE <where>) AS `_rfm`)
   * ```
   *
   * `DISTINCT` keeps the optimizer from merging the derived table back into
   * the statement. Every other filter renders as-is.
   *
   * @since 0.1.147
   */
  private _mutationWhere(filter: FilterExpr): TSqlFragment {
    const where = buildWhere(filter);
    if (!this._filterReadsOwnTable(filter)) {
      return where;
    }
    const tableName = this.resolveTableName();
    const keys = this._table.primaryKeys.map((key) => this._table.physicalPath(key));
    if (keys.length === 0) {
      throw new DbError("REL_FILTER_NOT_SUPPORTED", [
        {
          path: "",
          message:
            "MySQL cannot update or delete by a relational predicate that reads the table itself when the table has no primary key",
        },
      ]);
    }
    const cols = keys.map((key) => qi(key)).join(", ");
    const keyExpr = keys.length === 1 ? cols : `(${cols})`;
    return {
      sql: `${keyExpr} IN (SELECT * FROM (SELECT DISTINCT ${cols} FROM ${quoteTableName(tableName)} WHERE ${where.sql}) AS ${qi("_rfm")})`,
      params: where.params,
    };
  }

  /** `true` when a relational predicate of `filter` (nested ones included) reads this table. */
  private _filterReadsOwnTable(filter: FilterExpr): boolean {
    if (!containsRelationFilter(filter)) {
      return false;
    }
    const own = this.resolveTableName();
    let hit = false;
    forEachResolvedRelation(filter, (node) => {
      if (node.target.table === own || node.junction?.table === own) {
        hit = true;
      }
    });
    return hit;
  }

  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    // MySQL supports native UPDATE ... LIMIT 1
    const where = this._mutationWhere(filter);
    const versionColumn = this._table.versionColumnPhysical;
    const { sql, params } = buildUpdate(
      this.resolveTableName(),
      data,
      where,
      1,
      ops,
      versionColumn,
      expectedVersion,
    );
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { matchedCount: result.affectedRows, modifiedCount: result.changedRows };
  }

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): Promise<TDbUpdateResult> {
    const where = this._mutationWhere(filter);
    const versionColumn = this._table.versionColumnPhysical;
    const { sql, params } = buildUpdate(
      this.resolveTableName(),
      data,
      where,
      undefined,
      ops,
      versionColumn,
    );
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { matchedCount: result.affectedRows, modifiedCount: result.changedRows };
  }

  // ── CRUD: Replace ─────────────────────────────────────────────────────────

  async replaceOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    // Use UPDATE instead of DELETE+INSERT to avoid triggering CASCADE deletes.
    // Full replace (since 0.1.128): every column is assigned — omitted ones
    // become NULL, native function defaults (`now` / `increment`) re-apply
    // their DDL DEFAULT — matching the document adapters' whole-row replace
    // instead of silently merging with the old row.
    const where = this._mutationWhere(filter);
    const versionColumn = this._table.versionColumnPhysical;
    const full = fillReplacePayload(
      data,
      replaceColumnsFor(this._table.fieldDescriptors, this.nativeDefaultFns()),
      versionColumn,
    );
    const { sql, params } = buildUpdate(
      this.resolveTableName(),
      full,
      where,
      1,
      undefined,
      versionColumn,
      expectedVersion,
    );
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { matchedCount: result.affectedRows, modifiedCount: result.changedRows };
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    const where = this._mutationWhere(filter);
    const versionColumn = this._table.versionColumnPhysical;
    const { sql, params } = buildUpdate(
      this.resolveTableName(),
      data,
      where,
      undefined,
      undefined,
      versionColumn,
    );
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { matchedCount: result.affectedRows, modifiedCount: result.changedRows };
  }

  // ── CRUD: Delete ──────────────────────────────────────────────────────────

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    // MySQL supports native DELETE ... LIMIT 1
    const where = this._mutationWhere(filter);
    const { sql, params } = buildDelete(this.resolveTableName(), where, 1);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { deletedCount: result.affectedRows };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    const where = this._mutationWhere(filter);
    const { sql, params } = buildDelete(this.resolveTableName(), where);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { deletedCount: result.affectedRows };
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  async prepareTypeMapper(): Promise<void> {
    await this._warnNonStrictMode();
    if (this._supportsVector === undefined && this._vectorFields.size > 0) {
      await this._detectVectorSupport();
    }
  }

  async ensureTable(opts?: TEnsureTableOptions): Promise<void> {
    // Detect vector support lazily on first schema operation
    await this.prepareTypeMapper();
    // Structural check (never `instanceof`): a bundle may carry two copies of
    // @atscript/db, and a false `instanceof` would create an empty table here.
    if (this._table.isView) {
      return this._ensureView();
    }
    const sql = buildCreateTable(
      this.resolveTableName(),
      this._table.fieldDescriptors,
      this._table.foreignKeys,
      this._tableOptions(opts),
    );
    this._log(sql);
    await this._exec().exec(sql);
  }

  /** The CREATE TABLE options (engine/charset/collation/increment/ON UPDATE/type mapper). */
  private _tableOptions(opts?: TEnsureTableOptions): TMysqlTableOptions {
    return {
      engine: this._engine,
      charset: this._charset,
      collation: this._collation,
      autoIncrementStart: this._autoIncrementStart,
      incrementFields: this._incrementFields,
      onUpdateFields: this._onUpdateFields,
      typeMapper: (field) => this.typeMapper(field),
      deferForeignKeysTo: opts?.deferForeignKeysTo,
    };
  }

  /** The shared column-definition context for ADD/MODIFY statements. */
  private _columnCtx(purpose: TMysqlColumnContext["purpose"]): TMysqlColumnContext {
    return {
      incrementFields: this._incrementFields,
      onUpdateFields: this._onUpdateFields,
      typeMapper: (field) => this.typeMapper(field),
      purpose,
    };
  }

  // ── Schema sync primitives (since 0.1.128) ─────────────────────────────

  async hasRows(tableName?: string): Promise<boolean> {
    const target = tableName
      ? quoteTableName(this._schema ? `${this._schema}.${tableName}` : tableName)
      : quoteTableName(this.resolveTableName());
    const sql = `SELECT EXISTS(SELECT 1 FROM ${target}) AS present`;
    this._log(sql);
    const row = await this._exec().get<{ present: number | boolean }>(sql, []);
    return Boolean(Number(row?.present ?? 0));
  }

  /** Live foreign keys referencing `tableName` (any table of the schema). */
  async getReferencingForeignKeys(tableName: string): Promise<TReferencingForeignKey[]> {
    const rows = await this._exec().all<{
      TABLE_NAME: string;
      CONSTRAINT_NAME: string;
      COLUMN_NAME: string;
      REFERENCED_COLUMN_NAME: string;
    }>(
      `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE REFERENCED_TABLE_NAME = ? AND REFERENCED_TABLE_SCHEMA = COALESCE(?, DATABASE())
       ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      [tableName, this._schema],
    );
    const byConstraint = new Map<string, TReferencingForeignKey>();
    for (const r of rows) {
      const key = `${r.TABLE_NAME}\0${r.CONSTRAINT_NAME}`;
      let fk = byConstraint.get(key);
      if (!fk) {
        fk = { table: r.TABLE_NAME, fields: [], targetFields: [] };
        byConstraint.set(key, fk);
      }
      fk.fields.push(r.COLUMN_NAME);
      fk.targetFields.push(r.REFERENCED_COLUMN_NAME);
    }
    return [...byConstraint.values()];
  }

  async getObjectKind(name: string): Promise<TDbObjectKind | undefined> {
    const row = await this._exec().get<{ TABLE_TYPE: string }>(
      `SELECT TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_NAME = ? AND TABLE_SCHEMA = COALESCE(?, DATABASE())`,
      [name, this._schema],
    );
    if (!row) {
      return undefined;
    }
    return row.TABLE_TYPE.toUpperCase() === "VIEW" ? "view" : "table";
  }

  /**
   * One `ALTER TABLE … [MODIFY …,] DROP PRIMARY KEY, ADD PRIMARY KEY (…)`
   * statement (atomic). The sole owner of the columns entering the key:
   * `syncColumns` adds them without AUTO_INCREMENT and skips their MODIFYs
   * while the key change is pending, and this statement re-declares each of
   * them in full (AUTO_INCREMENT when the model declares increment, explicit
   * NOT NULL) together with the key swap — so an AUTO_INCREMENT column never
   * exists without a key (ER 1075), in safe mode or otherwise. A demoted key
   * column loses AUTO_INCREMENT in the same statement (pre-flight guarantees
   * its model no longer declares increment). Called on an empty table only.
   */
  async rebuildPrimaryKey(change: TPrimaryKeyChange): Promise<void> {
    const fields = new Map(this._table.fieldDescriptors.map((f) => [f.physicalName, f]));
    const to = new Set(change.to);
    const clauses: string[] = [];

    for (const name of change.to) {
      const field = fields.get(name);
      if (field) {
        clauses.push(
          `MODIFY COLUMN ${buildColumnDefinition(field, this._columnCtx("modify")).def}`,
        );
      }
    }

    if (change.from.length > 0) {
      const placeholders = change.from.map(() => "?").join(", ");
      const live = await this._exec().all<{
        COLUMN_NAME: string;
        COLUMN_TYPE: string;
        EXTRA: string;
      }>(
        `SELECT COLUMN_NAME, COLUMN_TYPE, EXTRA FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_NAME = ? AND TABLE_SCHEMA = COALESCE(?, DATABASE())
           AND COLUMN_NAME IN (${placeholders})`,
        [this._table.tableName, this._schema, ...change.from],
      );
      for (const col of live) {
        if (to.has(col.COLUMN_NAME) || !/auto_increment/i.test(col.EXTRA ?? "")) {
          continue;
        }
        const field = fields.get(col.COLUMN_NAME);
        // A demoted column that left the model is dropped right after the
        // swap — re-declare it from its live type, minus AUTO_INCREMENT.
        const def = field
          ? buildColumnDefinition(field, this._columnCtx("modify")).def
          : `${qi(col.COLUMN_NAME)} ${col.COLUMN_TYPE.toUpperCase()} NOT NULL`;
        clauses.push(`MODIFY COLUMN ${def}`);
      }
      clauses.push("DROP PRIMARY KEY");
    }

    if (change.to.length > 0) {
      clauses.push(`ADD PRIMARY KEY (${change.to.map((c) => qi(c)).join(", ")})`);
    }
    if (clauses.length === 0) {
      return;
    }
    const ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} ${clauses.join(", ")}`;
    this._log(ddl);
    await this._withStrictSession((conn) => conn.exec(ddl));
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
    return this._readColumns(this._exec(), tableName);
  }

  /** Live columns of `tableName`, read through `exec` (a held connection, or the pool). */
  private async _readColumns(
    exec: Pick<TMysqlDriver, "all">,
    tableName: string,
  ): Promise<TExistingColumn[]> {
    // `COLUMN_KEY = 'PRI'` also flags the first NOT NULL UNIQUE index of a
    // table WITHOUT a primary key (documented SHOW COLUMNS behaviour) — the
    // PRIMARY constraint (KEY_COLUMN_USAGE) is the only trustworthy source,
    // joined in so introspection is one round trip per table.
    const rows = await exec.all<{
      COLUMN_NAME: string;
      COLUMN_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null;
      SRS_ID: number | null;
      EXTRA: string | null;
      IS_PK: number | boolean | null;
    }>(
      `SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.SRS_ID, c.EXTRA,
              (k.COLUMN_NAME IS NOT NULL) AS IS_PK
       FROM INFORMATION_SCHEMA.COLUMNS c
       LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
         ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
        AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY'
       WHERE c.TABLE_NAME = ? AND c.TABLE_SCHEMA = COALESCE(?, DATABASE())
       ORDER BY c.ORDINAL_POSITION`,
      [tableName, this._schema],
    );
    return rows.map((r) => {
      const column: TExistingColumn = {
        name: r.COLUMN_NAME,
        // Geometry columns report SRID separately (COLUMN_TYPE is just "point") —
        // fold it back in to match `mysqlTypeFromField` ("POINT SRID 4326").
        type:
          r.SRS_ID == null
            ? r.COLUMN_TYPE.toUpperCase()
            : `${r.COLUMN_TYPE.toUpperCase()} SRID ${r.SRS_ID}`,
        notnull: r.IS_NULLABLE === "NO",
        pk: Boolean(Number(r.IS_PK ?? 0)),
        dflt_value: normalizeMysqlDefault(r.COLUMN_DEFAULT),
      };
      // `VIRTUAL GENERATED` / `STORED GENERATED` (MySQL and MariaDB) — not
      // `DEFAULT_GENERATED`, which marks an expression default.
      if (/\b(VIRTUAL|STORED) GENERATED\b/i.test(r.EXTRA ?? "")) {
        column.generated = true;
      }
      return column;
    });
  }

  async syncColumns(diff: TColumnDiff): Promise<TSyncColumnResult> {
    // One strict-mode connection: a MODIFY or backfill whose values do not
    // convert fails instead of being coerced (see `_withStrictSession`).
    return this._withStrictSession(async (conn) => {
      const tableName = this.resolveTableName();
      const added: string[] = [];
      const renamed: string[] = [];

      // Renames first
      for (const { field, oldName } of diff.renamed ?? []) {
        const ddl = `ALTER TABLE ${quoteTableName(tableName)} RENAME COLUMN ${qi(oldName)} TO ${qi(field.physicalName)}`;
        this._log(ddl);
        await conn.exec(ddl);
        renamed.push(field.physicalName);
      }

      const quotedTable = quoteTableName(tableName);

      // Adds — a required column without a model default gets an invented type
      // default so existing rows are filled, then loses it again immediately:
      // the live column must end in the canonical "no default" state or the
      // next diff would try to remove a default the adapter itself invented.
      // An increment column is added WITHOUT AUTO_INCREMENT (it would need a key
      // in the same statement) — the primary-key rebuild declares it.
      for (const field of diff.added) {
        const { def, inventedDefault } = buildColumnDefinition(field, this._columnCtx("add"));
        const ddl = `ALTER TABLE ${quotedTable} ADD COLUMN ${def}`;
        this._log(ddl);
        await conn.exec(ddl);
        if (inventedDefault) {
          const drop = `ALTER TABLE ${quotedTable} ALTER COLUMN ${qi(field.physicalName)} DROP DEFAULT`;
          this._log(drop);
          await conn.exec(drop);
        }
        added.push(field.physicalName);
      }

      // Modifications — type, nullability and default changes on one column
      // collapse into ONE `MODIFY COLUMN <full definition>` (the definition
      // carries DEFAULT / COLLATE / ON UPDATE / AUTO_INCREMENT, so nothing is
      // silently reset by a partial MODIFY). Columns entering a pending primary
      // key are left to `rebuildPrimaryKey`, which re-declares them in the swap
      // statement (their AUTO_INCREMENT needs the key in the same statement).
      // A derived column never appears in these lists — its drift is a
      // derived rebuild (`TColumnDiff.derivedChanged`), drop + add.
      const enteringKey = new Set(diff.primaryKeyChanged?.to ?? []);
      const modified = new Map<string, TDbFieldMeta>();
      for (const { field } of diff.typeChanged ?? []) {
        if (enteringKey.has(field.physicalName)) {
          continue;
        }
        const sqlType = this.typeMapper(field);
        if (field.isGeoPoint && !field.encrypted && sqlType.startsWith("POINT")) {
          // v1 JSON '[lng, lat]' → native POINT SRID 4326. MODIFY can't convert
          // JSON to geometry — go through a temp column, preserving NULLs.
          await this._migrateJsonColumnToPoint(conn, tableName, field);
          continue;
        }
        modified.set(field.physicalName, field);
      }
      for (const { field } of diff.nullableChanged ?? []) {
        if (enteringKey.has(field.physicalName)) {
          continue;
        }
        if (!field.optional) {
          // NULLs would make the NOT NULL MODIFY fail under strict sql_mode —
          // backfill with the model default (or a type default) first.
          const sqlType = this.typeMapper(field);
          const fallback =
            field.defaultValue?.kind === "value"
              ? mysqlDefaultLiteral(sqlType, field.designType, field.defaultValue.value)
              : mysqlTypeDefault(sqlType, field);
          const backfill = `UPDATE ${quotedTable} SET ${qi(field.physicalName)} = ${fallback} WHERE ${qi(field.physicalName)} IS NULL`;
          this._log(backfill);
          await conn.exec(backfill);
        }
        modified.set(field.physicalName, field);
      }
      for (const { field } of diff.defaultChanged ?? []) {
        if (!enteringKey.has(field.physicalName)) {
          modified.set(field.physicalName, field);
        }
      }
      for (const field of modified.values()) {
        const ddl = `ALTER TABLE ${quotedTable} MODIFY COLUMN ${buildColumnDefinition(field, this._columnCtx("modify")).def}`;
        this._log(ddl);
        await conn.exec(ddl);
      }

      return { added, renamed };
    });
  }

  async recreateTable(): Promise<void> {
    const tableName = this.resolveTableName();
    const tempName = `${this._table.tableName}__tmp_${Date.now()}`;

    // `SET FOREIGN_KEY_CHECKS` and `sql_mode` are session-scoped: every
    // statement of the recreate runs on the SAME connection (the pool would
    // hand the DROP to a connection where checks are still on), in strict mode
    // so a copied value that does not convert fails the copy.
    return this._withStrictSession(async (conn) => {
      await conn.exec("SET FOREIGN_KEY_CHECKS = 0");
      // MySQL DDL auto-commits, so nothing rolls the temp table back: a failure
      // before the original is dropped drops it here. After that the temp table
      // holds the only copy of the rows and is left in place.
      let originalDropped = false;
      try {
        // 1. Create new table with temp name
        const createSql = buildCreateTable(
          tempName,
          this._table.fieldDescriptors,
          this._table.foreignKeys,
          this._tableOptions(),
        );
        this._log(createSql);
        await conn.exec(createSql);

        // 2. Get columns that exist in both old and new
        // Read on the held connection: a second pool checkout could wait forever
        // on a one-connection pool.
        // Generated (derived) columns are computed, never inserted — the new
        // table recomputes them from the copied JSON source.
        const oldCols = (await this._readColumns(conn, this._table.tableName)).map((c) => c.name);
        const newCols = this._table.storedDescriptors.map((f) => f.physicalName);
        const oldColSet = new Set(oldCols);
        const commonCols = newCols.filter((c) => oldColSet.has(c));

        if (commonCols.length > 0) {
          // 3. Copy data
          const fieldsByName = new Map(
            this._table.fieldDescriptors.map((f) => [f.physicalName, f]),
          );
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
          const copySql = `INSERT INTO ${qi(tempName)} (${colNames}) SELECT ${selectExprs} FROM ${quoteTableName(tableName)}`;
          this._log(copySql);
          await conn.exec(copySql);
        }

        // 4. Drop old, rename new. Not an atomic `RENAME TABLE t TO old, tmp TO t`:
        //    InnoDB would re-point other tables' foreign keys at the renamed original.
        await conn.exec(`DROP TABLE IF EXISTS ${quoteTableName(tableName)}`);
        originalDropped = true;
        await conn.exec(`RENAME TABLE ${qi(tempName)} TO ${quoteTableName(tableName)}`);
      } catch (error) {
        if (originalDropped) {
          throw new Error(
            `Recreate of "${tableName}" failed after the original table was dropped; its rows are in "${tempName}"`,
            { cause: error },
          );
        }
        await conn.exec(`DROP TABLE IF EXISTS ${qi(tempName)}`).catch(() => undefined);
        throw error;
      } finally {
        await conn.exec("SET FOREIGN_KEY_CHECKS = 1");
      }
    });
  }

  async dropTable(): Promise<void> {
    return this.dropTableByName(this.resolveTableName());
  }

  async dropColumns(columns: string[]): Promise<void> {
    const tableName = this.resolveTableName();
    // MySQL supports multi-column drop in a single ALTER TABLE
    const drops = columns.map((col) => `DROP COLUMN ${qi(col)}`).join(", ");
    const ddl = `ALTER TABLE ${quoteTableName(tableName)} ${drops}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  async dropIndexesForColumns(columns: string[]): Promise<void> {
    const placeholders = columns.map(() => "?").join(", ");
    const rows = await this._exec().all<{ name: string }>(
      `SELECT DISTINCT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_NAME = ? AND TABLE_SCHEMA = COALESCE(?, DATABASE())
         AND INDEX_NAME LIKE 'atscript\\_\\_%' AND COLUMN_NAME IN (${placeholders})`,
      [this._table.tableName, this._schema, ...columns],
    );
    for (const row of rows) {
      const sql = `DROP INDEX ${qi(row.name)} ON ${quoteTableName(this.resolveTableName())}`;
      this._log(sql);
      await this._exec().exec(sql);
    }
  }

  override async dropTableByName(tableName: string): Promise<void> {
    const ddl = `DROP TABLE IF EXISTS ${quoteTableName(tableName)}`;
    this._log(ddl);
    const conn = await this.driver.getConnection();
    await conn.exec("SET FOREIGN_KEY_CHECKS = 0");
    try {
      await conn.exec(ddl);
    } finally {
      await conn.exec("SET FOREIGN_KEY_CHECKS = 1");
      conn.release();
    }
  }

  override async dropViewByName(viewName: string): Promise<void> {
    const ddl = `DROP VIEW IF EXISTS ${quoteTableName(viewName)}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  async renameTable(oldName: string): Promise<void> {
    const newName = this.resolveTableName();
    const ddl = `RENAME TABLE ${quoteTableName(oldName)} TO ${quoteTableName(newName)}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  typeMapper(field: TDbFieldMeta): string {
    if (field.encrypted) {
      // Ciphertext envelope: unbounded text, plaintext-length-dependent.
      return "TEXT";
    }
    // Vector fields → VECTOR(N) on MySQL 9+, JSON otherwise
    if (this._vectorFields.has(field.path)) {
      const vec = this._vectorFields.get(field.path)!;
      return this._supportsVector ? `VECTOR(${vec.dimensions})` : "JSON";
    }
    return mysqlTypeFromField(field);
  }

  // ── Index sync ────────────────────────────────────────────────────────────

  async syncIndexes(): Promise<void> {
    const tableName = this._table.tableName;
    const schema = this._schema;

    // Key-length prefixes are a function of the MAPPED column type and the
    // table charset (MySQL has no column-level charset annotation). Live key
    // parts are rendered the same way — with a SUB_PART equal to the column's
    // declared length normalised to "no prefix" — so the definition-drift
    // check rebuilds an index exactly once when its prefix must change.
    const bytesPerChar = mysqlBytesPerChar(this._charset);
    const fields = new Map(this._table.fieldDescriptors.map((f) => [f.physicalName, f]));
    const mappedType = (column: string): string | undefined => {
      const field = fields.get(column);
      return field ? this.typeMapper(field) : undefined;
    };
    const desiredPrefix = (column: string): number | undefined => {
      const type = mappedType(column);
      return type === undefined ? undefined : mysqlIndexPrefix(type, bytesPerChar);
    };
    const renderPart = (column: string, prefix: number | undefined): string =>
      prefix === undefined ? column : `${column}(${prefix})`;

    await this.syncIndexesWithDiff({
      listExisting: async () => {
        const rows = await this._exec().all<{
          INDEX_NAME: string;
          COLUMN_NAME: string;
          SUB_PART: number | null;
          SEQ_IN_INDEX: number;
        }>(
          `SELECT INDEX_NAME, COLUMN_NAME, SUB_PART, SEQ_IN_INDEX
           FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_NAME = ? AND TABLE_SCHEMA = COALESCE(?, DATABASE())
           ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
          [tableName, schema],
        );
        const byName = new Map<string, string[]>();
        for (const r of rows) {
          let subPart = r.SUB_PART ?? undefined;
          const type = mappedType(r.COLUMN_NAME);
          if (subPart !== undefined && type !== undefined && mysqlCharLength(type) === subPart) {
            subPart = undefined;
          }
          const parts = byName.get(r.INDEX_NAME) ?? [];
          parts.push(renderPart(r.COLUMN_NAME, subPart));
          byName.set(r.INDEX_NAME, parts);
        }
        return [...byName].map(([name, columns]) => ({ name, columns }));
      },
      renderDesiredColumn: (_index, f) => renderPart(f.name, desiredPrefix(f.name)),
      createIndex: async (index: TDbIndex) => {
        if (index.type === "geo") {
          // MySQL requires NOT NULL columns for SPATIAL indexes. Optional
          // geoPoint fields stay searchable (scan-based) — warn and skip.
          const fieldMeta = this._table.fieldDescriptors.find(
            (f) => f.physicalName === index.fields[0]?.name,
          );
          if (fieldMeta?.optional) {
            this.logger.warn(
              `[mysql] geo index "${index.name}" skipped — SPATIAL indexes require a NOT NULL column; make "${fieldMeta.path}" required to index it`,
            );
            return;
          }
          const sql = `CREATE SPATIAL INDEX ${qi(index.key)} ON ${quoteTableName(this.resolveTableName())} (${qi(index.fields[0].name)})`;
          this._log(sql);
          await this._exec().exec(sql);
          return;
        }
        const unique = index.type === "unique" ? "UNIQUE " : "";
        const fulltext = index.type === "fulltext" ? "FULLTEXT " : "";
        // FULLTEXT indexes accept TEXT columns; others take a key-length
        // prefix only where the mapped type requires one (see mysqlIndexPrefix)
        const isFulltext = index.type === "fulltext";
        const cols = index.fields
          .map((f) => {
            const col = qi(f.name);
            const prefix = isFulltext ? undefined : desiredPrefix(f.name);
            const order = isFulltext ? "" : ` ${f.sort === "desc" ? "DESC" : "ASC"}`;
            return `${col}${prefix === undefined ? "" : `(${prefix})`}${order}`;
          })
          .join(", ");
        const sql = `CREATE ${fulltext}${unique}INDEX ${qi(index.key)} ON ${quoteTableName(this.resolveTableName())} (${cols})`;
        this._log(sql);
        await this._exec().exec(sql);
      },
      dropIndex: async (name: string) => {
        const sql = `DROP INDEX ${qi(name)} ON ${quoteTableName(this.resolveTableName())}`;
        this._log(sql);
        await this._exec().exec(sql);
      },
    });
  }

  // ── FK sync ───────────────────────────────────────────────────────────────

  async syncForeignKeys(): Promise<void> {
    const existingByName = await this._getExistingFkConstraints();

    // Build desired FK set (keyed by sorted local column names)
    const desiredFkKeys = new Set<string>();
    for (const fk of this._table.foreignKeys.values()) {
      desiredFkKeys.add([...fkColumns(fk).fields].toSorted().join(","));
    }

    // Drop stale FKs (managed ones that no longer match desired)
    for (const [constraintName, columns] of existingByName) {
      const key = columns.toSorted().join(",");
      if (!desiredFkKeys.has(key)) {
        const ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} DROP FOREIGN KEY ${qi(constraintName)}`;
        this._log(ddl);
        await this._exec().exec(ddl);
      }
    }

    // Add missing FKs
    const existingKeys = new Set(
      [...existingByName.values()].map((cols) => cols.toSorted().join(",")),
    );
    for (const fk of this._table.foreignKeys.values()) {
      const key = [...fkColumns(fk).fields].toSorted().join(",");
      if (!existingKeys.has(key)) {
        const ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} ADD ${foreignKeySql(qi, fk)}`;
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
        const ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} DROP FOREIGN KEY ${qi(constraintName)}`;
        this._log(ddl);
        await this._exec().exec(ddl);
      }
    }
  }

  /** Queries INFORMATION_SCHEMA for existing FK constraints, grouped by constraint name → column names. */
  private async _getExistingFkConstraints(): Promise<Map<string, string[]>> {
    const rows = await this._exec().all<{
      CONSTRAINT_NAME: string;
      COLUMN_NAME: string;
    }>(
      `SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       WHERE kcu.TABLE_NAME = ? AND kcu.TABLE_SCHEMA = COALESCE(?, DATABASE())
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
      [this._table.tableName, this._schema],
    );
    const byName = new Map<string, string[]>();
    for (const row of rows) {
      let cols = byName.get(row.CONSTRAINT_NAME);
      if (!cols) {
        cols = [];
        byName.set(row.CONSTRAINT_NAME, cols);
      }
      cols.push(row.COLUMN_NAME);
    }
    return byName;
  }

  // ── Fulltext search ───────────────────────────────────────────────────────

  override getSearchIndexes(): TSearchIndexInfo[] {
    const indexes: TSearchIndexInfo[] = [];
    // The first index of each type answers a request naming none.
    for (const index of this._table.indexes.values()) {
      if (index.type === "fulltext") {
        indexes.push({
          name: index.key,
          description: `FULLTEXT index on ${index.fields.map((f) => f.name).join(", ")}`,
          type: "text",
          fields: this._indexLogicalPaths(index),
          isDefault: indexes.length === 0,
        });
      }
    }
    // Add vector indexes
    let firstVector = true;
    for (const [field, vec] of this._vectorFields) {
      indexes.push({
        name: vec.indexName,
        description: `VECTOR(${vec.dimensions}) on ${field}, ${vec.similarity}`,
        type: "vector",
        fields: [field],
        isDefault: firstVector,
      });
      firstVector = false;
    }
    return indexes;
  }

  override async search(
    text: string,
    query: DbQuery,
    indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
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
    const combinedWhere = this._buildSearchWhere(text, query, indexName);
    const tableName = this.resolveTableName();

    const selectPromise = (async () => {
      const { sql, params } = buildSelect(tableName, combinedWhere, query.controls);
      this._log(sql, params);
      return this._exec().all(sql, params);
    })();

    const countPromise = (async () => {
      const sql = `SELECT COUNT(*) as cnt FROM ${quoteTableName(tableName)} WHERE ${combinedWhere.sql}`;
      this._log(sql, combinedWhere.params);
      const row = await this._exec().get<{ cnt: number }>(sql, combinedWhere.params);
      return row?.cnt ?? 0;
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
      throw new Error("No FULLTEXT index found for search");
    }
    const matchCols = fulltextIndex.fields.map((f) => qi(f.name)).join(", ");
    const where = buildWhere(query.filter);
    const matchClause = `MATCH(${matchCols}) AGAINST(? IN NATURAL LANGUAGE MODE)`;
    return {
      sql: where.sql === "1=1" ? matchClause : `${where.sql} AND ${matchClause}`,
      params: [...where.params, text],
    };
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
   * Detects native VECTOR type support by inspecting the server version.
   * MySQL 9.0+ supports the VECTOR column type natively.
   * Caches the result for the lifetime of this adapter instance.
   */
  private async _detectVectorSupport(): Promise<boolean> {
    if (this._supportsVector !== undefined) {
      return this._supportsVector;
    }
    try {
      const row = await this.driver.get<{ v: string }>("SELECT VERSION() as v", []);
      if (row?.v) {
        // VERSION() returns e.g. '9.0.1', '8.4.3', '8.0.mysql_aurora.3.07.1'
        const major = Number.parseInt(row.v, 10);
        this._supportsVector = !Number.isNaN(major) && major >= 9;
      } else {
        this._supportsVector = false;
      }
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
      throw new Error("Vector search requires MySQL 9.0+");
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
      throw new Error("Vector search requires MySQL 9.0+");
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
      this._exec().get<{ cnt: number }>(countSql, countParams),
    ]);
    return { data, count: countRow?.cnt ?? 0 };
  }

  /** Resolves vector field and computes shared context for vector search SQL builders. */
  private _prepareVectorSearch(vector: number[], query: DbQuery, indexName?: string) {
    // Resolve target vector field
    let field: string;
    let vec: { dimensions: number; similarity: string; indexName: string };
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
        throw new Error(vectorIndexNotFoundMessage(indexName));
      }
    } else {
      const first = this._vectorFields.entries().next();
      if (first.done) {
        throw new Error("No vector fields defined");
      }
      field = first.value[0];
      vec = first.value[1];
    }
    const distanceFn = similarityToMysqlFn(vec!.similarity);
    const where = buildWhere(query.filter, {
      // vectorDistanceSource aliases the table `t` — relational predicates correlate to it.
      qualifier: mysqlDialect.quoteTable(SEARCH_SOURCE_ALIAS),
    });
    const controls = query.controls || {};
    const threshold = this._resolveVectorThreshold(
      controls as Record<string, unknown>,
      vec!.indexName,
    );
    return {
      field: field!,
      vec: vec!,
      distanceFn,
      where,
      controls,
      threshold,
      tableName: this.resolveTableName(),
      vectorStr: vectorToString(vector),
    };
  }

  /**
   * The row source + distance cap of a vector search. The threshold is a
   * normalized score matching MongoDB Atlas semantics: cosine score =
   * (1 + cos_sim) / 2, VEC_DISTANCE_COSINE = 1 - cos_sim, so the distance cap
   * is 2 * (1 - score).
   */
  private _vectorSearchSource(
    ctx: ReturnType<MysqlAdapter["_prepareVectorSearch"]>,
    withRows: boolean,
  ): { source: TSqlFragment; maxDistance?: number } {
    const distExpr = {
      sql: `${ctx.distanceFn}(${qi(ctx.field)}, STRING_TO_VECTOR(?))`,
      params: [ctx.vectorStr],
    };
    return {
      source: vectorDistanceSource(mysqlDialect, ctx.tableName, ctx.where, distExpr, withRows),
      maxDistance: ctx.threshold === undefined ? undefined : 2 * (1 - ctx.threshold),
    };
  }

  private _buildVectorSearchQuery(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): { sql: string; params: unknown[] } {
    const ctx = this._prepareVectorSearch(vector, query, indexName);
    const { source, maxDistance } = this._vectorSearchSource(ctx, true);
    const skip = Number(ctx.controls.$skip) || 0;
    return buildVectorSearchSelect(mysqlDialect, source, {
      select: ctx.controls.$select,
      limit: Number(ctx.controls.$limit) || (skip ? 1000 : 20),
      skip,
      maxDistance,
    });
  }

  private _buildVectorSearchCountQuery(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): { sql: string; params: unknown[] } {
    const { source, maxDistance } = this._vectorSearchSource(
      this._prepareVectorSearch(vector, query, indexName),
      false,
    );
    return buildVectorSearchCount(mysqlDialect, source, { maxDistance });
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

  // ── Geo search ───────────────────────────────────────────────────────────

  /** Native POINT SRID 4326 + ST_Distance_Sphere — available on MySQL 8.0+. */
  override isGeoSearchable(): boolean {
    return true;
  }

  override async geoSearch(
    point: [number, number],
    query: DbQuery,
    indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const { sql, params } = this._buildGeoSearchSelect(
      this._prepareGeoSearch(point, query, indexName),
    );
    this._log(sql, params);
    const rows = await this._exec().all(sql, params);
    return rows.map((row) => renameGeoDistance(row));
  }

  override async geoSearchWithCount(
    point: [number, number],
    query: DbQuery,
    indexName?: string,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    const ctx = this._prepareGeoSearch(point, query, indexName);
    const { sql, params } = this._buildGeoSearchSelect(ctx);
    const countFrag = buildGeoSearchCount(
      mysqlDialect,
      ctx.tableName,
      ctx.where,
      ctx.dist,
      ctx.window,
    );
    this._log(sql, params);
    this._log(countFrag.sql, countFrag.params);
    const [rows, countRow] = await Promise.all([
      this._exec().all(sql, params),
      this._exec().get<{ cnt: number }>(countFrag.sql, countFrag.params),
    ]);
    return {
      data: rows.map((row) => renameGeoDistance(row)),
      count: Number(countRow?.cnt ?? 0),
    };
  }

  /** Resolves the shared parts of a geo search once (column, filter, distance, window). */
  private _prepareGeoSearch(point: [number, number], query: DbQuery, indexName?: string) {
    const column = this._resolveGeoColumn(indexName);
    const controls = (query.controls ?? {}) as Record<string, unknown>;
    return {
      tableName: this.resolveTableName(),
      // The geo builders alias the table `t` — relational predicates correlate to it.
      where: buildWhere(query.filter, { qualifier: mysqlDialect.quoteTable(SEARCH_SOURCE_ALIAS) }),
      dist: mysqlGeoDistanceExpr(qi(column), point),
      window: geoWindowFromControls(controls),
      controls,
    };
  }

  private _buildGeoSearchSelect(ctx: ReturnType<MysqlAdapter["_prepareGeoSearch"]>): {
    sql: string;
    params: unknown[];
  } {
    return buildGeoSearchSelect(
      mysqlDialect,
      ctx.tableName,
      ctx.where,
      ctx.dist,
      ctx.window,
      ctx.controls as TGeoSearchControls,
    );
  }

  /**
   * Migrates a v1 JSON `[lng, lat]` column to native `POINT SRID 4326` via a
   * temp column (MySQL has no JSON→geometry cast for MODIFY COLUMN).
   */
  private async _migrateJsonColumnToPoint(
    conn: TMysqlConnection,
    tableName: string,
    field: TDbFieldMeta,
  ): Promise<void> {
    const col = qi(field.physicalName);
    const tmp = qi(`${field.physicalName}__geo_mig`);
    const quotedTable = quoteTableName(tableName);
    const steps = [
      `ALTER TABLE ${quotedTable} ADD COLUMN ${tmp} POINT SRID 4326 NULL`,
      `UPDATE ${quotedTable} SET ${tmp} = ST_SRID(POINT(CAST(${col}->>'$[0]' AS DOUBLE), CAST(${col}->>'$[1]' AS DOUBLE)), 4326) WHERE ${col} IS NOT NULL`,
      `ALTER TABLE ${quotedTable} DROP COLUMN ${col}`,
      `ALTER TABLE ${quotedTable} RENAME COLUMN ${tmp} TO ${col}`,
      ...(field.optional || field.isPrimaryKey
        ? []
        : [
            `ALTER TABLE ${quotedTable} MODIFY COLUMN ${buildColumnDefinition(field, this._columnCtx("modify")).def}`,
          ]),
    ];
    for (const ddl of steps) {
      this._log(ddl);
      await conn.exec(ddl);
    }
  }
}

/**
 * Normalizes MySQL INFORMATION_SCHEMA.COLUMNS.COLUMN_DEFAULT values
 * to match the format produced by `serializeDefaultValue()`.
 *
 * MySQL stores expression defaults as raw SQL (e.g., `CURRENT_TIMESTAMP`,
 * `uuid()`), but the diff engine compares against serialized form (`fn:now`,
 * `fn:uuid`). Without normalization, every table with function defaults
 * produces phantom ALTER diffs on re-plan.
 */
function normalizeMysqlDefault(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  const lower = value.toLowerCase();
  // DEFAULT CURRENT_TIMESTAMP / current_timestamp() → fn:now
  if (lower === "current_timestamp" || lower === "current_timestamp()") {
    return "fn:now";
  }
  // DEFAULT uuid() — MySQL 8.0 stores as "uuid()"
  if (lower === "uuid()") {
    return "fn:uuid";
  }
  // Strip enclosing single quotes and un-double escaped quotes
  // MySQL INFORMATION_SCHEMA returns 'it''s active' for DEFAULT 'it''s active'
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Maps generic similarity metric to MySQL 9+ distance function name. */
function similarityToMysqlFn(similarity: string): string {
  switch (similarity) {
    case "euclidean": {
      return "VEC_DISTANCE_EUCLIDEAN";
    }
    case "dotProduct": {
      return "VEC_DISTANCE_DOT";
    }
    default: {
      return "VEC_DISTANCE_COSINE";
    }
  }
}

/** Formats a number[] vector as MySQL's STRING_TO_VECTOR input: '[1.0, 2.0, ...]'. */
function vectorToString(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
