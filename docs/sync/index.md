---
outline: deep
---

# How Schema Sync Works

<!--@include: ../_experimental-warning.md-->

Schema sync compares your `.as` definitions against the live database and generates DDL to bring them in sync. There are no migration files to write, review, or track — your `.as` files _are_ the schema, and `asc db sync` brings the database in line with them.

## When to Use Schema Sync

Schema sync fits naturally into every stage of your workflow:

- **Development** — run sync on application startup. The hash check makes it effectively free when nothing has changed, so you can call it on every boot without penalty.
- **Staging** — use `--dry-run` to preview the planned changes, then apply with `--yes` after review.
- **Production** — integrate into your CI/CD pipeline. Use `--safe` to block destructive changes and require manual approval for anything beyond additive modifications.

::: tip
Because sync is hash-gated, calling it on every deployment or application startup adds negligible overhead when the schema has not changed. There is no need to conditionally skip it.
:::

## Architecture

The sync pipeline follows a deterministic sequence of steps:

```
.as files → compile → hash → compare → lock → introspect → diff → apply → store hash
```

Each step has a specific role in ensuring safe, repeatable schema updates:

1. **Compile** — your `.as` files are compiled into annotated types with full metadata: field names, types, nullability, defaults, primary keys, [indexes](/api/indexes), [foreign keys](/relations/), view definitions, and adapter-specific table options.

2. **Hash** — a deterministic FNV-1a hash is computed from the entire schema structure. All tables, views, and their complete metadata are serialized into a canonical JSON form (fields sorted alphabetically, indexes sorted by key), then hashed.

3. **Compare** — the computed hash is compared against the stored hash from the last successful sync. If they match, sync exits immediately with an `up-to-date` status — no lock acquisition, no schema introspection, no DDL. (The hash read itself requires a lightweight query to the control table.)

