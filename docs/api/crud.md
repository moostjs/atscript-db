---
outline: deep
---

# CRUD Operations

Atscript's DB layer provides a type-safe API for creating, reading, updating, and deleting records. All operations go through `AtscriptDbTable`, which handles validation, default values, nested object flattening, and adapter translation automatically.

## Getting a Table Instance

```typescript
import { DbSpace } from "@atscript/db";
import { User } from "./schema/user.as";

const users = db.getTable(User); // AtscriptDbTable<typeof User>
```

`getTable()` returns a cached instance — calling it again with the same type returns the same table. See [Setup](/guide/setup) for how to create a `DbSpace`.

## Inserting Records

### Insert One

Insert a single record and get back the generated primary key:

```typescript
const result = await users.insertOne({
  email: "alice@example.com",
  name: "Alice",
  status: "active",
});
// result: { insertedId: 1 }
```

Fields with `@db.default.*` annotations (`@db.default.increment`, `@db.default.uuid`, `@db.default.now`, or `@db.default 'value'`) are applied automatically — you can omit them from the input. An `undefined` value counts as omitted (since 0.1.128); `null` is an explicit NULL — see [Defaults](/api/defaults#how-defaults-interact-with-inserts).

Write payloads are typed as `DbPatch<Row>` (insert / patch: every key optional) and `DbRow<Row>` (replace: required keys stay required); both accept `null` on optional columns. Defaults are applied before validation: static `@db.default 'x'` values are filled on every adapter, function defaults (`now` / `uuid` / `increment`) only when the adapter does not generate them natively (since 0.1.128; before, SQL adapters left static defaults to the DDL `DEFAULT` clause). To see or enrich the defaulted, validated rows before they are written, pass a [write guard](#write-guards).

::: info `insertedId` typing
`insertedId` is typed as `unknown` (the PK type isn't always inferable — UUID, ObjectId, composite, etc.). Cast it to your PK type when you need a typed value: `result.insertedId as number`.
:::

### Insert Many

Insert multiple records in a single transaction:

```typescript
const result = await users.insertMany([
  { email: "alice@example.com", name: "Alice" },
  { email: "bob@example.com", name: "Bob" },
  { email: "charlie@example.com", name: "Charlie" },
]);
// result: { insertedCount: 3, insertedIds: [1, 2, 3] }
```

Rows may carry different sets of fields: each row is stored as `insertOne` would store it, and a column a row omits gets its default (or `NULL`).

::: warning PostgreSQL and MySQL before 0.1.132
Up to 0.1.131 the PostgreSQL and MySQL adapters built the column list from the **first** row only, so any column absent from row 1 was silently dropped from every row of the batch. If you inserted heterogeneous batches on those adapters, check the affected columns. SQLite, MongoDB and memory were not affected.
:::

### Skip conflicting rows {#insert-ignore}

Pass `onConflict: "ignore"` (since 0.1.148) to skip rows that collide on the primary key or any unique index instead of failing the call with `CONFLICT`. The result has one slot per input row, by index:

```typescript
const result = await users.insertMany(
  [
    { email: "alice@example.com", name: "Alice" }, // new
    { email: "bob@example.com", name: "Bob" }, // already stored
    { email: "alice@example.com", name: "Alice again" }, // duplicate inside the batch
  ],
  { onConflict: "ignore" },
);
// result: { insertedCount: 1, insertedIds: [7], inserted: [0], conflicts: [1, 2] }

const one = await users.insertOne(
  { email: "bob@example.com", name: "Bob" },
  { onConflict: "ignore" },
);
// one: { conflict: true }   — or { insertedId, conflict: false }
```

- `insertedIds` holds the ids of the inserted rows only (dense, input order); `inserted` gives each one's input index, and `conflicts` lists the skipped input indices.
- A row repeating the key of an **earlier row of the same batch** is a conflict too: the earlier row wins. A key with a `NULL` / missing component never collides (SQL `NULLS DISTINCT`).
- Only uniqueness collisions are skipped. Validation, `NOT NULL`, foreign-key, `guard` and `check` failures still throw and roll the call back. The `guard` sees every submitted row (a forbidden row is an error even if it would have conflicted); `check` sees the inserted rows only.
- A payload that creates a related **parent** (a nested `@db.rel.to` object with more than the target's key) is rejected with `INVALID_QUERY`: the parent would be orphaned when the row is skipped. A `@db.rel.to` object that names only the target's key (`{ author: { id: 5 } }`) creates nothing: it links the existing parent and becomes the row's foreign key (its existence is checked like any foreign key); a different value in the row's own foreign key field is `INVALID_QUERY`. Nested children (`@db.rel.from`) and `@db.rel.via` links of a skipped row are not written; a conflict inside a nested child insert is not ignored (nested inserts use the default mode, so it throws and rolls the call back).
- SDK-side defaults of skipped rows are discarded; database sequences and increments may leave gaps.
- A skipped row never aborts the surrounding [transaction](/api/transactions).
- **A conflict reveals that the value exists**, exactly as the default mode's `409` does: a skipped row tells the caller that a row with that unique value is stored, even one the caller cannot read. An application that scopes uniqueness per tenant should declare per-tenant unique indexes (a composite unique index that includes the tenant column) instead of a global one.
- An adapter that does not implement conflict-ignoring inserts throws `DbError("ON_CONFLICT_NOT_SUPPORTED")`; the built-in adapters all do. Over HTTP the mode is `POST /?$onConflict=ignore` ([CRUD endpoints](/http/crud)).

::: info Nested Creation
Both `insertOne` and `insertMany` support nested relation data — inserting related records across foreign keys in a single call. This is covered in [Relations — Deep Operations](/relations/deep-operations).
:::

## Reading Records

### Find by ID

Look up a single record by primary key:

```typescript
const user = await users.findById(1);
// Returns the record or null
```

`findById` is flexible — it accepts:

- A scalar — tried against the primary key and every single-field unique index
- An object with primary-key fields, or with all fields of a compound unique index

Add [`@db.table.preferredId.uniqueIndex`](/api/tables#preferred-identifier) to a table to make a non-PK unique index the canonical id (e.g., `slug`). Scalar ids then resolve **only** against that index — no PK fallback — which keeps URLs and external references deterministic.

#### Which row an id addresses {#id-resolution}

An id always addresses **exactly one row, primary key first** (since 0.1.143). A scalar can be type-compatible with several identifications — with a string primary key next to a string unique `slug`, `"abc"` may be one row's `id` and another row's `slug`:

1. The identifications are tried in order — primary key first, then each unique index. The first one that matches a row wins, and that row is then addressed by its exact primary key.
2. An object id that carries the complete primary key resolves by the primary key alone, like a write payload.
3. When nothing matches, the id addresses no row (`findById` → `null`, `deleteOne` → `{ deletedCount: 0 }`).

`findById`, `deleteOne` and the write guards' `current()` all follow this rule. `deleteOne` pins the row inside its transaction, so the guard, the cascade and the delete all see the same row.

**Row scope.** Pass `{ scope: filter }` (a row-level overlay such as a tenant filter) to `resolveRowFilter` or `deleteOne` and only rows matching it count while the identifications are tried: an out-of-scope row can never shadow an in-scope one, so the answer is exactly what it would be if that row did not exist. `resolveRowFilter` still returns the first identification when nothing in scope matches — AND the scope onto its result before reading. `deleteOne` also applies the scope to the delete itself: an out-of-scope row is not deleted (`{ deletedCount: 0 }`, and the guard's `current()` is `null`).

To READ the addressed row under a scope, use `findOneByRow` (since 0.1.143): it resolves the id the same way and returns the row itself — scope applied to the result, your `controls` applied to the read — in one step, without a separate resolve-then-read:

```typescript
const scope = { tenant: currentTenant() };
const row = await slugs.findOneByRow("abc", { scope, controls: { $select: ["id", "title"] } });
await slugs.deleteOne("abc", { scope });

// The same, by hand:
const filter = await slugs.resolveRowFilter("abc", { scope });
const same = filter ? await slugs.findOne({ filter: { $and: [filter, scope] } }) : null;
```

Public helpers that turn an id (or a write payload) into a filter or a row:

| Method                         | Returns                                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveRowFilter(id, opts?)`  | `Promise<FilterExpr \| null>` — the one-row filter described above (since 0.1.143). Use it whenever an id must name a single row, e.g. before AND-ing it with a read scope. `null` when the id fits no identification. |
| `findOneByRow(id, opts?)`      | `Promise<row \| null>` — the row that filter addresses, read with `opts.controls`; `null` when it is missing or outside `opts.scope` (since 0.1.143).                                                                  |
| `resolveIdFilter(id, opts?)`   | `FilterExpr \| null` (sync) — the `$or` of every identification the id fits. It can match more than one row.                                                                                                           |
| `recordFilter(payload, opts?)` | `FilterExpr` (sync, tables only) — the filter `updateOne` / `replaceOne` of that payload target: primary key when complete, else a unique index. Throws `NOT_FOUND` without identifying fields (since 0.1.143).        |

All take `{ isFieldVisible }`: a unique index over a hidden field is skipped.

```typescript
// rows: { id: "zz-b", slug: "abc" }, { id: "abc", slug: "a-own" }
await slugs.resolveRowFilter("abc"); // { id: "abc" }   — the primary-key row
await slugs.resolveRowFilter("a-own"); // { id: "abc" } — unique-key fallback, pinned to its PK
slugs.resolveIdFilter("abc"); // { $or: [{ id: "abc" }, { slug: "abc" }] }
```

### Find One

Return the first record matching a filter:

```typescript
const user = await users.findOne({
  filter: { email: "alice@example.com" },
});
// Returns the first match or null
```

### Find Many

Return all records matching a filter, with optional sorting and pagination:

```typescript
const active = await users.findMany({
  filter: { status: "active" },
  controls: {
    $sort: { name: 1 },
    $limit: 10,
    $skip: 0,
  },
});
```

For a full reference on filter operators and controls, see [Queries & Filters](/api/queries).

### Count

Count matching records without fetching data:

```typescript
const total = await users.count({
  filter: { status: "active" },
});
```

Pass no arguments to count all records:

```typescript
const allUsers = await users.count();
```

### Find Many with Count

Get both data and total count in one call — useful for paginated UIs:

```typescript
const { data, count } = await users.findManyWithCount({
  filter: { status: "active" },
  controls: { $limit: 10, $skip: 20 },
});
// data: first 10 records after skipping 20
// count: total matching records (ignoring $limit/$skip)
```

## Updating Records

### Update One

Partially update a record. The primary key field(s) must be included to identify the record — only the other provided fields are changed:

```typescript
const result = await users.updateOne({
  id: 1,
  name: "Alice Smith",
});
// result: { matchedCount: 1, modifiedCount: 1 }
```

`matchedCount` is what the identifying filter (plus `$cas`, when present) matched at execution time — never assumed. A payload with only the identifying fields writes nothing and reports `{ 1, 0 }` when the row exists or `{ 0, 0 }` when it does not; an `undefined` value is treated as absent (since 0.1.128). See [Update & Patch](/api/update-patch#simple-updates).

`null` clears an optional column (`updateOne({ id, note: null })` → `NULL`), an omitted key keeps it. Since 0.1.128 the readable's filter types admit `null` for optional columns too (`findMany({ filter: { note: null } })`, `{ note: { $ne: null } }`) — see [Queries — Null Values](/api/queries#null-values).

::: info Patch Operators & Field Operations
For atomic increments/decrements (`$inc`, `$dec`, `$mul`) and embedded array patch operators (`$insert`, `$remove`, etc.), see [Update & Patch](/api/update-patch).
:::

::: tip Optimistic concurrency
For tables that declare [`@db.column.version`](/api/versioning), add `$cas` to make the update conditional on the current row version:

```typescript
const ok = await users.updateOne({
  id: 1,
  status: "active",
  $cas: { version: row.version },
});
// ok.matchedCount === 0 on stale-read OR missing row — caller retries.
```

See [Optimistic Concurrency (Row Versioning)](/api/versioning) for the full reference.
:::

### Update Many

Update all records matching a filter:

```typescript
const result = await users.updateMany(
  { status: "inactive" }, // filter
  { status: "archived" }, // data to set
);
// result: { matchedCount: 5, modifiedCount: 5 }
```

`updateMany` does not support nested relation operations — only own fields. An empty patch (`{}` or one that prunes to nothing) issues no `UPDATE`: it returns the honest match count with `modifiedCount: 0` and bumps no version.

## Replacing Records

### Replace One

Replace an entire record by primary key. Unlike `updateOne`, **all fields must be provided** — missing fields are not preserved: an omitted optional column becomes `NULL` (absent on document stores) on every adapter. Since 0.1.128 this holds on SQLite, PostgreSQL and MySQL too — their `UPDATE`-based replace now assigns every column (a column whose function default the engine owns, e.g. a native `@db.default.now`, is reset to its `DEFAULT`); before, an omitted column silently kept its old value there.

```typescript
const result = await users.replaceOne({
  id: 1,
  email: "alice.new@example.com",
  name: "Alice Smith",
  status: "active",
});
```

::: tip Replace vs. Update

- **`updateOne`** — sends only the fields you want to change (partial)
- **`replaceOne`** — replaces the entire record with new data (full)
  :::

`replaceOne` also supports `$cas` on [versioned tables](/api/versioning) — same semantics as `updateOne`.

### Replace Many

Replace every record matching a filter with the **same** payload — the filter-based sibling of `updateMany`. Unlike `replaceOne`, it does **not** null-fill: on every adapter it assigns the given columns on each matched row (a `$set`-style merge — SQL `UPDATE … SET`, MongoDB `updateMany` + `$set`, memory merge), so omitted optional fields keep their stored values. All required fields must still be provided (the payload is validated in `replace` mode); a versioned table bumps `version` on every matched row:

```typescript
const result = await users.replaceMany(
  { status: "inactive" },
  { email: "archived@example.com", name: "Archived User", status: "archived" },
);
// result: { matchedCount, modifiedCount }
```

For replacing many records with **different** payloads (each identified by its primary key), use [`bulkReplace`](#bulk-operations) instead.

## Deleting Records

### Delete One

Delete a single record by ID:

```typescript
const result = await users.deleteOne(1);
// result: { deletedCount: 1 }
```

`deleteOne` accepts the same flexible ID format as `findById` — primary key, composite key object, or unique index value — and deletes the one row that id addresses, [primary key first](#id-resolution). An optional `{ guard }` runs inside the delete's transaction once the id has resolved to a filter — see [Write guards](#write-guards).

### Delete Many

Delete all records matching a filter:

```typescript
const result = await users.deleteMany({
  status: "archived",
});
// result: { deletedCount: 12 }
```

::: info Cascade & Set-Null
When a deleted record is referenced by other tables via foreign keys, cascade and set-null behaviors are handled automatically based on `@db.rel.onDelete` annotations. See [Relations](/relations/deep-operations) for details.
:::

## Bulk Operations

For batched writes that apply different changes to each record (vs. `updateMany`, which applies the same change to many rows), use `bulkUpdate` and `bulkReplace`. Both accept an array of payloads (each identified by its primary key) and an optional `{ maxDepth, guard }` options object (see [Write guards](#write-guards)), and they participate in the surrounding transaction.

| Method                      | Purpose                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bulkUpdate(items, opts?)`  | A different patch per row                                                                                                |
| `bulkReplace(items, opts?)` | A different full replacement per row                                                                                     |
| `touchMany(keys, opts?)`    | Batch versioned touch (since 0.1.129, versioned tables only). See [Versioning — Batch touch](/api/versioning#touch-many) |

```typescript
import { $dec } from "@atscript/db/ops";

await products.bulkUpdate([
  { id: 1, stock: $dec(2) },
  { id: 2, stock: $dec(5) },
  { id: 3, stock: $dec(1) },
]);

await users.bulkReplace([
  { id: 1, email: "alice.new@example.com", name: "Alice" /* …all fields */ },
  { id: 2, email: "bob.new@example.com", name: "Bob" /* …all fields */ },
]);
```

See [Update & Patch](/api/update-patch) for the full operator catalog and per-payload options.

::: warning Nested writes need `@db.depth.limit`
Insert / replace / patch payloads that nest into `@db.rel.from` or `@db.rel.via` children are rejected at the validator boundary unless the table declares [`@db.depth.limit N`](/relations/deep-operations) with `N >= 1`. The default — annotation absent — is `0`, which blocks every nested write. See [Relations — Deep Operations](/relations/deep-operations).
:::

## Write Guards {#write-guards}

Since 0.1.128 every keyed write — `insertOne` / `insertMany`, `replaceOne` / `bulkReplace`, `updateOne` / `bulkUpdate` — accepts `{ guard }` in its options, and `deleteOne(id, { guard })` too. The table invokes the guard **exactly once, inside its own transaction**, after `undefined` props were pruned, defaults applied and the rows validated, and before encryption and the nested-relation phases. It is the validated stage: what the guard sees is what the table is about to write.

```typescript
import type { TDbWriteGuardContext } from "@atscript/db";

await orders.insertMany(rows, {
  guard: async (ctx: TDbWriteGuardContext<Order>) => {
    // ctx.action: 'insert' | 'insertMany' | 'replace' | 'replaceMany' | 'update' | 'updateMany'
    for (let i = 0; i < ctx.rows.length; i++) {
      const row = ctx.rows[i]; // validated, defaults applied (insert / replace), `$cas` removed (update)
      row.updatedBy = currentUserId(); // enrich in place — the table validates the rows again
      const before = await ctx.current(i); // lazy, memoised pre-image read inside the transaction
      if (before?.locked) throw new Error("locked"); // rolls the transaction back, propagates unchanged
      // ctx.expectedVersions[i]: the version a `$cas` predicate expects, or undefined
    }
  },
});

await orders.deleteOne(id, {
  guard: async (ctx) => {
    // ctx.id, ctx.filter (the resolved identifying filter), ctx.current() → the row or null
    if ((await ctx.current())?.isFallback) throw new Error("cannot delete the fallback row");
  },
});
```

- `ctx.current(i)` reads the row exactly as the write identifies it — by its primary key, else by a unique index — so it is always the row the write targets. It never throws for a row without an identifying key (an auto-increment insert): it resolves to `null`.
- `ctx.currentAll()` (since 0.1.143) reads every row's pre-image in **one** `findMany` and resolves to an array parallel to `ctx.rows` — each entry exactly what `current(i)` would give. It fills the same per-index memo: an index `current(i)` already read is reused, and a later `current(i)` reads nothing. Prefer it to a `current(i)` loop on batches.
- `ctx.filterFor(i)` (since 0.1.143) is the exact filter the write identifies `rows[i]` by — its primary key, else the unique index it carries, each naming at most one row — or `null` when the row has no identifying key yet. It is the filter `current(i)` reads by, memoised per index on first use (change a row's identifying fields before asking, not after). It lets a guard check a whole batch in the database without reading it:

  ```typescript
  // Row-level USING: every row this update targets must be the caller's.
  guard: async (ctx) => {
    const filters = ctx.rows.map((_, i) => ctx.filterFor(i)).filter((f) => f !== null);
    if (filters.length === 0) return;
    const distinct = new Set(filters.map((f) => JSON.stringify(f))).size;
    const owned = await orders.count({ filter: { $and: [{ $or: filters }, { ownerId: me }] } });
    if (owned !== distinct) throw new Error("row outside your scope"); // missing rows count as misses
  };
  ```

- A delete guard's `ctx.filter` is the exact filter the delete targets ([primary key first](#id-resolution)).
- A throw rolls the table's transaction back — including anything the guard itself wrote through other tables that joined it — and the same error propagates to the caller.
- The guard runs for the root call only, never for the nested re-entries a deep write performs on related tables.
- An id that resolves to no filter makes `deleteOne` answer `{ deletedCount: 0 }` without calling the guard.
- In `@atscript/moost-db`, overriding `guardWrite` / `guardRemove` on a controller passes that override as the guard — see [Customization — Write Hooks](/http/customization#write-hooks).

## Post-write Check {#write-check}

Since 0.1.143, `insertOne` / `insertMany`, `replaceOne` / `bulkReplace` and `updateOne` / `bulkUpdate` accept `{ check }`. A guard sees the rows **before** the write. A check sees what was **actually written**, through the database's own filter semantics. Use it for a row-level "WITH CHECK" policy: every written row must still match a filter.

The table invokes the check **exactly once per call, inside its transaction, after the main write and every nested-relation phase**. It receives a `TDbWriteCheckContext`:

| Field           | Meaning                                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`        | `'insert'` · `'insertMany'` · `'replace'` · `'replaceMany'` · `'update'` · `'updateMany'`                                                                                                                                                                                    |
| `filters`       | One exact primary-key filter per written row, de-duplicated. Inserted rows appear by their resulting key, auto-increment and generated ids included. Updated / replaced rows appear by the key of the row the write targeted. Rows the write matched nothing for are absent. |
| `transactional` | `true` when a throw rolls the write back. `false` on adapters whose transaction is a pass-through (the memory adapter, a standalone MongoDB): the write is already durable.                                                                                                  |
| `count(filter)` | Counts matching rows inside the same transaction.                                                                                                                                                                                                                            |

```typescript
import type { TDbWriteCheckContext } from "@atscript/db";

// Row-level WITH CHECK: every row this call wrote must belong to the caller's tenant.
const withCheck = async (ctx: TDbWriteCheckContext) => {
  if (ctx.filters.length === 0) return;
  const inScope = await ctx.count({ $and: [{ $or: ctx.filters }, { tenant: currentTenant() }] });
  if (inScope !== ctx.filters.length) {
    throw new Error("row outside your tenant"); // rolls back, propagates unchanged
  }
};

await tasks.updateOne({ id: 1, title: "Renamed" }, { check: withCheck }); // ok
await tasks.updateOne({ id: 1, tenant: "other" }, { check: withCheck }); // throws, nothing written
```

- A throw rolls the table's transaction back and propagates unchanged — **only when `ctx.transactional` is `true`**. Without a real transaction, a caller that needs a hard guarantee must validate before the write: for inserts and replaces, the full rows; for updates, the patched fields.
- Like the guard, the check runs for the root call only. The nested re-entries a deep write performs on related tables get neither `guard` nor `check` nor `isFieldVisible`. See [Nested write rules](/relations/patches#nested-write-rules).
- In `@atscript/moost-db`, overriding `checkWrite` on a controller passes that override as the check.

## Validation

Tables automatically validate data on every write operation using constraints from your `.as` definitions (`@expect.*` annotations). Validation is purpose-aware:

| Purpose         | Used by                     | Behavior                                                                                          |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `'insert'`      | `insertOne`, `insertMany`   | PK, defaulted, and FK fields become optional                                                      |
| `'bulkUpdate'`  | `updateOne`, `bulkUpdate`   | Top level is partial; merge-strategy objects partial, replace-strategy objects require all fields |
| `'bulkReplace'` | `replaceOne`, `bulkReplace` | All non-optional fields required                                                                  |
| `'patch'`       | Available for manual checks | Fully partial; useful when you need to validate a partial payload yourself                        |

`updateMany` does **not** run a validator on the data payload — only foreign-key references are checked. If you want strict validation of a partial update, build a `'patch'` validator and run it yourself before calling `updateMany`.

You can access validators directly for manual checks:

```typescript
const validator = users.getValidator("insert");
if (!validator.validate(data, true)) {
  // safe = true → returns false instead of throwing
  console.log(validator.errors);
  // [{ path: 'email', message: 'Required field' }, ...]
}
```

## Error Handling

Database operations throw `DbError` with a `code` property indicating the error type:

| Code                     | Meaning                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONFLICT`               | Unique constraint violation; a nested write that names a related row outside the record's relation (since 0.1.143, see [Nested write rules](/relations/patches#nested-write-rules))                    |
| `FK_VIOLATION`           | Foreign key constraint violated                                                                                                                                                                        |
| `NOT_FOUND`              | Record not found                                                                                                                                                                                       |
| `CASCADE_CYCLE`          | Circular cascade detected                                                                                                                                                                              |
| `INVALID_QUERY`          | Malformed query or filter                                                                                                                                                                              |
| `DEPTH_EXCEEDED`         | Nested-write payload deeper than `@db.depth.limit N` (also a `DepthLimitExceededError`)                                                                                                                |
| `VERSION_COLUMN_WRITE`   | Direct write to a `@db.column.version` column — use `$cas` instead. See [Versioning](/api/versioning#direct-write-rejection)                                                                           |
| `CAS_EXHAUSTED`          | `withOptimisticRetry` exhausted `maxAttempts` (also a `CasExhaustedError`). See [Versioning](/api/versioning#casexhaustederror)                                                                        |
| `CAS_MISMATCH`           | `touchMany` (`require: 'all'`) found a stale or missing key: refused before the first write, or rolled back on SQL (also a `CasMismatchError`). HTTP 409. See [Versioning](/api/versioning#touch-many) |
| `BUCKET_NOT_SUPPORTED`   | The adapter cannot group by the requested [calendar bucket](/api/calendar-buckets) unit, or has no calendar buckets at all. HTTP 400. Since 0.1.132                                                    |
| `BUCKET_TZ_UNAVAILABLE`  | The database cannot convert to the calendar bucket's time zone (e.g. MySQL time zone tables not loaded). HTTP 501. Since 0.1.132                                                                       |
| `AGG_FN_NOT_SUPPORTED`   | A [grouped query](/api/aggregation#aggregate-functions) uses an aggregate function the adapter does not render (e.g. `countDistinct` on a custom adapter). HTTP 400                                    |
| `AGG_EXPR_NOT_SUPPORTED` | A [grouped query](/api/aggregation#arithmetic-expressions) uses an arithmetic entry and the adapter's `supportsAggregateExpressions()` is false (a custom adapter). HTTP 400. Since 0.1.148            |

Handle errors by checking the code:

```typescript
import { DbError } from "@atscript/db";

try {
  await users.insertOne({ email: "alice@example.com", name: "Alice" });
} catch (err) {
  if (err instanceof DbError) {
    switch (err.code) {
      case "CONFLICT":
        console.log("Email already exists:", err.errors);
        break;
      case "FK_VIOLATION":
        console.log("Referenced record missing:", err.errors);
        break;
    }
  }
}
```

Each error includes an `errors` array with `{ path, message }` entries for detailed diagnostics.

### Error Paths in Nested Data

When validation fails inside nested or array payloads, error paths use dot notation to pinpoint the exact location:

| Context            | Example path              | Meaning                                            |
| ------------------ | ------------------------- | -------------------------------------------------- |
| Top-level field    | `"title"`                 | The `title` field failed validation                |
| TO navigation      | `"project.title"`         | The `title` field inside inline `project` data     |
| FROM array element | `"comments.0.body"`       | The `body` field of the first comment in the array |
| Deep nesting       | `"tasks.2.project.title"` | The `title` of the project in the third task       |

This makes it straightforward to map errors back to specific fields in complex nested payloads — useful for building form validation UIs.

## Next Steps

- [Queries & Filters](/api/queries) — Advanced filtering, sorting, and projection
- [Update & Patch](/api/update-patch) — Embedded array and object patch operators
- [Transactions](/api/transactions) — Atomic multi-table operations
- [Relations — Deep Operations](/relations/deep-operations) — Nested creation and replacement across relations
