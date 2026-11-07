import { DbError, bucketTimeZoneUnavailable } from "@atscript/db";

/** Server code for an unrecognized `timezone` in a date expression (verified on MongoDB 7.0 and 8.0). */
const UNKNOWN_TIME_ZONE = 40485;

/** `CommandNotFound`: e.g. `hello` on a server before 4.2.10. */
export const COMMAND_NOT_FOUND = 59;

/**
 * Maps MongoDB server errors that describe the query, not a server fault:
 * - projection validation (31249, 31254) → `DbError("INVALID_QUERY")` (moost-db:
 *   400) — these codes always indicate a malformed client `$select`;
 * - an unrecognized time zone identifier (40485) → `BUCKET_TZ_UNAVAILABLE`
 *   (moost-db: 501). Only calendar buckets put a zone into a pipeline, and the
 *   core already accepted it as a canonical IANA name — so the server's
 *   bundled tz database lacking it is a store condition, never a silent NULL
 *   or UTC label.
 */
export async function wrapInvalidQuery<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error: unknown) {
    const code = serverErrorCode(error);
    if (code === 31249 || code === 31254) {
      throw new DbError("INVALID_QUERY", [{ path: "$select", message: (error as Error).message }]);
    }
    if (code === UNKNOWN_TIME_ZONE) {
      const message = (error as Error).message;
      const zone = /time zone identifier:\s*"([^"]*)"/.exec(message)?.[1];
      throw bucketTimeZoneUnavailable(
        zone
          ? `MongoDB does not recognize time zone "${zone}" — its time zone database may be outdated`
          : `MongoDB does not recognize a bucket time zone: ${message}`,
      );
    }
    throw error;
  }
}

// ── Driver errors, recognised by shape ──────────────────────────────────────
//
// Never by `instanceof`: the `MongoClient` handed to the adapter may come from
// another copy of the `mongodb` package than the one this package imports (an
// app's own driver install, a second version, a linked workspace). Its errors
// are then instances of THAT copy's classes, and an `instanceof` check against
// ours fails — a duplicate key escaped as a raw `MongoBulkWriteError` instead of
// a `CONFLICT`.

/** The numeric server code of a driver error, `undefined` for anything else. */
export function serverErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

/** `WriteConflict`: a write met a concurrent transaction's uncommitted change. */
const WRITE_CONFLICT = 112;

/**
 * The retryable `SERIALIZATION_FAILURE` of a driver error that ended a
 * transaction without committing it — one labelled `TransientTransactionError`
 * or `UnknownTransactionCommitResult` (`session.withTransaction` retries
 * those itself for 120 s, then rethrows), or a `WriteConflict` — else `error`
 * as is. The raw driver error is kept as `cause`.
 */
export function mapTransientTransactionError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const labels = (error as { errorLabels?: unknown }).errorLabels;
  const labelled =
    Array.isArray(labels) &&
    (labels.includes("TransientTransactionError") ||
      labels.includes("UnknownTransactionCommitResult"));
  if (!labelled && serverErrorCode(error) !== WRITE_CONFLICT) return error;
  return new DbError("SERIALIZATION_FAILURE", [{ path: "", message: error.message }], undefined, {
    cause: error,
  });
}

/** `DuplicateKey` (E11000) and its legacy update form `DuplicateKeyValue` (E11001). */
function isDuplicateKeyCode(code: unknown): boolean {
  return code === 11000 || code === 11001;
}

/** A bulk error's per-statement write errors (`MongoBulkWriteError.writeErrors`) — `[]` for other errors. */
export function bulkWriteErrors(error: unknown): TBulkWriteError[] {
  if (!(error instanceof Error)) return [];
  const writeErrors = (error as { writeErrors?: unknown }).writeErrors;
  return [writeErrors].flat().filter((w): w is TBulkWriteError => !!w);
}

/** The fields of the driver's `WriteError` read here. */
interface TBulkWriteError {
  code?: unknown;
  index: number;
  errmsg?: unknown;
}

/**
 * Whether a driver error carries a write-concern failure (`MongoWriteConcernError`,
 * or a bulk error whose result holds one): the write's durability is unknown, so it
 * is never read as a duplicate key, whatever its write errors say.
 */
function hasWriteConcernError(error: object): boolean {
  const e = error as {
    writeConcernError?: unknown;
    result?: { getWriteConcernError?: () => unknown; writeConcernErrors?: unknown[] };
  };
  return Boolean(
    e.writeConcernError ||
    e.result?.getWriteConcernError?.() ||
    e.result?.writeConcernErrors?.length,
  );
}

/**
 * The duplicate-key violation a write failed with, or `undefined` when the error
 * is anything else — for every shape the driver reports one in:
 * - a `MongoServerError` (single-document writes: `code` 11000, `keyPattern`);
 * - a `MongoBulkWriteError` (`insertMany` / `bulkWrite` — the table layer sends
 *   every insert through `insertMany`): 11000 on top and in `writeErrors`, or in
 *   `writeErrors` only — a bulk error counts only when EVERY write error is a
 *   duplicate key (another failure in the batch is not a conflict);
 * - a bare `WriteError` (`code` getter, `errmsg`).
 *
 * A write-concern failure is never a duplicate key (see {@link hasWriteConcernError}).
 */
export function duplicateKeyViolation(
  error: unknown,
): { message: string; keyPattern?: Record<string, unknown> } | undefined {
  if (error === null || typeof error !== "object" || hasWriteConcernError(error)) return undefined;
  const e = error as {
    code?: unknown;
    message?: unknown;
    errmsg?: unknown;
    keyPattern?: Record<string, unknown>;
  };
  const writeErrors = bulkWriteErrors(error);
  const codes = writeErrors.length > 0 ? writeErrors.map((w) => w.code) : [e.code];
  if (!codes.every(isDuplicateKeyCode)) return undefined;
  const message = [e.message, e.errmsg, writeErrors[0]?.errmsg].find(
    (m): m is string => typeof m === "string" && m !== "",
  );
  return { message: message ?? "E11000 duplicate key error", keyPattern: e.keyPattern };
}
