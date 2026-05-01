import { HttpError } from "@moostjs/event-http";

/**
 * Wire-body shape for server-side gate rejections. The `name` discriminator
 * lets `@atscript/db-client` recognise the response and construct the typed
 * `ActionDisabledError` subclass. The shape extends Moost's standard
 * `ServerError` envelope (`{ message, statusCode, errors? }`) with three
 * additional fields:
 *
 * - `name: 'ActionDisabledError'` — discriminator the client matches.
 * - `action` — the `@DbAction` name that rejected the request.
 * - `id?` — present only for `'row'`-level rejections.
 * - `ids?` — present only for `'rows'`-level rejections.
 *
 * `message` is populated with a human-readable string so generic
 * `ClientError` consumers (which read `body.message`) still get something
 * useful without typed-catch dispatch.
 */
export interface ActionDisabledErrorBody {
  name: "ActionDisabledError";
  message: string;
  statusCode: 409;
  action: string;
  id?: Record<string, unknown>;
  ids?: Record<string, unknown>[];
}

function buildMessage(action: string, ids?: readonly unknown[]): string {
  if (ids !== undefined) {
    return `Action "${action}" is disabled for ${ids.length} of the selected rows`;
  }
  return `Action "${action}" is disabled for this row`;
}

/**
 * Thrown by the gate interceptor when `disabled` returns truthy. Composes
 * with Moost's existing error mapper to produce HTTP 409 with the wire body
 * defined by {@link ActionDisabledErrorBody}.
 *
 * - `'row'`-level rejection: pass `(action, id)` — the body emits `id`.
 * - `'rows'`-level rejection: pass `(action, undefined, ids)` — the body
 *   emits `ids` (the FULL list of failing IDs in reject mode; the FULL list
 *   of request IDs in skip mode with zero survivors).
 */
export class ActionDisabledError extends HttpError<ActionDisabledErrorBody> {
  override name = "ActionDisabledError";

  constructor(action: string, id?: Record<string, unknown>, ids?: Record<string, unknown>[]) {
    const body: ActionDisabledErrorBody = {
      name: "ActionDisabledError",
      message: buildMessage(action, ids),
      statusCode: 409,
      action,
    };
    if (ids !== undefined) {
      body.ids = ids;
    } else if (id !== undefined) {
      body.id = id;
    }
    super(409, body);
  }
}