4. **Lock** — a distributed lock is acquired in the `__atscript_control` table. This prevents concurrent sync operations across multiple application instances (see [Distributed Locking](#distributed-locking) below).

5. **Introspect** — the adapter reads the current database schema. The strategy depends on adapter capabilities: live column introspection, snapshot comparison, or existence check (see [Sync Execution Paths](#sync-execution-paths) below).

6. **Diff** — the desired schema (from `.as` files) is compared against the existing schema (from introspection) to produce a detailed set of changes: columns to add, rename, or drop; type mismatches; nullable changes; default value changes; foreign key changes; index changes; and table option drift.

7. **Apply** — DDL statements are executed to bring the database in line with the desired schema. Tables are synced first (in definition order), then managed views, then external views are validated. Removed tables and views are dropped last (unless safe mode is active).

8. **Store hash** — the new schema hash, per-table snapshots, and updated tracked-tables list are written to the control table. The lock is released in a `finally` block to ensure cleanup even if an error occurs.

### Processing Order

Within the apply step, sync processes objects in a specific order to respect dependencies:

1. **Tables** — synced first, one at a time in definition order. Each table goes through its full lifecycle: rename check, column diff, column sync, index sync, foreign key sync, and post-sync finalization.
2. **Managed views** — synced after all tables, since views may reference tables that were just created or altered.
3. **External views** — validated (existence and column checks) but never modified.
4. **Removed objects** — tables and views that are no longer in the schema are dropped last, and only if safe mode is not active. External views are never dropped.

After all objects are processed, per-table snapshots are written for every tracked table and view, old snapshots from renamed objects are cleaned up, and the tracked-tables list is updated.

## The Control Table

Schema sync automatically creates and maintains a table called `__atscript_control` in your database. This table uses a simple key-value structure (an `_id` string key and a `value` string column) to store all sync state.

The following keys are used:

| Key                     | Purpose                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `schema_version`        | The FNV-1a hash of the full schema from the last successful sync                       |
| `sync_lock`             | Distributed lock entry with `lockedBy`, `lockedAt`, and `expiresAt` fields             |
| `synced_tables`         | JSON array of all tracked tables and views with their names and types                  |
| `table_snapshot:<name>` | Per-table snapshot storing field definitions, indexes, foreign keys, and table options |

The control table is created automatically on the first sync — you never need to create it manually. Each adapter creates it using its own DDL (e.g., `CREATE TABLE` for SQL adapters, collection creation for MongoDB).

::: tip
The control table uses the same adapter as the rest of your schema. It works identically across SQLite, PostgreSQL, MySQL, and MongoDB. You should not modify its contents manually.
:::

### Table Snapshots

Per-table snapshots are the most detailed entries in the control table. Each snapshot captures:

- **Fields** — physical name, design type, adapter-mapped type (e.g., `VARCHAR(255)`), nullability, primary key flag, storage type, default value
- **Indexes** — index key, type (e.g., `unique`, `fulltext`), and field list with sort direction
- **Foreign keys** — source fields, target table, target fields, `onDelete` and `onUpdate` actions
- **Table options** — adapter-specific settings (e.g., MySQL `engine`, `charset`, `collation`)

Snapshots are stored as serialized JSON and are used by both the hash computation and the snapshot-based sync path (Path B).

## Hash-Based Drift Detection

Schema sync uses FNV-1a (Fowler-Noll-Vo) hashing to detect whether anything has changed since the last sync. FNV-1a is a fast, non-cryptographic hash chosen for its speed and low collision rate — it is not used for security, only for change detection.

The hash is computed from the full schema structure. Every element contributes:

- Field names, design types, and adapter-mapped types
- Nullability and primary key flags
- Default values (both literal values and function-based defaults like `now()`)
- Index definitions (key, type, fields, sort directions)
- Foreign key constraints (source fields, target table, target fields, cascade actions)
- View definitions (entry table, joins, filter hash, materialized flag)
- Table options (engine, charset, collation, etc.)

All data is sorted deterministically before hashing — fields by physical name, indexes by key, foreign keys by field list — so the hash is stable across runs regardless of definition order in the `.as` files.

### The Sync Lifecycle

On each sync, the hash check follows this sequence:

1. Compute hash from all current `.as` definitions
2. Read the stored hash from `schema_version` in `__atscript_control`
3. If they match, return `up-to-date` immediately — no schema introspection, no DDL, no lock acquisition
4. If they differ (or `--force` is used), proceed with locking, introspection, and diffing

When sync completes successfully, the new hash is written to `schema_version`. This means the next sync will exit at step 3 — making repeated syncs on an unchanged schema essentially free.

Use `--force` to bypass the hash check and introspect the database regardless. This is useful when the database was modified outside of schema sync (manual DDL, another tool, a database migration from a different system).

## Distributed Locking

When multiple instances of your application start simultaneously (e.g., Kubernetes pods, serverless cold starts, or parallel CI runners), schema sync uses a distributed lock to prevent concurrent migrations.

### Lock Flow

The locking protocol works as follows:

1. **Quick hash check** — before attempting to acquire the lock, the instance checks if the stored hash already matches the desired hash. If it does, sync returns `up-to-date` without ever touching the lock.

2. **Lock acquisition** — the instance attempts to insert a lock row into `__atscript_control` with a unique `podId`, the current timestamp, and an expiration time (`lockedAt + lockTtlMs`). If the row already exists and has not expired, acquisition fails.

3. **Waiting** — if another instance holds the lock, the current instance enters a polling loop, checking the lock status at `pollIntervalMs` intervals. If the lock disappears (released by the holder) or expires (TTL exceeded), polling stops.

4. **Peer sync detection** — after waiting, the instance re-checks the stored hash. If another instance already synced and the hash now matches, the current instance returns `synced-by-peer` without performing any DDL. This is the common case in multi-pod deployments.

5. **Double-check** — if the hash still does not match after waiting, the instance acquires the lock and performs one final hash check (double-check pattern) before proceeding with the actual sync.

### Heartbeat

Once the lock is acquired, a background heartbeat automatically extends the lock's expiry every `ttl/3` (default: every 10 seconds). This ensures long-running syncs — large table recreations, many tables, slow adapters — never lose their lock mid-operation.

The heartbeat also provides **stolen-lock detection**. If another pod deletes the lock and acquires its own (e.g., after a network partition heals), the heartbeat detects the ownership change and aborts the current sync at the next safe checkpoint — between table operations, never mid-DDL. This prevents two pods from running conflicting DDL concurrently.

If a heartbeat refresh fails due to a transient DB error (connection hiccup, brief timeout), it logs a warning and retries on the next cycle. The remaining TTL provides a safety buffer — a single missed heartbeat does not cause an abort.

### Lock Safety

- **Lock TTL** (default: 30 seconds) — locks automatically expire after this duration. If a process crashes and the heartbeat stops, the lock expires naturally and other pods can proceed.
- **Heartbeat** (interval: `ttl/3`, minimum 1 second) — automatically extends the lock's expiry while sync is in progress. Long-running syncs are never interrupted by TTL expiry.
- **Stolen-lock abort** — if the heartbeat discovers another pod has taken the lock, sync throws at the next checkpoint (between table/view operations) rather than continuing with conflicting DDL.
- **Wait timeout** (default: 60 seconds) — if the lock is not released within this duration, the waiting instance throws an error rather than blocking indefinitely.
- **Cleanup** — the heartbeat is stopped and the lock is released in a `finally` block, ensuring cleanup even if the sync encounters an error.

::: info Lock Configuration
Lock parameters are configurable via the [programmatic API](./programmatic):

| Parameter        | Default     | Description                                                                 |
| ---------------- | ----------- | --------------------------------------------------------------------------- |
| `lockTtlMs`      | `30000`     | Lock time-to-live in milliseconds. Heartbeat interval is derived as `ttl/3` |
| `waitTimeoutMs`  | `60000`     | Max wait time for another pod's lock                                        |
| `pollIntervalMs` | `500`       | Poll interval when waiting for lock                                         |
| `podId`          | random UUID | Identifier for the current instance                                         |

:::

## Sync Execution Paths

Not all databases support the same level of schema introspection. Schema sync adapts its strategy based on what the adapter provides, choosing one of three execution paths for each table:

### Path A: Live Introspection

**Used by:** SQLite, PostgreSQL, MySQL

The adapter implements `getExistingColumns()`, which reads the actual column definitions from the database (e.g., `PRAGMA table_info` for SQLite, `information_schema` for MySQL/PostgreSQL). The desired schema is diffed against the live schema to produce precise, column-level changes.

This is the most accurate path. It detects changes even if they were made outside of schema sync — for example, if someone ran manual `ALTER TABLE` statements or used another migration tool.

For adapters that also support `getExistingTableOptions()` (e.g., MySQL), table-level option drift (engine, charset, collation) is detected via live introspection as well.

### Path B: Snapshot-Based

**Used by:** MongoDB

The adapter implements `syncColumns()` but lacks native column introspection (because MongoDB is schema-less at the database level). Instead of reading the live schema, sync compares the desired schema against the stored snapshot from the previous sync in `__atscript_control`.

This path relies on the snapshots being accurate. If the database was modified outside of schema sync (e.g., manual index creation in `mongosh`), those changes will not be detected. Use `--force` to trigger a full re-sync if you suspect drift.

On first sync (no stored snapshot), the adapter checks whether the collection exists. If it does not, it is created. If it does, sync assumes it is in its initial state.

### Path C: Schema-Less

**Used by:** adapters with `tableExists()` only

The adapter can only check whether a table or collection exists. If it does not exist, it is created via `ensureTable()`. No column-level diffing is performed — the adapter has no concept of column definitions at the database level.

This path is appropriate for truly schema-less stores where the structure exists only in the application layer.

### How Paths Are Selected

The execution path is selected automatically based on which methods the adapter implements. Sync checks capabilities in order:

1. If the adapter has both `getExistingColumns()` and `syncColumns()` → **Path A**
2. If the adapter has `syncColumns()` but no `getExistingColumns()` → **Path B**
3. If the adapter has `tableExists()` only → **Path C**

You do not need to configure the path — it is determined by the adapter you choose. Custom adapters can support any combination of these methods to control how sync interacts with them.

## Change Categories

Each table or view in the sync plan receives a status indicating what action will be taken:

| Status    | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `create`  | New table or view — will be created from scratch                            |
| `alter`   | Existing table or view — columns, indexes, FKs, or options will be modified |
| `drop`    | No longer in the schema — will be removed                                   |
| `in-sync` | No changes needed                                                           |
| `error`   | Conflicts detected that prevent sync                                        |

### What Triggers `error` Status

A sync entry is marked as `error` when sync cannot proceed safely:

- **Rename collision** — a `@db.column.renamed` annotation attempts to rename column `A` to `B`, but column `B` already exists in the database.
- **Type change without sync method** — a column's type changed (e.g., `TEXT` to `INTEGER`) but the table has no `@db.sync.method` annotation and the adapter does not support in-place column modification. Sync cannot determine whether to drop the table (`'drop'`) or recreate it with data preservation (`'recreate'`), so it flags the entry for manual resolution.

### Alter Details

For entries with `alter` status, the plan provides a detailed breakdown of changes:

- **Columns to add** — new fields with their types and constraints
- **Columns to rename** — old name to new name mappings (via [`@db.column.renamed`](./what-gets-synced))
- **Type changes** — column type mismatches requiring `@db.sync.method` or adapter support
- **Nullable changes** — fields changing between required and optional
- **Default changes** — updated default values
- **Columns to drop** — fields no longer in the schema
- **FK changes** — foreign keys added, removed, or modified (fields, target table, cascade actions)
- **Table option changes** — adapter-specific options (e.g., MySQL engine/charset)

::: danger Destructive Operations
Entries involving destructive operations — column drops, table drops, type changes requiring table recreation, or destructive table option changes — are flagged with a `destructive` marker in the sync plan. Always review these carefully before confirming, especially in staging and production environments.
:::

### Views

Views follow a simpler lifecycle than tables. They are categorized by type:

| View Type    | Label | Behavior                                                            |
| ------------ | ----- | ------------------------------------------------------------------- |
| Managed      | `[V]` | Created, dropped, and recreated by sync when the definition changes |
| Materialized | `[M]` | Like managed, but uses `CREATE MATERIALIZED VIEW` where supported   |
| External     | `[E]` | Validated (existence + column check) but never modified or dropped  |

When a managed view's definition changes (different entry table, joins, filter, or fields), sync drops the old view and recreates it. External views are never dropped by sync — even when they are removed from the schema. They are validated: if a declared external view is missing from the database, sync reports an `error` status.

## Safe Mode

The `--safe` flag suppresses all destructive operations during sync:

- Column drops are skipped
- Table and view drops are skipped
- Type changes that require table recreation are skipped
- Table option changes that require recreation are skipped
- Nullable and default changes that would require table recreation are skipped

Only additive and non-destructive changes are applied: new tables, new columns, column renames, index updates, and foreign key additions.

Safe mode is designed for production CI/CD pipelines where you want automatic sync for additive changes but want to manually review and approve any destructive operations.

```bash
# Safe mode in CI/CD — only additive changes applied automatically
npx asc db sync --safe --yes
```

::: warning
Safe mode does not prevent all data loss scenarios. Column renames are still applied (they preserve data), and new non-nullable columns without defaults may cause insert failures on existing rows. Use `--dry-run` alongside `--safe` to review the full plan before applying.
:::

## Sync Result Statuses

The `run()` method returns a result object with one of three statuses:

| Status           | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `up-to-date`     | Schema hash matched — no introspection or DDL was performed                 |
| `synced`         | Changes were detected and applied successfully                              |
| `synced-by-peer` | Another instance completed the sync while this one was waiting for the lock |

Both `up-to-date` and `synced-by-peer` are success statuses that indicate no work was needed by the current instance. The `synced` status includes a list of `SyncEntry` objects detailing what was changed.

## Next Steps

- [CLI](./cli) — command-line usage and flags
- [What Gets Synced](./what-gets-synced) — detailed change categories, renames, and structural changes
- [Configuration](./configuration) — config file setup
- [Programmatic API](./programmatic) — using sync from code
- [CI/CD Integration](./ci-cd) — deployment strategies
