import type { FilterExpr, Uniquery, WithRelation } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import { notSupported, unknownWithRelation } from "../db-error";
import { andFilters, relationStaticFilter } from "../query/relation-filter";
import { nestDottedWith } from "../shared/with-nesting";
import type { TReadControls } from "../strategies/field-mapping";
import type { TableMetadata } from "../table/table-metadata";
import type { DbQuery, TDbRelation, TResolvedWith, TTableResolver } from "../types";
import type { TGroupPage } from "./relation-helpers";

/**
 * The resolved `$with` plan (since 0.1.196): ONE resolution of a read's
 * `$with` entries — relation, target table, merged filter and controls —
 * consumed by the generic loader and by an adapter that reads relations
 * in-read (`supportsWithInRead()`).
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

// ── In-read ─────────────────────────────────────────────────────────────────

/** A related table of an in-read plan (an `AtscriptDbReadable`). */
export interface TInReadTable {
  readonly tableName: string;
  getAdapter(): BaseDbAdapter;
  _translateForAdapter(query: Uniquery): DbQuery;
  _resolveWithInRead(withRelations: WithRelation[], path: string): TInReadPlan;
  _rowsFromInRead(
    rows: Record<string, unknown>[],
    controls: TReadControls | undefined,
    nodes: readonly TInReadNode[],
  ): Promise<Record<string, unknown>[]>;
}

/** How one relation's values in the adapter's rows become logical rows. */
export interface TInReadNode {
  nav: string;
  isArray: boolean;
  target: TInReadTable;
  /** The logical controls the related rows were read with. */
  controls: TReadControls | undefined;
  children: TInReadNode[];
}

/** A `$with` tree planned for an in-read adapter: what it receives and how its rows are finished. */
export interface TInReadPlan {
  entries: TResolvedWith[];
  nodes: TInReadNode[];
}

/**
 * Plans the whole `$with` tree of `host` for an adapter that reads relations
 * in-read: each entry becomes the target's `_translateForAdapter(query)` (the
 * guard and stable sort a generic relation read runs), nested entries in its
 * `controls.$with`. Paging inside `$with` and a target on another store are
 * refused (`NOT_SUPPORTED`).
 */
export function resolveWithInRead(
  host: TWithPlanHost,
  withRelations: WithRelation[],
  path: string,
): TInReadPlan {
  const adapterName = host.adapter.constructor.name;
  const entries: TResolvedWith[] = [];
  const nodes: TInReadNode[] = [];
  for (const entry of planWith(host, nestDottedWith(withRelations), path)) {
    const where = path ? `${path}.${entry.nav}` : entry.nav;
    if (entry.page) {
      throw notSupported(
        `Relation "${where}": the ${adapterName} adapter reads relations inside the read and does not page them — $skip / $limit inside $with are not supported`,
        "$with",
      );
    }
    const target = entry.target as unknown as TInReadTable;
    if (typeof target._translateForAdapter !== "function") {
      throw new Error(
        `Relation "${where}" of "${host.tableName}": the table resolver's table cannot be read in-read`,
      );
    }
    const adapter = target.getAdapter();
    if (!host.adapter.sharesStoreWith(adapter)) {
      throw notSupported(
        `Relation "${where}": the related table lives in a different database or adapter — the ${adapterName} adapter reads relations inside the read`,
        "$with",
      );
    }
    const { $with, ...controls } = entry.query.controls;
    const nested = Array.isArray($with)
      ? target._resolveWithInRead($with as WithRelation[], where)
      : undefined;
    let query = target._translateForAdapter({ filter: entry.query.filter ?? {}, controls });
    if (nested && nested.entries.length > 0) {
      query = { ...query, controls: { ...query.controls, $with: nested.entries } };
    }
    entries.push({
      // `via` relations are refused at table build on such an adapter
      kind: entry.kind as TResolvedWith["kind"],
      nav: entry.nav,
      isArray: entry.isArray,
      target: { table: adapter.resolveTableName(), name: adapter.resolveTableName(false), adapter },
      query,
    });
    nodes.push({
      nav: entry.nav,
      isArray: entry.isArray,
      target,
      controls: controls as TReadControls,
      children: nested?.nodes ?? [],
    });
  }
  return { entries, nodes };
}

