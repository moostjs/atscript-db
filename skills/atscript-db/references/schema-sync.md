# schema-sync

```ts
import { syncSchema } from "@atscript/db/sync";
await syncSchema(db, [Todo, User, Post], opts);
```

## Flow (three phases since 0.1.128)

1. Ensure the `__atscript_control` table (holds hash, per-table snapshots, lock row) — the only DDL before pre-flight.
2. Compute the current FNV-1a schema hash across all `types` (calls `prepareTypeMapper()` first so lazily-detected type mappings — e.g. vector support — are stable at hash time).
3. Compare vs the stored hash. Equal → return `{ status: 'up-to-date' }`.
4. Acquire the distributed lock. Another pod holds it → wait; another pod synced while waiting → return `{ status: 'synced-by-peer' }`.
5. **Discover** (read-only): introspect every table ONCE (live columns on SQL, stored snapshot on Mongo; the OLD name for a pending `@db.table.renamed`), read tracking, compute column/FK diffs incl. `primaryKeyChanged`, probe `hasRows` / `getReferencingForeignKeys` / `getObjectKind` where relevant, build the dependency graph (desired tables: `@db.rel.FK` edges; removed tables: live inbound FKs, snapshot fallback; views: entry + join tables). A removed table that references a table this run drops and recreates (`@db.sync.method 'drop'` on a type change, or a destructive table-option change without `'recreate'`) or whose primary key it rebuilds — transitively, with its own removed children — is scheduled right before that table.
6. **Pre-flight** (pure): any change no order of DDL can apply safely → refusal. One refusal ⇒ return `{ status: 'refused', entries }` — **zero DDL on managed objects, tracking/snapshots/hash untouched, lock released**; every pod refuses identically. Refusals (verbatim messages in [docs/sync](https://db.atscript.dev/sync/#pre-flight-refusals)): PK field set changed on a populated table; PK change on a table renamed in the same run when the adapter's `hasRows` cannot probe the old name (base default → "cannot tell"); PK change while a live inbound FK still references the old key (unless that child retargets it in the same run, or is removed in the same run — then it is dropped first); PK change while a retargeting child is itself `@db.table.renamed` in the same run (rename first, then retarget); PK change while a retargeting child's own plan entry has errors, or while the parent's OWN plan entry has errors and a live FK references it (0.1.129 — the child's live FK would be dropped for a step that issues no DDL: `Primary key of "<parent>" changed (<from> → <to>) but the referencing table "<child>" has errors — fix them and re-run: <first error>` / `… but the table's own entry has errors — fix them and re-run: <first error>`); `@db.default.increment` column leaving the PK; removed table still referenced by an inventory model / managed view; FK to a target neither in the inventory nor in the DB; physical table under a managed view's name (or view under a table's name).
7. **Execute**: (a) drop changed/renamed AND removed views (not in safe mode for removed) — BEFORE table ops, so a column drop isn't blocked by an old view definition; (a′) drop the live inbound FKs of every key-changing table (`dropForeignKeys` on the retargeting children, which re-add them in their own step); (b) tables in topological order, parents first, names sorted for determinism — a removed table that references a table this run drops and recreates (`@db.sync.method 'drop'` on a type change, or a destructive table-option change — both covered) or whose primary key it rebuilds is dropped right BEFORE that table (its own removed children first) — per table: rename → drop stale/changed FKs → column diff (`dropIndexesForColumns` before `dropColumns`; PK rebuild after adds, before drops) → `syncIndexes()` → `syncForeignKeys()` → `afterSyncTable()`; FK-cycle members are created with `ensureTable({ deferForeignKeysTo })` and their `syncForeignKeys()` runs in a deferred pass once all exist; (c) managed views; (d) external-view check (advisory); (e) the remaining removed tables children-first, cycles as one `dropTablesByName` group — a live inbound FK from OUTSIDE the removed set (unmanaged table, errored child) ⇒ `error` entry, table stays tracked, no hash; PG never `CASCADE`s.
8. DDL failures inside a table become `status: 'error'` entries — never an unhandled throw. Since 0.1.129 this covers EVERY statement of a table's step (rename, `syncColumns`, `recreateTable`, `dropColumns`, key rebuild, table options, indexes/FKs, view recreate), not only index/FK DDL: the entry is the PLAN entry plus one line `<phase> failed on <table>: <engine message>`, phase ∈ `Rename` / `Column sync` / `Table option sync` / `Index/FK sync` / `FK sync` (deferred cycle pass) / `View sync`; a refused `'drop'` recreate reads `Column sync failed on <t>: Drop of "<t>" failed: …`; FKs already dropped ahead of the failure (by the step itself, or before the walk for a key-changing parent) are named (`Dropped foreign keys before the failure: …`) and re-added by the next run. The run continues, the other tables are synced + persisted, only the failed table's snapshot and the hash are withheld. A failed RENAME leaves the table tracked under its OLD name (`renamedFrom` unset on the entry) so the next run retries the rename instead of creating an empty table. An entry the PLAN already marks `error` (rename conflict, type change without a method, a declared `@db.sync.method` the adapter lacks the primitive for — distinct message `… @db.sync.method "recreate" is declared but the adapter has no recreateTable — migrate manually.` —, PK change without a rebuild primitive) issues NO DDL at all — not the rename, not the FK drops before the column ops — so run entry === plan entry and a pending rename stays pending under the old name.
9. Write snapshots + hash — SKIPPED for every PENDING entry (`entry.pending`: an `error` entry, or work safe mode skipped), so the next run retries / applies instead of reporting `up-to-date` over a diverged schema. Tracking = current inventory + every removed entry that was NOT dropped (safe mode, blocked, failed). Release lock.

Entries (plan AND run) are in execution order; `entry.dependsOn` (FK parents + the removed tables dropped right before it / view sources / referencing children of a drop), `entry.dropGroup` (cycle dropped together), `entry.pkChange = { from, to, rebuild }`, `entry.skipped` (the work safe mode skipped: `'pk-rebuild'` | `'recreate'` | `'table-options'` | `'nullable-defaults'` — the matching `pkChange` / `typeChanges` / `optionChanges` / `nullableChanges` + `defaultChanges` are kept), `entry.pending` (skipped work or an `error` → snapshot + hash withheld), `entry.refused`. Print: `! PK (id) → (code) — rebuild (table is empty)` / `~ PK (id) → (code) — rebuilt` / `! PK (id) → (code) — skipped (safe mode)` / `! type col (REAL → string) — skipped (safe mode)` / `! option capped: 1000 → 2000 — skipped (safe mode)` / `~ col — non-nullable — skipped (safe mode)` / `✖ refused: <name>` / `· after: a, b` / `· dropped with: b`.

## Options

```ts
interface TSyncOptions {
  podId?: string; // default: random uuid
  lockTtlMs?: number; // default: 30_000
  waitTimeoutMs?: number; // default: 60_000
  pollIntervalMs?: number; // default: 500
  force?: boolean; // default: false — when true, runs the full per-table diff regardless of the schema-hash match
  safe?: boolean; // default: false — skip destructive ops (DROP COLUMN, DROP TABLE)
  logger?: TGenericLogger; // default: NoopLogger for progress logs (see onError for failures)
  onError?: "throw" | "warn" | "silent"; // default: "warn"
}
```

Configure `podId` and raise `lockTtlMs` / `waitTimeoutMs` in multi-pod deployments.

`onError` policy — runs with errored entries (failed index/FK DDL, external-view checks) AND `status: 'refused'` runs are never silent by default:

- `"warn"` (default) — one-line summary + per-entry error/refusal lines via `logger`, **falling back to `console`** when no logger is set. A failing `CREATE UNIQUE INDEX` surfaces even with the `NoopLogger` default. A refused run RETURNS normally — a boot that only checks `status === "synced"` must treat `"refused"` as a failed migration.
- `"throw"` — same reporting, then throws (after snapshots/lock handling, so retries stay correct; a refusal throws with `N entries refused`).
- `"silent"` — legacy: inspect `result.entries` for `status: 'error'` / `result.status === 'refused'` yourself.

`TSyncResult.status`: `'up-to-date' | 'synced' | 'synced-by-peer' | 'refused'` (`refused` since 0.1.128). `plan()` status stays `'up-to-date' | 'changes-needed'` — refusals appear there as `error` entries with `refused: true`, so `--dry-run` shows them.

## Dry-run plan (`planSchema`)

```ts
import { planSchema } from "@atscript/db/sync";
const plan = await planSchema(db, atscriptModels, { safe: true });
// plan.status: 'up-to-date' | 'changes-needed'
// plan.entries: structured diffs (columnsToAdd/rename/drop, type/nullable/default/FK changes)
for (const e of plan.entries) console.log(e.print("plan").join("\n")); // "+ table — create", "~ col: t1 → t2", …
```

No DDL executes; per-entry `destructive` / `hasChanges` / `hasErrors` flags support CI gating. Reading the stored baseline still needs a live DB connection (`__atscript_control`). Same engine as `asc db sync --dry-run`.

## Model manifest (never forget a model in the sync list)

`dbPlugin({ manifest: "atscript.models.ts" })` in `atscript.config` (path rootDir-relative — rule 4) makes full builds (`asc -f dts`) emit a generated inventory of every exported `@db.table` / `@db.view` model:

```ts
import { atscriptModels, dbTables, dbViews, modelsBySpace } from "./atscript.models";
await syncSchema(db, atscriptModels); // instead of a hand-maintained import array
```

Rules:

1. The manifest is an **inventory, not an action** — filter/extend at the call site: `syncSchema(db, [...atscriptModels.filter(m => m !== Legacy), ExternalPkgModel])`. Models from node_modules packages are outside the project build — append them manually.
2. `modelsBySpace` groups by the `@db.space` annotation (absent → `"default"`) for multi-database apps: `syncSchema(mongo, modelsBySpace.default)` / `syncSchema(pg, modelsBySpace.analytics)`.
3. Generated file — never hand-edit; regenerate with `npx asc -f dts`. Narrowed builds (e.g. `asc db sync`'s temp compile) never touch it.
4. The `manifest` path resolves relative to the config's `rootDir`, NOT the package root — with `rootDir: "src"`, use `manifest: "atscript.models.ts"` (a `src/` prefix would emit `src/src/…`).

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

| Change                                | Action                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New table                             | `ensureTable()`                                                                                                                                                                                                                                                                          |
| New column                            | `syncColumns({ added: […] })`                                                                                                                                                                                                                                                            |
| Renamed table (`@db.table.renamed`)   | `renameTable(oldName)`, then usual column diff                                                                                                                                                                                                                                           |
| Renamed column (`@db.column.renamed`) | Rename via `syncColumns({ renamed: […] })`                                                                                                                                                                                                                                               |
| Type change                           | If `adapter.supportsColumnModify` → in-place; else uses `@db.sync.method` (`'drop'` is skipped in safe mode → `skipped: ['recreate']`, snapshot + hash withheld)                                                                                                                         |
| Dropped column                        | `dropIndexesForColumns([…])` then `dropColumns([…])` (skipped if `safe: true`)                                                                                                                                                                                                           |
| Dropped indexed column                | Managed indexes / FTS5 / vec0 artifacts on the column dropped first; composite indexes recreated narrowed                                                                                                                                                                                |
| Dropped column used by a view         | Works only if the view definition is updated in the same sync (changed views pre-dropped)                                                                                                                                                                                                |
| Index add/drop                        | `syncIndexes()` (managed by `atscript__` prefix)                                                                                                                                                                                                                                         |
| Index definition drift                | Same-named plain/unique index with changed column list/order (MySQL: or key-length prefix) → dropped + recreated                                                                                                                                                                         |
| FK add/change                         | `syncForeignKeys()`                                                                                                                                                                                                                                                                      |
| PK field-set change (0.1.128)         | Empty table → `rebuildPrimaryKey(change)` (fallback `recreateTable`); populated → REFUSED; safe → skipped (`pkChange.rebuild: false` + `skipped: ['pk-rebuild']` in plan AND run)                                                                                                        |
| Nullable / default change             | `supportsColumnModify` → in-place; else `recreateTable`; schema-less → snapshot only. Safe: skipped where DDL is needed (`skipped: ['nullable-defaults']`, snapshot + hash withheld); snapshot-only adapters are not pending                                                             |
| Destructive table option              | `'recreate'` + `recreateTable` → data-preserving recreate; else `dropTable` + `ensureTable` (lossy). Safe: skipped (`skipped: ['table-options']`, snapshot + hash withheld); non-destructive option drift is not applied in safe mode and not reported                                   |
| Removed table (0.1.128)               | Children before parents; cycle → `dropTablesByName(group)`; referenced by inventory → REFUSED; referenced by unmanaged live FK → `error` entry, stays tracked; referencing a table the run drops/recreates (type change or destructive option) or key-rebuilds → dropped right before it |
| New tables (0.1.128)                  | Parents before children; FK cycle → `ensureTable({ deferForeignKeysTo })` + deferred `syncForeignKeys()`; unknown FK target → REFUSED                                                                                                                                                    |

PK change detection is the sorted FIELD SET (`@meta.id` moved, single↔composite, membership change); a composite reorder is NOT a change (same rule as the hash); a `@db.column.renamed` key column is compared under its new name. Rebuild order inside a table: renames/adds (`syncColumns`) → PK rebuild → drops. SQLite: the rebuild is `recreateTable`; a demoted numeric key also changes type (`INTEGER` → `REAL`), so `@db.sync.method 'recreate'` is required there. MySQL: one `ALTER … MODIFY <new key> NOT NULL[, MODIFY <demoted col w/o AUTO_INCREMENT>], DROP PRIMARY KEY, ADD PRIMARY KEY`; `ADD COLUMN` never emits `AUTO_INCREMENT` (no helper index) — a new increment key column gets it in that statement, so a safe run leaves a valid schema; `pk` introspected from the `PRIMARY` constraint (one query, KEY_COLUMN_USAGE joined in). PG: `DROP CONSTRAINT pk, ADD PRIMARY KEY`; demoted identity → `DROP IDENTITY IF EXISTS`. Mongo: no-op + index sync (explicit `_id` → never a PK change).

## `@db.sync.method`

When an existing table needs a structural change the adapter can't apply with ALTER:

- `@db.sync.method 'drop'` — drop and recreate (lossy; data deleted). Removed tables that still reference it are dropped first; a table that stays in the inventory and references it makes the recreate an `error` entry on PG (no CASCADE). A destructive table-option drop-and-recreate is covered by the same ordering. Skipped in safe mode (`skipped: ['recreate']`, snapshot + hash withheld; applied by the next run without `safe`).
- `@db.sync.method 'recreate'` — create temp → copy data → drop old → rename (lossless). PG (0.1.129): no `CASCADE` (a user view / unmanaged FK on the table ⇒ `error` entry naming it via PG's `detail`, transaction rolled back, table intact); inbound FKs (to the PK or a UNIQUE column) are re-added under their captured names; the recreated table's own `<tmp>_pkey` / `<tmp>_<col>_fkey` are renamed back to `<table>_pkey` / `<table>_<col>_fkey` (63-byte truncation handled; a taken name is skipped); a self-referencing FK is re-added by `syncForeignKeys`. MySQL relinks inbound FKs but not by name.
- absent — the table's entry reports `status: 'error'` (no throw); the error re-surfaces on every run until resolved. Same for a method the adapter cannot honour (`'recreate'` without `recreateTable`, `'drop'` without `dropTable`; own message, see flow step 8) — in the plan AND the run (0.1.129).

## Error entries (invariants)

1. Schema-level failures NEVER throw — they land on `result.entries` with `status: 'error'` + `errors[]`: rename conflicts, type changes without `@db.sync.method`, a removed table an unmanaged live FK still references / whose drop the engine refused, and any DDL a table's step issues (phases, messages, FK-drop and rename semantics: flow step 8). What still rejects `run()`: lock loss, connection failures, discovery errors. Pre-flight refusals are `error` entries too (`refused: true`) and additionally set `result.status = 'refused'` — nothing at all ran.
2. Errored tables do NOT persist their snapshot or the schema hash → every subsequent run retries; an errored sync is never reported `up-to-date`. A refused run persists NOTHING (not even tracking).
3. Recovery = fix the cause (clean data / fix annotation / add the referenced table back to the inventory / retarget the FK / empty the table) and re-run; no manual state reset needed.
4. External view check failures (`viewType: 'E'`) are advisory: error entry, but hash persistence is NOT blocked.
5. Check failures with `result.entries.filter(e => e.hasErrors)`; refusals with `result.status === 'refused'` / `e.refused`.
6. Removed entries that were not dropped (safe mode, blocked, failed) STAY TRACKED and are dropped by the next run that executes (`force: true` or the next schema change) — safe mode still writes the hash. A safe run that SKIPPED desired work on a table (`entry.skipped`: PK rebuild, `'drop'` recreate, destructive table-option recreate, nullable/default DDL) makes that entry PENDING (`entry.pending`, like an error entry): its snapshot and the hash are withheld and the next run without `safe` applies it. One invariant: the snapshot + hash assert "every desired readable is in its desired form"; leftovers safe mode did not remove are not desired state and are carried by the tracked list.

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

- `syncIndexesWithDiff({ listExisting, createIndex, dropIndex, prefix?, shouldSkipType?, renderDesiredColumn? })` is the adapter-facing template.
- `listExisting` returns `{ name, columns? }[]` — when `columns` (ordered) is provided, plain/unique indexes whose definition drifted from the model (composite membership/order change under the same name) are dropped + recreated. All built-in SQL adapters provide it. `renderDesiredColumn(index, field)` (0.1.128) lets an adapter render the model side the way `listExisting` renders key parts — MySQL uses it for key-length prefixes (`col(255)`), normalising a live `SUB_PART` equal to the column's declared length to "no prefix" first, so a wrong prefix rebuilds once and a correct one never churns.
- MySQL prefix rule (0.1.128): `mysqlIndexPrefix(mappedType, bytesPerChar)` — `VARCHAR/CHAR(n)` ≤ 3072 bytes ÷ bytes-per-char (768 chars on utf8mb4) → no prefix, longer → the limit; TEXT/BLOB → 255; numeric/ENUM/JSON/VECTOR/geometry/FULLTEXT → never. Unique string fields should carry `@expect.maxLength` so uniqueness is exact.
- Default prefix: `atscript__`. Indexes not matching the prefix are untouched.
- MongoDB: `syncIndexes()` only manages indexes whose names start with `atscript__`. Consumer-created indexes with that prefix will be treated as managed and can be dropped on drift.
- SQLite/Postgres/MySQL: names follow the same convention; adapter-specific DDL handles FTS5 / pgvector / FULLTEXT / MySQL VECTOR. SQLite vector indexes additionally provision a `<table>__vec__<indexName>` `vec0` shadow virtual table plus AI/AU/AD triggers — these live outside the `atscript__` prefix scheme and are managed by the adapter, not by `syncIndexesWithDiff`.

## View sync

Views track a separate snapshot (`TViewSnapshot`) including `viewType: 'V' | 'M' | 'E'` (managed / materialized / external), entry table, `joinTables: [{ targetTable, condition }]` (condition = canonical JSON of the ON predicate via `canonicalizeQueryNode` — table-qualified refs, fixed key order; since 0.1.128, previously bare target names), `filterHash`, `havingHash` (0.1.128), materialized flag, field set (`@db.ignore` fields excluded — and excluded from the generated `CREATE VIEW`). Changes trigger `CREATE OR REPLACE VIEW` / `DROP VIEW + CREATE` per dialect. Changed/renamed AND removed views are dropped BEFORE table ops; changed ones are recreated after — update a view's definition in the same sync that drops a column it referenced. External views (`viewType: 'E'`) are never created or dropped by sync; their check is advisory. Upgrade to 0.1.128: managed views with joins/filter/having are recreated once — PG loses view `GRANT`s (re-grant); a user view depending on a managed view makes the recreate an `error` entry (no `CASCADE`); Mongo `M` views are plain views (metadata-only). A physical table under a managed view's name is a pre-flight refusal. Adapters detect views structurally (`readable.isView` / `isAtscriptDbView()`), never `instanceof`.

## Safe mode

`{ safe: true }` skips `dropColumns`, `dropTableByName`, `dropViewByName`, and four kinds of desired work that it reports as SKIPPED — identically in plan AND run (`entry.skipped`, not destructive, warning logged): the `@db.sync.method 'drop'` recreate of a type change (`'recreate'`, since 0.1.128 — earlier releases dropped the table even in safe mode; `'recreate'` and in-place MODIFY still apply: `! type col (REAL → string) — skipped (safe mode)`, `typeChanges` kept), the PK rebuild (`'pk-rebuild'`: `! PK … — skipped (safe mode)`, `pkChange: { …, rebuild: false }`), a destructive table-option recreate (`'table-options'`: `! option k: a → b — skipped (safe mode)`, `optionChanges` kept; non-destructive option drift is silently not applied) and nullable/default changes on adapters that need DDL for them — `supportsColumnModify` or `recreateTable` (`'nullable-defaults'`: `~ col — non-nullable — skipped (safe mode)`, `nullableChanges` / `defaultChanges` kept; snapshot-only adapters just record the change, nothing pending) — useful for production where destructive changes should go through manual migration review. A PK change on a POPULATED table is refused in safe mode too. Skipped removals stay tracked (with snapshots) and are dropped by the next run that executes (`force: true` or the next schema change); the hash IS written after a safe run — EXCEPT for a PENDING entry (`entry.pending`: `skipped` non-empty, or `error`): that table's snapshot and the hash are withheld (`Safe mode: "<table>" — <work> skipped, snapshot and hash withheld; the next run without safe applies it`), the next run without `safe` applies it with no `force`, and a safe-only boot re-plans (and re-warns) every start until then.
