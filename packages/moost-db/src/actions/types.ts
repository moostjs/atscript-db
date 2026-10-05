import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type {
  AtscriptDbTable,
  FilterExpr,
  FlatOf,
  TDbActionInfo,
  TDbActionIntent,
  TDbActionLevel,
} from "@atscript/db";

import type { TDbQueryTargetOpts } from "./query-target";

/**
 * One entry of a `disabled` predicate's result. Truthy = the action is
 * disabled for that row; falsy (`false`, `""`) = enabled. A non-empty string
 * disables the action AND carries a human-readable reason — surfaced in the
 * 409 `ActionDisabledError` message/body and in the row's `$disabledReasons`.
 *
 * @since 0.1.141 (`string`)
 */
export type TDbActionDisabledVerdict = boolean | string;

/** `'rows'`-level batch policy — controls whether failing rows reject or are filtered out. */
export type TOnDisabledRows = "reject" | "skip";

/**
 * Dot-notation field paths of `TRow`'s flat type. Drives both the runtime
 * projection widening and the type narrowing of the `disabled` predicate's
 * row argument. Relations are absent from `FlatOf<T>` — listing a relation
 * field is therefore a compile error.
 *
 * Permissive fallback when `TRow = unknown` (no explicit decorator generic):
 * any string is allowed and the `disabled` predicate's row arg is `any[]`,
 * preserving the prior loose typing for un-annotated call sites.
 */
export type FlatKey<TRow> = unknown extends TRow ? string : keyof FlatOf<TRow> & string;

/** Row-shape narrowing for the `disabled` predicate. Falls back to `any` when `TRow = unknown`. */
type DisabledRowsArg<TRow, R extends readonly FlatKey<TRow>[]> = unknown extends TRow
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any[]
  : Pick<FlatOf<TRow>, R[number] & keyof FlatOf<TRow>>[];

// ── Gate shape ─────────────────────────────────────────────────────────────
// Two-branch union: either no gate (no `requiredFields`, no `disabled`), or
// BOTH `requiredFields` AND an optional `disabled` whose `rows` arg is typed
// as `Pick<FlatOf<TRow>, R[number]>[]`. Setting `disabled` without
// `requiredFields` is a compile error; the runtime mirrors this by dropping
// the action at discovery.

interface NoGate {
  requiredFields?: never;
  disabled?: never;
  onDisabledRows?: never;
}

interface WithGate<TRow, R extends readonly FlatKey<TRow>[]> {
  /**
   * Dot-notation field paths the predicate references. SERVER-INTERNAL —
   * never emitted on the `/meta` wire. Consumed verbatim to widen the DB
   * projection so `disabled` always sees the fields it declared.
   */
  requiredFields: R;
  /**
   * Sync batch gate predicate — returns a parallel array aligned with the
   * input. Per entry: truthy = disabled for the corresponding row; a
   * non-empty string also gives the reason (see
   * {@link TDbActionDisabledVerdict}). The `rows`
   * argument is type-narrowed to `Pick<FlatOf<TRow>, R[number]>[]`; reading
   * a field not listed in `requiredFields` is a compile error.
   *
   * Promise return is NOT permitted — the predicate is consumed in the
   * same tick by the gate and the augmenter.
   */
  disabled?: (rows: DisabledRowsArg<TRow, R>) => TDbActionDisabledVerdict[];
  /**
   * `'rows'`-level batch policy. Default `'reject'`.
   *
   * - `'reject'`: evaluate every row before throwing; if any row fails, the
   *   error body lists ALL failing IDs; handler not invoked.
   * - `'skip'`: filter cached rows + cached IDs to passing-only; zero
   *   survivors → reject. Handler runs against the survivors.
   *
   * Ignored for `'row'` and `'table'` level actions.
   */
  onDisabledRows?: TOnDisabledRows;
}

/**
 * Loose gate shape used when `TRow = unknown` (no explicit decorator generic).
 * Preserves the prior un-typed call-site flexibility; the runtime still drops
 * actions where `disabled` is set without `requiredFields`.
 */
interface LooseGate {
  requiredFields?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  disabled?: (rows: any[]) => TDbActionDisabledVerdict[];
  onDisabledRows?: TOnDisabledRows;
}

export type GateOpts<TRow, R extends readonly FlatKey<TRow>[]> = unknown extends TRow
  ? LooseGate
  : NoGate | WithGate<TRow, R>;

// ── Method-decorator opts (`@DbAction`) ────────────────────────────────────

interface BaseActionOpts extends Partial<
  Omit<
    TDbActionInfo,
    | "name"
    | "level"
    | "processor"
    | "value"
    | "disabled"
    | "formUrl"
    | "owner"
    | "idMap"
    | "queryTarget"
  >
> {
  /**
   * Bound table reference. REQUIRED on non-`AsDbReadableController` classes
   * when `disabled` is set OR a `@DbActionRow*` parameter is declared.
   *
   * Silently ignored on `AsDbReadableController` subclasses (which include
   * `AsDbController`) — the bound table from the controller wins.
   */
  table?: AtscriptDbTable<any>;
  /**
   * `'rows'` level (`@DbActionIDs` / `@DbActionRows`): the most identifiers
   * one request may carry. Above it the request is rejected with 400 before
   * any row is loaded. Default `1000`. Server-internal — never on the wire.
   *
   * @since 0.1.143
   */
  maxIds?: number;
  /**
   * `'rows'` level only: the action also accepts a query target — a body
   * `{ query: { q, exclude?, expectCount?, maxRows?, dryRun? }, input? }`
   * meaning "every row matching `q`" (the `GET /query` filter plus
   * `$search` / `$index`) under the caller's read scope (`queryTargetScope`)
   * and the action's own gate. `true` = `{ maxRows: 10_000, batchSize:
   * 500 }`. `maxRows` (on the wire as `queryTarget.maxRows`) caps the
   * matched rows; a `@DbActionTarget()` handler gets them in `batchSize`
   * batches, a `@DbActionIDs` / `@DbActionRows` handler at once (then also
   * capped by `maxIds`).
   *
   * @since 0.1.147
   */
  queryTarget?: TDbQueryTargetOpts;
}

