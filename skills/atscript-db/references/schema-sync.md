# schema-sync

```ts
import { syncSchema } from "@atscript/db/sync";
await syncSchema(db, [Todo, User, Post], opts);
```

## Flow

1. Ensure the `__atscript_control` table (holds hash, per-table snapshots, lock row).
2. Compute the current FNV-1a schema hash across all `types` (calls `prepareTypeMapper()` first so lazily-detected type mappings — e.g. vector support — are stable at hash time).
3. Compare vs the stored hash. Equal → return `{ status: 'up-to-date' }`.
4. Acquire the distributed lock. Another pod holds it → wait; another pod synced while waiting → return `{ status: 'synced-by-peer' }`.
5. Drop tracked views whose definition changed (or being renamed) — BEFORE table ops, so a column drop isn't blocked by an old view definition (SQLite/Postgres refuse it). Recreated in step 7.
6. For each table: diff vs stored snapshot → create / alter / drop as needed. Before `dropColumns`, `dropIndexesForColumns` removes managed indexes (and SQLite FTS5/vec0 artifacts) referencing the dropped columns.
7. Per table: `syncIndexes()` → `syncForeignKeys()` → `afterSyncTable()` (latter two if implemented). DDL failures here (e.g. unique index over duplicate data) become `status: 'error'` entries — never an unhandled throw.
8. Sync views; validate external views (advisory — an error here never blocks anything).
9. Write snapshots + hash — SKIPPED for errored tables, so the next run retries instead of reporting `up-to-date` over a diverged schema. Release lock.

## Options

```ts
interface TSyncOptions {
  podId?: string; // default: random uuid
  lockTtlMs?: number; // default: 30_000
  waitTimeoutMs?: number; // default: 60_000
  pollIntervalMs?: number; // default: 500
  force?: boolean; // default: false — when true, runs the full per-table diff regardless of the schema-hash match
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

| Change                                | Action                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| New table                             | `ensureTable()`                                                                                           |
| New column                            | `syncColumns({ added: […] })`                                                                             |
| Renamed table (`@db.table.renamed`)   | `renameTable(oldName)`, then usual column diff                                                            |
| Renamed column (`@db.column.renamed`) | Rename via `syncColumns({ renamed: […] })`                                                                |
| Type change                           | If `adapter.supportsColumnModify` → in-place; else uses `@db.sync.method`                                 |
| Dropped column                        | `dropIndexesForColumns([…])` then `dropColumns([…])` (skipped if `safe: true`)                            |
| Dropped indexed column                | Managed indexes / FTS5 / vec0 artifacts on the column dropped first; composite indexes recreated narrowed |
| Dropped column used by a view         | Works only if the view definition is updated in the same sync (changed views pre-dropped)                 |
| Index add/drop                        | `syncIndexes()` (managed by `atscript__` prefix)                                                          |
| Index definition drift                | Same-named plain/unique index with changed column list/order → dropped + recreated                        |
| FK add/change                         | `syncForeignKeys()`                                                                                       |

## `@db.sync.method`

When an existing table needs a structural change the adapter can't apply with ALTER:

- `@db.sync.method 'drop'` — drop and recreate (lossy; data deleted).
- `@db.sync.method 'recreate'` — create temp → copy data → drop old → rename (lossless).
- absent — the table's entry reports `status: 'error'` (no throw); the error re-surfaces on every run until resolved.

## Error entries (invariants)

1. Schema-level failures NEVER throw — they land on `result.entries` with `status: 'error'` + `errors[]`. Covers: rename conflicts, type changes without `@db.sync.method`, index/FK DDL failures (e.g. `@db.index.unique` over duplicate data).
2. Errored tables do NOT persist their snapshot or the schema hash → every subsequent run retries; an errored sync is never reported `up-to-date`.
3. Recovery = fix the cause (clean data / fix annotation) and re-run; no manual state reset needed.
4. External view check failures (`viewType: 'E'`) are advisory: error entry, but hash persistence is NOT blocked.
5. Check failures with `result.entries.filter(e => e.hasErrors)`.

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
- `listExisting` returns `{ name, columns? }[]` — when `columns` (ordered) is provided, plain/unique indexes whose definition drifted from the model (composite membership/order change under the same name) are dropped + recreated. All built-in SQL adapters provide it.
- Default prefix: `atscript__`. Indexes not matching the prefix are untouched.
- MongoDB: `syncIndexes()` only manages indexes whose names start with `atscript__`. Consumer-created indexes with that prefix will be treated as managed and can be dropped on drift.
- SQLite/Postgres/MySQL: names follow the same convention; adapter-specific DDL handles FTS5 / pgvector / FULLTEXT / MySQL VECTOR. SQLite vector indexes additionally provision a `<table>__vec__<indexName>` `vec0` shadow virtual table plus AI/AU/AD triggers — these live outside the `atscript__` prefix scheme and are managed by the adapter, not by `syncIndexesWithDiff`.

## View sync

Views track a separate snapshot (`TViewSnapshot`) including `viewType: 'V' | 'M' | 'E'` (managed / materialized / external), entry table, join tables, filter hash, materialized flag, field set. Changes trigger `CREATE OR REPLACE VIEW` / `DROP VIEW + CREATE` per dialect. Changed/renamed views are dropped BEFORE table ops and recreated after — update a view's definition in the same sync that drops a column it referenced. External views (`viewType: 'E'`) are never created or dropped by sync; their check is advisory.

## Safe mode

`{ safe: true }` skips `dropColumns`, `dropTableByName`, `dropViewByName` — useful for production where destructive changes should go through manual migration review.
