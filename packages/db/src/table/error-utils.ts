import { ValidatorError } from "@atscript/typescript/utils";

import { DbError } from "../db-error";
import type { TableMetadata } from "./table-metadata";

/**
 * Prefixes error paths with a nav field context.
 * Ensures errors from child table operations (e.g., FK violations on a comment)
 * get paths like `comments[0].authorId` instead of just `authorId`.
 */
export function prefixErrorPaths(
  errors: Array<{ path: string; message: string }>,
  prefix: string,
): Array<{ path: string; message: string }> {
  return errors.map((err) => ({
    ...err,
    path: err.path ? `${prefix}.${err.path}` : prefix,
  }));
}

/**
 * Wraps an async nested operation and prefixes error paths with the nav field context.
 */
export async function wrapNestedError<R>(navField: string, fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ValidatorError) {
      throw new ValidatorError(prefixErrorPaths(error.errors, navField));
    }
    if (error instanceof DbError) {
      throw new DbError(error.code, prefixErrorPaths(error.errors, navField));
    }
    throw error;
  }
}

/**
 * Catches `DbError('FK_VIOLATION')` with empty paths (from adapters that
 * enforce FKs natively but can't report which field failed) and enriches
 * the error with all FK field names from table metadata.
 */
export async function enrichFkViolation<R>(meta: TableMetadata, fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof DbError &&
      error.code === "FK_VIOLATION" &&
      error.errors.every((err) => !err.path)
    ) {
      const msg = error.errors[0]?.message ?? error.message;
      const errors: Array<{ path: string; message: string }> = [];
      for (const [, fk] of meta.foreignKeys) {
        for (const field of fk.fields) {
          errors.push({ path: field, message: msg });
        }
      }
      throw new DbError("FK_VIOLATION", errors.length > 0 ? errors : error.errors);
    }
    throw error;
  }
}

/**
 * Wraps a delete operation: catches native `FK_VIOLATION` errors (e.g. SQLite
 * RESTRICT) and re-throws as `CONFLICT` (409) with a descriptive message.
 */
export async function remapDeleteFkViolation<R>(
  tableName: string,
  fn: () => Promise<R>,
): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DbError && error.code === "FK_VIOLATION") {
      throw new DbError("CONFLICT", [
        {
          path: tableName,
          message: `Cannot delete from "${tableName}": referenced by child records (RESTRICT)`,
        },
      ]);
    }
    throw error;
  }
}
