import type { FilterExpr, FilterVisitor, RelationOp, ResolvedRelationFilter } from "@atscript/db";
import {
  andFilters,
  containsRelationPredicate,
  DbError,
  isResolvedRelationFilter,
  walkFilter,
} from "@atscript/db";
import type { Document, Filter } from "mongodb";

import { correlate } from "./lookup-join";
import { fieldCompareExpr } from "./mongo-view-expr";

const EMPTY: Filter<any> = {};

function parseRegexString(value: unknown): { pattern: string; flags: string } {
  if (value instanceof RegExp) {
    return { pattern: value.source, flags: value.flags };
  }
  const str = String(value);
  const match = str.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    return { pattern: match[1]!, flags: match[2]! };
  }
  return { pattern: str, flags: "" };
}

/**
 * Earth radius in meters used by MongoDB's `$centerSphere` radians conversion
 * (Mongo documents dividing by 6378.1 km).
 */
const EARTH_RADIUS_M = 6_378_100;

const mongoVisitor: FilterVisitor<Filter<any>> = {
  comparison(field: string, op: string, value: unknown): Filter<any> {
    if (op === "$eq") {
      return { [field]: value };
    }
    if (op === "$exists") {
      // `$exists` = "holds a value" (a stored null counts as absent, as in SQL) —
      // native `$exists` is key presence. See docs/api/queries.md.
      return value ? { [field]: { $ne: null } } : { [field]: null };
    }
    if (op === "$regex") {
      const { pattern, flags } = parseRegexString(value);
      return flags
        ? { [field]: { $regex: pattern, $options: flags } }
        : { [field]: { $regex: pattern } };
    }
    if (op === "$geoWithin") {
      // Circle predicate (core-validated shape: { center: [lng, lat], radius: meters }).
      // $centerSphere takes radians — meters / earth radius. Works without an index.
      const { center, radius } = value as { center: [number, number]; radius: number };
      return { [field]: { $geoWithin: { $centerSphere: [center, radius / EARTH_RADIUS_M] } } };
    }
    return { [field]: { [op]: value } };
  },
  and(children: Array<Filter<any>>): Filter<any> {
    if (children.length === 0) {
      return EMPTY;
    }
    if (children.length === 1) {
      return children[0];
    }
    return { $and: children };
  },
  or(children: Array<Filter<any>>): Filter<any> {
    if (children.length === 0) {
      return { _impossible: true };
    }
    if (children.length === 1) {
      return children[0];
    }
    return { $or: children };
  },
  not(child: Filter<any>): Document {
    return { $nor: [child] };
  },
  relation(field: string, op: RelationOp): Filter<any> {
    // A predicate needs `$lookup` stages — only `buildMongoQuery` renders it.
    throw new DbError("REL_FILTER_NOT_SUPPORTED", [
      {
        path: field,
        message: `Relational predicate "${op}" on "${field}" reached a plain MongoDB filter — it needs an aggregation pipeline (buildMongoQuery)`,
      },
    ]);
  },
};

/** A `{ $field: path }` comparison operand (a field-to-field comparison). */
function isFieldOperand(value: unknown): value is { $field: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { $field?: unknown }).$field === "string"
  );
}

/**
 * {@link mongoVisitor} plus field-to-field comparisons (`{ $field }` operands →
 * `$expr`), null-guarded like SQL ({@link fieldCompareExpr}).
 */
const fieldOperandVisitor: FilterVisitor<Filter<any>> = {
  ...mongoVisitor,
  comparison(field, op, value) {
    return isFieldOperand(value)
      ? { $expr: fieldCompareExpr(op, `$${field}`, `$${value.$field}`) }
      : mongoVisitor.comparison(field, op, value);
  },
};

