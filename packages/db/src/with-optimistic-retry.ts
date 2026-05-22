import { CasExhaustedError, DbError } from "./db-error";
import type { AtscriptDbTable } from "./table/db-table";
import type { FilterExpr, TDbUpdateResult } from "./types";

export interface WithOptimisticRetryOptions {
  /** Maximum number of attempts before giving up. Defaults to `5`. */
  maxAttempts?: number;
  /**
   * Optional hook invoked between failed attempts. Receives the 1-based
   * attempt number that just failed. Useful for exponential backoff with
   * jitter. Default behavior is to retry immediately.
   */
  delay?: (attempt: number) => Promise<void>;
}

/**
 * Runs a read-modify-write loop under optimistic concurrency control (OCC).
 *
 * Reads the row via `findOne({ filter })`, hands it to `mutator`, then applies
 * the returned patch with `$cas: { [versionColumn]: row[versionColumn] }`. On
 * a version conflict (`matchedCount === 0`) it re-reads the row, calls the
 * mutator with the fresh state, and retries — up to `maxAttempts` times.
 *
 * The filter (typically the primary key) is threaded into the update payload
 * so the table layer can extract the row identity. If `mutator` returns
 * fields that overlap with the filter, the patch wins (last-write semantics
 * inside a single object spread).
 *
 * @throws {DbError} with code `INVALID_QUERY` if `table` has no
 *   `@db.column.version` column — the helper would have no version to thread
 *   into `$cas` and would silently degrade to last-write-wins.
 * @throws {DbError} with code `NOT_FOUND` if the initial `findOne` returns
 *   `null`. The mutator is not invoked with a fabricated row.
 * @throws {CasExhaustedError} if `maxAttempts` is reached without a
 *   successful commit.
 */
export async function withOptimisticRetry<TRow extends Record<string, unknown>>(
  table: AtscriptDbTable,
  filter: Record<string, unknown>,
  mutator: (row: TRow) => Promise<Record<string, unknown>> | Record<string, unknown>,
  opts?: WithOptimisticRetryOptions,
): Promise<TDbUpdateResult> {
  const versionColumn = table.versionColumn;
  if (versionColumn === undefined) {
    throw new DbError("INVALID_QUERY", [
      {
        path: "$cas",
        message:
          `withOptimisticRetry: table "${table.tableName}" has no ` +
          `@db.column.version column — CAS cannot be applied`,
      },
    ]);
  }

  const maxAttempts = opts?.maxAttempts ?? 5;
  let lastSeenVersion: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const row = (await table.findOne({
      filter: filter as FilterExpr,
    } as never)) as TRow | null;

    if (row === null) {
      throw new DbError("NOT_FOUND", [
        {
          path: "$cas",
          message:
            `withOptimisticRetry: row not found in "${table.tableName}" ` +
            `for filter ${JSON.stringify(filter)}`,
        },
      ]);
    }

    lastSeenVersion = row[versionColumn] as number;
    const patch = await mutator(row);

    const result = await table.updateOne({
      ...filter,
      ...patch,
      $cas: { [versionColumn]: lastSeenVersion },
    });

    if (result.matchedCount > 0) {
      return result;
    }

    if (attempt < maxAttempts && opts?.delay !== undefined) {
      await opts.delay(attempt);
    }
  }

  throw new CasExhaustedError(maxAttempts, lastSeenVersion);
}
