import type {
  FilterExpr,
  FilterVisitor,
  RelationOp,
  ResolvedRelationFilter,
  TDbCollation,
} from "@atscript/db";
import {
  andFilters,
  containsRelationFilter,
  DbError,
  isResolvedRelationFilter,
  walkFilter,
} from "@atscript/db";
import type { Document, Filter } from "mongodb";
import { BSONRegExp } from "mongodb";

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
  {
    fieldOperands = false,
    collation,
  }: { fieldOperands?: boolean; collation?: TMongoFieldCollation } = {},
): Filter<any> {
  if (!filter || Object.keys(filter).length === 0) {
    return EMPTY;
  }
  const visitor = fieldOperands
    ? fieldOperandVisitor
    : collation
      ? collatedVisitor(collation)
      : mongoVisitor;
  return walkFilter(filter, visitor) ?? EMPTY;
}

// ── Per-field collation, rendered explicitly ────────────────────────────────

/**
 * A table's per-field collation (`@db.column.collate`), keyed by PHYSICAL
 * field path — `undefined` / `'binary'` compare byte-wise. See
 * {@link TMongoFilterOptions.collation}.
 *
 * @since 0.1.147
 */
export type TMongoFieldCollation = (field: string) => TDbCollation | undefined;

/** Options of {@link buildMongoQuery} / {@link mongoFilterStages}. @since 0.1.147 */
export interface TMongoFilterOptions {
  /**
   * The source table's per-field collation. A pipeline with relational
   * predicates runs WITHOUT an operation-wide `collation` (it would govern
   * every `$lookup` too — join keys and the related table's fields), so a
   * `'nocase'` field's comparisons are rendered explicitly instead: `$eq` /
   * `$ne` / `$in` / `$nin` on string values become anchored, escaped
   * case-insensitive regular expressions. Range operators on a string value
   * and every string comparison on a `'unicode'` field cannot be rendered
   * faithfully and throw `REL_FILTER_NOT_SUPPORTED`.
   *
   * Omitted: the source's own fields compare byte-wise. Predicate operands
   * always use the RELATED table's collation (read from its adapter).
   */
  collation?: TMongoFieldCollation;
}

/** Regex metacharacters (PCRE) escaped in an exact-match pattern. */
const REGEX_SPECIAL = /[\\^$.|?*+()[\]{}]/g;

/** A case-insensitive regex matching exactly `value` (`\z`: `$` would also match before a final newline). */
function exactNocase(value: string): BSONRegExp {
  const escaped = value.replace(REGEX_SPECIAL, "\\$&").replaceAll("\0", "\\x00");
  return new BSONRegExp(`^${escaped}\\z`, "i");
}

/** Operators whose result never depends on a string collation. */
const COLLATION_FREE_OPS = new Set(["$regex", "$exists", "$geoWithin"]);

const isStringOrHasString = (value: unknown): boolean =>
  typeof value === "string" || (Array.isArray(value) && value.some((v) => typeof v === "string"));

/**
 * A comparison on a field with a non-binary collation, rendered without a
 * query-level collation (`undefined`: the value is not collation-sensitive —
 * render it as usual).
 */
function collatedComparison(
  field: string,
  op: string,
  value: unknown,
  collation: TDbCollation,
): Filter<any> | undefined {
  if (COLLATION_FREE_OPS.has(op) || !isStringOrHasString(value)) {
    return undefined;
  }
  if (collation === "nocase") {
    if (op === "$eq") return { [field]: exactNocase(value as string) };
    if (op === "$ne") return { [field]: { $not: exactNocase(value as string) } };
    if ((op === "$in" || op === "$nin") && Array.isArray(value)) {
      return {
        [field]: { [op]: value.map((v) => (typeof v === "string" ? exactNocase(v) : v)) },
      };
    }
  }
  throw new DbError("REL_FILTER_NOT_SUPPORTED", [
    {
      path: field,
      message: `"${op}" on the ${collation} field "${field}" cannot be combined with relational predicates on MongoDB (a pipeline with $lookup stages cannot apply a per-field collation) — only $eq / $ne / $in / $nin / $regex / $exists on a 'nocase' field are supported there`,
    },
  ]);
}

