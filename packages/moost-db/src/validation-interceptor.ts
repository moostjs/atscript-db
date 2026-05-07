import { ValidatorError } from "@atscript/typescript/utils";
import { DbError } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";
import { defineInterceptor, Intercept, TInterceptorPriority } from "moost";

const dbErrorCodeToStatus: Record<string, number> = {
  CONFLICT: 409,
};

function transformValidationError(error: unknown, reply: (response: unknown) => void) {
  if (error instanceof ValidatorError) {
    reply(
      new HttpError(400, {
        message: error.message,
        statusCode: 400,
        errors: error.errors,
      }),
    );
  } else if (error instanceof DbError) {
    const statusCode = dbErrorCodeToStatus[error.code] ?? 400;
    reply(
      new HttpError(statusCode as ConstructorParameters<typeof HttpError>[0], {
        message: error.message,
        statusCode: statusCode as number,
        errors: error.errors,
      }),
    );
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
