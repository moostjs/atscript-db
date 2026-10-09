import {
  isViewType,
  queryReadColumns,
  type AtscriptDbView,
  type DbQuery,
  type TReadColumnsKind,
  type TViewReadPlan,
} from "@atscript/db";
import type { Document } from "mongodb";

import { buildViewPipeline } from "./mongo-view-pipeline";

/**
 * A pruned read of a managed view: the view's own pipeline without the
 * `$lookup` + `$unwind` of the joins the read does not need, run on the
 * entry collection (`entry`), followed by the read's own stages.
 * @since 0.1.153
 */
export interface TMongoViewRead {
  /** The entry collection the pipeline runs on. */
  entry: string;
  /** The pruned view pipeline — prepend it to the read's stages. */
  prefix: Document[];
  /** View columns the prefix no longer produces. */
  dropped: readonly string[];
}

/** Rendered prefixes per read variant (variants are memoised by their view). */
const prefixes = new WeakMap<TViewReadPlan, Document[]>();

/**
 * The pruned read of `view` for `query`, or `undefined` to read the stored
 * view: nothing droppable, an external view, or an entry that is itself a
 * view (its collation and pipeline would be read twice).
 */
export function mongoViewRead(
  view: AtscriptDbView,
  query: DbQuery,
  kind: TReadColumnsKind,
): TMongoViewRead | undefined {
  const variant = view.readPlan(queryReadColumns(query, kind));
  if (!variant || isViewType(variant.plan.entryType())) return undefined;
  let prefix = prefixes.get(variant);
  if (!prefix) {
    prefix = buildViewPipeline(view, variant);
    prefixes.set(variant, prefix);
  }
  return { entry: variant.plan.entryTable, prefix, dropped: variant.droppedColumns };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether any stage may read one of the `dropped` view columns: a field path
 * string (`"$col"`, `"col.sub"`, a `localField`), an object key naming it, or
 * a whole-document variable (`$$ROOT` / `$$CURRENT`). Literals that happen to
 * equal a column name match too — that only falls back to the stored view.
 *
 * MongoDB never rejects a missing field, so this scan — not an engine error —
 * is what keeps a column reference the read-column collector did not report
 * from silently reading `null`.
 */
export function stagesReadAny(stages: unknown, dropped: readonly string[]): boolean {
  if (dropped.length === 0) return false;
  const names = (raw: string): boolean => {
    if (raw.startsWith("$$")) {
      const variable = raw.slice(2).split(".")[0];
      return variable === "ROOT" || variable === "CURRENT";
    }
    const path = raw.startsWith("$") ? raw.slice(1) : raw;
    if (!path) return false;
    return dropped.some(
      (col) => path === col || path.startsWith(`${col}.`) || col.startsWith(`${path}.`),
    );
  };
  const visit = (value: unknown): boolean => {
    if (typeof value === "string") return names(value);
    if (Array.isArray(value)) return value.some(visit);
    if (!isPlainObject(value)) return false;
    for (const [key, child] of Object.entries(value)) {
      if (names(key) || visit(child)) return true;
    }
    return false;
  };
  return visit(stages);
}
