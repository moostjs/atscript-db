---
outline: deep
---

# URL Query Syntax

The HTTP controllers accept a rich URL query syntax for filtering, sorting, pagination, and projection — powered by [`@uniqu/url`](https://github.com/moostjs/uniqu). Filters and controls are encoded directly into the query string using a compact, expressive format that all [database adapters](/adapters/) understand.

## How It Works

URL query strings are parsed into three components:

1. **filter** — field conditions (equality, comparison, logical operators)
2. **controls** — `$`-prefixed parameters (`$sort`, `$limit`, `$select`, etc.)
3. **insights** — field usage metadata (for validation and access control)

The parsed query is then executed identically by any adapter.

## Filter Operators

### Equality

Match a field against an exact value:

```bash
curl "http://localhost:3000/todos/query?status=active"
curl "http://localhost:3000/todos/query?status=active&priority=high"
```

Multiple conditions are combined with AND by default.

::: warning Quote values that contain reserved characters
A bare value may only contain letters, digits, `_`, `.` and percent-encoded spaces. Anything else — a hyphen (`name=json-w1`, `date=2026-01-01`), `/`, `:`, `@`, … — must be wrapped in single quotes: `?name='json-w1'` (`%27json-w1%27` when the client encodes). A query string the grammar cannot parse is rejected with **HTTP 400** and the validation envelope `{ "statusCode": 400, "message": "Malformed query string: …", "errors": [{ "path": "", "message": "…" }] }` (since 0.1.128 — earlier versions failed with a 500). This applies to every read endpoint (`/query`, `/pages`, `/geo`, `/one`, value help) and to values inside `$with=…(…)` sub-filters.
:::

### Not Equal

```bash
curl "http://localhost:3000/todos/query?status!=done"
```

### Comparison Operators

```bash
curl "http://localhost:3000/todos/query?priority>3"       # greater than
curl "http://localhost:3000/todos/query?priority>=3"      # greater than or equal
curl "http://localhost:3000/todos/query?priority<5"       # less than
curl "http://localhost:3000/todos/query?priority<=5"      # less than or equal
```

These work with numeric fields, dates, and any comparable type supported by the adapter.

### Set Operators (IN / NOT IN)

Match against a set of values using curly braces:

```bash
curl "http://localhost:3000/todos/query?role{Admin,Editor}"      # IN
curl "http://localhost:3000/todos/query?status!{Draft,Deleted}"  # NOT IN
```

The IN operator matches records where the field equals any value in the comma-separated list.

### Range (Between)

Filter a field within a range:

```bash
curl "http://localhost:3000/todos/query?25<age<35"       # exclusive
curl "http://localhost:3000/todos/query?25<=age<=35"     # inclusive
```

Mix `<` and `<=` as needed (e.g., `25<=age<35`).

### Pattern Matching (Regex)

Match a field against a regular expression:

```bash
curl "http://localhost:3000/todos/query?name~=/^Al/i"
```

The pattern follows `/pattern/flags` format. Common flags include `i` (case-insensitive).

::: info Adapter differences
MongoDB supports full PCRE regex. SQLite uses `LIKE`-based approximation for simple patterns.
:::

### Existence

Check whether fields hold a value — a missing field and an explicit `null` both count as absent, on every adapter:

```bash
curl "http://localhost:3000/todos/query?\$exists=email,phone"    # both hold a value
curl "http://localhost:3000/todos/query?\$!exists=deletedAt"     # null or missing
```

Since 0.1.132 `$exists` is also accepted on `@db.json` object and array columns on SQL adapters, where every other operator is rejected (`/meta` then lists `filterOps: ["$exists"]` for the field). See [Existence](../api/queries#existence) for the full rules.

### Null Values

Explicitly match null:

```bash
curl "http://localhost:3000/todos/query?assigneeId=null"
```

The literal `null` is parsed as a null value, not the string `"null"`.

### Nested Fields

Reference fields inside embedded objects with **dot notation** — the same logical path you would use in a programmatic filter:

```bash
curl "http://localhost:3000/users/query?contact.email=alice@example.com"
curl "http://localhost:3000/users/query?address.city=Berlin&address.country=DE"
```

The path uses the `.as` interface's logical property names, never physical column names (`contact__email` is rejected). The same dot-notation applies to `$select`, `$sort`, `$groupBy`, and `$with` sub-controls. Which dotted paths exist depends on how the parent is stored (since 0.1.128 the server enforces this instead of failing inside the database):

| Parent                                                | `contact.email`-style paths                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flattened object (default for nested objects)         | Real columns on every adapter — filter, `$sort`, `$select`, `$groupBy` all work; grouped keys are returned nested, e.g. `{ stats: { views } }` (since 0.1.128). The parent itself is only selectable. |
| `@db.json` object / array of objects                  | MongoDB and memory: native dotted paths, listed in `/meta.fields`. SQL adapters: **HTTP 400** — select the parent instead.                                                                            |
| `@db.encrypted` object                                | 400 on every adapter (ciphertext) — select the encrypted parent.                                                                                                                                      |
| Navigation property (`@db.rel.to` / `.from` / `.via`) | 400 at the root — use `$with=assignee(...)` (`$with=assignee($select=name)`, `$with=assignee(name=x)`).                                                                                               |

Rejections carry the envelope `{ "statusCode": 400, "message": "...", "errors": [{ "path": "<the path>", "message": "..." }] }`.

## Logical Operators

### AND

Multiple conditions are ANDed by default. Use `&` for explicit AND:

```bash
curl "http://localhost:3000/todos/query?status=todo&priority=high"
```

### OR

Use `^` for OR:

```bash
curl "http://localhost:3000/todos/query?status=done^priority=low"
```

### NOT

Use `!` to negate:

```bash
curl "http://localhost:3000/todos/query?!(status=done)"
```

### Grouping

Use parentheses to control precedence:

```bash
curl "http://localhost:3000/todos/query?(status=todo^status=in_progress)&priority=high"
```

**Operator precedence:** `&` (AND) binds tighter than `^` (OR). This means:

```
status=done^priority=high&role=admin
```

is interpreted as:

```
status=done  OR  (priority=high AND role=admin)
```

Use parentheses to override default precedence.

## Control Parameters

Special `$`-prefixed parameters configure query behavior rather than filtering data.

### Sorting ($sort)

Order results by one or more fields:

```bash
curl "http://localhost:3000/todos/query?\$sort=name"                # ascending
curl "http://localhost:3000/todos/query?\$sort=-createdAt"           # descending
curl "http://localhost:3000/todos/query?\$sort=status,-priority"     # multi-field
```

Prefix a field with `-` for descending order.

### Offset Pagination ($limit, $skip)

For `GET /query` — use `$limit` and `$skip`:

```bash
curl "http://localhost:3000/todos/query?\$limit=20&\$skip=40"
```

### Page Pagination ($page, $size)

For `GET /pages` — use `$page` and `$size`:

```bash
curl "http://localhost:3000/todos/pages?\$page=2&\$size=10"
```

Pages are 1-based.

### Projection ($select)

Control which fields are returned:

```bash
curl "http://localhost:3000/todos/query?\$select=id,title,status"         # include only
curl "http://localhost:3000/todos/query?\$select=-password,-secret"       # exclude only
```

**Include mode** returns only the listed fields. **Exclude mode** (prefix with `-`) returns all fields except the listed ones.

::: warning Avoid mixed mode
Mixing includes and excludes (e.g., `$select=name,-password`) produces unpredictable results depending on the adapter. Use either include-only or exclude-only.
:::

Every `$select` entry is validated before the read (since 0.1.128, on `/query`, `/pages`, `/geo`, `/one/:id` and `/one?…`):

| `$select` entry                               | Result                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| listed field (`title`, `contact.email`)       | ok                                                                        |
| flattened object parent (`contact`)           | ok — expands to its leaf columns                                          |
| JSON parent (`prefs`)                         | ok — the whole value                                                      |
| JSON descendant (`prefs.theme`)               | MongoDB / memory: ok; SQL adapters: 400                                   |
| `@db.writeOnly` field                         | accepted, then silently stripped — sealed values never leave the database |
| encrypted descendant (`credentials.user`)     | 400 — select `credentials`                                                |
| navigation path at the root (`assignee.name`) | 400 — use `$with=assignee($select=name)`                                  |
| unknown field                                 | 400 `Unknown field "…"`                                                   |

#### Computed entries (grouped queries)

With [`$groupBy`](./advanced#groupby), `$select` also takes computed entries, each with an optional `:alias`:

| Entry                                 | Meaning                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `fn(field)` / `count(*)`              | Aggregate — `count`, `sum`, `avg`, `min`, `max`. Default key `fn_field`; `count(*)` → `count_star` |
| `bucket(field,unit[,tz][,weekStart])` | [Calendar bucket](/api/calendar-buckets) (since 0.1.132). Default key `unit_field`                 |

```bash
curl "http://localhost:3000/tickets/query?\$select=status,bucket(openedAt,month,'Europe/Berlin'):month,count(*):n&\$groupBy=status,month&\$having=month>='2026-01-01'"
```

`bucket()` grammar:

- `unit` is `day`, `week`, `month`, `quarter` or `year`; `weekStart` (`mon` … `sun`) is valid only with `week`.
- Quote the zone when it contains `/` (`'America/New_York'`); `UTC` may be bare. An empty slot keeps the default zone: `bucket(openedAt,week,,sun)`.
- A dotted field (`stats.firstSeenAt`) needs an explicit `:alias`.
- `bucket` is a reserved name. A missing field or unit, a one-argument `bucket(x)` or more than four arguments is a malformed query string (400). An unknown unit, zone or week start parses, then fails validation with 400 and a message naming the problem.
- Compare a label in `$having` as a quoted string — `$having=month>='2026-01-01'`.

### Count ($count)

Return only the count of matching records:

```bash
curl "http://localhost:3000/todos/query?completed=true&\$count"
```

Returns a plain number (e.g., `5`) instead of an array.

## Complete Parameter Reference

| Parameter    | Type    | Endpoints         | Default | Example                    |
| ------------ | ------- | ----------------- | ------- | -------------------------- |
| `$sort`      | string  | query, pages      | —       | `$sort=-createdAt,title`   |
| `$skip`      | number  | query             | `0`     | `$skip=20`                 |
| `$limit`     | number  | query             | `1000`  | `$limit=50`                |
| `$page`      | number  | pages             | `1`     | `$page=3`                  |
| `$size`      | number  | pages             | `10`    | `$size=25`                 |
| `$select`    | string  | query, pages, one | —       | `$select=id,title`         |
| `$count`     | boolean | query             | —       | `$count`                   |
| `$search`    | string  | query, pages      | —       | `$search=mongodb tutorial` |
| `$index`     | string  | query, pages      | —       | `$index=product_search`    |
| `$fuzzy`     | string  | query, pages      | —       | `$fuzzy=1`                 |
| `$vector`    | string  | query, pages      | —       | `$vector=embedding`        |
| `$threshold` | string  | query, pages      | —       | `$threshold=0.8`           |
| `$with`      | string  | query, pages, one | —       | `$with=author,comments`    |
| `$groupBy`   | string  | query             | —       | `$groupBy=status`          |
| `$having`    | string  | query             | —       | `$having=total>100`        |

See [Relations & Search in URLs](./advanced) for details on `$with`, `$search`, `$fuzzy`, `$vector`, and `$groupBy`.

## Type Coercion

URL values are always strings, but the query parser coerces them based on your `.as` schema:

- **Numbers** — `priority=3` becomes the number `3`, not the string `"3"`
- **Booleans** — `completed=true` becomes `true`, `completed=false` becomes `false`
- **Null** — `assigneeId=null` becomes `null`
- **Arrays** — `field{a,b,c}` becomes an array of values

Coercion is automatic and consistent across adapters.

## Comprehensive Examples

**Simple filtered list** — active items sorted by recency:

```bash
curl "http://localhost:3000/todos/query?status=active&\$sort=-createdAt&\$limit=10"
```

**Paginated search** — full-text search with page-based pagination:

```bash
curl "http://localhost:3000/todos/pages?\$search=typescript&\$page=1&\$size=20"
```

**Complex filtered with relations** — high-priority incomplete tasks with projection and relations:

```bash
curl "http://localhost:3000/todos/query?status!=done&priority>=3&\$select=id,title,status&\$with=assignee,tags&\$sort=-priority,title&\$limit=50"
```

**Nested relation loading** — projects with comments and their authors:

```bash
curl "http://localhost:3000/todos/query?\$with=project(\$select=id,title),comments(\$sort=-createdAt&\$limit=5&\$with=author(\$select=name))"
```

**Count with filter:**

```bash
curl "http://localhost:3000/todos/query?completed=true&\$count"
```

**Excluding sensitive fields:**

```bash
curl "http://localhost:3000/users/query?\$select=-password,-secret,-internalNotes"
```

## Next Steps

- [Relations & Search in URLs](./advanced) — `$with`, `$search`, `$vector`, `$groupBy` details
- [Queries & Filters](/api/queries) — Programmatic query API (non-HTTP)
- [CRUD Endpoints](./crud) — Endpoint reference
