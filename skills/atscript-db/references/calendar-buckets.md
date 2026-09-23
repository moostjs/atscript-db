# calendar-buckets (`{ $bucket }` / `bucket()` — group by day, week, month, quarter, year in a time zone)

Since 0.1.132, every adapter. A computed `$select` entry of a grouped query ([aggregation.md](aggregation.md)); the value is a `YYYY-MM-DD` label.

## Quick start

```ts
const weekly = await tickets.aggregate({
  filter: { openedAt: { $gte: from, $lt: to } }, // ALWAYS bound the raw timestamp (index)
  controls: {
    $select: [
      { $bucket: "week", $field: "openedAt", $tz: "Europe/Berlin", $weekStart: "sun", $as: "week" },
      { $fn: "count", $field: "*", $as: "n" },
    ],
    $groupBy: ["week"], // the alias — required
    $sort: { week: 1 },
    $having: { week: { $gte: "2026-03-01" } }, // string compare
  },
});
// [{ week: "2026-03-01", n: 12 }, …]
```

```
GET /tickets/query?$select=bucket(openedAt,week,'Europe/Berlin',sun):week,count(*):n&$groupBy=week&$sort=week&$having=week>='2026-03-01'
```

## Entry

| Key          | Values                                       | Default          |
| ------------ | -------------------------------------------- | ---------------- |
| `$bucket`    | `day` `week` `month` `quarter` `year`        | required         |
| `$field`     | `number.timestamp` (`.created` / `.updated`) | required         |
| `$tz`        | canonical IANA name                          | `'UTC'`          |
| `$weekStart` | `mon` … `sun` — ONLY with `week`             | `'mon'`          |
| `$as`        | identifier `^[A-Za-z_][A-Za-z0-9_]*$`        | `{unit}_{field}` |

URL: `bucket(field,unit[,tz][,weekStart])[:alias]`; quote a zone containing `/`; empty slot = default zone (`bucket(openedAt,week,,sun)`); `bucket` is reserved; `bucket(x)` / >4 args = malformed (400).

## Invariants

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Label = local date (in `$tz`) of the bucket's FIRST day, same format for every unit: day `2026-03-29`, week(mon) `2026-03-23`, month `2026-03-01`, quarter/year `2026-01-01`. Week label may fall in the previous month/year. Quarters = Jan/Apr/Jul/Oct.                                                                                                                                                                     |
| 2   | Labels sort chronologically as strings → `$sort` / `$having` need no parsing. `$having` / URL values are strings (quote in URLs: hyphens).                                                                                                                                                                                                                                                                                    |
| 3   | `null` / missing source, or instant outside `[1970-01-02Z, 3000-01-01Z)` → `null` label; all form ONE `null` group. Typed `string` (`string \| null` for an optional source) in `@atscript/db-client`.                                                                                                                                                                                                                        |
| 4   | Only in grouped queries; the alias MUST be in `$groupBy`. `findMany` / no `$groupBy` → `INVALID_QUERY` (`Calendar buckets are only valid in grouped queries`).                                                                                                                                                                                                                                                                |
| 5   | Zones: IANA names from the Node runtime list + `UTC` + `Etc/GMT±N`; case-insensitive, canonicalized (`europe/berlin` → `Europe/Berlin`). Aliases rejected with hint (`US/Eastern` → use `America/New_York`; also `Etc/UTC`, `CET`, `Asia/Calcutta`). Offsets / abbreviations rejected.                                                                                                                                        |
| 6   | Source: the TYPE is the opt-in — `number.timestamp[.created\|.updated]`, stored leaf, not inside a `@db.json`/array column (any adapter), not `@db.encrypted` (`ENC_FIELD_AGG`), not `@db.writeOnly` (HTTP), a dimension in strict mode.                                                                                                                                                                                      |
| 7   | Alias: unique among `$select` aliases, not equal to any field / physical / nav name; dotted source (`stats.firstSeenAt`) needs explicit `$as`.                                                                                                                                                                                                                                                                                |
| 8   | Errors: rule violations → `INVALID_QUERY` 400 (`path` `$select` / `$groupBy`; HTTP field rules path = field: `Bucketing field "points" is not permitted — not a timestamp field (declare it number.timestamp).` / `— not a dimension.` / `— adapter has no calendar buckets.`). Unit unsupported → `BUCKET_NOT_SUPPORTED` 400. Engine can't resolve zone → `BUCKET_TZ_UNAVAILABLE` **501** — never a silent `null`/UTC label. |
| 9   | Discovery: `/meta.bucketUnits` (omitted when none) + `fields[P].bucketable: true` exactly when the gate accepts bucketing `P`. Gate a UI's time-grouping control on these.                                                                                                                                                                                                                                                    |
| 10  | GROUP BY an expression can't use an index — pair the bucket with a WHERE range on the raw timestamp. Never narrow the period via `$having` on the label.                                                                                                                                                                                                                                                                      |
| 11  | Labels agree across adapters only where their tz databases agree (PG tzdata, MySQL tables, Mongo bundled, SQLite/memory Node ICU). Keep server tzdata current.                                                                                                                                                                                                                                                                |

