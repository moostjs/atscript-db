export type DbErrorCode =
  | "CONFLICT"
  | "FK_VIOLATION"
  | "NOT_FOUND"
  | "CASCADE_CYCLE"
  | "INVALID_QUERY"
  | "DEPTH_EXCEEDED"
  | "VERSION_COLUMN_WRITE";

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