/** {@link mongoVisitor} with `collation`-aware comparisons ({@link collatedComparison}). */
function collatedVisitor(collation: TMongoFieldCollation): FilterVisitor<Filter<any>> {
  return {
    ...mongoVisitor,
    comparison(field, op, value) {
      const collate = collation(field);
      const rendered =
        collate && collate !== "binary" ? collatedComparison(field, op, value, collate) : undefined;
      return rendered ?? mongoVisitor.comparison(field, op, value);
    },
  };
}

/**
 * The per-field collation of a table, read from its (Mongo) adapter's
 * `fieldCollation` — what a relational-predicate pipeline renders `'nocase'`
 * fields with ({@link TMongoFilterOptions.collation}).
 */
export function collationOfAdapter(adapter: unknown): TMongoFieldCollation | undefined {
  const source = adapter as { fieldCollation?: (field: string) => TDbCollation | undefined };
  return typeof source?.fieldCollation === "function"
    ? (field) => source.fieldCollation!(field)
    : undefined;
}

// ── Relational predicates ($some / $none) ─────────────────────────────────────

/**
 * Prefix of the temporary fields predicate lookups write (`<prefix><n>`) —
 * long and specific so it cannot plausibly collide with a stored field; the
 * fields are dropped with `$unset` before any row leaves the pipeline.
 *
 * @since 0.1.147
 */
export const REL_FILTER_TEMP_PREFIX = "__atscript_rf_";

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
  /** One `$lookup` per relational predicate, each writing a temporary array field (at most one element). */
  lookups: Document[];
  /** The rest of the filter, predicates read as `{ <temp>: { $ne: [] } }` (`$some`) / `{ <temp>: { $size: 0 } }` (`$none`). */
  match: Filter<any>;
  /** The temporary fields the lookups add ({@link REL_FILTER_TEMP_PREFIX}`<n>`, dropped with `$unset`). */
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
    (containsRelationFilter(part) ? post : pre).push(part);
  }
}

function isEmptyFilter(filter: Filter<any> | undefined): boolean {
  return !filter || Object.keys(filter).length === 0;
}

function malformed(field: string, message: string): DbError {
  return new DbError("REL_FILTER_NOT_SUPPORTED", [{ path: field, message }]);
}

