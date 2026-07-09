# adapters-memory

`@atscript/db-memory` — in-memory `BaseDbAdapter` over JS `Map`s; no engine/I/O/persistence. Two modes: provider-backed read-only (primary) + stored read-write (tests).

No driver dep, no compiler plugin, no `@db.memory.*` annotations — portable `@db.*` only. Peer deps: `@atscript/core`, `@atscript/db`, `@atscript/typescript`. Install `pnpm add @atscript/db-memory`.

## Wiring

**Stored (read-write)** — full CRUD, rows in a per-table `Map`:

```ts
import { createAdapter } from "@atscript/db-memory";
import { syncSchema } from "@atscript/db/sync";
import { User } from "./user.as";

const db = createAdapter(); // DbSpace, a fresh MemoryAdapter per table
await syncSchema(db, [User]); // in-memory __atscript_control table + distributed lock
const users = db.getTable(User);
await users.insertOne({ id: "u1", name: "Ada" });
await users.findMany({ filter: { name: { $regex: "^A" } }, controls: { $sort: { name: 1 } } });
```

**Provider-backed (read-only)** — rows come from a runtime closure, observed as a read-only table:

```ts
import { createAdapter, setMemoryProvider } from "@atscript/db-memory";
import { syncSchema } from "@atscript/db/sync";
import { Job } from "./job.as";

const db = createAdapter();
await syncSchema(db, [Job]);
// Late-bind AFTER the readable exists: Job now read-only, rows recomputed per read.
setMemoryProvider(db, Job, async () => loadScheduledJobs()); // Redis/registry/computed snapshot
const jobs = db.getTable(Job);
await jobs.findMany({
  filter: { scheduled: true },
  controls: { $sort: { nextRun: 1 }, $limit: 20 },
});
// jobs.insertOne(...) → throws DbError('INVALID_QUERY') — provider tables are read-only.
```

- `setMemoryProvider` is **late-bound**: call it after `syncSchema`/`getTable` has built the adapter (it resolves the already-built `MemoryAdapter` via `space.getAdapter`). Not a constructor arg.
- The `MemoryAdapter` **constructor takes no provider**: a `DbSpace` factory builds _every_ table's adapter — including the internal `__atscript_control` sync table — so a constructor provider would leak onto the control table and break sync. Target one table via `setMemoryProvider`.
- Manual construction (what `createAdapter()` wraps): `new DbSpace(() => new MemoryAdapter())`.
- The primary use is exposing a runtime-owned surface with no datastore (Redis jobs, in-code registries, computed snapshots) as a real atscript table carrying `@DbAction`/`@InputForm`/`?$actions=true` — see [actions.md](actions.md).

## Capabilities

| Capability                                      | Status                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Transactions                                    | No — stored batch writes are non-atomic (no rollback).                              |
| Foreign keys                                    | App-level cascade / set-null (via `updateMany`/`deleteMany`); no native constraint. |
| Full-text / Vector / Geo search                 | No.                                                                                 |
| Collation (`@db.column.collate`)                | No — JS-native code-point comparison.                                               |
| JSON / nested objects (`supportsNestedObjects`) | Yes — stored nested, not flattened; nested dot-path filters + patches.              |
| Aggregation / `$groupBy`                        | No — throws typed `DbError('INVALID_QUERY')` (4xx, not 500).                        |
| Views                                           | No.                                                                                 |
| Native patch (`supportsNativePatch`)            | No — core decomposes patches into dot-path `$set`.                                  |
| Native relations (`supportsNativeRelations`)    | No — `$with` resolved by core's app-level batch loading.                            |
| Persistence                                     | No — in-process JS `Map`s; nothing persisted or shared across processes.            |
| OCC / `$cas`                                    | Yes — `$cas`/expectedVersion; version auto-bumps on every versioned write.          |
| Unique / PK enforcement                         | Yes — duplicate → `DbError('CONFLICT')`.                                            |
| Increment / defaults                            | Yes — `@db.default.increment` (per-instance counter), `now`, static.                |

`canFilterField` mirrors Mongo (`!fd.encrypted`) — nested/JSON fields report `filterable: true` on `/meta`. `canSortField` keeps the conservative base default (JSON veto). Field ops `$inc`/`$dec`/`$mul` and `prepareId` coercion are supported — see [patch.md](patch.md), [crud.md](crud.md).

