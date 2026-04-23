# http-query-syntax

URL query strings accepted by `/query`, `/pages`, and `/one`. Parsed by `@uniqu/url` into `Uniquery`, then executed identically by every adapter.

Three components:

- **filter** — field conditions (no `$`-prefix).
- **controls** — `$`-prefixed keys (`$sort`, `$select`, `$limit`, `$with`, …).
- **insights** — set automatically from the parse.

## Equality / inequality

```
?status=active                        # AND (implicit when multiple)
?status=active&priority=high
?status!=done
```

## Comparison

```
?priority>3    ?priority>=3    ?priority<5    ?priority<=5
```

## Set (IN / NOT IN)

```
?role{admin,editor}        # IN
?status!{draft,deleted}    # NOT IN
```

## Range

```
?25<age<35          # exclusive
?25<=age<=35        # inclusive
?age>=18,age<=65    # AND of two conditions
```

## Pattern / regex

```
?name~=/^Al/i       # regex with flags
?slug=foo-*         # prefix (LIKE-style — `*` wildcard)
?slug=*-v2          # suffix
```

## Null / exists

```
?deletedAt=null
?deletedAt!=null
```

## Logical grouping

Parentheses and `|` for OR:

```
?(role=admin|createdAt>2026-01-01)&active=true
```

## Nested field paths

Dot-notation for nested objects / joined view fields:

```
?profile.country=US
?author.name=Alice
```

## Controls

| Key        | Syntax                                                              | Notes                                                                                                |
| ---------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `$sort`    | `$sort=field,-field2`                                               | Leading `-` = DESC.                                                                                  |
| `$select`  | `$select=id,name,author.name`                                       | Include-list (paths).                                                                                |
| `$skip`    | `$skip=20`                                                          |                                                                                                      |
| `$limit`   | `$limit=10`                                                         |                                                                                                      |
| `$page`    | `$page=2`                                                           | Alternative to `$skip` (with `$size`).                                                               |
| `$size`    | `$size=20`                                                          | Page size.                                                                                           |
| `$count`   | `$count=1`                                                          | Returns a number.                                                                                    |
| `$with`    | `$with=author,comments`                                             | Load nav relations.                                                                                  |
| `$with`    | `$with=author($select=id,name),comments($sort=-createdAt&$limit=5)` | Sub-query per relation — same URL grammar recursively (filter + `$`-controls, incl. nested `$with`). |
| `$groupBy` | `$groupBy=category,region`                                          | Aggregate query.                                                                                     |
| `$search`  | `$search=quick+brown`                                               | FTS — adapter must support.                                                                          |
| `$vector`  | `$vector=embed-this-text`                                           | Controller's `computeEmbedding()`.                                                                   |

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

## Gate enforcement

When `@db.table.filterable 'manual'` is set, a filter referencing a field without `@db.column.filterable` returns:

```json
HTTP/1.1 400 Bad Request
{ "statusCode": 400, "errors": [{ "path": "ssn", "message": "Field not filterable" }] }
```

Same mechanism for `@db.table.sortable 'manual'` with `@db.column.sortable`.

## Encoding

Use `encodeURIComponent` on values with reserved chars (`& + = , { } | < > ~ /`). The parser handles RFC 3986 percent-encoding. Commas inside `{…}` or parens are structural — encode literal commas as `%2C`.
