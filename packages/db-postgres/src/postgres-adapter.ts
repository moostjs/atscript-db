import type { TMetadataMap } from "@atscript/typescript/utils";
import {
  ALL_AGGREGATE_FNS,
  ALL_VIEW_CAPABILITIES,
  ALL_BUCKET_UNITS,
  BaseDbAdapter,
  DbError,
  isColumnTypeChanged,
  vectorIndexNotFoundMessage,
  fkColumns,
  searchTermInteger,
  describeFulltext,
  defaultFulltextIndex,
  splitFulltextFields,
  uniqueKeyTuple,
} from "@atscript/db";
import type {
  AtscriptDbView,
  DbErrorCode,
  TDbObjectKind,
  TEnsureTableOptions,
  TPrimaryKeyChange,
  TReferencingForeignKey,
} from "@atscript/db";
import type { TFieldOps } from "@atscript/db";
import type {
  TDbDeleteResult,
  TDbIndex,
  TDbInsertManyResult,
  TDbInsertIgnoreSlot,
  TDbInsertIgnoreOptions,
  TDbInsertResult,
  TDbUpdateResult,
  TDbUpdateOptions,
  TExistingColumn,
  TColumnDiff,
  TJsonCopyTarget,
  TSyncColumnResult,
  TDbFieldMeta,
  TDbDefaultFn,
  TValueFormatterPair,
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
  buildJsonColumnCopy,
  buildJsonifyText,
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
  orFragment,
  buildKeyViolationCount,
} from "@atscript/db-sql-tools";

import { mapIgnoredBatch } from "./insert-ignore";
import { buildWhere } from "./filter-builder";
import {
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
  geoPointToEwkt,
  parseEwkbPointHex,
  PendingGeoPoint,
  type TGeoProbeExecutor,
  pgCollateClause,
  pgDerivedColumnDef,
  pgGeoDistanceExpr,
  pgTypeFromField,
  isTextKeyType,
  qi,
  quoteTableName,
  pgDialect,
  finalizeParams,
} from "./sql-builder";
import type { TPgConnection, TPgDriver } from "./types";

/** The statement surface the adapter runs CRUD through (pool or transaction connection). */
type TPgExecutor = Pick<TPgDriver, "run" | "all" | "get" | "exec">;

/** The key columns of a conflict-ignoring insert (see `PostgresAdapter._ignorePlan`). */
interface TPgIgnorePlan {
  keySets: string[][];
  returning: string[];
  nonTextKeyCols: Set<string>;
  returningSuffix: string;
}

/**
 * Read-only geo facts of one table, in one round trip: PostGIS presence and
 * the physical type of the named columns (`{ column: type }`, a domain
 * reported as its base type; `null` when the relation does not exist). Catalog
 * reads only — no privileges needed, never aborts a transaction.
 */
const GEO_PROBE_SQL = `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS "postgis",
  (SELECT json_object_agg(a.attname, COALESCE(b.typname, t.typname))
     FROM pg_attribute a
     JOIN pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_type b ON b.oid = NULLIF(t.typbasetype, 0)
    WHERE a.attrelid = to_regclass($1::text) AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname = ANY($2::text[])) AS "columns"`;

const identity = (value: unknown): unknown => value;

/** A column type node-postgres parses on read. */
const PG_JSON_TYPE = /^\s*jsonb?\s*$/i;

/** A JSON string value as JSON text — see `formatValue`. */
function reencodeJsonString(value: unknown): unknown {
  return typeof value === "string" ? JSON.stringify(value) : value;
}

/** A PostGIS column type — a geo value binds as EWKT. Anything else (JSONB, TEXT) takes the JSON form. */
const POSTGIS_TYPES: ReadonlySet<string> = new Set(["geography", "geometry"]);

/** The SQL `$geoWithin` renders (`pgDialect.geoWithin`) — PostGIS only. */
const GEO_WITHIN_SQL = "ST_DWithin(";

/** The answer of {@link GEO_PROBE_SQL}: PostGIS presence + column → PostGIS-typed (found columns only). */
interface TGeoProbe {
  postgis: boolean;
  columns: Map<string, boolean>;
}

/** Index of the first {@link PendingGeoPoint} in `params`, or -1. */
function firstPendingGeo(params: unknown[] | undefined): number {
  if (params) {
    for (let i = 0; i < params.length; i++) {
      if (params[i] instanceof PendingGeoPoint) return i;
    }
  }
  return -1;
}

/**
 * A copy of `params` with every {@link PendingGeoPoint} (from `from` on)
 * resolved for its own column — EWKT for a PostGIS column, the JSON form
 * otherwise — each marker's column probe running on `exec`, the statement's.
 */
async function resolvePendingGeo(
  params: unknown[],
  from: number,
  exec: TPgExecutor,
): Promise<unknown[]> {
  const out = params.slice();
  for (let i = from; i < out.length; i++) {
    const value = out[i];
    if (value instanceof PendingGeoPoint) {
      const native = value.native(exec);
      out[i] = (typeof native === "boolean" ? native : await native)
        ? geoPointToEwkt(value.point)
        : value.raw;
    }
  }
  return out;
}

/** `GEO_NOT_SUPPORTED` — geo search / `$geoWithin` without PostGIS. */
function geoNotSupported(path: string, message: string): DbError {
  return new DbError("GEO_NOT_SUPPORTED", [{ path, message }]);
}

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
/** The suffix PostgreSQL gives an auto-named constraint of each `pg_constraint.contype`. */
/** Savepoint guarding one `insertManyIgnore` chunk (see {@link PostgresAdapter.insertManyIgnore}). */
const IGNORE_SAVEPOINT = "atscript_ignore_chunk";

/** Retryable concurrency SQLSTATEs (see `PostgresAdapter._mapConstraintError`). */
const PG_CONTENTION_CODES: Record<string, DbErrorCode | undefined> = {
  "40P01": "DEADLOCK",
  "55P03": "LOCK_TIMEOUT",
  "40001": "SERIALIZATION_FAILURE",
};

const PG_CONSTRAINT_LABELS: Record<string, string | undefined> = {
  p: "pkey",
  u: "key",
  f: "fkey",
  n: "not_null",
};

