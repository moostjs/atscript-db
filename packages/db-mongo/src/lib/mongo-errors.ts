import { DbError } from "@atscript/db";
import { MongoServerError } from "mongodb";

/**
 * Maps MongoDB projection-validation errors (31249, 31254) to `DbError("INVALID_QUERY")`
 * so moost-db's validation interceptor returns HTTP 400 instead of an opaque 500.
 * These codes always indicate malformed client `$select`, not a server fault.
 */
export async function wrapInvalidQuery<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (error instanceof MongoServerError && (error.code === 31249 || error.code === 31254)) {
      throw new DbError("INVALID_QUERY", [{ path: "$select", message: error.message }]);
    }
    throw error;
  }
}
