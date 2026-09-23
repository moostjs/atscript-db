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
  // ── SQLite transaction gate (waiter timed out; moost-db maps it to 503) ──
  | "TX_WAIT_TIMEOUT";

export class DbError extends Error {
  name = "DbError";

  constructor(
    public readonly code: DbErrorCode,
    public readonly errors: Array<{ path: string; message: string }>,
    message?: string,
  ) {
    super(message ?? errors[0]?.message ?? "Database error");
    this.stack = undefined;
  }
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
