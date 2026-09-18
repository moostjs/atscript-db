---
outline: deep
---

# Programmatic API

<!--@include: ../_experimental-warning.md-->

You can run schema sync from your own code using the `syncSchema` convenience function or the `SchemaSync` class directly. This is useful for application startup, custom deployment scripts, and CI/CD integration.

## Quick Start

The simplest way to sync your schema:

```typescript
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";
import { User, Post, Comment } from "./schema/index.as.js";

const db = new DbSpace(adapterFactory);

const result = await syncSchema(db, [User, Post, Comment]);
console.log(result.status); // 'up-to-date' | 'synced' | 'synced-by-peer'
```

`syncSchema` is a one-liner that creates a `SchemaSync` instance and calls `run()`. It handles locking, hashing, diffing, and DDL execution in a single call.

## SchemaSync Class

For more control, use the `SchemaSync` class directly. It provides separate `plan()` and `run()` methods:

```typescript
import { SchemaSync } from "@atscript/db/sync";

const sync = new SchemaSync(db);

// Plan first — see what would change without applying
const plan = await sync.plan(types);
console.log(plan.status); // 'up-to-date' | 'changes-needed'

for (const entry of plan.entries) {
  console.log(entry.name, entry.status, entry.destructive);
}

// Then run — apply changes with distributed locking
const result = await sync.run(types, { force: true, safe: false });
console.log(result.status); // 'up-to-date' | 'synced' | 'synced-by-peer'
```

The constructor accepts an optional logger:

```typescript
const sync = new SchemaSync(db, console);
```

## TSyncOptions

Options for both `syncSchema()` and `sync.run()`:

| Option           | Type             | Default      | Description                                                       |
| ---------------- | ---------------- | ------------ | ----------------------------------------------------------------- |
| `force`          | `boolean`        | `false`      | Ignore hash check, always introspect the database                 |
| `safe`           | `boolean`        | `false`      | Skip destructive operations (column drops, table drops)           |
| `podId`          | `string`         | Random UUID  | Identifier for distributed locking                                |
| `lockTtlMs`      | `number`         | `30000`      | Lock time-to-live in milliseconds (auto-extended while sync runs) |
| `waitTimeoutMs`  | `number`         | `60000`      | Max wait time for another pod's lock                              |
| `pollIntervalMs` | `number`         | `500`        | Poll interval when waiting for lock release                       |
| `logger`         | `TGenericLogger` | `NoopLogger` | Logger for sync progress and failures (see below)                 |

The `plan()` method accepts only `force` and `safe`.

::: warning Pass a logger in production
Index and FK sync failures (e.g. a unique index over data that already contains duplicates) do **not** throw — they are logged, recorded on the entry (`status: 'error'`, `errors: [...]`), and the schema hash is not persisted so the next boot retries. With the default `NoopLogger` those log lines go nowhere. Pass `{ logger: console }` to `syncSchema()` (or `new SchemaSync(db, console)`) so they surface, or inspect `result.entries` for errored tables after every run.
:::

## TSyncPlan

Returned by `sync.plan()`:

```typescript
interface TSyncPlan {
  status: "up-to-date" | "changes-needed";
  schemaHash: string;
  entries: SyncEntry[];
}
```

When `status` is `'up-to-date'`, the entries still list all tables/views (normally `'in-sync'`) — useful for displaying a full schema overview. The `safe` option is honoured here too (since 0.1.128): a table or view that an earlier safe run retained shows as a pending `drop` unless `safe` is set.

## TSyncResult

Returned by `sync.run()` and `syncSchema()`:

```typescript
interface TSyncResult {
  status: "up-to-date" | "synced" | "synced-by-peer" | "refused";
  schemaHash: string;
  entries: SyncEntry[];
}
```

| Status             | Meaning                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'up-to-date'`     | Schema hash matched, no sync needed                                                                                                                                                            |
| `'synced'`         | This process applied changes                                                                                                                                                                   |
| `'synced-by-peer'` | Another process completed sync while this one was waiting for the lock                                                                                                                         |
| `'refused'`        | Pre-flight refused the run (since 0.1.128): **no DDL ran**, nothing was persisted, the lock was released. `entries` is the full plan; refused entries are `error` entries with `refused: true` |

`'refused'` follows the `onError` policy like error entries do — `"warn"` (default) logs each refusal at error level and returns, `"throw"` throws after the lock is released, `"silent"` returns. `plan()` reports the same refusals with its status unchanged (`'changes-needed'`).

## SyncEntry

Each entry in the plan/result represents a table or view:

```typescript
interface SyncEntry {
  name: string;
  status: "create" | "alter" | "drop" | "in-sync" | "error";
  viewType?: "V" | "M" | "E"; // V=virtual, M=materialized, E=external

  // Plan fields — what will change
  columnsToAdd: TDbFieldMeta[];
  columnsToRename: Array<{ from: string; to: string }>;
  typeChanges: Array<{ column: string; fromType: string; toType: string }>;
  nullableChanges: Array<{ column: string; toNullable: boolean }>;
  defaultChanges: Array<{ column: string; oldDefault?: string; newDefault?: string }>;
  columnsToDrop: string[];
  optionChanges: Array<{ key: string; oldValue: string; newValue: string; destructive: boolean }>;
  fkAdded: Array<{ fields: string[]; targetTable: string }>;
  fkRemoved: Array<{ fields: string[]; targetTable: string }>;
  fkChanged: Array<{ fields: string[]; targetTable: string; details: string }>;

