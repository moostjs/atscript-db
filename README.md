<p align="center">
  <img src="https://db.atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">Atscript DB</h1>

<p align="center">
  Database adapters and query layer for <a href="https://github.com/moostjs/atscript">Atscript</a> — define your models once in <code>.as</code> files, get type-safe CRUD for any database.
</p>

## Packages

| Package                                           | Description                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`@atscript/db`](packages/db)                     | Core database abstraction — tables, views, relations, schema sync, and validation |
| [`@atscript/db-sql-tools`](packages/db-sql-tools) | Shared SQL builder utilities for SQL-based adapters                               |
| [`@atscript/db-sqlite`](packages/db-sqlite)       | SQLite adapter (via better-sqlite3)                                               |
| [`@atscript/db-postgres`](packages/db-postgres)   | PostgreSQL adapter (via pg, with pgvector support)                                |
| [`@atscript/db-mysql`](packages/db-mysql)         | MySQL adapter (via mysql2)                                                        |
| [`@atscript/db-mongo`](packages/db-mongo)         | MongoDB adapter                                                                   |
| [`@atscript/moost-db`](packages/moost-db)         | Moost framework integration — auto-generated REST CRUD controllers                |
| [`@atscript/db-client`](packages/db-client)       | Browser-compatible HTTP client for moost-db REST endpoints                        |

## Architecture

```
@atscript/db                 ← core: tables, views, relations, schema sync
    ├── @atscript/db-sql-tools   ← shared SQL builders (WHERE, SELECT, INSERT, etc.)
    │       ├── @atscript/db-sqlite
    │       ├── @atscript/db-postgres
    │       └── @atscript/db-mysql
    ├── @atscript/db-mongo       ← native MongoDB driver, no SQL layer
    ├── @atscript/moost-db       ← Moost HTTP controllers wrapping db tables
    └── @atscript/db-client      ← browser/SSR HTTP client for moost-db
```

## Documentation

See the full documentation at [atscript.dev/db](https://atscript.dev/db/guide/quick-start).

## Development

```bash
# Install dependencies
vp install

# Format, lint, test, and build everything
pnpm run ready

# Build all packages
pnpm run build

# Run all tests
pnpm run test

# Release (bump version, build, test, publish)
pnpm run release          # patch
pnpm run release:minor    # minor
pnpm run release:major    # major
```

## License

MIT
