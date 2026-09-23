---
outline: deep
---

# Calendar Buckets

<!--@include: ../_experimental-warning.md-->

Group rows by the day, week, month, quarter or year of a timestamp, in the time zone your users live in. A calendar bucket is a computed `$select` entry of a [grouped query](./aggregation): the database turns each timestamp into the local date its period starts on, and the query groups, sorts and filters by it. Available on every adapter since 0.1.132.

```typescript
const weekly = await tickets.aggregate({
  filter: { openedAt: { $gte: from, $lt: to } },
  controls: {
    $select: [
      { $bucket: "week", $field: "openedAt", $tz: "Europe/Berlin", $weekStart: "sun", $as: "week" },
      { $fn: "count", $field: "*", $as: "n" },
    ],
    $groupBy: ["week"],
    $sort: { week: 1 },
  },
});
// [{ week: "2026-03-01", n: 12 }, { week: "2026-03-08", n: 9 }, …]
```

Over HTTP the same query is:

```bash
curl "http://localhost:3000/tickets/query?openedAt>=1772323200000&\$select=bucket(openedAt,week,'Europe/Berlin',sun):week,count(*):n&\$groupBy=week&\$sort=week"
```

## The bucket entry

| Key          | Required | Values                                                                           | Default          |
| ------------ | -------- | -------------------------------------------------------------------------------- | ---------------- |
| `$bucket`    | yes      | `'day' \| 'week' \| 'month' \| 'quarter' \| 'year'`                              | —                |
| `$field`     | yes      | a `number.timestamp` field path                                                  | —                |
| `$tz`        | no       | a canonical IANA time zone (`'Europe/Berlin'`)                                   | `'UTC'`          |
| `$weekStart` | no       | `'mon' \| 'tue' \| 'wed' \| 'thu' \| 'fri' \| 'sat' \| 'sun'` — unit `week` only | `'mon'`          |
| `$as`        | no       | the output key                                                                   | `{unit}_{field}` |

The alias is how the rest of the query refers to the bucket:

- **`$groupBy` must list it** — a bucket in `$select` that is not in `$groupBy` is rejected.
- **`$sort`** orders by it; labels sort chronologically.
- **`$having`** filters on it, as a string: `{ week: { $gte: "2026-03-01" } }`.
- Group by several buckets, or a bucket plus plain fields: `$groupBy: ["week", "status"]`.

Buckets exist only in grouped queries. `findMany()` and `$select` without `$groupBy` reject them.

### URL form

In `$select`, write `bucket(field,unit[,tz][,weekStart])[:alias]`:

| URL entry                                  | Object entry                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `bucket(openedAt,day)`                     | `{ $bucket: "day", $field: "openedAt" }` — key `day_openedAt`              |
| `bucket(openedAt,month,'Europe/Berlin'):m` | `{ $bucket: "month", $field: "openedAt", $tz: "Europe/Berlin", $as: "m" }` |
| `bucket(openedAt,week,,sun):week`          | UTC weeks starting on Sunday (an empty zone slot means the default)        |

