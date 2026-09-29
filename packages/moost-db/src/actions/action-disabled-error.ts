import { HttpError } from "@moostjs/event-http";

import { verdictReason } from "./verdict";

/**
 * Wire-body shape for server-side gate rejections. The `name` discriminator
 * lets `@atscript/db-client` recognise the response and construct the typed
 * `ActionDisabledError` subclass. The shape extends Moost's standard
 * `ServerError` envelope (`{ message, statusCode, errors? }`) with:
 *
 * - `name: 'ActionDisabledError'` — discriminator the client matches.
 * - `action` — the `@DbAction` name that rejected the request.
 * - `id?` — present only for `'row'`-level rejections.
 * - `ids?` — present only for `'rows'`-level rejections.
 * - `reason?` — the reason shared by every rejected row, when the
 *   `disabled` predicate returned one (since 0.1.141).
 * - `reasons?` — `'rows'` level only: index-aligned with `ids`, `null` where
 *   that row carries no reason. Present only when at least one reason exists
 *   (since 0.1.141).
 *
 * `message` is populated with a human-readable string so generic
 * `ClientError` consumers (which read `body.message`) still get something
 * useful without typed-catch dispatch — the reason itself when there is one.
 */
export interface ActionDisabledErrorBody {
  name: "ActionDisabledError";
  message: string;
  statusCode: 409;
  action: string;
  id?: Record<string, unknown>;
  ids?: Record<string, unknown>[];
  /** @since 0.1.141 */
  reason?: string;
  /** @since 0.1.141 */
  reasons?: (string | null)[];
}

/** Distinct reasons quoted in a mixed `'rows'` message before `(+N more)`. */
const MAX_LISTED_REASONS = 3;

function sharedReason(reasons: readonly (string | null)[]): string | undefined {
  const first = reasons[0];
  if (first === null || first === undefined) return undefined;
  return reasons.every((r) => r === first) ? first : undefined;
}

function rowsMessage(action: string, count: number, reasons: readonly (string | null)[]): string {
  const base = `Action "${action}" is disabled for ${count} of the selected rows`;
  const distinct = [...new Set(reasons.filter((r): r is string => r !== null))];
  if (distinct.length === 0) return base;
  const listed = distinct.slice(0, MAX_LISTED_REASONS).join("; ");
  const more = distinct.length - MAX_LISTED_REASONS;
  return `${base}: ${listed}${more > 0 ? ` (+${more} more)` : ""}`;
}

/**
 * Thrown by the gate interceptor when `disabled` returns truthy. Composes
 * with Moost's existing error mapper to produce HTTP 409 with the wire body
 * defined by {@link ActionDisabledErrorBody}.
 *
 * - `'row'`-level rejection: pass `(action, id, undefined, [reason])` — the
 *   body emits `id` (+ `reason` when given).
 * - `'rows'`-level rejection: pass `(action, undefined, ids, reasons?)` — the
 *   body emits `ids` (the FULL list of failing IDs in reject mode; the FULL
 *   list of request IDs in skip mode with zero survivors) and, when any
 *   reason exists, `reasons` aligned with `ids`.
 *
 * `reasons` entries are verdict reasons (`verdictReason`): anything but a
 * non-empty string counts as "no reason".
 */
export class ActionDisabledError extends HttpError<ActionDisabledErrorBody> {
  override name = "ActionDisabledError";

  constructor(
    action: string,
    id?: Record<string, unknown>,
    ids?: Record<string, unknown>[],
    reasons?: readonly (string | null | undefined)[],
  ) {
    const body: ActionDisabledErrorBody = {
      name: "ActionDisabledError",
      message: "",
      statusCode: 409,
      action,
    };
    if (ids !== undefined) {
      const aligned = ids.map((_, i) => verdictReason(reasons?.[i]) ?? null);
      const reason = sharedReason(aligned);
      body.message = reason ?? rowsMessage(action, ids.length, aligned);
      body.ids = ids;
      if (reason !== undefined) body.reason = reason;
      if (aligned.some((r) => r !== null)) body.reasons = aligned;
    } else {
      const reason = verdictReason(reasons?.[0]);
      body.message = reason ?? `Action "${action}" is disabled for this row`;
      if (id !== undefined) body.id = id;
      if (reason !== undefined) body.reason = reason;
    }
    super(409, body);
  }
}
