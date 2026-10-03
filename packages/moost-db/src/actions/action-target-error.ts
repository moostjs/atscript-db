import { HttpError } from "@moostjs/event-http";

/**
 * Why a query-targeted action request was refused:
 *
 * - `TARGET_INVALID` (400) — malformed `query` (unknown key, a control other
 *   than `$search` / `$index`, `ids` and `query` together, an action that
 *   accepts no query target);
 * - `TARGET_TOO_LARGE` (400) — more rows match than the cap (`cap`);
 * - `TARGET_CHANGED` (409) — the match count differs from `expectCount`
 *   (`matched` carries the current count).
 *
 * @since 0.1.147
 */
export type TActionTargetErrorCode = "TARGET_INVALID" | "TARGET_TOO_LARGE" | "TARGET_CHANGED";

/**
 * Wire body of {@link ActionTargetError} — the moost `ServerError` envelope
 * plus the `name` discriminator `@atscript/db-client` maps to its typed error.
 *
 * @since 0.1.147
 */
export interface ActionTargetErrorBody {
  name: "ActionTargetError";
  message: string;
  statusCode: 400 | 409;
  code: TActionTargetErrorCode;
  action: string;
  /** `TARGET_CHANGED`: the current match count. */
  matched?: number;
  /** `TARGET_TOO_LARGE`: the most rows one request may target. */
  cap?: number;
}

/**
 * A refused query target (400 / 409) — see {@link TActionTargetErrorCode}.
 *
 * @since 0.1.147
 */
export class ActionTargetError extends HttpError<ActionTargetErrorBody> {
  override name = "ActionTargetError";

  constructor(
    code: TActionTargetErrorCode,
    action: string,
    message: string,
    extra: { matched?: number; cap?: number } = {},
  ) {
    const statusCode = code === "TARGET_CHANGED" ? 409 : 400;
    super(statusCode, { name: "ActionTargetError", message, statusCode, code, action, ...extra });
  }
}

/** `TARGET_INVALID` for `action`. */
export function targetInvalid(action: string, message: string): ActionTargetError {
  return new ActionTargetError("TARGET_INVALID", action, message);
}
