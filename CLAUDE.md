# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## AI agents

Consumer-facing agent skill for this repo lives in [`skills/atscript-db/`](skills/atscript-db/SKILL.md). Install with `npx skills add moostjs/atscript-db` (agents working in downstream apps use this). This file is for contributor agents working inside the repo.

## Project Overview

Atscript DB is a monorepo providing a unified database abstraction layer for [Atscript](https://github.com/moostjs/atscript). Models are defined in `.as` files with `@db.*` annotations, producing type-safe CRUD, schema sync, and REST APIs across SQLite, PostgreSQL, MySQL, and MongoDB.

## Architecture

```
@atscript/db                     ← core: tables, views, relations, schema sync
    ├── @atscript/db-sql-tools   ← shared SQL builders (WHERE, SELECT, INSERT, etc.)
    │       ├── @atscript/db-sqlite
    │       ├── @atscript/db-postgres
    │       └── @atscript/db-mysql
    ├── @atscript/db-mongo       ← native MongoDB driver, no SQL layer
    └── @atscript/moost-db       ← Moost HTTP controllers wrapping db tables
```

- **`@atscript/db`** — Database-agnostic core. `BaseDbAdapter` (abstract), `DbSpace` (factory), `AtscriptDbTable`/`AtscriptDbView` (CRUD interface), schema sync with FNV-1a hash drift detection and distributed locking, relation loading, patch decomposition.
- **`@atscript/db-sql-tools`** — Shared `SqlDialect` interface, `buildSelect`/`buildInsert`/`buildUpdate`/`buildDelete`, MongoDB-style filter-to-SQL translation via `createFilterVisitor()`, aggregate query builders.
- **SQL adapters** (`db-sqlite`, `db-postgres`, `db-mysql`) — Each extends `BaseDbAdapter`, adds dialect-specific SQL generation and schema sync. PostgreSQL adds pgvector/HNSW/CITEXT support; SQLite adds FTS5/collation; MySQL adds VECTOR/FULLTEXT.
- **`@atscript/db-mongo`** — Standalone adapter using native MongoDB aggregation pipelines. `CollectionPatcher` converts patch payloads into `$set` aggregation stages. Atlas Search support for text and vector indexes.
- **`@atscript/moost-db`** — `AsDbController` and `AsDbReadableController` auto-generate REST CRUD endpoints with URL query filtering, pagination, and relation loading via Moost decorators.

## Common Commands

```bash
vp install                    # Install dependencies (always run first)
vp check                      # Format + lint + type-check
vp run test -r                # Run all tests across packages
vp run build -r               # Build all packages
vp run ready -r               # Full validation: fmt + lint + test + build

# Single package
vp run test -r --filter @atscript/db-sqlite
vp pack --watch               # Watch-mode library build (from package dir)

# Release
vp run release                # Patch bump, build, test, publish
vp run release:minor          # Minor bump
vp run release:major          # Major bump
```

## Testing

Tests use Vitest via Vite+. Import test utilities from `vite-plus/test`, **not** `vitest`:

```typescript
import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
```

Test files live in `src/__test__/` directories within each package as `*.spec.ts`. Atscript `.as` model fixtures are compiled at test time via `prepareFixtures()` in `beforeAll`.

## Key Conventions

- **Imports**: Use `vite-plus` for all Vite/Vitest imports. Use `@atscript/*` package names in source (resolved via `tsconfig.base.json` path mappings during development).
- **Each adapter package** has its own `vite.config.ts` with `unplugin-atscript` for `.as` file compilation and `pack` config for ESM + CJS output with DTS.
- **Generated files** (`*.as.d.ts`, `atscript.d.ts`) are auto-generated — do not hand-edit. Formatting ignores these files.
- **Adapters are independent**: only share code through `db-sql-tools`. All DB-facing logic belongs in adapters, not in core.
- **MongoDB indexes** use the `atscript__` prefix. `syncIndexes()` only manages indexes with this prefix.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
