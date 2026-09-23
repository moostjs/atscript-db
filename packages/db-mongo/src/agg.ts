/**
 * MongoDB aggregation pipeline builder.
 * Dynamically imported by MongoAdapter.aggregate() on first call.
 *
 * Constructs MongoDB aggregation pipelines from translated DbQuery objects
 * containing $groupBy, $select (with AggregateExpr), $having, $sort, etc.
 */

import type { DbQuery, TResolvedBucket } from "@atscript/db";
import { type AggregateExpr, type BucketUnit, resolveAlias } from "@atscript/db/agg";
import { BUCKET_MAX_INSTANT, BUCKET_MIN_INSTANT } from "@uniqu/core";
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

// ── Calendar buckets ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const ISO_DATE = "%Y-%m-%d";

/**
 * Units whose first day `$dateToString` renders straight from the instant in
 * the zone: the local day, then the literal `01` for day-of-month / month.
 */
const LOCAL_DATE_FORMATS: Partial<Record<BucketUnit, string>> = {
  day: ISO_DATE,
  month: "%Y-%m-01",
  year: "%Y-01-01",
};

/**
 * The first day of a quarter / week bucket as a NAIVE date (UTC midnight of
 * the local calendar date), from the local parts `$$p` (`$dateToParts` in
 * the zone). Pure calendar arithmetic: nothing converts local time back to an
 * instant, so a zone whose DST switch skips midnight cannot shift a label.
 */
function naiveFirstDay(b: TResolvedBucket): Document {
  if (b.unit === "quarter") {
    // month − ((month − 1) mod 3): 1..3 → 1, 4..6 → 4, …
    const month = { $subtract: ["$$p.month", { $mod: [{ $subtract: ["$$p.month", 1] }, 3] }] };
    return { $dateFromParts: { year: "$$p.year", month, day: 1 } };
  }
  // week: local day − ((isoDow − weekStartIso + 7) mod 7) days. The naive
  // date's UTC weekday IS the local weekday.
  const back = {
    $mod: [{ $add: [{ $subtract: [{ $isoDayOfWeek: "$$n" }, b.weekStartIso] }, 7] }, 7],
  };
  return {
    $let: {
      vars: { n: { $dateFromParts: { year: "$$p.year", month: "$$p.month", day: "$$p.day" } } },
      in: { $subtract: ["$$n", { $multiply: [back, DAY_MS] }] },
    },
  };
}

/**
 * The `$group._id` expression of a calendar bucket: the ISO local date
 * `YYYY-MM-DD` of the bucket's first day in `b.tz`, or `null`.
 *
 * The only zone-aware step is instant → local date (`timezone` on
 * `$dateToString` / `$dateToParts`, never ambiguous). `$dateTrunc` is
 * deliberately not used — it returns the bucket start as an INSTANT, which
 * reintroduces the midnight-gap ambiguity.
 *
 * The source is an epoch-ms number of any BSON numeric type. The `$cond`
 * range guard `[BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)` labels an
 * out-of-range source `null`, like every other adapter, and also folds null,
 * missing and non-numeric sources (BSON orders null/missing below numbers and
 * strings/objects above them) into ONE null group — a bare field path would
 * group a missing source under `_id: {}`, apart from `_id: { k: null }`.
 */
export function bucketExpression(b: TResolvedBucket): Document {
  const source = `$${b.field}`;
  // `$toDate` rejects a 32-bit int — how drivers store an epoch-ms before
  // 1970-01-25 — so the (guarded, hence numeric) source goes through `$toLong`.
  const date = { $toDate: { $toLong: source } };
  const format = LOCAL_DATE_FORMATS[b.unit];
  const label: Document = format
    ? { $dateToString: { date, format, timezone: b.tz } }
    : {
        $let: {
          vars: { p: { $dateToParts: { date, timezone: b.tz } } },
          in: { $dateToString: { date: naiveFirstDay(b), format: ISO_DATE } },
        },
      };
  return {
    $cond: [
      { $and: [{ $gte: [source, BUCKET_MIN_INSTANT] }, { $lt: [source, BUCKET_MAX_INSTANT] }] },
      label,
      null,
    ],
  };
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Builds the common prefix stages: [search] + $match + $group._id from groupBy
 * fields. Shared by both full aggregate and count pipelines.
 * `groupKeys` maps each `$groupBy` key (a field path or a calendar-bucket
 * alias) to its `_id` sub-key.
 *
 * Every key is stored positionally inside `_id` (`k0`, `k1`, …) — internal
 * names that never collide — and projected back under its own name:
 * `$group` output names may not contain `.`, while `$project` accepts dotted
 * output keys and nests them, which is the row shape a dotted `$select`
 * yields on find (`{ metadata: { clicks } }`).
 *
 * A field key is grouped as `{ $ifNull: ['$f', null] }` so a missing and a
 * null value form ONE null group (SQL semantics) that projects back as
 * `f: null` — a bare `'$f'` would split them into `_id: {}` and
 * `_id: { f: null }`. A bucket alias is grouped by {@link bucketExpression}.
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
  for (const [index, key] of groupBy.entries()) {
    const idKey = `k${index}`;
    const bucket = controls.$select?.bucketByAlias(key);
    groupId[idKey] = bucket ? bucketExpression(bucket) : { $ifNull: [`$${key}`, null] };
    groupKeys.push([key, idKey]);
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
