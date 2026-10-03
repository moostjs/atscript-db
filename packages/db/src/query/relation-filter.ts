import type { AtscriptQueryFieldRef, AtscriptQueryNode } from "@atscript/typescript/utils";
import type { FilterExpr, RelationOp } from "@uniqu/core";
import { isRelationOp } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import { DbError } from "../db-error";
import { findFKEntryForRelation, findRemoteFK, tableNameOf } from "../rel/relation-helpers";
import { isPlainObject } from "../shared/object";
import type { TableMetadata } from "../table/table-metadata";
import type { TDbForeignKey, TDbRelation } from "../types";
import { isFieldRef, translateQueryTree } from "./query-tree";

/**
 * Relational filter predicates (`{ nav: { $some | $none: <filter on the
 * related table> } }`) — resolution against the related tables.
 *
 * Semantics: `rel(r, nav)` is exactly the set of related rows `$with=nav`
 * loads for row `r` (same foreign-key pairing, the relation's
 * `@db.rel.filter` included). `$some: F` holds when one of them matches `F`,
 * `$none: F` when none does; a NULL foreign-key component means "no related
 * row". The core resolves each predicate into a {@link ResolvedRelationFilter}
 * (physical names on every side, the inner filter translated by the related
 * table's own field mapper) before the adapter sees the filter — adapters
 * only render it.
 *
 * @since 0.1.147
 */

/**
 * Maximum nesting of relational predicates in one filter, server-added ones
 * included (a predicate inside a predicate's operand counts one level). The
 * core backstop for every caller; higher than moost-db's per-client limit
 * (`REL_FILTER_CLIENT_MAX_DEPTH`) so server overlays (row scopes,
 * `transformRelationFilter`) have headroom above what a client may send.
 */
export const REL_FILTER_MAX_DEPTH = 4;

/** Maximum number of relational predicates in one filter (nested and server-added ones included). See {@link REL_FILTER_MAX_DEPTH}. */
export const REL_FILTER_MAX_NODES = 16;

/** A table taking part in a resolved predicate. */
export interface TRelationFilterTable {
  /** The adapter's `resolveTableName()` — schema-qualified when the table has a `@db.schema`. */
  table: string;
  /** The adapter's `resolveTableName(false)` — the bare table / collection name. */
  name: string;
  /** The adapter instance bound to this table. */
  adapter: BaseDbAdapter;
}

/** The junction side of a resolved `via` predicate. */
export interface TRelationFilterJunction extends TRelationFilterTable {
  /** Junction column → the SOURCE column it references (physical names). */
  toSource: Array<{ junction: string; source: string }>;
  /** Junction column → the TARGET column it references (physical names). */
  toTarget: Array<{ junction: string; target: string }>;
  /** The junction part of the relation's `@db.rel.filter` (junction physical names), if any. */
  filter?: FilterExpr;
}

/**
 * Cross-realm brand of {@link ResolvedRelationFilter}: `instanceof` fails when
 * two copies of `@atscript/db` are loaded (ESM + CJS, or nested installs) and
 * an adapter from one sees nodes built by the other.
 */
const RESOLVED_BRAND = Symbol.for("@atscript/db:ResolvedRelationFilter");

/**
 * A relational predicate as adapters receive it — the operand of
 * `FilterVisitor.relation(field, op, operand)` once the core translated the
 * filter. Every name is physical:
 *
 * - `to` / `from`: `pairs` correlate a SOURCE column with a TARGET column
 *   (`target.<pair.target> = source.<pair.source>`, one pair per composite
 *   key part);
 * - `via`: `pairs` is empty — `junction.toSource` correlates the junction
 *   with the source row, `junction.toTarget` with the target row.
 *
 * `filter` is the inner filter on the TARGET (already translated by the
 * target's field mapper: renames, flattening, value formatters; nested
 * predicates resolved the same way), conjoined with the target part of the
 * relation's `@db.rel.filter`. `{}` matches every related row.
 *
 * @since 0.1.147
 */
