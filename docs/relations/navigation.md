---
outline: deep
---

# Navigation Properties

<!--@include: ../_experimental-warning.md-->

Navigation properties define how you traverse relationships between tables. While [foreign keys](./index) declare the physical link, navigation properties let you load related records by name.

A foreign key says "this field points to that table." A navigation property says "give me the related record(s)." You declare both in the same `.as` schema, and Atscript wires them together automatically.

## `@db.rel.to` — Forward Navigation (N:1, 1:1)

A `@db.rel.to` property loads the **single parent record** that a foreign key points to. The field type must be the target interface (not an array), since a foreign key always references exactly one row.

```atscript
@db.table 'tasks'
export interface Task {
    @meta.id
    id: number
    title: string

    @db.rel.FK
    ownerId: User.id

    @db.rel.to
    owner: User
}
```

Atscript matches `owner: User` to the FK that points to `User` — in this case `ownerId`. You don't need to specify which FK to follow when there's only one FK targeting that type.

When the FK is optional, the navigation property should be optional too:

```atscript
@db.rel.FK
assigneeId?: User.id

@db.rel.to
assignee?: User
```

::: tip Navigation paths are not columns
`assignee.name` is not a column of `tasks`: filtering, sorting or selecting it at the root of a query is rejected (HTTP 400 / `INVALID_QUERY` since 0.1.128). Pick the tool by what you want to narrow:

