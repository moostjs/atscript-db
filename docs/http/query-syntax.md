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
A bare value may contain letters, digits, `_`, `.`, percent-encoded spaces and — since 0.1.147 — hyphens between word characters (`status=in-progress`, `date=2026-01-01`) and an hour label or date-time of the exact shape `2026-03-29T14:00` (optionally `:SS`). Anything else — a leading or trailing hyphen, `/`, other `:` forms, `@`, … — must be wrapped in single quotes: `?name='a/b'` (`%27a%2Fb%27` when the client encodes). `buildUrl` / the client keep quoting such values. A query string the grammar cannot parse is rejected with **HTTP 400** and the validation envelope `{ "statusCode": 400, "message": "Malformed query string: …", "errors": [{ "path": "", "message": "…" }] }` (since 0.1.128 — earlier versions failed with a 500). This applies to every read endpoint (`/query`, `/pages`, `/geo`, `/one`, value help) and to values inside `$with=…(…)` sub-filters.
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

An **empty** set follows the usual semantics: `f{}` matches nothing, `f!{}` excludes nothing (matches every row), and `!(f{})` matches every row. The same holds on every adapter.

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

The pattern follows `/pattern/flags` format. Common flags include `i` (case-insensitive). On an integer field `~=` matches the number's decimal text (`refNo~=/^29/` finds `29461277`); floats, decimals and timestamps are rejected with 400.

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
| Navigation property (`@db.rel.to` / `.from` / `.via`) | 400 at the root — filter by it with [`assignee=$some(name=x)`](#relational-predicates), or load it with `$with=assignee(...)` (`$with=assignee($select=name)`, `$with=assignee(name=x)`).             |

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

## Relational Predicates ($some / $none) {#relational-predicates}

Since 0.1.147. Filter rows by their related rows — the URL form of [`$some` / `$none`](/api/queries#relational-filters). The relation must opt in with [`@db.rel.filterable`](/relations/navigation#db-rel-filterable):

```bash
# Issues whose ticket is open and belongs to team t1 or t2
curl "http://localhost:3000/issues/query?ticket=\$some(teamId{t1,t2}&status=open)"

# Issues without a ticket / with any ticket
curl "http://localhost:3000/issues/query?ticket=\$none()"
curl "http://localhost:3000/issues/query?ticket=\$some()"

# Two hops: the ticket's team is named Core
curl "http://localhost:3000/issues/query?ticket=\$some(team=\$some(name=Core))"
```

| Form                          | Meaning                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `rel=$some(<filter>)`         | at least one related row matches `<filter>`                                    |
| `rel=$none(<filter>)`         | no related row matches                                                         |
| `rel=$some()` / `rel=$none()` | has any / has no related row                                                   |
| `!(rel=$some(…))`             | negation — same as `$none`; `rel!=$some(…)` is a syntax error (400)            |
| `rel=$some(a=1^b=2)`          | the body is a full filter: `&`, `^`, `!( )`, groups and nested predicates work |

- Inside the body, field names are the **related table's** paths (`status`, not `ticket.status`); `&` inside the parentheses does not split the query string.
- Predicates combine with other conditions like any term: `status=new&ticket=$some(status=open)`, `(ticket=$none()^priority>3)`.
- They also work inside `$with` bodies, on the related table's relations: `$with=tickets(issues=$some(title~=/crash/i))` loads, for each team, only the tickets with a crash issue.
- A dotted navigation path (`ticket.status=open`) stays a 400 whose message suggests `ticket=$some(status=…)` (requires `@db.rel.filterable`) or `$with=ticket(...)`.
- Valid on `/query` (incl. `$count` and `$groupBy`), `/pages`, `/geo`, and in `$with` bodies of `/one`. A predicate never identifies a row: `/one?…` and `DELETE /?…` with one answer `400 Query params do not match any primary key or unique index`. `$having` never accepts one.

What the server checks — opt-in, visibility, the related table's field rules, limits — and the exact 400 messages are on [Permissions § Relational predicates](./permissions#relational-predicates).

## Control Parameters

Special `$`-prefixed parameters configure query behavior rather than filtering data.

### Sorting ($sort)

Order results by one or more fields:

```bash
curl "http://localhost:3000/todos/query?\$sort=name"                # ascending
curl "http://localhost:3000/todos/query?\$sort=-createdAt"           # descending
curl "http://localhost:3000/todos/query?\$sort=status,-priority"     # multi-field
```

Prefix a field with `-` for descending order. Rows that tie on every `$sort` field come back in primary-key order, in the direction of the last field, so pages never overlap. See [Ties and the primary-key tie-breaker](/api/queries#tie-breaker).

#### NULL placement (`:first`, `:last`) {#sort-nulls}

Since 0.1.153, a `:first` or `:last` suffix on a sort field places `null` / missing values before or after every value, in either direction:

```bash
curl "http://localhost:3000/tickets/query?\$sort=-closedAt:last,title"   # open tickets at the end
curl "http://localhost:3000/tickets/pages?\$sort=assignee:first&\$size=20"
```

The suffix becomes the `$nulls` control ([NULL placement](/api/queries#nulls)); without it, placement follows the field's `@db.sort.nulls` default, else the engine. It works in `$sort`, `$order`, `$rowOrder` and in `$with` sub-queries (`$with=comments($sort=-editedAt:last)`). `$nulls` is not a URL parameter of its own (`$nulls=…` is a 400), and any other suffix is a 400. The field must be sortable like any `$sort` field. `/meta.nullsPlacement` is `true` when the adapter supports it.

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

Pages are 1-based. Without `$sort`, `/pages` reads in primary-key order, ascending (since 0.1.153), so page 2 continues exactly where page 1 ended. `$search` / `$vector` requests keep their relevance order, and a view without `@meta.id` stays unordered. `/query` without `$sort` imposes no order.

### Projection ($select)

Control which fields are returned:

```bash
curl "http://localhost:3000/todos/query?\$select=id,title,status"         # include only
curl "http://localhost:3000/todos/query?\$select=-password,-secret"       # exclude only
```

**Include mode** returns only the listed fields. **Exclude mode** (prefix with `-`) returns all fields except the listed ones.

::: warning Avoid mixed mode
A controller may also declare display-only columns ([`@DbDecorations`](./customization#declared-decorations), since 0.1.148): `$select` can name them like fields (`$select=title,ownerName`), they are served without a `$select`, and they cannot be used in a filter, `$sort`, `$groupBy`, `$having` or an aggregate. `/meta.fields[key].decoration` is `true` for each.

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

| Entry                                 | Meaning                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fn(field)` / `count(*)`              | Aggregate — `count`, `sum`, `avg`, `min`, `max`, `countDistinct` (`countDistinct(*)` is a 400), `first`, `last` (since 0.1.148, read a field of the row `$rowOrder` picks). Default key `fn_field`; `count(*)` → `count_star`. [`/meta.aggregateFns`](./crud#get-meta) lists what the adapter supports |
| `expr(<arith>):alias`                 | Group-level [arithmetic](/api/aggregation#arithmetic-expressions) over aliases and numeric `$groupBy` fields (since 0.1.148). `:alias` is required                                                                                                                                                     |
| `sum(<arith>):alias`                  | Row-level arithmetic aggregated per group — also `avg`, `min`, `max` (since 0.1.148). Used when the argument is neither a field nor `*`. `:alias` is required                                                                                                                                          |
| `bucket(field,unit[,tz][,weekStart])` | [Calendar bucket](/api/calendar-buckets) (since 0.1.132). Default key `unit_field`                                                                                                                                                                                                                     |

```bash
curl "http://localhost:3000/tickets/query?\$select=status,bucket(openedAt,month,'Europe/Berlin'):month,count(*):n&\$groupBy=status,month&\$having=month>='2026-01-01'"
```

Arithmetic and `$rowOrder` (since 0.1.148):

```bash
curl "http://localhost:3000/issues/query?status=open&\$groupBy=ticketId&\$select=ticketId,count(*):n,sum(price*qty):revenue,expr(revenue/n):avg,first(title):oldest&\$rowOrder=raisedAt&\$sort=-avg"
```

- `<arith>` is `+ - * /`, unary `-`, parentheses, number literals, names and `coalesce(a,b,…)`. **Write `+` as `%2B`** (`expr(n%2B1):m`): an unescaped `+` that a proxy or framework decodes to a space becomes `n 1`, which is rejected (`missing operator`) rather than read as something else. A raw `+` that reaches moost-db is accepted too.
- `$rowOrder=raisedAt,-id` is parsed like `$sort` (`:first` / `:last` included) and orders the rows inside each group for `first` / `last`; it is rejected without them. See [Representative row](/api/aggregation#representative-row-first-last).
- A computed `$select` item that matches none of these forms is now a malformed query string (400); older versions silently dropped it.

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

| Parameter    | Type    | Endpoints         | Default | Example                       |
| ------------ | ------- | ----------------- | ------- | ----------------------------- |
| `$sort`      | string  | query, pages      | —       | `$sort=-createdAt:last,title` |
| `$skip`      | number  | query             | `0`     | `$skip=20`                    |
| `$limit`     | number  | query             | `1000`  | `$limit=50`                   |
| `$page`      | number  | pages             | `1`     | `$page=3`                     |
| `$size`      | number  | pages             | `10`    | `$size=25`                    |
| `$select`    | string  | query, pages, one | —       | `$select=id,title`            |
| `$count`     | boolean | query             | —       | `$count`                      |
| `$search`    | string  | query, pages      | —       | `$search=mongodb tutorial`    |
| `$index`     | string  | query, pages      | —       | `$index=product_search`       |
| `$fuzzy`     | string  | query, pages      | —       | `$fuzzy=1`                    |
| `$vector`    | string  | query, pages      | —       | `$vector=embedding`           |
| `$threshold` | string  | query, pages      | —       | `$threshold=0.8`              |
| `$with`      | string  | query, pages, one | —       | `$with=author,comments`       |
| `$groupBy`   | string  | query             | —       | `$groupBy=status`             |
| `$having`    | string  | query             | —       | `$having=total>100`           |

See [Relations & Search in URLs](./advanced) for details on `$with`, `$search`, `$fuzzy`, `$vector`, and `$groupBy`.

## Type Coercion

A URL value gets its type from how it is written, not from your `.as` schema:

- **Numbers** — an unquoted number is a number: `priority=3` is `3`. Quoted, it is a string: `priority='3'` is `"3"`
- **Booleans** — `completed=true` is `true`, `completed=false` is `false`
- **Null** — `assigneeId=null` is `null`
- **Strings** — any other value, bare or quoted: `status=active`, `name='json-w1'`
- **Arrays** — `field{a,b,c}` is a list of values, each typed the same way

The server then checks every value against the field's type (since 0.1.147, see [Value Types](/api/queries#value-types)). A value that cannot stand for it is a **400** naming the field — `priority=high` or `priority>=abc` on a number, `completed=yes` on a boolean — on every adapter:

```json
{
  "statusCode": 400,
  "message": "Invalid filter value for \"priority\": expected a number, got \"high\"",
  "errors": [
    {
      "path": "priority",
      "message": "Invalid filter value for \"priority\": expected a number, got \"high\""
    }
  ]
}
```

- A quoted number on a number field (`priority='3'`) and an unquoted one on a string field (`code=123`) are accepted. MongoDB and the memory adapter compare types strictly, so they match only the form that fits the field — write numbers bare and quote numeric strings.
- Timestamps (`number.timestamp`) take epoch milliseconds: `createdAt>=1767225600000`. An ISO date (`createdAt>='2026-01-01'`) is a 400.
- Integer fields (`number.int`, timestamps, auto-increment ids, a view's count column) take whole numbers: `qty>5.5` is a 400.
- Boolean fields take `true`, `false`, `0` or `1`.

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

**Filter by related rows** — open issues whose ticket belongs to team `t1`, with the ticket loaded:

```bash
curl "http://localhost:3000/issues/query?status=open&ticket=\$some(teamId=t1)&\$with=ticket(\$select=key,status)"
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