/** UTF-8 byte length of `s`. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Cuts `s` to at most `bytes` UTF-8 bytes (whole characters only). */
function truncateBytes(s: string, bytes: number): string {
  let out = s;
  while (byteLength(out) > bytes) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * The name PostgreSQL generates for an unnamed constraint (`makeObjectName`):
 * `<table>_<columns joined by _>_<label>`, with the table and column parts
 * shortened — the longer one first — until the whole fits 63 bytes
 * (`NAMEDATALEN - 1`). Used to recognise and to rename the recreated table's
 * constraints. Ignores the `1`, `2`, … suffix PostgreSQL appends on a clash.
 */
export function pgObjectName(table: string, columns: string[], label: string): string {
  const name2 = columns.join("_");
  const overhead = label.length + 1 + (name2 ? 1 : 0);
  const avail = 63 - overhead;
  let n1 = byteLength(table);
  let n2 = byteLength(name2);
  while (n1 + n2 > avail) {
    if (n1 > n2) {
      n1--;
    } else {
      n2--;
    }
  }
  const head = truncateBytes(table, n1);
  return name2 ? `${head}_${truncateBytes(name2, n2)}_${label}` : `${head}_${label}`;
}

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

  // ── Geo search state ────────────────────────────────────────────────────
  /**
   * Whether the connected PostgreSQL instance has the PostGIS extension —
   * `undefined` until known: set by schema sync ({@link prepareTypeMapper},
   * which installs it), or by the read-only geo probe ({@link _probeGeo}).
   * Decides DDL and geo search; how a geo VALUE binds is decided per column
   * ({@link _geoNative}).
   */
  private _supportsGeo: boolean | undefined;
  /** Whether {@link _detectGeoSupport} (the installing detection) already ran. */
  private _geoInstallTried = false;
  /** Memo of {@link _hasGeoPointFields}. */
  private _geoFields?: boolean;
  /** Physical names of the unencrypted `db.geoPoint` columns (set with the metadata). */
  private _geoColumnNames: string[] = [];
  /**
   * Physical geo column → whether it is a PostGIS column (`geography` /
   * `geometry`: EWKT) or not (JSONB: the JSON form). Learned from the catalog
   * — after schema sync ({@link afterSyncTable}) or before the first statement
   * binding a geo value — never from the extension alone: a JSONB column
   * created before PostGIS was installed stays JSONB until a sync migrates
   * it. Cleared by every DDL path ({@link _geoSchemaChanged}).
   */
  private _geoNative = new Map<string, boolean>();
  /** The in-flight shared geo probe and the executor it runs on. */
  private _geoProbe?: { exec: TGeoProbeExecutor; promise: Promise<TGeoProbe> };
  /** Bumped by {@link _geoSchemaChanged}: a probe started before a DDL caches nothing. */
  private _geoSchemaGen = 0;
  /** The pool executor with geo-marker resolution (built once). */
  private _poolExec?: TPgExecutor;
  /** The last transaction connection's wrapped executor. */
  private _txExec?: { conn: TPgConnection; exec: TPgExecutor };

  // ── Per-table memos (the table metadata is built once per readable) ────
  private _pkColumnsMemo?: { src: readonly string[]; cols: string[]; returning: string };
  private _replaceColumnsMemo?: {
    src: readonly TDbFieldMeta[];
    cols: ReturnType<typeof replaceColumnsFor>;
  };
  private _ignorePlanMemo?: TPgIgnorePlan & { key: string };
  private _fulltextMemo?: {
    src: Map<string, TDbIndex>;
    all: TDbIndex[];
    def: TDbIndex | undefined;
  };
  private _searchIndexesMemo?: { src: Map<string, TDbIndex>; list: TSearchIndexInfo[] };

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

  /**
   * Schema name for catalog queries and qualification — `@db.schema` of the
   * bound table, or `null` (→ the connection's `current_schema()`, the same default the bound path
   * uses) when the table declares none or the adapter is an administrative
   * one with no readable (the name-taking schema-sync primitives run on such
   * an adapter).
   */
  private get _schema(): string | null {
    return this._table?.schema ?? null;
  }

  constructor(protected readonly driver: TPgDriver) {
    super();
  }

  // ── Transaction primitives ──────────────────────────────────────────────

  /** Every adapter over this pool shares one transaction (since 0.1.128). */
  protected override _transactionOwner(): unknown {
    return this.driver;
  }

  /** The dedicated connection of this pool's open transaction, if any. */
  private _txConnection(): TPgConnection | undefined {
    return this._getTransactionState() as TPgConnection | undefined;
  }

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
  private _exec(): TPgExecutor {
    const conn = this._txConnection();
    if (!conn) {
      return (this._poolExec ??= this._geoResolvingExec(this.driver));
    }
    if (this._txExec?.conn !== conn) {
      this._txExec = { conn, exec: this._geoResolvingExec(conn) };
    }
    return this._txExec.exec;
  }

  /**
   * `exec` resolving `PendingGeoPoint` params before the statement runs. Every
   * adapter wraps — not only geo tables: a relational filter on another
   * table's geo column carries that table's markers into this one's
   * statement. A statement without markers runs as is (one param scan).
   */
  private _geoResolvingExec(exec: TPgExecutor): TPgExecutor {
    const prep = <R>(
      sql: string,
      params: unknown[] | undefined,
      run: (p?: unknown[]) => Promise<R>,
    ): Promise<R> => {
      if (this._geoFields && this._supportsGeo !== true && sql.includes(GEO_WITHIN_SQL)) {
        return this._assertGeoWithin(exec).then(() => prep(sql, params, run));
      }
      const at = firstPendingGeo(params);
      return at < 0 ? run(params) : resolvePendingGeo(params!, at, exec).then(run);
    };
    return {
      run: (sql, params) => prep(sql, params, (p) => exec.run(sql, p)),
      all: <T>(sql: string, params?: unknown[]) => prep(sql, params, (p) => exec.all<T>(sql, p)),
      get: <T>(sql: string, params?: unknown[]) => prep(sql, params, (p) => exec.get<T>(sql, p)),
      // DDL (every schema path runs it through here, recreate aside): the
      // geo column types are learned anew once it has run.
      exec: (sql) => exec.exec(sql).finally(() => this._geoSchemaChanged()),
    };
  }

  /**
   * `$geoWithin` passed the core guard while PostGIS presence was unknown
   * ({@link isGeoSearchable} answers optimistically then): learn it, and
   * refuse like the guard would have when it is absent.
   */
  private async _assertGeoWithin(exec: TPgExecutor): Promise<void> {
    if (this._supportsGeo === undefined) {
      await this._probeGeo(exec);
    }
    if (this._supportsGeo !== true) {
      throw geoNotSupported("", "$geoWithin requires the PostGIS extension");
    }
  }

  // ── Capability flags ──────────────────────────────────────────────────────

  /**
   * Relational predicates (`$some` / `$none`) render as correlated
   * `[NOT] EXISTS` subqueries — in reads and in mutation filters alike.
   *
   * @since 0.1.147
   */
  override supportsRelationFilters(_mode: "read" | "write"): boolean {
    return true;
  }

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

  /**
   * Every unit: `pgCalendarBucket` renders them all over any zone in the
   * server's tz database (an unknown one maps to `BUCKET_TZ_UNAVAILABLE`).
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

  /** `$nulls` / `@db.sort.nulls` NULL placement — `NULLS FIRST` / `NULLS LAST`. */
  override supportsNullsPlacement(): boolean {
    return true;
  }

  /** Computed view columns and first-row joins. */
  override viewCapabilities(): ReadonlySet<TViewCapability> {
    return ALL_VIEW_CAPABILITIES;
  }

  // ── Annotation hooks ──────────────────────────────────────────────────────

  override onBeforeFlatten(_type: unknown): void {
    // PostgreSQL tables have no engine/charset/collation table-level options
  }

  override onAfterFlatten(): void {
    // Scan field descriptors for @db.collate 'nocase' — maps to CITEXT column type
    // (case-insensitive text). Extension is provisioned in ensureTable().
    const geo: string[] = [];
    for (const fd of this._table.fieldDescriptors) {
      if (fd.collate === "nocase") {
        this._nocaseColumns.add(fd.physicalName);
      }
      if (fd.isGeoPoint === true && !fd.encrypted) {
        geo.push(fd.physicalName);
      }
    }
    this._geoColumnNames = geo;
    this._geoFields = geo.length > 0;
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
    if (this._vectorFields.has(field.path)) {
      return {
        toStorage: (value: unknown) => (Array.isArray(value) ? `[${value.join(",")}]` : value),
        fromStorage: (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value),
      };
    }
    // geoPoint ↔ geography(Point,4326): EWKT text in, hex-EWKB parsed out.
    // Branches at call time on the COLUMN's physical type (learned from the
    // catalog after formatters are built — see `_geoNative`). A JSONB column
    // (no PostGIS, or created before it was installed) gets the value
    // untouched (the relational mapper's JSON handling already round-trips).
    // Not known yet: a `PendingGeoPoint` the executing statement resolves.
    if (field.isGeoPoint && !field.encrypted) {
      const column = field.physicalName;
      const native = (exec: TGeoProbeExecutor) => this._geoColumnNative(column, exec);
      return {
        toStorage: (value: unknown) => {
          if (this._supportsGeo === false) {
            return value;
          }
          const point = normalizeGeoPointValue(value);
          if (!point) {
            return value;
          }
          const known = this._geoNative.get(column);
          if (known === undefined) {
            return new PendingGeoPoint(point, value, native);
          }
          return known ? geoPointToEwkt(point) : value;
        },
        fromStorage: (value: unknown) => {
          if (typeof value === "string") {
            const point = parseEwkbPointHex(value);
            if (point) {
              return point;
            }
          }
          return value;
        },
      };
    }
    // node-postgres hands JSON / JSONB back parsed, while the relational
    // mapper parses a string read from a JSON column (SQLite stores text): a
    // JSON string value — a string member of a mixed union (since 0.1.155) —
    // is re-encoded so that parse gives the string back. A text column
    // (`@db.pg.type 'TEXT'`) already returns the JSON text.
    if (field.storage === "json" && !field.encrypted && PG_JSON_TYPE.test(this.typeMapper(field))) {
      return { toStorage: identity, fromStorage: reencodeJsonString };
    }
    return undefined;
  }

  // ── Error mapping ─────────────────────────────────────────────────────────

  /**
   * Wraps an async write operation to catch PostgreSQL constraint errors
   * and rethrow as structured `DbError`.
   *
   * PostgreSQL uses SQLSTATE codes:
   * - 23505 = unique_violation
   * - 23503 = foreign_key_violation
   * - 40P01 = deadlock_detected → `DEADLOCK`
   * - 55P03 = lock_not_available (`lock_timeout`, `NOWAIT`) → `LOCK_TIMEOUT`
   * - 40001 = serialization_failure → `SERIALIZATION_FAILURE`
   */
  private async _wrapConstraintError<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error: unknown) {
      return this._mapConstraintError(error);
    }
  }

  /** Rethrows `error` as a structured `DbError` when it is a unique / FK violation or a deadlock / lock timeout, else as is. */
  private _mapConstraintError(error: unknown): never {
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

      // Row-lock contention: retryable (deadlock_detected / lock_not_available)
      const contention = PG_CONTENTION_CODES[err.code];
      if (contention) {
        throw new DbError(contention, [{ path: "", message: err.message }]);
      }
    }
    throw error;
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
    const insert = buildInsert(this.resolveTableName(), data);
    // RETURNING the PK fields
    const sql = insert.sql + this._pk().returning;
    const params = insert.params;
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

    // Batch rows into multi-row INSERT statements over the column union of
    // ALL rows (PG max params is ~65535; chunked well under the limit).
    const { columns, batches } = chunkInsertRows(data);
    const run = async (): Promise<TDbInsertManyResult> => {
      const tableName = this.resolveTableName();
      const returningSuffix = this._pk().returning;
      const allIds: unknown[] = [];

      for (const batch of batches) {
        const insert = buildInsertMany(tableName, batch, columns);
        const sql = insert.sql + returningSuffix;
        const params = insert.params;
        this._log(sql, params);
        const result = await this._wrapConstraintError(() => this._exec().run(sql, params));

        // Map RETURNING rows back to insertedIds
        for (let i = 0; i < batch.length; i++) {
          const returned = result.rows?.[i];
          allIds.push(
            this._resolveInsertedId(batch[i], returned ? Object.values(returned)[0] : undefined),
          );
        }
      }

      return { insertedCount: allIds.length, insertedIds: allIds };
    };
    // One statement is atomic on its own: no BEGIN / COMMIT round trips (and
    // no held connection) around it. Several chunks commit together.
    return batches.length === 1 ? run() : this.withTransaction(run);
  }

  override supportsInsertIgnore(): boolean {
    return true;
  }

  /**
   * Batched `INSERT … VALUES (…), (…) ON CONFLICT DO NOTHING RETURNING <pk +
   * unique key columns>`: one statement per chunk (a conflict never raises, so
   * the surrounding transaction survives). Skipped rows are the ones missing
   * from RETURNING — mapped back by key values, see {@link mapIgnoredBatch}.
   * A multi-row chunk of a keyed table runs inside a SAVEPOINT: when the
   * mapping is ambiguous (a key the server returns in another form than it
   * was sent) the chunk is rolled back to the savepoint and redone row by row
   * with the same `ON CONFLICT DO NOTHING`, so the result is always exact. A
   * one-row chunk (or a table without keys) maps exactly by construction, so
   * it needs no savepoint — and a single such chunk no transaction either.
   * `ON CONFLICT DO NOTHING` takes no lock on a stored conflicting row, so a
   * caller's transaction is left without any. `opts.lockConflicts` (since
   * 0.1.153) locks them: one `SELECT … FOR UPDATE` of the stored rows matching
   * the batch's keys, in primary-key order, BEFORE the insert, and one more
   * for the skipped rows a concurrent writer committed in between.
   */
  override async insertManyIgnore(
    data: Array<Record<string, unknown>>,
    opts?: TDbInsertIgnoreOptions,
  ): Promise<TDbInsertIgnoreSlot[]> {
    if (data.length === 0) return [];
    if (opts?.lockConflicts && this._table.uniqueKeySets.length > 0) {
      return this.withTransaction(async () => {
        const locked = await this._lockKeyedRows(data);
        const slots = await this.insertManyIgnore(data);
        const raced = data.filter((_, i) => slots[i] === null && !locked.has(i));
        if (raced.length > 0) await this._lockKeyedRows(raced);
        return slots;
      });
    }
    const plan = this._ignorePlan();
    const { columns, batches } = chunkInsertRows(data);
    // Only a multi-row chunk of a keyed table can map ambiguously.
    const needsSavepoint = (batch: unknown[]) => batch.length > 1 && plan.returning.length > 0;
    const run = async (): Promise<TDbInsertIgnoreSlot[]> => {
      const tableName = this.resolveTableName();
      const { keySets, returning, nonTextKeyCols, returningSuffix } = plan;
      const pkCols = this._pk().cols;
      const insertedId = (row: Record<string, unknown>, returned?: Record<string, unknown>) => ({
        insertedId: this._resolveInsertedId(
          row,
          pkCols.length > 0 ? returned?.[pkCols[0]!] : undefined,
        ),
      });
      const slots: TDbInsertIgnoreSlot[] = [];

      for (const batch of batches) {
        const insert = buildInsertMany(tableName, batch, columns);
        const sql = `${insert.sql} ON CONFLICT DO NOTHING${returningSuffix}`;
        // The savepoint lets an ambiguous chunk be undone and redone row by row.
        const savepoint = needsSavepoint(batch);
        if (savepoint) {
          await this._exec().run(`SAVEPOINT ${IGNORE_SAVEPOINT}`);
        }
        this._log(sql, insert.params);
        const result = await this._wrapConstraintError(() => this._exec().run(sql, insert.params));
        const returned = result.rows ?? [];
        // No key at all (no PK, no unique index): nothing can collide.
        const mapping =
          returning.length === 0
            ? batch.map((_, i) => i)
            : mapIgnoredBatch(batch, returned, keySets, nonTextKeyCols);
        if (mapping) {
          if (savepoint) {
            await this._exec().run(`RELEASE SAVEPOINT ${IGNORE_SAVEPOINT}`);
          }
          mapping.forEach((hit, i) =>
            slots.push(hit < 0 ? null : insertedId(batch[i]!, returned[hit])),
          );
          continue;
        }
        // The returned rows cannot be matched back to the input (a key the
        // server normalizes, e.g. NUMERIC(10,2)): redo this chunk per row.
        // (Only a savepointed chunk gets here — a one-row mapping is exact.)
        await this._exec().run(`ROLLBACK TO SAVEPOINT ${IGNORE_SAVEPOINT}`);
        for (const row of batch) {
          const single = buildInsert(tableName, row);
          const rowSql = `${single.sql} ON CONFLICT DO NOTHING${returningSuffix}`;
          this._log(rowSql, single.params);
          const rowResult = await this._wrapConstraintError(() =>
            this._exec().run(rowSql, single.params),
          );
          slots.push(rowResult.rows?.length ? insertedId(row, rowResult.rows[0]) : null);
        }
      }
      return slots;
    };
    return batches.length === 1 && !needsSavepoint(batches[0]!) ? run() : this.withTransaction(run);
  }

  /**
   * `SELECT <key columns> … FOR UPDATE` of the stored rows sharing a primary /
   * unique key tuple with one of `rows`, ordered by the primary key (so
   * concurrent lockers queue instead of deadlocking); PostgreSQL locks only
   * the rows returned. Returns the indices of `rows` a locked row matched.
   */
  private async _lockKeyedRows(rows: Array<Record<string, unknown>>): Promise<Set<number>> {
    const keySets = this._table.uniqueKeySets.filter((f) => f.length > 0);
    const rowTuples = rows.map((row) => keySets.map((fields) => uniqueKeyTuple(row, fields)));
    const order = (this._pk().cols.length > 0 ? this._pk().cols : keySets[0]!)
      .map((c) => qi(c))
      .join(", ");
    const selectCols = [...new Set(keySets.flat())].map((c) => qi(c)).join(", ");
    const lockedTuples = keySets.map(() => new Set<string>());
    const width = keySets.reduce((n, f) => n + f.length, 0);
    const sliceSize = Math.max(1, Math.floor(30000 / width));
    for (let offset = 0; offset < rows.length; offset += sliceSize) {
      const end = Math.min(rows.length, offset + sliceSize);
      const clauses: string[] = [];
      const params: unknown[] = [];
      const ph = (value: unknown) => {
        params.push(pgDialect.toValue(value));
        return `$${params.length}`;
      };
      keySets.forEach((fields, k) => {
        const tuples: string[] = [];
        for (let i = offset; i < end; i++) {
          if (rowTuples[i]![k] === undefined) continue;
          const row = rows[i]!;
          tuples.push(`(${fields.map((f) => ph(row[f])).join(", ")})`);
        }
        if (tuples.length > 0) {
          clauses.push(`(${fields.map((f) => qi(f)).join(", ")}) IN (${tuples.join(", ")})`);
        }
      });
      if (clauses.length === 0) continue;
      const sql = `SELECT ${selectCols} FROM ${quoteTableName(this.resolveTableName())} WHERE ${clauses.join(" OR ")} ORDER BY ${order} FOR UPDATE`;
      this._log(sql, params);
      const found = await this._wrapConstraintError(() => this._exec().all(sql, params));
      for (const doc of found) {
        keySets.forEach((fields, k) => {
          const tuple = uniqueKeyTuple(doc, fields);
          if (tuple !== undefined) lockedTuples[k]!.add(tuple);
        });
      }
    }
    const locked = new Set<number>();
    rowTuples.forEach((tuples, i) => {
      if (tuples.some((t, k) => t !== undefined && lockedTuples[k]!.has(t))) locked.add(i);
    });
    return locked;
  }

  /**
   * The key columns of a conflict-ignoring insert (built once per table):
   * every primary / unique key set, their RETURNING list, and the key columns
   * whose physical type is not text (see {@link mapIgnoredBatch}). Keyed on the
   * detected extension state the type mapper reads.
   */
  private _ignorePlan(): TPgIgnorePlan {
    const key = `${this._supportsGeo}|${this._supportsVector}`;
    const memo = this._ignorePlanMemo;
    if (memo?.key === key) return memo;
    const keySets = this._table.uniqueKeySets;
    const returning = [...new Set(keySets.flat())];
    const returningCols = new Set(returning);
    const nonTextKeyCols = new Set(
      this._table.fieldDescriptors
        .filter((f) => returningCols.has(f.physicalName) && !isTextKeyType(this.typeMapper(f)))
        .map((f) => f.physicalName),
    );
    const returningSuffix =
      returning.length > 0 ? ` RETURNING ${returning.map((c) => qi(c)).join(", ")}` : "";
    this._ignorePlanMemo = { key, keySets, returning, nonTextKeyCols, returningSuffix };
    return this._ignorePlanMemo;
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
      pgDialect,
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
    // Grouped-search contract: see `resolveAggregateSearch`. `_buildSearchWhere`
    // is the leaf path's own predicate builder — it contributes a WHERE fragment
    // only, which the row query and the `$count` subquery then share.
    const search = resolveAggregateSearch(query.controls);
    const where = search
      ? this._buildSearchWhere(search.text, query, search.indexName)
      : buildWhere(query.filter);
    const tableName = this.resolveTableName();

    if (query.controls.$count) {
      const { sql, params } = buildAggregateCount(tableName, where, query.controls);
      this._log(sql, params);
      const row = await mapQueryErrors(
        pgDialect,
        () => this._exec().get<{ count: number | string }>(sql, params),
        query.controls,
      );
      const count = parseCount(row?.count);
      return [{ count }];
    }

    const { sql, params } = buildAggregateSelect(tableName, where, query.controls);
    this._log(sql, params);
    return mapQueryErrors(pgDialect, () => this._exec().all(sql, params), query.controls);
  }

  // ── CRUD: Update ──────────────────────────────────────────────────────────

  /**
   * Physical primary-key columns (`@db.column` renames applied) and their
   * ` RETURNING …` clause (empty without a PK) — built once per table.
   */
  private _pk(): { cols: string[]; returning: string } {
    const src = this._table.primaryKeys;
    let memo = this._pkColumnsMemo;
    if (memo?.src !== src) {
      const cols = src.map((key) => this._table.physicalPath(key));
      const returning = cols.length > 0 ? ` RETURNING ${cols.map((c) => qi(c)).join(", ")}` : "";
      memo = this._pkColumnsMemo = { src, cols, returning };
    }
    return memo;
  }

  /**
   * Whether `filter` pins at most one row by itself: a plain object holding
   * exactly the primary-key columns, each equal to a scalar (`{ id: 5 }` or
   * `{ id: { $eq: 5 } }`) — what the core sends for a by-id write. Such a
   * filter needs no `LIMIT 1` re-keying subquery: the outer predicate is the
   * PK equality either way.
   */
  private _isExactPkFilter(filter: FilterExpr): boolean {
    const pk = this._pk().cols;
    if (pk.length === 0 || typeof filter !== "object" || filter === null || Array.isArray(filter)) {
      return false;
    }
    const f = filter as Record<string, unknown>;
    if (Object.keys(f).length !== pk.length) {
      return false;
    }
    for (const col of pk) {
      if (!Object.hasOwn(f, col)) {
        return false;
      }
      let value = f[col];
      if (
        typeof value === "object" &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype
      ) {
        const ops = Object.keys(value);
        if (ops.length !== 1 || ops[0] !== "$eq") {
          return false;
        }
        value = (value as { $eq: unknown }).$eq;
      }
      const t = typeof value;
      if (t !== "string" && t !== "number" && t !== "bigint" && t !== "boolean") {
        return false;
      }
    }
    return true;
  }

  /**
   * The predicate that narrows a single-row UPDATE/DELETE to the first row
   * matching `whereSql`: `<key> <op> (SELECT <cols> … LIMIT 1)`. Single-col
   * PKs use `<col> = (SELECT <col> …)`; composite PKs the row-constructor form
   * `(c1, c2) IN (SELECT c1, c2 …)`. Tables with no declared PK fall back to
   * ctid — concurrency on PK-less tables is already ill-defined; preserve
   * existing behavior rather than guess.
   */
  private _limitOnePredicate(quotedTable: string, whereSql: string): string {
    const pkCols = this._pk().cols;
    const quotedKeys = pkCols.length > 0 ? pkCols.map((c) => qi(c)) : ["ctid"];
    const colList = quotedKeys.join(", ");
    const keyMatch = quotedKeys.length === 1 ? `${colList} =` : `(${colList}) IN`;
    return `${keyMatch} (SELECT ${colList} FROM ${quotedTable} WHERE ${whereSql} LIMIT 1)`;
  }

  // oxlint-disable-next-line max-params
  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    expectedVersion?: number,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    // PostgreSQL does not support UPDATE ... LIMIT 1.
    // Re-key the outer UPDATE on the primary key (a stable column) via a subquery.
    // Keying on ctid would lose concurrent writes: ctid is a physical tuple pointer
    // that changes on every UPDATE, and SELECT ctid takes no row lock, so two
    // parallel updaters can both capture the same ctid, have T1's commit invalidate
    // it, then T2 matches zero rows and silently drops the update. A PK predicate
    // lets Postgres' EvalPlanQual recovery follow the updated tuple under READ
    // COMMITTED, so both UPDATEs serialize on the row lock and both take effect.
    // An exact primary-key filter already pins one row: no subquery.
    const where = buildWhere(filter);
    const tableName = this.resolveTableName();
    const limitedWhere = this._isExactPkFilter(filter)
      ? where
      : {
          sql: this._limitOnePredicate(quoteTableName(tableName), where.sql),
          params: where.params,
        };
    const versionColumn = this._versionColumnFor(opts, expectedVersion);
    const { sql, params } = buildUpdate(
      tableName,
      data,
      limitedWhere,
      undefined,
      ops,
      versionColumn,
      expectedVersion,
    );
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { matchedCount: result.affectedRows, modifiedCount: result.affectedRows };
  }

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    const where = buildWhere(filter);
    const versionColumn = this._versionColumnFor(opts);
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
    return { matchedCount: result.affectedRows, modifiedCount: result.affectedRows };
  }

  // ── CRUD: Replace ─────────────────────────────────────────────────────────

  async replaceOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    // Use UPDATE instead of DELETE+INSERT to avoid triggering CASCADE deletes.
    // Full replace (since 0.1.128): every column is assigned — omitted ones
    // become NULL, native function defaults (`now` / `uuid` / `increment`)
    // re-apply their DDL DEFAULT — matching the document adapters' whole-row
    // replace instead of silently merging with the old row.
    const full = fillReplacePayload(
      data,
      this._replaceColumns(),
      this._table.versionColumnPhysical,
    );
    // No `opts`: a replace touches every column, so it always bumps.
    return this.updateOne(filter, full, undefined, expectedVersion);
  }

  /** The columns a full replace assigns (`replaceColumnsFor`), built once per table. */
  private _replaceColumns(): ReturnType<typeof replaceColumnsFor> {
    const src = this._table.fieldDescriptors;
    let memo = this._replaceColumnsMemo;
    if (memo?.src !== src) {
      memo = this._replaceColumnsMemo = {
        src,
        cols: replaceColumnsFor(src, this.nativeDefaultFns()),
      };
    }
    return memo.cols;
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    return this.updateMany(filter, data);
  }

  // ── CRUD: Delete ──────────────────────────────────────────────────────────

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    // PostgreSQL does not support DELETE ... LIMIT 1 — re-key the outer DELETE
    // on the primary key via a subquery, for the same reason as updateOne:
    // a ctid key silently deletes NOTHING when a concurrent UPDATE of the row
    // commits first (the new tuple has a new ctid, so the EvalPlanQual recheck
    // fails), while a PK predicate follows the updated tuple. The filter is
    // repeated on the outer DELETE so that recheck also re-applies it — a row
    // updated out of the filter meanwhile is left alone, as a plain
    // `DELETE … WHERE <filter>` would. An exact primary-key filter already
    // pins one row: a plain `DELETE … WHERE <pk> = ?`.
    const where = buildWhere(filter);
    if (this._isExactPkFilter(filter)) {
      return this._deleteWhere(where);
    }
    const quotedTable = quoteTableName(this.resolveTableName());
    const raw = {
      sql: `DELETE FROM ${quotedTable} WHERE ${where.sql} AND ${this._limitOnePredicate(quotedTable, where.sql)}`,
      params: [...where.params, ...where.params],
    };
    const { sql, params } = finalizeParams(pgDialect, raw);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { deletedCount: result.affectedRows };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    return this._deleteWhere(buildWhere(filter));
  }

  private async _deleteWhere(where: TSqlFragment): Promise<TDbDeleteResult> {
    const { sql, params } = buildDelete(this.resolveTableName(), where);
    this._log(sql, params);
    const result = await this._wrapConstraintError(() => this._exec().run(sql, params));
    return { deletedCount: result.affectedRows };
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  async prepareTypeMapper(): Promise<void> {
    if (this._supportsVector === undefined && this._vectorFields.size > 0) {
      await this._detectVectorSupport();
    }
    if (!this._geoInstallTried && this._hasGeoPointFields()) {
      await this._detectGeoSupport();
    }
  }

  /**
   * Whether the table declares any `db.geoPoint` fields (unencrypted) — set
   * when the metadata is built (`false` before, and on an administrative
   * adapter: no geo value can be formatted without built metadata).
   */
  private _hasGeoPointFields(): boolean {
    return this._geoFields === true;
  }

  async ensureTable(opts?: TEnsureTableOptions): Promise<void> {
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
    await this.prepareTypeMapper();
    // @db.schema targets a named schema — sync owns DDL, so it must also
    // ensure the namespace exists (fresh databases have only "public")
    if (this._schema) {
      await this._exec().exec(`CREATE SCHEMA IF NOT EXISTS ${qi(this._schema)}`);
    }
    // Structural check (never `instanceof`): a bundle may carry two copies of
    // @atscript/db, and a false `instanceof` would create an empty table here.
    if (this._table.isView) {
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
        deferForeignKeysTo: opts?.deferForeignKeysTo,
      },
    );
    this._log(sql);
    await this._exec().exec(sql);
  }

  // ── Schema sync primitives (since 0.1.128) ─────────────────────────────

  /** `schema.name` when the adapter targets a named schema. */
  private _qualify(name: string): string {
    return quoteTableName(this._schema ? `${this._schema}.${name}` : name);
  }

  async hasRows(tableName?: string): Promise<boolean> {
    const target = tableName ? this._qualify(tableName) : quoteTableName(this.resolveTableName());
    const sql = `SELECT EXISTS (SELECT 1 FROM ${target}) AS "present"`;
    this._log(sql);
    const row = await this._exec().get<{ present: boolean }>(sql, []);
    return row?.present ?? false;
  }

  async countKeyViolations(columns: readonly string[], tableName?: string): Promise<number> {
    const target = tableName ? this._qualify(tableName) : quoteTableName(this.resolveTableName());
    const sql = buildKeyViolationCount(pgDialect, target, columns);
    this._log(sql);
    const row = await this._exec().get<{ violations: number | string }>(sql, []);
    return Number(row?.violations ?? 0);
  }

  /**
   * Live foreign keys referencing `tableName`, via `pg_constraint` — exact for
   * composite keys (`conkey`/`confkey` are positionally aligned, unlike the
   * `key_column_usage` ordinal join).
   */
  async getReferencingForeignKeys(tableName: string): Promise<TReferencingForeignKey[]> {
    const rows = await this._exec().all<{
      table_name: string;
      constraint_name: string;
      columns: string[] | null;
      ref_columns: string[] | null;
    }>(
      `SELECT cl.relname AS table_name, c.conname AS constraint_name,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_columns
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_class rcl ON rcl.oid = c.confrelid
       JOIN pg_namespace rn ON rn.oid = rcl.relnamespace
       WHERE c.contype = 'f' AND rcl.relname = $1 AND rn.nspname = COALESCE($2, current_schema())
       ORDER BY cl.relname, c.conname`,
      [tableName, this._schema],
    );
    return rows.map((r) => ({
      table: r.table_name,
      fields: r.columns ?? [],
      targetFields: r.ref_columns ?? [],
    }));
  }

  async getObjectKind(name: string): Promise<TDbObjectKind | undefined> {
    const row = await this._exec().get<{ relkind: string }>(
      `SELECT c.relkind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1 AND n.nspname = COALESCE($2, current_schema())
         AND c.relkind IN ('r', 'p', 'v', 'm')`,
      [name, this._schema],
    );
    switch (row?.relkind) {
      case "r":
      case "p": {
        return "table";
      }
      case "v": {
        return "view";
      }
      case "m": {
        return "materialized";
      }
      default: {
        return undefined;
      }
    }
  }

  /** One multi-table `DROP TABLE a, b` — PostgreSQL resolves the mutual FKs inside the set. No CASCADE. */
  override async dropTablesByName(tableNames: string[]): Promise<void> {
    if (tableNames.length === 0) {
      return;
    }
    const ddl = `DROP TABLE IF EXISTS ${tableNames.map((n) => this._qualify(n)).join(", ")}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  /**
   * `ALTER TABLE … DROP CONSTRAINT <pk>, ADD PRIMARY KEY (…)` in ONE statement
   * (atomic: rows a concurrent write made violate the new key fail it with
   * the old key in place). Called on an empty table or one whose rows satisfy
   * the new key; `ADD PRIMARY KEY` makes the new key columns NOT NULL. A demoted identity column is handled by the
   * `defaultChanged` diff (`DROP IDENTITY`).
   */
  async rebuildPrimaryKey(change: TPrimaryKeyChange): Promise<void> {
    const clauses: string[] = [];
    if (change.from.length > 0) {
      const row = await this._exec().get<{ conname: string }>(
        `SELECT c.conname FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
         WHERE c.contype = 'p' AND cl.relname = $1 AND n.nspname = COALESCE($2, current_schema())`,
        [this._table.tableName, this._schema],
      );
      if (row?.conname) {
        clauses.push(`DROP CONSTRAINT ${qi(row.conname)}`);
      }
    }
    if (change.to.length > 0) {
      clauses.push(`ADD PRIMARY KEY (${change.to.map((c) => qi(c)).join(", ")})`);
    }
    if (clauses.length === 0) {
      return;
    }
    const ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} ${clauses.join(", ")}`;
    this._log(ddl);
    await this._exec().exec(ddl);
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

  /** Live columns of `tableName`, read through `exec` (the recreate's own connection, or the pool). */
  private async _readColumns(
    exec: Pick<TPgDriver, "all">,
    tableName: string,
  ): Promise<TExistingColumn[]> {
    const schema = this._schema;
    const rows = await exec.all<{
      column_name: string;
      data_type: string;
      udt_name: string;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
      is_generated: string;
      formatted_type: string;
      is_pk: boolean;
    }>(
      `SELECT c.column_name, c.data_type, c.udt_name, c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.is_nullable, c.column_default, c.is_identity, c.is_generated,
              format_type(a.atttypid, a.atttypmod) AS formatted_type,
              EXISTS (
                SELECT 1 FROM pg_index i
                WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
              ) AS is_pk
       FROM information_schema.columns c
       JOIN pg_attribute a ON a.attname = c.column_name
         AND a.attrelid = (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = COALESCE($2, current_schema())))
       WHERE c.table_name = $1 AND c.table_schema = COALESCE($2, current_schema())
       ORDER BY c.ordinal_position`,
      [tableName, schema],
    );

    return rows.map((r) => {
      const column: TExistingColumn = {
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
        pk: r.is_pk,
        dflt_value: normalizePgDefault(r.column_default, r.is_identity),
      };
      if (r.is_generated === "ALWAYS") {
        column.generated = true;
      }
      return column;
    });
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

    // Adds. The derived (STORED generated) columns go in ONE statement after
    // the others: PostgreSQL computes them for every existing row as part of
    // the ADD COLUMN — a table rewrite — so several derived adds rewrite once.
    const derivedAdds: string[] = [];
    for (const field of diff.added) {
      const sqlType = this.typeMapper(field);
      if (field.derived) {
        derivedAdds.push(`ADD COLUMN ${pgDerivedColumnDef(field, sqlType)}`);
        added.push(field.physicalName);
        continue;
      }
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
      ddl += pgCollateClause(field);
      this._log(ddl);
      await this._exec().exec(ddl);
      added.push(field.physicalName);
    }
    if (derivedAdds.length > 0) {
      const ddl = `ALTER TABLE ${quoteTableName(tableName)} ${derivedAdds.join(", ")}`;
      this._log(ddl);
      await this._exec().exec(ddl);
    }

    // Type changes — PostgreSQL supports ALTER TABLE ALTER COLUMN TYPE
    // USING clause required when no implicit cast exists (e.g., TEXT → INTEGER)
    // Double-cast via TEXT as intermediate handles most non-trivial transitions.
    // (A derived column never appears here — its type drift is a derived
    // rebuild, drop + add: a generated column's type cannot be altered with USING.)
    for (const { field } of diff.typeChanged ?? []) {
      const sqlType = this.typeMapper(field);
      const col = qi(field.physicalName);
      const ddl = `ALTER TABLE ${quoteTableName(tableName)} ALTER COLUMN ${col} TYPE ${sqlType} USING ${convertColumnExpr(col, field, sqlType)}`;
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

    // Default value changes. Identity columns (`@db.default.increment`) are
    // not defaults: introspection reports them as `fn:increment`, and they
    // are added/removed with ADD GENERATED / DROP IDENTITY — SET/DROP DEFAULT
    // is rejected on them.
    for (const { field, oldDefault } of diff.defaultChanged ?? []) {
      const col = `ALTER TABLE ${quoteTableName(tableName)} ALTER COLUMN ${qi(field.physicalName)}`;
      const wasIdentity = oldDefault === "fn:increment";
      const statements: string[] = [];
      if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "increment") {
        if (!wasIdentity) {
          if (oldDefault !== undefined) {
            statements.push(`${col} DROP DEFAULT`);
          }
          statements.push(`${col} SET NOT NULL`, `${col} ADD GENERATED BY DEFAULT AS IDENTITY`);
        }
      } else {
        if (wasIdentity) {
          statements.push(`${col} DROP IDENTITY IF EXISTS`);
        }
        if (field.defaultValue?.kind === "value") {
          statements.push(
            `${col} SET DEFAULT ${defaultValueToSqlLiteral(field.designType, field.defaultValue.value)}`,
          );
        } else if (field.defaultValue?.kind === "fn") {
          const fnExpr =
            field.defaultValue.fn === "now"
              ? "(extract(epoch from now()) * 1000)::bigint"
              : "gen_random_uuid()";
          statements.push(`${col} SET DEFAULT ${fnExpr}`);
        } else if (!wasIdentity) {
          statements.push(`${col} DROP DEFAULT`);
        }
      }
      for (const ddl of statements) {
        this._log(ddl);
        await this._exec().exec(ddl);
      }
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

      // Save and drop FK constraints from OTHER tables that reference this
      // table — whether they reference its primary key or a UNIQUE
      // constraint. Read from `pg_constraint`: `conkey` / `confkey` are
      // positionally aligned, so a multi-column FK's pairs line up, and a
      // constraint is identified by its table — names are unique per table,
      // not per schema. Each is restored below under its captured name.
      // The table's own self-referencing FKs are not captured: the old table
      // goes away with them and the executor's `syncForeignKeys` re-adds them
      // on the recreated table (its CREATE omits them, see below).
      const fkRefs = await conn.all<{
        constraint_name: string;
        table_name: string;
        table_schema: string;
        column_name: string;
        ref_column_name: string;
        delete_rule: string;
        update_rule: string;
      }>(
        `SELECT c.conname AS constraint_name, cl.relname AS table_name, n.nspname AS table_schema,
                a.attname AS column_name, ra.attname AS ref_column_name,
                CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
                  WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS delete_rule,
                CASE c.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
                  WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS update_rule
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_class rcl ON rcl.oid = c.confrelid
         JOIN pg_namespace rn ON rn.oid = rcl.relnamespace
         CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
         JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.refattnum
         WHERE c.contype = 'f' AND rcl.relname = $2 AND rn.nspname = COALESCE($1, current_schema())
         ORDER BY n.nspname, cl.relname, c.conname, k.ord`,
        [schema, this._table.tableName],
      );

      // Group FK refs per constraint (table + name) for multi-column FKs
      const inboundFks = new Map<
        string,
        {
          name: string;
          schema: string;
          table: string;
          cols: string[];
          refCols: string[];
          onDelete: string;
          onUpdate: string;
        }
      >();
      const ownSchema =
        schema ?? (await conn.get<{ s: string }>("SELECT current_schema() AS s"))?.s ?? "public";
      for (const fk of fkRefs) {
        if (fk.table_schema === ownSchema && fk.table_name === this._table.tableName) {
          continue;
        }
        const key = `${fk.table_schema}.${fk.table_name}.${fk.constraint_name}`;
        let entry = inboundFks.get(key);
        if (!entry) {
          entry = {
            name: fk.constraint_name,
            schema: fk.table_schema,
            table: fk.table_name,
            cols: [],
            refCols: [],
            onDelete: fk.delete_rule,
            onUpdate: fk.update_rule,
          };
          inboundFks.set(key, entry);
        }
        entry.cols.push(fk.column_name);
        entry.refCols.push(fk.ref_column_name);
      }

      // Drop FK constraints
      for (const fk of inboundFks.values()) {
        const ddl = `ALTER TABLE ${qi(fk.schema)}.${qi(fk.table)} DROP CONSTRAINT IF EXISTS ${qi(fk.name)}`;
        this._log(ddl);
        await conn.exec(ddl);
      }

      // 1. Create new table with temp name. A self-referencing FK would
      //    point at the OLD table (and block its drop): it is left out, and
      //    `syncForeignKeys` adds it to the recreated table afterwards.
      const createSql = buildCreateTable(
        tempName,
        this._table.fieldDescriptors,
        this._table.foreignKeys,
        {
          incrementFields: this._incrementFields,
          autoIncrementStart: this._autoIncrementStart,
          typeMapper: (field) => this.typeMapper(field),
          deferForeignKeysTo: new Set([this._table.tableName]),
        },
      );
      this._log(createSql);
      await conn.exec(createSql);

      // 2. Get columns that exist in both old and new, with their live types
      //    (query via conn, not pool)
      const oldTypes = new Map(
        (await this._readColumns(conn, this._table.tableName)).map((c) => [c.name, c.type]),
      );
      // Generated (derived) columns are computed, never inserted — the new
      // table recomputes them from the copied JSON source.
      const commonFields = this._table.storedDescriptors.filter((f) =>
        oldTypes.has(f.physicalName),
      );

      if (commonFields.length > 0) {
        // 3. Copy data. A column whose type changed is converted to its new
        //    type first, as an in-place ALTER COLUMN TYPE would: PostgreSQL
        //    types a COALESCE by its first argument, so the old column would
        //    make it parse the new type's fallback (`''` for a string) as the
        //    OLD type. A value that does not convert fails the INSERT and the
        //    transaction rolls back.
        const colNames = commonFields.map((f) => qi(f.physicalName)).join(", ");
        const selectExprs = commonFields
          .map((field) => {
            const c = qi(field.physicalName);
            const sqlType = this.typeMapper(field);
            const changed = isColumnTypeChanged(oldTypes.get(field.physicalName)!, sqlType);
            const value = changed ? convertColumnExpr(c, field, sqlType) : c;
            if (!field.optional && !field.isPrimaryKey) {
              const fallback =
                field.defaultValue?.kind === "value"
                  ? defaultValueToSqlLiteral(field.designType, field.defaultValue.value)
                  : defaultValueForType(field.designType);
              return `COALESCE(${value}, ${fallback}) AS ${c}`;
            }
            return changed ? `${value} AS ${c}` : c;
          })
          .join(", ");
        const copySql = `INSERT INTO ${quoteTableName(tempName)} (${colNames}) SELECT ${selectExprs} FROM ${quoteTableName(tableName)}`;
        this._log(copySql);
        await conn.exec(copySql);
      }

      // 4. Drop old, rename new. Never CASCADE: an object outside the sync
      //    inventory (a user view, an unmanaged FK) still depending on the
      //    table makes PostgreSQL refuse (2BP01) — the transaction rolls back
      //    and the error names the dependent object (see the catch below).
      const dropSql = `DROP TABLE IF EXISTS ${quoteTableName(tableName)}`;
      this._log(dropSql);
      await conn.exec(dropSql);
      await conn.exec(
        `ALTER TABLE ${quoteTableName(tempName)} RENAME TO ${qi(this._table.tableName)}`,
      );

      // The temp table was created with unnamed constraints, so after the
      // RENAME they still carry PostgreSQL's names for the temp table
      // (`<tmp>_pkey`, `<tmp>_<col>_fkey`, `<tmp>_<col>_key`); rename them to
      // the names the final table would have given them. The old table is
      // gone, so its names are free — a target that still exists is skipped
      // (logged), never overwritten.
      await this._renameTempConstraints(conn, baseTempName);

      // 5. Restore FK constraints from other tables under their captured names
      const resolvedTable = this.resolveTableName();
      for (const fk of inboundFks.values()) {
        const localCols = fk.cols.map((c) => qi(c)).join(", ");
        const refCols = fk.refCols.map((c) => qi(c)).join(", ");
        let ddl = `ALTER TABLE ${qi(fk.schema)}.${qi(fk.table)} ADD CONSTRAINT ${qi(fk.name)} FOREIGN KEY (${localCols}) REFERENCES ${quoteTableName(resolvedTable)} (${refCols})`;
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
      this._geoSchemaChanged();

      // Reset identity sequences after data copy — the INSERT INTO ... SELECT
      // uses explicit values, so the sequence doesn't advance. Runs on the
      // pool after COMMIT: a failure here rejects a recreate that has already
      // committed (accepted — the next run's `afterSyncTable` retries it).
      await this._resetIdentitySequences();
    } catch (err) {
      await conn.exec("ROLLBACK").catch(() => {});
      this._geoSchemaChanged();
      // PostgreSQL puts the dependent object of a refused DROP (2BP01) — and
      // the offending row of a failed FK restore — in `detail`; carry it so
      // the schema-sync error entry names it (the same error is rethrown, so
      // `code` / `detail` stay readable on it).
      const detail = (err as { detail?: unknown }).detail;
      if (err instanceof Error && typeof detail === "string" && detail.length > 0) {
        err.message = `${err.message} — ${detail}`;
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Renames the recreated table's auto-named constraints from the temp
   * table's names to the final table's: `<tmp>_pkey` → `<table>_pkey`,
   * `<tmp>_<cols>_fkey` → `<table>_<cols>_fkey`, and so on. Runs inside the
   * recreate transaction, after the RENAME. A constraint is recognised by
   * its kind and columns — its name equals the one PostgreSQL generates for
   * the temp table ({@link pgObjectName}, 63-byte truncation included) — so
   * a long table name matches too. A target name already taken (a primary /
   * unique constraint's index shares its name with every relation in the
   * schema; other kinds with the table's constraints) is skipped and logged.
   */
  private async _renameTempConstraints(conn: TPgConnection, baseTempName: string): Promise<void> {
    const table = this._table.tableName;
    const rows = await conn.all<{ conname: string; contype: string; columns: string[] | null }>(
      `SELECT c.conname, c.contype,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE cl.relname = $1 AND n.nspname = COALESCE($2, current_schema())
       ORDER BY c.conname`,
      [table, this._schema],
    );
    const taken = new Set(rows.map((r) => r.conname));
    for (const { conname, contype, columns } of rows) {
      const label = PG_CONSTRAINT_LABELS[contype];
      if (!label) {
        continue;
      }
      const cols = contype === "p" ? [] : (columns ?? []);
      if (conname !== pgObjectName(baseTempName, cols, label)) {
        continue;
      }
      const target = pgObjectName(table, cols, label);
      if (target === conname) {
        // Both names truncate to the same identifier — nothing to rename
        continue;
      }
      const clash =
        contype === "p" || contype === "u"
          ? await this._relationExists(conn, target)
          : taken.has(target);
      if (clash) {
        this._log(`-- constraint "${conname}" keeps its name: "${target}" already exists`);
        continue;
      }
      const ddl = `ALTER TABLE ${quoteTableName(this.resolveTableName())} RENAME CONSTRAINT ${qi(conname)} TO ${qi(target)}`;
      this._log(ddl);
      await conn.exec(ddl);
      taken.add(target);
    }
  }

  /** Whether a relation (table, index, view, …) named `name` exists in this adapter's schema. */
  private async _relationExists(conn: TPgConnection, name: string): Promise<boolean> {
    const row = await conn.get<{ present: boolean }>(
      `SELECT true AS present FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1 AND n.nspname = COALESCE($2, current_schema())`,
      [name, this._schema],
    );
    return row?.present ?? false;
  }

  async afterSyncTable(): Promise<void> {
    await this._resetIdentitySequences();
    // Learn the geo column types while syncing, so writes never probe after
    // a sync. Best effort — the first geo write probes when this did not.
    if (this._geoFields && this._supportsGeo === true && this._geoNative.size === 0) {
      await this._probeGeo(this._txConnection() ?? this.driver).catch(() => undefined);
    }
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
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = COALESCE($2, current_schema())) AS "exists"`,
      [this._table.tableName, this._schema],
    );
    return row?.exists ?? false;
  }

  /**
   * No CASCADE: when something outside the sync inventory (a user view, an
   * unmanaged FK) still depends on the table PostgreSQL refuses, and schema
   * sync reports that as an error entry instead of silently dropping the
   * dependents.
   */
  async dropTable(): Promise<void> {
    const ddl = `DROP TABLE IF EXISTS ${quoteTableName(this.resolveTableName())}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  async copyFromJsonColumn(source: string, targets: readonly TJsonCopyTarget[]): Promise<void> {
    // `#>>` yields text: a scalar target is cast to its column type (a value
    // that does not convert fails the sync); booleans and JSON keep theirs. A
    // `VARCHAR(n)` / `CHAR(n)` target takes the text by assignment, which
    // fails on overflow where an explicit cast would truncate.
    const sql = buildJsonColumnCopy(
      pgDialect,
      this.resolveTableName(),
      source,
      targets,
      (expr, target) => {
        if (target.kind !== "text") return expr;
        const type = this.typeMapper(target.field);
        return /^(VARCHAR|CHAR)\b/i.test(type) ? expr : `(${expr})::${type}`;
      },
    );
    this._log(sql);
    await this._exec().exec(sql);
  }

  async jsonifyTextColumn(column: string): Promise<void> {
    const sql = buildJsonifyText(pgDialect, this.resolveTableName(), column);
    this._log(sql);
    await this._exec().exec(sql);
  }

  async dropColumns(columns: string[]): Promise<void> {
    const tableName = this.resolveTableName();
    const drops = columns.map((col) => `DROP COLUMN ${qi(col)}`).join(", ");
    const ddl = `ALTER TABLE ${quoteTableName(tableName)} ${drops}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  async dropIndexesForColumns(columns: string[]): Promise<void> {
    const tableName = this._table.tableName;
    const schema = this._schema;
    const rows = await this._exec().all<{ name: string }>(
      `SELECT DISTINCT i.relname AS name
       FROM pg_index x
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
       WHERE t.relname = $1 AND n.nspname = COALESCE($2, current_schema())
         AND i.relname LIKE 'atscript__%' AND a.attname = ANY($3)`,
      [tableName, schema, columns],
    );
    for (const row of rows) {
      const sql = `DROP INDEX IF EXISTS ${schema ? `${qi(schema)}.` : ""}${qi(row.name)}`;
      this._log(sql);
      await this._exec().exec(sql);
    }
  }

  override async dropTableByName(tableName: string): Promise<void> {
    const ddl = `DROP TABLE IF EXISTS ${quoteTableName(tableName)}`;
    this._log(ddl);
    await this._exec().exec(ddl);
  }

  override async dropViewByName(viewName: string): Promise<void> {
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
    if (field.encrypted) {
      // Ciphertext envelope: unbounded text, plaintext-length-dependent.
      return "TEXT";
    }
    // Vector fields → vector(N) when pgvector is available, JSONB otherwise
    if (this._vectorFields.has(field.path)) {
      const vec = this._vectorFields.get(field.path)!;
      return this._supportsVector ? `vector(${vec.dimensions})` : "JSONB";
    }
    // geoPoint → geography(Point,4326) when PostGIS is available, JSONB otherwise
    if (field.isGeoPoint) {
      return this._supportsGeo ? "geography(Point,4326)" : pgTypeFromField(field);
    }
    return pgTypeFromField(field);
  }

  // ── Index sync ────────────────────────────────────────────────────────────

  async syncIndexes(): Promise<void> {
    const tableName = this._table.tableName;
    const schema = this._schema;
    // Resolve PostGIS availability before index DDL (idempotent; usually
    // already resolved by ensureTable/schema sync).
    await this.prepareTypeMapper();

    await this.syncIndexesWithDiff({
      listExisting: async () => {
        // ::text cast — pg has no parser for name[], it would arrive as the
        // string "{col1,col2}" and wrongly trip the definition-drift rebuild.
        const rows = await this._exec().all<{ name: string; columns: string[] | null }>(
          `SELECT i.relname AS name,
                  (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                   WHERE k.attnum > 0) AS columns
           FROM pg_index x
           JOIN pg_class t ON t.oid = x.indrelid
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE t.relname = $1 AND n.nspname = COALESCE($2, current_schema())`,
          [tableName, schema],
        );
        return rows.map((r) => ({ name: r.name, columns: r.columns ?? undefined }));
      },
      createIndex: async (index: TDbIndex) => {
        if (index.type === "fulltext") {
          // GIN index on tsvector expression (text members only — integer
          // members are matched by exact number, never part of the index)
          const textFields = splitFulltextFields(index).text;
          if (textFields.length === 0) return;
          const tsvectorExpr = this._buildTsvectorExpr(textFields);
          const sql = `CREATE INDEX IF NOT EXISTS ${qi(index.key)} ON ${quoteTableName(this.resolveTableName())} USING gin(to_tsvector('english', ${tsvectorExpr}))`;
          this._log(sql);
          await this._exec().exec(sql);
          return;
        }
        if (index.type === "geo") {
          if (!this._supportsGeo) {
            this.logger.warn(
              `[postgres] geo index "${index.name}" declared but PostGIS is not available — skipped`,
            );
            return;
          }
          const sql = `CREATE INDEX IF NOT EXISTS ${qi(index.key)} ON ${quoteTableName(this.resolveTableName())} USING gist (${qi(index.fields[0].name)})`;
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
      desiredFkKeys.add([...fkColumns(fk).fields].toSorted().join(","));
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
      `SELECT c.conname AS constraint_name, a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f' AND cl.relname = $1 AND n.nspname = COALESCE($2, current_schema())
       ORDER BY c.conname, k.ord`,
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
    // Built once per table (the index set is fixed); callers get their own array.
    const src = this._table.indexes;
    let memo = this._searchIndexesMemo;
    if (memo?.src !== src) {
      memo = this._searchIndexesMemo = { src, list: this._buildSearchIndexes() };
    }
    return [...memo.list];
  }

  private _buildSearchIndexes(): TSearchIndexInfo[] {
    const indexes: TSearchIndexInfo[] = [];
    // The default text index is the first one with a TEXT member (else the first).
    const { all: ftAll, def: ftDefault } = this._fulltextIndexes();
    for (const index of ftAll) {
      indexes.push({
        name: index.key,
        description: describeFulltext(index, (names) => `GIN tsvector index on ${names}`),
        type: "text",
        fields: this._indexLogicalPaths(index),
        isDefault: index === ftDefault,
      });
    }
    // Add vector indexes
    let firstVector = true;
    for (const [field, vec] of this._vectorFields) {
      indexes.push({
        name: vec.indexName,
        description: `vector(${vec.dimensions}) on ${field}, ${vec.similarity}`,
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
    const { text: textFields, integer: integerFields } = splitFulltextFields(fulltextIndex);
    const where = buildWhere(query.filter);
    const n = integerFields.length > 0 ? searchTermInteger(text) : undefined;

    // Text match OR exact number on each integer member (the term must be a
    // whole number). BIGINT keeps a 10-digit term from overflowing an INTEGER
    // column; int4 = int8 is a btree cross-type operator, so the index stays usable.
    const parts: string[] = [];
    const params: unknown[] = [];
    if (textFields.length > 0) {
      const tsvectorExpr = this._buildTsvectorExpr(textFields);
      parts.push(`to_tsvector('english', ${tsvectorExpr}) @@ plainto_tsquery('english', ?)`);
      params.push(text);
    }
    if (n !== undefined) {
      for (const f of integerFields) {
        parts.push(`${qi(f.name)} = CAST(? AS BIGINT)`);
        params.push(n);
      }
    }
    // An integer-only index with a term that is not a whole number matches nothing.
    const clause = orFragment(parts, params);
    return {
      sql: where.sql === "1=1" ? clause.sql : `${where.sql} AND ${clause.sql}`,
      params: [...where.params, ...clause.params],
    };
  }

  /** Builds the tsvector SQL expression for a fulltext index's fields. Must match between index DDL and queries. */
  private _buildTsvectorExpr(fields: TDbIndex["fields"]): string {
    return fields.map((f) => `coalesce(${qi(f.name)}, '')`).join(" || ' ' || ");
  }

  private _getFulltextIndex(indexName?: string): TDbIndex | undefined {
    const { all, def } = this._fulltextIndexes();
    if (!indexName) return def;
    return all.find((index) => index.key === indexName);
  }

  /** The table's fulltext indexes and the default one, built once per table. */
  private _fulltextIndexes(): { all: TDbIndex[]; def: TDbIndex | undefined } {
    const src = this._table.indexes;
    let memo = this._fulltextMemo;
    if (memo?.src !== src) {
      const all = [...src.values()].filter((i) => i.type === "fulltext");
      memo = this._fulltextMemo = { src, all, def: defaultFulltextIndex(all) };
    }
    return memo;
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
    const { sql, params } = this._buildVectorSearchQuery(
      this._prepareVectorSearch(vector, query, indexName),
    );
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
    // One context (field, filter, threshold) for both statements.
    const ctx = this._prepareVectorSearch(vector, query, indexName);
    const { sql, params } = this._buildVectorSearchQuery(ctx);
    const { sql: countSql, params: countParams } = this._buildVectorSearchCountQuery(ctx);
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
    const distanceOp = similarityToPgOp(vec.similarity);
    const where = buildWhere(query.filter, {
      // vectorDistanceSource aliases the table `t` — relational predicates correlate to it.
      qualifier: pgDialect.quoteTable(SEARCH_SOURCE_ALIAS),
    });
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

  /** The row source + distance cap (threshold on pgvector's distance scale) of a vector search. */
  private _vectorSearchSource(
    ctx: ReturnType<PostgresAdapter["_prepareVectorSearch"]>,
    withRows: boolean,
  ): { source: TSqlFragment; maxDistance?: number } {
    const distExpr = {
      sql: `(${qi(ctx.field)} ${ctx.distanceOp} ?::vector)`,
      params: [ctx.vectorStr],
    };
    return {
      source: vectorDistanceSource(pgDialect, ctx.tableName, ctx.where, distExpr, withRows),
      maxDistance:
        ctx.threshold === undefined
          ? undefined
          : thresholdToDistance(ctx.threshold, ctx.vec.similarity),
    };
  }

  private _buildVectorSearchQuery(ctx: ReturnType<PostgresAdapter["_prepareVectorSearch"]>): {
    sql: string;
    params: unknown[];
  } {
    const { source, maxDistance } = this._vectorSearchSource(ctx, true);
    const skip = Number(ctx.controls.$skip) || 0;
    return buildVectorSearchSelect(pgDialect, source, {
      select: ctx.controls.$select,
      limit: Number(ctx.controls.$limit) || (skip ? 1000 : 20),
      skip,
      maxDistance,
    });
  }

  private _buildVectorSearchCountQuery(ctx: ReturnType<PostgresAdapter["_prepareVectorSearch"]>): {
    sql: string;
    params: unknown[];
  } {
    const { source, maxDistance } = this._vectorSearchSource(ctx, false);
    return buildVectorSearchCount(pgDialect, source, { maxDistance });
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

  /**
   * Detects PostGIS support by attempting to enable the extension — schema
   * sync's detection ({@link prepareTypeMapper}). Runs once; a probe that
   * already found PostGIS skips it.
   */
  private async _detectGeoSupport(): Promise<boolean> {
    if (this._geoInstallTried || this._supportsGeo === true) {
      return this._supportsGeo === true;
    }
    this._geoInstallTried = true;
    try {
      await this._exec().exec("CREATE EXTENSION IF NOT EXISTS postgis");
      this._supportsGeo = true;
      // Columns are learned anew: one probed as JSONB before stays JSONB
      // until sync migrates it — `_geoSchemaChanged` runs on that DDL.
    } catch {
      this._supportsGeo = false;
      this.logger.warn(
        "[postgres] PostGIS extension not available — db.geoPoint fields are stored as JSONB (no geo search).",
      );
    }
    return this._supportsGeo;
  }

  /**
   * Whether geo column `column` is a PostGIS column (EWKT) — synchronously
   * when known, else after {@link _probeGeo} on `exec` (the statement's own
   * executor). A column the catalog does not show (table not created yet)
   * follows PostGIS presence — what sync would create — and is probed again
   * next time.
   */
  private _geoColumnNative(column: string, exec: TGeoProbeExecutor): boolean | Promise<boolean> {
    if (this._supportsGeo === false) {
      return false;
    }
    const known = this._geoNative.get(column);
    if (known !== undefined) {
      return known;
    }
    return this._probeGeo(exec).then(
      (probe) => probe.columns.get(column) ?? this._supportsGeo ?? probe.postgis,
    );
  }

  /**
   * The read-only geo probe ({@link GEO_PROBE_SQL}) of this table on `exec`:
   * records PostGIS presence when not known yet, and caches the type of every
   * geo column the catalog shows (unless a DDL path ran meanwhile).
   *
   * Concurrent callers on the SAME executor share one probe; a caller on
   * another executor runs its own — waiting on a probe queued for a pool
   * connection while holding a transaction connection could deadlock a
   * small pool, and a transaction's failure (an aborted one) never reaches
   * callers outside it. A failed probe is not cached, and a caller that
   * joined it retries once (a pool probe may have hit a broken connection).
   */
  private _probeGeo(exec: TGeoProbeExecutor): Promise<TGeoProbe> {
    const shared = this._geoProbe;
    if (shared?.exec === exec) {
      return shared.promise.catch(() => this._runGeoProbe(exec));
    }
    const promise = this._runGeoProbe(exec);
    const entry = { exec, promise };
    this._geoProbe = entry;
    const clear = () => {
      if (this._geoProbe === entry) this._geoProbe = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async _runGeoProbe(exec: TGeoProbeExecutor): Promise<TGeoProbe> {
    const gen = this._geoSchemaGen;
    const row = await exec.get<{ postgis: unknown; columns: unknown }>(GEO_PROBE_SQL, [
      quoteTableName(this.resolveTableName()),
      this._geoColumnNames,
    ]);
    const postgis = row?.postgis === true;
    const raw = typeof row?.columns === "string" ? JSON.parse(row.columns) : row?.columns;
    const columns = new Map<string, boolean>();
    if (raw && typeof raw === "object") {
      for (const [name, type] of Object.entries(raw as Record<string, unknown>)) {
        columns.set(name, POSTGIS_TYPES.has(String(type)));
      }
    }
    this._supportsGeo ??= postgis;
    if (gen === this._geoSchemaGen) {
      for (const [name, native] of columns) this._geoNative.set(name, native);
    }
    return { postgis, columns };
  }

  /**
   * A DDL path ran (create / alter / recreate / rename / drop): the geo
   * column types are learned anew, and a probe in flight caches nothing.
   */
  private _geoSchemaChanged(): void {
    if (this._geoFields) {
      this._geoNative.clear();
      this._geoSchemaGen++;
      this._geoProbe = undefined;
    }
  }

  /**
   * PostGIS presence when known; while unknown (no sync, no statement yet),
   * a table with geo columns answers `true` — the geo paths learn presence
   * before they run and refuse with `GEO_NOT_SUPPORTED` then, so the first
   * geo search of a process that never syncs is not refused up front.
   */
  override isGeoSearchable(): boolean {
    return this._supportsGeo ?? this._hasGeoPointFields();
  }

  /** PostGIS presence, probed when not known yet (geo search entry points). */
  private async _ensureGeoKnown(): Promise<void> {
    if (this._supportsGeo === undefined) {
      await this._probeGeo(this._txConnection() ?? this.driver);
    }
  }

  override async geoSearch(
    point: [number, number],
    query: DbQuery,
    indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    await this._ensureGeoKnown();
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
    await this._ensureGeoKnown();
    const ctx = this._prepareGeoSearch(point, query, indexName);
    const { sql, params } = this._buildGeoSearchSelect(ctx);
    const countFrag = buildGeoSearchCount(
      pgDialect,
      ctx.tableName,
      ctx.where,
      ctx.dist,
      ctx.window,
    );
    this._log(sql, params);
    this._log(countFrag.sql, countFrag.params);
    const [rows, countRow] = await Promise.all([
      this._exec().all(sql, params),
      this._exec().get<{ cnt: number | string }>(countFrag.sql, countFrag.params),
    ]);
    return {
      data: rows.map((row) => renameGeoDistance(row)),
      count: parseCount(countRow?.cnt),
    };
  }

  /** Resolves the shared parts of a geo search once (column, filter, distance, window). */
  private _prepareGeoSearch(point: [number, number], query: DbQuery, indexName?: string) {
    if (!this._supportsGeo) {
      throw geoNotSupported("", "Geo search requires the PostGIS extension");
    }
    const column = this._resolveGeoColumn(indexName);
    const controls = (query.controls ?? {}) as Record<string, unknown>;
    return {
      tableName: this.resolveTableName(),
      // The geo builders alias the table `t` — relational predicates correlate to it.
      where: buildWhere(query.filter, { qualifier: pgDialect.quoteTable(SEARCH_SOURCE_ALIAS) }),
      dist: pgGeoDistanceExpr(qi(column), point),
      window: geoWindowFromControls(controls),
      controls,
    };
  }

  private _buildGeoSearchSelect(ctx: ReturnType<PostgresAdapter["_prepareGeoSearch"]>): {
    sql: string;
    params: unknown[];
  } {
    return buildGeoSearchSelect(
      pgDialect,
      ctx.tableName,
      ctx.where,
      ctx.dist,
      ctx.window,
      ctx.controls as TGeoSearchControls,
    );
  }
}

/** A text / character type: the value is converted by the assignment into the column. */
const CHARACTER_TYPE = /^\s*(?:text|varchar|character varying|char|character|bpchar)\b/i;

/**
 * The expression converting column `col` (quoted) to `sqlType`, the field's
 * new type — one rule for `ALTER COLUMN … TYPE … USING` and the recreate copy.
 * The value goes through text, so one that does not parse as the new type
 * fails the statement instead of being coerced. A TEXT / VARCHAR(n) / CHAR(n)
 * target stops at `::text`: an explicit cast to VARCHAR(n) / CHAR(n) would
 * truncate an over-long value, the assignment into the column rejects it
 * (since 0.1.137).
 */
function convertColumnExpr(col: string, field: TDbFieldMeta, sqlType: string): string {
  if (field.isGeoPoint && sqlType.startsWith("geography")) {
    // v1 JSONB '[lng, lat]' → native geography(Point,4326). The generic
    // ::text double-cast can't parse a JSON tuple as WKT — build the
    // point explicitly, preserving NULLs.
    return `CASE WHEN ${col} IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint((${col}->>0)::float8, (${col}->>1)::float8), 4326)::geography END`;
  }
  if (CHARACTER_TYPE.test(sqlType)) {
    return `${col}::text`;
  }
  return `${col}::text::${sqlType}`;
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
      // PostGIS geography for db.geoPoint (e.g. "geography(Point,4326)")
      if (udtName === "geography") {
        return formattedType;
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
