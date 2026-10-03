# aggregation (grouped queries — `table.aggregate()`, `$groupBy`)

`table.aggregate(q)` is a **distinct method** from `findMany` — it takes an `AggregateQuery` (`filter?`, **required** `controls`). Only `aggregate()` interprets `$groupBy`; route every grouped read through it. HTTP: `GET /query?$groupBy=…` (URL form in [http-query-syntax.md](http-query-syntax.md)). Group by day/week/month → [calendar-buckets.md](calendar-buckets.md).

## Quick start

```ts
await orders.aggregate({
  filter: { status: "paid" },
  controls: {
    $groupBy: ["category"],
    $select: [
      "category",
      { $fn: "sum", $field: "amount", $as: "total" },
      { $fn: "count", $field: "*" }, // key: count_star
      { $fn: "countDistinct", $field: "customerId", $as: "buyers" },
    ],
    $having: { total: { $gt: 100 } },
    $sort: { total: -1 },
  },
});
```

## Controls

| Control             | Rule                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `$groupBy`          | Required `string[]`: field paths or bucket aliases from `$select`.                                                            |
| `$select`           | Plain fields (each also in `$groupBy`), `{ $fn, $field, $as? }` aggregates, `{ $bucket, $field, … }` buckets. Always pass it. |
| `$having`           | Keys = aggregate aliases, bucket aliases or `$groupBy` fields ONLY.                                                           |
| `$sort`             | Grouped field or alias. No implicit order.                                                                                    |
| `$skip` / `$limit`  | Page over groups.                                                                                                             |
| `$count`            | `[{ count: N }]` = groups surviving `$having` (since 0.1.129).                                                                |
| `$search`, `$index` | Not declared on the type (ride the `$`-key pass-through) — text search applied BEFORE grouping (since 0.1.130), see below.    |
| `$with`             | Not allowed (HTTP 400).                                                                                                       |

