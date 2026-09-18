import { HttpError } from "@moostjs/event-http";

/** One entry of the structured error envelope's `errors` array. */
export interface THttpErrorEntry {
  path: string;
  message: string;
}

/**
 * The structured error envelope every `moost-db` rejection uses (since
 * 0.1.128 all of them do): `{ message, statusCode, errors: [{ path, message }] }`
 * — the same shape the validation interceptor renders for `ValidatorError` /
 * `DbError`, so clients parse one format.
 */
export function errorEnvelope(
  statusCode: number,
  message: string,
  errors: THttpErrorEntry[],
): HttpError {
  return new HttpError(statusCode as ConstructorParameters<typeof HttpError>[0], {
    message,
    statusCode,
    errors,
  });
}

/**
 * A 400 with a single `errors` entry: `path` names the offending logical
 * path / body position, `message` the reason, `top` the envelope's top-level
 * message (defaults to `message`).
 */
export function badRequest(path: string, message: string, top: string = message): HttpError {
  return errorEnvelope(400, top, [{ path, message }]);
}
