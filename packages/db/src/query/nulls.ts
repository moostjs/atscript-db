import { isNullsPlacement } from "@uniqu/core";
import type { NullsPlacement, ResolvedRowOrderKey } from "@uniqu/core";

import { DbError } from "../db-error";
import { isPlainObject } from "../shared/object";
import type { TableMetadata } from "../table/table-metadata";

/** Annotation key of a field's default NULL placement (`@db.sort.nulls`). */
export const SORT_NULLS_ANNOTATION = "db.sort.nulls";

/** What a {@link NullsSource} is built from — one readable's facts. */
export interface TNullsSourceInit {
  meta: TableMetadata;
  tableName: string;
  /**
   * `true` for a view: a view column can be NULL whatever the field's
   * optionality (a left join, an aggregate over NULLs), so no `$nulls` entry
   * of a view is ever dropped as redundant.
   */
  isView: boolean;
  /** The adapter's `supportsNullsPlacement()`. */
  supported: boolean;
}

/**
 * Per-table NULL-placement resolution (since 0.1.153): built once per
 * readable, memoizing the per-path answers every sorted read asks for.
 */
export class NullsSource {
  private readonly _nullable = new Map<string, boolean>();
  private _hasDefaults?: boolean;

  constructor(private readonly _init: TNullsSourceInit) {}

  /** Whether any field carries a `@db.sort.nulls` default. */
  hasDefaults(): boolean {
    return (this._hasDefaults ??= [...this._init.meta.flatMap.keys()].some(
      (path) => this.defaultOf(path) !== undefined,
    ));
  }

  /** The `@db.sort.nulls` default of the LOGICAL field `path`, if any. */
  defaultOf(path: string): NullsPlacement | undefined {
    const type = this._init.meta.flatMap.get(path);
    const value = type?.metadata.get(SORT_NULLS_ANNOTATION as never) as unknown;
    return isNullsPlacement(value) ? value : undefined;
  }

  /**
   * Whether ordering by the LOGICAL field `path` can meet NULL (or a missing
   * value): the field or one of its parent objects is optional, the field is
   * a derived column, it is not a known field, or the source is a view. A
   * `$nulls` entry on any other field changes nothing and is dropped, so the
   * plain `ORDER BY` keeps using the index.
   */
  nullable(path: string): boolean {
    let answer = this._nullable.get(path);
    if (answer === undefined) {
      answer = this._init.isView || this._nullableField(path);
      this._nullable.set(path, answer);
    }
    return answer;
  }

  private _nullableField(path: string): boolean {
    const { meta } = this._init;
    const fd = meta.descriptorByPath.get(path);
    if (!fd || fd.derived) return true;
    for (let p = path; ; ) {
      if (meta.flatMap.get(p)?.optional === true) return true;
      const dot = p.lastIndexOf(".");
      if (dot === -1) return false;
      p = p.slice(0, dot);
    }
  }

  /**
   * The effective `$nulls` of the `$sort` keys of one read: the request's
   * entry, else the field's `@db.sort.nulls` default; entries on fields that
   * cannot be NULL ({@link nullable}) are dropped. `aliases` are the computed
   * output names of a grouped read — they take a request entry only and are
   * never dropped. Entries for keys that are not ordered by are ignored. On
   * an adapter without support a request entry is refused and defaults are
   * dropped.
   *
   * @returns LOGICAL keys (or aliases) → placement; `undefined` when none.
   * @throws DbError `INVALID_QUERY` on a malformed `$nulls`, or a request
   *   entry the adapter cannot honour.
   */
  resolveSort(
    sort: unknown,
    rawNulls: unknown,
    aliases?: ReadonlySet<string>,
  ): Record<string, NullsPlacement> | undefined {
    const requested = checkNullsControl(rawNulls);
    if (!isPlainObject(sort)) return undefined;
    let nulls: Record<string, NullsPlacement> | undefined;
    for (const key of Object.keys(sort)) {
      const asked = requested && Object.hasOwn(requested, key) ? requested[key] : undefined;
      const placement = aliases?.has(key) ? asked : this._placement(key, asked);
      if (placement && this._allowed(asked)) (nulls ??= {})[key] = placement;
    }
    return nulls;
  }

  /**
   * `$rowOrder` keys (as uniqu resolved them, `nulls` from the request) under
   * the rules of {@link resolveSort}: defaults filled in, placements on
   * fields that cannot be NULL (or on an unsupporting adapter) dropped.
   */
  resolveRowOrder(rowOrder: ResolvedRowOrderKey[] | undefined): ResolvedRowOrderKey[] | undefined {
    return rowOrder?.map((key) => {
      const placement = this._placement(key.field, key.nulls);
      const nulls = placement && this._allowed(key.nulls) ? placement : undefined;
      if (nulls === key.nulls) return key;
      return nulls ? { ...key, nulls } : { field: key.field, desc: key.desc };
    });
  }

  /** The placement of field `path` — the request's `asked`, else its default — or `undefined` when it cannot be NULL. */
  private _placement(path: string, asked: NullsPlacement | undefined): NullsPlacement | undefined {
    return this.nullable(path) ? (asked ?? this.defaultOf(path)) : undefined;
  }

  /** Whether a placement may be forwarded; a requested one on an unsupporting adapter is refused. */
  private _allowed(asked: NullsPlacement | undefined): boolean {
    if (this._init.supported) return true;
    if (asked) {
      throw new DbError("INVALID_QUERY", [
        {
          path: "$nulls",
          message: `NULL placement ($nulls / :first / :last) is not supported by the adapter of "${this._init.tableName}"`,
        },
      ]);
    }
    return false;
  }
}

/**
 * The raw `$nulls` control as a checked map, or `undefined` when absent.
 * @throws DbError `INVALID_QUERY` (`path: "$nulls"`) on a non-object or a
 * value other than `'first'` / `'last'`.
 */
export function checkNullsControl(raw: unknown): Record<string, NullsPlacement> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    throw new DbError("INVALID_QUERY", [
      { path: "$nulls", message: "$nulls must be an object of field → 'first' | 'last'" },
    ]);
  }
  for (const [field, value] of Object.entries(raw)) {
    if (!isNullsPlacement(value)) {
      throw new DbError("INVALID_QUERY", [
        { path: "$nulls", message: `$nulls "${field}" must be 'first' or 'last'` },
      ]);
    }
  }
  return raw as Record<string, NullsPlacement>;
}