/** A per-query renderer: one temp-field / variable counter shared by every nesting level. */
function createPredicateRenderer() {
  let seq = 0;

  /** `collation`: the per-field collation of the table `filter` reads. */
  const level = (
    filter: FilterExpr | undefined,
    collation: TMongoFieldCollation | undefined,
  ): TMongoFilterPlan => {
    const preParts: FilterExpr[] = [];
    const postParts: FilterExpr[] = [];
    if (filter) splitConjuncts(filter, preParts, postParts);
    const lookups: Document[] = [];
    const temp: string[] = [];
    const base = collation ? collatedVisitor(collation) : mongoVisitor;
    const visitor: FilterVisitor<Filter<any>> = {
      ...base,
      relation(field, op, operand) {
        if (!isResolvedRelationFilter(operand)) {
          throw malformed(
            field,
            `Relational predicate "${op}" on "${field}" was not resolved by the table — query through the table API`,
          );
        }
        const n = seq++;
        const as = `${REL_FILTER_TEMP_PREFIX}${n}`;
        lookups.push(lookupOf(operand, field, as, `rf${n}`));
        temp.push(as);
        return op === "$some" ? { [as]: { $ne: [] } } : { [as]: { $size: 0 } };
      },
    };
    const pre =
      preParts.length > 0 ? buildMongoFilter(andFilters(...preParts), { collation }) : undefined;
    const match =
      postParts.length > 0 ? (walkFilter(andFilters(...postParts), visitor) ?? EMPTY) : EMPTY;
    return { pre: isEmptyFilter(pre) ? undefined : pre, lookups, match, temp };
  };

  /**
   * Stages narrowing a lookup's documents to `filter` (nested predicates
   * included), compared with the looked-up table's own collation. No
   * `$unset`: the lookup projects `_id` only.
   */
  const filterStages = (filter: FilterExpr | undefined, adapter: unknown): Document[] =>
    stagesOf(level(filter, collationOfAdapter(adapter)), false);

  const lookupOf = (
    node: ResolvedRelationFilter,
    field: string,
    as: string,
    vars: string,
  ): Document => {
    const exists = [{ $limit: 1 }, { $project: { _id: 1 } }];
    if (node.kind === "via") {
      return viaLookupOf(node, field, as, vars, exists);
    }
    if (node.pairs.length === 0) {
      // An empty correlation would relate every target document.
      throw malformed(field, `Relational predicate on "${field}" has no join key pairs`);
    }
    const join = correlate(
      vars,
      node.pairs.map((p) => ({ outer: p.source, inner: p.target })),
    );
    return {
      $lookup: {
        from: node.target.name,
        let: join.let,
        pipeline: [...join.stages, ...filterStages(node.filter, node.target.adapter), ...exists],
        as,
      },
    };
  };

  // via: ∃ junction row J (correlated with the source, junction part of
  // @db.rel.filter) with ∃ target row T (correlated with J, inner filter).
  // oxlint-disable-next-line max-params -- internal helper of lookupOf
  const viaLookupOf = (
    node: ResolvedRelationFilter,
    field: string,
    as: string,
    vars: string,
    exists: Document[],
  ): Document => {
    const junction = node.junction;
    if (!junction || junction.toSource.length === 0 || junction.toTarget.length === 0) {
      throw malformed(
        field,
        `Relational predicate on the via relation "${field}" has no junction correlation`,
      );
    }
    const n = seq++;
    const targetAs = `${REL_FILTER_TEMP_PREFIX}${n}`;
    const toSource = correlate(
      vars,
      junction.toSource.map((p) => ({ outer: p.source, inner: p.junction })),
    );
    const toTarget = correlate(
      `rf${n}`,
      junction.toTarget.map((p) => ({ outer: p.junction, inner: p.target })),
    );
    return {
      $lookup: {
        from: junction.name,
        let: toSource.let,
        pipeline: [
          ...toSource.stages,
          ...filterStages(junction.filter, junction.adapter),
          {
            $lookup: {
              from: node.target.name,
              let: toTarget.let,
              pipeline: [
                ...toTarget.stages,
                ...filterStages(node.filter, node.target.adapter),
                ...exists,
              ],
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
 * collection (`let` = the source key fields; a bare `$expr` `$eq` per key
 * part — index-friendly — then a `{ <key>: { $ne: null } }` guard; the
 * inner filter — nested predicates as lookups inside it — then
 * `$limit: 1`); `via` looks up the junction, and inside it the target. The
 * predicate itself reads the lookup's temporary array field
 * ({@link REL_FILTER_TEMP_PREFIX}`<n>`). Top-level conjuncts without
 * predicates go to `pre` so the lookups run only for documents that survive
 * them.
 *
 * Run the pipeline WITHOUT an operation-wide `collation`: it would apply to
 * the join keys and the related tables' fields too. Each related table's
 * `'nocase'` fields are compared case-insensitively explicitly (see
 * {@link TMongoFilterOptions.collation}, which does the same for the source).
 *
 * A predicate-free filter yields `{ pre, lookups: [], match: {}, temp: [] }`.
 *
 * @since 0.1.147
 */
export function buildMongoQuery(
  filter: FilterExpr | undefined,
  options: TMongoFilterOptions = {},
): TMongoFilterPlan {
  return createPredicateRenderer()(filter, options.collation);
}

/**
 * The pipeline stages that apply `filter`: `[{ $match }]` for a
 * predicate-free filter (exactly what the reads always emitted — `options`
 * is ignored then), else `$match(pre)` → predicate `$lookup`s → `$match` →
 * `$unset` of the temporary fields ({@link buildMongoQuery}).
 *
 * @since 0.1.147
 */
export function mongoFilterStages(
  filter: FilterExpr | undefined,
  options: TMongoFilterOptions = {},
): Document[] {
  if (!containsRelationFilter(filter)) {
    return [{ $match: buildMongoFilter(filter as FilterExpr) }];
  }
  return planStages(buildMongoQuery(filter, options));
}

/**
 * The stages of a {@link TMongoFilterPlan}, in order: `$match(pre)`, the
 * lookups, `$match(match)`, `$unset` of the temporary fields.
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
