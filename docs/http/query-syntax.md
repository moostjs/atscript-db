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

Check whether fields are present (non-null) or absent (null):

```bash
curl "http://localhost:3000/todos/query?\$exists=email,phone"    # fields must not be null
curl "http://localhost:3000/todos/query?\$!exists=deletedAt"     # field must be null
```

### Null Values

Explicitly match null:

```bash
curl "http://localhost:3000/todos/query?assigneeId=null"
```

The literal `null` is parsed as a null value, not the string `"null"`.

### Nested Fields

For embedded objects that are [flattened to columns](/api/tables), use the flattened field name with `__` separator:

```bash
curl "http://localhost:3000/users/query?contact__email=alice@example.com"
```

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
| `$vector`    | string  | query, pages      | —       | `$vector=embedding`        |
| `$threshold` | string  | query, pages      | —       | `$threshold=0.8`           |
| `$with`      | string  | query, pages, one | —       | `$with=author,comments`    |
| `$groupBy`   | string  | query             | —       | `$groupBy=status`          |

See [Relations & Search in URLs](./advanced) for details on `$with`, `$search`, `$vector`, and `$groupBy`.

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
