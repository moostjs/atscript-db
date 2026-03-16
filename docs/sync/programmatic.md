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

| Option           | Type      | Default     | Description                                                                   |
| ---------------- | --------- | ----------- | ----------------------------------------------------------------------------- |
| `force`          | `boolean` | `false`     | Ignore hash check, always introspect the database                             |
| `safe`           | `boolean` | `false`     | Skip destructive operations (column drops, table drops)                       |
| `podId`          | `string`  | Random UUID | Identifier for distributed locking                                            |
| `lockTtlMs`      | `number`  | `30000`     | Lock time-to-live in milliseconds. A heartbeat extends the lock every `ttl/3` |
| `waitTimeoutMs`  | `number`  | `60000`     | Max wait time for another pod's lock                                          |
| `pollIntervalMs` | `number`  | `500`       | Poll interval when waiting for lock release                                   |

The `plan()` method accepts only `force` and `safe`.

## TSyncPlan

Returned by `sync.plan()`:

```typescript
interface TSyncPlan {
  status: "up-to-date" | "changes-needed";
  schemaHash: string;
  entries: SyncEntry[];
}
```

When `status` is `'up-to-date'`, the entries still list all tables/views with their `'in-sync'` status — useful for displaying a full schema overview.

## TSyncResult

Returned by `sync.run()` and `syncSchema()`:

```typescript
interface TSyncResult {
  status: "up-to-date" | "synced" | "synced-by-peer";
  schemaHash: string;
  entries: SyncEntry[];
}
```

| Status             | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `'up-to-date'`     | Schema hash matched, no sync needed                                    |
| `'synced'`         | This process applied changes                                           |
| `'synced-by-peer'` | Another process completed sync while this one was waiting for the lock |

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

  // Computed properties
  destructive: boolean; // involves drops, type changes, or recreation
  hasChanges: boolean; // status is not 'in-sync' or 'error'
  hasErrors: boolean; // status is 'error' or errors array is non-empty
}
```

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
    // Another pod took the lock during sync (e.g., after a network partition)
    // The heartbeat detected the ownership change and aborted
  }
  // Other errors: DB connection issues, DDL failures
}
```

Schema-level errors (rename conflicts, type changes without sync method) don't throw — they appear as entries with `status: 'error'` and populated `errors` arrays.

## Exported Utilities

The `@atscript/db/sync` sub-entry exports additional utilities for advanced use cases:

| Export                        | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `SchemaSync`                  | Full sync class with `plan()` and `run()`             |
| `SyncEntry`                   | Entry class with computed properties                  |
| `syncSchema()`                | One-liner convenience function                        |
| `readStoredSnapshot()`        | Read a table's stored snapshot from the control table |
| `computeColumnDiff()`         | Compute column diff between desired and existing      |
| `computeTableOptionDiff()`    | Compute table option diff                             |
| `computeSchemaHash()`         | Compute FNV-1a hash from snapshots                    |
| `computeTableSnapshot()`      | Build a snapshot from a table's metadata              |
| `computeViewSnapshot()`       | Build a snapshot from a view's metadata               |
| `computeForeignKeyDiff()`     | Compute FK diff between desired and stored            |
| `snapshotToExistingColumns()` | Convert a stored snapshot to existing column format   |

These are primarily useful for building custom sync UIs, debugging, or extending the sync system.

## Next Steps

- [CI/CD Integration](./ci-cd) — deployment strategies and pipeline examples
- [What Gets Synced](./what-gets-synced) — detailed change categories
- [How Sync Works](./) — architecture and internals