export class ResolvedRelationFilter {
  /** @internal cross-realm brand (see {@link isResolvedRelationFilter}). */
  readonly [RESOLVED_BRAND] = true as const;
  readonly kind: "to" | "from" | "via";
  /** Logical navigation field name on the source table. */
  readonly nav: string;
  readonly source: TRelationFilterTable;
  readonly target: TRelationFilterTable;
  readonly pairs: ReadonlyArray<{ source: string; target: string }>;
  readonly junction?: TRelationFilterJunction;
  readonly filter: FilterExpr;

  constructor(init: {
    kind: "to" | "from" | "via";
    nav: string;
    source: TRelationFilterTable;
    target: TRelationFilterTable;
    pairs: Array<{ source: string; target: string }>;
    junction?: TRelationFilterJunction;
    filter: FilterExpr;
  }) {
    this.kind = init.kind;
    this.nav = init.nav;
    this.source = init.source;
    this.target = init.target;
    this.pairs = init.pairs;
    this.junction = init.junction;
    this.filter = init.filter;
  }
}

/** `true` for a {@link ResolvedRelationFilter} (the resolved operand of a predicate). */
export function isResolvedRelationFilter(value: unknown): value is ResolvedRelationFilter {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[RESOLVED_BRAND] === true
  );
}

/** `true` when `value` (a filter entry's value) is an operator map with a `$some` / `$none` key. */
export function hasRelationOp(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  for (const key in value) {
    if (isRelationOp(key)) return true;
  }
  return false;
}

/**
 * Pre-scan results of filters the core BUILT (translated / resolved
 * filters, never mutated after) — adapters scan the same translated filter
 * several times per operation. Caller-owned filters are never cached: they
 * may be mutated between two queries.
 */
const relationFilterCache = new WeakMap<object, boolean>();

/** @internal Records the pre-scan result of a filter the core built. */
export function noteRelationFilter(filter: unknown, has: boolean): void {
  if (filter && typeof filter === "object") relationFilterCache.set(filter, has);
}

/**
 * `true` when `filter` holds a relational predicate anywhere outside
 * predicate operands (through `$and` / `$or` / `$not`) — the cheap pre-scan
 * the field mappers and renderers use to keep predicate-free filters on
 * their fast paths. Results for filters the core translated are cached.
 */
export function containsRelationFilter(filter: unknown): boolean {
  if (!filter || typeof filter !== "object") return false;
  const cached = relationFilterCache.get(filter);
  if (cached !== undefined) return cached;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value) && value.some((child) => containsRelationFilter(child))) {
        return true;
      }
    } else if (key === "$not") {
      if (containsRelationFilter(value)) return true;
    } else if (!key.startsWith("$") && hasRelationOp(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Calls `visit` for every resolved predicate of a TRANSLATED filter,
 * depth-first: the top-level ones, then (with `nested`) those inside each
 * operand — target filters and junction filters alike. Adapters use it to
 * prepare per-predicate data (memory snapshots, self-referencing checks).
 */
export function forEachResolvedRelation(
  filter: unknown,
  visit: (node: ResolvedRelationFilter, op: RelationOp) => void,
  nested = true,
): void {
  if (!filter || typeof filter !== "object") return;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        for (const child of value) forEachResolvedRelation(child, visit, nested);
      }
    } else if (key === "$not") {
      forEachResolvedRelation(value, visit, nested);
    } else if (!key.startsWith("$") && isPlainObject(value)) {
      for (const [op, operand] of Object.entries(value)) {
        if (!isRelationOp(op) || !isResolvedRelationFilter(operand)) continue;
        visit(operand, op);
        if (nested) {
          forEachResolvedRelation(operand.filter, visit, nested);
          forEachResolvedRelation(operand.junction?.filter, visit, nested);
        }
      }
    }
  }
}

// ── Guard state ──────────────────────────────────────────────────────────────

/** Shared state of one guarded filter: predicate depth / count and the read/write mode. */
export interface TRelGuardState {
  /** Nesting level of the filter being guarded (0 = the query's own filter). */
  depth: number;
  /** Predicates seen so far in this query (shared by every level). */
  counter: { nodes: number };
  /** Mutation filter (`supportsRelationFilters('write')`) vs read filter. */
  write: boolean;
  /** Dotted navigation chain of the filter being guarded (`""` at the root). */
  path: string;
}

