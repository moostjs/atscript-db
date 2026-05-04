import { cached, defineWook } from "@wooksjs/event-core";
import { useBody } from "@wooksjs/http-body";
import { ValidatorError } from "@atscript/typescript/utils";

/**
 * Wire-shape of an action request body. Both fields are optional:
 *
 * - `ids` — what previously sat at the body root: a single identifier object
 *   (`'row'`-level), an array of identifier objects (`'rows'`-level), or
 *   absent (`'table'`-level).
 * - `input` — present only when the action declares an `@InputForm()`
 *   parameter; carries the form payload the user filled out.
 */
export interface DbActionEnvelope {
  ids?: unknown;
  input?: unknown;
}

/**
 * Cached parse of the action request body. Centralises the shape check so
 * every per-param resolver (`@DbActionID*`, `@DbActionRow*`, `@InputForm`)
 * reads through the same gate. An array or scalar root is rejected with the
 * same `ValidatorError` envelope as today's strict-shape ID failures.
 */
export const dbActionBodySlot = cached<Promise<DbActionEnvelope>>(async (ctx) => {
  const raw = await useBody(ctx).parseBody<unknown>();
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidatorError([
      {
        path: "",
        message: "Action body must be an object of shape { ids?, input? }",
      },
    ]);
  }
  return raw as DbActionEnvelope;
});

/** Cached `body.input` slot — consumed by `@InputForm()` and `useDbActionInput()`. */
export const dbActionInputSlot = cached<Promise<unknown>>(async (ctx) => {
  const env = await ctx.get(dbActionBodySlot);
  return env.input;
});

/** Composable for in-handler reads of the form input. */
export const useDbActionInput = defineWook((ctx) => ({
  load: () => ctx.get(dbActionInputSlot),
}));
