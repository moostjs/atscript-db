---
outline: deep
---

# Transactions

<!--@include: ../_experimental-warning.md-->

Transactions ensure that multiple database operations either all succeed or all roll back together. If any operation within a transaction fails, every change is reverted, leaving your database in a consistent state.

## Basic Usage

`withTransaction` lives on the **adapter**, not on the table. Access it via `space.getAdapter()` or `table.getAdapter()`:

```typescript
const adapter = db.getAdapter(User);

await adapter.withTransaction(async () => {
  await users.insertOne({ email: "alice@example.com", name: "Alice" });
  await todos.insertOne({ title: "Welcome task", ownerId: 1 });
});
```

If any operation throws, the entire transaction rolls back. Neither the user nor the todo will be inserted.

The return value of the callback is propagated:

```typescript
const id = await adapter.withTransaction(async () => {
  const result = await users.insertOne({ email: "alice@example.com", name: "Alice" });
  return result.insertedId;
});
// id is the inserted user's primary key
```

## Cross-Table Transactions

Each table in a `DbSpace` has its own adapter instance, but transactions are shared across all adapters in the same async context via `AsyncLocalStorage`. Start a transaction on **any** adapter — all operations in the callback automatically participate:

```typescript
const users = db.getTable(User);
const projects = db.getTable(Project);
const tasks = db.getTable(Task);

const adapter = db.getAdapter(User);

await adapter.withTransaction(async () => {
  const { insertedId } = await users.insertOne({
    name: "Alice",
    email: "alice@example.com",
  });
  await projects.insertOne({ title: "New Project", ownerId: insertedId });
  await tasks.insertMany([
    { title: "Setup", projectId: 1 },
    { title: "Deploy", projectId: 1 },
  ]);
});
```

Even though `users`, `projects`, and `tasks` have separate adapter instances, the `AsyncLocalStorage` context ensures they all use the same underlying transaction.

## Automatic Nesting

Nested `withTransaction()` calls reuse the outer transaction — no savepoints are created, and no extra `BEGIN`/`COMMIT` pairs are issued:

```typescript
await adapter.withTransaction(async () => {
  await users.insertOne({ name: "Alice", email: "alice@example.com" });

  // Inner transaction reuses outer — no extra BEGIN/COMMIT
  await adapter.withTransaction(async () => {
    await tasks.insertOne({ title: "Welcome task", ownerId: 1 });
  });
});
```

This means library code can safely call `withTransaction()` without worrying about whether the caller has already started one. If a transaction is active, the inner call joins it; otherwise, a new one begins.

## Deep Operations Are Transactional

All deep operations automatically wrap themselves in a transaction. You don't need explicit `withTransaction()` for:

- `insertOne` / `insertMany` with nested relation data
- `replaceOne` / `bulkReplace` with nested data
- `updateOne` / `bulkUpdate` with nested data
- `deleteOne` with cascade behavior

For example, inserting a user with related tasks and project references runs as a single atomic operation internally — if any part fails, all changes roll back. See [Relations — Deep Operations](/relations/deep-operations) for details.

## Error Handling and Rollback

When an error is thrown inside `withTransaction()`, the transaction rolls back and the error propagates to the caller:

```typescript
try {
  await adapter.withTransaction(async () => {
    await users.insertOne({ email: "alice@example.com", name: "Alice" });
    throw new Error("Something went wrong");
    // User is NOT inserted — entire transaction rolls back
  });
} catch (error) {
  console.log("Transaction rolled back:", error.message);
}
```

This applies to any kind of failure — validation errors, constraint violations, or application-level errors. The database remains in the state it was in before the transaction began.

If the rollback itself fails, the rollback error is swallowed and the original error is preserved.

### Retrying deadlocks and lock timeouts {#retrying}

Since 0.1.153, when MySQL or PostgreSQL picks your transaction as a **deadlock** victim (MySQL errno 1213, PostgreSQL `40P01`) or a row lock is **not granted in time** (MySQL 1205 `innodb_lock_wait_timeout`, PostgreSQL `55P03` `lock_timeout` / `NOWAIT`), the write throws `DbError` with code `DEADLOCK` or `LOCK_TIMEOUT`. PostgreSQL's `40001` (could not serialize access — under `REPEATABLE READ` / `SERIALIZABLE`) throws `SERIALIZATION_FAILURE`. All three carry `retryable: true`; `isRetryableDbError(error)` tests for them. The database has already rolled the transaction back (a MySQL lock wait timeout fails only the statement, but `withTransaction` rolls the rest back as the error propagates), so retry the **whole** callback, not the failed statement:

```typescript
import { isRetryableDbError } from "@atscript/db";

async function inTransactionWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await adapter.withTransaction(fn);
    } catch (error) {
      if (!isRetryableDbError(error) || attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 20 * attempt)); // small backoff
    }
  }
}
```