/** A fresh {@link TRelGuardState} for one query. */
export function relGuardState(write = false): TRelGuardState {
  return { depth: 0, counter: { nodes: 0 }, write, path: "" };
}

/** Installed on `TableMetadata.relationFilters` by the owning readable. */
export interface TRelationFilterHost {
  /** Validates one predicate's operand against the related table (recursively). */
  guard(nav: string, op: RelationOp, inner: FilterExpr, state: TRelGuardState): void;
  /** Resolves one predicate into its adapter-facing form; `depth` is this predicate's level (≥ 1). */
  resolve(nav: string, op: RelationOp, inner: FilterExpr, depth: number): ResolvedRelationFilter;
}

/** The readable surface the host needs (`AtscriptDbReadable` provides it). */
export interface TRelationFilterOwner {
  readonly tableName: string;
  getAdapter(): BaseDbAdapter;
  getMetadata(): TableMetadata;
  /** Guard an operand against THIS table (filter guard + path guard), `state` at its level. */
  _guardRelationOperand(filter: FilterExpr, state: TRelGuardState): void;
  /** Translate an operand for THIS table's adapter, nested predicates resolved at `depth + 1`. */
  _resolveRelationOperand(filter: FilterExpr, depth: number): FilterExpr;
}

function invalid(path: string, message: string): DbError {
  return new DbError("INVALID_QUERY", [{ path, message }]);
}

function notSupported(path: string, message: string): DbError {
  return new DbError("REL_FILTER_NOT_SUPPORTED", [{ path, message }]);
}

/** The present, non-empty `parts` ANDed (`{}` when none, a single one as is). */
export function andFilters(...parts: Array<FilterExpr | null | undefined>): FilterExpr {
  const present = parts.filter(
    (p): p is FilterExpr => p != null && Object.keys(p as object).length > 0,
  );
  if (present.length === 0) return {};
  if (present.length === 1) return present[0]!;
  return { $and: present } as FilterExpr;
}

// ── @db.rel.filter ───────────────────────────────────────────────────────────

/** A relation's `@db.rel.filter`, split by the table each condition reads (LOGICAL names). */
export interface TRelationStaticFilter {
  /** Conditions on the related (target) table. */
  target?: FilterExpr;
  /** Conditions on the junction table (`@db.rel.via` only). */
  junction?: FilterExpr;
}

const NO_STATIC_FILTER: TRelationStaticFilter = {};
const staticFilterCache = new WeakMap<TDbRelation, TRelationStaticFilter>();

/**
 * A relation's `@db.rel.filter` as logical filters per side — what `$with`
 * loading and relational predicates both AND into the related rows (the
 * filter is part of the relation's meaning). Top-level `and` conditions are
 * split by side: an unqualified field and the related type's fields go to
 * `target`, the `@db.rel.via` junction's to `junction`. A single condition
 * that reads both sides (e.g. an `or` across them) or compares two fields is
 * rejected with `INVALID_QUERY` — `name` is the navigation field (error path).
 *
 * @since 0.1.147
 */
