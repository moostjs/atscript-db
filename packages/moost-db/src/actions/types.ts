import type {
  AtscriptDbTable,
  FlatOf,
  TDbActionInfo,
  TDbActionIntent,
  TDbActionLevel,
} from "@atscript/db";

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
   * Sync batch gate predicate — returns a parallel `boolean[]` aligned with
   * the input. `true` = disabled for the corresponding row. The `rows`
   * argument is type-narrowed to `Pick<FlatOf<TRow>, R[number]>[]`; reading
   * a field not listed in `requiredFields` is a compile error.
   *
   * Promise return is NOT permitted — the predicate is consumed in the
   * same tick by the gate and the augmenter.
   */
  disabled?: (rows: DisabledRowsArg<TRow, R>) => boolean[];
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
  disabled?: (rows: any[]) => boolean[];
  onDisabledRows?: TOnDisabledRows;
}

export type GateOpts<TRow, R extends readonly FlatKey<TRow>[]> = unknown extends TRow
  ? LooseGate
  : NoGate | WithGate<TRow, R>;

// ── Method-decorator opts (`@DbAction`) ────────────────────────────────────

interface BaseActionOpts extends Partial<
  Omit<TDbActionInfo, "name" | "level" | "processor" | "value" | "disabled">
> {
  /**
   * Bound table reference. REQUIRED on non-`AsDbReadableController` classes
   * when `disabled` is set OR a `@DbActionRow*` parameter is declared.
   *
   * Silently ignored on `AsDbReadableController` subclasses (which include
   * `AsDbController`) — the bound table from the controller wins.
   */
  table?: AtscriptDbTable<any>;
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
  | (DbActionsEntryWithGate<TRow, R> & { processor: "navigate"; value: string })
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
