---
outline: deep
---

# What Gets Synced

<!--@include: ../_experimental-warning.md-->

Schema sync detects and applies changes across tables, columns, indexes, foreign keys, views, and table options. This page details each category — what sync looks for, how it handles each change, and what you need to know about destructive operations.

## Tables

Schema sync manages three table lifecycle operations:

### Create

Any type annotated with `@db.table` that does not yet exist in the database triggers a `CREATE TABLE` statement. All columns, constraints, indexes, and foreign keys are created in a single operation.

```atscript
@db.table 'products'
export interface Product {
  @meta.id
  id: number

  name: string
  price: number
}
```

### Rename

The `@db.table.renamed` annotation tells sync to rename an existing table instead of dropping the old one and creating a new one:

```atscript
@db.table 'app_users'
@db.table.renamed 'old_users'
export interface User {
  @meta.id
  id: number

  email: string
}
```

Sync will execute `ALTER TABLE old_users RENAME TO app_users` rather than destroying the original table and its data.

::: tip
Keep `@db.table.renamed` in your `.as` file until the rename has been deployed to all environments (dev, staging, production). Once every environment has the new name, you can safely remove the annotation.
:::

### Drop

Tables present in the database but no longer defined in your `.as` schema are dropped during sync.

::: danger
Dropping a table destroys all data in it. Use `--safe` mode to prevent table drops, or use `--dry-run` to preview what will be removed before applying changes.
:::

## Columns

Column-level changes are detected by `computeColumnDiff()`, which compares the desired field definitions from your `.as` types against the existing columns in the database. Six change types are tracked:

### Add

New fields in a type generate `ALTER TABLE ADD COLUMN` statements. Added columns are nullable by default unless a default value is specified via `@db.default.*`:

```atscript
@db.table 'users'
export interface User {
  @meta.id
  id: number

  email: string

  // New column — added on next sync
  @db.default.value 'free'
  plan: string
}
```

### Rename

The `@db.column.renamed` annotation triggers a column rename instead of a drop-and-add:

```atscript
@db.table 'users'
export interface User {
  @meta.id
  id: number

  // Rename email_address → email
  @db.column.renamed 'email_address'
  email: string
}
```

Sync executes `ALTER TABLE users RENAME COLUMN email_address TO email`, preserving the existing data.

### Type Change

When an existing column's type no longer matches the desired type (e.g., `TEXT` to `INTEGER`), sync detects the mismatch. How it handles the change depends on the adapter:

- **Adapters with `supportsColumnModify`** (MySQL, PostgreSQL) can modify the column type in-place via `ALTER TABLE ... MODIFY COLUMN`.
- **Other adapters** (SQLite) cannot modify columns. You must specify `@db.sync.method 'recreate'` or `'drop'` on the table, or the sync will produce an error.

