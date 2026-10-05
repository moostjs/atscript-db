/**
 * MongoDB aggregation pipeline builder.
 * Dynamically imported by MongoAdapter.aggregate() on first call.
 *
 * Constructs MongoDB aggregation pipelines from translated DbQuery objects
 * containing $groupBy, $select (with AggregateExpr), $having, $sort, etc.
 */

import { evaluateExpr, type DbQuery, type TResolvedBucket } from "@atscript/db";
import { type AggregateExpr, type BucketUnit, resolveAlias } from "@atscript/db/agg";
import { BUCKET_MAX_INSTANT, BUCKET_MIN_INSTANT } from "@uniqu/core";
import type { Document } from "mongodb";
import { buildAccumulator, distinctCountExpr } from "./lib/mongo-accumulator";
import { buildMongoFilter, mongoFilterStages, type TMongoFilterOptions } from "./lib/mongo-filter";
import { exprToMongo, notNullExpr, orNull } from "./lib/mongo-view-expr";

/** Maps an AggregateExpr to its MongoDB `$group` accumulator (see `buildAccumulator`). */
function toAccumulator(expr: AggregateExpr): Document {
  return buildAccumulator(expr.$fn, expr.$field === "*" ? "*" : `$${expr.$field}`);
}

/** An operand of query-time arithmetic: the field as a double (IEEE, like the SQL adapters). */
const asDouble = (path: string): Document => ({ $toDouble: `$${path}` });

/** Prefix of the hidden `$group` field counting a sum's non-null values. */
const NON_NULL_PREFIX = "__as_n_";

// ── Calendar buckets ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const ISO_DATE = "%Y-%m-%d";

