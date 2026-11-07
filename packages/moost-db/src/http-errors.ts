import { ValidatorError } from "@atscript/typescript/utils";
import { HttpError } from "@moostjs/event-http";
import { registerMessages } from "moost";

import type { TCapabilityVerdict } from "./meta/field-capabilities";

/**
 * moost-db's own code-keyed English templates (since 0.1.173), registered
 * with moost's `registerMessages` on import: `MoostHttp` translates an error
 * body by its `code`, and a translated `/meta` serves the templates as
 * `$i18n`.
 *
 * - `NOT_FOUND` — every 404 moost-db answers: a missing row, a row outside
 *   the caller's scope (the same answer on purpose), an unknown or refused
 *   form, an unknown delegated action. Neutral text: other libraries (e.g.
 *   a permission layer) answer their 404s with the same id.
 *
 * Since 0.1.175 every 400 / 403 / 409 moost-db answers is coded too — the
 * envelope's top-level `code` / `params` and each `errors` entry's. The
 * English `message` stays the detailed sentence (with its hints); the
 * template is the wording a translator starts from. `params`:
 *
 * - `UNKNOWN_FIELD` `{ field }` — a path that does not exist or the caller
 *   cannot see (the two answer alike);
 * - `UNKNOWN_RELATION` `{ relation }` — a `$with` relation, likewise;
 * - `NOT_A_RELATION` `{ field }` — `$some` / `$none` on a field that is
 *   no navigation relation;
 * - `NAVIGATION_PATH` `{ field, op }` — a navigation property used as a
 *   column (load it with `$with`, filter it with `$some`);
 * - `FIELD_NOT_PERMITTED` `{ field, op }` — the field exists but may not be
 *   used in that position (no `@db.column.filterable` / `sortable`, the
 *   adapter cannot, …);
 * - `FIELD_DISPLAY_ONLY` `{ field, op }` — a computed display field outside
 *   `$select`;
 * - `FIELD_NESTED_OBJECT` `{ field, op }` — a nested object where a leaf is
 *   needed;
 * - `FIELD_IN_JSON` `{ field, column, op }` — a path inside a JSON-stored
 *   column the adapter cannot address;
 * - `FIELD_ENCRYPTED` `{ field, op }` — an `@db.encrypted` field (or a path
 *   inside one);
 * - `FIELD_WRITE_ONLY` `{ field, op }` — a `@db.writeOnly` field read back;
 * - `RELATION_NOT_FILTERABLE` `{ relation }` — `$some` / `$none` on a
 *   relation without `@db.rel.filterable` (or whose table is unavailable);
 * - `EXPECTED_OBJECT` — a write body (or one of its rows) is not an object;
 * - `VERSION_MISMATCH` `{ currentVersion }` — the 409 of a stale `$cas` /
 *   `If-Match` write (the body keeps `kind: "version_mismatch"`);
 * - `ACTION_FORBIDDEN` `{ action }` — the 403 of a refused action;
 * - `INVALID_QUERY` — every other malformed request (bad query string,
 *   unsupported control or combination, unknown search index, …). Also the
 *   top-level code of the core's query errors, whose entries carry the
 *   field codes above.
 */
export const MOOST_DB_MESSAGES = {
  NOT_FOUND: "Not found",
  UNKNOWN_FIELD: 'Unknown field "{field}"',
  UNKNOWN_RELATION: 'Unknown relation "{relation}"',
  NOT_A_RELATION: '"{field}" is not a relation',
  NAVIGATION_PATH: '"{field}" is a navigation property — load it with $with',
  FIELD_NOT_PERMITTED: 'Field "{field}" is not permitted here',
  FIELD_DISPLAY_ONLY: 'Field "{field}" is display-only',
  FIELD_NESTED_OBJECT: '"{field}" is a nested object — use one of its fields',
  FIELD_IN_JSON: '"{field}" is inside JSON-stored field "{column}"',
  FIELD_ENCRYPTED: 'Field "{field}" is encrypted',
  FIELD_WRITE_ONLY: 'Field "{field}" is write-only',
  RELATION_NOT_FILTERABLE: 'Filtering by related "{relation}" rows is not permitted',
  EXPECTED_OBJECT: "Expected an object",
  VERSION_MISMATCH: "The record was changed by someone else",
  ACTION_FORBIDDEN: 'Action "{action}" is not allowed',
  INVALID_QUERY: "Invalid query",
} as const;

/** A code of {@link MOOST_DB_MESSAGES}. */
export type TMoostDbErrorCode = keyof typeof MOOST_DB_MESSAGES;

registerMessages(MOOST_DB_MESSAGES);

/**
 * The 404 every moost-db endpoint answers (since 0.1.173):
 * `{ statusCode: 404, code: "NOT_FOUND", message: "Not found" }`. A row that
 * is missing and a row outside the caller's scope answer these same bytes,
 * so a permission layer refusing a row should throw this too.
 */
export function notFoundError(): HttpError {
  return new HttpError(404, { message: MOOST_DB_MESSAGES.NOT_FOUND, code: "NOT_FOUND" });
}

