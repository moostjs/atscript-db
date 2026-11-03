/**
 * MongoDB aggregation pipeline builder.
 * Dynamically imported by MongoAdapter.aggregate() on first call.
 *
 * Constructs MongoDB aggregation pipelines from translated DbQuery objects
 * containing $groupBy, $select (with AggregateExpr), $having, $sort, etc.
 */

import {
  DbError,
  aggregateColumns,
  evaluateExpr,
  type DbControls,
  type DbQuery,
  type FilterExpr,
  type TResolvedBucket,
} from "@atscript/db";
import {
  type AggregateExpr,
  type BucketUnit,
  assertAggregateFn,
  resolveAlias,
} from "@atscript/db/agg";
import { BUCKET_MAX_INSTANT, BUCKET_MIN_INSTANT } from "@uniqu/core";
import type { Document } from "mongodb";
import { buildAccumulator, distinctCountExpr } from "./lib/mongo-accumulator";
import { buildMongoFilter, mongoFilterStages, type TMongoFilterOptions } from "./lib/mongo-filter";
import { rowOrderStages, sortStages } from "./lib/mongo-sort";
import { exprToMongo, orNull, whereToExpr } from "./lib/mongo-view-expr";

/** The condition of a conditional aggregate as an aggregation expression, or `undefined`. */
function conditionOf(where: unknown): Document | undefined {
  return where === undefined ? undefined : whereToExpr(where as FilterExpr);
}

/**
 * Maps an AggregateExpr to its MongoDB `$group` accumulator (see
 * `buildAccumulator`), restricted to the rows `where` matches. A field list
 * (since 0.1.168) is `countDistinct`'s only.
 */
