# aggregation (grouped queries — `table.aggregate()`, `$groupBy`)

`table.aggregate(q)` is a **distinct method** from `findMany` — it takes an `AggregateQuery` (`filter?`, **required** `controls`). Only `aggregate()` interprets `$groupBy`; route every grouped read through it. HTTP: `GET /query?$groupBy=…` (URL form in [http-query-syntax.md](http-query-syntax.md)). Group by hour/day/week/month → [calendar-buckets.md](calendar-buckets.md).

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

| Control             | Rule                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$groupBy`          | Required `string[]`: field paths or bucket aliases from `$select`.                                                                                                                            |
| `$select`           | Plain fields (each also in `$groupBy`), `{ $fn, $field, $as? }` aggregates, `{ $fn, $expr, $as }` / `{ $expr, $as }` expressions (0.1.148), `{ $bucket, $field, … }` buckets. Always pass it. |
| `$rowOrder`         | `{ field: 1 \| -1 }` — order of the rows INSIDE each group for `first` / `last` (0.1.148). Required with them, rejected without.                                                              |
| `$having`           | Keys = aggregate aliases, bucket aliases or `$groupBy` fields ONLY.                                                                                                                           |
| `$sort`             | Grouped field or alias. No implicit order.                                                                                                                                                    |
| `$skip` / `$limit`  | Page over groups.                                                                                                                                                                             |
| `$count`            | `[{ count: N }]` = groups surviving `$having` (since 0.1.129).                                                                                                                                |
| `$search`, `$index` | Not declared on the type (ride the `$`-key pass-through) — text search applied BEFORE grouping (since 0.1.130), see below.                                                                    |
| `$with`             | Not allowed (HTTP 400).                                                                                                                                                                       |

## Invariants

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SQL semantics on EVERY adapter: `count(*)` rows, `count(f)` non-null and non-missing, `countDistinct(f)` distinct non-null values, `sum`/`avg` over non-null numerics → `null` when none (MongoDB too since 0.1.148; it was `0`), `min`/`max` over non-null. An UNGROUPED query is one group: over no rows it returns ONE row (counts `0`, the rest `null`) on every adapter (Mongo since 0.1.148).                                                                                    |
| 2   | Output key = `$as`, else `{fn}_{field}` with the LOGICAL field (also over a `@db.column` rename: `sum(amount)` over `amount_cents` → `sum_amount`); `count(*)` → **`count_star`**. `resolveAlias` (`@atscript/db/agg`) = uniqu's rule since 0.1.132 (≤ 0.1.131 it returned `count_*`, mismatching the URL parser).                                                                                                                                                                     |
| 3   | `null` and missing grouped values = ONE `null` group on every adapter (≤ 0.1.131 MongoDB split them).                                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | Rows carry only what `$select` lists. Grouped flattened leaf comes back nested (`$groupBy: ["stats.views"]` → `{ stats: { views } }`); grouped boolean/decimal/`@db.json` coerced like `findMany` (0.1.128).                                                                                                                                                                                                                                                                           |
| 5   | Strict mode — table declares any `@db.column.dimension` / `.measure`: every `$groupBy` field must be a dimension (`Field "x" is not a dimension`, path `$groupBy`), every aggregate `$field` except `'*'` a measure — a `countDistinct` field may be a dimension OR a measure (else `Aggregate field "x" is not a dimension or measure`). A bucket's SOURCE must be a dimension too, reported as a bucket-source rule on the field → [calendar-buckets.md](calendar-buckets.md) #6/#8. |
| 6   | Aggregating a `@db.amount.currency.ref` / `@db.unit.ref` field requires the ref field in `$groupBy` (`INVALID_QUERY`). `count(*)` exempt.                                                                                                                                                                                                                                                                                                                                              |
| 7   | `Plain field "x" in $select must also appear in $groupBy`; `$having key "x" must be an aggregate alias or a $groupBy field` (0.1.128). All `INVALID_QUERY` / HTTP 400.                                                                                                                                                                                                                                                                                                                 |
| 8   | Unknown `$select` entry (not string / aggregate / bucket) → `Unsupported $select entry at index i`; non-string `$groupBy` entry → `Unsupported $groupBy entry at index i — …` (since 0.1.132; ≤ 0.1.131 silently DROPPED — the query ran without it).                                                                                                                                                                                                                                  |
| 9   | Path guard applies to `$groupBy`, aggregate `$field`, `$having` keys (minus aliases) — see [queries.md § Path guard](queries.md#path-guard-since-01128). Encrypted field → `ENC_FIELD_AGG`.                                                                                                                                                                                                                                                                                            |
| 10  | Every adapter aggregates. **Memory since 0.1.132** (was `INVALID_QUERY`) — in-process scan over one snapshot, provider mode too. MongoDB `@db.column`-renamed fields in `$groupBy` / aggregates / `$sort` / `$having` fixed in 0.1.132.                                                                                                                                                                                                                                                |
| 11  | `$fn` ∈ `sum`/`count`/`avg`/`min`/`max`/`countDistinct`/`first`/`last` ONLY — else `Unknown aggregate function "x" — use sum, count, avg, min, max, countDistinct, first or last`; `'*'` is `count`'s only — else `Aggregate "countDistinct" needs a field — only count accepts *`. `INVALID_QUERY`, path `$select`, HTTP 400, before any adapter runs. Adapters re-assert with `assertAggregateFn`.                                                                                   |
| 12  | A known `$fn` the adapter doesn't list in `aggregateFns()` → `DbError("AGG_FN_NOT_SUPPORTED")`, `Aggregate function "countDistinct" is not supported by this adapter`, HTTP 400, before dispatch. Every built-in adapter supports all eight (`first` / `last` since 0.1.148); `/meta.aggregateFns` lists them.                                                                                                                                                                         |
| 13  | `countDistinct` distinctness follows collation: MySQL `*_ci` counts `'A'`/`'a'` once; PG / SQLite / Mongo case-sensitive. Mongo builds an in-memory `$addToSet` per group (100 MB `$group` limit on huge cardinalities).                                                                                                                                                                                                                                                               |

## Arithmetic and `first` / `last` (since 0.1.148)

```ts
await issues.aggregate({
  filter: { status: "open" },
  controls: {
    $groupBy: ["ticketId"],
    $select: [
      "ticketId",
      { $fn: "count", $field: "*", $as: "open" },
      { $fn: "sum", $field: "estimate", $as: "est" },
      { $fn: "sum", $expr: { $op: "*", $args: ["price", "qty"] }, $as: "revenue" }, // row-level: fields
      { $expr: { $op: "/", $args: ["est", "open"] }, $as: "avgEst" }, // group-level: aliases / $groupBy fields
      { $fn: "first", $field: "id", $as: "oldestId" }, // same representative row for every first()
      { $fn: "first", $field: "title", $as: "oldestTitle" },
    ],
    $rowOrder: { raisedAt: 1 }, // PK appended as final tie-break
    $sort: { avgEst: -1 },
    $having: { avgEst: { $gte: 2 } },
  },
});
```

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | Expression = number \| name \| `{ $op: '+'\|'-'\|'*'\|'/', $args:[a,b] }` \| unary `{ $op:'-', $args:[a] }` \| `{ $op:'coalesce', $args:[a,b,…] }` — `@db.compute` semantics: IEEE double, NULL propagates, `/` by 0 → `null`. `$as` required; ≤ 64 nodes, depth ≤ 16, ≤ 256 once aliases are inlined; at least one name.                                                     |
| 15  | Row-level `{ $fn: sum\|avg\|min\|max, $expr, $as }` names FIELDS; group-level `{ $expr, $as }` names ALIASES of numeric entries (acyclic) or numeric `$groupBy` fields. No inline aggregates (`sum(a)/count(*)`): name each, then combine. Operands must be `number` — not decimal / timestamp / string / boolean / JSON / encrypted (`ENC_FIELD_AGG`). Grouped queries ONLY. |
| 16  | `first` / `last` read a scalar field of ONE representative row per group, ordered by `$rowOrder` (PK appended; NULL key smallest; ties → lowest PK); a NULL on that row is returned. `$rowOrder` is required with them, rejected without. Strict tables: row-level operands = measures, `$rowOrder` keys = dimension or measure.                                              |
| 17  | `supportsAggregateExpressions()` (default `false`) else `AGG_EXPR_NOT_SUPPORTED` (400); `first`/`last` in `aggregateFns()` else `AGG_FN_NOT_SUPPORTED`. All built-in adapters support both. No per-aggregate `$where` and no per-row computed values on plain reads → a view (`@db.agg.*` with condition, `@db.compute`).                                                     |
| 18  | Reserved aliases (0.1.148): the prefix `__as_` (the engine's own columns) and `_id` (the group key of document stores) are `INVALID_QUERY` in any alias, on every adapter. PostgreSQL `first` / `last` of a native array column picks through `MIN` over the array.                                                                                                           |

Full rules, error messages and per-adapter notes: [docs → Grouped Queries](https://db.atscript.dev/api/aggregation#arithmetic-expressions).

URL: `sum(price*qty):revenue`, `expr(est/open):avgEst` (write `+` as `%2B`), `first(title):oldest`, `$rowOrder=raisedAt,-id`. Types: `AggregateOfExpr`, `SelectArithExpr`, `ArithExpr` (`@uniqu/core`); expression aliases are `number | null`, first/last = the field's type. `/meta`: `aggregateExpressions`, `fields[P].numeric`, `fields[P].groupable` (since 0.1.148: `true` exactly when `$groupBy` on P passes the gate — physically filterable, and on a table with dimensions a dimension; a distinct-values picker `$groupBy=f&$select=f` needs `filterable ∧ groupable`).

## `$search` on an aggregate query (since 0.1.130)

Search narrows the ROWS, `$groupBy` shapes what is left — the adapter applies the search predicate BEFORE grouping, so a rollup describes exactly the rows the same `$search` returns in the leaf list. `$count` counts the groups those rows form (still after `$having`). Up to 0.1.129 every adapter with native text search silently DISCARDED the term on the aggregate path.

- **No implicit relevance ordering.** Grouped results order by `$sort` or not at all.
- **No implicit row cap.** (The leaf Mongo runner's 1000-row search cap is not applied before grouping.)
- `$search` on a source with no search capability → `DbError("INVALID_QUERY", [{ path: "$search" }])`. Over HTTP the `@db.column.searchable` fallback rewrites the term into the filter first, so grouped queries are searched there too. `$vector` + `$groupBy` → 400.

## Key imports

```ts
import type { AggregateQuery, AggregateExpr, AggregateResult } from "@atscript/db/agg";
import { resolveAlias, isAggregateExpr, isBucketExpr, assertAggregateFn } from "@atscript/db/agg";
import { evaluateExpr } from "@atscript/db"; // shared expression evaluator (adapter authors)
```

## References

| Domain           | File                                         | When                                                        |
| ---------------- | -------------------------------------------- | ----------------------------------------------------------- |
| Calendar buckets | [calendar-buckets.md](calendar-buckets.md)   | Grouping a timestamp by day / week / month / quarter / year |
| URL form         | [http-query-syntax.md](http-query-syntax.md) | `$groupBy`, `fn(field):alias`, `$having` in a query string  |
| Filters / paths  | [queries.md](queries.md)                     | Filter operators, path guard, non-grouped controls          |
| Views            | [tables-and-views.md](tables-and-views.md)   | Fixed aggregations declared with `@db.agg.*` on a view      |

See also: https://db.atscript.dev/api/aggregation
