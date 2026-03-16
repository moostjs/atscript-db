---
outline: deep
---

# Adapter Overview

<!--@include: ../_experimental-warning.md-->

Atscript's DB layer is adapter-agnostic. The same `.as` definitions, queries, and operations work across all supported adapters. Each adapter translates the generic API to a specific database engine, handling differences in SQL dialects, type systems, indexing strategies, and schema management transparently.

## Quick Decision Guide

**PostgreSQL** is the best choice for production workloads. It offers the most complete feature set: native foreign key enforcement, transactional DDL (schema changes are atomic), pgvector for vector similarity search, CITEXT for case-insensitive text, and GIN-based fulltext search. If you need a battle-tested relational database with advanced capabilities, PostgreSQL is the recommended adapter.

**SQLite** is ideal for development and testing. Zero-config, single-file storage, and no server process make it the fastest way to get started. SQLite supports foreign keys via `PRAGMA foreign_keys` and fulltext search via FTS5 virtual tables. Its main limitation is ALTER TABLE support — column type changes and some modifications require table recreation.

**MongoDB** is best for flexible schemas and document-oriented data. It stores nested objects natively (no flattening), supports native array patch operations (`$push`, `$pull`), and loads relations via `$lookup` in a single pipeline. Atlas Search enables text and vector search. Transactions require a replica set.

**MySQL** is a solid choice for existing MySQL infrastructure. It offers wide hosting support, native FULLTEXT indexing, and `VECTOR(N)` support in MySQL 9.0+. In-place column modification via `ALTER TABLE MODIFY COLUMN` means schema changes are straightforward.

## Feature Comparison Matrix

| Feature                      | PostgreSQL        | SQLite        | MongoDB              | MySQL          |
| ---------------------------- | ----------------- | ------------- | -------------------- | -------------- |
| Native FK constraints        | Yes               | Yes (PRAGMA)  | Emulated             | Yes            |
| Transactional DDL            | Yes               | No            | N/A                  | No             |
| Text search                  | GIN + tsvector    | FTS5          | Atlas Search         | FULLTEXT       |
| Vector search                | pgvector          | No            | Atlas vectorSearch   | VECTOR(N) 9.0+ |
| JSON storage                 | JSONB             | TEXT          | Native               | JSON           |
| Boolean type                 | Native            | INTEGER 0/1   | Native               | TINYINT(1)     |
| UUID generation              | gen_random_uuid() | App-side      | App-side             | App-side       |
| Nested objects               | Flattened         | Flattened     | Native               | Flattened      |
| Native patch ops             | No                | No            | Yes ($push/$pull)    | No             |
| Native relations             | No                | No            | Yes ($lookup)        | No             |
| In-place column modify       | Yes               | No (recreate) | N/A                  | Yes            |
| Transactions                 | Full (incl. DDL)  | Yes           | Replica set required | Yes (no DDL)   |
| Schema namespaces            | Schemas           | No            | No                   | Databases      |
| Adapter-specific annotations | `@db.pg.*`        | None          | `@db.mongo.*`        | `@db.mysql.*`  |

## Installation Quick Reference

| Adapter    | Package                 | Peer Dependency  | Import            |
| ---------- | ----------------------- | ---------------- | ----------------- |
| PostgreSQL | `@atscript/db-postgres` | `pg`             | `PostgresAdapter` |
| SQLite     | `@atscript/db-sqlite`   | `better-sqlite3` | `SqliteAdapter`   |
| MongoDB    | `@atscript/db-mongo`    | `mongodb`        | `MongoAdapter`    |
| MySQL      | `@atscript/db-mysql`    | `mysql2`         | `MysqlAdapter`    |

All adapters follow the same `DbSpace` + factory pattern:

```typescript
import { DbSpace } from "@atscript/db";
import { PgDriver, PostgresAdapter } from "@atscript/db-postgres";

const driver = new PgDriver("postgresql://localhost:5432/mydb");
const db = new DbSpace(() => new PostgresAdapter(driver));
```

Or use the shorthand `createAdapter` helper where available:

```typescript
import { createAdapter } from "@atscript/db-postgres";

const db = createAdapter("postgresql://localhost:5432/mydb");
```

::: tip
Each adapter page covers detailed setup, driver options, and adapter-specific configuration. See the individual pages linked in [Next Steps](#next-steps).
:::

## Capability Flags

Adapters declare their capabilities via boolean flags on the `BaseDbAdapter` class. The generic DB layer reads these flags and adapts its behavior automatically — for example, skipping client-side object flattening when the adapter stores nested objects natively, or falling back to application-level cascade logic when the database does not enforce foreign keys.

| Flag                          | Description                    | PG  | SQLite | Mongo | MySQL |
| ----------------------------- | ------------------------------ | :-: | :----: | :---: | :---: |
| `supportsNativeForeignKeys`   | DB enforces FK constraints     | Yes |  Yes   |  No   |  Yes  |
| `supportsNestedObjects`       | Stores nested objects natively | No  |   No   |  Yes  |  No   |
| `supportsNativePatch`         | Has native array operations    | No  |   No   |  Yes  |  No   |
| `supportsNativeRelations`     | Joins relations in one query   | No  |   No   |  Yes  |  No   |
| `supportsNativeValueDefaults` | DB handles default values      | Yes |  Yes   |  No   |  Yes  |
| `supportsColumnModify`        | ALTER COLUMN type changes      | Yes |   No   |  N/A  |  Yes  |

::: info How the generic layer uses these flags
When `supportsNativeForeignKeys` is `false`, the generic layer implements cascade and set-null behavior in application code before deleting parent records. When `supportsNestedObjects` is `false`, nested objects are automatically flattened to `__`-separated column names (e.g., `address__city`). When `supportsNativePatch` is `true`, patch operations like array `$push`/`$pull` are delegated directly to the adapter instead of being decomposed into read-modify-write cycles.
:::

## Next Steps

- [PostgreSQL](./postgresql) — full setup, pgvector, CITEXT, connection pooling
- [SQLite](./sqlite) — driver setup, FTS5 search, table recreation
- [MongoDB](./mongodb) — Atlas Search, vector search, capped collections
- [MySQL](./mysql) — engine/charset options, FULLTEXT, VECTOR support
- [Creating Custom Adapters](./creating-adapters) — extend `BaseDbAdapter` for other databases
- [Annotations Reference](./annotations) — all `@db.*` annotations in one place

For general usage that applies to all adapters:

- [Setup & Configuration](/guide/setup) — initial project setup
- [CRUD Operations](/api/crud) — create, read, update, delete
- [Query Filters](/api/queries) — filtering, sorting, pagination
