export type DbErrorCode =
  | "CONFLICT"
  | "FK_VIOLATION"
  | "NOT_FOUND"
  | "CASCADE_CYCLE"
  | "INVALID_QUERY"
  | "DEPTH_EXCEEDED"
  | "VERSION_COLUMN_WRITE"
  | "CAS_EXHAUSTED";

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