function toAccumulator(expr: AggregateExpr, where: Document | undefined): Document {
  if (typeof expr.$field === "string") {
    return buildAccumulator(expr.$fn, expr.$field === "*" ? "*" : `$${expr.$field}`, where);
  }
  assertAggregateFn(expr.$fn);
  if (expr.$fn !== "countDistinct") {
    throw new DbError("INVALID_QUERY", [
      {
        path: "$select",
        message: `${expr.$fn}() takes one field — only countDistinct takes a list`,
      },
    ]);
  }
  const fields = aggregateColumns(expr).map((field) => `$${field}`);
  return buildAccumulator(expr.$fn, fields, where);
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
 * The stages yielding the rows a grouped level aggregates: `[search →]
 * $match(filter)` — or, for a two-level aggregate (`controls.$from`, since
 * 0.1.168), those followed by the INNER level's grouped stages, whose
 * projected documents (every inner column: `$groupBy` keys at their paths,
 * computed aliases at the top) are the outer level's rows.
 *
 * `searchStage` is the resolved text-search stage (classic `$text` `$match`, or
 * an Atlas `$search`). Both MUST be the pipeline's FIRST stage, hence its
 * position in front of the filter `$match`. Resolving it needs adapter state,
 * so the caller passes it in and this module stays a pure translation.
 */
function sourceStages(
  query: DbQuery,
  searchStage: Document | undefined,
  filterOptions: TMongoFilterOptions | undefined,
): Document[] {
  // Relational predicates (since 0.1.147) add their `$lookup`s here, before `$group`.
  const filterStages = mongoFilterStages(query.filter, filterOptions);
  const rows = searchStage ? [searchStage, ...filterStages] : filterStages;
  const inner = query.controls?.$from;
  return inner ? buildGroupedStages(inner, rows, true) : rows;
}

/**
 * The `$group._id` of a level from its `$groupBy`. `groupKeys` maps each
 * `$groupBy` key (a field path or a calendar-bucket alias) to its `_id`
 * sub-key.
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
 */
function groupIdOf(controls: DbControls): {
  groupId: Document;
  groupKeys: Array<[path: string, idKey: string]>;
} {
  const groupBy = (controls.$groupBy ?? []) as string[];
  const groupId: Document = {};
  const groupKeys: Array<[string, string]> = [];
  for (const [index, key] of groupBy.entries()) {
    const idKey = `k${index}`;
    const bucket = controls.$select?.bucketByAlias(key);
    groupId[idKey] = bucket ? bucketExpression(bucket) : orNull(`$${key}`);
    groupKeys.push([key, idKey]);
  }
  return { groupId, groupKeys };
}

/**
 * The stages of one grouped level, appended to `pipeline` — a fresh array of
 * its source rows' stages ({@link sourceStages}), returned:
 * `$group` (dimensions + accumulators) → `$project` (flatten `_id`, keep
 * aliases) → `$match($having)`. The row pipeline appends sort/skip/limit, the
 * count pipeline appends `$count`, so both see exactly the same group set —
 * including the same `$search` narrowing, which is why the stage is threaded
 * through this single seam instead of being appended by each caller. The
 * inner level of a two-level aggregate is built here too.
 *
 * With `accumulators: false` only the `$group._id` dimensions are emitted
 * (no accumulators, no `$project`, no `$having`) — the cheapest shape for a
 * plain group count, where no alias has to be resolvable.
 */
function buildGroupedStages(
  controls: DbControls,
  pipeline: Document[],
  accumulators: boolean,
): Document[] {
  const { groupId, groupKeys } = groupIdOf(controls);

  const groupStage: Document = { _id: groupId };
  if (!accumulators) {
    pipeline.push({ $group: groupStage });
    return pipeline;
  }

  // `first` / `last`: order the rows BEFORE grouping (the portable `$sort` +
  // `$first` / `$last`, MongoDB 3.6+); BSON order puts null / missing first,
  // like the SQL adapters, unless a key places NULL (`nulls`, since 0.1.153 —
  // `$last` reads the same forward order). The key list ends with the primary key.
  const firstLast = controls.$select?.firstLast ?? [];
  const rowOrder = controls.$select?.rowOrder ?? [];
  if (firstLast.length > 0 && rowOrder.length > 0) {
    pipeline.push(...rowOrderStages(rowOrder));
  }

  // Build $group accumulators and $project in a single pass over groupBy + aggregates
  const project: Document = { _id: 0 };
  for (const [field, idKey] of groupKeys) {
    project[field] = `$_id.${idKey}`;
  }
  // `$sum` of no (non-null) value is 0 in MongoDB, NULL in SQL and the memory
  // adapter: count the values next to the sum and project null over none. A
  // conditional sum counts only the values of the rows its condition matches.
  const nullWhenEmpty = (alias: string, value: unknown, where: Document | undefined): Document => {
    const count = `${NON_NULL_PREFIX}${alias}`;
    groupStage[count] = buildAccumulator("count", value, where);
    return { $cond: [{ $eq: [`$${count}`, 0] }, null, `$${alias}`] };
  };
  for (const expr of controls.$select?.aggregates ?? []) {
    const alias = resolveAlias(expr);
    const where = conditionOf(expr.$where);
    groupStage[alias] = toAccumulator(expr, where);
    // countDistinct accumulates a set — `$project` turns it into its size, so
    // `$having` and `$sort` (which run after it) compare a number.
    project[alias] =
      expr.$fn === "countDistinct"
        ? distinctCountExpr(`$${alias}`)
        : expr.$fn === "sum"
          ? nullWhenEmpty(alias, `$${expr.$field as string}`, where)
          : 1;
  }
  for (const e of controls.$select?.exprAggregates ?? []) {
    // sum / avg / min / max over a per-row expression: IEEE double, NULL / ÷0 → null
    const value = exprToMongo(e.expr, asDouble);
    const where = conditionOf(e.where);
    groupStage[e.alias] = buildAccumulator(e.fn, value, where);
    project[e.alias] = e.fn === "sum" ? nullWhenEmpty(e.alias, value, where) : 1;
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

  return pipeline;
}

/**
 * Builds a full MongoDB aggregation pipeline for GROUP BY queries.
 *
 * Pipeline: [search →] $match → $group → $project → $match(having) → $sort →
 * $skip → $limit. A two-level aggregate (`controls.$from`, since 0.1.168)
 * runs the inner level's `$group` → `$project` → `$match(having)` first; the
 * outer stages group its documents (no filter, no search of their own).
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
  const controls = query.controls ?? {};
  const pipeline = buildGroupedStages(
    controls,
    sourceStages(query, searchStage, filterOptions),
    true,
  );

  // Group keys / aliases are top-level after `$project`; `$nulls` places NULL among them.
  const { stages, cleanup } = sortStages(controls);
  pipeline.push(...stages);
  if (controls.$skip) {
    pipeline.push({ $skip: controls.$skip });
  }
  if (controls.$limit) {
    pipeline.push({ $limit: controls.$limit });
  }
  if (cleanup) pipeline.push(cleanup);

  return pipeline;
}

/**
 * The row an UNGROUPED aggregate yields over no input rows: a pipeline's
 * `$group` emits nothing there, while SQL (and the memory adapter) always
 * yield the one group — counts 0, every other aggregate, `first` / `last` and
 * the expressions over them `null`. `undefined` when the query is grouped or
 * computes nothing. The row is BEFORE `$having` / `$skip` — see
 * {@link emptyGroupStages}.
 */
export function emptyGroupRow(query: DbQuery): Document | undefined {
  const controls = query.controls;
  const select = controls?.$select;
  if (!controls || (controls.$groupBy as string[] | undefined)?.length) return undefined;
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
 * A pipeline yielding at most one document iff ANY input row matches the
 * query's filter (and search) — the probe that tells "no rows matched" (the
 * one empty group exists) from "the real group was removed by `$having`".
 */
export function buildMatchedProbe(
  query: DbQuery,
  searchStage?: Document,
  filterOptions?: TMongoFilterOptions,
): Document[] {
  // (a two-level aggregate: any INNER row — its `$having` applied)
  return [
    ...sourceStages(query, searchStage, filterOptions),
    { $limit: 1 },
    { $project: { _id: 1 } },
  ];
}

/**
 * The pipeline that applies the query's `$having` (and, for the row query, `$skip`
 * and `$limit`) to the {@link emptyGroupRow} — over a single synthetic document
 * (a `$facet` emits exactly one document, even from an empty input), so the
 * server evaluates `$having` exactly as it does for a real group. `undefined`
 * when there is nothing to apply (the row stands). Its result is empty when the
 * row is filtered out.
 */
export function emptyGroupStages(
  query: DbQuery,
  row: Document,
  forCount: boolean,
): Document[] | undefined {
  const controls = query.controls;
  const having = controls?.$having;
  const skip = forCount ? 0 : (controls?.$skip ?? 0);
  const limit = forCount ? 0 : (controls?.$limit ?? 0);
  if (!having && !skip && !limit) return undefined;
  const stages: Document[] = [
    { $match: { _id: { $in: [] } } },
    { $facet: { one: [] } },
    { $replaceRoot: { newRoot: { $literal: row } } },
  ];
  if (having) stages.push({ $match: buildMongoFilter(having) });
  if (skip) stages.push({ $skip: skip });
  if (limit) stages.push({ $limit: limit });
  return stages;
}

/**
 * `allowDiskUse` for a pipeline that sorts before it groups (`first` / `last`
 * order every matching row by `$rowOrder` first, which may exceed the
 * in-memory sort limit), and for a two-level aggregate (two `$group` stages:
 * the outer one groups every inner group, since 0.1.168); `undefined`
 * otherwise.
 */
export function aggregateOptions(pipeline: Document[]): { allowDiskUse: true } | undefined {
  const group = pipeline.findIndex((stage) => "$group" in stage);
  const twoLevel = pipeline.findLastIndex((stage) => "$group" in stage) > group;
  return twoLevel || pipeline.slice(0, group < 0 ? 0 : group).some((stage) => "$sort" in stage)
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
  const controls = query.controls ?? {};
  const pipeline = buildGroupedStages(
    controls,
    sourceStages(query, searchStage, filterOptions),
    Boolean(controls.$having),
  );
  pipeline.push({ $count: "count" });
  return pipeline;
}
