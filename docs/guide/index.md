---
outline: deep
---

# Database Layer

<!--@include: ./_experimental-warning.md-->

Atscript's DB layer extends the `.as` model with database annotations — define tables, relations, views, and constraints in the same files that drive your TypeScript types. One model powers your types, validation, schema, and runtime queries.

::: info New to Atscript?
Start with the [TypeScript Quick Start](https://atscript.dev/packages/typescript/quick-start) to learn `.as` syntax and project setup. The DB layer builds on the same model.
:::

## How It Works

Add `@db.*` annotations to your `.as` definitions and the DB layer takes it from there:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'email_idx'
    email: string

    name: string

    @db.default.now
    createdAt?: number.timestamp
}
```

From this single definition you get:

- **TypeScript types** — fully typed interfaces and runtime metadata
- **Database schema** — tables, columns, indexes, and constraints
- **Validation** — automatic data validation from the same annotations
- **CRUD operations** — type-safe insert, find, update, and delete
- **Schema sync** — drift detection and automatic migrations via CLI

## Architecture

The DB layer is organized in three tiers:

| Layer                             | Role                                                             | Example                                            |
| --------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| **Annotations** (`@db.*`)         | Declare schema, indexes, relations, and views inside `.as` files | `@db.table`, `@db.rel.to`, `@db.view`              |
| **Table API** (`AtscriptDbTable`) | Type-safe CRUD, relation loading, query translation, schema sync | `table.find()`, `table.insert()`                   |
| **Adapters** (`BaseDbAdapter`)    | Database-specific drivers that implement the adapter interface   | `SqliteAdapter`, `PostgresAdapter`, `MongoAdapter` |

Your application code talks to the Table API. The adapter handles SQL generation, document mapping, or whatever your database needs — you never write driver-level code directly.

## What's Included

| Package                 | Purpose                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `@atscript/db/plugin`   | Provides all generic `@db.*` annotations via `dbPlugin()`          |
| `@atscript/db`          | Table API, views, relations, query translation, schema sync engine |
| `@atscript/db-sqlite`   | SQLite adapter (better-sqlite3 or node:sqlite)                     |
| `@atscript/db-postgres` | PostgreSQL adapter with pgvector and CITEXT support                |
| `@atscript/db-mongo`    | MongoDB adapter with Atlas Search and vector search support        |
| `@atscript/db-mysql`    | MySQL adapter                                                      |
| `@atscript/moost-db`    | REST API controller for the [Moost](https://moost.org) framework   |

## Feature Highlights

- **[Relations](/relations/)** — TO (foreign key), FROM (reverse 1:N), and VIA (M:N junction table) with explicit `$with` loading
- **[Views](/views/)** — managed, materialized, and external views defined with `@db.view` annotations
- **[Text search](/search/)** — full-text search across indexed fields
- **[Vector search](/search/vector-search)** — similarity search with pgvector and MongoDB Atlas
- **Array patch operators** — `$insert`, `$remove`, `$update`, `$upsert`, and `$replace` work across all adapters
- **[Schema sync](/sync/)** — CLI-driven migrations with FNV-1a drift detection, column renames, and distributed locking
- **[Transactions](/api/transactions)** — adapter-agnostic transaction support via `AsyncLocalStorage`
- **Adapter-agnostic design** — swap SQLite for PostgreSQL (or any other adapter) without changing application code

## Model-First, Not ORM-First

Atscript is a **model-first data layer**, not a traditional ORM. The `.as` model is the center of the system — the database is one consumer of that model, alongside TypeScript types, validators, and API metadata.

|                      | Traditional ORM                | Atscript DB Layer                                          |
| -------------------- | ------------------------------ | ---------------------------------------------------------- |
| **Source of truth**  | Entity classes or ORM config   | Shared `.as` model                                         |
| **Optimized for**    | Object mapping and DB access   | Reusing one model across types, validation, DB, and APIs   |
| **Validation**       | Separate library or DTO layer  | Built into the same model                                  |
| **Schema evolution** | ORM-specific migrations        | Schema sync from `@db.*` annotations                       |
| **Relations**        | Object graph with lazy loading | Explicit relation loading via `$with`                      |
| **Metadata reuse**   | Mostly DB-focused              | Same model powers validators, JSON Schema, and UI metadata |

## Next Steps

- [Quick Start](/guide/quick-start) — build your first table in five minutes
- [Tables & Fields](/api/tables) — define columns, primary keys, and field types
- [Relations](/relations/) — connect tables with TO, FROM, and VIA relations
- [CRUD Operations](/api/crud) — insert, query, update, and delete data