## Invariants

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SQL semantics on EVERY adapter: `count(*)` rows, `count(f)` non-null and non-missing, `countDistinct(f)` distinct non-null values, `sum`/`avg` over non-null numerics → `null` when none (**MongoDB `sum` → `0`** — only divergence), `min`/`max` over non-null.                                                                                                                                                                                                                       |
| 2   | Output key = `$as`, else `{fn}_{field}` with the LOGICAL field (also over a `@db.column` rename: `sum(amount)` over `amount_cents` → `sum_amount`); `count(*)` → **`count_star`**. `resolveAlias` (`@atscript/db/agg`) = uniqu's rule since 0.1.132 (≤ 0.1.131 it returned `count_*`, mismatching the URL parser).                                                                                                                                                                     |
| 3   | `null` and missing grouped values = ONE `null` group on every adapter (≤ 0.1.131 MongoDB split them).                                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | Rows carry only what `$select` lists. Grouped flattened leaf comes back nested (`$groupBy: ["stats.views"]` → `{ stats: { views } }`); grouped boolean/decimal/`@db.json` coerced like `findMany` (0.1.128).                                                                                                                                                                                                                                                                           |
| 5   | Strict mode — table declares any `@db.column.dimension` / `.measure`: every `$groupBy` field must be a dimension (`Field "x" is not a dimension`, path `$groupBy`), every aggregate `$field` except `'*'` a measure — a `countDistinct` field may be a dimension OR a measure (else `Aggregate field "x" is not a dimension or measure`). A bucket's SOURCE must be a dimension too, reported as a bucket-source rule on the field → [calendar-buckets.md](calendar-buckets.md) #6/#8. |
| 6   | Aggregating a `@db.amount.currency.ref` / `@db.unit.ref` field requires the ref field in `$groupBy` (`INVALID_QUERY`). `count(*)` exempt.                                                                                                                                                                                                                                                                                                                                              |
| 7   | `Plain field "x" in $select must also appear in $groupBy`; `$having key "x" must be an aggregate alias or a $groupBy field` (0.1.128). All `INVALID_QUERY` / HTTP 400.                                                                                                                                                                                                                                                                                                                 |
| 8   | Unknown `$select` entry (not string / aggregate / bucket) → `Unsupported $select entry at index i`; non-string `$groupBy` entry → `Unsupported $groupBy entry at index i — …` (since 0.1.132; ≤ 0.1.131 silently DROPPED — the query ran without it).                                                                                                                                                                                                                                  |
| 9   | Path guard applies to `$groupBy`, aggregate `$field`, `$having` keys (minus aliases) — see [queries.md § Path guard](queries.md#path-guard-since-01128). Encrypted field → `ENC_FIELD_AGG`.                                                                                                                                                                                                                                                                                            |
| 10  | Every adapter aggregates. **Memory since 0.1.132** (was `INVALID_QUERY`) — in-process scan over one snapshot, provider mode too. MongoDB `@db.column`-renamed fields in `$groupBy` / aggregates / `$sort` / `$having` fixed in 0.1.132.                                                                                                                                                                                                                                                |
| 11  | `$fn` ∈ `sum`/`count`/`avg`/`min`/`max`/`countDistinct` ONLY — else `Unknown aggregate function "x" — use sum, count, avg, min, max or countDistinct`; `'*'` is `count`'s only — else `Aggregate "countDistinct" needs a field — only count accepts *`. `INVALID_QUERY`, path `$select`, HTTP 400, before any adapter runs. Adapters re-assert with `assertAggregateFn`.                                                                                                               |
| 12  | A known `$fn` the adapter doesn't list in `aggregateFns()` → `DbError("AGG_FN_NOT_SUPPORTED")`, `Aggregate function "countDistinct" is not supported by this adapter`, HTTP 400, before dispatch. Every built-in adapter supports all six; `/meta.aggregateFns` lists them.                                                                                                                                                                                                            |
| 13  | `countDistinct` distinctness follows collation: MySQL `*_ci` counts `'A'`/`'a'` once; PG / SQLite / Mongo case-sensitive. Mongo builds an in-memory `$addToSet` per group (100 MB `$group` limit on huge cardinalities).                                                                                                                                                                                                                                                               |

Runtime arithmetic in `$select` / `$sort` (e.g. `sum(a) / count(*)`, a weighted rank) is NOT supported — declare it in a view: two `@db.agg.*` fields + `@db.compute` (0.1.147) → an ordinary sortable / filterable column. See [tables-and-views.md § Computed columns](tables-and-views.md#computed-columns-01147).

## `$search` on an aggregate query (since 0.1.130)

Search narrows the ROWS, `$groupBy` shapes what is left — the adapter applies the search predicate BEFORE grouping, so a rollup describes exactly the rows the same `$search` returns in the leaf list. `$count` counts the groups those rows form (still after `$having`). Up to 0.1.129 every adapter with native text search silently DISCARDED the term on the aggregate path.

- **No implicit relevance ordering.** Grouped results order by `$sort` or not at all.
- **No implicit row cap.** (The leaf Mongo runner's 1000-row search cap is not applied before grouping.)
- `$search` on a source with no search capability → `DbError("INVALID_QUERY", [{ path: "$search" }])`. Over HTTP the `@db.column.searchable` fallback rewrites the term into the filter first, so grouped queries are searched there too. `$vector` + `$groupBy` → 400.

## Key imports

```ts
import type { AggregateQuery, AggregateExpr, AggregateResult } from "@atscript/db/agg";
import { resolveAlias, isAggregateExpr, isBucketExpr, assertAggregateFn } from "@atscript/db/agg";
```

## References

| Domain           | File                                         | When                                                        |
| ---------------- | -------------------------------------------- | ----------------------------------------------------------- |
| Calendar buckets | [calendar-buckets.md](calendar-buckets.md)   | Grouping a timestamp by day / week / month / quarter / year |
| URL form         | [http-query-syntax.md](http-query-syntax.md) | `$groupBy`, `fn(field):alias`, `$having` in a query string  |
| Filters / paths  | [queries.md](queries.md)                     | Filter operators, path guard, non-grouped controls          |
| Views            | [tables-and-views.md](tables-and-views.md)   | Fixed aggregations declared with `@db.agg.*` on a view      |

See also: https://db.atscript.dev/api/aggregation
