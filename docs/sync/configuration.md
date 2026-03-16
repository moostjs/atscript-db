---
outline: deep
---

# Configuration

<!--@include: ../_experimental-warning.md-->

Schema sync reads its database connection from the `db` section of your `atscript.config.mts`. This page covers all configuration options.

## Config File Setup

Add a `db` section to your `atscript.config.mts`:

```typescript
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";

export default defineConfig({
  rootDir: "src",
  plugins: [ts(), dbPlugin()],
  format: "dts",
  db: {
    adapter: "@atscript/db-sqlite",
    connection: "./myapp.db",
  },
});
```

::: info
`dbPlugin()` is required to register `@db.*` annotations. The full base config is covered in [Setup](/guide/setup). This page focuses on the `db` section only.
:::

## Declarative Config

The declarative format specifies the adapter package and connection:

```typescript
db: {
  adapter: '@atscript/db-sqlite',
  connection: './myapp.db',
}
```

| Option       | Type                      | Description                                                         |
| ------------ | ------------------------- | ------------------------------------------------------------------- |
| `adapter`    | `string`                  | Package name of the DB adapter (e.g., `'@atscript/db-sqlite'`)      |
| `connection` | `string \| () => string`  | Connection string, file path, or factory function                   |
| `options`    | `Record<string, unknown>` | Additional options passed to `createAdapter()`                      |
| `include`    | `string[]`                | Glob patterns for `.as` files to include (overrides root `include`) |
| `exclude`    | `string[]`                | Glob patterns for `.as` files to exclude (overrides root `exclude`) |

The CLI resolves the adapter by importing the package and calling its `createAdapter(connection, options)` function.

### Connection strings by adapter

| Adapter                 | Example Connection                                                  |
| ----------------------- | ------------------------------------------------------------------- |
| `@atscript/db-sqlite`   | `'./data.db'` or `':memory:'`                                       |
| `@atscript/db-postgres` | `'postgresql://user:pass@localhost:5432/mydb'`                      |
| `@atscript/db-mysql`    | `{ host: 'localhost', port: 3306, user: 'root', database: 'mydb' }` |
| `@atscript/db-mongo`    | `'mongodb://localhost:27017/mydb'`                                  |

### Dynamic connection

The `connection` option can be a function that returns a connection string. This is useful for reading environment variables or secrets at sync time:

```typescript
db: {
  adapter: '@atscript/db-postgres',
  connection: () => process.env.DATABASE_URL!,
}
```

## Callback Config

For full control, pass a callback that returns a configured `DbSpace`:

```typescript
import { DbSpace } from "@atscript/db";
import { PostgresAdapter, PgDriver } from "@atscript/db-postgres";

export default defineConfig({
  // ...
  db: async () => {
    const driver = new PgDriver({
      connectionString: process.env.DATABASE_URL,
      max: 5,
    });
    return new DbSpace(() => new PostgresAdapter(driver));
  },
});
```

This bypasses adapter auto-resolution entirely — you construct the `DbSpace` yourself with any driver configuration you need.

## Scoping Sync to Specific Files

Use `include` and `exclude` to control which `.as` files are compiled for sync. This is useful when your project has `.as` files that aren't database tables (e.g., validation-only types):

```typescript
db: {
  adapter: '@atscript/db-sqlite',
  connection: './myapp.db',
  include: ['src/db/**/*.as'],
  exclude: ['src/db/deprecated/**'],
}
```

When omitted, sync compiles all `.as` files matching the root config's patterns and extracts types with `@db.table` or `@db.view` annotations.

## Environment-Based Config

Use standard Node.js environment detection for different sync settings:

```typescript
const isProd = process.env.NODE_ENV === "production";

export default defineConfig({
  // ...
  db: {
    adapter: "@atscript/db-postgres",
    connection: isProd ? process.env.DATABASE_URL! : "postgresql://localhost:5432/myapp_dev",
  },
});
```

::: tip
For production deployments, consider using the [programmatic API](./programmatic) instead of the CLI. This gives you full control over sync options, error handling, and integration with your deployment pipeline.
:::

## Lock Configuration

The distributed lock parameters (`lockTtlMs`, `waitTimeoutMs`, `pollIntervalMs`) are not available in the config file — they use sensible defaults (30s TTL, 60s wait, 500ms poll). A background heartbeat automatically extends the lock every `ttl/3` while sync is in progress, so you do not need to set `lockTtlMs` high enough to cover the worst-case sync duration — only high enough to survive a few missed heartbeat cycles.

To customize lock parameters, use the [programmatic API](./programmatic):

```typescript
import { syncSchema } from "@atscript/db/sync";

await syncSchema(db, types, {
  lockTtlMs: 60_000, // 60s lock TTL — heartbeat extends every 20s
  waitTimeoutMs: 120_000, // 2 minute wait
  pollIntervalMs: 1000, // 1s poll interval
});
```

## Next Steps

- [CLI](./cli) — command-line usage and flags
- [Programmatic API](./programmatic) — using sync from code
- [CI/CD Integration](./ci-cd) — deployment strategies
