export type DbErrorCode =
  | "CONFLICT"
  | "FK_VIOLATION"
  | "NOT_FOUND"
  | "CASCADE_CYCLE"
  | "INVALID_QUERY"
  | "DEPTH_EXCEEDED";

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
 * Thrown when an insert payload nests deeper than the table's
 * declared `@db.deep.insert N`. Surfaced as HTTP 400 in moost-db.
 */
export class DeepInsertDepthExceededError extends DbError {
  name = "DeepInsertDepthExceededError";

  constructor(
    public readonly field: string,
    public readonly declared: number,
    public readonly actual: number,
  ) {
    const message = `Nested insert depth ${actual} exceeds declared @db.deep.insert ${declared} at '${field}'`;
    super("DEPTH_EXCEEDED", [{ path: field, message }], message);
  }
}
