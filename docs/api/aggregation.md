---
outline: deep
---

# Grouped Queries

<!--@include: ../_experimental-warning.md-->

`table.aggregate()` groups rows and computes counts, distinct counts, sums, averages, minimums, maximums, [arithmetic over them](#arithmetic-expressions) and [representative-row values](#representative-row-first-last) at query time — the ad-hoc counterpart of [aggregation views](/views/aggregation-views), whose shape is fixed in the schema.

```typescript
const revenue = await orders.aggregate({
  filter: { status: "paid" },
  controls: {
    $groupBy: ["region"],
    $select: [
      "region",
      { $fn: "sum", $field: "amount", $as: "total" },
      { $fn: "count", $field: "*", $as: "orders" },
    ],
    $sort: { total: -1 },
  },
});
// [{ region: "US", total: 15420.5, orders: 87 }, { region: "EU", total: 8930, orders: 42 }]
```

The same query over HTTP is `GET /orders/query?status=paid&$groupBy=region&$select=region,sum(amount):total,count(*):orders&$sort=-total` — see [Aggregation in URLs](/http/advanced#groupby).

## The query

`aggregate()` takes an `AggregateQuery` — a `filter` plus required `controls`:

| Control             | Meaning                                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$groupBy`          | Field paths to group by, or the alias of a [calendar bucket](./calendar-buckets) declared in `$select`. `[]` (or no `$groupBy`) is the [ungrouped query](#ungrouped): one row over the filtered set.                                                           |
| `$select`           | What each result row carries: plain fields (each must also appear in `$groupBy`), aggregate entries `{ $fn, $field, $as? }`, [expression entries](#arithmetic-expressions) `{ $expr, $as }` / `{ $fn, $expr, $as }`, calendar-bucket entries `{ $bucket, … }`. |
| `$rowOrder`         | The order of the rows **inside each group** that [`first` / `last`](#representative-row-first-last) read (since 0.1.148). Same shape as `$sort`. Required with `first` / `last`, rejected without them.                                                        |
| `$having`           | A filter on the groups — its keys must be aggregate aliases, bucket aliases or `$groupBy` fields.                                                                                                                                                              |
| `$sort`             | Orders the groups by a grouped field or an alias.                                                                                                                                                                                                              |
| `$skip` / `$limit`  | Pages over the groups.                                                                                                                                                                                                                                         |
| `$count`            | Returns `[{ count: N }]` — the number of groups that survive `$having`.                                                                                                                                                                                        |
| `$search`, `$index` | Text search applied to the rows **before** grouping, so a rollup describes exactly the rows the same search lists.                                                                                                                                             |

`$with` is not available on grouped queries.

## Aggregate functions

An aggregate entry is `{ $fn, $field, $as? }`. The semantics are the SQL ones on every adapter:

| `$fn`           | `$field`       | Result                                                                                                               |
| --------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `count`         | `'*'`          | Number of rows in the group                                                                                          |
| `count`         | a field        | Number of rows where the field holds a value                                                                         |
| `sum`           | numeric field  | Sum of the non-null values; `null` when there are none                                                               |
| `avg`           | numeric field  | Average of the non-null values; `null` when there are none                                                           |
| `min`           | any field      | Smallest non-null value                                                                                              |
| `max`           | any field      | Largest non-null value                                                                                               |
| `countDistinct` | any field      | Number of distinct non-null values (since 0.1.136). `'*'` is rejected                                                |
| `first`         | a scalar field | The field's value on the group's first row, ordered by [`$rowOrder`](#representative-row-first-last) (since 0.1.148) |
| `last`          | a scalar field | The field's value on the group's last row, ordered by `$rowOrder`                                                    |

`countDistinct` follows the column's collation: MySQL's default `*_ci` collations count `'A'` and `'a'` once, while PostgreSQL, SQLite and MongoDB count them twice. Every built-in adapter supports it; a [custom adapter](/adapters/creating-adapters#aggregate-functions) may not (see [errors](#validation-and-errors)).

```typescript
const reach = await orders.aggregate({
  filter: {},
  controls: {
    $groupBy: ["region"],
    $select: ["region", { $fn: "countDistinct", $field: "customerId", $as: "buyers" }],
    $having: { buyers: { $gte: 10 } },
  },
});
```

The output key is `$as` when given, otherwise `{fn}_{field}` — `sum_amount`, and `count_star` for `count(*)`. The HTTP parser uses the same rule, so `$select=count(*)` returns a `count_star` key too. The `{field}` part is always the logical field name, also when the field is stored under a `@db.column` name.

::: info `resolveAlias` and `count(*)` — 0.1.132
`resolveAlias` from `@atscript/db/agg` now returns `count_star` for `{ $fn: "count", $field: "*" }`. Up to 0.1.131 it returned `count_*`, which did not match the key the URL parser and the adapters produce.
:::

## Arithmetic expressions {#arithmetic-expressions}

_Since 0.1.148._ An aggregate query can compute with numbers — revenue as `price × qty`, an average as a ratio of two aggregates, a ranking score — instead of returning aggregates for the client to combine. There are two kinds of expression entry, in the same `$select` as the aggregates:

```typescript
const queue = await issues.aggregate({
  filter: { status: "open" },
  controls: {
    $groupBy: ["ticketId"],
    $select: [
      "ticketId",
      { $fn: "count", $field: "*", $as: "open" },
      { $fn: "sum", $field: "estimate", $as: "est" },
      // row-level: an aggregate over a per-row expression
      { $fn: "sum", $expr: { $op: "*", $args: ["price", "qty"] }, $as: "revenue" },
      // group-level: arithmetic over the aliases above, evaluated after grouping
      { $expr: { $op: "/", $args: ["est", "open"] }, $as: "avgEst" },
      { $expr: { $op: "+", $args: [{ $op: "*", $args: ["open", 10] }, "avgEst"] }, $as: "rank" },
    ],
    $sort: { rank: -1 },
    $having: { rank: { $gte: 10 } },
  },
});
```

| Entry                 | Operands (names in `$args`)                                                                                                                                                    | Result           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `{ $fn, $expr, $as }` | **Row-level.** Numeric **fields** of the row. `$fn` is `sum`, `avg`, `min` or `max`; the expression is evaluated per row, then aggregated.                                     | `number \| null` |
| `{ $expr, $as }`      | **Group-level.** The **aliases** of other numeric `$select` entries (aggregates, `first` / `last`, other expressions) and numeric `$groupBy` fields. Evaluated after grouping. | `number \| null` |

`$as` is required on both. An expression is a number literal, a name, or a node: `{ $op: '+' \| '-' \| '*' \| '/', $args: [a, b] }`, unary minus `{ $op: '-', $args: [a] }`, or `{ $op: 'coalesce', $args: [a, b, …] }`. This is the grammar of [`@db.compute`](/views/computed-columns) and it has the same semantics on every adapter:

- values are IEEE double (`7 / 2` is `3.5`);
- a `null` operand makes the result `null` (`coalesce` returns its first non-null argument);
- division by zero is `null`, not an error;
- a result past the double range is `Infinity` on SQLite and MongoDB, and a `400` (`Arithmetic overflow`) on PostgreSQL and MySQL;
- an expression is limited to 64 nodes and depth 16, and once the aliases it names are inlined (SQL repeats them) to 256 nodes — `x = a + a`, `y = x * x`, `z = y * y`, … grows exponentially and is refused with `Expression "x8" is too large once its aliases are expanded`.

Doubles make equality on fractions fragile — compare ranges (`$gte`) rather than `=` on a computed ratio.

**Rules**

- **Operands are numbers.** A field must be a `number` (not a `decimal`, not a timestamp), a plain stored column: strings, booleans, decimals, timestamps, JSON leaves, arrays, navigation fields and `@db.encrypted` fields are rejected with `Field "title" is not numeric — arithmetic needs a number field (not decimal, timestamp or text)`. A group-level operand that names an alias must name a numeric entry: `count`, `countDistinct`, an expression, or `sum` / `avg` / `min` / `max` / `first` / `last` of a numeric field (`"oldestTitle" is not numeric and cannot be used in an expression` otherwise).
- **No inline aggregates.** `sum(a)/count(*)` is not an expression: name each aggregate in `$select`, then combine the aliases. This keeps one kind of operand per scope.
- **Names resolve once.** A group-level expression may reference entries in any order but not itself (`Expression cycle: a → b → a`); an alias that is neither an aggregate/expression alias nor a `$groupBy` field is `Expression "x" references "y" — name an aggregate alias or a $groupBy field`. A calendar-bucket alias is a text label (`Bucket "w" is a text label and cannot be used in arithmetic`). The expression must use at least one name (a constant is rejected), and has at most 64 nodes and depth 16.
- **Grouped queries only.** An expression in a plain `findMany` / `query` is `Expressions and first()/last() are only valid in grouped queries`. Per-row computed values on plain reads are not provided: **declare a [view with `@db.compute`](/views/computed-columns)** when you want a value that is computed per row, sortable and filterable across requests.
- **No per-aggregate condition.** There is no `{ $fn, $field, $where }`; a conditional aggregate (`count where status = 'open'`) is a [view aggregate](/views/aggregation-views) (a `@db.agg.*` annotation with a condition), or a separate query with the condition in `filter`.
- **Aliases** follow the aggregate rule — identifier shape, unique among `$select` aliases, not equal to a field name — and an expression alias cannot be a `$groupBy` entry. The prefix `__as_` is reserved for the engine's own columns and is rejected in any alias, and so is `_id` (the group key of document stores) — `INVALID_QUERY` on every adapter.
- **Size.** One expression has at most 64 nodes and depth 16; a group-level expression is limited to 256 nodes once the aliases it names are inlined, and all the expressions of one query together to 1024 expanded nodes. A `$select` entry carries either `$field` or `$expr`, never both.
- **`$sort`, `$having`, `$skip` / `$limit`, `$count`** work on an expression alias like on an aggregate alias. `$having` is rendered over the expression itself on every adapter.
- **Strict tables.** On a table with [dimensions / measures](#dimensions-and-measures-strict-mode), row-level operands must be measures (`Expression operand "x" is not a measure`; `/meta` `fields[path].numeric` marks the numbers that may be operands in general, so an expression picker should offer the measures among them); a field tagged with a currency or unit reference needs that reference in `$groupBy`.
- **Capability.** An adapter that does not render expressions (`supportsAggregateExpressions()` is `false`, the default for a [custom adapter](/adapters/creating-adapters#aggregate-expressions)) fails with `DbError("AGG_EXPR_NOT_SUPPORTED")` — HTTP 400.

Over HTTP the same query is `$select=…,sum(price*qty):revenue,expr(est/open):avgEst` — see [Aggregation in URLs](/http/advanced#aggregate-expressions).

## Representative row: first / last {#representative-row-first-last}

_Since 0.1.148._ `first` and `last` read a field from one **representative row** of each group — "the title and id of the oldest open issue per ticket" — which no `min` / `max` can answer, because the columns belong to the same row. `$rowOrder` orders the rows inside each group; `first(f)` is `f` on the first row, `last(f)` on the last:

```typescript
const oldest = await issues.aggregate({
  filter: { status: "open" },
  controls: {
    $groupBy: ["ticketId"],
    $select: [
      "ticketId",
      { $fn: "first", $field: "id", $as: "oldestId" },
      { $fn: "first", $field: "title", $as: "oldestTitle" },
      { $fn: "first", $field: "raisedAt", $as: "oldestAt" },
      { $fn: "last", $field: "raisedAt", $as: "newestAt" },
    ],
    $rowOrder: { raisedAt: 1 },
    $sort: { oldestAt: 1 },
  },
});
```

- **One row, every field.** All `first(…)` entries read the same row, and all `last(…)` entries read the same (last) row, so `oldestId` and `oldestTitle` always belong together.
- **Deterministic.** The table's primary key is appended to `$rowOrder` as the final ascending key unless you list it, so ties break by lowest key on every adapter. A readable without a primary key (a view without `@meta.id`) leaves ties adapter-defined.
- **NULL is the smallest value** of an order key — `first` over an ascending `raisedAt` picks a row with no `raisedAt` before any dated one. The same rule as [first-row joins](/views/#first-row-joins). To skip such rows, filter them out (`raisedAt != null`).
- **A `NULL` field value is a value.** `first(x)` returns `null` when the representative row's `x` is `null`; it is not "the first non-null".
- **`$rowOrder` is required with `first` / `last`** (a non-empty `{ field: 1 | -1 }` object) and rejected without them (`$rowOrder orders rows for first()/last() only`). It applies to `first` / `last` only — there is no per-entry order. Its keys are sortable scalar fields (an encrypted key is `ENC_FIELD_SORT`).
- **The field is a scalar** — a JSON value, array or navigation path is rejected; an encrypted field is `ENC_FIELD_AGG`. `'*'` is rejected.
- **A numeric `first` / `last` can be an operand** of an [expression](#arithmetic-expressions), and sort and filter like any alias. A boolean or decimal reads back typed (`true`, a decimal string) — as does `min` / `max` of a boolean or decimal field.
- **Grouped queries only**, with no `'*'`; `first` / `last` are not available as `@db.agg.*` view annotations.

How it runs, for index planning: SQL adapters render a `FIRST_VALUE(col) OVER (PARTITION BY <group keys> ORDER BY <$rowOrder, key>)` derived table (`last` over the reversed order) that carries only the columns the query reads, then aggregate its columns per group — SQLite 3.25+, MySQL 8.0+, any PostgreSQL; MongoDB sorts the matching rows by `$rowOrder` before `$group` and takes `$first` / `$last`; the memory adapter keeps the best row per group. An index on `(group key, $rowOrder fields…, primary key)` serves them.

## Ungrouped queries {#ungrouped}

An ungrouped query (`$groupBy: []`, or no `$groupBy` at all — over HTTP an aggregate `$select` without `$groupBy`, [since 0.1.155](/http/advanced#ungrouped)) is one group on every adapter, so over no matching row it returns **one row**: counts `0`, every other aggregate, `first` / `last` and the expressions over them `null`. With `$count: true` such a query answers `{ count: 1 }` (the one aggregated row), or `{ count: 0 }` when a `$having` filters it out — the number of rows the data query returns.

## Result rows

- **Each row carries what `$select` lists** — its plain fields, bucket aliases and aggregate aliases. Always pass a `$select`.
- **Grouped nested fields come back nested.** Grouping by a flattened nested-object leaf (`$groupBy: ['stats.views']`) returns `{ stats: { views: 1 }, cnt: 2 }` on every adapter, and grouped boolean, decimal and `@db.json` columns are coerced as in `findMany` (a grouped boolean is `true` / `false`, not `0` / `1`) — since 0.1.128.
- **`null` and missing form one group** on every adapter. Since 0.1.132 on MongoDB, which used to return a `null` group and a separate group for documents missing the field.
- **`$count`** counts the groups that survive `$having` (since 0.1.129).
- **Order** is whatever `$sort` asks for. Without `$sort`, no order is guaranteed.

## Dimensions and measures (strict mode)

When a table marks fields with [`@db.column.dimension` or `@db.column.measure`](/adapters/annotations#aggregation), grouped queries become strict:

- every `$groupBy` field must be a dimension, else `Field "x" is not a dimension` (path `$groupBy`). A [calendar bucket](./calendar-buckets#which-fields-can-be-bucketed)'s source field must be one too; that rule is reported on the field itself ([errors](./calendar-buckets#errors));
- every aggregate `$field` except `'*'` must be a measure, else `Aggregate field "x" is not a measure`. A `countDistinct`, `first` or `last` field may be a dimension or a measure ("how many regions sold"), else `Aggregate field "x" is not a dimension or measure`. The same holds for a `$rowOrder` key.

A table without either annotation accepts any groupable field. Fields tagged with a currency or unit reference must also be grouped by that reference — see [Quantity dimensions](/views/aggregations#runtime-aggregation-quantity-dimensions).

## Validation and errors

Grouped queries are checked before any SQL or pipeline is built. Failures throw `DbError("INVALID_QUERY")` (HTTP 400 through moost-db):

| Mistake                                                                                             | Message                                                                                        |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A plain `$select` field missing from `$groupBy`                                                     | `Plain field "x" in $select must also appear in $groupBy`                                      |
| A `$having` key that is neither an alias nor a grouped field                                        | `$having key "x" must be an aggregate alias or a $groupBy field`                               |
| A `$select` entry that is not a string, aggregate or bucket                                         | `Unsupported $select entry at index i`                                                         |
| An aggregate `$fn` other than `sum`, `count`, `avg`, `min`, `max`, `countDistinct`, `first`, `last` | `Unknown aggregate function "x" — use sum, count, avg, min, max, countDistinct, first or last` |
| `*` on any aggregate other than `count`, e.g. `sum(*)` or `countDistinct(*)`                        | `Aggregate "sum" needs a field — only count accepts *`                                         |
| A `$groupBy` entry that is not a string                                                             | `Unsupported $groupBy entry at index i — expected a field name or bucket alias`                |
| A path that does not resolve to stored data (JSON descendant on SQL, etc.)                          | see [path validation](/api/queries#nested-field-filters)                                       |

A known function the adapter does not render (`aggregateFns()`) fails with `DbError("AGG_FN_NOT_SUPPORTED")` — also HTTP 400 — and message `Aggregate function "countDistinct" is not supported by this adapter`. An [expression](#arithmetic-expressions) on an adapter that does not render them fails with `DbError("AGG_EXPR_NOT_SUPPORTED")` (HTTP 400, `Aggregate expressions are not supported by this adapter`); [`/meta.aggregateExpressions`](/http/crud#get-meta) says which. The expression and `$rowOrder` rules have their own messages, listed [above](#arithmetic-expressions). [`/meta.aggregateFns`](/http/crud#get-meta) lists the functions an adapter supports. An `@db.encrypted` field in `$groupBy` or an aggregate fails with `ENC_FIELD_AGG`. Calendar buckets add their own rules — see [Calendar Buckets — Errors](./calendar-buckets#errors).

::: warning Malformed entries are rejected since 0.1.132
Up to 0.1.131 an unrecognized `$select` entry (for example `{ $fn: "sum" }` without `$field`) or a non-string `$groupBy` entry was silently dropped, so the query ran without it.
:::

## Adapter support

Grouped queries run on every adapter, with the semantics above.

- **Memory** — since 0.1.132 (earlier versions threw `INVALID_QUERY`). Groups are computed in process over one snapshot, in provider mode too. See [Memory — Grouped queries](/adapters/memory#grouped-queries).
- **Expressions and `first` / `last`** (since 0.1.148) run on every bundled adapter — SQLite, PostgreSQL, MySQL, MongoDB and memory. See each adapter page: [SQLite](/adapters/sqlite#aggregate-expressions), [PostgreSQL](/adapters/postgresql#aggregate-expressions), [MySQL](/adapters/mysql#aggregate-expressions), [MongoDB](/adapters/mongodb#aggregate-expressions), [Memory](/adapters/memory#grouped-queries).
- **MongoDB** — `@db.column`-renamed fields work in `$groupBy`, aggregate fields, `$sort` and `$having` since 0.1.132; earlier versions mapped them to the wrong document keys.

## See also

- [Calendar Buckets](./calendar-buckets) — group by hour, day, week, month, quarter or year
- [Aggregation in URLs](/http/advanced#groupby) — `$groupBy`, `$having` and `fn(field):alias` over HTTP
- [HTTP Client — aggregate](/http/client#aggregate) — typed grouped queries from the browser
- [Aggregation Views](/views/aggregation-views) — aggregations declared in the schema
- [Computed Columns](/views/computed-columns) — the same arithmetic declared on a view, for per-row values and global rankings
