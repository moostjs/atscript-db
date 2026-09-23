import { DbError, bucketTimeZoneUnavailable } from "@atscript/db";
import { MongoServerError } from "mongodb";

/** Server code for an unrecognized `timezone` in a date expression (verified on MongoDB 7.0 and 8.0). */
const UNKNOWN_TIME_ZONE = 40485;

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
    if (error instanceof MongoServerError) {
      if (error.code === 31249 || error.code === 31254) {
        throw new DbError("INVALID_QUERY", [{ path: "$select", message: error.message }]);
      }
      if (error.code === UNKNOWN_TIME_ZONE) {
        const zone = /time zone identifier:\s*"([^"]*)"/.exec(error.message)?.[1];
        throw bucketTimeZoneUnavailable(
          zone
            ? `MongoDB does not recognize time zone "${zone}" — its time zone database may be outdated`
            : `MongoDB does not recognize a bucket time zone: ${error.message}`,
        );
      }
    }
    throw error;
  }
}
