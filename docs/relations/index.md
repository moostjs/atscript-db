---
outline: deep
---

# Foreign Keys

<!--@include: ../_experimental-warning.md-->

Relational data rarely lives in a single table. Atscript lets you define foreign keys directly in your `.as` schema so that relationships between tables are explicit, type-safe, and portable across database adapters.

This page covers how to declare foreign keys. Once FKs are in place, you can add [navigation properties](./navigation) to traverse relationships at query time, define [referential actions](./referential-actions) that control cascade behavior, and [load related data](./loading) in your queries.

## Declaring a Foreign Key

A foreign key links a field in one table to the primary key (or unique field) of another table. Use `@db.rel.FK` and a **chain reference** to declare it:

```atscript
@db.table 'tasks'
export interface Task {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    ownerId: User.id
}
```

The chain reference `User.id` tells Atscript that `ownerId` points to the `id` field on the `User` table. The referenced field must be marked with `@meta.id` or `@db.index.unique`.

::: info What a chain reference is
A chain reference is a dotted path like `User.id` used as a field type. It resolves to the scalar type of the target field (here, `number`) while also carrying the relationship information that `@db.rel.FK` needs.
:::

## What Foreign Keys Give You

Declaring `@db.rel.FK` on a field provides:

- **DB-level constraint enforcement** — the database rejects inserts or updates that reference a non-existent parent record (adapters without native FK support emulate this at the application level)
- **Cascade and restrict behavior** — control what happens when a parent is deleted or updated via [referential actions](./referential-actions)
- **Relation loading** — define [navigation properties](./navigation) that use the FK to traverse between tables

Without `@db.rel.FK`, a field with a chain reference type is just a regular scalar field — it has no relational semantics.

## Optional Foreign Keys

Not every relationship is mandatory. Use `?` to make a foreign key nullable — the field can hold a valid reference or `null`:

```atscript
@db.rel.FK
assigneeId?: User.id
```

This is common for fields like "assignee" or "reviewer" where a record may not have a related parent yet. See [Loading Relations — Nullable FK Lifecycle](./loading#nullable-fk-lifecycle) for how null FKs behave at query time.

## FK Aliases

When a table has multiple foreign keys pointing to the same target type, you must provide aliases to distinguish them:

```atscript
@db.table 'articles'
export interface Article {
    @meta.id
    id: number

    title: string

    @db.rel.FK 'author'
    authorId: User.id

    @db.rel.FK 'reviewer'
    reviewerId?: User.id
}
```

The alias string (`'author'`, `'reviewer'`) becomes important when you define [navigation properties](./navigation) — it tells Atscript which FK to follow.

::: warning Disambiguation required
If two or more unaliased `@db.rel.FK` fields point to the same target type, Atscript reports an error. Always add aliases when multiple FKs reference the same table.
:::

## Composite Foreign Keys

When a target table has a composite primary key (multiple `@meta.id` fields), declare one FK per key field. They automatically combine into a single composite foreign key:

```atscript
@db.table 'order_items'
export interface OrderItem {
    @meta.id
    id: number

    @db.rel.FK
    orderId: Order.id

    @db.rel.FK
    productId: Order.productId

    quantity: number
}
```

Both `orderId` and `productId` reference fields on `Order`, so they form a single composite FK that matches the composite primary key of the `Order` table.

## Complete Example

Here is a three-table schema that demonstrates different FK patterns:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    @db.default.increment
    id: number

    name: string
    email: string
}

@db.table 'projects'
export interface Project {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    ownerId: User.id
}

@db.table 'tasks'
export interface Task {
    @meta.id
    @db.default.increment
    id: number

    title: string
    done: boolean

    // Required FK — every task belongs to a project
    @db.rel.FK
    @db.rel.onDelete 'cascade'
    projectId: Project.id

    // Optional FK — task may or may not have an assignee
    @db.rel.FK 'assignee'
    @db.rel.onDelete 'setNull'
    assigneeId?: User.id
}
```

```
┌──────────┐       ┌──────────────┐       ┌──────────┐
│  users   │       │    tasks     │       │ projects │
├──────────┤       ├──────────────┤       ├──────────┤
│ id (PK)  │◄──────│ assigneeId?  │       │ id (PK)  │
│ name     │       │ projectId ───┼──────►│ name     │
│ email    │       │ id (PK)      │       │ ownerId ─┼──►users.id
│          │       │ title        │       │          │
│          │       │ done         │       │          │
└──────────┘       └──────────────┘       └──────────┘
```

The `projectId` FK is required (every task must belong to a project) with cascade delete. The `assigneeId` FK is optional and aliased, with set-null on delete. The `ownerId` FK on `Project` is a simple required FK with no explicit referential action.

::: warning Nested writes require `@db.depth.limit`
If you plan to insert/replace/patch a parent together with its 1:N (`@db.rel.from`) or M:N (`@db.rel.via`) children in a single payload, you must add `@db.depth.limit N` on the parent table. Without it, nested writes are rejected with HTTP 400 (`DEPTH_EXCEEDED`). See [Deep Operations § `@db.depth.limit`](./deep-operations#depth-limit).
:::

## Next Steps

- [Navigation Properties](./navigation) — define `@db.rel.to`, `@db.rel.from`, and `@db.rel.via` to traverse relationships
- [Referential Actions](./referential-actions) — control cascade, restrict, and set-null behavior
- [Loading Relations](./loading) — query related data with `$with` controls
- [Deep Operations](./deep-operations) — nested writes and the `@db.depth.limit` gate