/** Units `$dateToString` labels straight from the instant in the zone (literal `01` for day / month). */
const LOCAL_LABEL_FORMATS: Partial<Record<BucketUnit, string>> = {
  hour: "%Y-%m-%dT%H:00",
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
 * `YYYY-MM-DD` of the bucket's first day in `b.tz` (for `hour`, the local
 * `YYYY-MM-DDTHH:00`), or `null`.
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
  const format = LOCAL_LABEL_FORMATS[b.unit];
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
  filterOptions: TMongoFilterOptions | undefined,
): {
  pipeline: Document[];
  groupId: Document;
  groupKeys: Array<[path: string, idKey: string]>;
  controls: DbQuery["controls"];
} {
  const controls = query.controls || {};
  const groupBy = (controls.$groupBy ?? []) as string[];
  // Relational predicates (since 0.1.147) add their `$lookup`s here, before `$group`.
  const filterStages = mongoFilterStages(query.filter, filterOptions);
  const pipeline: Document[] = searchStage ? [searchStage, ...filterStages] : filterStages;

  const groupId: Document = {};
  const groupKeys: Array<[string, string]> = [];
  for (const [index, key] of groupBy.entries()) {
    const idKey = `k${index}`;
    const bucket = controls.$select?.bucketByAlias(key);
    groupId[idKey] = bucket ? bucketExpression(bucket) : orNull(`$${key}`);
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
  {
    accumulators,
    searchStage,
    filterOptions,
  }: { accumulators: boolean; searchStage?: Document; filterOptions?: TMongoFilterOptions },
): {
  pipeline: Document[];
  controls: DbQuery["controls"];
} {
  const { pipeline, groupId, groupKeys, controls } = buildPrefix(query, searchStage, filterOptions);

  const groupStage: Document = { _id: groupId };
  if (!accumulators) {
    pipeline.push({ $group: groupStage });
    return { pipeline, controls };
  }

  // `first` / `last`: order the rows BEFORE grouping (the portable `$sort` +
  // `$first` / `$last`, MongoDB 3.6+); BSON order puts null / missing first,
  // like the SQL adapters. The key list ends with the primary key.
  const firstLast = controls.$select?.firstLast ?? [];
  const rowOrder = controls.$select?.rowOrder ?? [];
  if (firstLast.length > 0 && rowOrder.length > 0) {
    pipeline.push({ $sort: Object.fromEntries(rowOrder.map((k) => [k.column, k.desc ? -1 : 1])) });
  }

  // Build $group accumulators and $project in a single pass over groupBy + aggregates
  const project: Document = { _id: 0 };
  for (const [field, idKey] of groupKeys) {
    project[field] = `$_id.${idKey}`;
  }
  // `$sum` of no (non-null) value is 0 in MongoDB, NULL in SQL and the memory
  // adapter: count the values next to the sum and project null over none.
  const nullWhenEmpty = (alias: string, nonNull: Document): Document => {
    const count = `${NON_NULL_PREFIX}${alias}`;
    groupStage[count] = { $sum: { $cond: [nonNull, 1, 0] } };
    return { $cond: [{ $eq: [`$${count}`, 0] }, null, `$${alias}`] };
  };
  for (const expr of controls.$select?.aggregates ?? []) {
    const alias = resolveAlias(expr);
    groupStage[alias] = toAccumulator(expr);
    // countDistinct accumulates a set — `$project` turns it into its size, so
    // `$having` and `$sort` (which run after it) compare a number.
    project[alias] =
      expr.$fn === "countDistinct"
        ? distinctCountExpr(`$${alias}`)
        : expr.$fn === "sum"
          ? nullWhenEmpty(alias, notNullExpr(`$${expr.$field}`))
          : 1;
  }
  for (const e of controls.$select?.exprAggregates ?? []) {
    // sum / avg / min / max over a per-row expression: IEEE double, NULL / ÷0 → null
    const value = exprToMongo(e.expr, asDouble);
    groupStage[e.alias] = { [`$${e.fn}`]: value };
    project[e.alias] = e.fn === "sum" ? nullWhenEmpty(e.alias, notNullExpr(value)) : 1;
  }
  for (const fl of firstLast) {
    groupStage[fl.alias] = { [`$${fl.fn}`]: orNull(`$${fl.column}`) };
    project[fl.alias] = 1;
  }
  pipeline.push({ $group: groupStage });
  pipeline.push({ $project: project });

  // Group-level expressions, in dependency order: leaves are the projected
  // aliases or group keys, as doubles.
  // One `$addFields` per expression: a later one reads the field an earlier one wrote.
  for (const e of controls.$select?.exprs ?? []) {
    pipeline.push({ $addFields: { [e.alias]: exprToMongo(e.expr, asDouble) } });
  }

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
 * relevance `$sort` and no default `$limit`. `filterOptions` renders a
 * filter with relational predicates (`mongoFilterStages`).
 */
export function buildAggregatePipeline(
  query: DbQuery,
  searchStage?: Document,
  filterOptions?: TMongoFilterOptions,
): Document[] {
  const { pipeline, controls } = buildGroupedStages(query, {
    accumulators: true,
    searchStage,
    filterOptions,
  });

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
 * The row an UNGROUPED aggregate yields over no input rows: a pipeline's
 * `$group` emits nothing there, while SQL (and the memory adapter) always
 * yield the one group — counts 0, every other aggregate, `first` / `last` and
 * the expressions over them `null`. `undefined` when the query is grouped,
 * has a `$having` (not evaluable here) or `$skip`, or computes nothing.
 */
export function emptyGroupRow(query: DbQuery): Document | undefined {
  const controls = query.controls;
  const select = controls?.$select;
  if (!controls || (controls.$groupBy as string[] | undefined)?.length) return undefined;
  if (controls.$having || controls.$skip) return undefined;
  if (!select?.computedAliases.length) return undefined;
  const row: Document = {};
  for (const expr of select.aggregates ?? []) {
    row[resolveAlias(expr)] = expr.$fn === "count" || expr.$fn === "countDistinct" ? 0 : null;
  }
  for (const e of select.exprAggregates ?? []) row[e.alias] = null;
  for (const fl of select.firstLast ?? []) row[fl.alias] = null;
  for (const e of select.exprs ?? []) {
    row[e.alias] = evaluateExpr(e.expr, (name) => row[name]);
  }
  return row;
}

/**
 * `allowDiskUse` for a pipeline that sorts before it groups (`first` / `last`
 * order every matching row by `$rowOrder` first, which may exceed the
 * in-memory sort limit); `undefined` otherwise.
 */
export function aggregateOptions(pipeline: Document[]): { allowDiskUse: true } | undefined {
  const group = pipeline.findIndex((stage) => "$group" in stage);
  return pipeline.slice(0, group < 0 ? 0 : group).some((stage) => "$sort" in stage)
    ? { allowDiskUse: true }
    : undefined;
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
export function buildCountPipeline(
  query: DbQuery,
  searchStage?: Document,
  filterOptions?: TMongoFilterOptions,
): Document[] {
  const { pipeline } = buildGroupedStages(query, {
    accumulators: Boolean(query.controls?.$having),
    searchStage,
    filterOptions,
  });
  pipeline.push({ $count: "count" });
  return pipeline;
}