## Invariants

| #   | Invariant                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provider-backed tables are **read-only** — every write (`insert`/`update`/`replace`/`delete`, single or batch) throws `DbError('INVALID_QUERY')` → HTTP 400.                                                                                                                                                                                       |
| 2   | `setMemoryProvider(space, Type, fn)` is **late-bound**, not a constructor arg — call it after `syncSchema`/`getTable`. A constructor provider would leak onto `__atscript_control` and break sync.                                                                                                                                                 |
| 3   | Provider closure is invoked **exactly once** per logical read (`findMany`/`count`/`findManyWithCount`/`findOne`) — single snapshot, so `/pages` count + data stay consistent.                                                                                                                                                                      |
| 4   | Null model is **Mongo-like**: `$eq: null` matches null AND missing; `$ne` matches only concrete present values.                                                                                                                                                                                                                                    |
| 5   | `$regex` is **JS-native** `RegExp` (honors `/pat/flags`) — NOT SQL `LIKE`. A pattern accepted by SQLite may behave differently here.                                                                                                                                                                                                               |
| 6   | **No collation** — `@db.column.collate` is ignored; `$eq`/`$sort` are code-point / JS-native (case-sensitive), so results differ from SQLite/Mongo case-insensitive comparison.                                                                                                                                                                    |
| 7   | Stored **batch writes are non-atomic** (`insertMany`/`updateMany`/`replaceMany`/`deleteMany`) — a mid-batch conflict leaves earlier items written. Single writes are safe.                                                                                                                                                                         |
| 8   | Default order is **insertion order** (stored mode); provider order is provider-owned. Provider tables have **no cross-request pagination stability** — page 1 and page 2 are separate snapshots.                                                                                                                                                   |
| 9   | Aggregation (`$groupBy`) throws typed `INVALID_QUERY` (4xx). FTS / vector / geo / `$search` / DB views are documented non-goals — unsupported.                                                                                                                                                                                                     |
| 10  | OCC stale `$cas`/expectedVersion → `matchedCount: 0` (**no throw**); the row is left unchanged.                                                                                                                                                                                                                                                    |
| 11  | The filter/sort/projection engine (`buildMemoryPredicate` + `sortRows` + `projectRow`) is **shared**: it also backs `@atscript/moost-db`'s `AsJsonValueHelpController` (static value-help). Same JS-native semantics (Mongo-like null model, `/pat/flags` regex, dot-paths) apply there — see [moost-db.md § Value-help controllers](moost-db.md). |

Also: no Mongo-style implicit array-element / `$elemMatch` matching — the dot-path getter reaches scalars and nested-object paths only. Semantics are JS-native, deliberately NOT SQL-identical; not a production datastore.

## Key imports

```ts
import {
  MemoryAdapter,
  createAdapter,
  setMemoryProvider,
  // shared JS-native filter/sort/projection engine (also backs moost-db value-help — see below)
  buildMemoryPredicate,
  sortRows,
  projectRow,
} from "@atscript/db-memory";
import type { MemoryProviderFn } from "@atscript/db-memory";
import { syncSchema } from "@atscript/db/sync";
import { DbSpace } from "@atscript/db"; // only for manual `new DbSpace(() => new MemoryAdapter())`
```

## In-memory for tests

The role an in-memory SQLite serves, minus the native module and the SQL round-trip:

```ts
import { createAdapter } from "@atscript/db-memory";
import { syncSchema } from "@atscript/db/sync";
import { User, Post } from "../src/schema";

export async function makeTestDb() {
  const db = createAdapter(); // no native module, no DB process
  await syncSchema(db, [User, Post]);
  return { db, users: db.getTable(User), posts: db.getTable(Post) };
}
```

- Reads default to **insertion order** — deterministic without a `$sort`.
- One fresh `createAdapter()` per test (or `beforeEach`) is fully isolated: the store is a `Map` on each table's adapter, scoped to the space. Nothing to close.
- See [testing.md](testing.md) for the broader app-side testing patterns and [schema-sync.md](schema-sync.md) for the in-memory `__atscript_control` sync.