/**
 * Options accepted by `@DbAction(name, opts?)`. Generic over `TRow` (the
 * controller's bound atscript type) and `R` (the literal `requiredFields`
 * tuple). Both are inferred at the call site via the decorator's `<TRow>`
 * argument plus `const R` generic.
 */
export type DbActionOpts<TRow = unknown, R extends readonly FlatKey<TRow>[] = []> = BaseActionOpts &
  GateOpts<TRow, R>;

// ── Class-level dict entries (`@DbActions` family) ─────────────────────────
// Discriminated over `processor`. The shortcut decorators (`@DbTableActions`,
// `@DbRowActions`, `@DbRowsActions`) inject `level` into each entry.

interface DbActionsEntryCommonBase {
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
   * Input form the UI collects before invoking the action:
   *
   * - a compiled `.as` interface — registered on THIS controller and served
   *   by its own `GET /meta/form/:name`; the wire carries `inputForm: Type.name`.
   * - `{ name, url }` — a form served elsewhere: `name` goes on the wire as
   *   `inputForm`, `url` (server-absolute path of the serialized schema, e.g.
   *   `"/api/shipping/meta/form/ShipForm"`) as {@link TDbActionInfo.formUrl}.
   *
   * Not allowed with `processor: 'navigate'`. Class-level entries only
   * describe the action — validating `input` is the target handler's job
   * (e.g. its own `@InputForm(Type)` param).
   *
   * @since 0.1.136
   */
  inputForm?: TAtscriptAnnotatedType | { name: string; url: string };
}

type DbActionsEntryWithGate<TRow, R extends readonly FlatKey<TRow>[]> = DbActionsEntryCommonBase &
  GateOpts<TRow, R>;

/**
 * Class-level dict entry. `value` semantics by processor:
 *
 * - `'navigate'` — REQUIRED, non-empty. URL template (`$1` substituted client-side).
 * - `'backend'`  — REQUIRED, non-empty. Full HTTP POST path the UI client invokes.
 * - `'custom'`   — `value` is forbidden in the entry; the meta builder fills it
 *   with the dict key.
 */
export type TDbActionsEntry<TRow = unknown, R extends readonly FlatKey<TRow>[] = []> =
  | (DbActionsEntryWithGate<TRow, R> & {
      processor: "navigate";
      value: string;
      inputForm?: never;
    })
  | (DbActionsEntryWithGate<TRow, R> & { processor: "custom"; value?: never })
  | (DbActionsEntryWithGate<TRow, R> & { processor: "backend"; value: string });

/** Distributes `Omit` across the discriminated union members. */
type DistributiveOmit<T, K extends keyof T> = T extends T ? Omit<T, K> : never;

/** Same as {@link TDbActionsEntry} but without the `level` field — used by the level-pinned shortcuts. */
export type TDbActionsEntryUnpinned<
  TRow = unknown,
  R extends readonly FlatKey<TRow>[] = [],
> = DistributiveOmit<TDbActionsEntry<TRow, R>, "level">;

// ── Per-entry inference helpers ────────────────────────────────────────────
// Used as decorator-level constraints so each entry's `disabled` is narrowed
// by its own `requiredFields` literal. Pattern: `dict: D & ValidatedDict<TRow, D>`.

type DbActionsDictBase = Record<string, unknown>;

type EntryRequiredFields<E, TRow> = E extends { requiredFields: infer R }
  ? R extends readonly FlatKey<TRow>[]
    ? R
    : []
  : [];

export type ValidatedDict<TRow, D extends DbActionsDictBase> = {
  [K in keyof D]: TDbActionsEntry<TRow, EntryRequiredFields<D[K], TRow>>;
};

export type ValidatedUnpinnedDict<TRow, D extends DbActionsDictBase> = {
  [K in keyof D]: TDbActionsEntryUnpinned<TRow, EntryRequiredFields<D[K], TRow>>;
};

/**
 * An id as an id-addressed endpoint received it: a path scalar (always a
 * string from the URL) or an identification object (`?field=value` forms,
 * action bodies).
 *
 * @since 0.1.148
 */
export type TDbRowIdInput = string | number | boolean | Record<string, unknown>;

/**
 * Which endpoint asks `resolveRowIds`:
 *
 * - `"action"` — an action route: the body's validated ids;
 * - `"available"` — `GET /meta/actions/:id` | `?…` (and a view asking its source);
 * - `"one"` — `GET /one/:id` | `?…`;
 * - `"remove"` — `DELETE /:id` | `?…`.
 *
 * @since 0.1.148
 */
export type TDbRowIdPurpose = "action" | "available" | "one" | "remove";

/**
 * Context of `AsDbReadableController.resolveRowIds`.
 *
 * @since 0.1.148
 */
export interface TDbRowIdsContext {
  readonly purpose: TDbRowIdPurpose;
  /** `"action"` only: the action's name. */
  readonly action?: string;
  /** `"action"` only: the action's level. */
  readonly level?: "row" | "rows";
  /**
   * The row overlay the endpoint will apply to the resolved id
   * (`rowOverlay()`; for actions the gate's overlay), `undefined` when none.
   * Server data — never sent to the client. Resolve INSIDE it when an alias
   * could name several rows, so a row the caller can't reach never shadows
   * one they can.
   */
  readonly overlay?: FilterExpr;
}
