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
.as files → compile → hash check → (if changed) lock → diff → apply → store hash
```

On every run, schema sync hashes the full compiled schema and compares against the hash from the last successful sync. If it matches, sync exits as `up-to-date` after a single lightweight read — no introspection, no DDL, no lock acquired. Otherwise it acquires a distributed lock in `__atscript_control`, diffs the desired schema against either live introspection (SQL adapters) or the stored per-table snapshot (MongoDB), applies the DDL, and writes the new hash.

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
- [Model Manifest](./model-manifest) — generated model inventory so the sync list can't go stale
- [Programmatic API](./programmatic) — using sync from code
- [CI/CD Integration](./ci-cd) — deployment strategies
