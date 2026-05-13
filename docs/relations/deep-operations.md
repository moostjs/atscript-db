---
outline: deep
---

# Deep Operations

<!--@include: ../_experimental-warning.md-->

When inserting, replacing, or updating records, you can include related data inline — the DB layer handles the multi-phase orchestration automatically. Instead of manually creating parent records, wiring up foreign keys, and inserting children one by one, you pass a single nested payload and Atscript takes care of the rest.

## How Deep Operations Work

The table API detects navigation properties (fields defined with `@db.rel.to`, `@db.rel.from`, or `@db.rel.via`) in your payload and creates, updates, or deletes related records in the correct order. The entire operation is wrapped in a transaction, so if any phase fails, everything rolls back.

Navigation properties are the relation fields you define in your `.as` schema — the same ones used for [querying relations](./navigation). When they appear in a write payload, they trigger deep processing instead of being stored directly.

### Schema Context

The examples on this page use the following schema. It includes TO, FROM, and VIA relations on a `Task` interface:

```atscript
@db.table 'projects'
export interface Project {
    @meta.id
    @db.default.increment
    id: number
    title: string

    @db.rel.FK
    ownerId: User.id
}

@db.table 'tasks'
export interface Task {
    @meta.id
    @db.default.increment
    id: number
    title: string
    status: string

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    projectId: Project.id

    @db.rel.to
    project: Project

    @db.rel.from
    comments: Comment[]

    @db.rel.via TaskTag
    tags: Tag[]
}

@db.table 'comments'
export interface Comment {
    @meta.id
    @db.default.increment
    id: number
    body: string

    @db.rel.FK
    authorId: User.id

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    taskId: Task.id
}

@db.table 'tags'
export interface Tag {
    @meta.id
    @db.default.increment
    id: number
    name: string

    @db.rel.via TaskTag
    tasks: Task[]
}

@db.table 'task_tags'
export interface TaskTag {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    taskId: Task.id

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    tagId: Tag.id
}
```

## Nested Inserts

The DB layer orchestrates multi-phase writes so foreign keys resolve in the
correct order — TO parents first, the main record next, FROM children and VIA
junction entries last. Failures roll back all phases.

Inserting a Task with an inline Project (TO), Comments (FROM), and Tags (VIA):

```typescript
await taskTable.insertOne({
  title: "Design homepage",
  project: { title: "Website Redesign", ownerId: 1 }, // TO: created first
  comments: [
    // FROM: created after
    { body: "Looks good!", authorId: 2 },
  ],
  tags: [{ name: "design" }, { name: "frontend" }], // VIA: targets + junctions
});
```

You never need to manually set `projectId` on the task or `taskId` on the comments — Atscript resolves the FK chain references from your schema and wires them up automatically.

## Nested Replaces (PUT)

A deep replace fully swaps the record and its relations. FROM children are
**diff-synced by primary key** rather than wiped: children whose `@meta.id`
appears in the new payload are updated in place (preserving any downstream
relations), absent ones are cascade-deleted per their referential rules, and
unrecognized entries are inserted. VIA junction entries are recomputed against
the new target set.

```typescript
await taskTable.replaceOne({
  id: 1,
  title: "Redesign homepage",
  status: "in-progress",
  projectId: 1,
  comments: [{ body: "Updated scope", authorId: 1 }],
  tags: [
    { id: 5 }, // existing tag — junction entry created
    { name: "urgent" }, // new tag — record + junction entry created
  ],
});
```

Sending an empty array removes all related records for that relation:

```typescript
await taskTable.replaceOne({
  id: 1,
  title: "Solo task",
  status: "done",
  projectId: 1,
  comments: [], // deletes all comments for this task
  tags: [], // removes all junction entries
});
```

## Nested Updates (PATCH)

Partial updates support relations, but with important constraints:

- **TO relations**: Send changed fields plus the PK — the parent record is partially updated
- **FROM and VIA relations**: You **must** use patch operators (`$insert`, `$remove`, `$update`, `$upsert`, `$replace`) — plain arrays are rejected with a `400` error
- **Nested FROM inside TO**: Not supported — you cannot patch a TO parent's FROM children in a single call. This returns a `400` error.

