<p align="center">
  <img src="https://atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/db-sql-tools</h1>

<p align="center">
  <strong>Define your models once</strong> — get TypeScript types, runtime validation, and DB metadata from a single <code>.as</code> model.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/adapters/">DB Adapters</a>
</p>

---

Shared SQL builder utilities for Atscript's SQL-based database adapters (`db-sqlite`, `db-mysql`, `db-postgres`). Provides parameterized query generation, MongoDB-style filter translation, and dialect abstraction.

This is an internal package — not typically installed directly by end users.

## Installation

```bash
pnpm add @atscript/db-sql-tools
```

## Features

- `SqlDialect` interface abstracting identifier quoting, parameter placeholders, regex, and value serialization
- `buildWhere` — translates MongoDB-style filters (`$gt`, `$in`, `$or`, `$regex`, etc.) to parameterized SQL
- `buildInsert`, `buildSelect`, `buildUpdate`, `buildDelete` — full SQL statement builders
- `buildAggregateSelect`, `buildAggregateCount` — GROUP BY, HAVING, aggregate functions
- `buildCreateView` — CREATE VIEW with JOINs, filters, and GROUP BY from Atscript view plans
- DDL helpers: query expression → SQL, referential actions, default value literals

## Documentation

- [DB Adapters Guide](https://db.atscript.dev/adapters/)
- [Full Documentation](https://db.atscript.dev)

## License

MIT