function contractError(adapter: BaseDbAdapter, message: string): Error {
  return new Error(`${adapter.constructor.name} ${message}`);
}

/**
 * Takes each requested relation's value off the adapter's rows (before they
 * are reconstructed), per node, per row. A row without one is an adapter
 * defect.
 */
export function detachRelations(
  rows: Record<string, unknown>[],
  nodes: readonly TInReadNode[],
  adapter: BaseDbAdapter,
): unknown[][] {
  return nodes.map((node) =>
    rows.map((row) => {
      const value = row[node.nav];
      if (value === undefined) {
        throw contractError(adapter, `returned a row without relation "${node.nav}"`);
      }
      const shapeOk = node.isArray
        ? Array.isArray(value)
        : value === null || (typeof value === "object" && !Array.isArray(value));
      if (!shapeOk) {
        throw contractError(
          adapter,
          `returned relation "${node.nav}" as ${Array.isArray(value) ? "an array" : typeof value}, expected ${node.isArray ? "an array" : "an object or null"}`,
        );
      }
      delete row[node.nav];
      return value;
    }),
  );
}

/**
 * Converts the detached relation values through each target's own
 * `_rowsFromInRead` (field mapping, value formatters, decryption, nested
 * relations) and attaches them to the logical rows `out` (1:1 with the
 * adapter's rows).
 */
export async function attachRelations(
  out: Record<string, unknown>[],
  values: unknown[][],
  nodes: readonly TInReadNode[],
): Promise<void> {
  await Promise.all(
    nodes.map(async (node, n) => {
      const perRow = values[n]!;
      const related: Record<string, unknown>[] = [];
      for (const value of perRow) {
        if (Array.isArray(value)) related.push(...(value as Record<string, unknown>[]));
        else if (value !== null) related.push(value as Record<string, unknown>);
      }
      const logical =
        related.length > 0
          ? await node.target._rowsFromInRead(related, node.controls, node.children)
          : [];
      let next = 0;
      for (let r = 0; r < out.length; r++) {
        const value = perRow[r];
        if (Array.isArray(value)) {
          out[r]![node.nav] = logical.slice(next, next + value.length);
          next += value.length;
        } else {
          out[r]![node.nav] = value === null ? null : logical[next++];
        }
      }
    }),
  );
}

/**
 * Why `meta`'s relations cannot be used with `adapter`'s relation
 * capabilities — `undefined` when they can. The table refuses every use
 * with this message.
 */
export function relationCapabilityProblem(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  tableName: string,
): string | undefined {
  if (meta.relations.size === 0) return undefined;
  const name = adapter.constructor.name;
  if (!adapter.supportsWithInRead()) {
    // `@db.rel.store`: only an adapter that reads relations in-read can hold it
    for (const [nav, relation] of meta.relations) {
      if (relation.direction === "store") {
        return `Relation "${nav}" of "${tableName}" has no foreign key; the ${name} adapter does not read relations in-read`;
      }
    }
    return undefined;
  }
  if (adapter.supportsNativeRelations()) {
    return `Table "${tableName}": the ${name} adapter declares both supportsNativeRelations() and supportsWithInRead() — relations are read one way`;
  }
  for (const [nav, relation] of meta.relations) {
    if (relation.direction === "via") {
      return `Relation "${nav}" of "${tableName}" is a @db.rel.via relation; the ${name} adapter reads relations in-read, where a junction table is not read`;
    }
    const prefix = `${nav}.`;
    if (meta.allPhysicalFields.some((column) => column === nav || column.startsWith(prefix))) {
      return `Navigation "${nav}" of "${tableName}" has the name of a stored column; the ${name} adapter reads relations in-read, where relation values travel in the row under the navigation name`;
    }
  }
  return undefined;
}
