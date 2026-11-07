export type DbErrorCode =
  | "CONFLICT"
  | "FK_VIOLATION"
  | "NOT_FOUND"
  | "CASCADE_CYCLE"
  | "INVALID_QUERY"
  | "DEPTH_EXCEEDED"
  | "VERSION_COLUMN_WRITE"
  | "CAS_EXHAUSTED"
  // ── touchMany: a key's row is stale or missing (moost-db maps it to 409) ──
  | "CAS_MISMATCH"
  // ── Field-level encryption (@db.encrypted) ──
  | "ENC_CONFIG_MISSING"
  | "ENC_KEY_INVALID"
  | "ENC_NOT_ENCRYPTED"
  | "ENC_DECRYPT_FAILED"
  | "ENC_FIELD_FILTER"
  | "ENC_FIELD_SORT"
  | "ENC_FIELD_AGG"
  | "ENC_FIELD_PATCH_OP"
  // ── Geo (db.geoPoint / @db.index.geo) ──
  | "GEO_INDEX_MISSING"
  | "GEO_NOT_SUPPORTED"
  | "FILTER_TYPE_MISMATCH"
  // ── Calendar buckets ($select `{ $bucket }`) ──
  /** The adapter's `calendarBucketUnits()` lacks the requested unit (moost-db: 400). */
  | "BUCKET_NOT_SUPPORTED"
  /** The engine cannot resolve the bucket's time zone — a store-configuration condition (moost-db: 501). */
  | "BUCKET_TZ_UNAVAILABLE"
  // ── Aggregate functions ($select `{ $fn, $field }`) ──
  /** A known aggregate function the adapter's `aggregateFns()` lacks (moost-db: 400). @since 0.1.136 */
  | "AGG_FN_NOT_SUPPORTED"
  /**
   * The adapter's `supportsAggregateExpressions()` is false and the query uses
   * arithmetic (`{ $expr }`, `{ $fn, $expr }`) in an aggregate `$select`
   * (moost-db: 400). @since 0.1.148
   */
  | "AGG_EXPR_NOT_SUPPORTED"
  /**
   * The adapter's `supportsConditionalAggregates()` is false and an aggregate
   * `$select` entry carries a `$where` (moost-db: 400). @since 0.1.168
   */
  | "AGG_WHERE_NOT_SUPPORTED"
  /**
   * The adapter's `supportsDistinctFieldLists()` is false and a
   * `countDistinct` lists several fields (moost-db: 400). @since 0.1.168
   */
  | "AGG_FIELD_LIST_NOT_SUPPORTED"
  /**
   * The adapter's `supportsNestedAggregates()` is false, or the HTTP endpoint
   * turned two-level aggregates off, and the query has a `$from` (moost-db:
   * 400). @since 0.1.168
   */
  | "AGG_NESTED_NOT_SUPPORTED"
  // ── Relational filter predicates ($some / $none) ──
  /**
   * The adapter (or the table's wiring) cannot run a relational predicate:
   * `supportsRelationFilters()` is false for the read/write mode, the related
   * table lives on a different adapter, or the table was built without a
   * `DbSpace` (moost-db: 400). @since 0.1.147
   */
  | "REL_FILTER_NOT_SUPPORTED"
  // ── Space lifecycle ──
  /** The `DbSpace` was closed; the table/view handle can no longer be used (moost-db: 503). @since 0.1.148 */
  | "SPACE_CLOSED"
  // ── Conflict-ignoring insert ──
  /** The adapter does not implement `insertManyIgnore` (moost-db: 400). @since 0.1.148 */
  | "ON_CONFLICT_NOT_SUPPORTED"
  // ── SQLite transaction gate (waiter timed out; moost-db maps it to 503) ──
  | "TX_WAIT_TIMEOUT"
  // ── Row-lock contention (retryable; moost-db maps both to 503) ──
  /**
   * The engine chose this transaction as a deadlock victim (MySQL errno 1213,
   * PostgreSQL 40P01) and rolled it back. Retry the WHOLE transaction.
   * `retryable` is `true`. @since 0.1.153
   */
  | "DEADLOCK"
  /**
   * A row lock was not granted in time (MySQL errno 1205
   * `innodb_lock_wait_timeout`, PostgreSQL 55P03 `lock_timeout` / `NOWAIT`).
   * The statement failed; MySQL keeps the transaction open unless
   * `innodb_rollback_on_timeout` is set, PostgreSQL aborts it — retry the
   * whole transaction. `retryable` is `true`. @since 0.1.153
   */
  | "LOCK_TIMEOUT"
  /**
   * PostgreSQL could not serialize the transaction (`40001`: under
   * `REPEATABLE READ` / `SERIALIZABLE`, e.g. a row locked or updated after it
   * changed since the snapshot). The transaction is aborted — retry it whole.
   * Also thrown (since 0.1.162, path `limit`) by a bounded `updateMany` /
   * `deleteMany` whose picked rows concurrent writers kept taking while rows
   * still matched — retry the call (or its transaction).
   * `retryable` is `true`. @since 0.1.153
   */
  | "SERIALIZATION_FAILURE"
  // ── Locking reads & isolation (since 0.1.162; moost-db maps both to 501) ──
  /**
   * The adapter cannot take a row lock on a read (`findOne` / `findMany`
   * with `{ lock }`) — MongoDB, or an adapter whose `supportsReadLocks()` is
   * false. Use optimistic concurrency (`$cas`, `withOptimisticRetry`) there.
   */
  | "LOCK_NOT_SUPPORTED"
  /**
   * The adapter cannot run a transaction at the requested isolation level
   * (`withTransaction(fn, { isolation })`) — e.g. `serializable` on MongoDB,
   * any level on a MongoDB without transactions, or an adapter whose
   * `isolationLevels()` lacks it.
   */
  | "ISOLATION_NOT_SUPPORTED";

