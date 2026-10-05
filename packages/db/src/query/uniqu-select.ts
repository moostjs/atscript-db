import type { AggregateExpr, UniqueryControls } from "@uniqu/core";
import { isAggregateExpr, resolveAlias } from "@uniqu/core";
import type { AtscriptExprNode } from "@atscript/typescript/utils";

import { isFirstLast } from "./aggregate-fns";
import type { TDbFieldMeta } from "../types";
import type { TResolvedBucket } from "./buckets";

/** A row-level expression aggregate: `fn(<expr>)` over each row (physical field leaves). */
export interface TExprAggregate {
  fn: "sum" | "avg" | "min" | "max";
  alias: string;
  expr: AtscriptExprNode;
  /** The distinct physical columns the expression reads. */
  names: readonly string[];
}

/** A group-level expression: leaves name aliases of other entries or grouped columns. */
export interface TSelectExpr {
  alias: string;
  expr: AtscriptExprNode;
  /** The distinct names the expression reads (aliases of other entries, or grouped columns). */
  names: readonly string[];
}

/** A `first` / `last` entry: the value of PHYSICAL `column` on the group's representative row. */
export interface TFirstLast {
  fn: "first" | "last";
  column: string;
  alias: string;
}

/** One key of the representative-row order (PHYSICAL column). */
export interface TRowOrderKey {
  column: string;
  desc: boolean;
}

/** The arithmetic and representative-row parts of an aggregate `$select`, as the field mapper resolves them. */
export interface TUniquComputed {
  exprAggregates?: readonly TExprAggregate[];
  exprs?: readonly TSelectExpr[];
  rowOrder?: readonly TRowOrderKey[];
  sources?: ReadonlyMap<string, TDbFieldMeta>;
}

/**
 * Wraps a raw `$select` value and provides lazy-cached conversions
 * to the forms different adapters need.
 *
 * Only instantiated when `$select` is actually provided —
 * `controls.$select` is `UniquSelect | undefined`.
 *
 * For exclusion → inclusion inversion, pass `allFields` (physical field names).
 *
 * An array `$select` holds plain field names and computed entries —
 * aggregates (`{ $fn, $field }`, {@link aggregates}), `first` / `last`
 * ({@link firstLast}), arithmetic ({@link exprAggregates}, {@link exprs}) and
 * calendar buckets (`{ $bucket, $field }`, {@link buckets}). Entries arrive normalized
 * (`normalizeComputedSelect` rejects any other shape before translation).
 */
export class UniquSelect {
  private static readonly UNRESOLVED = Symbol("unresolved");

  private _raw: UniqueryControls["$select"];
  private _allFields?: string[];
  private _array: string[] | undefined | symbol = UniquSelect.UNRESOLVED;
  private _projection: Record<string, 0 | 1> | undefined | symbol = UniquSelect.UNRESOLVED;
  /**
   * The calendar buckets of an aggregate `$select`, normalized (canonical
   * zone, week start, alias) with the PHYSICAL source `field` and its
   * descriptor `fd`. `undefined` when there are none. A `$groupBy` key equal
   * to a bucket's `alias` groups by that bucket (aliases never collide with
   * columns). Since 0.1.132.
   */
  readonly buckets: readonly TResolvedBucket[] | undefined;
  /**
   * The plain aggregates (`{ $fn, $field }`) of an array-form `$select`;
   * `undefined` when there are none or the `$select` is object form.
   * `first` / `last` are listed separately ({@link firstLast}), so an adapter
   * written before them never meets one here.
   */
  readonly aggregates: AggregateExpr[] | undefined;
  /** The `first` / `last` entries of an array-form `$select` (since 0.1.148); `undefined` when none. */
  readonly firstLast: readonly TFirstLast[] | undefined;
  /**
   * Row-level expression aggregates (`sum(price*qty)`) — leaves are physical
   * columns; render `fn(<expr>)` per row. `undefined` when there are none.
   * Only reaches adapters whose `supportsAggregateExpressions()` is true.
   * Since 0.1.148.
   */
  readonly exprAggregates: readonly TExprAggregate[] | undefined;
  /**
   * Group-level expressions in dependency order: each leaf names an alias
   * defined by an aggregate / `first` / `last` / expression entry or a
   * grouped column; evaluate after grouping. `undefined` when there are none.
   * Since 0.1.148.
   */
  readonly exprs: readonly TSelectExpr[] | undefined;
  /**
   * The order of the rows inside each group that `first` / `last` read, as
   * physical columns, with the primary key appended as the final ascending
   * tie-break. `undefined` without `first` / `last`. Since 0.1.148.
   */
  readonly rowOrder: readonly TRowOrderKey[] | undefined;
  /**
   * The descriptors of the PHYSICAL columns a `min` / `max` / `first` / `last`
   * reads — for an engine that cannot aggregate a type directly (PostgreSQL
   * has no `MIN(boolean)`). Since 0.1.148.
   */
  readonly sources: ReadonlyMap<string, TDbFieldMeta>;
  /**
   * The output alias of every computed entry but the calendar buckets, in the
   * order adapters emit them: {@link aggregates}, {@link exprAggregates},
   * {@link firstLast}, then {@link exprs} (which read the others). Since 0.1.148.
   */
  readonly computedAliases: readonly string[];