## Per adapter

| Adapter    | Requirement / note                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | none; `AT TIME ZONE`, session-zone independent. Unknown zone → 501.                                                                                                                                                                     |
| MySQL      | non-UTC zones need tz tables (`mysql_tzinfo_to_sql /usr/share/zoneinfo \| mysql -u root mysql`) and 8.0.28+ 64-bit; lazy per-zone probe → 501 with the fix. Slim zoneinfo → no DST after 2037. → [adapters-mysql.md](adapters-mysql.md) |
| SQLite     | driver needs `registerFunction` (`BetterSqlite3Driver` has it); without it → no units, `BUCKET_NOT_SUPPORTED`. → [adapters-sqlite.md](adapters-sqlite.md)                                                                               |
| MongoDB    | ≥ 4.0 (`$dateToParts` / `$dateFromParts`). Unknown zone (code 40485) → 501.                                                                                                                                                             |
| Memory     | in-process kernel.                                                                                                                                                                                                                      |

## Gap filling (client or server)

```ts
import { nextBucketLabel, bucketStartInstant } from "@atscript/db-client"; // also @uniqu/core
const counts = new Map(weekly.map((r) => [r.week, r.n]));
for (let w = weekly[0].week; w <= weekly.at(-1)!.week; w = nextBucketLabel(w, "week", "sun")) {
  series.push({ week: w, n: counts.get(w) ?? 0 });
}
bucketStartInstant("2026-03-01", "Europe/Berlin"); // epoch ms of that local midnight (DST-gap safe)
```

Same unit + week start as the query. `nextBucketLabel` is tz-free.

## Key imports

```ts
import type { BucketExpr, BucketUnit, WeekStart, CalendarBucketLabel } from "@atscript/db"; // also @atscript/db-client
import type { ValidGroupBy } from "@atscript/db-client";
import { nextBucketLabel, bucketStartInstant } from "@atscript/db-client";
```

Adapter authors (`calendarBucketUnits()`, `$select.buckets`, `bucketByAlias`, dialect `calendarBucket` / `bucketAliasInHaving`) → [creating-adapters.md](creating-adapters.md).

## References

| Domain          | File                                         | When                                            |
| --------------- | -------------------------------------------- | ----------------------------------------------- |
| Grouped queries | [aggregation.md](aggregation.md)             | `aggregate()`, aggregate functions, strict mode |
| HTTP / `/meta`  | [moost-db.md](moost-db.md)                   | `bucketUnits` / `bucketable`, status mapping    |
| Client          | [db-client.md](db-client.md)                 | Typed `aggregate()` with buckets                |
| Custom adapter  | [creating-adapters.md](creating-adapters.md) | Implementing buckets in an adapter              |

See also: https://db.atscript.dev/api/calendar-buckets