`@atscript/moost-db` answers these codes with **503**. To avoid the most common deadlock — ignore-insert rows, then update the ones that already existed — see [`lockConflicts`](/api/crud#insert-ignore-lock).

## Locking reads {#locking-reads}

Since 0.1.162, `findOne`, `findMany` and `findById` take a row lock when you pass `{ lock }`. Use it to "read the current row and keep it until I write" — without a version column, a counter or a touch-then-read workaround:

```typescript
const adapter = db.getAdapter(Order);

await adapter.withTransaction(async () => {
  const order = await orders.findById(orderId, { lock: "update" });
  if (order.status !== "open") throw new Error("Order is closed");
  await orders.updateOne({ id: orderId, status: "paid" });
}); // the lock is released at COMMIT / ROLLBACK
```

A second transaction asking for the same row waits until the first one ends, then reads the committed value.

| Option | Values                                            | Effect                                                                                                                                                                                                        |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock` | `'update'` / `'share'`                            | `'update'` takes an exclusive lock (`SELECT … FOR UPDATE`), so other lockers and writers wait. `'share'` takes a shared lock (`FOR SHARE`): other `'share'` readers proceed, but writers wait.                |
| `wait` | `'block'` (default) / `'nowait'` / `'skipLocked'` | `'nowait'` fails at once with a retryable `DbError("LOCK_TIMEOUT")` when the row is locked. `'skipLocked'` leaves locked rows out of the result, for queue-style "claim the next free rows". Requires `lock`. |

```typescript
// claim up to 10 pending jobs no other worker holds
await adapter.withTransaction(async () => {
  const batch = await jobs.findMany(
    { filter: { status: "pending" }, controls: { $sort: { id: 1 }, $limit: 10 } },
    { lock: "update", wait: "skipLocked" },
  );
  // … process and update `batch`
});
```

Rules:

- **It needs a transaction.** A lock outside a `withTransaction` scope of the table's adapter throws `INVALID_QUERY`, because a lock held for a single autocommit statement is always a bug.
- **It works on tables only.** Views and `$groupBy`, aggregate `$select` or `$count` reads throw `INVALID_QUERY`. `count`, `aggregate`, `findManyWithCount` and search reads take no lock option.
- **`findById` with `'skipLocked'` answers `null` when the row the id names is held.** It never falls through to another identification, so an id that is also a unique-key value of a different row does not return that row.
- **Only the root rows are locked.** `$with` relations load with plain reads. To lock children, read them with their own locking `findMany`. A `$some` / `$none` filter does not lock the related rows it checks.
- **Locks last until the outermost transaction ends.** A nested `withTransaction` joins it and adds no savepoint.
- **It is a server-side option only.** It is the second argument, never a query control, so it cannot arrive over HTTP. In a `moost-db` controller, call it inside `this.withTransaction(fn)` in a custom action.

| Adapter    | Locking read                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | Native `FOR UPDATE` / `FOR SHARE` [`NOWAIT` / `SKIP LOCKED`]. Under `repeatable read` or `serializable`, locking a row that changed since the snapshot throws `SERIALIZATION_FAILURE` (retryable).    |
| MySQL 8    | Native, same syntax. A locking read is a _current_ read: it sees the latest committed row even under the default REPEATABLE READ, where a plain read in the same transaction still sees the snapshot. |
| SQLite     | Accepted as a no-op. Every transaction starts with `BEGIN IMMEDIATE`, which holds the database write lock, so no other writer can change the row.                                                     |
| MongoDB    | Throws `LOCK_NOT_SUPPORTED` (`moost-db`: 501). Use [`$cas` / `withOptimisticRetry`](/api/versioning) instead.                                                                                         |
| Memory     | Accepted and ignored inside a `withTransaction` scope.                                                                                                                                                |

**DOs and DON'Ts**

- **Do** keep a locked transaction short. Never await an HTTP call or other slow I/O while holding a row lock, because every other writer of that row waits for you.
- **Do** lock by primary key (`findById`, or a filter on the key). On MySQL a filter without an index locks every row the scan touches.
- **Don't** page a locking read with `$skip`. The rows `$skip` passes over are locked too (PostgreSQL and MySQL lock every row they read), so filter or `$limit` to exactly the rows you need.
- **Do** lock several rows in one stable order (`$sort` by the primary key) so concurrent transactions don't deadlock. A deadlock that still happens throws `DEADLOCK` — [retry the transaction](#retrying).
- **Do** use `'nowait'` when waiting is pointless (for example, "someone else is already processing this"). Treat its `LOCK_TIMEOUT` as "busy".
- **Don't** reach for `isolation` to get fresh reads. Use a locking read: isolation alone takes no lock, so read-then-write still races.

## Isolation level {#isolation}

`withTransaction(fn, { isolation })` (since 0.1.162) opens the transaction at `'read committed'`, `'repeatable read'` or `'serializable'`:

```typescript
await adapter.withTransaction(
  async () => {
    // read-validate-write that must not suffer write skew
  },
  { isolation: "serializable" },
);
```

- **It means "at least this level".** An engine that always runs stricter satisfies every level.
- **Set it on the outermost call.** A nested `withTransaction` joins the open transaction. It may name a level only when that transaction was opened at the same or a stricter one; otherwise it throws `INVALID_QUERY`, because a running transaction's level cannot change.
- **Expect retries at the stricter levels.** PostgreSQL `repeatable read` / `serializable` transactions can fail with `SERIALIZATION_FAILURE`, so [retry the whole callback](#retrying).
- **Without it** you get the engine default: READ COMMITTED on PostgreSQL, REPEATABLE READ on MySQL.

| Adapter    | `isolation`                                                                                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | `BEGIN ISOLATION LEVEL …`                                                                                                                                                                                                                                |
| MySQL      | `SET TRANSACTION ISOLATION LEVEL …` on the transaction's connection, right before `START TRANSACTION`                                                                                                                                                    |
| SQLite     | Every level is satisfied: `BEGIN IMMEDIATE` transactions are serializable                                                                                                                                                                                |
| MongoDB    | `'read committed'` / `'repeatable read'` are satisfied by the transaction's snapshot. `'serializable'` throws `ISOLATION_NOT_SUPPORTED` (snapshot isolation allows write skew), and so does any level on a standalone server, which has no transactions. |
| Memory     | Accepted and ignored                                                                                                                                                                                                                                     |

In a `moost-db` controller, `this.withTransaction(fn, { isolation })` forwards the option.

## Adapter Behavior

| Adapter    | DML transactions | Transactional DDL | Notes                                                                                                                                                            |
| ---------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | ✅               | ✅                | Best support; CREATE / ALTER TABLE roll back on failure. A dedicated pooled connection is held for the whole `withTransaction` span                              |
| SQLite     | ✅ (serialised)  | ❌                | One connection per driver: transactions queue behind each other and plain statements wait for `COMMIT` — see [SQLite serialisation](#sqlite-serialisation)       |
| MySQL      | ✅ (InnoDB)      | ❌                | DDL auto-commits. A dedicated pooled connection is held for the whole `withTransaction` span                                                                     |
| MongoDB    | ✅               | n/a               | **Requires a replica set or mongos**; a no-op on a standalone (same code works dev → prod). The callback may **re-run** on transient errors — keep it idempotent |
| Memory     | ❌               | n/a               | `withTransaction` runs the callback; nothing rolls back. Test rollback behaviour on SQLite `:memory:` or with adapter spies                                      |

### SQLite serialisation {#sqlite-serialisation}

Since 0.1.128 the SQLite adapter serialises transactions through a per-driver FIFO gate: `withTransaction` takes the gate before `BEGIN IMMEDIATE` and releases it on `COMMIT` / `ROLLBACK`; every plain read or write from another async context waits until the transaction is over instead of executing inside it. Two concurrent `withTransaction` calls therefore both succeed, one after the other, where they used to fail with `cannot start a transaction within a transaction`. Never await external I/O (an HTTP call, another connection) inside a SQLite transaction — the whole connection waits with you — and note that schema operations take the same connection gate (since 0.1.128), so they never land inside a request's transaction. Options, timeouts and the full posture are on the [SQLite adapter page](/adapters/sqlite#concurrency-and-transactions).

### Transaction state is per adapter family

Transaction state is branded by the connection it belongs to — the driver, pool or client every adapter of a space shares (since 0.1.128). Nested `withTransaction` calls on adapters over the same connection join the open transaction; a nested call on a _different_ family or connection (a MongoDB write inside a SQLite transaction, a SQLite write inside a MySQL one, a second pool) opens its **own** transaction on top of the outer one, and a bare statement of another family runs autocommit — with SQLite statements still queued behind SQLite's own transactions. The outer family's statements issued inside the inner callback still belong to the outer transaction. Cross-engine atomicity is not provided.

Schema sync is not one transaction either: each step (`getExistingColumns`, `syncColumns`, `syncIndexes`, …) is its own statement group — on SQLite each step takes and releases the connection gate — so a request served between two steps can observe a half-synced table. Run `syncSchema` before serving traffic.

## When to Use Explicit Transactions

**Use `withTransaction()` when:**

- Multiple independent writes must be atomic
- Custom business logic spans multiple tables
- Batch operations where partial completion is unacceptable

**You do NOT need explicit transactions for:**

- Single record operations (already atomic)
- Deep operations with nested data (auto-wrapped)
- Read-only queries (no mutations to protect), unless you need a [locking read](#locking-reads)

**Inside a keyed write**, pass `{ guard }` to run validated checks inside the table's own transaction — see [Write guards](/api/crud#write-guards). **In a `moost-db` controller**, override `guardWrite` / `guardRemove` (the override becomes that guard) and use `this.withTransaction(fn)` for custom actions — see [Customization — Write Hooks](/http/customization#write-hooks).

## Next Steps

- [Relations — Deep Operations](/relations/deep-operations) — Auto-transactional nested CRUD
- [Schema Sync](/sync/) — Automatic schema migrations
- [Adapters](/adapters/) — Full adapter configuration and features
