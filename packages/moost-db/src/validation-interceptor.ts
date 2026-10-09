import { DbError } from "@atscript/db";
import { defineInterceptor, Intercept, TInterceptorPriority } from "moost";

import { errorEnvelope, validatorErrorToHttp } from "./http-errors";

export { badRequest, errorEnvelope } from "./http-errors";
export type { THttpErrorEntry } from "./http-errors";

const dbErrorCodeToStatus: Record<string, number> = {
  CONFLICT: 409,
  // touchMany: a key's row is stale or missing — the caller's view is out of
  // date, the same verdict a `$cas` mismatch gets.
  CAS_MISMATCH: 409,
  // SQLite transaction-gate waiter timed out (`transactionWaitTimeoutMs`) —
  // the store is busy, not the request malformed.
  TX_WAIT_TIMEOUT: 503,
  // The DbSpace was closed (shutdown in progress) — the store is unavailable.
  SPACE_CLOSED: 503,
  // Row-lock contention (deadlock victim / lock wait timeout): transient —
  // retrying the request may succeed.
  DEADLOCK: 503,
  LOCK_TIMEOUT: 503,
  SERIALIZATION_FAILURE: 503,
  // The engine cannot resolve a calendar bucket's time zone (e.g. MySQL time
  // zone tables not loaded) — a store-configuration condition, not a bad
  // request. (`BUCKET_NOT_SUPPORTED` stays 400, like `GEO_NOT_SUPPORTED`.)
  BUCKET_TZ_UNAVAILABLE: 501,
};

function transformValidationError(error: unknown, reply: (response: unknown) => void) {
  const validation = validatorErrorToHttp(error);
  if (validation) {
    reply(validation);
  } else if (error instanceof DbError) {
    reply(errorEnvelope(dbErrorCodeToStatus[error.code] ?? 400, error.message, error.errors));
  }
}

export const validationErrorTransform = () =>
  defineInterceptor(
    {
      error: transformValidationError,
    },
    // Priority MUST be BEFORE_ALL so this interceptor's `error` callback is
    // registered before any higher-priority interceptor's `before` runs (and
    // potentially throws ValidatorError). Stack-order is by design: a throw
    // at priority N skips registration of error handlers at priority > N.
    TInterceptorPriority.BEFORE_ALL,
  );

export const UseValidationErrorTransform = () => Intercept(validationErrorTransform());
