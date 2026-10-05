# http-query-syntax

URL query strings accepted by `/query`, `/pages`, and `/one`. Parsed by `@uniqu/url` into `Uniquery`, then executed identically by every adapter. Canonical doc: `docs/http/query-syntax.md`.

Three components:

- **filter** — field conditions (no `$`-prefix).
- **controls** — `$`-prefixed keys (`$sort`, `$select`, `$limit`, `$with`, …).
- **insights** — set automatically from the parse.

## Equality / inequality

```
?status=active                        # AND (implicit when multiple)
?status=active&priority=high          # explicit AND
?status!=done
```

## Comparison

```
?priority>3    ?priority>=3    ?priority<5    ?priority<=5
```

## Set (IN / NOT IN)

```
?role{admin,editor}        # IN — comma INSIDE {…} is structural
?status!{draft,deleted}    # NOT IN
?f{}                       # EMPTY set: IN matches nothing
?f!{}                      # EMPTY set: NOT IN excludes nothing; !(f{}) matches all
```

## Range

```
?25<age<35          # exclusive
?25<=age<=35        # inclusive
?age>=18&age<=65    # two conditions — use `&` (AND) at top level, not comma
```

## Pattern / regex

Only `~=` regex form. No `*` wildcard in URL grammar — use regex anchors:

```
?name~=/^Al/i       # regex with flags
?slug~=/^foo-/      # prefix (use ^ anchor)
?slug~=/-v2$/       # suffix (use $ anchor)
```

## Null

```
?deletedAt=null
?deletedAt!=null
```

## $exists / $!exists controls

`$`-prefixed; field list is comma-separated. NOT a filter operator — they are controls.

```
?$exists=phone,email     # phone AND email both hold a value
?$!exists=deletedAt      # deletedAt is null or missing
```

Semantics (null ≡ absent on every adapter, boolean-only, sole-operator rule on JSON columns) → [queries.md § `$exists`](queries.md). The one filter a SQL JSON / array column accepts (`/meta` → `filterOps: ["$exists"]`, since 0.1.132).

## Logical operators

| Op   | Meaning | Example                                          |
| ---- | ------- | ------------------------------------------------ |
| `&`  | AND     | `?status=open&priority=high`                     |
| `^`  | OR      | `?status=done^priority=low`                      |
| `!`  | NOT     | `?!(status=done)` — wrap expression in `(…)`     |
| `()` | group   | `?(role=admin^createdAt>2026-01-01)&active=true` |

**Precedence:** `&` binds tighter than `^`. So `status=done^priority=high&role=admin` parses as `status=done OR (priority=high AND role=admin)`. Use `(…)` to override.

## Nested field paths

Dot notation addresses embedded / flattened own-props. A nav-prop path is a 400 (since 0.1.128) — filter by a relation with a predicate (below), load it with `$with`.

```
?contact.email=a@e.com             # embedded / flattened own-prop
?author.name=Alice                 # 400 — navigation path
?author=$some(name=Alice)          # rows whose author is named Alice (needs @db.rel.filterable)
```

## Relational predicates — `$some` / `$none` (0.1.147)

```
?ticket=$some(teamId{t1,t2}&status=open)     # some related row matches
?ticket=$none(status=open)                   # no related row matches (NULL FK rows included)
?ticket=$some()  /  ?ticket=$none()          # has any / has none
?ticket=$some(team=$some(name=Core))         # nested, one relation per level
?!(ticket=$some(status=open))                # negation (same as $none)
?$with=tickets(issues=$some(title~=/crash/i)) # inside $with bodies
```

