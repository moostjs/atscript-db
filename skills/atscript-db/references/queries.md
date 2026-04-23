# queries

Filter/control shape is MongoDB-compatible; SQL adapters translate via `@atscript/db-sql-tools`.

## Uniquery shape

```ts
interface Uniquery<Own, Nav> {
  filter?: FilterExpr;
  controls?: UniqueryControls;
  insights?: UniqueryInsights; // optional; moost-db computes from URL
}
```

## Filter operators

All applied per-field unless inside `$and / $or / $not`.

| Operator            | Example                                      | Meaning                                  |
| ------------------- | -------------------------------------------- | ---------------------------------------- |
| equality (implicit) | `{ name: 'Alice' }`                          | `=`                                      |
| `$eq`               | `{ id: { $eq: 1 } }`                         | `=`                                      |
| `$ne`               | `{ status: { $ne: 'done' } }`                | `<>`                                     |
| `$gt / $gte`        | `{ age: { $gt: 18 } }`                       | `>` / `>=`                               |
| `$lt / $lte`        | `{ age: { $lte: 65 } }`                      | `<` / `<=`                               |
| `$in / $nin`        | `{ role: { $in: ['admin', 'editor'] } }`     | `IN` / `NOT IN`                          |
| `$between`          | `{ age: { $between: [18, 65] } }`            | `BETWEEN`                                |
| `$like`             | `{ name: { $like: 'Al%' } }`                 | `LIKE` (case-sensitive per collation)    |
| `$ilike`            | `{ name: { $ilike: 'al%' } }`                | Case-insensitive LIKE                    |
| `$regex`            | `{ name: { $regex: '^Al', $options: 'i' } }` | Regex (per-adapter translation)          |
| `$exists`           | `{ deletedAt: { $exists: false } }`          | Null / key-presence                      |
| `$startsWith`       | `{ slug: { $startsWith: 'foo-' } }`          | Prefix                                   |
| `$endsWith`         | `{ slug: { $endsWith: '-v2' } }`             | Suffix                                   |
| `$contains`         | `{ title: { $contains: 'foo' } }`            | Substring (case-sensitive per collation) |
| `$containsAny`      | `{ tags: { $containsAny: ['a', 'b'] } }`     | Array/string contains-any                |
| `$containsAll`      | `{ tags: { $containsAll: ['a', 'b'] } }`     | Array contains-all                       |

## Logical composition

```ts
filter: {
  $and: [{ active: true }, { $or: [{ role: 'admin' }, { createdAt: { $gt: cutoff } }] }],
  $not: { email: { $endsWith: '@banned.dev' } },
}
```

## Controls

| Control               | Value                                     | Effect                                                                                |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `$select`             | `string[] \| { [path]: 0 \| 1 }`          | Projection. Array form = include-list; map form = explicit.                           |
| `$sort`               | `{ [path]: 1 \| -1 }`                     | Ordered keys.                                                                         |
| `$skip`               | `number`                                  | Offset.                                                                               |
| `$limit`              | `number`                                  | Row cap.                                                                              |
| `$page` / `$size`     | `number`                                  | Used by `/pages` endpoint — alternative to `$skip`/`$limit`.                          |
| `$count`              | `true`                                    | Return a count instead of rows.                                                       |
| `$with`               | `Array<{ name: string; controls?: ... }>` | Load nav relations. Nested `controls` apply per-relation.                             |
| `$groupBy`            | `string[]`                                | Aggregate query. Requires `@db.column.dimension` on keys and `@db.agg.*` on measures. |
| `$search` / `$vector` | `string` / `number[]`                     | Full-text / vector search (adapter must support).                                     |

## Projection with $with

Response type is computed statically from `$with` — nav props absent unless requested.

```ts
const r = await posts.findMany({
  controls: { $with: [{ name: "author", controls: { $select: ["id", "name"] } }] },
});
r[0].author?.id; // typed
r[0].content; // still there — only nav props are stripped/added
```

## Aggregation

```ts
await orders.aggregate({
  filter: { status: "paid" },
  controls: {
    $groupBy: ["category"],
    $select: ["category", { $fn: "sum", $field: "amount" }, { $fn: "count" }],
  },
});
```

Groups over fields marked `@db.column.dimension`; aggregates over fields marked `@db.column.measure` (or via `@db.agg.*` on view fields).

## Insights

`UniqueryInsights = Map<field, Set<InsightOp>>` — per-field operator set. Adapters use it for query-time behaviour (collation, tokenizer). `moost-db` computes it from the URL automatically; set manually only when building queries from non-URL sources.

## URL parsing

For HTTP consumption see `http-query-syntax.md` — the URL encoding differs (uses `field=v`, `field!=v`, `field>v`, etc.) and is parsed into the same `Uniquery` shape before reaching the adapter.
