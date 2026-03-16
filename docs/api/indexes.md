---
outline: deep
---

# Indexes & Constraints

<!--@include: ../_experimental-warning.md-->

Indexes improve query performance and can enforce constraints. Atscript supports three index types and two column constraint annotations — all declared in your `.as` schema.

## Plain Index

Create a standard index for faster lookups with `@db.index.plain`. The first argument is the index name, and an optional second argument sets the sort direction (`'asc'` or `'desc'`):

```atscript
@db.index.plain 'name_idx'
name: string

@db.index.plain 'created_idx', 'desc'
createdAt: number
```

## Unique Index

Enforce that no two records share the same value with `@db.index.unique`:

```atscript
@db.index.unique 'email_idx'
email: string
```

Any attempt to insert a duplicate value will result in a constraint violation error.

## Full-Text Search Index

Mark fields for full-text search with `@db.index.fulltext`. An optional second argument sets the field's **weight** — higher weight means greater relevance in search results:

```atscript
@db.index.fulltext 'search_idx', 10
title: string

@db.index.fulltext 'search_idx', 1
body?: string
```

The weight defaults to `1` when omitted. Weighted full-text search is supported by MongoDB and PostgreSQL. SQLite uses FTS5 virtual tables with auto-managed sync triggers — schema sync creates and maintains them automatically.

::: tip
`@db.index.fulltext` sets up the index in the database. For search usage (querying against full-text indexes), see [Text Search](/search/).
:::

## Composite Indexes

When multiple fields share the same index name, they form a **composite index**. This is useful for queries that filter or sort on multiple columns together:

```atscript
@db.index.plain 'name_email_idx'
name: string

@db.index.plain 'name_email_idx'
email: string
```

This creates a single index spanning both `name` and `email`, which speeds up queries that filter on both fields simultaneously.

## Multiple Indexes Per Field

A single field can participate in more than one index. Simply stack multiple `@db.index.*` annotations:

```atscript
@db.index.unique 'email_idx'
@db.index.plain 'name_email_idx'
email: string
```

Here `email` has its own unique index and also participates in a composite index with another field.

## Column Precision

Use `@db.column.precision` to set decimal precision and scale for database storage. Adapters map this to their native decimal type (e.g., `DECIMAL(10,2)` in MySQL, `NUMERIC(10,2)` in PostgreSQL):

```atscript
@db.column.precision 10, 2
price: decimal
```

The `decimal` type stores values as strings at runtime (e.g., `"19.99"`) to preserve exact precision. This also means decimal values pass through JSON transport (client ↔ server) without any loss — no serialization or hydration step is needed. Use `decimal` for prices, financial amounts, and any field where floating-point rounding is unacceptable.

`@db.column.precision` also works on `number` fields for cases where you want a database-level decimal column but don't need string precision at runtime.

## Collation

Use `@db.column.collate` to control how string comparison and sorting work. The value is portable — each adapter maps it to its native collation:

```atscript
@db.column.collate 'nocase'
username: string
```

| Value       | Behavior                               |
| ----------- | -------------------------------------- |
| `'binary'`  | Exact byte comparison (case-sensitive) |
| `'nocase'`  | Case-insensitive comparison            |
| `'unicode'` | Full Unicode-aware sorting             |

Each adapter translates these to its native collation. For example, PostgreSQL maps `'nocase'` to the `CITEXT` type, while SQLite uses the `NOCASE` collation. See [Adapters](/adapters/) for adapter-specific collation details.

## Complete Example

Putting it all together — a `User` table with several index types, precision, and collation:

```atscript
@db.table 'users'
export interface User {
    // Primary key with auto-increment
    @meta.id
    @db.default.increment
    id: number

    // Unique index ensures no duplicate emails
    @db.index.unique 'email_idx'
    @db.column.collate 'nocase'
    email: string

    // Plain index for fast name lookups, also part of a composite index
    @db.index.plain 'name_idx'
    @db.index.plain 'name_status_idx'
    name: string

    // Part of a composite index with name
    @db.index.plain 'name_status_idx'
    status: string

    // Full-text search on bio
    @db.index.fulltext 'search_idx'
    bio?: string

    // Decimal precision for financial data
    @db.column.precision 10, 2
    balance?: decimal
}
```

This gives you a unique case-insensitive email constraint, composite and full-text indexes, and precise decimal storage — all declared in one place.

## Next Steps

- [CRUD Operations](/api/crud) — insert, read, update, and delete records
- [Queries & Filters](/api/queries) — filter, sort, and paginate results
- [Schema Sync](/sync/) — apply schema changes to your database
