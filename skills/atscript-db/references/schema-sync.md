# schema-sync

```ts
import { syncSchema } from "@atscript/db/sync";
await syncSchema(db, [Todo, User, Post], opts);
```

## Flow

1. Ensure the `__atscript_control` table (holds hash, per-table snapshots, lock row).
2. Compute the current FNV-1a schema hash across all `types`.
3. Compare vs the stored hash. Equal → return `{ status: 'up-to-date' }`.
4. Acquire the distributed lock. Another pod holds it → wait; another pod synced while waiting → return `{ status: 'synced-by-peer' }`.
5. For each type: diff vs stored snapshot → create / alter / drop as needed.
6. `syncIndexes()` per table.
7. `syncForeignKeys()` per table (if adapter implements it).
8. `afterSyncTable()` hook per table (if adapter implements it).
9. Write new hash + snapshots. Release lock.

## Options

```ts
interface TSyncOptions {
  podId?: string; // default: random uuid
  lockTtlMs?: number; // default: 30_000
  waitTimeoutMs?: number; // default: 60_000
  pollIntervalMs?: number; // default: 500
  force?: boolean; // default: false — bypass the hash-equal short-circuit
  safe?: boolean; // default: false — skip destructive ops (DROP COLUMN, DROP TABLE)
}
```

Configure `podId` and raise `lockTtlMs` / `waitTimeoutMs` in multi-pod deployments.

## `__atscript_control` (control table)

Stores: `schema_version` (hash), `table_snapshot:<name>` (one row per table), `synced_tables` (list), `sync_lock` (distributed lock with `lockedBy`, `lockedAt`, `expiresAt`).

Lock rules:

- `tryAcquireLock(podId, ttl)` — inserts the row. Collision → `false`.
- Expired locks (`expiresAt < now`) are reaped automatically.
- `refreshLock(podId, ttl)` returns `'refreshed' | 'stolen' | 'missing'`.
- `releaseLock(podId)` is best-effort; missing the release is safe because TTL eventually clears it.

## Drift detection

Each table's snapshot carries: per-field `physicalName`, `designType`, `optional`, `isPrimaryKey`, `storage`, `defaultValue`, and the adapter's `mappedType` (e.g. `VARCHAR(255)`). Sorted deterministically for stable hashing.

Changes trigger:

| Change                                | Action                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------- |
| New table                             | `ensureTable()`                                                           |
| New column                            | `syncColumns({ added: […] })`                                             |
| Renamed table (`@db.table.renamed`)   | `renameTable(oldName)`, then usual column diff                            |
| Renamed column (`@db.column.renamed`) | Rename via `syncColumns({ renamed: […] })`                                |
| Type change                           | If `adapter.supportsColumnModify` → in-place; else uses `@db.sync.method` |
| Dropped column                        | `dropColumns([…])` (skipped if `safe: true`)                              |
| Dropped table                         | `dropTableByName()` (skipped if `safe: true`)                             |
| Index add/drop                        | `syncIndexes()` (managed by `atscript__` prefix)                          |
| FK add/change                         | `syncForeignKeys()`                                                       |

## `@db.sync.method`

When an existing table needs a structural change the adapter can't apply with ALTER:

- `@db.sync.method 'drop'` — drop and recreate (lossy; data deleted).
- `@db.sync.method 'recreate'` — create temp → copy data → drop old → rename (lossless).
- absent — sync throws; author intervenes.

## Programmatic vs CLI

```bash
npx asc db sync        # reads atscript.config.db.adapter/connection, runs syncSchema
```

Equivalent in code:

```ts
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

const db = new DbSpace(() => new MyAdapter(driver));
const result = await syncSchema(db, allTypes, { podId: process.env.HOSTNAME });
console.log(result.status, result.schemaHash, result.entries);
```

`result.entries: SyncEntry[]` — per-table outcome (`status`, colored log).

## `readStoredSnapshot`

```ts
import { readStoredSnapshot } from "@atscript/db/sync";
const snap = await readStoredSnapshot(db, "users");
```

Returns the stored `TTableSnapshot` — useful for deployment guards that diff expected vs actual before starting the app.

## Index sync details

- `syncIndexesWithDiff({ listExisting, createIndex, dropIndex, prefix?, shouldSkipType? })` is the adapter-facing template.
- Default prefix: `atscript__`. Indexes not matching the prefix are untouched.
- MongoDB: `syncIndexes()` only manages indexes whose names start with `atscript__`. Consumer-created indexes with that prefix will be treated as managed and can be dropped on drift.
- SQLite/Postgres/MySQL: names follow the same convention; FTS5/pgvector/FULLTEXT indexes are created with adapter-specific DDL.

## View sync

Views track a separate snapshot (`TViewSnapshot`) including `viewType: 'V' | 'M' | 'E'` (managed / materialized / external), entry table, join tables, filter hash, materialized flag, field set. Changes trigger `CREATE OR REPLACE VIEW` / `DROP VIEW + CREATE` per dialect. External views (`viewType: 'E'`) are never created or dropped by sync.

## Safe mode

`{ safe: true }` skips `dropColumns`, `dropTableByName`, `dropViewByName` — useful for production where destructive changes should go through manual migration review.