::: warning
Without either adapter support for in-place modification or a `@db.sync.method` annotation, type changes result in an error status. Sync will not apply any changes to the table until you resolve the conflict. See [Structural Changes](#structural-changes) below.
:::

### Nullable Change

Sync detects when a field changes between optional and required:

```atscript
// Before: optional
bio?: string

// After: required
bio: string
```

Adapters with `supportsColumnModify` handle this in-place. On SQLite, nullable changes require table recreation (see [Structural Changes](#structural-changes)).

### Default Change

Changes to `@db.default.*` values are detected when the existing column already has a recorded default. If the column had no default previously (no baseline exists), changes cannot be detected.

Some adapters handle default changes in-place; others require table recreation.

### Drop

Fields removed from your `.as` type are dropped from the database table.

::: danger
Dropping a column permanently deletes all data stored in it. Use `--safe` mode to suppress column drops, or review carefully with `--dry-run`.
:::

## Indexes

Sync manages indexes prefixed with `atscript__`. Indexes you create with any
other name are left alone — useful for custom partial / expression indexes
that schema sync shouldn't touch.

```atscript
@db.table 'users'
export interface User {
  @meta.id
  id: number

  @db.index.unique
  email: string

  @db.index
  created_at: string
}
```

Adding `@db.index.*` creates the matching managed index; removing the
annotation drops it.

Two annotation-driven special cases participate in the schema hash like any
other change:

- [`@db.index.geo`](/search/geo-search) syncs to a managed `2dsphere` index on
  MongoDB; SQL adapters log a warning and skip it (no index created, no drift
  churn when switching adapters).
- Toggling [`@db.encrypted`](/api/encryption) changes the field's storage type
  (ciphertext is unbounded text), so sync runs — but sync **never**
  encrypts/decrypts existing data, and key material is never written to the
  database.

## Foreign Keys

Foreign key changes are detected by `computeForeignKeyDiff()`, which compares the desired FK constraints (from `@db.rel.FK` annotations) against a stored snapshot. Three change types are tracked:

### Add

New `@db.rel.FK` fields generate foreign key constraints:

```atscript
@db.table 'tasks'
export interface Task {
  @meta.id
  id: number

  // FK target is encoded in the chain reference type (User.id).
  // The optional string argument is an *alias* (used to pair with @db.rel.to / @db.rel.from
  // when multiple FKs point to the same target type), NOT the target field.
  @db.rel.FK
  user_id: User.id
}
```

### Remove

FK fields removed from the schema cause the corresponding constraint to be dropped.

### Change

When a foreign key is retargeted (different table or different fields) or its `@db.rel.onDelete` / `@db.rel.onUpdate` actions change, sync detects the property difference and updates the constraint.

### Adapter Differences

How FK changes are applied depends on the adapter:

- **MySQL, PostgreSQL** — support standalone FK operations via `syncForeignKeys()`. Stale or changed FKs are dropped first (to unblock column alterations), then all desired FKs are synced after column operations complete.
- **SQLite** — cannot `ALTER` foreign keys. Any FK change requires full table recreation. Sync handles this automatically when FK changes are detected on an adapter without `syncForeignKeys` support.

For more on foreign key annotations, see [Foreign Keys](/relations/).

## Table Options

Table-level options are adapter-specific settings detected by `computeTableOptionDiff()`. Changes are only detected when both the desired value (from annotations) and the existing value (from introspection or snapshot) are present — new options without a prior baseline are treated as initial state and do not trigger changes.

Table option changes fall into two categories:

- **Non-destructive** — applied in-place via `ALTER TABLE` (e.g., changing MySQL engine or charset). These are safe and do not affect data.
- **Destructive** — require the table to be recreated (e.g., changing MongoDB capped collection size). With `@db.sync.method 'recreate'`, data is preserved via server-side copy; with `'drop'`, data is lost. See [Structural Changes](#structural-changes).

### MySQL

MySQL tracks engine, charset, and collation as table options. Non-destructive changes (e.g., switching from InnoDB to MyISAM) are applied via `ALTER TABLE`. Destructive changes require table recreation.

### MongoDB

MongoDB tracks capped collection parameters (size, max documents). Since these cannot be modified in place, changes require recreation. With `@db.sync.method 'recreate'`, **data is preserved**: it is copied server-side to a temporary collection via `$out`, the original is dropped and recreated with the new options, then data is copied back via `$merge`. With `@db.sync.method 'drop'`, data is lost (the collection is dropped and recreated empty).

## Views

Schema sync manages views according to their type (see [View Types](/views/view-types) for definitions):

- **Managed views** — created, dropped, and recreated by sync when the definition changes. Since most databases do not support `ALTER VIEW`, changes trigger a drop + recreate.
- **Materialized views** — same lifecycle as managed views, but created with the materialized flag where supported.
- **External views** — validated only (existence + column check). Never created, modified, or dropped by sync.

### View Renames

The `@db.view.renamed` annotation handles view renames by dropping the old view and creating a new one with the updated name:

```atscript
@db.view 'premium_users'
@db.view.renamed 'vip_users'
@db.view.for User
@db.view.filter `tier = 'premium'`
export interface PremiumUser {
  id: User.id
  email: User.email
}
```

For more on view definitions and types, see [Views](/views/).

## Rename Tracking

Renames require explicit tracking because, without it, a renamed field looks like a deletion followed by an addition — which means data loss.

Three annotations handle renames across different schema objects:

| Annotation                     | Target | Effect                                             |
| ------------------------------ | ------ | -------------------------------------------------- |
| `@db.table.renamed 'oldName'`  | Table  | `ALTER TABLE oldName RENAME TO newName`            |
| `@db.column.renamed 'oldName'` | Column | `ALTER TABLE ... RENAME COLUMN oldName TO newName` |
| `@db.view.renamed 'oldName'`   | View   | `DROP VIEW oldName` + `CREATE VIEW newName`        |

### Lifecycle

The lifecycle for all rename annotations follows the same pattern:

1. **Add the annotation** with the old name as the argument.
2. **Deploy to all environments** — sync will execute the rename on each database it runs against.
3. **Remove the annotation** once every environment has been updated.

::: tip
Do not remove a `@db.*.renamed` annotation prematurely. If an environment has not yet been synced, removing the annotation will cause sync to treat the old and new names as unrelated — dropping the old object (and its data) and creating a new empty one.
:::

### Rename Conflicts

If both the old name and the new name exist in the database simultaneously, sync produces an error status instead of proceeding. This protects against situations where a rename was partially applied or where two columns genuinely exist with both names.

```
Column rename conflict on users: cannot rename "email_address" → "email"
because "email" already exists.
```

You must resolve the conflict manually (drop the stale column, or adjust the annotation) before sync will proceed.

### Example: Full Rename Workflow

```atscript
// Step 1: Rename the column
@db.table 'users'
export interface User {
  @meta.id
  id: number

  @db.column.renamed 'email_address'
  email: string
}
```

After deploying to all environments:

```atscript
// Step 2: Remove the annotation
@db.table 'users'
export interface User {
  @meta.id
  id: number

  email: string
}
```

## Structural Changes

Some changes cannot be applied with a simple `ALTER TABLE` statement — for example, changing a column type on SQLite, modifying nullable constraints, or changing destructive table options. The `@db.sync.method` annotation controls how sync handles these cases.

### `'drop'` — Drop and Recreate

```atscript
@db.table 'sessions'
@db.sync.method 'drop'
export interface Session {
  @meta.id
  id: string

  data: string
  expires_at: string
}
```

::: tip Recipe: dropping a column safely
Atscript never auto-rolls-back, so a column you remove in code is removed from the DB on the next sync. Two-step pattern for a live system:

1. **Stop reading/writing the column** — deploy the application change first, leaving the column in the schema (no `.as` change yet).
2. **Drop the column** — remove the field from the `.as` file and run sync. Use `--safe` in production to require manual approval; pair with `--dry-run` to preview.
   :::

::: tip Recipe: changing an FK target

1. Add the new FK field (with chain reference to the new target) alongside the old one.
2. Backfill rows so the new FK is populated.
3. Drop the old FK field on the next deploy.

Changing the chain-reference type of an existing FK field is a drop+add; do it in two deploys when downtime is not acceptable.
:::

The table is dropped and recreated from scratch.

::: danger
All data in the table is permanently destroyed. Use `'drop'` only for ephemeral data like sessions, caches, or temporary tables where data loss is acceptable.
:::

### `'recreate'` — Copy and Swap

```atscript
@db.table 'users'
@db.sync.method 'recreate'
export interface User {
  @meta.id
  id: number

  email: string
  age: number  // was: string
}
```

Sync copies the data into a new table with the updated schema and swaps it
in. Data is preserved wherever the old and new types are compatible;
incompatible columns may lose data during the copy.

### When Required

Structural changes are required in the following scenarios:

| Scenario                        | Adapters Affected | Required Method          |
| ------------------------------- | ----------------- | ------------------------ |
| Column type change              | SQLite            | `'recreate'` or `'drop'` |
| Nullable change                 | SQLite            | `'recreate'` or `'drop'` |
| Default value change            | SQLite            | `'recreate'` or `'drop'` |
| FK constraint change            | SQLite            | Automatic recreation     |
| Destructive table option change | All               | `'recreate'` or `'drop'` |

Adapters with `supportsColumnModify` (MySQL, PostgreSQL) can handle type, nullable, and default changes in-place without requiring `@db.sync.method`.

### Method Comparison

| Method       | Data                                                           | Use Case                                                                                 |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `'drop'`     | **Lost** — table is destroyed and recreated empty              | Caches, sessions, temporary data                                                         |
| `'recreate'` | **Preserved** — copied to new table where types are compatible | Important data with schema changes                                                       |
| _(none)_     | **Error** — sync refuses to proceed                            | Default behavior when structural changes are needed on adapters without in-place support |

## Recipes

### Many-to-Many (Junction Table)

Define an explicit junction `@db.table` with one `@db.rel.FK` per side; use `@db.rel.via` on each side to navigate through it:

```atscript
@db.table 'tags'
export interface Tag {
  @meta.id
  id: number

  label: string

  @db.rel.via PostTag
  posts: Post[]
}

@db.table 'posts'
export interface Post {
  @meta.id
  id: number

  title: string

  @db.rel.via PostTag
  tags: Tag[]
}

// Junction table — must be its own @db.table with FKs on each side.
@db.table 'post_tags'
export interface PostTag {
  @meta.id
  id: number

  @db.rel.FK
  @db.rel.onDelete 'cascade'
  postId: Post.id

  @db.rel.FK
  @db.rel.onDelete 'cascade'
  tagId: Tag.id
}
```

The junction must be a `@db.table`. `@db.rel.via` cannot be combined with `@db.rel.to` or `@db.rel.from` — it is self-sufficient. See [Navigation Properties](/relations/navigation#db-rel-via-many-to-many) for the runtime semantics.

### Vector Search

Mark a field with `@db.search.vector <dimensions>, "<similarity>"`. The dimensions must match the embedding model output and must be one of: `256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 16384`.

```atscript
@db.table 'documents'
export interface Document {
  @meta.id
  id: number

  title: string

  @db.search.vector 1536, "cosine"
  @db.search.vector.threshold 0.7
  embedding: db.vector

  @db.search.filter "embedding"
  category: string
}
```

On sync, the adapter provisions its native vector type/index (pgvector for PostgreSQL, Atlas vector index for MongoDB, `VECTOR(N)` for MySQL 9+, `vec0` shadow table for SQLite with `sqlite-vec` loaded). See [Vector Search](/search/vector-search) for the full query API.

## What Is NOT Synced

Schema sync handles structural schema changes only. The following are outside its scope:

- **Data migration and seed data** — sync creates and modifies schema, but does not transform or populate data
- **Stored procedures, triggers, and functions** — database-level logic is not managed by `.as` definitions
- **Database users, roles, and permissions** — access control must be managed through your database administration tools
- **Database-level settings** — charset, timezone, connection limits, and other server-level configuration
- **Custom DDL** — any database objects not representable through Atscript annotations (e.g., custom types, sequences, partitions)

## Next Steps

- [CLI](./cli) — command-line usage and flags
- [Configuration](./configuration) — config file setup and adapter options
- [Tables & Fields](/api/tables) — defining tables, columns, and constraints
- [Indexes](/api/indexes) — index annotations and types
- [Foreign Keys](/relations/) — FK annotations and relation patterns
- [Views](/views/) — view definitions and types