- **the tasks** by their assignee — a [relational predicate](/api/queries#relational-filters) on the relation: `{ assignee: { $some: { name: "x" } } }` (since 0.1.147; over HTTP `assignee=$some(name=x)`, which needs [`@db.rel.filterable`](#db-rel-filterable));
- **the loaded assignee** — `$with`: `$with=assignee($select=name)` to project, `$with=assignee(name=x)` to filter the related rows.

A `@db.table` foreign key is a real constraint, so its target must be unique on its own: a column of a composite primary key is a compile error (since 0.1.148) unless it is also `@db.index.unique` or the FK columns together cover the whole key. For value help over such a dictionary without a constraint, use the `@ui.valueHelp` annotation of `@atscript/ui`.

In `/meta`, `@db.rel.FK` also follows reference chains to their terminal field (see [annotations — dual role](../adapters/annotations#db-rel-fk-dual-role)).
:::

### Alias Matching for TO

When multiple FKs point to the same target type, Atscript can't infer which FK a navigation property should follow. Use aliases to disambiguate:

```atscript
@db.rel.FK 'author'
authorId: User.id

@db.rel.FK 'reviewer'
reviewerId?: User.id

@db.rel.to 'author'
author: User

@db.rel.to 'reviewer'
reviewer?: User
```

The alias on `@db.rel.to` must match the alias on the corresponding `@db.rel.FK`. Without aliases, Atscript reports an error because it can't determine which FK each navigation property refers to.

::: tip When is an alias required?
Only when a table has two or more FKs pointing to the **same** target type. If each FK targets a different type, Atscript resolves the match by type alone and no alias is needed.
:::

## `@db.rel.from` — Inverse Navigation (1:N)

A `@db.rel.from` property navigates from a parent to its children. The foreign key lives on the **target** table, not the current one. The field type is an array because one parent can have many children.

```atscript
@db.table 'projects'
export interface Project {
    @meta.id
    id: number
    name: string

    @db.rel.from
    tasks: Task[]
}
```

```
┌──────────────┐           ┌──────────────┐
│   projects   │           │    tasks     │
├──────────────┤           ├──────────────┤
│ id (PK)      │◄──────────│ projectId(FK)│
│ name         │           │ id (PK)      │
│              │  1:N      │ title        │
│ tasks[]  ◄───┼───────────│              │
└──────────────┘           └──────────────┘
```

The FK is on `Task` (e.g., `projectId: Project.id`). Atscript resolves the reverse relationship automatically — it finds the FK on the target table that references the current table.

### Alias Matching for FROM

When the target table has multiple FKs pointing back to this type, use aliases to specify which FK the inverse navigation follows:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    id: number
    name: string

    @db.rel.from 'assignee'
    assignedTasks: Task[]

    @db.rel.from 'reporter'
    reportedTasks: Task[]
}
```

This assumes `Task` has two FKs pointing to `User`:

```atscript
@db.rel.FK 'assignee'
assigneeId?: User.id

@db.rel.FK 'reporter'
reporterId: User.id
```

The alias on `@db.rel.from` matches the alias on the corresponding `@db.rel.FK` on the target table.

### Singular FROM (1:1 Inverse)

For one-to-one inverse relations, use a singular type instead of an array:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    id: number

    @db.rel.from
    profile: UserProfile
}
```

This tells Atscript to expect at most one `UserProfile` per `User`. The FK on `UserProfile` should have `@db.index.unique` to enforce the 1:1 constraint at the database level:

```atscript
@db.table 'user_profiles'
export interface UserProfile {
    @meta.id
    id: number

    @db.rel.FK
    @db.index.unique
    userId: User.id

    bio: string
}
```

When no matching record exists, loading a singular `@db.rel.from` returns `null` (instead of an empty array as you'd get with an array type).

## `@db.rel.via` — Many-to-Many {#db-rel-via-many-to-many}

A `@db.rel.via` property traverses a **junction table** to reach records on the other side of a many-to-many relationship. The junction type is required as an argument, and the field type is always an array.

Here is a complete M:N example linking tasks and tags through a junction table:

```atscript
@db.table 'task_tags'
export interface TaskTag {
    @meta.id
    id: number

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    taskId: Task.id

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    tagId: Tag.id
}

@db.table 'tasks'
export interface Task {
    @meta.id
    id: number
    title: string

    @db.rel.via TaskTag
    tags: Tag[]
}

@db.table 'tags'
export interface Tag {
    @meta.id
    id: number
    label: string

    @db.rel.via TaskTag
    tasks: Task[]
}
```

```
┌──────────┐       ┌──────────────┐       ┌──────────┐
│  tasks   │       │  task_tags   │       │   tags   │
├──────────┤       ├──────────────┤       ├──────────┤
│ id (PK)  │◄──────│ taskId (FK)  │       │ id (PK)  │
│ title    │       │ tagId (FK) ──┼──────►│ label    │
│          │       │ id (PK)      │       │          │
└──────────┘       └──────────────┘       └──────────┘
```

Atscript resolves the path automatically: `Task.tags` follows `TaskTag.taskId` → `TaskTag.tagId` → `Tag`, and `Tag.tasks` follows the reverse direction. The junction table must have FKs to both sides.

::: info Junction table requirements
The junction table must have at least two `@db.rel.FK` fields — one pointing to each side of the relationship. It can also contain additional data fields (e.g., `sortOrder`, `createdAt`) that describe the relationship itself.
:::

## `@db.rel.filter` — Filtering Navigation Properties {#db-rel-filter}

The `@db.rel.filter` annotation restricts which records count as related. It accepts a backtick-delimited query expression that is applied as a `WHERE` condition whenever the relation is loaded with `$with` and inside [relational predicates](/api/queries#relational-filters) on it (`$some` / `$none`).

```atscript
@db.table 'posts'
export interface Post {
    @meta.id
    id: number
    title: string

    @db.rel.from
    comments: Comment[]

    @db.rel.from
    @db.rel.filter `Comment.visible = true`
    visibleComments: Comment[]
}
```

Loading `comments` returns all comments for a post. Loading `visibleComments` only returns comments where `visible` is `true`. The filter is applied at the database level, so filtered-out records are never fetched.

`@db.rel.filter` works with all navigation types — `@db.rel.to`, `@db.rel.from`, and `@db.rel.via`. A query-time `$with` filter is ANDed with it, and `{ visibleComments: { $some: {} } }` means "has a visible comment".

::: warning Applied at run time since 0.1.147
Before 0.1.147 the annotation was validated but **ignored** when loading: `$with=visibleComments` returned every comment. It is now applied on every adapter, so such a relation returns fewer rows after the upgrade — the rows its declaration always described.
:::

On a `@db.rel.via` relation the expression may read the related type and the junction. Its top-level `and` conditions are split by the table they read: unqualified fields and the related type's fields filter the related rows, the junction's fields filter the links:

```atscript
@db.rel.via TicketLabel
@db.rel.filter `TicketLabel.pinned = true and Label.name != 'hidden'`
pinnedLabels: Label[]
```

Two shapes are compile errors (shown in the editor too): a comparison between two fields (`Comment.createdAt = Comment.updatedAt`) on any relation, and — on a `@db.rel.via` relation — a single top-level condition that reads both the junction and the related type (an `or` across them, or a parenthesized group mixing both: split it into separate top-level `and` conditions). The query layer still rejects them with `INVALID_QUERY` should such metadata reach it some other way.

::: tip Query expression syntax
The backtick-delimited syntax (`\`Comment.visible = true\``) follows the same expression format used in view filters and join conditions. See [Queries & Filters](/api/queries#query-expressions) for the full syntax reference.
:::

## `@db.rel.filterable` — Client Filters on a Relation {#db-rel-filterable}

Since 0.1.147. Lets HTTP clients filter the parent rows by this relation with a [relational predicate](/api/queries#relational-filters) — `ticket=$some(status=open)` on `/query`, `/pages` and `/geo`. A flag, valid on `@db.rel.to` / `.from` / `.via` fields only:

```atscript
@db.table 'issues'
export interface Issue {
    @meta.id
    id: number

    @db.rel.FK
    ticketKey?: Ticket.key

    @db.rel.to
    @db.rel.filterable
    ticket?: Ticket
}
```

- **HTTP opt-in only.** Without it, a client predicate on the relation answers `400 Filtering by related "ticket" rows is not permitted — add @db.rel.filterable to enable.` Loading it with `$with` needs no flag.
- **Server-side code never needs it**: `transformFilter`, `actionRowScope` and direct table calls use predicates on any relation.
- The related table's own rules still apply to the operand (visibility, encrypted and write-only fields, manual filter mode) — see [Permissions § Relational predicates](/http/permissions#relational-predicates).
- `/meta.relations[]` marks opted-in relations with `filterable: true`. The flag is not part of the schema, so adding or removing it never triggers a sync.

Opt in only where clients need it: a predicate filters the parent set and runs a correlated lookup per candidate row (index advice in [Queries § Relational filters](/api/queries#relational-filters)).

## Complete Example

Here is a full five-type schema that combines `@db.rel.to`, `@db.rel.from`, and `@db.rel.via` into a coherent data model:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    @db.default.increment
    id: number
    name: string
    email: string

    @db.rel.from
    projects: Project[]
}

@db.table 'projects'
export interface Project {
    @meta.id
    @db.default.increment
    id: number
    name: string

    @db.rel.FK
    ownerId: User.id

    @db.rel.to
    owner: User

    @db.rel.from
    tasks: Task[]
}

@db.table 'tasks'
export interface Task {
    @meta.id
    @db.default.increment
    id: number
    title: string
    done: boolean

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    projectId: Project.id

    @db.rel.FK 'assignee'
    @db.rel.onDelete 'setNull'
    assigneeId?: User.id

    @db.rel.to
    project: Project

    @db.rel.to 'assignee'
    assignee?: User

    @db.rel.via TaskTag
    tags: Tag[]
}

@db.table 'tags'
export interface Tag {
    @meta.id
    @db.default.increment
    id: number
    label: string

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

This gives you:

| Navigation      | Type | Direction      | Resolved via                         |
| --------------- | ---- | -------------- | ------------------------------------ |
| `Project.owner` | TO   | Project → User | `ownerId` FK                         |
| `User.projects` | FROM | User ← Project | `ownerId` FK on Project              |
| `Project.tasks` | FROM | Project ← Task | `projectId` FK on Task               |
| `Task.project`  | TO   | Task → Project | `projectId` FK                       |
| `Task.assignee` | TO   | Task → User    | `assigneeId` FK (alias `'assignee'`) |
| `Task.tags`     | VIA  | Task ↔ Tag     | through `TaskTag` junction           |
| `Tag.tasks`     | VIA  | Tag ↔ Task     | through `TaskTag` junction           |

### Loading the Relations in TypeScript

With navigation properties defined, you can load related data using `$with` controls:

```typescript
const projects = await projectTable.findMany({
  controls: {
    $with: [
      { name: "owner" },
      {
        name: "tasks",
        controls: {
          $with: [{ name: "assignee" }, { name: "tags" }],
        },
      },
    ],
  },
});
```

This loads all projects, each with its `owner` record, and each project's `tasks` loaded with their `assignee` and `tags`. The loader runs relations in parallel within each `$with` level. The execution strategy is adapter-specific: SQL adapters issue a separate batched query per relation (no JOINs); MongoDB executes a `$lookup` aggregation pipeline per relation. See [Loading Relations § How It Works Internally](./loading#how-it-works-internally) for the full picture.

### Resolving a Related Table

`relatedTable(navField)` (since 0.1.134) returns the table a navigation property points to, taken from the same `DbSpace` — handy for reading its `primaryKeys` / `preferredId` or validating a path on it:

```typescript
const users = tasks.relatedTable("assignee");
users?.primaryKeys; // ['id']
```

It answers `undefined` when the name is not a navigation property of this table (plain fields and dotted paths included) or the table was built without a `DbSpace`.

### The Foreign Key Behind a TO Relation {#foreign-key-of}

`foreignKeyOf(relationName)` (since 0.1.143) returns the `@db.rel.FK` entry a `@db.rel.to` relation follows — paired exactly as loading and nested writes pair them: by alias when the relation has one, else by target table:

```typescript
tasks.foreignKeyOf("assignee"); // { fields: ['assigneeId'], targetTable: 'users', targetFields: ['id'], … }
tasks.foreignKeyOf("reviewer"); // the FK with alias 'reviewer'
```

It answers `undefined` for a `@db.rel.from` / `@db.rel.via` relation (their key lives on the other table), a name that is not a relation, or a TO relation without a matching FK.

## Next Steps

- [Loading Relations](./loading) — `$with` controls, nested loading, per-relation controls
- [Referential Actions](./referential-actions) — control cascade, restrict, set-null behavior
- [Deep Operations](./deep-operations) — insert, replace, and update across related tables
