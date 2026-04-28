import type { TDbActionInfo, TDbActionIntent, TDbActionLevel } from "@atscript/db";

/**
 * Options accepted by `@DbAction(name, opts?)`. Structurally derived from
 * {@link TDbActionInfo} so every addition to the wire shape automatically
 * propagates here. Fields owned by the framework (`name`, `level`, `processor`,
 * `value`) are excluded — `name` comes from the decorator argument, `level` is
 * inferred from `@DbActionPK*` usage, `processor` is fixed to `'backend'` for
 * method-decorator actions, and `value` is filled from the `@Post` path.
 */
export type DbActionOpts = Partial<Omit<TDbActionInfo, "name" | "level" | "processor" | "value">>;

// ── Class-level dict entries ───────────────────────────────────────────────
// Discriminated over `processor`. The shortcut decorators (`@DbTableActions`,
// `@DbRowActions`, `@DbRowsActions`) inject `level` into each entry — the
// shortcut-form of these branches omits `level` and is exposed as
// {@link TDbActionsEntryUnpinned}.

interface DbActionsEntryCommon {
  label: string;
  level: TDbActionLevel;
  icon?: string;
  intent?: TDbActionIntent;
  description?: string;
  order?: number;
  default?: boolean;
  promptText?: string;
}

/**
 * Class-level dict entry. `value` semantics by processor:
 *
 * - `'navigate'` — REQUIRED, non-empty. The URL template (with `$1` substituted client-side).
 * - `'backend'`  — REQUIRED, non-empty. The full HTTP POST path the UI client should invoke.
 *   For row/rows entries the dev-supplied path MUST point to a `@Post`-bound
 *   handler accepting the PK-shaped JSON body (single PK scalar / composite
 *   object / array thereof) — typically a method using `@DbActionPK()` or
 *   `@DbActionPKs()`. The meta builder does NOT validate this.
 * - `'custom'`   — `value` is forbidden in the entry; the meta builder fills it
 *   with the dict key.
 */
export type TDbActionsEntry =
  | (DbActionsEntryCommon & { processor: "navigate"; value: string })
  | (DbActionsEntryCommon & { processor: "custom"; value?: never })
  | (DbActionsEntryCommon & { processor: "backend"; value: string });

/** Distributes `Omit` across the discriminated union members. */
type DistributiveOmit<T, K extends keyof T> = T extends T ? Omit<T, K> : never;

/** Same as {@link TDbActionsEntry} but without the `level` field — used by the level-pinned shortcuts. */
export type TDbActionsEntryUnpinned = DistributiveOmit<TDbActionsEntry, "level">;
