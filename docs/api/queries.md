---
outline: deep
---

# Queries & Filters

<!--@include: ../_experimental-warning.md-->

Every query in Atscript's DB layer follows the same shape: a **filter** that selects which records to return, and a **controls** object that determines how they come back (sorting, pagination, projection). This syntax is consistent across all adapters.

```typescript
const results = await table.findMany({
  filter: {
    /* which records */
  },
  controls: {
    /* how to return them */
  },
});
```

## Filter Syntax

Filters use a MongoDB-inspired expression language. At its simplest, you pass an object whose keys are field names and whose values are the conditions to match.

### Equality

The most common filter is a direct equality check:

```typescript
// Shorthand — value is the match target
{
  filter: {
    status: "active";
  }
}

// Explicit operator form
{
  filter: {
    status: {
      $eq: "active";
    }
  }
}
```

Multiple fields in the same object are combined with AND:

```typescript
{ filter: { status: 'active', role: 'admin' } }
// WHERE status = 'active' AND role = 'admin'
```

### Not Equal

```typescript
{
  filter: {
    status: {
      $ne: "done";
    }
  }
}
// WHERE status != 'done'
```

### Comparisons

```typescript
{
  filter: {
    age: {
      $gt: 18;
    }
  }
} // greater than
{
  filter: {
    age: {
      $gte: 18;
    }
  }
} // greater than or equal
{
  filter: {
    age: {
      $lt: 65;
    }
  }
} // less than
{
  filter: {
    age: {
      $lte: 65;
    }
  }
} // less than or equal
```

These operators are available on `number`, `string`, and `Date` fields.

### Set Operators

Check whether a value belongs (or does not belong) to a set:

```typescript
{
  filter: {
    role: {
      $in: ["admin", "editor"];
    }
  }
}
// WHERE role IN ('admin', 'editor')

{
  filter: {
    status: {
      $nin: ["archived", "deleted"];
    }
  }
}
// WHERE status NOT IN ('archived', 'deleted')
```

### Pattern Matching

```typescript
{
  filter: {
    name: {
      $regex: "^Al";
    }
  }
}
// SQLite/PostgreSQL: WHERE name LIKE 'Al%' (or REGEXP)
// MongoDB: WHERE name matches /^Al/
```

`$regex` is available on `string` fields and accepts a `RegExp` or `string`.

### Existence

`$exists` tests whether a field **holds a value** — the same answer on every adapter:

```typescript
{
  filter: {
    email: {
      $exists: true;
    }
  }
} // SQL: WHERE email IS NOT NULL
{
  filter: {
    email: {
      $exists: false;
    }
  }
} // SQL: WHERE email IS NULL
```

| Stored value                                              | `$exists: true` | `$exists: false` |
| --------------------------------------------------------- | :-------------: | :--------------: |
| Missing / `undefined`                                     |        —        |      match       |
| Explicit `null`                                           |        —        |      match       |
| Any other value, including `{}`, `[]`, `""`, `0`, `false` |      match      |        —         |

Rules (since 0.1.132):

- **The operand must be a boolean.** `{ $exists: 1 }` or `{ $exists: "false" }` throws `DbError("INVALID_QUERY")` — `$exists on "email" expects true or false` (HTTP 400). An `@db.encrypted` field fails with `ENC_FIELD_FILTER` first, as for any filter.
- **Works on any stored column, including `@db.json` objects and arrays on SQL adapters**, which otherwise reject every filter on the column. Only an entry whose **sole** operator is `$exists` qualifies: `{ metrics: { $exists: true } }` is accepted, `{ metrics: { $exists: true, $ne: null } }` or `{ metrics: { value: 1 } }` is not — the error then names `(accepted operators: $exists)`. Each occurrence inside `$and` / `$or` / `$not` is judged on its own, so an `$exists` entry never unlocks another entry on the same path.
- **Descendants stay rejected.** `{ "metrics.value": { $exists: true } }` on a SQL JSON column, a flattened object parent (`contact`) and navigation paths fail like any other filter (see the path rules below). `$sort`, `$groupBy`, `$having` and aggregate fields are unaffected.

