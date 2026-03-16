export type DbErrorCode =
  | "CONFLICT"
  | "FK_VIOLATION"
  | "NOT_FOUND"
  | "CASCADE_CYCLE"
  | "INVALID_QUERY";

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