/** Codes whose operation may succeed when the whole transaction is retried. */
const RETRYABLE_CODES: ReadonlySet<DbErrorCode> = new Set<DbErrorCode>([
  "DEADLOCK",
  "LOCK_TIMEOUT",
  "SERIALIZATION_FAILURE",
]);

/**
 * Per-entry reasons of a constraint violation (since 0.1.165), stable
 * UPPER_SNAKE keys a client can translate (with {@link TDbErrorEntry.params}):
 * - `UNIQUE` — a unique key (or the primary key) already holds the value;
 *   params `{ index, fields }` (`index` is the declared unique-index name, or
 *   `"primaryKey"`);
 * - `FK_MISSING` — a foreign key names a row that does not exist; params
 *   `{ fields, target }` (+ `ambiguous: true` when the engine could not tell
 *   which foreign key failed and every one is listed);
 * - `FK_RESTRICT` — a delete is blocked by referencing rows; params
 *   `{ table, referencedBy? }`.
 *
 * Query-path rejections (`INVALID_QUERY`, since 0.1.175) code their entry
 * too: `UNKNOWN_FIELD` `{ field }`, `UNKNOWN_RELATION` `{ relation }`,
 * `NOT_A_RELATION` `{ field }`, `NAVIGATION_PATH` / `FIELD_NOT_PERMITTED` /
 * `FIELD_NESTED_OBJECT` / `FIELD_ENCRYPTED` `{ field, op }`, `FIELD_IN_JSON`
 * `{ field, column, op }`, else `INVALID_QUERY` — the codes moost-db answers
 * over HTTP (its `MOOST_DB_MESSAGES` holds their English templates).
 */
export type TDbErrorEntryCode = "UNIQUE" | "FK_MISSING" | "FK_RESTRICT";

