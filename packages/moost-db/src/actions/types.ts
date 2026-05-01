import type { AtscriptDbTable, TDbActionInfo, TDbActionIntent, TDbActionLevel } from "@atscript/db";

/** `'rows'`-level batch policy — controls whether failing rows reject or are filtered out. */
export type TOnDisabledRows = "reject" | "skip";

/**
 * Options accepted by `@DbAction(name, opts?)`. Structurally derived from
 * {@link TDbActionInfo} so every wire-shape addition propagates here, EXCEPT
 * `disabled` and `requiredFields` which differ in shape between decorator
 * opts (function / dev-supplied) and the wire (string / forwarded verbatim).
 *
 * Fields owned by the framework (`name`, `level`, `processor`, `value`) are
 * excluded — `name` comes from the decorator argument, `level` is inferred
 * from `@DbActionPK*` / `@DbActionRow*` usage, `processor` is fixed to
 * `'backend'` for method-decorator actions, and `value` is filled from the
 * `@Post` path.
 *
 * Generic over `TRow` so the `disabled` predicate can be type-checked against
 * the bound table's row shape. Note: TS decorators cannot infer `TRow` from
 * the enclosing controller's class generic, so the dev MUST annotate the row
 * arg explicitly (`(row: Order) => …`) to get type-checking.
 */
export type DbActionOpts<TRow = unknown> = Partial<
  Omit<TDbActionInfo, "name" | "level" | "processor" | "value" | "disabled" | "requiredFields">
> & {
  /**
   * Per-row gate predicate. Truthy → action is disabled for that row.
   * Server enforces (via the gate interceptor); UI evaluates the same
   * expression to grey-out / hide the button.
   *
   * The dev MUST annotate the row arg explicitly (`(row: Order) => …`) —
   * TS decorators cannot infer `TRow` from the enclosing class generic.
   */
  disabled?: (row: TRow) => boolean;
  /**
   * Optional dot-notation field paths the UI should union into `$select`.
   * Plain `string[]` in v1.
   *
   * TODO: upgrade to typed `PathOf<TRow>[]` in a follow-up — the recursive
   * type pattern is finicky for nested objects/arrays/optionals and isn't
   * blocking v1.
   *
   * When omitted, the UI parses the stringified `disabled` itself to extract
   * row-property accesses. When present, the UI uses this list verbatim — the
   * server does NOT auto-derive or merge.
   */
  requiredFields?: string[];
  /**
   * `'rows'`-level batch policy. Default `'reject'`.
   *
   * - `'reject'`: evaluate every row (FULL scan, NOT short-circuit) before
   *   throwing; if any row fails, the error body lists ALL failing PKs;
   *   handler not invoked.
   * - `'skip'`: filter cached rows + cached PKs to passing-only;
   *   zero survivors → reject. Handler runs against the survivors.
   *
   * Ignored for `'row'` and `'table'` level actions.
   */
  onDisabledRows?: TOnDisabledRows;
  /**
   * Bound table reference. REQUIRED on non-`AsDbReadableController` classes
   * when `disabled` is set OR a `@DbActionRow*` parameter is declared.
   *
   * Silently ignored on `AsDbReadableController` subclasses (which include
   * `AsDbController`) — the bound table from the controller wins; the
   * gate / thin interceptor probes `instanceof AsDbReadableController` and
   * populates the bound-table slot from `controller.readable` before
   * checking `opts.table`.
   */
  table?: AtscriptDbTable<any>;
};

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
  /** Mirrors {@link TDbActionInfo.promptText} — singular/plural via tuple. */
  promptText?: string | [string, string];
  /** Mirrors {@link TDbActionInfo.shortcut} — single-character UI hint. */
  shortcut?: string;
  /**
   * UI-only gate predicate (class-level dict entries do NOT register a
   * server-side gate interceptor — the dict entry's `value` may point at an
   * endpoint in another controller). The wire emits `fn.toString()` so the
   * UI can grey-out / hide the button. For symmetric server enforcement at
   * the actual `@Post`-bound handler, declare `@DbAction(name, { disabled })`
   * on that handler too.
   *
   * Not generic over `TRow` — devs type the row arg explicitly.
   */
  disabled?: (row: any) => boolean;
  /** Same as method-decorator `requiredFields`. UI hint, not server-derived. */
  requiredFields?: string[];
  /**
   * Reserved for future API symmetry with method-decorator opts. Currently a
   * no-op for class-level dict entries (no gate interceptor registers).
   */
  onDisabledRows?: TOnDisabledRows;
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