export function relationStaticFilter(relation: TDbRelation, name = ""): TRelationStaticFilter {
  if (!relation.filter) return NO_STATIC_FILTER;
  const cached = staticFilterCache.get(relation);
  if (cached) return cached;

  const targetType = relation.targetType();
  const junctionType = relation.viaType?.();
  const targetName = tableNameOf(targetType);
  const junctionName = junctionType ? tableNameOf(junctionType) : undefined;
  const sideOf = (ref: AtscriptQueryFieldRef): "target" | "junction" => {
    const type = ref.type?.();
    if (!type || type === targetType || tableNameOf(type) === targetName) return "target";
    if (junctionType && (type === junctionType || tableNameOf(type) === junctionName)) {
      return "junction";
    }
    throw invalid(
      name,
      `@db.rel.filter on "${name}" references a type other than the related type` +
        (junctionType ? " and the junction" : "") +
        " — only those can be referenced",
    );
  };

  const target: FilterExpr[] = [];
  const junction: FilterExpr[] = [];
  const conjuncts = "$and" in relation.filter ? relation.filter.$and : [relation.filter];
  for (const conjunct of conjuncts) {
    const sides = new Set<"target" | "junction">();
    collectSides(conjunct, (ref) => sides.add(sideOf(ref)), name);
    if (sides.size > 1) {
      throw invalid(
        name,
        `@db.rel.filter on "${name}" has a condition reading both the junction and the related type — split it into separate "and" conditions`,
      );
    }
    const filter = translateQueryTree(conjunct, (ref) => ref.field);
    (sides.has("junction") ? junction : target).push(filter);
  }
  const result: TRelationStaticFilter = {
    target: target.length > 0 ? andFilters(...target) : undefined,
    junction: junction.length > 0 ? andFilters(...junction) : undefined,
  };
  staticFilterCache.set(relation, result);
  return result;
}

function collectSides(
  node: AtscriptQueryNode,
  visit: (ref: AtscriptQueryFieldRef) => void,
  name: string,
): void {
  if ("$and" in node) {
    for (const child of node.$and) collectSides(child, visit, name);
    return;
  }
  if ("$or" in node) {
    for (const child of node.$or) collectSides(child, visit, name);
    return;
  }
  if ("$not" in node) {
    collectSides(node.$not, visit, name);
    return;
  }
  visit(node.left);
  if (isFieldRef(node.right)) {
    throw invalid(
      name,
      `@db.rel.filter on "${name}" compares two fields — only field-to-value conditions are supported`,
    );
  }
}

// ── Host ─────────────────────────────────────────────────────────────────────

/** Logical pairing of one relation, resolved once per navigation field. */
interface TRelationPlan {
  kind: "to" | "from" | "via";
  relation: TDbRelation;
  target: TRelationFilterOwner;
  /** to / from: source field ↔ target field (logical). */
  pairs: Array<{ source: string; target: string }>;
  junction?: {
    owner: TRelationFilterOwner;
    toSource: Array<{ junction: string; source: string }>;
    toTarget: Array<{ junction: string; target: string }>;
  };
}

function zip<A extends string, B extends string>(
  left: string[],
  right: string[],
  a: A,
  b: B,
): Array<Record<A | B, string>> {
  return left.map((value, i) => ({ [a]: value, [b]: right[i]! }) as Record<A | B, string>);
}

/**
 * The {@link TRelationFilterHost} of a readable: resolves a navigation
 * field's related table (and junction) through `resolve` (the readable's
 * table resolver), pairing foreign keys exactly like `$with` loading does
 * (`findFKEntryForRelation` / `findRemoteFK`).
 */
