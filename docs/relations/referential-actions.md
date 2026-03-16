---
outline: deep
---

# Referential Actions

<!--@include: ../_experimental-warning.md-->

Referential actions control what happens to child records when a parent record is deleted or its primary key is updated. Use `@db.rel.onDelete` and `@db.rel.onUpdate` alongside `@db.rel.FK` to define this behavior.

## `@db.rel.onDelete`

`@db.rel.onDelete` specifies what the database (or the application layer) should do with child records when a parent record is deleted.

| Action         | Behavior                                                   |
| -------------- | ---------------------------------------------------------- |
| `'cascade'`    | Delete child records when the parent is deleted            |
| `'restrict'`   | Prevent parent deletion if child records exist             |
| `'setNull'`    | Set FK field to `null` (field must be optional)            |
| `'setDefault'` | Set FK field to its default value (requires `@db.default`) |
| `'noAction'`   | Database default behavior (adapter-dependent)              |

Here is an example combining cascade and setNull on different FK fields:

```atscript
@db.table 'comments'
export interface Comment {
    @meta.id
    id: number
    body: string

    // Delete comments when the task is deleted
    @db.rel.FK
    @db.rel.onDelete 'cascade'
    taskId: Task.id

    // Keep comment but clear author if user is deleted
    @db.rel.FK
    @db.rel.onDelete 'setNull'
    authorId?: User.id
}
```

The `taskId` FK uses cascade — when a task is deleted, all its comments are deleted too. The `authorId` FK uses setNull — when a user is deleted, comments are preserved but their `authorId` is set to `null`.

## `@db.rel.onUpdate`

`@db.rel.onUpdate` controls what happens when the parent's primary key value changes. It accepts the same five actions as `@db.rel.onDelete`: `'cascade'`, `'restrict'`, `'setNull'`, `'setDefault'`, `'noAction'`.

```atscript
@db.rel.FK
@db.rel.onDelete 'cascade'
@db.rel.onUpdate 'cascade'
projectId: Project.id
```

::: tip
In most applications, primary keys don't change after creation. `@db.rel.onUpdate` is primarily useful for tables with natural keys (like email addresses or codes) that might be updated.
:::

## Default Behavior

When no `@db.rel.onDelete` or `@db.rel.onUpdate` is specified, the behavior depends on the adapter:

- **SQL adapters** (SQLite, MySQL, PostgreSQL) use the database engine's default — typically `'noAction'` or `'restrict'` depending on the engine
- **MongoDB adapter** applies no action by default — the child FK becomes a dangling reference

::: warning
Without explicit referential actions, deleting a parent record may leave orphaned FK values in child tables. Always specify `@db.rel.onDelete` for production schemas.
:::

## Cascade Delete

Cascade is the most common action for dependent child records. When a parent is deleted, all children with `@db.rel.onDelete 'cascade'` are automatically deleted too.

```atscript
@db.table 'projects'
export interface Project {
    @meta.id
    id: number
    name: string

    @db.rel.from
    tasks: Task[]
}

@db.table 'tasks'
export interface Task {
    @meta.id
    id: number
    title: string

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    projectId: Project.id
}
```

```typescript
// Deleting a project also deletes all its tasks
await projects.deleteOne(1);
```

Cascades are recursive — if a task has comments with `onDelete: 'cascade'`, deleting the project deletes the tasks, which deletes the comments.

::: info Cascade depth limit
The application-level cascade engine (used by the MongoDB adapter) enforces a maximum cascade depth of 100 to prevent infinite loops in misconfigured schemas. SQL adapters delegate cascade enforcement to the database engine, which has its own limits.
:::

## Restrict

Use `'restrict'` when child records should prevent parent deletion. This protects important data from accidental cascading deletes.

```atscript
@db.table 'departments'
export interface Department {
    @meta.id
    id: number
    name: string

    @db.rel.from
    employees: Employee[]
}

@db.table 'employees'
export interface Employee {
    @meta.id
    id: number
    name: string

    @db.rel.FK
    @db.rel.onDelete 'restrict'
    departmentId: Department.id
}
```

```typescript
await departments.deleteOne(1);
// Throws DbError { code: 'CONFLICT', errors: [...] }
// because employees with departmentId=1 still exist
```

You must delete or reassign all employees before deleting the department. Via the HTTP controller, this returns a `409 Conflict` response.

## Set Null

`'setNull'` keeps the child record but clears the FK reference. The FK field **must** be optional (`?`):

```atscript
@db.rel.FK
@db.rel.onDelete 'setNull'
assigneeId?: User.id
```

```typescript
// Before: task.assigneeId = 5
await users.deleteOne(5);
// After: task.assigneeId = null
```

::: warning
Using `'setNull'` on a non-optional FK field causes a validation error. The field must be declared with `?` to allow the null state.
:::

## Set Default

`'setDefault'` sets the FK to its default value when the parent is deleted. The FK field must have a `@db.default.*` annotation:

```atscript
@db.default.value 0
@db.rel.FK
@db.rel.onDelete 'setDefault'
categoryId: Category.id
```

If the field has no `@db.default.*` annotation, Atscript reports a warning at schema validation time — the field will have no fallback value when the parent is deleted.

::: info
`'setDefault'` is rarely used in practice. Most schemas use `'cascade'` for dependent data, `'restrict'` for protected references, or `'setNull'` for optional associations.
:::

## Composite Foreign Keys

When a composite FK (multiple fields referencing the same target with the same alias) needs a referential action, declare the action on exactly one of the FK fields:

```atscript
@db.table 'order_items'
export interface OrderItem {
    @meta.id
    id: number

    @db.rel.FK 'order'
    @db.rel.onDelete 'cascade'
    orderId: Order.id

    @db.rel.FK 'order'
    orderProductId: Order.productId

    quantity: number
}
```

Placing `@db.rel.onDelete` on multiple fields within the same composite FK group causes a validation error — the action applies to the entire composite FK, not individual fields.

## Adapter Considerations

Referential actions are enforced differently depending on the adapter:

- **SQL adapters** (SQLite, MySQL, PostgreSQL) — actions are defined as native SQL `ON DELETE` / `ON UPDATE` clauses on the foreign key constraint. The database engine enforces them atomically.
- **MongoDB adapter** — there are no native FK constraints. The generic DB layer emulates referential actions at the application level: before deleting a record, it queries for children and applies the configured action (cascade delete, restrict with error, or set null).

The behavior is identical from the application's perspective — the same `@db.rel.onDelete 'cascade'` annotation works the same way regardless of adapter.

## Next Steps

- [Foreign Keys](./index) — declaring FK fields with `@db.rel.FK`
- [Navigation Properties](./navigation) — defining TO, FROM, and VIA relations
- [Deep Operations](./deep-operations) — how referential actions interact with nested writes
