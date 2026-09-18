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

## How It Works

```
.as files → compile → hash check → (if changed) lock → discover → pre-flight → execute → store hash
```

On every run, schema sync hashes the full compiled schema and compares against the hash from the last successful sync. If it matches, sync exits as `up-to-date` after a single lightweight read — no introspection, no DDL, no lock acquired. Otherwise it acquires a distributed lock in `__atscript_control` and runs three phases (since 0.1.128):

1. **Discover** (read-only) — introspects every table once (live columns on SQL adapters, the stored per-table snapshot on MongoDB), reads the tracked-object list, and builds the dependency graph from foreign keys and view definitions.
2. **Pre-flight** (pure validation) — every change that no order of DDL could apply safely becomes a [refusal](#pre-flight-refusals), and one refusal stops the whole run before any DDL.
3. **Execute** — in dependency order: stale and removed views first, then the live foreign keys that reference a primary key about to be rebuilt, then tables (parents before children; a foreign-key cycle is created with its constraints deferred; a removed table that references a table this run drops and recreates (`@db.sync.method 'drop'` on a type change, or a destructive table-option change) or whose primary key it rebuilds is dropped right before that table), then managed views and the external-view check, then the remaining removed tables (children before parents), then snapshots, tracking and the hash.

The only DDL that runs before pre-flight is `CREATE TABLE IF NOT EXISTS __atscript_control` — sync's own bookkeeping table.

The `__atscript_control` table is created and maintained automatically — you never need to touch it. It stores the current schema hash, the lock entry, the tracked-table list, and per-table snapshots used for diffing on snapshot-based adapters.

::: tip
Because the hash check skips all introspection and DDL when nothing has changed, repeated syncs (on every deployment, every cold start, every CI run) are essentially free.
:::

Use `--force` to bypass the hash check and re-introspect — useful when the database was modified outside of schema sync.

## Distributed Locking

When multiple instances of your application start simultaneously (Kubernetes rolling deploys, serverless cold starts, parallel CI runners), the distributed lock prevents concurrent migrations:

1. **Quick hash check** — if the stored hash matches, sync returns `up-to-date` without touching the lock.
2. **Lock acquisition** — the first instance writes a lock row to `__atscript_control` keyed by `podId`. Other instances wait, polling at `pollIntervalMs`.
3. **Peer sync detection** — after the holder finishes, waiting instances re-check the hash. If it now matches, they return `synced-by-peer` without running any DDL. This is the common case in multi-pod deployments.

A background heartbeat keeps the lock alive while sync runs, so long-running migrations don't lose their lock to TTL expiry. If a process crashes, the lock expires naturally and the next instance picks up.

::: info Lock knobs (programmatic only)
| Parameter | Default | When to change |
| ---------------- | ----------- | ------------------------------------------------------------------------------ |
| `lockTtlMs` | `30000` | Increase only if you expect heartbeat misses (very slow DB). 30s is plenty. |
| `waitTimeoutMs` | `60000` | Increase for large schemas or slow DBs where the first pod's sync takes long. |
| `pollIntervalMs` | `500` | Lower for faster startup races; higher to reduce DB load on the control table. |
| `podId` | random UUID | Set explicitly to make logs identifiable across restarts. |

See the [programmatic API](./programmatic) for usage.
:::

## Change Categories

Each table or view in the sync plan receives a status indicating what action will be taken:

| Status    | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `create`  | New table or view — will be created from scratch                            |
| `alter`   | Existing table or view — columns, indexes, FKs, or options will be modified |
| `drop`    | No longer in the schema — will be removed                                   |
| `in-sync` | No changes needed                                                           |
| `error`   | Conflicts detected that prevent sync                                        |

Entries are listed in **execution order** (since 0.1.128): tables parents-first, then views, then drops children-first — except that a removed table that references a table this run drops and recreates (`@db.sync.method 'drop'` on a type change, or a destructive table-option change) or whose primary key it rebuilds is dropped right before that table, and its `drop` entry is listed there. `entry.dependsOn` names the tables an entry waits for (for such a table, the removed tables dropped first are included); `entry.dropGroup` is set when a foreign-key cycle is dropped as one group.

### What Triggers `error` Status

A sync entry is marked as `error` when sync cannot proceed safely:

- **Rename collision** — a `@db.column.renamed` annotation attempts to rename column `A` to `B`, but column `B` already exists in the database.
- **Type change without sync method** — a column's type changed (e.g., `TEXT` to `INTEGER`) but the table has no `@db.sync.method` annotation and the adapter does not support in-place column modification. Sync cannot determine whether to drop the table (`'drop'`) or recreate it with data preservation (`'recreate'`), so it flags the entry for manual resolution. Since 0.1.129 the same rule covers a `@db.sync.method` the adapter cannot honour (`'recreate'` without `recreateTable`, `'drop'` without `dropTable`) and a primary-key change on an adapter that can neither rebuild keys nor recreate the table — the plan reports these exactly as the run does.
- **DDL that failed inside the table's step** (since 0.1.129) — any statement the engine refused: a table rename, `syncColumns` / `recreateTable` / `dropColumns` / a key rebuild (a type conversion the data does not allow, a dependent object PostgreSQL will not drop without `CASCADE`), a table-option change, an index or foreign key (a unique index over duplicate rows), a view recreate. The entry is the plan entry plus one error line, `<phase> failed on <table>: <engine message>`, where the phase is one of `Rename`, `Column sync`, `Table option sync`, `Index/FK sync`, `FK sync` (the deferred pass of a foreign-key cycle) or `View sync`; a `@db.sync.method 'drop'` recreate the engine refused reads `Column sync failed on <table>: Drop of "<table>" failed: …`. When foreign keys had already been dropped ahead of the failed statement — by the table's own step, or for a key-changing parent before the walk — the line names them (`Dropped foreign keys before the failure: <columns> — …`); they are re-added by the next run. The run **completes**: the other tables are synced and their snapshots persisted, the failed table's snapshot and the schema hash are withheld, and the next run retries — exactly like a failed index (earlier releases rejected the whole run with nothing persisted). A failed rename keeps the table tracked under its old name (`renamedFrom` is unset on the entry), so the next run sees the rename as pending again rather than creating an empty table under the new name.

An `error` entry the plan already predicts (a rename conflict, a type change without a method, an unsupported `@db.sync.method`, a key change the adapter cannot rebuild) issues **no DDL at all** on that table since 0.1.129 — not even the rename or the foreign-key drops that precede the column changes — so its run entry is its plan entry, and a pending rename stays pending (tracked under the old name).

### Pre-flight refusals

Since 0.1.128 a second class of `error` entries exists: **refusals** (`entry.refused === true`). This is the contract, stated once: a refusal is found in pre-flight, before any DDL; the run returns `status: 'refused'`; **no DDL is issued on any managed table or view**; tracking, snapshots and the hash are left untouched; the lock is released; every pod that hits the same schema refuses identically, so nothing is ever half-applied. The plan prints a refused entry as `✖ refused: <name>`:

| Refusal                                                                                                                                               | Message                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary-key field set changed on a **populated** table                                                                                                | `Primary key of "<table>" changed (<from> → <to>) but the table has rows; schema sync cannot rebuild a populated primary key. Migrate manually (or empty the table) and re-run.`                                                 |
| Primary-key change on a table renamed in the same sync when the adapter's `hasRows` cannot probe the old name                                         | `Primary key of "<table>" changed (<from> → <to>) but the adapter cannot tell whether the table has rows under its old name "<old>" — implement hasRows(tableName) on the adapter, or rename the table in a separate run first.` |
| Primary-key change while a live foreign key from a table that is not removed in the same sync still references the old key                            | `Primary key of "<table>" changed (<from> → <to>) but "<child>.<cols>" still references the old key — retarget the foreign key (or migrate manually) and re-run.`                                                                |
| Primary-key change while a retargeting child table is itself renamed (`@db.table.renamed`) in the same sync                                           | `Primary key of "<table>" changed (<from> → <to>) but the referencing table "<child>" is renamed in the same run (from "<old>") — rename it in a separate run first, then retarget the foreign key and re-run.`                  |
| An auto-increment column leaves the primary key                                                                                                       | `"<table>.<field>" is auto-increment but no longer part of the primary key; auto-increment columns must be primary-key columns.`                                                                                                 |
| A removed table is still referenced by a model or managed view in the inventory                                                                       | `Cannot drop "<table>": it is still referenced by <child>.<cols> (@db.rel.FK) / view "<view>". Add "<table>" to the sync inventory or remove the reference.`                                                                     |
| A foreign key targets a table that is neither in the inventory nor in the database                                                                    | `FK <table>.<cols> references "<target>" which is neither in the sync inventory nor present in the database`                                                                                                                     |
| A physical table exists under a managed view's name (or a view under a table's name)                                                                  | `A physical table "<name>" exists where managed view "<name>" is declared — drop or rename it` / `A view "<name>" exists where table "<name>" is declared — drop or rename it`                                                   |
| Primary-key change while a retargeting child's own entry has errors (since 0.1.129 — its live FK would be dropped for a step that then issues no DDL) | `Primary key of "<table>" changed (<from> → <to>) but the referencing table "<child>" has errors — fix them and re-run: <the child's first error>`                                                                               |
| Primary-key change on a table whose own entry has errors while a live foreign key references it (since 0.1.129 — same reason, on the parent's side)   | `Primary key of "<table>" changed (<from> → <to>) but the table's own entry has errors — fix them and re-run: <the table's first error>`                                                                                         |

`plan()` reports the same entries (its status stays `changes-needed`); a refusal is therefore visible in `--dry-run` before it can hit a deployment.

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
- `@db.sync.method 'drop'` recreates for type changes are skipped (since 0.1.128 — earlier releases dropped the table, data and all, even in safe mode; `'recreate'` and in-place `MODIFY COLUMN` still apply): both the plan and the result keep `typeChanges`, `entry.skipped` includes `'recreate'`, printed as `! type priority (REAL → string) — skipped (safe mode)`, and it does not count as destructive
- Table option changes that require recreation are skipped: `optionChanges` is kept, `entry.skipped` includes `'table-options'`, printed as `! option capped: 1000 → 2000 — skipped (safe mode)`, not destructive (non-destructive option changes are not applied in safe mode either, and are not reported)
- Nullable and default changes are skipped on adapters that need DDL for them (in-place `MODIFY COLUMN` or a table recreation): `nullableChanges` / `defaultChanges` are kept, `entry.skipped` includes `'nullable-defaults'`, printed as `~ bio — non-nullable — skipped (safe mode)`; a snapshot-only adapter (MongoDB without a recreate) just records the change and nothing is pending
- Primary-key rebuilds are skipped (logged as a warning; both the plan and the result show `pkChange` with `rebuild: false` and `entry.skipped` includes `'pk-rebuild'`, printed as `! PK (id) → (code) — skipped (safe mode)`, and it does not count as destructive; a populated-table key change is still refused)

Only additive and non-destructive changes are applied: new tables, new columns, column renames, index updates, and foreign key additions. `entry.skipped` (since 0.1.128) lists the work a safe run skipped — `'pk-rebuild'`, `'recreate'`, `'table-options'`, `'nullable-defaults'` — identically in the plan and in the result, so `plan({ safe: true })` shows exactly what `run({ safe: true })` leaves pending; `entry.pending` is `true` for such an entry (and for an `error` entry).

Objects skipped by safe mode **stay tracked** (since 0.1.128): a removed table or view that safe mode did not drop remains in `synced_tables` with its snapshot, and is dropped by the next run that actually executes — a `--force` run or the next schema change. The schema hash is still written after a safe run, so a safe production boot does not re-plan on every start — with one exception (since 0.1.128): when the run skipped work on a desired table (a primary-key rebuild, a `'drop'` recreate, a destructive table-option recreate or nullable/default DDL — `entry.pending`), that change is still pending, so the table's snapshot and the hash are withheld exactly as for an `error` entry, with a warning per table: `Safe mode: "projects" — nullable/default change skipped, snapshot and hash withheld; the next run without safe applies it`. The next run without `--safe` applies it (no `--force` needed), and a safe-only deployment re-plans and repeats the warning on every start until it does.

Safe mode is designed for production CI/CD pipelines where you want automatic sync for additive changes but want to manually review and approve any destructive operations.

```bash
# Safe mode in CI/CD — only additive changes applied automatically
npx asc db sync --safe --yes
```

::: warning
Safe mode does not prevent all data loss scenarios. Column renames are still applied (they preserve data), and new non-nullable columns without defaults may cause insert failures on existing rows. Use `--dry-run` alongside `--safe` to review the full plan before applying.
:::

## Sync Result Statuses

The `run()` method returns a result object with one of four statuses:

| Status           | Meaning                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up-to-date`     | Schema hash matched — no introspection or DDL was performed                                                                                          |
| `synced`         | Changes were detected and applied (inspect `entries` — an `error` entry means that table did not converge and the hash was withheld)                 |
| `synced-by-peer` | Another instance completed the sync while this one was waiting for the lock                                                                          |
| `refused`        | A [pre-flight refusal](#pre-flight-refusals) stopped the run (since 0.1.128); `entries` is the full plan with the refused entries as `error` entries |

Both `up-to-date` and `synced-by-peer` are success statuses that indicate no work was needed by the current instance. The `synced` status includes a list of `SyncEntry` objects detailing what was changed. A `refused` run follows the `onError` policy: `"warn"` (default) logs every refusal at error level and returns normally, `"throw"` throws, `"silent"` returns — a boot script that only checks `status === "synced"` should treat `refused` as a failed migration.

## Next Steps

- [CLI](./cli) — command-line usage and flags
- [What Gets Synced](./what-gets-synced) — detailed change categories, renames, and structural changes
- [Configuration](./configuration) — config file setup
- [Model Manifest](./model-manifest) — generated model inventory so the sync list can't go stale
- [Programmatic API](./programmatic) — using sync from code
- [CI/CD Integration](./ci-cd) — deployment strategies