/** One entry of {@link DbError.errors}. */
export interface TDbErrorEntry {
  /** Logical field path the entry is about (`""` when it concerns the whole row / table). */
  path: string;
  /** Human-readable English message. */
  message: string;
  /**
   * Machine-readable reason of this entry (since 0.1.165) — see
   * {@link TDbErrorEntryCode}. Absent on entries whose reason is the
   * error's own {@link DbError.code}.
   */
  code?: TDbErrorEntryCode | (string & {});
  /** The values {@link message} names, for rendering it in another language (since 0.1.165). */
  params?: Record<string, unknown>;
  /**
   * The engine's raw text, kept for logs when the message was normalized
   * (since 0.1.165). Never sent to HTTP clients.
   */
  details?: string;
}

/**
 * What an adapter could tell about a violated constraint (since 0.1.165) —
 * the core resolves it against the table's metadata into logical paths
 * (see {@link constraintViolation}). Physical names throughout.
 */
export interface TDbConstraintHint {
  /** The violated columns, when the engine names them. */
  columns?: readonly string[];
  /** The violated constraint / index name, when the engine names it. */
  name?: string;
  /** On a blocked delete: the table holding the referencing rows. */
  referencedBy?: string;
  /** The violation is the primary key's. */
  primaryKey?: boolean;
}

export class DbError extends Error {
  name = "DbError";

  /**
   * Set by {@link constraintViolation}: what the adapter could tell about the
   * violated constraint, for the table layer to normalize. @internal
   */
  hint?: TDbConstraintHint;

  constructor(
    public readonly code: DbErrorCode,
    public readonly errors: TDbErrorEntry[],
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? errors[0]?.message ?? "Database error", options);
    this.stack = undefined;
  }

  /**
   * `true` when retrying the whole transaction may succeed — a transient
   * concurrency condition (`DEADLOCK`, `LOCK_TIMEOUT`,
   * `SERIALIZATION_FAILURE`), not a fault of the
   * request. @since 0.1.153
   */
  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}

/**
 * Whether `error` is a retryable `DbError` (`DEADLOCK` / `LOCK_TIMEOUT` /
 * `SERIALIZATION_FAILURE`):
 * re-running the whole transaction may succeed. @since 0.1.153
 */
export function isRetryableDbError(error: unknown): error is DbError {
  return error instanceof DbError && error.retryable;
}

/** Whether `error` is a `DbError` with code `CONFLICT` (unique / primary-key violation). */
export function isConflict(error: unknown): error is DbError {
  return error instanceof DbError && error.code === "CONFLICT";
}

/**
 * The error an adapter throws for an engine unique / foreign-key violation
 * (since 0.1.165): `CONFLICT` (unique, primary key, blocked delete) or
 * `FK_VIOLATION`, carrying the engine's `raw` text and whatever `hint` the
 * engine gave. The table layer rewrites it into one entry per logical field
 * of the violated constraint, with `code` / `params` and the raw text in
 * `details`.
 */
export function constraintViolation(
  code: "CONFLICT" | "FK_VIOLATION",
  hint: TDbConstraintHint,
  raw: string,
): DbError {
  // A provisional path (the first physical column) for callers of the adapter
  // itself; the table layer replaces the entry.
  const error = new DbError(code, [{ path: hint.columns?.[0] ?? "", message: raw, details: raw }]);
  error.hint = hint;
  return error;
}

/** @internal An `INVALID_QUERY` error with a single `{ path, message }` entry. */
export function invalidQuery(path: string, message: string): DbError {
  return new DbError("INVALID_QUERY", [{ path, message }]);
}

/** @internal The error every handle of a closed `DbSpace` throws. */
export function spaceClosedError(): DbError {
  return new DbError("SPACE_CLOSED", [
    {
      path: "",
      message: "The DbSpace is closed; table and view handles can no longer be used",
    },
  ]);
}

/**
 * Collapses the failures of a multi-step shutdown into one `AggregateError`
 * (message lists every failure).
 * @internal
 */
