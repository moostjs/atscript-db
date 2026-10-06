import { ValidatorError } from "@atscript/typescript/utils";
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

/**
 * The 400 of a `$with` relation the request cannot reach — nonexistent, or
 * hidden by `hasField` (the two answer alike): `Unknown relation "<name>"`,
 * the envelope message listing `visible` (the relations the caller CAN
 * load at that level). The single source of this wording — a permission
 * layer that rejects a relation itself should throw this.
 *
 * @since 0.1.143
 */
export function unknownRelationError(name: string, visible: readonly string[]): HttpError {
  return badRequest(
    "$with",
    `Unknown relation "${name}"`,
    `Unknown relation "${name}" in $with. Available relations: ${visible.join(", ") || "(none)"}`,
  );
}

/** The path behind each `Unknown field` message a controller's `validateInsights` returned. */
const insightPaths = new WeakMap<Map<string, unknown>, THttpErrorEntry>();

/**
 * `validateInsights`' refusal of `path` (its string contract): the
 * `Unknown field "<path>"` message, remembered with its path so
 * {@link insightError} can render the envelope.
 */
export function unknownInsight(insights: Map<string, unknown>, path: string): string {
  const message = `Unknown field "${path}"`;
  insightPaths.set(insights, { path, message });
  return message;
}

/**
 * The 400 for the message `validateInsights` returned: the validation
 * envelope when it is the controller's own {@link unknownInsight} refusal
 * (an override passing `super`'s answer through included), else the bare
 * message an override chose.
 */
export function insightError(insights: Map<string, unknown>, message: string): HttpError {
  const entry = insightPaths.get(insights);
  return entry?.message === message ? badRequest(entry.path, message) : new HttpError(400, message);
}

/**
 * The 400 envelope of a `ValidatorError`; `undefined` for any other error.
 * @internal Not part of the public API (not re-exported from the barrel).
 */
export function validatorErrorToHttp(error: unknown): HttpError | undefined {
  return error instanceof ValidatorError
    ? errorEnvelope(400, error.message, error.errors)
    : undefined;
}