export function createRelationFilterHost(
  owner: TRelationFilterOwner,
  resolve: (
    type: NonNullable<ReturnType<TDbRelation["targetType"]>>,
  ) => TRelationFilterOwner | undefined,
): TRelationFilterHost {
  const plans = new Map<string, TRelationPlan>();

  // Same STORE, not just the same adapter class: two drivers / connections /
  // databases of one class cannot be joined in one statement or pipeline.
  // Messages name the navigation path only — never a physical table name.
  const sameAdapter = (other: TRelationFilterOwner, path: string, what: string) => {
    if (!owner.getAdapter().sharesStoreWith(other.getAdapter())) {
      throw notSupported(
        path,
        `Relational predicate on "${path}": the ${what} table lives in a different database or adapter`,
      );
    }
  };

  const planOf = (nav: string, path: string): TRelationPlan => {
    const cached = plans.get(nav);
    if (cached) return cached;
    const meta = owner.getMetadata();
    const relation = meta.relations.get(nav);
    if (!relation) {
      throw invalid(
        path,
        `"$some" / "$none" are only valid on a navigation relation — "${nav}" is not one`,
      );
    }
    const target = resolve(relation.targetType());
    if (!target) {
      throw notSupported(
        path,
        `Relational predicate on "${path}": the related table is not available`,
      );
    }
    sameAdapter(target, path, "related");
    let plan: TRelationPlan;
    if (relation.direction === "to") {
      const fk = findFKEntryForRelation(relation, meta.foreignKeys);
      if (!fk) throw invalid(path, `Relation "${nav}" has no foreign key to filter by`);
      plan = {
        kind: "to",
        relation,
        target,
        pairs: zip(fk.fields, fk.targetFields, "source", "target"),
      };
    } else if (relation.direction === "from") {
      const fk = findRemoteFK(target.getMetadata(), owner.tableName, relation.alias);
      if (!fk) throw invalid(path, `Relation "${nav}" has no foreign key to filter by`);
      plan = {
        kind: "from",
        relation,
        target,
        pairs: zip(fk.targetFields, fk.fields, "source", "target"),
      };
    } else {
      const junctionType = relation.viaType?.();
      const junction = junctionType ? resolve(junctionType) : undefined;
      if (!junction) {
        throw notSupported(
          path,
          `Relational predicate on "${path}": the junction table is not available`,
        );
      }
      sameAdapter(junction, path, "junction");
      const junctionMeta = junction.getMetadata();
      const fkToThis: TDbForeignKey | undefined = findRemoteFK(junctionMeta, owner.tableName);
      const fkToTarget = findRemoteFK(junctionMeta, tableNameOf(relation.targetType()));
      if (!fkToThis || !fkToTarget) {
        throw invalid(path, `Relation "${nav}" has no junction foreign keys to filter by`);
      }
      if (fkToThis === fkToTarget) {
        throw invalid(
          path,
          `Relation "${nav}" is a self-referencing many-to-many — relational predicates cannot tell its two junction keys apart`,
        );
      }
      plan = {
        kind: "via",
        relation,
        target,
        pairs: [],
        junction: {
          owner: junction,
          toSource: zip(fkToThis.fields, fkToThis.targetFields, "junction", "source"),
          toTarget: zip(fkToTarget.fields, fkToTarget.targetFields, "junction", "target"),
        },
      };
    }
    plans.set(nav, plan);
    return plan;
  };

  const tableOf = (o: TRelationFilterOwner): TRelationFilterTable => {
    const adapter = o.getAdapter();
    return { table: adapter.resolveTableName(), name: adapter.resolveTableName(false), adapter };
  };

  return {
    guard(nav, op, inner, state) {
      const path = state.path ? `${state.path}.${nav}` : nav;
      const depth = state.depth + 1;
      // The caps count server-added predicates too, so their errors name no
      // path (a nav chain could be one the caller never sent).
      if (depth > REL_FILTER_MAX_DEPTH) {
        throw invalid("", `Relational predicates nest at most ${REL_FILTER_MAX_DEPTH} levels deep`);
      }
      if (++state.counter.nodes > REL_FILTER_MAX_NODES) {
        throw invalid("", `At most ${REL_FILTER_MAX_NODES} relational predicates per query`);
      }
      if (!isPlainObject(inner)) {
        throw invalid(path, `"${op}" on "${path}" expects a filter object`);
      }
      const plan = planOf(nav, path);
      relationStaticFilter(plan.relation, path);
      try {
        plan.target._guardRelationOperand(inner, { ...state, depth, path });
      } catch (error) {
        throw prefixError(error, path);
      }
    },

    resolve(nav, _op, inner, depth) {
      if (depth > REL_FILTER_MAX_DEPTH) {
        throw invalid("", `Relational predicates nest at most ${REL_FILTER_MAX_DEPTH} levels deep`);
      }
      const plan = planOf(nav, nav);
      const ownerMeta = owner.getMetadata();
      const targetMeta = plan.target.getMetadata();
      const statics = relationStaticFilter(plan.relation, nav);
      const filter = plan.target._resolveRelationOperand(andFilters(statics.target, inner), depth);
      let junction: TRelationFilterJunction | undefined;
      if (plan.junction) {
        const junctionMeta = plan.junction.owner.getMetadata();
        junction = {
          ...tableOf(plan.junction.owner),
          toSource: plan.junction.toSource.map((p) => ({
            junction: junctionMeta.physicalPath(p.junction),
            source: ownerMeta.physicalPath(p.source),
          })),
          toTarget: plan.junction.toTarget.map((p) => ({
            junction: junctionMeta.physicalPath(p.junction),
            target: targetMeta.physicalPath(p.target),
          })),
          ...(statics.junction
            ? { filter: plan.junction.owner._resolveRelationOperand(statics.junction, depth) }
            : {}),
        };
      }
      return new ResolvedRelationFilter({
        kind: plan.kind,
        nav,
        source: tableOf(owner),
        target: tableOf(plan.target),
        pairs: plan.pairs.map((p) => ({
          source: ownerMeta.physicalPath(p.source),
          target: targetMeta.physicalPath(p.target),
        })),
        junction,
        filter,
      });
    },
  };
}