export function aggregateFailure(label: string, errors: unknown[]): AggregateError {
  return new AggregateError(
    errors,
    `${label}: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")}`,
  );
}

/**
 * Thrown when a write payload nests deeper than the table's
 * declared `@db.depth.limit N`. Surfaced as HTTP 400 in moost-db.
 */
export class DepthLimitExceededError extends DbError {
  name = "DepthLimitExceededError";

  constructor(
    public readonly field: string,
    public readonly declared: number,
    public readonly actual: number,
  ) {
    const message = `Nested write depth ${actual} exceeds declared @db.depth.limit ${declared} at '${field}'`;
    super("DEPTH_EXCEEDED", [{ path: field, message }], message);
  }
}

/**
 * Thrown by {@link withOptimisticRetry} when `maxAttempts` is reached
 * without a successful CAS commit — the target row kept changing under
 * the read-modify-write loop. Surfaces the attempt count and the
 * last-observed version so callers can log/report the contention.
 */
export class CasExhaustedError extends DbError {
  name = "CasExhaustedError";

  constructor(
    public readonly attempts: number,
    public readonly lastSeenVersion: number | undefined,
  ) {
    const message =
      `Optimistic concurrency: exhausted ${attempts} attempts; ` +
      `row kept changing under us (last seen version: ${lastSeenVersion ?? "unknown"})`;
    super("CAS_EXHAUSTED", [{ path: "$cas", message }], message);
  }
}

/**
 * Thrown by `AtscriptDbTable.touchMany` (`require: 'all'`, the default) when
 * fewer rows than keys matched their expected version — at least one row is
 * stale or missing. Nothing was written (the pre-count refused before the
 * first statement, or the SQL transaction rolled every bump back). Surfaced
 * as HTTP 409 by moost-db.
 */
export class CasMismatchError extends DbError {
  name = "CasMismatchError";

  constructor(
    /** Rows whose primary key + version matched. */
    public readonly matched: number,
    /** Keys passed to `touchMany`. */
    public readonly expected: number,
  ) {
    const message = `touchMany: ${matched} of ${expected} rows matched — stale or missing rows`;
    super("CAS_MISMATCH", [{ path: "$cas", message }], message);
  }
}

/**
 * The engine cannot resolve a calendar bucket's time zone (`BUCKET_TZ_UNAVAILABLE`,
 * `path` `$select`; moost-db: 501). The zone already passed the core's IANA
 * validation, so this is a store-configuration condition — an outdated or
 * missing server time zone database — never a malformed query. Since 0.1.132.
 */
export function bucketTimeZoneUnavailable(message: string): DbError {
  return new DbError("BUCKET_TZ_UNAVAILABLE", [{ path: "$select", message }]);
}

/**
 * A `$with` entry names a relation the table does not have (`INVALID_QUERY`,
 * entry `UNKNOWN_RELATION` `{ relation }`, `path` `$with`; moost-db: 400) —
 * the message names only the requested relation. Since 0.1.175.
 */
export function unknownWithRelation(name: string): DbError {
  return new DbError(
    "INVALID_QUERY",
    [
      {
        path: "$with",
        message: `Unknown relation "${name}"`,
        code: "UNKNOWN_RELATION",
        params: { relation: name },
      },
    ],
    `Unknown relation "${name}" in $with`,
  );
}

/**
 * The adapter's `supportsAggregateExpressions()` is false (or its SQL dialect
 * cannot cast to a double) and the query uses arithmetic in an aggregate
 * `$select` (`AGG_EXPR_NOT_SUPPORTED`, `path` `$select`; moost-db: 400).
 * @since 0.1.148
 */
export function aggregateExpressionsNotSupported(): DbError {
  return new DbError("AGG_EXPR_NOT_SUPPORTED", [
    { path: "$select", message: "Aggregate expressions are not supported by this adapter" },
  ]);
}
