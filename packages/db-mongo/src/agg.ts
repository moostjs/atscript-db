/**
 * MongoDB aggregation pipeline builder.
 * Dynamically imported by MongoAdapter.aggregate() on first call.
 *
 * Constructs MongoDB aggregation pipelines from translated DbQuery objects
 * containing $groupBy, $select (with AggregateExpr), $having, $sort, etc.
 */

import type { DbQuery } from "@atscript/db";
import { type AggregateExpr, resolveAlias } from "@atscript/db/agg";
import type { Document } from "mongodb";
import { buildMongoFilter } from "./lib/mongo-filter";

/** Simple accumulators that map directly to `{ $<fn>: '$field' }`. */
const SIMPLE_ACCUMULATORS: Record<string, string> = {
  sum: "$sum",
  avg: "$avg",
  min: "$min",
  max: "$max",
};

/**
 * Maps an AggregateExpr to a MongoDB $group accumulator expression.
 */
function toAccumulator(expr: AggregateExpr): Document {
  const simple = SIMPLE_ACCUMULATORS[expr.$fn];
  if (simple) {
    return { [simple]: `$${expr.$field}` };
  }
  if (expr.$fn === "count") {
    if (expr.$field === "*") {
      return { $sum: 1 };
    }
    // COUNT(field) — count non-null values
    return { $sum: { $cond: [{ $ne: [`$${expr.$field}`, null] }, 1, 0] } };
  }
  throw new Error(`Unsupported aggregate function: ${expr.$fn}`);
}

/**
 * `$group` output field names (including `_id` sub-keys) may not contain `.`,
 * so a dotted `$groupBy` path (a JSON/nested descendant such as
 * `metadata.clicks`) is keyed positionally inside `_id` (`k0`, `k1`, …) and
 * projected back under its dotted path — `$project` accepts dotted output
 * keys and nests them, which is the row shape a dotted `$select` yields on
 * find (`{ metadata: { clicks } }`). Plain paths keep their own name.
 */
function groupIdKey(field: string, index: number): string {
  return field.includes(".") ? `k${index}` : field;
}

/**
 * Builds the common prefix stages: [search] + $match + $group._id from groupBy
 * fields. Shared by both full aggregate and count pipelines.
 * `groupKeys` maps each `$groupBy` path to its `_id` sub-key.
 *
 * `searchStage` is the resolved text-search stage (classic `$text` `$match`, or
 * an Atlas `$search`). Both MUST be the pipeline's FIRST stage, hence its
 * position in front of the filter `$match`. Resolving it needs adapter state,
 * so the caller passes it in and this module stays a pure translation.
 */
function buildPrefix(
  query: DbQuery,
  searchStage: Document | undefined,
): {
  pipeline: Document[];
  groupId: Document;
  groupKeys: Array<[path: string, idKey: string]>;
  controls: DbQuery["controls"];
} {
  const controls = query.controls || {};
  const groupBy = (controls.$groupBy ?? []) as string[];
  const pipeline: Document[] = searchStage
    ? [searchStage, { $match: buildMongoFilter(query.filter) }]
    : [{ $match: buildMongoFilter(query.filter) }];

  const groupId: Document = {};
  const groupKeys: Array<[string, string]> = [];
  for (const [index, field] of groupBy.entries()) {
    const idKey = groupIdKey(field, index);
    groupId[idKey] = `$${field}`;
    groupKeys.push([field, idKey]);
  }

  return { pipeline, groupId, groupKeys, controls };
}

/**
 * The stages every grouped query shares: `[search →] $match(filter)` →
 * `$group` (dimensions + accumulators) → `$project` (flatten `_id`, keep
 * aliases) → `$match($having)`. The row pipeline appends sort/skip/limit, the
 * count pipeline appends `$count`, so both see exactly the same group set —
 * including the same `$search` narrowing, which is why the stage is threaded
 * through this single seam instead of being appended by each caller.
 *
 * With `accumulators: false` only the `$group._id` dimensions are emitted
 * (no accumulators, no `$project`, no `$having`) — the cheapest shape for a
 * plain group count, where no alias has to be resolvable.
 */
function buildGroupedStages(
  query: DbQuery,
  { accumulators, searchStage }: { accumulators: boolean; searchStage?: Document },
): {
  pipeline: Document[];
  controls: DbQuery["controls"];
} {
  const { pipeline, groupId, groupKeys, controls } = buildPrefix(query, searchStage);

  const groupStage: Document = { _id: groupId };
  if (!accumulators) {
    pipeline.push({ $group: groupStage });
    return { pipeline, controls };
  }

  // Build $group accumulators and $project in a single pass over groupBy + aggregates
  const project: Document = { _id: 0 };
  for (const [field, idKey] of groupKeys) {
    project[field] = `$_id.${idKey}`;
  }
  for (const expr of controls.$select?.aggregates ?? []) {
    const alias = resolveAlias(expr);
    groupStage[alias] = toAccumulator(expr);
    project[alias] = 1;
  }
  pipeline.push({ $group: groupStage });
  pipeline.push({ $project: project });

  // $having (post-aggregation filter, aliases are top-level after $project)
  if (controls.$having) {
    pipeline.push({ $match: buildMongoFilter(controls.$having) });
  }

  return { pipeline, controls };
}

/**
 * Builds a full MongoDB aggregation pipeline for GROUP BY queries.
 *
 * Pipeline: [search →] $match → $group → $project → $match(having) → $sort →
 * $skip → $limit
 *
 * `searchStage` is the resolved `$search` / `$text` stage (see
 * `buildAggregateSearchStage`); unlike the leaf runner this path adds no
 * relevance `$sort` and no default `$limit`.
 */
export function buildAggregatePipeline(query: DbQuery, searchStage?: Document): Document[] {
  const { pipeline, controls } = buildGroupedStages(query, { accumulators: true, searchStage });

  if (controls.$sort) {
    pipeline.push({ $sort: controls.$sort });
  }
  if (controls.$skip) {
    pipeline.push({ $skip: controls.$skip });
  }
  if (controls.$limit) {
    pipeline.push({ $limit: controls.$limit });
  }

  return pipeline;
}

/**
 * Builds a count-only pipeline: the number of groups that survive `$having`
 * (all groups when there is none). With `$having` it runs the same grouped
 * stages as the row pipeline — the accumulators must run so an alias
 * `$having` has a value to match; without it only the `$group._id`
 * dimensions are needed.
 *
 * Pipeline: [search →] $match → $group → [$project → $match(having)] → $count
 *
 * `searchStage` must be the SAME stage handed to `buildAggregatePipeline` for
 * the same query — the counted groups are exactly the rows the search matched.
 */
export function buildCountPipeline(query: DbQuery, searchStage?: Document): Document[] {
  const { pipeline } = buildGroupedStages(query, {
    accumulators: Boolean(query.controls?.$having),
    searchStage,
  });
  pipeline.push({ $count: "count" });
  return pipeline;
}