/**
 * Translates a generic {@link FilterExpr} into a MongoDB-compatible
 * {@link Filter} document.
 *
 * MongoDB's query language is nearly identical to the `FilterExpr` structure,
 * so this is largely a structural pass-through via the `walkFilter` visitor.
 * `fieldOperands` (view predicates only — `translateQueryTree` output) turns
 * `{ $field: path }` operands into field-to-field `$expr` comparisons; a
 * request filter never gets that reading.
 *
 * Predicate-free filters only: a relational predicate (`$some` / `$none`)
 * throws `REL_FILTER_NOT_SUPPORTED` — render those with
 * {@link buildMongoQuery} / {@link mongoFilterStages}.
 */
export function buildMongoFilter(
  filter: FilterExpr,
  { fieldOperands = false }: { fieldOperands?: boolean } = {},
): Filter<any> {
  if (!filter || Object.keys(filter).length === 0) {
    return EMPTY;
  }
  return walkFilter(filter, fieldOperands ? fieldOperandVisitor : mongoVisitor) ?? EMPTY;
}

// ── Relational predicates ($some / $none) ─────────────────────────────────────

/**
 * A filter rendered for an aggregation pipeline — what
 * {@link buildMongoQuery} returns. Stage order: `$match: pre` (when set),
 * the `lookups`, `$match: match` (when non-empty), `$unset: temp`
 * ({@link mongoFilterStages} assembles them).
 *
 * @since 0.1.147
 */
export interface TMongoFilterPlan {
  /** The predicate-free top-level conjuncts — matched BEFORE the lookups, so they run only for surviving documents. */
  pre?: Filter<any>;
  /** One `$lookup` per relational predicate, each writing a `__rf<n>` array (at most one element). */
  lookups: Document[];
  /** The rest of the filter, predicates read as `{ __rf<n>: { $ne: [] } }` (`$some`) / `{ __rf<n>: { $size: 0 } }` (`$none`). */
  match: Filter<any>;
  /** The temporary `__rf<n>` fields the lookups add (dropped with `$unset`). */
  temp: string[];
}

/** Splits a filter's top-level conjuncts (keys, `$and` members) by whether they hold a predicate. */
function splitConjuncts(filter: FilterExpr, pre: FilterExpr[], post: FilterExpr[]): void {
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and" && Array.isArray(value)) {
      for (const child of value as FilterExpr[]) splitConjuncts(child, pre, post);
      continue;
    }
    const part = { [key]: value } as FilterExpr;
    (containsRelationPredicate(part) ? post : pre).push(part);
  }
}

function isEmptyFilter(filter: Filter<any> | undefined): boolean {
  return !filter || Object.keys(filter).length === 0;
}

