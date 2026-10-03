---
outline: deep
---

<!--@include: ../_experimental-warning.md-->

# Memory

The memory adapter (`@atscript/db-memory`) is an in-memory `BaseDbAdapter` whose backing store is plain JavaScript `Map`s — **no engine, no I/O, and no persistence**. It has no driver dependency, no compiler plugin, and no adapter-specific annotations: it speaks only the portable `@db.*` layer, so any `.as` model that runs on SQLite runs here unchanged. Because it is decoupled from any datastore, its primary job is to expose a _runtime-owned_ surface — data that lives in Redis, an in-code registry, or a computed snapshot — as a real atscript table without giving it a database.

It runs in two modes:

- **Provider-backed (read-only) — the primary use case.** A table's rows come from a closure you register with `setMemoryProvider`. Writes throw.
- **Stored (read-write) — a secondary convenience.** Rows live in a `Map` with full CRUD — a fast in-memory `DbSpace` for tests and trivial in-app tables.

## Installation

```bash
pnpm add @atscript/db-memory
```

There is no driver to install and no plugin to register. `@atscript/core`, `@atscript/db`, and `@atscript/typescript` are peer dependencies.

## When to use it

**Provider-backed tables are the reason this adapter exists.** When you have a runtime-owned entity that must _not_ acquire a database — a "scheduled jobs" list zipped together from Redis keys and an in-code job registry, a job-runs snapshot, any computed set — the memory adapter lets you observe it as a real atscript table. It renders in the atscript-ui table UI, carries `@DbAction` row actions and `@InputForm`s, and participates in `/meta` filterability, all while the underlying data stays wherever it actually lives.

