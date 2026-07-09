<p align="center">
  <img src="https://db.atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/db-memory</h1>

<p align="center">
  <strong>Define your models once</strong> — get TypeScript types, runtime validation, and DB metadata from a single <code>.as</code> model.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/adapters">Adapters</a>
</p>

---

In-memory adapter for `@atscript/db`. `MemoryAdapter` is a full `BaseDbAdapter` with **no engine, no I/O, and no persistence** — rows live in ordinary in-process JS structures. It runs in two modes:

- **Provider-backed (read-only) — the primary mode.** A table's rows come from a closure `() => Row[] | Promise<Row[]>` invoked at query time. This lets a _runtime-owned_ surface with no database — a "scheduled jobs" list zipped from Redis + a job registry, a job-runs snapshot, any computed set — be observed as a real atscript table (rendered in atscript-ui, carrying `@DbAction` row actions and `@InputForm`s) without acquiring a datastore. Writes throw.
- **Stored (read-write) — a secondary convenience.** Rows live in a `Map`, giving a fast in-memory `DbSpace` for tests and trivial in-app tables. Full CRUD.

Filter, sort, project, paginate, optimistic-concurrency (OCC) versioning, and primary-key + unique-index enforcement are all supported. Leaf-comparison semantics (regex, null, ordering) are **JS-native and documented** — deliberately not claimed identical to the SQL engines (see [Accepted limitations](#accepted-limitations-v1)).

## Installation

```bash
pnpm add @atscript/db-memory
```

`@atscript/db` is a peer dependency.

## Provider-backed (read-only) — the primary mode

Observe a runtime-owned entity as a read-only table. The provider closure is re-invoked on **every** read (a fresh snapshot each time), and is late-bound after `syncSchema` so it can close over dependencies that don't exist at factory time:

```typescript
import { createAdapter, setMemoryProvider } from "@atscript/db-memory";
import { syncSchema } from "@atscript/db/sync";
import { Job } from "./models/job.as";

// A DbSpace backed by the in-memory adapter — no engine, no I/O.
const space = createAdapter();
await syncSchema(space, [Job]);

// Make `Job` a READ-ONLY table whose rows come from a runtime closure
// (e.g. Redis keys zipped with an in-code job registry). Set AFTER syncSchema.
setMemoryProvider(space, Job, async () => await loadScheduledJobs());

// Observe it like any other atscript table.
const jobs = space.getTable(Job);
await jobs.findMany({
  filter: { scheduled: { $eq: true } },
  controls: { $sort: { nextRun: 1 }, $limit: 20 },
});
// Any write (insert/update/delete) throws: the table is provider-backed.
```

Because the readable is built uniformly, `@DbAction` discovery, `?$actions=true` gating, `disabled` predicates, `@InputForm`, and the atscript-ui table / `/meta` surface all work against this table with no adapter-side action code.

## Stored (read-write) — tests and trivial tables

A drop-in in-memory `DbSpace` with full CRUD — the role an in-memory SQLite serves, minus the native module and the SQL round-trip:

```typescript
import { createAdapter } from "@atscript/db-memory";
import { syncSchema } from "@atscript/db/sync";
import { User } from "./models/user.as";

const space = createAdapter();
await syncSchema(space, [User]);

const users = space.getTable(User);
await users.insertOne({ id: "u1", name: "Ada" });
await users.findMany({
  filter: { name: { $regex: "^A" } },
  controls: { $sort: { name: 1 } },
});
```

## Public API

| Export                               | Purpose                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `createAdapter()`                    | Builds a `DbSpace` backed by a fresh `MemoryAdapter` per table.                                     |
| `setMemoryProvider(space, Type, fn)` | Late-binds a provider closure onto `Type`'s adapter, making that table read-only (provider mode).   |
| `MemoryAdapter`                      | The adapter class, for constructing a `DbSpace` by hand (`new DbSpace(() => new MemoryAdapter())`). |
| `MemoryProviderFn`                   | The provider closure type: `() => Row[] \| Promise<Row[]>`.                                         |
| `buildMemoryPredicate(filter)`       | Compiles a `FilterExpr` into a JS-native `(row) => boolean` predicate (the engine's filter core).   |

## Accepted limitations (v1)

Deliberate — matching a real engine here is hard or impossible and unnecessary for the small computed surfaces this adapter targets. All are documented, none silent:

- **Regex / null semantics** — JS-native (`RegExp`, `/pat/flags` honored; `$ne`/`$exists` are Mongo-like). Not byte-identical to any SQL engine.
- **No collation** — `@db.column.collate` is not honored; filters and sorts are code-point / JS-native, so case-insensitive `$eq`/sort differ from SQLite/Mongo.
- **No array-element matching** — the dot-path getter matches scalars and nested-object paths; Mongo-style implicit array-element / `$elemMatch` matching is not provided.
- **Non-atomic stored batch writes** — `insertMany`/`updateMany`/`replaceMany`/`deleteMany` apply sequentially with no rollback; a mid-batch conflict leaves earlier items written. Single writes are safe. (Provider tables are read-only, so this never applies to the primary mode.)
- **Provider tables are read-only, with no cross-request pagination stability** — page 1 and page 2 are separate requests over separate snapshots.
- **No native aggregation** — `$groupBy` throws a typed `INVALID_QUERY` (clean 4xx, not 500).
- **Relations `$with`** — resolved by core's app-level batch loading, not natively.
- **No FTS / vector / geo / `$search`** — unsupported.
- **Not a production datastore** — nothing is persisted or shared across processes.

## Documentation

- [Full Documentation](https://db.atscript.dev)
- [Adapters](https://db.atscript.dev/adapters)

## License

MIT
