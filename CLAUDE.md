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

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ built-in commands (`vp dev`, `vp build`, `vp test`, etc.) always run the Vite+ built-in tool, not any `package.json` script of the same name. To run a custom script that shares a name with a built-in command, use `vp run <script>`. For example, if you have a custom `dev` script that runs multiple services concurrently, run it with `vp run dev`, not `vp dev` (which always starts Vite's dev server).
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
<!--VITE PLUS END-->
