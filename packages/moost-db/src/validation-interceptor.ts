import { ValidatorError } from "@atscript/typescript/utils";
import { DbError } from "@atscript/db";
import { defineInterceptor, Intercept, TInterceptorPriority } from "moost";

import { errorEnvelope } from "./http-errors";

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
};

function transformValidationError(error: unknown, reply: (response: unknown) => void) {
  if (error instanceof ValidatorError) {
    reply(errorEnvelope(400, error.message, error.errors));
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