**Stored mode is a convenience.** It is the role an in-memory SQLite plays — a drop-in `DbSpace` with full CRUD — minus the native module and the SQL round-trip. Reach for it in tests and for trivial in-app tables. It is **not a production datastore** (see [Limitations](#limitations)).

## Setup

Both modes start from `createAdapter()`, which builds a `DbSpace` backed by a fresh `MemoryAdapter` per table, then run [schema sync](/sync/) to record indexes and provision the in-memory control table.

The space is the database: its tables are keyed by table name and shared by every adapter the space builds, and a new space starts empty. Since 0.1.137 — before, each compiled type had its own store, even when two types named the same table.

Stored (read-write) — the drop-in in-memory space for tests and trivial tables:

```typescript
import { createAdapter } from "@atscript/db-memory";
import { syncSchema } from "@atscript/db/sync";
import { User } from "./user.as.js";

const db = createAdapter(); // new DbSpace(() => new MemoryAdapter())
await syncSchema(db, [User]);

const users = db.getTable(User);
await users.insertOne({ id: "u1", name: "Ada" });
```

Provider-backed (read-only) — a runtime-owned surface that still carries `@DbAction`s:

```typescript
import { createAdapter, setMemoryProvider } from "@atscript/db-memory";
import { syncSchema } from "@atscript/db/sync";
import { Job } from "./job.as.js";

const jobsDb = createAdapter();
await syncSchema(jobsDb, [Job]);

// Rows come from a runtime closure. Late-bound AFTER syncSchema.
setMemoryProvider(jobsDb, Job, () => loadJobRows());

const jobs = jobsDb.getTable(Job); // read-only
```

::: tip Building the space by hand
`createAdapter()` is shorthand for `new DbSpace(() => new MemoryAdapter())`. Construct it directly if you need to — `MemoryAdapter` takes no arguments.
:::

## Provider-backed tables

`setMemoryProvider(space, Type, fn)` switches one table into provider (read-through) mode. The closure `fn` — a `MemoryProviderFn`, `() => Row[] | Promise<Row[]>` — is invoked on **every** read to recompute a fresh snapshot, so the table always reflects the current runtime state.

::: info Late-bound by design
Call `setMemoryProvider` **after** `syncSchema` / `getTable` has built the table's adapter — never before. A `DbSpace` builds every table's adapter (including the internal control table) with the same zero-arg factory, so a provider injected at construction would leak onto the control table and break sync. Binding it after construction targets one specific table. The closure can therefore also close over dependencies (a Redis client, a job registry) that don't exist at factory time.
:::

Key behaviors:

- **Read-only.** Every write (`insertOne`, `updateMany`, `deleteOne`, …) throws a typed `DbError` — the table cannot be mutated through the adapter.
- **Recompute per request.** There is no caching; each logical read calls the provider afresh.
- **One invocation per logical read.** A single `findManyWithCount` (which backs `findMany` and the atscript-ui `/pages` count) invokes the provider exactly once, so the count and the returned rows always come from the same snapshot.

Because the readable is built uniformly, `@DbAction` discovery, `?$actions=true` gating, `disabled` predicates, `@InputForm`, and the atscript-ui table / `/meta` surface all work against a provider-backed table with no adapter-side action code. See [Actions](/http/actions) for the action flow.

## Adapter-Specific Annotations

The memory adapter has **no adapter-specific annotations**. All generic `@db.*` annotations work as documented in the [Annotations Reference](./annotations) — there is no `@db.memory.*` namespace and no plugin to register.

## Features

### Nested Objects

Documents are stored in their nested physical shape (no flattening), so `supportsNestedObjects()` is `true`. Filter, sort, project, and patch with dot-notation exactly as you would on MongoDB:

```typescript
await contacts.insertOne({ id: 1, address: { city: "Portland", zip: "97201" } });

await contacts.findMany({
  filter: { "address.city": "Portland" },
  controls: { $sort: { "address.zip": 1 } },
});
```

Dotted paths into `@db.json` objects and arrays are listed in `/meta.fields` and accepted by filters, `$sort`, `$select` (SQL adapters reject them). The array / `@db.json` column itself is filterable but **never sortable** — since 0.1.128 `$sort=tags` is rejected with `INVALID_QUERY` / 400 instead of ordering by the stringified array, and `/meta` says `sortable: false`. Navigation descendants are not listed in `/meta.fields` (since 0.1.128) — load relations with `$with`.

### Optimistic Concurrency

Versioned writes support compare-and-set via `$cas` / `expectedVersion`. A stale version yields `matchedCount: 0` (no throw), and the version column auto-bumps on every versioned write — including the PK-only [versioned touch](/api/versioning#versioned-touch). See [Optimistic Concurrency](/api/versioning).

### Field Operations & Defaults

`$inc`, `$dec`, and `$mul` field operators are applied over dot-paths. `@db.default.increment` (a per-table counter that restarts with each fresh space, like SQLite `:memory:`, and when the table is dropped), `@db.default.now`, and static defaults are all honored at insert time.

### Unique & Primary-Key Enforcement

Unique indexes (recorded from the model at sync time) and primary keys are enforced on every write; a collision raises `DbError('CONFLICT')`. Present-only (partial) semantics apply when an optional index member is absent — matching SQL's `NULLS DISTINCT`.

### Single-Snapshot Count

`findManyWithCount` computes the data page and the total count from one filtered snapshot, so the count never disagrees with the page — important for provider-backed reads where two separate reads could otherwise observe different snapshots.

### Grouped queries

[Grouped queries](/api/aggregation) — `$groupBy`, `count` / `countDistinct` / `sum` / `avg` / `min` / `max`, [calendar buckets](/api/calendar-buckets), `$having`, `$sort`, `$skip` / `$limit` and `$count` — work since 0.1.132, in stored and provider mode (before, `$groupBy` threw `INVALID_QUERY`). Groups are computed in process over one snapshot of the rows with the SQL semantics described in [Aggregate functions](/api/aggregation#aggregate-functions): `null` and missing values form one group, and `sum` / `avg` over no values are `null`. Calendar-bucket labels use the Node.js runtime's time zone data.

There is no index-backed grouping: every grouped query scans the matching rows, which suits the small sets this adapter targets.

Fields renamed with `@db.column` are honored in `$select` and `$sort` since 0.1.132; earlier versions dropped them from selected rows and ignored them in `$sort`.

### Relational predicates {#relational-predicates}

[`$some` / `$none` filters](/api/queries#relational-filters) (since 0.1.147) work in reads — stored and provider-backed tables alike — and in every mutation filter.

- **Cost.** An operation whose filter holds predicates loads each related table (and junction) once — a provider-backed table's provider runs once per operation — and builds a key set from it; then every candidate row is a set lookup. Expect time proportional to the related tables' sizes plus the source size. There are no indexes. A filter without predicates costs nothing extra.
- **Snapshots.** A read sees one consistent snapshot per table, shared with the outer scan when a relation points back to its own table.
- **Writes** evaluate the predicates against the related rows as they were just before the write. Loading those rows is asynchronous, so a write whose filter holds a predicate reads the table only after that await: concurrent writes can interleave between them, with read-committed-like results (a `$cas` / version check is still evaluated synchronously with the write itself). The evaluation and the write are not atomic, like the adapter's other [batch writes](#limitations).
- **Key comparison** follows the adapter's equality everywhere else: a related key matches only a value of the same type (`5` ≠ `"5"`, `5n` ≠ `"5n"`, a `Date` ≠ its ISO string; `Date`s compare by instant). A `null` or missing key part relates to nothing.
- `buildMemoryPredicate` alone cannot evaluate a predicate (it has no access to the related tables) and throws `REL_FILTER_NOT_SUPPORTED` — see [Utilities](#utilities).

### Foreign Keys

There is no native FK enforcement; `supportsNativeForeignKeys()` is `false`. Cascade and set-null run through the generic layer's application-level logic (via the adapter's `updateMany` / `deleteMany`), driven by `@db.rel.onDelete` / `@db.rel.onUpdate`. The rows a `deleteMany` / `deleteOne` matches are pinned by primary key first; the cascade and the delete then both act on those keys, so a filter that reads the cascaded children (`{ issues: { $some: … } }`) still deletes the parent. See [Referential Actions](/relations/referential-actions).

### Schema Sync

Schema sync provisions an in-memory `__atscript_control` table, takes the distributed lock, creates and drops tables, and records unique indexes for insert-time enforcement. See [Schema Sync](/sync/).

- **Create** — a table that does not exist yet is reported `create`. A write to a table that was never synced creates it too.
- **Drop** (since 0.1.137) — a model removed from the schema has its table dropped: rows, unique indexes and increment counter. Added back, it is reported `create` and starts empty. Removed views are dropped the same way. Before 0.1.137, sync reported the drop but the rows stayed, and a model added back was reported `in-sync` with its old rows.
- **Pre-flight** (since 0.1.138) — sync refuses a managed view declared where a table sits, a table declared where a view sits, and a foreign key whose target is neither in the inventory nor already in the space. Include FK targets in the same sync, or sync them first on the same `DbSpace` — a new space starts empty.
- **Columns** — sync does not diff or migrate columns. See [Limitations](#limitations).
- **Derived columns** (since 0.1.141) — a [`@db.column.derived`](/api/storage#derived-columns) field stores nothing: queries and unique indexes address its source path (`payload.customer.id`), reads copy the value as stored (no type guard; a missing leaf is `null`).

## Comparison semantics

Leaf-comparison semantics are **JS-native and documented — deliberately not claimed identical to the SQL engines**. Call these out when moving a model between adapters:

- **Regex** — a JS `RegExp`, honoring `/pat/flags`. Not translated to SQL `LIKE`.
- **Null model** — Mongo-like. `{ f: null }` / `$eq: null` matches both an explicit `null` **and** a missing field; `$ne` matches only concrete, present values.
- **`$exists`** — "holds a value", the same on every adapter: `$exists: true` ⇔ `$ne: null`, `$exists: false` ⇔ `$eq: null`. Before 0.1.132 a key holding `null` counted as present; it now counts as absent. See [Existence](/api/queries#existence).
- **Ordering** — JS-native (`<` / `>`); strings compare by code point. There is **no collation** or locale awareness.

## Limitations

Deliberate v1 trade-offs — matching a real engine here is hard or unnecessary for the small computed surfaces this adapter targets. All are documented, none silent:

- **JS-native regex / null semantics** — not byte-identical to any SQL engine (see [Comparison semantics](#comparison-semantics)).
- **No collation** — `@db.column.collate` (nocase / unicode) is not honored; `$eq` and sort are code-point / JS-native.
- **No sort on array / `@db.json` columns** — `$sort` on them is rejected (400 / `INVALID_QUERY`, since 0.1.128); sort by a nested leaf (`address.zip`) instead.
- **No array-element matching** — the dot-path getter matches scalars and nested-object paths; Mongo-style implicit array-element / `$elemMatch` matching is not provided.
- **Non-atomic stored batch writes** — `insertMany` / `updateMany` / `replaceMany` / `deleteMany` apply sequentially with no rollback; a mid-batch conflict leaves earlier items written. Single writes are safe.
- **No transactions** — `withTransaction` runs the callback but nothing rolls back on a throw. Rollback behaviour (including `moost-db` write guards) is not observable on this adapter; assert it on SQLite `:memory:` or with adapter spies. See [Transactions](/api/transactions#adapter-behavior).
- **Provider tables are read-only** — writes throw, and there is no cross-request pagination stability (page 1 and page 2 are separate requests over separate snapshots).
- **Relations `$with`** — resolved by core's app-level batch loading (`supportsNativeRelations()` is `false`), not natively.
- **No FTS / vector / geo / `$search`** — unsupported. No DB views.
- **Table-level schema sync only** — sync creates and drops tables but does not diff columns: after a field is renamed, removed or changes type, stored rows keep their old shape and `plan()` reports the table `in-sync`. `@db.sync.method` has no effect. `@db.table.renamed` is not applied: the table is created empty under its new name, and the old rows are not moved.
- **In-process only** — nothing is persisted or shared across processes. **Not a production datastore.**

## Utilities

The package exports its query engine as three pure functions — the same engine the adapter runs internally, so a raw-driver or custom controller can apply identical filter/sort/projection semantics outside the standard CRUD flow:

- `buildMemoryPredicate(filter)` — compiles a `FilterExpr` into a JS-native `(row) => boolean` predicate. A filter with [relational predicates](#relational-predicates) needs the adapter (it reads the related tables) — the function throws `REL_FILTER_NOT_SUPPORTED` on one.
- `sortRows(rows, $sort, tieBreak?)` — stable multi-key `$sort` with the adapter's leaf ordering (null-low, `Date`-by-instant, no collation); an optional `tieBreak` yields a deterministic total order.
- `projectRow(row, projection, opts?)` — dot-path `$select` inclusion/exclusion projection over one row, with an optional deep-clone. `opts.pkFields` adds the named fields to an inclusion projection. The adapter itself does not pass it: since 0.1.145 an inclusion `$select` returns exactly the selected fields, as on the SQL adapters. Earlier versions also returned the primary key.

```typescript
import { buildMemoryPredicate, sortRows, projectRow } from "@atscript/db-memory";

const match = buildMemoryPredicate({ status: "active", age: { $gte: 18 } });
const active = sortRows(rows.filter(match), { age: -1 });
```

This same trio backs `@atscript/moost-db`'s [`AsJsonValueHelpController`](./value-help) — static value-help dictionaries and in-memory tables share one filter/sort/projection engine.

## Next Steps

- [SQLite](./sqlite) — zero-config file/`:memory:` adapter for development and testing
- [MongoDB](./mongodb) — document-oriented adapter with native nested objects and Atlas Search
- [Adapter Overview](./) — feature comparison across all adapters
