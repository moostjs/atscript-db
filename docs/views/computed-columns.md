---
outline: deep
---

# Computed Columns

Since 0.1.147 a field of a managed view can be **computed**: `@db.compute` declares closed arithmetic over the view's own fields — dimensions, aggregates, [first-row join](./#first-row-joins) fields and other computed fields. The database evaluates it, so the column sorts, filters and pages like any other column, through every query path, HTTP, `/meta` and db-client.

```atscript
@db.alias Issue
export type OldestOpenIssue = Issue

@db.view 'ticket_queue'
@db.view.for Ticket
@db.view.joins Issue, `Issue.ticketId = Ticket.id`, 'left'
@db.view.joins OldestOpenIssue, `OldestOpenIssue.ticketId = Ticket.id and OldestOpenIssue.status = 'open'`, 'left', `raisedAt`
export interface TicketQueue {
    id: Ticket.id

    @db.agg.count 'id', `Issue.status = 'open'`
    openCount: Issue.id

    @db.agg.count 'id', `Issue.status = 'open' and Issue.overdue = true`
    overdueCount: Issue.id

    @db.agg.sum 'estimate', `Issue.status = 'open'`
    openEstimate?: Issue.estimate

    oldestSeverity?: OldestOpenIssue.severity

    @db.compute `openCount * 10 + overdueCount`
    rank: number

    @db.compute `openEstimate / openCount`      // `/` may be NULL → optional field
    avgEstimate?: number

    @db.compute `coalesce(oldestSeverity, 0) * 100 + rank`
    priority: number
}
```

```
GET /ticket-queue/query?$sort=-priority,id&rank>=10&$limit=20
```

## Grammar

A closed grammar — anything else is a compile error at the offending token:

| Form                | Example                    |
| ------------------- | -------------------------- |
| `+` `-` `*` `/`     | `openCount * 10 + overdue` |
| unary `-`           | `-(a - b) * 2`, `a - -1`   |
| parentheses         | `(a + b) * c`              |
| numeric literal     | `10`, `2.5`, `1e3`         |
| `coalesce(a, b, …)` | `coalesce(severity, 0)`    |
| view field          | `openCount`                |

There is no `%`, no comparison, no string / boolean / `null` literal, no aggregate call and no other function. A ratio of aggregates is two `@db.agg.*` fields plus a computed field (`` @db.compute `total / n` ``) — each aggregate keeps its own conditional form. Arithmetic inside predicates (`@db.view.filter` / `having`) is not supported: reference a computed field instead (`` @db.view.having `rank > 10` ``).

## Semantics

Identical on every adapter:

| Aspect      | Behavior                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| Type        | Every value is an IEEE-754 double: `7 / 2 = 3.5` (no integer division); integers stay exact up to 2^53 |
| NULL        | A NULL operand makes the result NULL; `coalesce(a, b, …)` is the first non-NULL argument               |
| Division    | Division by zero is NULL — never an error                                                              |
| Result type | A JS `number` (or `null`)                                                                              |
| Overflow    | Adapter-specific — see below                                                                           |

Doubles make equality filters on fractional results fragile — prefer ranges (`avgEstimate>=2.5`) over `avgEstimate=2.5`.

**Overflow.** A result beyond the double range (about ±1.8e308) behaves differently per adapter. PostgreSQL (`value out of range: overflow`) and MySQL (`DOUBLE value is out of range`) raise an error, so a single extreme row fails the whole view read. SQLite and MongoDB return `Infinity` / `-Infinity`. Keep operands in a range where the expression cannot overflow.

## Rules

Checked at compile time:

| Rule | Check                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VC1  | Only on a field of a `@db.view.for` view, typed exactly `number`; not combined with `@db.agg.*`, `@db.json` or `@db.ignore`                                                            |
| VC2  | Every reference is an unqualified field of the same view — `Issue.severity` is rejected: declare `severity: Issue.severity` first and reference `severity`                             |
| VC3  | Every operand is a `number` field — not `decimal`, not a timestamp (`number.timestamp` / `created` / `updated`), not a string or boolean, not `@db.ignore`                             |
| VC4  | No self-reference and no cycle among computed fields (the message names the path)                                                                                                      |
| VC5  | At least one field reference — a constant column is rejected                                                                                                                           |
| VC6  | An expression that may be NULL needs an optional field (`avgEstimate?: number`): `/`, or an optional operand under `+ - *` / unary `-`; `coalesce` is NULL only when every argument is |

Sealing follows the operands: a computed field over a `@db.writeOnly` field (directly or through another computed field) is write-only on the view; one over an `@db.encrypted` field is rejected the first time the view is used ("ciphertext cannot be computed").

Over HTTP a computed field is visible only while **every** operand is, including the computed fields it reads through. A [`hasField`](/http/customization#hasfield) override that hides one of them hides the computed field too: it becomes an unknown field in filters, sorts and `$select`, and is sealed out of read projections. So `salary * 1` can never leak a hidden `salary`. Likewise, hiding `rank` hides `priority = coalesce(oldestSeverity, 0) * 100 + rank`, because `priority - oldestSeverity * 100` would give `rank` back.

## Querying

A computed column is an ordinary column: sorting (`$sort`), filtering (`rank>=10`), `$select`, pagination, views over the view and `@db.view.having` all accept it. `/meta` lists it with `computed: true` and the normal `sortable` / `filterable` flags (both `true` for a number column) — see [Querying Views](./querying-views#filtering-and-sorting).

## Adapters

An adapter renders computed columns only when its [`viewCapabilities()`](/adapters/creating-adapters#view-capabilities) include `compute` — every bundled adapter does; otherwise sync refuses the view and the adapter's `ensureTable()` throws. SQL adapters cast each leaf (`CAST(x AS REAL | DOUBLE | DOUBLE PRECISION)`) and divide with `NULLIF(divisor, 0)`. MongoDB casts each leaf with `$toDouble` (MongoDB 4.0+), so int64 values past 2^53 round the same way as on SQL, and uses `$add` / `$subtract` / `$multiply` with a guarded `$divide`. The memory adapter holds no view rows (managed views are not evaluated there).

## Query-time arithmetic {#query-time}

When the value is needed for one query rather than as a column of its own — an ad-hoc ratio or score over a `filter` the caller chose — the same arithmetic works inside [`aggregate()`](/api/aggregation#arithmetic-expressions) (since 0.1.148): `sum(price*qty)` per group, `expr(est/open)` over aggregate aliases, plus `first` / `last` for a representative row. Choose by where the value must live:

- **A view with `@db.compute`** — a value that is **per row of the view**, or a ranking you sort, filter and page across requests (the global work queue above), with the same name in `/meta`, db-client and every query path.
- **An aggregate expression** — an ad-hoc grouping with a caller-chosen `filter`. It is grouped queries only: arithmetic in a plain `findMany` / `query` is not provided, so a per-row computed value belongs in a view.

## Schema Sync

The expression is part of the view's sync hash: changing an expression, an operand, or adding a computed field recreates the view (and its dependent views). Views without computed columns hash exactly as before — upgrading does not recreate them. See [View Types → Schema Sync](./view-types#schema-sync-behavior).

## Next Steps

- [Defining Views](./) — joins, [first-row joins](./#first-row-joins), filters
- [Aggregation Views](./aggregation-views) — ranking example
- [Querying Views](./querying-views) — sorting and filtering view columns
