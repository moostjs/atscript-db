---
outline: deep
---

# Transactions

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

All four adapters support transactions, but with important behavioral differences:

### SQLite

- Synchronous `BEGIN` / `COMMIT` / `ROLLBACK` via the driver
- Foreign keys are enabled automatically (`PRAGMA foreign_keys = ON`)
- No transactional DDL — schema changes (CREATE TABLE, ALTER TABLE) take effect immediately and cannot be rolled back

### PostgreSQL

- `BEGIN` / `COMMIT` / `ROLLBACK` on a **dedicated connection** acquired from the pool
- The connection is released back to the pool after commit or rollback
- **Full transactional DDL** — even CREATE TABLE and ALTER TABLE roll back on failure
- Best transaction support of all adapters

### MongoDB

- Uses the **Convenient Transaction API** (`session.withTransaction()`) which automatically retries on `TransientTransactionError` and `UnknownTransactionCommitResult`
- **Requires a replica set** (or mongos topology) — standalone MongoDB does not support transactions
- **Graceful degradation**: on standalone, the adapter detects the topology and silently skips transactional wrapping. Operations run normally without transactional guarantees — no errors are thrown. This allows the same code to work in both development (standalone) and production (replica set) environments

### MySQL

- `START TRANSACTION` / `COMMIT` / `ROLLBACK` on a **dedicated connection** acquired from the pool
- InnoDB engine provides full transaction support for DML (data operations)
- **No transactional DDL** — DDL statements (CREATE TABLE, ALTER TABLE) auto-commit. Schema changes cannot be rolled back

## When to Use Explicit Transactions

**Use `withTransaction()` when:**

- Multiple independent writes must be atomic
- Custom business logic spans multiple tables
- Batch operations where partial completion is unacceptable

**You do NOT need explicit transactions for:**

- Single record operations (already atomic)
- Deep operations with nested data (auto-wrapped)
- Read-only queries (no mutations to protect)

## Next Steps

- [Relations — Deep Operations](/relations/deep-operations) — Auto-transactional nested CRUD
- [Schema Sync](/sync/) — Automatic schema migrations
- [Adapters](/adapters/) — Full adapter configuration and features
