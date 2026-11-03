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

| Option           | Type             | Default      | Description                                                                                                                                                 |
| ---------------- | ---------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `force`          | `boolean`        | `false`      | Ignore hash check, always introspect the database                                                                                                           |
| `safe`           | `boolean`        | `false`      | Skip destructive operations (column drops, table drops)                                                                                                     |
| `podId`          | `string`         | Random UUID  | Identifier for distributed locking                                                                                                                          |
| `lockTtlMs`      | `number`         | `30000`      | Lock time-to-live in milliseconds (auto-extended while sync runs)                                                                                           |
| `waitTimeoutMs`  | `number`         | `60000`      | Max wait time for another pod's lock                                                                                                                        |
| `pollIntervalMs` | `number`         | `500`        | Poll interval when waiting for lock release                                                                                                                 |
| `logger`         | `TGenericLogger` | `NoopLogger` | Logger for sync progress and failures (see below)                                                                                                           |
| `dataSteps`      | `TDataStep[]`    | —            | One-time data steps run after the DDL, or before the constraints with `phase: "beforeConstraints"` (since 0.1.165 / 0.1.168, see [Data steps](#data-steps)) |

The `plan()` method accepts only `force`, `safe` and `dataSteps`.

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
  pendingDataSteps?: string[]; // since 0.1.165, when dataSteps were passed
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
  dataSteps?: { ran: string[]; pending: string[] }; // since 0.1.165, when dataSteps were passed
}
```

| Status             | Meaning                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'up-to-date'`     | Schema hash matched, no sync needed                                                                                                                                                            |
| `'synced'`         | This process applied changes                                                                                                                                                                   |
| `'synced-by-peer'` | Another process completed sync while this one was waiting for the lock (never for a `force` run)                                                                                               |
| `'refused'`        | Pre-flight refused the run (since 0.1.128): **no DDL ran**, nothing was persisted, the lock was released. `entries` is the full plan; refused entries are `error` entries with `refused: true` |

`'refused'` follows the `onError` policy like error entries do — `"warn"` (default) logs each refusal at error level and returns, `"throw"` throws after the lock is released, `"silent"` returns. `plan()` reports the same refusals with its status unchanged (`'changes-needed'`).

## Data steps {#data-steps}

Schema sync changes structure only — it never backfills existing rows (a new `@db.default` applies to new rows). For a one-time data change that belongs to a schema change, pass it as a data step (since 0.1.165):

```typescript
await syncSchema(db, types, {
  dataSteps: [
    {
      id: "2026-10-users-tier", // stable and unique — the step is recorded under it
      async run(space) {
        await space.getTable(User).updateMany({ tier: null }, { tier: 3 });
      },
    },
  ],
});
```

- Steps run **in order, after the DDL, under the sync lock** — also when the schema itself is up to date, so a step added later runs on the next sync.
- Each step runs **once per database**: it runs in its own transaction (on adapters with transactions), together with its record in `__atscript_control` (`data_step:<id>`). A step that throws is rolled back and not recorded; the sync throws its error after releasing the lock, the steps after it stay pending, and the next sync runs it again.
- Steps do not run when the sync is `'refused'` or an entry errored.
- `result.dataSteps` reports `{ ran, pending }`; `plan()` reports `pendingDataSteps`, and a pending step makes the plan `'changes-needed'`.
- Never change what a recorded step does — add a new step with a new id. Duplicate or empty ids throw.

### Fix rows before a new constraint {#data-steps-before-constraints}

A new `@db.index.unique` or `@db.rel.FK` cannot be created over rows that break it, and a default step runs after the DDL — too late to merge the duplicates first. Give the step `phase: "beforeConstraints"` (since 0.1.168):

```typescript
await syncSchema(db, types, {
  dataSteps: [
    {
      id: "2026-11-merge-duplicate-codes",
      phase: "beforeConstraints",
      async run(space) {
        // the tables and their new columns exist; the new unique index does not yet
        await mergeDuplicateCodes(space.getTable(Product));
      },
    },
  ],
});
```

- A `beforeConstraints` step runs after every table and its new columns exist, before any table's indexes and foreign keys are synced; views are not synced yet either.
- All `beforeConstraints` steps run before the `"after"` (default) ones. When the schema is already up to date they simply run first.
- A `beforeConstraints` step that throws (rolled back, not recorded) stops the run there. What the run already applied — renamed and created tables, new columns — is recorded; every table still waiting for its indexes and foreign keys gets an `error` entry (`Data step "<id>" failed: …`), views are not synced (a view this run dropped to change it stays dropped), removed tables are not dropped, and the schema hash is withheld. The sync then throws the step's error after releasing the lock. The next sync picks up from there: it runs the step again and applies the constraints and views. A renamed table is not renamed twice: when the old name is gone and the new one exists, the adapters treat the rename as done.
- On SQLite a new foreign key rebuilds the table during the DDL, **before** the step runs — the rows are copied with foreign-key checks off, and SQLite never checks existing rows against a new constraint. Dangling references survive that rebuild, so clear them in the step anyway. The step still runs before the new unique indexes. Other values of `phase` throw.

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
  pkChange?: { from: string[]; to: string[]; rebuild: boolean; populated?: boolean }; // primary-key field set change; rebuild=false when safe mode skipped it; populated=true when the table has rows (since 0.1.155)
  dependsOn: string[]; // tables and views this entry's DDL waits for (FK parents / view sources / referencing children of a drop)
  dropGroup?: string[]; // set when a foreign-key cycle is dropped as one group
  refused: boolean; // this `error` entry is a pre-flight refusal — no DDL ran
  skipped: ReadonlyArray<
    "pk-rebuild" | "recreate" | "table-options" | "nullable-defaults" | "derived"
  >; // work safe mode skipped ('derived' since 0.1.141)
  toInit(): TSyncEntryInit; // the init object, for deriving a modified copy

  // Since 0.1.141
  derivedChanges: Array<{
    column: string;
    reason: "kind" | "expression" | "type";
    derived: boolean;
  }>; // derived-column rebuilds (drop + add)
  cascadeFrom: string[]; // upstream views whose recreation recreates this unchanged view

  // Since 0.1.162
  definitionChanged: boolean; // a managed view whose own definition changed (the reason it is recreated)
  indexChanges: Array<{ name: string; action: "add" | "drop" | "rebuild" }>; // managed index work on an existing table: planned (plan) or done (run); empty for a created or recreated table

  // Computed properties
  destructive: boolean; // involves drops, type changes, recreation, or a primary-key rebuild
  hasChanges: boolean; // status is not 'in-sync' or 'error'
  hasErrors: boolean; // status is 'error' or errors array is non-empty
  pending: boolean; // (since 0.1.128) desired work not applied — an `error` entry (not an external view) or non-empty `skipped`
}
```

Entries come back in **execution order** — tables parents-first, then views, then drops children-first — identically from `plan()` and `run()`. Safe mode is reported identically as well: a skipped primary-key rebuild is `pkChange: { from, to, rebuild: false }` in both (printed `! PK … — skipped (safe mode)`, not destructive). What each `skipped` value means and why a `pending` entry withholds its snapshot and the schema hash is covered in [Safe Mode](./index.md#safe-mode).

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
  if (error.message.includes("lock was stolen")) {
    // Another pod took over the lock mid-sync — the current sync aborted safely.
    // Usually transient (network partition recovery). Retry or rely on `synced-by-peer`.
  }
  // Other errors: DB connection issues (also while taking the lock), DDL failures
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

A `'result'` entry with status `alter` lists every change the run applied. Since 0.1.162 that includes in-place type, nullability and default changes and foreign keys, which earlier releases recorded only on plan entries (or when safe mode skipped them):

```
  ~ invoices — altered
      ~ amount: DOUBLE → decimal — type changed
      ~ amount — default 0.00 → 0
      + FK(teamId) → teams — added
```

An `alter` entry is never printed as `— in sync`. A foreign key that is only added makes the run entry `alter` too, as the plan already reported. A managed view whose own definition changed prints `· definition changed`, and its entry has `definitionChanged: true`.

## Syncing a module namespace

A compiled `.as` module exports more than its tables — helper interfaces, `@db.alias` types, plain type aliases. `isDbEntityType` (from `@atscript/db`, since 0.1.141) keeps only what a `DbSpace` accepts: types whose own declaration carries `@db.table`, `@db.view` or `@db.view.for`. A plain `export type Admin = User` is `User` itself (since `@atscript/typescript` 0.2), so it passes too; the sync lists and hashes each type once, however many export names it has. It turns a namespace into an inventory:

```typescript
import { isDbEntityType } from "@atscript/db";
import * as models from "./schema/index.as.js";

await syncSchema(db, Object.values(models).filter(isDbEntityType));
```

A `@db.alias` type in the list is skipped by the sync itself; any other non-entity type would be synced as a table named after its type id, so filter first. The [generated model manifest](./model-manifest) applies the same selection at build time.

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
