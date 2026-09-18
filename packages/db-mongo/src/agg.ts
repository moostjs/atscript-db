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
 * Builds the common prefix stages: $match + $group._id from groupBy fields.
 * Shared by both full aggregate and count pipelines.
 * `groupKeys` maps each `$groupBy` path to its `_id` sub-key.
 */
function buildPrefix(query: DbQuery): {
  pipeline: Document[];
  groupId: Document;
  groupKeys: Array<[path: string, idKey: string]>;
  controls: DbQuery["controls"];
} {
  const controls = query.controls || {};
  const groupBy = (controls.$groupBy ?? []) as string[];
  const pipeline: Document[] = [{ $match: buildMongoFilter(query.filter) }];

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
 * Builds a full MongoDB aggregation pipeline for GROUP BY queries.
 *
 * Pipeline: $match → $group → $project → $match(having) → $sort → $skip → $limit
 */
export function buildAggregatePipeline(query: DbQuery): Document[] {
  const { pipeline, groupId, groupKeys, controls } = buildPrefix(query);

  // $group: dimensions + accumulators
  const groupStage: Document = { _id: groupId };
  const project: Document = { _id: 0 };
  const aggregates = controls.$select?.aggregates;

  // Build $group accumulators and $project in a single pass over groupBy + aggregates
  for (const [field, idKey] of groupKeys) {
    project[field] = `$_id.${idKey}`;
  }
  if (aggregates) {
    for (const expr of aggregates) {
      const alias = resolveAlias(expr);
      groupStage[alias] = toAccumulator(expr);
      project[alias] = 1;
    }
  }
  pipeline.push({ $group: groupStage });
  pipeline.push({ $project: project });

  // $having (post-aggregation filter, aliases are top-level after $project)
  if (controls.$having) {
    pipeline.push({ $match: buildMongoFilter(controls.$having) });
  }

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
 * Builds a count-only pipeline: returns the number of distinct groups.
 *
 * Pipeline: $match → $group (just _id) → $project → $match(having) → $count
 */
export function buildCountPipeline(query: DbQuery): Document[] {
  const { pipeline, groupId, groupKeys, controls } = buildPrefix(query);

  pipeline.push({ $group: { _id: groupId } });

  // Apply $having before counting — count groups that pass the HAVING filter
  if (controls.$having) {
    // Need $project to flatten _id so $having aliases resolve
    const project: Document = { _id: 0 };
    for (const [field, idKey] of groupKeys) {
      project[field] = `$_id.${idKey}`;
    }
    pipeline.push({ $project: project });
    pipeline.push({ $match: buildMongoFilter(controls.$having) });
  }

  pipeline.push({ $count: "count" });

  return pipeline;
}