::: warning MongoDB and memory: `null` counts as absent since 0.1.132
Before 0.1.132 the MongoDB and memory adapters answered `$exists` by key presence, so a document storing `note: null` matched `$exists: true`. They now match SQL (where a missing value and `NULL` are the same thing): MongoDB translates `{ f: { $exists: true } }` to `{ f: { $ne: null } }` and `$exists: false` to `{ f: null }`. Filters that relied on "key present even if `null`" now return fewer rows (with `$exists: true`) or more (with `false`). Key presence is no longer expressible through the portable filter — `{ note: null }` also matches a missing key — so use the [native collection](/adapters/mongodb#accessing-the-adapter) if you need it.
:::

### Null Values

You can also filter for null directly:

```typescript
{
  filter: {
    assigneeId: null;
  }
}
// WHERE assigneeId IS NULL
```

Since 0.1.128 the filter types admit this: the readable's flat and own-props shapes are wrapped in `NullableOptional`, so every optional property accepts `null` in bare, `$eq`, `$ne` and `$in` positions (`{ note: null }`, `{ note: { $ne: null } }` type-check; `null` on a required property does not). `$in: [null]` never matches on SQL adapters (`IN (NULL)`), use the bare form. Optional columns read back as `null` (SQL) or are absent (MongoDB) — compare with `== null`.

## Logical Operators

### Implicit AND

When you put multiple fields in a single filter object, they are ANDed together automatically:

```typescript
{ filter: { status: 'active', role: 'admin' } }
```

### Explicit AND

Use `$and` when you need multiple conditions on the same field, or just prefer being explicit:

```typescript
{
  filter: {
    $and: [{ age: { $gte: 18 } }, { age: { $lt: 65 } }];
  }
}
```

### OR

```typescript
{
  filter: {
    $or: [{ status: "active" }, { role: "admin" }];
  }
}
```

### NOT

Negate a set of conditions:

```typescript
{
  filter: {
    $not: {
      status: "archived";
    }
  }
}
```

### Nested Combinations

Logical operators compose naturally:

```typescript
{ filter: {
  $and: [
    { $or: [
      { priority: 'high' },
      { priority: 'critical' },
    ] },
    { $not: { status: 'done' } },
  ],
} }
```

## Nested Field Filters

Atscript automatically flattens nested objects into `__`-separated column names (e.g., a `contact.email` field becomes the `contact__email` column). When filtering, use **dot notation** — the adapter translates it to the physical column name:

```typescript
{ filter: { 'contact.email': 'alice@example.com' } }
// SQL: WHERE contact__email = 'alice@example.com'

{ filter: { 'address.city': { $in: ['Berlin', 'Paris'] } } }
// SQL: WHERE address__city IN ('Berlin', 'Paris')
```

This works with all operators — comparisons, `$regex`, `$exists`, and logical combinators.

::: warning Paths are validated before translation (since 0.1.128)
Every filter key, `$sort` key, `$select` entry, `$groupBy` field, `$having` key and aggregate `$field` must resolve to physical storage on the adapter in use, or the call throws `DbError("INVALID_QUERY")` (HTTP 400 through moost-db) before any SQL or pipeline is built:

- physical column names (`contact__email`, `@db.column`-renamed names) are no longer accepted — use logical paths;
- descendants of a `@db.json` / array column (`prefs.theme`) are rejected on SQL adapters (MongoDB and memory address them natively);
- a `@db.json` / array column itself accepts only an [`$exists`](#existence) entry on SQL adapters (since 0.1.132; before, every filter on it was rejected);
- navigation paths (`assignee.name`) are rejected — load relations with `$with`, or filter by them with a [relational predicate](#relational-filters) (`{ assignee: { $some: { name: … } } }`, since 0.1.147);
- a flattened object parent (`contact`) can be selected but not filtered or sorted — use a leaf;
- `$sort` on a JSON / array column is rejected on every adapter (`canSortField`);
- filter nodes may only carry `$and`, `$or`, `$not` — `$nor` is rejected.
- `$having` keys must be aggregate aliases (`$as`, else `fn_field`) or `$groupBy` fields — a real but non-grouped column throws `$having key "region" must be an aggregate alias or a $groupBy field` (before 0.1.128 PostgreSQL / MySQL raised an engine error, SQLite ignored the key and MongoDB returned no rows).

This includes `updateMany` / `deleteMany` filters and `transformFilter` overlays in moost-db.
:::

## Relational Filters (`$some` / `$none`) {#relational-filters}

Since 0.1.147. Select rows by their **related** rows — "issues whose ticket is open", "tickets without issues" — by putting an operator map on a [navigation property](/relations/navigation). The examples in this section use this schema:

```atscript
@db.table 'teams'
export interface Team {
    @meta.id
    id: string
    name: string
}

@db.table 'tickets'
export interface Ticket {
    @meta.id
    key: string
    status: string

    @db.rel.FK
    teamId?: Team.id

    @db.rel.to
    team?: Team

    @db.rel.from
    issues: Issue[]

    @db.rel.via TicketLabel
    labels: Label[]
}

@db.table 'issues'
export interface Issue {
    @meta.id
    id: number
    title: string
    status?: string

    @db.rel.FK
    ticketKey?: Ticket.key

    @db.rel.to
    ticket?: Ticket
}
```

(`Label` and the `TicketLabel` junction follow the [many-to-many pattern](/relations/navigation#db-rel-via-many-to-many).)

```typescript
// Issues whose ticket is open and belongs to team t1 or t2
await issues.findMany({
  filter: { ticket: { $some: { status: "open", teamId: { $in: ["t1", "t2"] } } } },
});

// Tickets without any issue
await tickets.findMany({ filter: { issues: { $none: {} } } });

// Tickets labelled "bug" but not "wontfix"
await tickets.findMany({
  filter: { labels: { $some: { name: "bug" }, $none: { name: "wontfix" } } },
});
```

| Operator   | A row matches when                   | With `{}`              |
| ---------- | ------------------------------------ | ---------------------- |
| `$some: F` | at least one related row matches `F` | it has any related row |
| `$none: F` | no related row matches `F`           | it has no related row  |

Several operators on one key are ANDed. Predicates combine with other conditions and with `$and` / `$or` / `$not` like any field condition.

### Which rows are related

The related rows of a row are **exactly the rows [`$with`](/relations/loading) loads** for it — the same foreign-key pairing (aliases included) and the relation's [`@db.rel.filter`](/relations/navigation#db-rel-filter). The meaning is the same for to-one and to-many relations:

| Relation       | Related rows of a row `r`                                    |
| -------------- | ------------------------------------------------------------ |
| `@db.rel.to`   | the target row whose key equals `r`'s foreign key            |
| `@db.rel.from` | the target rows whose foreign key references `r`             |
| `@db.rel.via`  | the target rows linked to `r` by a row of the junction table |

Composite keys must match on every part.

**`NULL` foreign keys.** A row whose foreign key is `null` (any part of a composite one) has **no** related row: `$some` never matches it and `$none` always does. `{ ticket: { $none: { status: "open" } } }` therefore also returns issues without a ticket — add `ticketKey: { $ne: null }` when you mean "has a ticket, and it is not open". Both operators are plain true / false tests on every engine, so the SQL adapters, MongoDB and the memory adapter return the same rows.

### Writing the operand

- Keys are **the related table's** logical field paths (`status`, `contact.email`), not prefixed with the relation name. Every [filter operator](#filter-syntax) works.
- The related table's own rules apply inside: unknown fields, `@db.encrypted` fields (`ENC_FIELD_FILTER`), JSON descendants on SQL adapters and the other [path rules](#nested-field-filters) are rejected, with the path prefixed by the relation (`ticket.note`).
- To cross another relation, nest a predicate — one relation per level:

  ```typescript
  // Issues whose ticket belongs to the team named "Core"
  {
    ticket: {
      $some: {
        team: {
          $some: {
            name: "Core";
          }
        }
      }
    }
  }
  ```

- A dotted navigation path is still rejected, with a hint: `Cannot filter on "ticket.status" — navigation path; use { ticket: { $some: { status: … } } }`.
- `$some` / `$none` cannot share a key with a comparison operator (`Cannot mix "$some" / "$none" with "$eq" on "ticket"`), and each takes an object (`"$some" on "ticket" expects a filter object`).

### "Every related row" — no `$every`

There is no `$every` operator. "Every related row matches `F`" is "no related row fails `F`": `{ nav: { $none: { $not: F } } }`. It is also true when there are no related rows; add `$some: {}` on the same key to require at least one.

When `F` reads an optional field, write the negation yourself. A `null` inside `$not` is not handled the same way everywhere: SQL treats `NOT (status = 'closed')` on a `NULL` status as unknown (the row does not fail `F`), while MongoDB and the memory adapter treat it as a mismatch (the row fails `F`). Spell the failing case out so every adapter agrees:

```typescript
// Tickets whose issues are all closed (a null status counts as not closed)
await tickets.findMany({
  filter: { issues: { $none: { $or: [{ status: { $ne: "closed" } }, { status: null }] } } },
});
```

### Where predicates are accepted

- The `filter` of `findOne`, `findMany`, `count`, `findManyWithCount`, the text / vector / geo search methods, and `aggregate()` (the row filter — never `$having`).
- `$with` sub-filters, for the related table's own relations — see [Loading Relations](/relations/loading#filtering-parents-by-related-rows).
- Mutation filters: `updateMany`, `replaceMany`, `deleteMany`, and a row `scope`.

Server-side code needs no opt-in. HTTP clients do, per relation — see [Permissions § Relational predicates](/http/permissions#relational-predicates).

All five bundled adapters run predicates in reads and writes. How each one executes them is on its page: [PostgreSQL](/adapters/postgresql#relational-predicates), [MySQL](/adapters/mysql#relational-predicates), [SQLite](/adapters/sqlite#relational-predicates), [MongoDB](/adapters/mongodb#relational-predicates), [memory](/adapters/memory#relational-predicates).

::: tip Index the join columns
Each predicate runs a correlated lookup per candidate row. Index the foreign-key column on the `@db.rel.from` side (`issues.ticketKey` for `tickets.issues`) and both foreign-key columns of a `@db.rel.via` junction. A `@db.rel.to` predicate looks up the target's primary or unique key, which is indexed already.
:::

### Limits and errors

| Condition                                                                             | Error                                                                                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| more than 4 nested levels (`REL_FILTER_MAX_DEPTH`)                                    | `INVALID_QUERY` — `Relational predicates nest at most 4 levels deep` (no `path`)                    |
| more than 16 predicates in one filter, nested ones included (`REL_FILTER_MAX_NODES`)  | `INVALID_QUERY` — `At most 16 relational predicates per query` (no `path`)                          |
| `$some` / `$none` on a field that is not a navigation property                        | `INVALID_QUERY` — `"$some" / "$none" are only valid on a navigation relation — "title" is not one`  |
| a self-referencing many-to-many (a junction with one FK to the type)                  | `INVALID_QUERY` — its two junction keys cannot be told apart                                        |
| the adapter does not support predicates (custom adapters by default)                  | `REL_FILTER_NOT_SUPPORTED` — `… not supported by this adapter` (`… in mutation filters` for writes) |
| the related table lives in another database or on another adapter (`sharesStoreWith`) | `REL_FILTER_NOT_SUPPORTED`                                                                          |
| the table was not created through a `DbSpace`                                         | `REL_FILTER_NOT_SUPPORTED` — the related table cannot be resolved                                   |

The error `path` is the dotted relation chain (`ticket.team`); messages name relations, never physical table names. Both codes answer HTTP 400 through moost-db. The limits are exported from `@atscript/db` as `REL_FILTER_MAX_DEPTH` and `REL_FILTER_MAX_NODES`.

These core limits count every predicate of the filter, server-added ones included (row scopes, [`transformRelationFilter`](/http/customization#transformrelationfilter) overlays), so their errors name no path. HTTP clients have their own, lower budget — 3 levels and 8 predicates per request (`REL_FILTER_CLIENT_MAX_DEPTH`, `REL_FILTER_CLIENT_MAX_NODES`), counting the client's predicates only — which leaves the server headroom for its overlays. See [Permissions § Relational predicates](/http/permissions#relational-predicates).

### Typing

Typed filters accept a predicate on navigation keys only: `{ ticket: { $some: … } }` type-checks, `{ title: { $some: {} } }` and unknown keys do not. The operand of a relation to an `.as` type is not typed field by field (`Record<string, unknown>`) — it is validated at run time.

## Query Controls

The `controls` object determines how the result set is shaped.

### Sorting

Use `$sort` with `1` for ascending and `-1` for descending:

```typescript
controls: {
  $sort: {
    name: 1;
  }
} // A → Z
controls: {
  $sort: {
    createdAt: -1;
  }
} // newest first
```

Multiple sort keys are applied in order:

```typescript
controls: { $sort: { status: 1, name: -1 } }
// ORDER BY status ASC, name DESC
```

::: info NULL position
Where `null` / missing values land follows the engine: SQLite, MySQL, MongoDB and the memory adapter put them **first** in ascending order (last in descending); PostgreSQL puts them **last** in ascending order (first in descending). When the position must be the same on every engine, filter `null` out (or query it separately) instead of relying on the sort.
:::

### Pagination

```typescript
controls: {
  $limit: 10,   // return at most 10 records
  $skip: 20,    // skip the first 20 records
}
```

### Field Selection

Include specific fields using array form:

```typescript
controls: {
  $select: ["id", "name", "email"];
}
```

Or exclude fields with an object where `0` means exclude:

```typescript
controls: { $select: { password: 0, internalNotes: 0 } }
```

When selecting a nested object parent, all its child fields are included:

```typescript
controls: {
  $select: ["id", "contact"];
}
// Includes contact.email, contact.phone, etc.
```

::: info Computed entries
An include array can also carry aggregate entries (`{ $fn: 'sum', $field: 'amount' }`) and [calendar buckets](/api/calendar-buckets) (`{ $bucket: 'week', $field: 'createdAt' }`). Both belong to grouped queries — see [Grouped Queries](/api/aggregation). Any other non-string entry is rejected with `INVALID_QUERY` (`Unsupported $select entry at index i`) since 0.1.132; earlier versions dropped it silently.
:::

::: tip FK Fields Auto-Included
When using `$select` with relation loading (`$with`), foreign key fields needed for relation resolution (e.g., `assigneeId` for an `assignee` relation) are automatically included even if not listed in `$select`.
:::

### Paginated Results

Use `findManyWithCount()` to get both data and total count in one call — see [CRUD Operations — Find Many with Count](/api/crud#find-many-with-count) for the API and examples.

## Type-Safe Generics

Queries are fully typed. `findOne` and `findMany` accept a `Uniquery<OwnProps, NavType>` that constrains filter fields to own (non-navigation) properties — plus, since 0.1.147, [relational predicates](#relational-filters) on navigation properties. The return type `DbResponse` automatically strips navigation properties from the result unless you request them via `$with`.

When the query type is a literal (not widened), TypeScript infers exactly which navigation properties are returned:

```typescript
// result type includes `assignee` but not other nav props
const tasks = await taskTable.findMany({
  controls: { $with: [{ name: "assignee" }] },
});
```

## Query Expressions

Query expressions are a **compile-time** syntax used inside `.as` files to define view filters, join conditions, and relation filters. They are _not_ used in runtime TypeScript queries — they are embedded in annotations and compiled into the schema.

### Syntax

Expressions are wrapped in backticks inside `.as` files:

```atscript
@db.view.filter `Task.status != 'done'`
```

### Field References

Reference fields using `TableName.fieldName` (a nested field as `TableName.address.city`):

```atscript
@db.view.filter `Task.priority = 'high'`
@db.view.joins Project, `Project.id = Task.projectId`
```

An unqualified name (`status`) reads the annotation's default type: the entry table in `@db.view.filter`, `@db.view.joins` and `@db.agg.*` conditions, the related type in `@db.rel.filter`. `@db.view.having` takes only unqualified names — the view's own fields. See [Annotations → Editor support](/adapters/annotations#editor-support) for each annotation's scope.

### Operators

| Operator     | Meaning                 | Example                                      |
| ------------ | ----------------------- | -------------------------------------------- |
| `=`          | equals                  | `` `Task.status = 'active'` ``               |
| `!=`         | not equals              | `` `Task.status != 'done'` ``                |
| `>`          | greater than            | `` `Task.priority > 3` ``                    |
| `>=`         | greater than or equal   | `` `Task.priority >= 3` ``                   |
| `<`          | less than               | `` `Task.age < 65` ``                        |
| `<=`         | less than or equal      | `` `Task.age <= 65` ``                       |
| `in`         | in a list of values     | `` `Task.status in ('active', 'pending')` `` |
| `not in`     | not in a list of values | `` `Task.role not in ('guest', 'bot')` ``    |
| `exists`     | holds a value           | `` `Task.assigneeId exists` ``               |
| `not exists` | null or missing         | `` `Task.deletedAt not exists` ``            |
| `matches`    | regex match             | `` `User.name matches /^al/i` ``             |

The right side of a comparison is a literal — a string in single or double quotes, a number, `true`, `false` or `null` — or another field reference (`` `Project.id = Task.projectId` ``). `in` / `not in` take a parenthesized list of literals. `matches` takes a regex literal, `/pattern/flags`; view predicates reject it at sync on SQL adapters and in MongoDB join conditions (see [View Filters](/views/#view-filters)), and `@db.agg.*` conditions don't accept it.

### Logical Combinators

Combine conditions with the keywords `and`, `or` and `not`. `not` binds tightest, then `and`, then `or`; use parentheses for grouping. The symbolic forms `&&`, `||` and `!` are not accepted — they are a compile error.

```atscript
@db.view.filter `Task.status != 'done' and Task.priority >= 3`
@db.view.filter `(Task.status = 'active' or Task.status = 'pending') and Task.assigneeId exists`
@db.view.filter `not (Task.status = 'archived')`
```

### Where They Are Used

Query expressions appear in these annotations:

- **`@db.view.filter`** — row-level filter for a [view](/views/)
- **`@db.view.joins`** — join condition between tables in a view
- **`@db.view.having`** — having clause for aggregation views
- **`@db.agg.*`** (second argument) — the rows a [conditional aggregate](/views/aggregations#conditional-aggregates) reads
- **`@db.rel.filter`** — static filter on a relation, applied when it is loaded and in [relational predicates](#relational-filters) (since 0.1.147)

Example in a view definition:

```atscript
@db.view
@db.view.for Task
@db.view.joins Project, `Project.id = Task.projectId`
@db.view.filter `Task.status != 'done' and Task.priority >= 3`
type ActiveHighPriorityTasks {
  taskId: Task.id
  title: Task.title
  projectName: Project.name
}
```

## Combining It All

A practical example that brings filters, sorting, pagination, and field selection together:

```typescript
const tasks = await taskTable.findMany({
  filter: {
    status: { $ne: "done" },
    priority: { $in: ["high", "critical"] },
    project: { $some: { active: true } },
  },
  controls: {
    $sort: { priority: -1, createdAt: 1 },
    $limit: 20,
    $skip: 0,
    $select: ["id", "title", "status", "priority"],
  },
});
```

This returns the first 20 non-done tasks with high or critical priority from active projects, sorted by priority descending then creation date ascending, with only the selected fields.

## Next Steps

- [CRUD Operations](/api/crud) — Insert, read, update, delete
- [Grouped Queries](/api/aggregation) — `$groupBy`, aggregates, `$having`, calendar buckets
- [Update & Patch](/api/update-patch) — Embedded array and object patch operators
- [Views](/views/) — Managed, external, and materialized views
- [Relations](/relations/deep-operations) — Navigation property loading and deep operations
