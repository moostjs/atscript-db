import type { FilterExpr, WithRelation } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import { unknownWithRelation } from "../db-error";
import { andFilters, relationStaticFilter } from "../query/relation-filter";
import type { TDbRelation, TTableResolver } from "../types";
import type { TGroupPage } from "./relation-helpers";

/**
 * The resolved `$with` plan (since 0.1.196): ONE resolution of a read's
 * `$with` entries — relation, target table, merged filter and controls —
 * consumed by the generic loader.
 */

/** The table whose `$with` level is planned (an `AtscriptDbReadable`). */
export interface TWithPlanHost {
  readonly tableName: string;
  readonly _meta: { readonly relations: ReadonlyMap<string, TDbRelation> };
  readonly _tableResolver?: TTableResolver;
  readonly adapter: BaseDbAdapter;
}

/** A related table as the table resolver returns it. */
export type TWithTarget = NonNullable<ReturnType<TTableResolver>>;

/** One `$with` entry of a level, resolved against the host table. */
export interface TWithPlanEntry {
  kind: TDbRelation["direction"];
  nav: string;
  isArray: boolean;
  relation: TDbRelation;
  target: TWithTarget;
  /**
   * The target's logical query: the entry's filter AND the target part of
   * the relation's `@db.rel.filter`; the flat and nested controls merged
   * (nested wins), without `$skip` / `$limit` — a nested `$with` stays raw.
   */
  query: { filter?: FilterExpr; controls: Record<string, unknown> };
  /** `$skip` / `$limit`: they page the related rows of EACH parent row. */
  page?: TGroupPage;
  /** `@db.rel.via`: the junction part of the relation's `@db.rel.filter`. */
  junctionFilter?: FilterExpr;
}

const SET_CONTROLS = ["$sort", "$nulls", "$select", "$with"] as const;
const COUNT_CONTROLS = ["$limit", "$skip"] as const;

/**
 * An entry's controls: `@uniqu/url`'s `parseWithSegment` places `$sort` /
 * `$limit` / `$skip` / `$select` / `$with` as flat keys on the relation
 * object; the nested `controls` win over them.
 */
function mergedControls(withRel: WithRelation): Record<string, unknown> {
  const flat = withRel as Record<string, unknown>;
  const controls: Record<string, unknown> = {
    ...(withRel.controls as Record<string, unknown> | undefined),
  };
  for (const key of SET_CONTROLS) {
    if (flat[key] && !controls[key]) controls[key] = flat[key];
  }
  for (const key of COUNT_CONTROLS) {
    if (flat[key] !== null && flat[key] !== undefined && (controls[key] ?? null) === null) {
      controls[key] = flat[key];
    }
  }
  return controls;
}

/** A `$skip` / `$limit` value as a number (`undefined` when unset or not a number). */
function asCount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Plans one `$with` level of `host` (entries already nested, see
 * `nestDottedWith`). An unknown name is `UNKNOWN_RELATION`; a table without
 * a table resolver, or a target the resolver does not return, is a
 * configuration fault (plain `Error`). `path` is the navigation chain of the
 * level (`""` at the root), for messages.
 */
export function planWith(
  host: TWithPlanHost,
  withRelations: readonly WithRelation[],
  path = "",
): TWithPlanEntry[] {
  if (withRelations.length === 0) return [];
  const resolver = host._tableResolver;
  if (!resolver) {
    throw new Error(
      `Table "${host.tableName}" has no table resolver — $with needs one (tables of a DbSpace have it)`,
    );
  }
  return withRelations.map((withRel) => {
    const nav = withRel.name;
    const relation = host._meta.relations.get(nav);
    if (!relation) {
      throw unknownWithRelation(nav);
    }
    const target = resolver(relation.targetType());
    if (!target) {
      throw new Error(
        `Relation "${path ? `${path}.${nav}` : nav}" of "${host.tableName}": the table resolver returned no table for its target`,
      );
    }
    // `@db.rel.filter` is part of the relation: its target conditions AND the
    // `$with` sub-filter; its junction conditions filter the junction rows.
    const statics = relationStaticFilter(relation, nav);
    const merged = andFilters(statics.target, withRel.filter);
    const { $skip, $limit, ...controls } = mergedControls(withRel);
    const skip = asCount($skip) || undefined;
    const limit = asCount($limit);
    return {
      kind: relation.direction,
      nav,
      isArray: relation.isArray,
      relation,
      target,
      query: { filter: Object.keys(merged).length > 0 ? merged : undefined, controls },
      page: skip === undefined && limit === undefined ? undefined : { skip, limit },
      junctionFilter: statics.junction,
    };
  });
}