  /**
   * @param raw - the `$select` value (field paths already physical).
   * @param allFields - physical field names, for exclusion-form inversion.
   * @param buckets - the resolved calendar buckets of the raw `$select`'s
   *   `{ $bucket }` entries (the field mappers supply them — physical `field`,
   *   source `fd`).
   * @param computed - the resolved arithmetic and `$rowOrder` parts (physical).
   */
  constructor(
    raw: UniqueryControls["$select"],
    allFields?: string[],
    buckets?: readonly TResolvedBucket[],
    computed?: TUniquComputed,
  ) {
    this._raw = raw;
    this._allFields = allFields;
    this.buckets = buckets?.length ? buckets : undefined;
    this.exprAggregates = computed?.exprAggregates?.length ? computed.exprAggregates : undefined;
    this.exprs = computed?.exprs?.length ? computed.exprs : undefined;
    this.rowOrder = computed?.rowOrder?.length ? computed.rowOrder : undefined;
    this.sources = computed?.sources ?? new Map();

    // One pass over an array `$select`: plain aggregates and `first` / `last`.
    const aggregates: AggregateExpr[] = [];
    const firstLast: TFirstLast[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw as unknown[]) {
        if (isFirstLast(item)) {
          firstLast.push({ fn: item.$fn, column: item.$field, alias: resolveAlias(item) });
        } else if (isAggregateExpr(item)) {
          aggregates.push(item);
        }
      }
    }
    this.aggregates = aggregates.length > 0 ? aggregates : undefined;
    this.firstLast = firstLast.length > 0 ? firstLast : undefined;
    this.computedAliases = [
      ...aggregates.map((expr) => resolveAlias(expr)),
      ...(this.exprAggregates ?? []).map((e) => e.alias),
      ...firstLast.map((fl) => fl.alias),
      ...(this.exprs ?? []).map((e) => e.alias),
    ];
  }

  /**
   * Resolved inclusion array of plain field names (strings only).
   * Computed entries (aggregates, calendar buckets) are filtered out.
   * For exclusion form, inverts using `allFields` from constructor.
   */
  get asArray(): string[] | undefined {
    if (this._array !== UniquSelect.UNRESOLVED) {
      return this._array as string[] | undefined;
    }

    if (Array.isArray(this._raw)) {
      this._array = (this._raw as unknown[]).filter(
        (item): item is string => typeof item === "string",
      );
      return this._array;
    }

    const raw = this._raw as Record<string, number>;
    const entries = Object.entries(raw);
    if (entries.length === 0) {
      this._array = undefined;
      return undefined;
    }

    if (entries[0][1] === 1) {
      // Inclusion form — extract keys with value 1
      this._array = entries.filter((e) => e[1] === 1).map((e) => e[0]);
    } else if (this._allFields) {
      // Exclusion form — invert using allFields
      const excluded = new Set(entries.filter((e) => e[1] === 0).map((e) => e[0]));
      this._array = this._allFields.filter((f) => !excluded.has(f));
    } else {
      this._array = undefined;
    }

    return this._array;
  }

  /**
   * Record projection preserving original semantics.
   * Returns original object as-is if raw was object.
   * Converts `string[]` to `{field: 1}` inclusion object.
   * AggregateExpr objects in array form are ignored.
   */
  get asProjection(): Record<string, 0 | 1> | undefined {
    if (this._projection !== UniquSelect.UNRESOLVED) {
      return this._projection as Record<string, 0 | 1> | undefined;
    }

    if (!Array.isArray(this._raw)) {
      const raw = this._raw as Record<string, 0 | 1>;
      this._projection = Object.keys(raw).length === 0 ? undefined : raw;
      return this._projection;
    }

    const strings = this.asArray;
    if (!strings || strings.length === 0) {
      this._projection = undefined;
      return undefined;
    }
    const result: Record<string, 1> = {};
    for (const item of strings) {
      result[item] = 1;
    }
    this._projection = result;
    return this._projection;
  }

  /** Whether the $select contains any AggregateExpr entries. */
  get hasAggregates(): boolean {
    return !!this.aggregates?.length;
  }

  /** The calendar bucket whose alias is `key`, if any — how adapters resolve a `$groupBy` / `$having` key. */
  bucketByAlias(key: string): TResolvedBucket | undefined {
    return this.buckets?.find((b) => b.alias === key);
  }
}
