---
outline: deep
---

# Tables & Fields

<!--@include: ../_experimental-warning.md-->

Atscript lets you define database tables directly in `.as` files. Each table is an interface annotated with `@db.table` — the fields become columns, and annotations control how they map to the underlying database.

## Declaring a Table

Add `@db.table` to an interface to make it a database table:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    id: number

    name: string
    email: string
    bio?: string
}
```

The string argument sets the physical table name in the database. Optional fields (marked with `?`) become nullable columns.

If you omit the name, the interface name is used directly:

```atscript
@db.table
export interface User { ... }
// Table name: "User"
```

Providing an explicit name is recommended — it gives you control over casing and pluralization regardless of how you name your interface.

## Primary Keys

Mark the primary key with `@meta.id`:

```atscript
@db.table 'tasks'
export interface Task {
    @meta.id
    id: number

    title: string
    done: boolean
}
```

The `@meta.id` annotation takes no arguments. Every table should have at least one primary key field. `@meta.id` only marks the field as the primary key — it does **not** generate values on its own. Add `@db.default.increment` (numeric, auto-incrementing) or `@db.default.uuid` (random UUID string) when you want the database to populate the key for you. See [Defaults & Generated Values](/api/defaults).

When a `number` field is the primary key, SQLite stores it as `INTEGER` rather than the default `REAL` so it can act as the table's row id.

## Composite Primary Keys

When multiple fields are annotated with `@meta.id`, they form a composite primary key. This is common for junction tables in many-to-many relationships:

```atscript
@db.table 'task_tags'
export interface TaskTag {
    @meta.id
    taskId: number

    @meta.id
    tagId: number

    assignedAt?: number.timestamp.created
}
```

Here, the combination of `taskId` and `tagId` uniquely identifies each row. Neither field alone is unique — only the pair together serves as the key.

### Composite Key Operations

All CRUD operations work with composite keys. For programmatic usage, pass an object with all key fields:

```typescript
// Find by composite key
const entry = await taskTags.findById({ taskId: 1, tagId: 2 });

// Delete by composite key
await taskTags.deleteOne({ taskId: 1, tagId: 2 });

// Replace by composite key (all fields required)
await taskTags.replaceOne({ taskId: 1, tagId: 2, assignedAt: Date.now() });

// Update by composite key (partial)
await taskTags.updateOne({ taskId: 1, tagId: 2, assignedAt: Date.now() });
```

Providing only some key fields results in a `400` error for operations that require the full key (findById, deleteOne, replaceOne, updateOne). For `findMany`, partial key fields act as regular filters.

::: tip HTTP usage
See the [HTTP CRUD endpoints](/http/crud#get-one) for how composite keys map to URL query parameters.
:::

## Field Types

Atscript types map to database column types automatically:

| Atscript Type  | SQLite                | PostgreSQL                                                      | MySQL                    | MongoDB       |
| -------------- | --------------------- | --------------------------------------------------------------- | ------------------------ | ------------- |
| `string`       | TEXT                  | TEXT / VARCHAR                                                  | VARCHAR / TEXT           | string        |
| `number`       | REAL (INTEGER for PK) | DOUBLE PRECISION (BIGINT with `@db.default.increment` / `.now`) | DOUBLE (INT for PK)      | number        |
| `decimal`      | REAL                  | NUMERIC(p,s)                                                    | DECIMAL(p,s)             | string        |
| `boolean`      | INTEGER (0/1)         | BOOLEAN                                                         | TINYINT(1)               | boolean       |
| Arrays         | TEXT (JSON)           | JSONB                                                           | JSON                     | native array  |
| Nested objects | Flattened columns     | Flattened columns / JSONB                                       | Flattened columns / JSON | native object |

Semantic subtypes like `string.email`, `number.int`, and `number.timestamp` map to the same base column types. They carry meaning for validation and code generation, but the storage type follows the base type.

The `decimal` type is stored as a string at runtime to preserve exact precision. This also means it passes through JSON transport without any loss. Use `@db.column.precision` to control the database column's precision and scale — see [Indexes & Constraints](/api/indexes#column-precision).

Nested objects and arrays have special storage modes — see [Storage & Nested Objects](/api/storage) for details.

## Custom Column Names

Override the physical column name with `@db.column`:

```atscript
@db.column 'email_address'
email: string
// Column in DB: email_address
// Field in code: email
```

::: tip When to use `@db.column`
Reach for `@db.column` when you need a custom physical name — typically to map to a legacy schema or to satisfy an external naming convention. If you control the schema, prefer naming your Atscript fields to match the desired column names so no remapping is needed.
:::

For nested objects that are flattened, the parent prefix is prepended automatically. If you rename a parent field, all its flattened children reflect the new prefix.

## Excluding Fields

Use `@db.ignore` to keep a field in the type but exclude it from the database:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    id: number

    name: string

    @db.ignore
    displayName?: string
    // Exists in TypeScript types, no column in DB
}
```

