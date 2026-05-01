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
 * - `pk?` — present only for `'row'`-level rejections.
 * - `pks?` — present only for `'rows'`-level rejections.
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
  pk?: unknown;
  pks?: unknown[];
}

function buildMessage(action: string, pks?: unknown[]): string {
  if (pks !== undefined) {
    return `Action "${action}" is disabled for ${pks.length} of the selected rows`;
  }
  return `Action "${action}" is disabled for this row`;
}

/**
 * Thrown by the gate interceptor when `disabled` returns truthy. Composes
 * with Moost's existing error mapper to produce HTTP 409 with the wire body
 * defined by {@link ActionDisabledErrorBody}.
 *
 * - `'row'`-level rejection: pass `(action, pk)` — the body emits `pk`.
 * - `'rows'`-level rejection: pass `(action, undefined, pks)` — the body
 *   emits `pks` (the FULL list of failing PKs in reject mode; the FULL list
 *   of request PKs in skip mode with zero survivors).
 */
export class ActionDisabledError extends HttpError<ActionDisabledErrorBody> {
  override name = "ActionDisabledError";

  constructor(action: string, pk?: unknown, pks?: unknown[]) {
    const body: ActionDisabledErrorBody = {
      name: "ActionDisabledError",
      message: buildMessage(action, pks),
      statusCode: 409,
      action,
    };
    if (pks !== undefined) {
      body.pks = pks;
    } else if (pk !== undefined) {
      body.pk = pk;
    }
    super(409, body);
  }
}
