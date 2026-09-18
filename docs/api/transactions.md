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

## Adapter Behavior

| Adapter    | DML transactions | Transactional DDL | Notes                                                                                                                                                            |
| ---------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | ✅               | ✅                | Best support; CREATE / ALTER TABLE roll back on failure. A dedicated pooled connection is held for the whole `withTransaction` span                              |
| SQLite     | ✅ (serialised)  | ❌                | One connection per driver: transactions queue behind each other and plain statements wait for `COMMIT` — see [SQLite serialisation](#sqlite-serialisation)       |
| MySQL      | ✅ (InnoDB)      | ❌                | DDL auto-commits. A dedicated pooled connection is held for the whole `withTransaction` span                                                                     |
| MongoDB    | ✅               | n/a               | **Requires a replica set**; falls back to no-op on standalone (same code works dev → prod). The callback may **re-run** on transient errors — keep it idempotent |
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
- Read-only queries (no mutations to protect)

**Inside a keyed write**, pass `{ guard }` to run validated checks inside the table's own transaction — see [Write guards](/api/crud#write-guards). **In a `moost-db` controller**, override `guardWrite` / `guardRemove` (the override becomes that guard) and use `this.withTransaction(fn)` for custom actions — see [Customization — Write Hooks](/http/customization#write-hooks).

## Next Steps

- [Relations — Deep Operations](/relations/deep-operations) — Auto-transactional nested CRUD
- [Schema Sync](/sync/) — Automatic schema migrations
- [Adapters](/adapters/) — Full adapter configuration and features