/** One entry of the structured error envelope's `errors` array. */
export interface THttpErrorEntry {
  path: string;
  message: string;
  /**
   * Machine-readable reason of the entry (since 0.1.165) — a `DbError`
   * entry's code (`UNIQUE`, `FK_MISSING`, `FK_RESTRICT`).
   */
  code?: string;
  /** Values the message names, for translating it (since 0.1.165). */
  params?: Record<string, unknown>;
  /**
   * The message is your own text, not one of the library's: a translator
   * looks it up by its text, never by `code` (since 0.1.175; moost reads it).
   */
  custom?: boolean;
}

/**
 * The message of a two-level aggregate (`$from`) an endpoint does not take
 * (internal — not exported from the package).
 */
export const NESTED_NOT_SUPPORTED_MESSAGE =
  "Two-level aggregates ($from) are not supported on this endpoint";

/**
 * The structured error envelope every `moost-db` rejection uses (since
 * 0.1.128 all of them do): `{ message, statusCode, errors: [{ path, message }] }`
 * — the same shape the validation interceptor renders for `ValidatorError` /
 * `DbError`, so clients parse one format. A `DbError` adds its `code` and
 * each entry's `code` / `params` (since 0.1.165); `params` (since 0.1.175)
 * are the top-level message's.
 */
export function errorEnvelope(
  statusCode: number,
  message: string,
  errors: THttpErrorEntry[],
  code?: string,
  params?: Record<string, unknown>,
): HttpError {
  return new HttpError(statusCode as ConstructorParameters<typeof HttpError>[0], {
    message,
    statusCode,
    ...(code === undefined ? {} : { code }),
    ...(params === undefined ? {} : { params }),
    errors,
  });
}

/** Options of {@link badRequest}. */
export interface TBadRequestOptions {
  /** Values the message names (`{ field }`, …), on the entry and the envelope. */
  params?: Record<string, unknown>;
  /** The envelope's top-level message (defaults to `message`). */
  top?: string;
}

/**
 * A 400 with a single `errors` entry: `path` names the offending logical
 * path / body position, `message` the reason, `code` (required since
 * 0.1.175 — see {@link MOOST_DB_MESSAGES}) the machine-readable reason, set
 * on the entry and as the envelope's top-level `code` (with `params`), so a
 * translator never has to match the English text.
 */
export function badRequest(
  path: string,
  message: string,
  code: TMoostDbErrorCode | (string & {}),
  { params, top = message }: TBadRequestOptions = {},
): HttpError {
  const entry: THttpErrorEntry = { path, message, code };
  if (params !== undefined) entry.params = params;
  return errorEnvelope(400, top, [entry], code, params);
}

/** `INVALID_QUERY` {@link badRequest} — a malformed request without a more specific code. */
export function invalidQuery(path: string, message: string): HttpError {
  return badRequest(path, message, "INVALID_QUERY");
}

/**
 * The 400 for a refusal text an application chose (a `validateControls` /
 * `validateInsights` override): the entry is marked `custom` and the envelope
 * has no top-level `code`, so moost's translator looks the text up as it is
 * (a bare `{ message }` did the same before 0.1.175). The entry keeps
 * `INVALID_QUERY` for clients.
 * @internal
 */
export function controlsRefusal(message: string, path = ""): HttpError {
  return errorEnvelope(400, message, [{ path, message, code: "INVALID_QUERY", custom: true }]);
}

/**
 * The 400 of a path the request cannot reach — nonexistent, or hidden by
 * `hasField` (the two answer alike): `Unknown field "<path>"`, code
 * `UNKNOWN_FIELD` with `{ field }`. A permission layer that refuses a field
 * itself should throw this.
 *
 * @since 0.1.175
 */
export function unknownFieldError(path: string): HttpError {
  return badRequest(path, unknownFieldMessage(path), "UNKNOWN_FIELD", { params: { field: path } });
}

/** The English text of {@link unknownFieldError}. */
export function unknownFieldMessage(path: string): string {
  return `Unknown field "${path}"`;
}

/** The 400 of a capability verdict (its `code` / `params` included). */
export function verdictError(verdict: TCapabilityVerdict): HttpError {
  return badRequest(verdict.path, verdict.message, verdict.code, { params: verdict.params });
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
  return badRequest("$with", `Unknown relation "${name}"`, "UNKNOWN_RELATION", {
    params: { relation: name },
    top: `Unknown relation "${name}" in $with. Available relations: ${visible.join(", ") || "(none)"}`,
  });
}

/** The path behind each `Unknown field` message a controller's `validateInsights` returned. */
const insightPaths = new WeakMap<Map<string, unknown>, THttpErrorEntry>();

/**
 * `validateInsights`' refusal of `path` (its string contract): the
 * `Unknown field "<path>"` message, remembered with its path so
 * {@link insightError} can render the envelope.
 */
export function unknownInsight(insights: Map<string, unknown>, path: string): string {
  const message = unknownFieldMessage(path);
  insightPaths.set(insights, { path, message });
  return message;
}

/**
 * The 400 for the message `validateInsights` returned: `UNKNOWN_FIELD` when
 * it is the controller's own {@link unknownInsight} refusal (an override
 * passing `super`'s answer through included), else the message an override
 * chose, as a `custom` entry without a top-level code — a translator finds it
 * by its text (since 0.1.175; a bare `{ message }` before).
 */
export function insightError(insights: Map<string, unknown>, message: string): HttpError {
  const entry = insightPaths.get(insights);
  return entry?.message === message ? unknownFieldError(entry.path) : controlsRefusal(message);
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