An ignored field cannot also be a primary key — `@db.ignore` and `@meta.id` on the same field is an error.

## Preferred Identifier

By default, `findById` and `deleteOne` resolve scalar ids against the primary key and every **single-field** unique index, and object ids against the primary key plus compound unique indexes. If you want a non-PK unique index (such as `slug` or `email`) to be the canonical "id" for a table, add `@db.table.preferredId.uniqueIndex`:

```atscript
@db.table 'posts'
@db.table.preferredId.uniqueIndex 'by_slug'
export interface Post {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'by_slug'
    slug: string

    title: string
}
```

```typescript
await posts.findById("hello-world"); // resolves against slug
await posts.findById({ id: 42 }); // PK still works
```

With an explicit preferred identifier, scalar ids are routed **only** to the preferred field (deterministic) — they no longer fall back to other single-field unique indexes. Pass the argument-less form when the table has a single unique index group; the name is required only when there are multiple.

## Filter & Sort Gating

By default every column can be filtered or sorted via the auto-generated REST controller. To lock that down, switch the table to manual mode and opt fields in explicitly:

```atscript
@db.table 'users'
@db.table.filterable 'manual'
@db.table.sortable 'manual'
export interface User {
    @meta.id
    id: number

    @db.column.filterable
    @db.column.sortable
    email: string

    // not exposed to ?filter= / ?sort=
    passwordHash: string
}
```

The HTTP layer rejects any filter or sort against a non-allowed column with `400`. This is purely a controller-level concern — the programmatic table API is unaffected.

## Database Schemas

Assign a table to a schema or namespace with `@db.schema`:

```atscript
@db.table 'users'
@db.schema 'auth'
export interface User {
    @meta.id
    id: number
    name: string
}
// Full table path: auth.users
```

This is useful for organizing tables into logical groups, particularly with databases that support schemas natively (like PostgreSQL). SQLite adapters typically prefix the table name.

## Rename Tracking

When you rename a table or column, the schema sync system needs to know the old name to perform a rename migration rather than dropping and recreating:

```atscript
@db.table 'team_members'
@db.table.renamed 'users'
export interface TeamMember {
    @meta.id
    id: number

    @db.column.renamed 'name'
    fullName: string

    email: string
}
```

- `@db.table.renamed 'users'` — tells sync that this table was previously called `users`
- `@db.column.renamed 'name'` — tells sync that `fullName` was previously called `name`

These annotations are consumed during [Schema Sync](/sync/) and can be removed after the migration has been applied to all environments.

## Next Steps

- [Storage & Nested Objects](/api/storage) — how nested objects and arrays are stored
- [Defaults & Generated Values](/api/defaults) — auto-generated values and static defaults
- [Indexes & Constraints](/api/indexes) — database indexes, precision, and collation
- [CRUD Operations](/api/crud) — reading and writing data
- [Relations](/relations/) — foreign keys and table relationships
