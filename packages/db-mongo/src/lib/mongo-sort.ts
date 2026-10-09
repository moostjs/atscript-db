import { isNullsPlacement as isPlacement } from "@uniqu/core";
import type { NullsPlacement } from "@uniqu/core";
import type { Document } from "mongodb";

import { isNullExpr } from "./mongo-view-expr";

/**
 * Prefix of the temporary fields a NULL-placement sort adds (one per placed
 * key: `__atscript_nulls_0`, `__atscript_nulls_1`, …). Reserved — a stored
 * field never carries it — and dropped before any row leaves the pipeline.
 *
 * @since 0.1.153
 */
export const NULLS_FLAG_PREFIX = "__atscript_nulls_";

/** A `$sort` spec and its `$nulls` entries (keys as the `$sort` names them). */
export interface TSortSpec {
  $sort?: Record<string, unknown>;
  $nulls?: Record<string, unknown>;
}

/** The ordering stages of one read — see {@link sortStages}. */
export interface TSortStages {
  /** `[$addFields(flags)?, $sort]` — empty when there is no `$sort`. */
  stages: Document[];
  /** The `$project` dropping the flags (after `$skip` / `$limit`); `undefined` when none were added. */
  cleanup?: Document;
}

/**
 * Whether `controls` places NULL for at least one of its `$sort` keys
 * differently from BSON order (null and missing smallest: `'first'`
 * ascending and `'last'` descending need no flag — {@link placedKey}).
 */
export function hasNullsPlacement(controls: object | undefined): boolean {
  const { $sort: sort, $nulls: nulls } = (controls ?? {}) as TSortSpec;
  if (!sort || !nulls) return false;
  for (const [key, dir] of Object.entries(sort)) {
    if (placedKey(nulls[key], dir)) return true;
  }
  return false;
}

/**
 * The placement of one `$sort` key when it differs from BSON order, else
 * `undefined` — a native placement keeps the plain, index-served sort.
 */
function placedKey(placement: unknown, dir: unknown): NullsPlacement | undefined {
  if (!isPlacement(placement)) return undefined;
  return (placement === "first") === (dir !== -1) ? undefined : placement;
}

/**
 * The stages ordering rows by `$sort` with the `$nulls` placement of its keys.
 *
 * Without a placement entry that differs from BSON order (null and missing
 * are the smallest values) this is exactly `[{ $sort }]`. Otherwise each
 * placed key `k` gets a flag — `true` when `k` is null or missing — added before the
 * sort and ordered right before `k`: descending for `'first'`, ascending for
 * `'last'`, whatever `k`'s own direction. `cleanup` drops the flags again;
 * the caller emits it after `$skip` / `$limit` and before any projection.
 *
 * `find().sort()` cannot express this — a placed sort runs as a pipeline,
 * and it is a blocking sort (no index serves the computed flag).
 */
export function sortStages(controls: object | undefined): TSortStages {
  const { $sort: sort, $nulls: nulls } = (controls ?? {}) as TSortSpec;
  if (!sort) return { stages: [] };
  if (!hasNullsPlacement(controls)) return { stages: [{ $sort: sort }] };

  const flags: Document = {};
  const drop: Document = {};
  const ordered: Record<string, unknown> = {};
  let n = 0;
  for (const [key, dir] of Object.entries(sort)) {
    const placement = placedKey(nulls![key], dir);
    if (placement) {
      const flag = `${NULLS_FLAG_PREFIX}${n++}`;
      flags[flag] = isNullExpr(`$${key}`);
      drop[flag] = 0;
      ordered[flag] = placement === "first" ? -1 : 1;
    }
    ordered[key] = dir;
  }
  return { stages: [{ $addFields: flags }, { $sort: ordered }], cleanup: { $project: drop } };
}

/**
 * The `$sort` of a `first()` / `last()` row order (`TRowOrderKey[]`), with
 * the flags its `nulls` entries need. Rows are grouped right after, so the
 * flags never reach a row — `$last` reads the same forward order, so a
 * placement holds for both ends.
 */
export function rowOrderStages(
  rowOrder: ReadonlyArray<{ column: string; desc: boolean; nulls?: NullsPlacement }>,
): Document[] {
  const sort: Record<string, 1 | -1> = {};
  const nulls: Record<string, NullsPlacement> = {};
  for (const k of rowOrder) {
    sort[k.column] = k.desc ? -1 : 1;
    if (k.nulls) nulls[k.column] = k.nulls;
  }
  return sortStages({ $sort: sort, $nulls: nulls }).stages;
}