The reason for requiring operators is straightforward: a partial update cannot infer intent from a plain array. Should `comments: [{ body: 'Hi' }]` add a comment, replace all comments, or something else? Patch operators make your intent explicit.

```typescript
await taskTable.updateOne({
  id: 1,
  project: { id: 2, title: "Updated Title" }, // TO: partial update
  comments: {
    // FROM: requires operators
    $insert: [{ body: "New comment", authorId: 1 }],
  },
  tags: {
    // VIA: requires operators
    $insert: [{ name: "urgent" }],
    $remove: [{ id: 3 }],
  },
});
```

You can combine multiple operators in a single relation field — for example, inserting new items and removing others in one call. See [Relational Patches](./patches) for the full list of array operators and their behavior.

## Depth Control

Nested writes are gated by **two independent limits**: the `@db.depth.limit` annotation on the parent table (the schema-level gate) and the `maxDepth` runtime option (the per-call cap).

### `@db.depth.limit` — Required to Allow Nested Writes {#depth-limit}

By default, **no nested writes through 1:N (`@db.rel.from`) or M:N (`@db.rel.via`) navigation are allowed**. Any payload containing such nested data on a parent without `@db.depth.limit` is rejected with `DEPTH_EXCEEDED` (HTTP 400):

```atscript
// No @db.depth.limit — nested writes through `comments` are rejected.
@db.table 'tasks'
export interface Task {
    @meta.id
    id: number
    title: string

    @db.rel.from
    comments: Comment[]
}
```

Add `@db.depth.limit N` on the parent table to allow nested writes up to N levels of `@db.rel.from` / `@db.rel.via` chaining:

```atscript
@db.table 'tasks'
@db.depth.limit 2     // ← enables nested writes up to 2 levels deep
export interface Task {
    @meta.id
    id: number
    title: string

    @db.rel.from
    comments: Comment[]
}
```

::: info Why FROM/VIA and not TO?
Forward references (`@db.rel.to`) point to a single parent record and don't fan out — they aren't subject to the `@db.depth.limit` gate. The gate exists to prevent unbounded child-tree writes from a single payload (e.g. a deeply nested `posts → comments → replies` chain).
:::

### `maxDepth` — Runtime Per-Call Cap

Independently of `@db.depth.limit`, you can cap the runtime cost of a single nested-write call:

```typescript
await taskTable.insertOne(data, { maxDepth: 5 });
```

The default is **3**. `maxDepth` only lowers the ceiling for one call — it does **not** override the schema-level `@db.depth.limit` gate. If the payload exceeds `maxDepth`:

```
Error: Nested data in 'comments' exceeds maxDepth (1).
Increase maxDepth or strip nested data before writing.
```

This applies to all write operations — `insertOne`, `insertMany`, `replaceOne`, and `updateOne` — via both the programmatic API and the HTTP controller.

## Automatic Transactions

All deep operations are wrapped in `adapter.withTransaction()`. If any phase fails — whether creating a parent record, inserting the main record, or adding children — the entire operation rolls back. No partial writes are left behind.

If you are already inside a transaction (e.g., from an explicit `withTransaction()` call), deep operations participate in the existing transaction rather than creating a nested one.

```typescript
await adapter.withTransaction(async () => {
  // Both deep inserts share the same transaction
  await taskTable.insertOne({ title: "Task A", comments: [{ body: "Note" }] });
  await taskTable.insertOne({ title: "Task B", tags: [{ name: "urgent" }] });
});
```

See [Transactions](/api/transactions) for explicit transaction management and nesting behavior.

## Batch Deep Operations

`insertMany`, `bulkReplace`, and `bulkUpdate` all support nested data per item in the array. Each item goes through the same multi-phase process:

```typescript
await taskTable.insertMany([
  {
    title: "Task A",
    project: { title: "Project X", ownerId: 1 },
    comments: [{ body: "Comment on A", authorId: 1 }],
  },
  {
    title: "Task B",
    project: { title: "Project Y", ownerId: 2 },
    tags: [{ name: "backend" }],
  },
]);
```

All records and their related data are processed within a single transaction.

## Next Steps

- [Relational Patches](./patches) — fine-grained updates with `$insert`, `$remove`, `$update`, `$upsert`, `$replace`
- [Foreign Keys](./index) — declaring FK constraints and chain references
- [Loading Relations](./loading) — querying related data with `$with` controls