  // Result fields — what was applied
  columnsAdded: string[];
  columnsRenamed: string[];
  columnsDropped: string[];
  recreated: boolean;
  errors: string[];
  renamedFrom?: string;

  // Since 0.1.128
  pkChange?: { from: string[]; to: string[]; rebuild: boolean }; // primary-key field set change; rebuild=false when safe mode skipped it
  dependsOn: string[]; // tables this entry's DDL waits for (FK parents / view sources / referencing children of a drop)
  dropGroup?: string[]; // set when a foreign-key cycle is dropped as one group
  refused: boolean; // this `error` entry is a pre-flight refusal — no DDL ran
  toInit(): TSyncEntryInit; // the init object, for deriving a modified copy

  // Computed properties
  destructive: boolean; // involves drops, type changes, recreation, or a primary-key rebuild
  hasChanges: boolean; // status is not 'in-sync' or 'error'
  hasErrors: boolean; // status is 'error' or errors array is non-empty
}
```

Entries come back in **execution order** — tables parents-first, then views, then drops children-first — identically from `plan()` and `run()`. Safe mode is reported identically as well: a skipped primary-key rebuild is `pkChange: { from, to, rebuild: false }` in both (printed `! PK … — skipped (safe mode)`, not destructive).

## Plan-Then-Decide Pattern

Use `plan()` to inspect changes before deciding whether to apply:

```typescript
const sync = new SchemaSync(db);
const plan = await sync.plan(types);

if (plan.status === "up-to-date") {
  console.log("Nothing to do");
  return;
}

// Check for destructive changes
const hasDestructive = plan.entries.some((e) => e.destructive);
if (hasDestructive) {
  console.log("Destructive changes detected:");
  for (const entry of plan.entries.filter((e) => e.destructive)) {
    console.log(`  ${entry.name}: ${entry.status}`);
    for (const col of entry.columnsToDrop) {
      console.log(`    - drop column: ${col}`);
    }
  }
  // Require explicit approval in production
  if (!approved) return;
}

// Apply with force to skip hash check (we already know changes are needed)
const result = await sync.run(types, { force: true });
```

## Integration with Application Startup

A common pattern is to sync on startup in development and skip in production:

```typescript
const db = new DbSpace(adapterFactory);

if (process.env.NODE_ENV !== "production") {
  const { syncSchema } = await import("@atscript/db/sync");
  await syncSchema(db, allTypes);
}
```

The hash check makes this very cheap when nothing has changed — only a lightweight control table read occurs, skipping all schema introspection and DDL.

## Error Handling

Sync can fail for several reasons:

```typescript
try {
  await syncSchema(db, types);
} catch (error) {
  if (error.message.includes("lock wait timed out")) {
    // Another process holds the lock and didn't release in time
    // Increase waitTimeoutMs or investigate the other process
  }
  if (error.message.includes("Failed to acquire")) {
    // Lock acquisition failed after waiting
  }
  if (error.message.includes("lock was stolen")) {
    // Another pod took over the lock mid-sync — the current sync aborted safely.
    // Usually transient (network partition recovery). Retry or rely on `synced-by-peer`.
  }
  // Other errors: DB connection issues, DDL failures
}
```

Schema-level errors don't throw — they appear as entries with `status: 'error'` and populated `errors` arrays: rename conflicts, type changes without a sync method and, since 0.1.129, any DDL the engine refuses inside a table's step (`<phase> failed on <table>: …` — the run completes and the other tables are persisted; see [What triggers `error` status](./index.md#what-triggers-error-status)). What still rejects `run()` is what happens outside a table's DDL: lock problems, a connection failure, an error during discovery.

Error entries have retry semantics: the schema hash and the errored table's snapshot are **not** persisted, so the next `run()` (or application boot) attempts the same changes again instead of reporting `'up-to-date'` over a diverged schema. Once the underlying conflict is resolved (data cleaned up, annotation fixed), the retry converges and the hash settles:

```typescript
const result = await syncSchema(db, types);
const failed = result.entries.filter((e) => e.hasErrors);
for (const entry of failed) {
  console.error(`${entry.name}: ${entry.errors.join("; ")}`);
}
// failed entries re-attempt on every subsequent run until they succeed
```

## Printing the Plan

`SyncEntry` instances render themselves to coloured terminal output via `entry.print(mode, colors?)` — `mode` is `'plan'` (preview) or `'result'` (after `run()`). It returns an array of lines you can `console.log` directly:

```typescript
const plan = await sync.plan(types);
for (const entry of plan.entries) {
  for (const line of entry.print("plan")) {
    console.log(line);
  }
}
```

Pass a colour adapter (matching the `TSyncColors` shape — `green/red/cyan/yellow/bold/dim/underline`) as the second argument to control styling. Omit it for plain text output suitable for logs.

## Exported Utilities

The `@atscript/db/sync` sub-entry exports the building blocks used by the CLI:

| Export         | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `SchemaSync`   | Full sync class with `plan()` and `run()`              |
| `SyncEntry`    | Plan/result entry with `print()` and computed flags    |
| `syncSchema()` | One-liner convenience: `new SchemaSync(db).run(types)` |

Lower-level diff/snapshot helpers are also exported for building custom dashboards or sync UIs — consult the package source if you need them.

## Next Steps

- [CI/CD Integration](./ci-cd) — deployment strategies and pipeline examples
- [What Gets Synced](./what-gets-synced) — detailed change categories
- [How Sync Works](./) — architecture and internals
