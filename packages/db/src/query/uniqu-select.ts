import type { AggregateExpr, UniqueryControls } from "@uniqu/core";
import { isAggregateExpr } from "@uniqu/core";

import type { TResolvedBucket } from "./buckets";

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
 * aggregates (`{ $fn, $field }`, {@link aggregates}) and calendar buckets
 * (`{ $bucket, $field }`, {@link buckets}). Entries arrive normalized
 * (`resolveCalendarBuckets` rejects any other shape before translation).
 */
export class UniquSelect {
  private static readonly UNRESOLVED = Symbol("unresolved");

  private _raw: UniqueryControls["$select"];
  private _allFields?: string[];
  private _array: string[] | undefined | symbol = UniquSelect.UNRESOLVED;
  private _projection: Record<string, 0 | 1> | undefined | symbol = UniquSelect.UNRESOLVED;
  private _aggregates: AggregateExpr[] | undefined | symbol = UniquSelect.UNRESOLVED;
  /**
   * The calendar buckets of an aggregate `$select`, normalized (canonical
   * zone, week start, alias) with the PHYSICAL source `field` and its
   * descriptor `fd`. `undefined` when there are none. A `$groupBy` key equal
   * to a bucket's `alias` groups by that bucket (aliases never collide with
   * columns). Since 0.1.132.
   */
  readonly buckets: readonly TResolvedBucket[] | undefined;

  /**
   * @param raw - the `$select` value (field paths already physical).
   * @param allFields - physical field names, for exclusion-form inversion.
   * @param buckets - the resolved calendar buckets of the raw `$select`'s
   *   `{ $bucket }` entries (the field mappers supply them — physical `field`,
   *   source `fd`).
   */
  constructor(
    raw: UniqueryControls["$select"],
    allFields?: string[],
    buckets?: readonly TResolvedBucket[],
  ) {
    this._raw = raw;
    this._allFields = allFields;
    this.buckets = buckets?.length ? buckets : undefined;
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

  /**
   * Extracts AggregateExpr entries from array-form $select.
   * Returns undefined if no aggregates present or if $select is object form.
   */
  get aggregates(): AggregateExpr[] | undefined {
    if (this._aggregates !== UniquSelect.UNRESOLVED) {
      return this._aggregates as AggregateExpr[] | undefined;
    }
    if (!Array.isArray(this._raw)) {
      this._aggregates = undefined;
      return undefined;
    }
    const aggs = (this._raw as unknown[]).filter(isAggregateExpr);
    this._aggregates = aggs.length > 0 ? aggs : undefined;
    return this._aggregates;
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
