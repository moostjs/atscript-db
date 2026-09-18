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
?$exists=phone,email     # phone AND email must both be non-null
?$!exists=deletedAt      # deletedAt must be null
```

## Logical operators

| Op   | Meaning | Example                                          |
| ---- | ------- | ------------------------------------------------ |
| `&`  | AND     | `?status=open&priority=high`                     |
| `^`  | OR      | `?status=done^priority=low`                      |
| `!`  | NOT     | `?!(status=done)` — wrap expression in `(…)`     |
| `()` | group   | `?(role=admin^createdAt>2026-01-01)&active=true` |

**Precedence:** `&` binds tighter than `^`. So `status=done^priority=high&role=admin` parses as `status=done OR (priority=high AND role=admin)`. Use `(…)` to override.

## Nested field paths

Dot notation works for both nav-prop access and embedded / flattened own-props — the URL parser doesn't distinguish. Use the same `parent.child` form everywhere.

```
?author.name=Alice         # nav-prop / relation
?contact.email=a@e.com     # embedded / flattened own-prop
```

## Controls

| Key            | Syntax                                                              | Notes                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$sort`        | `$sort=field,-field2`                                               | Leading `-` = DESC.                                                                                                                                                                                               |
| `$select`      | `$select=id,name,author.name`                                       | Include-list (paths). See § Read-response baseline below.                                                                                                                                                         |
| `$skip`        | `$skip=20`                                                          |                                                                                                                                                                                                                   |
| `$limit`       | `$limit=10`                                                         | **Defaults to `1000` when absent** on `/query` (`as-db-readable.controller.ts:596`).                                                                                                                              |
| `$page`        | `$page=2`                                                           | `/pages` only. 1-based. Default `1`.                                                                                                                                                                              |
| `$size`        | `$size=20`                                                          | `/pages` only. Default `10`.                                                                                                                                                                                      |
| `$count`       | `$count=1`                                                          | Returns a number.                                                                                                                                                                                                 |
| `$with`        | `$with=author,comments`                                             | Load nav relations.                                                                                                                                                                                               |
| `$with`        | `$with=author($select=id,name),comments($sort=-createdAt&$limit=5)` | Sub-query per relation — same URL grammar recursively (filter + `$`-controls, incl. nested `$with`).                                                                                                              |
| `$groupBy`     | `$groupBy=category,region`                                          | Aggregate query.                                                                                                                                                                                                  |
| `$search`      | `$search=quick+brown`                                               | FTS — adapter must support.                                                                                                                                                                                       |
| `$index`       | `$index=product_search`                                             | Pick a specific FTS/vector index by name. Pairs with `$search` / `$vector`. The blessed way to choose a search **variant** (e.g. exact vs typeahead) — define one index per behavior.                             |
| `$fuzzy`       | `$fuzzy=1`                                                          | Mongo Atlas only: per-request typo tolerance override (`1`/`2`; `0` disables). Defaults to the index's declared `fuzzy`.                                                                                          |
| `$vector`      | `$vector=embed-this-text`                                           | Controller's `computeEmbedding()`.                                                                                                                                                                                |
| `$threshold`   | `$threshold=0.8`                                                    | Vector similarity cutoff (adapter-specific).                                                                                                                                                                      |
| `$center`      | `$center=-122.42,37.77`                                             | `GET /geo` only (required there). `lng,lat` — longitude FIRST. See [geo-search.md](geo-search.md).                                                                                                                |
| `$maxDistance` | `$maxDistance=50000`                                                | `GET /geo` only. Meters.                                                                                                                                                                                          |
| `$minDistance` | `$minDistance=1000`                                                 | `GET /geo` only. Meters (ring queries).                                                                                                                                                                           |
| `$exists`      | `$exists=phone,email`                                               | All listed fields must be non-null (AND).                                                                                                                                                                         |
| `$!exists`     | `$!exists=deletedAt`                                                | All listed fields must be null.                                                                                                                                                                                   |
| `$actions`     | `$actions=true` (or `1`)                                            | Augment each row with `$actions: string[]` — server-evaluated row/rows-level action availability. Stripped on `$count` / `$groupBy`. See [actions.md](actions.md#actionstrue--server-evaluated-row-availability). |

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
GET /orders/query?status=paid&$groupBy=category&$select=category,sum(amount),count()
```

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
| JSON parent (`prefs`, arrays)                 | filter: adapter-dependent (SQL 400); `$sort`: 400 everywhere      | ok (whole value)                                                 |
| JSON descendant (`prefs.theme`)               | SQL: 400 `… inside JSON-stored column "prefs" …`; Mongo/memory ok | same                                                             |
| navigation path (`assignee`, `assignee.name`) | 400 `… use $with=assignee(...)`                                   | 400 — use `$with=assignee($select=name)`                         |
| `@db.writeOnly` / `@db.encrypted`             | 400                                                               | writeOnly: stripped; encrypted leaf ok; encrypted descendant 400 |
| unknown                                       | 400 `Unknown field "x"`                                           | 400                                                              |

`$with` sub-controls (`$with=assignee($select=name)`) are validated per relation, not at the root. `$having=<alias>` is accepted for every aggregate alias (`sum(amount):total` → `total`; unnamed → `sum_amount`). Any other `$having` key must be a `$groupBy` field — a real but non-grouped column is a 400 `$having key "region" must be an aggregate alias or a $groupBy field` (since 0.1.128). Grouped flattened-object keys come back nested (`$groupBy=stats.views` → `{ "stats": { "views": 10 }, "cnt": 2 }`). Filter nodes carrying anything but `$and` / `$or` / `$not` (e.g. a programmatic `$nor`) → 400.

## Read-response baseline (preferred-id fields always present)

The server unions the table's `preferredId` field set into `$select` on every row-returning read endpoint, regardless of the URL `$select` value. So `?$select=name` on a `slug`-keyed table still returns rows containing both `slug` AND `name`. Pure exclusion maps (`?$select={id:0}`) are rewritten to inclusion before the readable call so preferred-id fields cannot be excluded; mixed inclusion/exclusion maps (`?$select={name:1,id:0}`) are rejected before read. Aggregate (`$groupBy`) and count (`$count`) responses are NOT widened. See [moost-db.md § Read-response baseline](moost-db.md#read-response-baseline).

## Encoding

Use `encodeURIComponent` on values with reserved chars (`& + = , { } | < > ~ /`). The parser handles RFC 3986 percent-encoding. Commas inside `{…}` or parens are structural — encode literal commas as `%2C`.

**Quote string values that are not plain words.** A bare value lexes only letters, digits, `_`, `.` (and `%20`); a hyphen (`name=json-w1`, `2026-01-01`), `/`, `:`, `@` … must be single-quoted: `?name='json-w1'`. Since 0.1.128 an unparsable query string is HTTP 400 with the envelope `{ message: "Malformed query string: …", statusCode: 400, errors: [{ path: "", message }] }` on every read endpoint (was a 500).