| #   | Rule                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Body = full filter grammar of the RELATED table (`&`, `^`, `!( )`, groups, nested predicates); field names unprefixed (`status`, not `ticket.status`). `&` inside `( )` doesn't split. |
| 2   | `ticket!=$some(…)` → SyntaxError 400 — negate with `!( )` or use `$none`.                                                                                                              |
| 3   | Relation must be `@db.rel.filterable`, visible, with filterable operand fields → else 400 (messages: [moost-db.md](moost-db.md#relational-predicates-over-http-01147)).                |
| 4   | Endpoints: `/query` (incl. `$count`, `$groupBy`), `/pages`, `/geo`, `$with` bodies (incl. `/one`). Never `$having`; never an identification (`/one?…`, `DELETE /?…` → 400).            |
| 5   | Caps per request (client predicates only): depth 3 per chain, 8 predicates total incl. `$with` sub-filters.                                                                            |
| 6   | Insights record `ticket` → `$some`, inner terms prefixed (`ticket.status` → `$eq`).                                                                                                    |

Semantics (NULL FK, `$every` = `$none: { $not: F }`) → [queries.md](queries.md#relational-predicates--some--none-01147).

## Controls

| Key            | Syntax                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$sort`        | `$sort=field,-field2`                                               | Leading `-` = DESC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `$select`      | `$select=id,name,author.name`                                       | Include-list (paths). See § Read-response baseline below. With `$groupBy` also `fn(field)[:alias]` — `sum`/`count`/`avg`/`min`/`max`/`countDistinct`/`first`/`last` (`countDistinct(*)` → 400; `/meta.aggregateFns` = what the adapter supports) (`count(*)` → key `count_star`), `expr(<arith>):alias` and `sum\|avg\|min\|max(<arith>):alias` (alias required; write `+` as `%2B`; 0.1.148 — [aggregation.md](aggregation.md)) and `bucket(field,unit[,tz][,weekStart])[:alias]` — see § Grouped queries. |
| `$skip`        | `$skip=20`                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `$limit`       | `$limit=10`                                                         | **Defaults to `1000` when absent** on `/query` (`as-db-readable.controller.ts:596`).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `$page`        | `$page=2`                                                           | `/pages` only. 1-based. Default `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `$size`        | `$size=20`                                                          | `/pages` only. Default `10`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `$count`       | `$count=1`                                                          | Returns a number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `$with`        | `$with=author,comments`                                             | Load nav relations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `$with`        | `$with=author($select=id,name),comments($sort=-createdAt&$limit=5)` | Sub-query per relation — same URL grammar recursively (filter + `$`-controls, incl. nested `$with`).                                                                                                                                                                                                                                                                                                                                                                                                        |
| `$groupBy`     | `$groupBy=category,region`                                          | Aggregate query. Fields or bucket aliases. Semantics → [aggregation.md](aggregation.md).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `$rowOrder`    | `$rowOrder=raisedAt,-id`                                            | Grouped queries (0.1.148): orders the rows inside each group for `first(f)` / `last(f)`; parsed like `$sort`; rejected without first/last. A computed `$select` item that matches no form is now a 400 (was silently dropped).                                                                                                                                                                                                                                                                              |
| `$search`      | `$search=quick+brown`                                               | FTS — adapter must support (or the `@db.column.searchable` fallback). Composes with `$groupBy`: rows are narrowed BEFORE grouping, so the rollup and its `$count` cover exactly what the leaf list returns. See [aggregation.md](aggregation.md#search-on-an-aggregate-query-since-01130).                                                                                                                                                                                                                  |
| `$index`       | `$index=product_search`                                             | Pick a specific FTS/vector index by name. Pairs with `$search` / `$vector`. The blessed way to choose a search **variant** (e.g. exact vs typeahead) — define one index per behavior.                                                                                                                                                                                                                                                                                                                       |
| `$fuzzy`       | `$fuzzy=1`                                                          | Mongo Atlas only: per-request typo tolerance override (`1`/`2`; `0` disables). Defaults to the index's declared `fuzzy`.                                                                                                                                                                                                                                                                                                                                                                                    |
| `$vector`      | `$vector=embed-this-text`                                           | Controller's `computeEmbedding()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `$threshold`   | `$threshold=0.8`                                                    | Vector similarity cutoff (adapter-specific).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `$center`      | `$center=-122.42,37.77`                                             | `GET /geo` only (required there). `lng,lat` — longitude FIRST. See [geo-search.md](geo-search.md).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `$maxDistance` | `$maxDistance=50000`                                                | `GET /geo` only. Meters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `$minDistance` | `$minDistance=1000`                                                 | `GET /geo` only. Meters (ring queries).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `$exists`      | `$exists=phone,email`                                               | All listed fields must hold a value (AND).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `$!exists`     | `$!exists=deletedAt`                                                | All listed fields must be null / missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `$actions`     | `$actions=true` (or `1`)                                            | Augment each row with `$actions: string[]` — server-evaluated row/rows-level action availability. Stripped on `$count` / `$groupBy`. See [actions.md](actions.md#actionstrue--server-evaluated-row-availability).                                                                                                                                                                                                                                                                                           |

## Examples

List open tasks, newest first, with author name:

```
GET /tasks/query?status=open&$sort=-createdAt&$with=author($select=name)
```

Paged users in two roles, case-insensitive name prefix:

```
GET /users/pages?role{admin,editor}&name~=/^al/i&$page=1&$size=25
```

Aggregate: revenue by category where status = paid:

```
GET /orders/query?status=paid&$groupBy=category&$select=category,sum(amount):total,count(*):n&$having=total>100
```

## Grouped queries — `bucket()` (since 0.1.132)

```
GET /tickets/query?$select=bucket(openedAt,week,'Europe/Berlin',sun):week,status,count(*):n&$groupBy=week,status&$having=week>='2026-03-01'&$sort=week
```

| #   | Rule                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `bucket(field,unit[,tz][,weekStart])[:alias]`; default alias `unit_field`; dotted field needs `:alias`. The alias must be listed in `$groupBy`.                                             |
| 2   | Quote a zone containing `/` (`'America/New_York'`); bare `UTC` ok; empty slot = default zone: `bucket(openedAt,week,,sun)`.                                                                 |
| 3   | `bucket` is reserved (never a custom aggregate). Missing field/unit, one argument, > 4 arguments → 400 `Malformed query string`. Unknown unit/zone/week start → 400 with a precise message. |
| 4   | Labels are `YYYY-MM-DD` strings (`hour`: `YYYY-MM-DDTHH:00`) — quote them in `$having` (`week>='2026-03-01'`, `h>='2026-03-29T05:00'`).                                                     |

Contract (labels, zones, eligible fields, 400/501, `/meta` discovery) → [calendar-buckets.md](calendar-buckets.md).

## Gate enforcement (since 0.1.128)

Every root path of a request — filter keys, `$sort` keys, `$select` entries, `$groupBy`, `$having` keys (minus aggregate aliases), aggregate `$field`s — is checked against the controller's capability index (the same one `/meta.fields` is projected from) before anything reaches the database. Rejections:

```json
HTTP/1.1 400 Bad Request
{
  "statusCode": 400,
  "message": "Filtering on field \"ssn\" is not permitted — add @db.column.filterable to enable.",
  "errors": [{ "path": "ssn", "message": "Filtering on field \"ssn\" is not permitted — add @db.column.filterable to enable." }]
}
```

| Path                                          | Filter / `$sort` / `$groupBy`                                     | `$select`                                                        |
| --------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| listed field (`title`, `contact.email`)       | per `/meta.fields` flags (manual-mode policy on filter/sort only) | ok                                                               |
| flattened object parent (`contact`)           | 400 `"contact" is a nested object — … leaves (contact.email, …)`  | ok (expands)                                                     |
| JSON parent (`prefs`, arrays)                 | filter: SQL `$exists` only, else 400; `$sort`: 400 everywhere     | ok (whole value)                                                 |
| JSON descendant (`prefs.theme`)               | SQL: 400 `… inside JSON-stored column "prefs" …`; Mongo/memory ok | same                                                             |
| navigation path (`assignee`, `assignee.name`) | 400 `… use assignee=$some(…) … or $with=assignee(...)`            | 400 — use `$with=assignee($select=name)`                         |
| `@db.writeOnly` / `@db.encrypted`             | 400                                                               | writeOnly: stripped; encrypted leaf ok; encrypted descendant 400 |
| unknown                                       | 400 `Unknown field "x"`                                           | 400                                                              |

`$with` sub-controls (`$with=assignee($select=name)`) are validated per relation, not at the root. `$having=<alias>` is accepted for every aggregate alias (`sum(amount):total` → `total`; unnamed → `sum_amount`). Any other `$having` key must be a `$groupBy` field — a real but non-grouped column is a 400 `$having key "region" must be an aggregate alias or a $groupBy field` (since 0.1.128). Grouped flattened-object keys come back nested (`$groupBy=stats.views` → `{ "stats": { "views": 10 }, "cnt": 2 }`). Filter nodes carrying anything but `$and` / `$or` / `$not` (e.g. a programmatic `$nor`) → 400.

## Value types (since 0.1.147)

URL values are typed by their syntax, NOT the schema: unquoted number → number (`n=5`), quoted → string (`n='5'`), `true`/`false` → boolean, `null` → null, anything else → string. Then the core checks each comparison value against the field's declared type (rules → [queries.md § Value types](queries.md#value-types-since-01147)); a value that cannot stand for it is a 400 with `errors[0].path` = the field, on every adapter:

```
?n='x'  ?n>=abc  ?n{0,abc}  ?flag=yes  ?ts>='2026-01-01T00:00:00Z'  ?qty>5.5 (number.int)  → 400 Invalid filter value for "n" …
?n=5  ?n>=5  ?n{0,5}  ?n=null  ?n='5'  ?code=123  ?flag=true  ?price='12.50'  ?ts>=1767225600000  → ok
```

≤ 0.1.146 these reached the database: PostgreSQL 500 (`invalid input syntax`), MySQL cast `'x'`→`0` (WRONG rows), SQLite / Mongo / memory `[]`. Accepted cross-type forms (`n='5'`, `code=123`) still pass unchanged — SQL compares them, Mongo / memory match only the declared type.

## Read-response baseline (preferred-id fields always present)

The server unions the table's `preferredId` field set into `$select` on every row-returning read endpoint, regardless of the URL `$select` value. So `?$select=name` on a `slug`-keyed table still returns rows containing both `slug` AND `name`. Pure exclusion maps (`?$select={id:0}`) are rewritten to inclusion before the readable call so preferred-id fields cannot be excluded (since 0.1.134 the rewrite drops an excluded object parent's whole subtree, and never keeps a parent whole when one of its leaves is excluded — before, `-address` still returned `address.*`); mixed inclusion/exclusion maps (`?$select={name:1,id:0}`) are rejected before read. Aggregate (`$groupBy`) and count (`$count`) responses are NOT widened. See [moost-db.md § Read-response baseline](moost-db.md#read-response-baseline).

## Encoding

Use `encodeURIComponent` on values with reserved chars (`& + = , { } | < > ~ /`). The parser handles RFC 3986 percent-encoding. Commas inside `{…}` or parens are structural — encode literal commas as `%2C`.

**Quote string values that are not plain words.** A bare value lexes letters, digits, `_`, `.` (and `%20`), interior hyphens (`status=in-progress`, `2026-01-01`, since 0.1.147) and an exact `YYYY-MM-DDTHH:MM[:SS]` (hour labels); a leading/trailing hyphen, `/`, other `:` forms, `@` … must be single-quoted: `?name='a/b'`. Since 0.1.128 an unparsable query string is HTTP 400 with the envelope `{ message: "Malformed query string: …", statusCode: 400, errors: [{ path: "", message }] }` on every read endpoint (was a 500).