/** Re-throws a related table's guard error with its paths under the navigation chain. */
function prefixError(error: unknown, path: string): unknown {
  if (!(error instanceof DbError)) return error;
  // Path-less errors (the depth / count caps) stay path-less: they may be
  // caused by server-added predicates, whose chain must not be named.
  if (error.errors.every((e) => !e.path)) return error;
  if (error.errors.every((e) => e.path === path || e.path.startsWith(`${path}.`))) return error;
  const errors = error.errors.map((e) => ({
    path: e.path ? `${path}.${e.path}` : path,
    message: e.message,
  }));
  return new DbError(error.code, errors, `${errors[0]?.message ?? error.message} (in "${path}")`);
}

/**
 * Resolves every relational predicate of a (logical) filter through
 * `meta.relationFilters` — the step every field-mapper entry point runs
 * first. Predicates at the top of `filter` are at level `depth + 1`.
 * Already-resolved operands pass through, so translating twice is safe.
 * One pass: unchanged subtrees (and `filter` itself, when nothing needed
 * resolving) are returned as they are.
 */
export function resolveRelationFilterTree(
  filter: FilterExpr,
  meta: TableMetadata,
  depth: number,
): FilterExpr {
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    let next = value;
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        let children: unknown[] | undefined;
        for (let i = 0; i < value.length; i++) {
          const child = value[i] as FilterExpr;
          if (!child || typeof child !== "object") continue;
          const resolved = resolveRelationFilterTree(child, meta, depth);
          if (resolved === child) continue;
          children ??= [...value];
          children[i] = resolved;
        }
        if (children) next = children;
      }
    } else if (key === "$not") {
      if (value && typeof value === "object") {
        next = resolveRelationFilterTree(value as FilterExpr, meta, depth);
      }
    } else if (!key.startsWith("$") && hasRelationOp(value)) {
      next = resolvePredicateMap(key, value, meta, depth);
    }
    if (next === value) continue;
    out ??= { ...(filter as Record<string, unknown>) };
    out[key] = next;
  }
  if (!out) return filter;
  noteRelationFilter(out, true);
  return out as FilterExpr;
}

/** One `{ $some | $none: … }` map of `key` resolved (operands already resolved pass through). */
function resolvePredicateMap(
  key: string,
  value: Record<string, unknown>,
  meta: TableMetadata,
  depth: number,
): Record<string, unknown> {
  const host = meta.relationFilters;
  if (!host) {
    if (!meta.navFields.has(key)) {
      throw invalid(
        key,
        `"$some" / "$none" are only valid on a navigation relation — "${key}" is not one`,
      );
    }
    throw notSupported(
      key,
      `Relational predicate on "${key}" needs the table to come from a DbSpace (no table resolver)`,
    );
  }
  const ops: Record<string, unknown> = {};
  for (const [op, operand] of Object.entries(value)) {
    if (!isRelationOp(op)) {
      throw invalid(key, `Cannot mix "$some" / "$none" with "${op}" on "${key}"`);
    }
    ops[op] = isResolvedRelationFilter(operand)
      ? operand
      : host.resolve(key, op, operand as FilterExpr, depth + 1);
  }
  return ops;
}