Quote the zone when it contains `/` (`'America/New_York'`); `UTC` may stay bare. Quote a label in `$having`, since it contains hyphens: `$having=week>='2026-03-01'`. The full grammar is on [URL Query Syntax](/http/query-syntax#projection-select).

## The label

Every bucket value is a string `YYYY-MM-DD`: **the local calendar date of the bucket's first day**, in the bucket's zone. The format is the same for every unit:

| Unit           | Label for a ticket opened on Sunday 2026-03-29, 14:00 in Berlin |
| -------------- | --------------------------------------------------------------- |
| `day`          | `2026-03-29`                                                    |
| `week` (`mon`) | `2026-03-23`                                                    |
| `week` (`sun`) | `2026-03-29`                                                    |
| `month`        | `2026-03-01`                                                    |
| `quarter`      | `2026-01-01`                                                    |
| `year`         | `2026-01-01`                                                    |

What follows from the contract:

- **Days are local.** An instant belongs to the day it falls on in `$tz`, DST included — `2026-03-29T23:30:00Z` is day `2026-03-30` in Berlin and `2026-03-29` in UTC.
- **Labels sort as strings.** `$sort` and `$having` comparisons need no date parsing.
- **A week label can fall in the previous month or year.** Monday-start week of 2027-01-01 is `2026-12-28`.
- **Quarters start in January, April, July and October.** Fiscal years are not supported.
- **`null` source → `null` label.** Rows whose timestamp is `null` or missing form one `null` group. So do instants outside the supported range, `1970-01-02T00:00:00Z` (inclusive) to `3000-01-01T00:00:00Z` (exclusive).

Result typing follows: the label is `string`, or `string | null` when the source field is optional.

## Time zones

- **IANA names only**, as listed by the Node.js runtime (`Intl.supportedValuesOf("timeZone")`), plus `UTC` and the `Etc/GMT±N` zones.
- **Case-insensitive and canonicalized:** `europe/berlin` is accepted as `Europe/Berlin`.
- **Aliases are rejected with a hint:** `US/Eastern` → `Time zone "US/Eastern" is an alias — use "America/New_York"`. The same goes for `Asia/Calcutta`, `Etc/UTC` and `CET`.
- **Offsets and abbreviations are rejected:** `+02:00`, `CEST`.

Each database resolves the zone with its own time zone data (see [Adapter notes](#adapter-notes)). Labels agree across adapters wherever those databases agree for the dates involved.

## Which fields can be bucketed

The source must be a field declared as a timestamp: `number.timestamp`, `number.timestamp.created` or `number.timestamp.updated`. No annotation opts a field in — the type is the declaration. The field must also:

- be a stored leaf — not inside a `@db.json` column or an array, on any adapter;
- not be `@db.encrypted` (`ENC_FIELD_AGG`) or, over HTTP, `@db.writeOnly`;
- be a dimension, when the table declares `@db.column.dimension` / `@db.column.measure` ([strict mode](./aggregation#dimensions-and-measures-strict-mode)).

A dotted source (`stats.firstSeenAt`) needs an explicit `$as`. An alias must look like an identifier (`^[A-Za-z_][A-Za-z0-9_]*$`), be unique in `$select`, and not equal a field name of the table.

## Discovering support through `/meta`

A UI can build its time-grouping controls from the table's [`/meta`](/http/crud#get-meta):

```json
{
  "bucketUnits": ["day", "week", "month", "quarter", "year"],
  "fields": {
    "openedAt": { "sortable": true, "filterable": true, "bucketable": true },
    "points": { "sortable": true, "filterable": true }
  }
}
```

- `bucketUnits` lists the units the adapter supports. It is omitted when there are none.
- `fields[path].bucketable: true` is present **exactly** when the server accepts a bucket over that field.

## Filling gaps

Groups exist only where rows exist, so a chart of weekly counts has holes for empty weeks. `@atscript/db-client` re-exports two helpers from `@uniqu/core` to fill them:

- `nextBucketLabel(label, unit, weekStart?)` — the label of the following bucket. Calendar arithmetic only; no time zone needed.
- `bucketStartInstant(label, tz)` — the first instant (epoch ms) of that local date, for a time axis. On a day whose midnight is skipped by DST, it returns the first instant that exists that day.

```typescript
import { nextBucketLabel } from "@atscript/db-client";

const counts = new Map(weekly.map((row) => [row.week, row.n]));
const series = [];
for (
  let week = weekly[0].week;
  week <= weekly[weekly.length - 1].week;
  week = nextBucketLabel(week, "week", "sun")
) {
  series.push({ week, n: counts.get(week) ?? 0 });
}
```

Pass the same unit and week start the query used.

## Performance

A bucket is an expression over the timestamp, so grouping by it cannot use an index. Always bound the scan with a range filter on the **raw timestamp**, which can:

```typescript
filter: { openedAt: { $gte: Date.parse("2026-01-01T00:00:00+01:00"), $lt: Date.parse("2026-04-01T00:00:00+02:00") } }
```

Don't filter on the label with `$having` to restrict the period — `$having` runs after every row has been grouped.

## Errors

| Situation                                                                                                                          | Error                   | HTTP |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---- |
| Unknown unit, week start or zone; alias zone; `$weekStart` with a unit other than `week`                                           | `INVALID_QUERY`         | 400  |
| Bucket outside a grouped query, missing from `$groupBy`, duplicate alias, alias equal to a field name, dotted source without `$as` | `INVALID_QUERY`         | 400  |
| Source is not a timestamp field, sits inside a JSON column, or is not a dimension in strict mode                                   | `INVALID_QUERY`         | 400  |
| Source is `@db.encrypted`                                                                                                          | `ENC_FIELD_AGG`         | 400  |
| The adapter does not support the unit                                                                                              | `BUCKET_NOT_SUPPORTED`  | 400  |
| The database cannot resolve the zone (MySQL time zone tables not loaded, or a zone newer than the server's tz data)                | `BUCKET_TZ_UNAVAILABLE` | 501  |

Programmatic calls throw `DbError` with these codes. Over HTTP the query rules report `path: "$select"` or `"$groupBy"`, and the field rules report the field — for example `Bucketing field "points" is not permitted — not a timestamp field (declare it number.timestamp).` The other endings are `— not a dimension.` and `— adapter has no calendar buckets.`

`BUCKET_TZ_UNAVAILABLE` is a server configuration problem, not a bad request: the zone name was valid, but the database could not convert to it. No adapter falls back to UTC or returns `null` labels silently.

## Adapter notes

All five adapters support all five units.

| Adapter    | Requirement                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | None. Independent of the session time zone. See [PostgreSQL — Calendar buckets](/adapters/postgresql#calendar-buckets).                                                     |
| MySQL      | Time zone tables loaded for any zone other than UTC; MySQL 8.0.28 or later (64-bit) for dates after 2038. See [MySQL — Calendar buckets](/adapters/mysql#calendar-buckets). |
| SQLite     | A driver with the `registerFunction` hook — `BetterSqlite3Driver` has it. See [SQLite — Calendar buckets](/adapters/sqlite#calendar-buckets).                               |
| MongoDB    | MongoDB 4.0 or later. See [MongoDB — Calendar buckets](/adapters/mongodb#calendar-buckets).                                                                                 |
| Memory     | None — computed in process. See [Memory — Grouped queries](/adapters/memory#grouped-queries).                                                                               |

Each engine uses its own time zone data: PostgreSQL its tzdata, MySQL its `mysql.time_zone*` tables, MongoDB its bundled database, SQLite and memory the Node.js runtime's ICU data. If they are at different tzdata releases, labels near midnight can differ for dates affected by the changes between those releases. Keep the database's time zone data current.

## See also

- [Grouped Queries](./aggregation) — `aggregate()`, aggregate functions, strict mode
- [Aggregation in URLs](/http/advanced#groupby) — grouped queries over HTTP
- [HTTP Client — aggregate](/http/client#aggregate) — typed results and label helpers
- [Creating Custom Adapters — Calendar buckets](/adapters/creating-adapters#calendar-buckets) — supporting buckets in your own adapter