/** A per-query renderer: one `__rf<n>` / variable counter shared by every nesting level. */
function createPredicateRenderer() {
  let seq = 0;

  const level = (filter: FilterExpr | undefined): TMongoFilterPlan => {
    const preParts: FilterExpr[] = [];
    const postParts: FilterExpr[] = [];
    if (filter) splitConjuncts(filter, preParts, postParts);
    const lookups: Document[] = [];
    const temp: string[] = [];
    const visitor: FilterVisitor<Filter<any>> = {
      ...mongoVisitor,
      relation(field, op, operand) {
        if (!isResolvedRelationFilter(operand)) {
          throw new DbError("REL_FILTER_NOT_SUPPORTED", [
            {
              path: field,
              message: `Relational predicate "${op}" on "${field}" was not resolved by the table — query through the table API`,
            },
          ]);
        }
        const as = `__rf${seq++}`;
        lookups.push(lookupOf(operand, as));
        temp.push(as);
        return op === "$some" ? { [as]: { $ne: [] } } : { [as]: { $size: 0 } };
      },
    };
    const pre = preParts.length > 0 ? buildMongoFilter(andFilters(...preParts)) : undefined;
    const match =
      postParts.length > 0 ? (walkFilter(andFilters(...postParts), visitor) ?? EMPTY) : EMPTY;
    return { pre: isEmptyFilter(pre) ? undefined : pre, lookups, match, temp };
  };

  /**
   * Stages narrowing a lookup's documents to `filter` (nested predicates
   * included). No `$unset`: the lookup projects `_id` only.
   */
  const filterStages = (filter: FilterExpr | undefined): Document[] =>
    stagesOf(level(filter), false);

  const lookupOf = (node: ResolvedRelationFilter, as: string): Document => {
    const exists = [{ $limit: 1 }, { $project: { _id: 1 } }];
    if (node.kind !== "via" || !node.junction) {
      const join = correlate(
        as.slice(2),
        node.pairs.map((p) => ({ outer: p.source, inner: p.target })),
      );
      return {
        $lookup: {
          from: node.target.name,
          let: join.let,
          pipeline: [join.match, ...filterStages(node.filter), ...exists],
          as,
        },
      };
    }
    // via: ∃ junction row J (correlated with the source, junction part of
    // @db.rel.filter) with ∃ target row T (correlated with J, inner filter).
    const junction = node.junction;
    const targetAs = `__rf${seq++}`;
    const toSource = correlate(
      as.slice(2),
      junction.toSource.map((p) => ({ outer: p.source, inner: p.junction })),
    );
    const toTarget = correlate(
      targetAs.slice(2),
      junction.toTarget.map((p) => ({ outer: p.junction, inner: p.target })),
    );
    return {
      $lookup: {
        from: junction.name,
        let: toSource.let,
        pipeline: [
          toSource.match,
          ...filterStages(junction.filter),
          {
            $lookup: {
              from: node.target.name,
              let: toTarget.let,
              pipeline: [toTarget.match, ...filterStages(node.filter), ...exists],
              as: targetAs,
            },
          },
          { $match: { [targetAs]: { $ne: [] } } },
          ...exists,
        ],
        as,
      },
    };
  };

  return level;
}

/**
 * Renders a translated filter that may hold relational predicates
 * (`{ nav: { $some | $none: ResolvedRelationFilter } }`) for an aggregation
 * pipeline. Each predicate becomes a correlated `$lookup` into the related
 * collection (`let` = the source key fields, `$ne: null` guard per key part,
 * the inner filter — nested predicates as lookups inside it — then
 * `$limit: 1`); `via` looks up the junction, and inside it the target. The
 * predicate itself reads the lookup's `__rf<n>` array. Top-level conjuncts
 * without predicates go to `pre` so the lookups run only for documents that
 * survive them.
 *
 * A predicate-free filter yields `{ pre, lookups: [], match: {}, temp: [] }`.
 *
 * @since 0.1.147
 */
export function buildMongoQuery(filter: FilterExpr | undefined): TMongoFilterPlan {
  return createPredicateRenderer()(filter);
}

/**
 * The pipeline stages that apply `filter`: `[{ $match }]` for a
 * predicate-free filter (exactly what the reads always emitted), else
 * `$match(pre)` → predicate `$lookup`s → `$match` → `$unset` of the
 * `__rf<n>` fields ({@link buildMongoQuery}).
 *
 * @since 0.1.147
 */
export function mongoFilterStages(filter: FilterExpr | undefined): Document[] {
  if (!containsRelationPredicate(filter)) {
    return [{ $match: buildMongoFilter(filter as FilterExpr) }];
  }
  return planStages(buildMongoQuery(filter));
}

/**
 * The stages of a {@link TMongoFilterPlan}, in order: `$match(pre)`, the
 * lookups, `$match(match)`, `$unset` of the `__rf<n>` fields.
 *
 * @since 0.1.147
 */
export function planStages(plan: TMongoFilterPlan): Document[] {
  return stagesOf(plan, true);
}

function stagesOf(plan: TMongoFilterPlan, unset: boolean): Document[] {
  const stages: Document[] = [];
  if (plan.pre) stages.push({ $match: plan.pre });
  stages.push(...plan.lookups);
  if (!isEmptyFilter(plan.match)) stages.push({ $match: plan.match });
  if (unset && plan.temp.length > 0) stages.push({ $unset: plan.temp });
  return stages;
}
