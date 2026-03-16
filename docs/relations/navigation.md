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

## `@db.rel.via` — Many-to-Many

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

## `@db.rel.filter` — Filtering Navigation Properties

The `@db.rel.filter` annotation restricts which related records are loaded. It accepts a backtick-delimited query expression that is applied as a `WHERE` condition when loading the relation.

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

`@db.rel.filter` works with all navigation types — `@db.rel.to`, `@db.rel.from`, and `@db.rel.via`.

::: tip Query expression syntax
The backtick-delimited syntax (`\`Comment.visible = true\``) follows the same expression format used in view filters and join conditions. See [Queries & Filters](/api/queries) for the full syntax reference.
:::

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

This loads all projects, each with its `owner` record, and each project's `tasks` loaded with their `assignee` and `tags`. The query is translated into efficient database operations — joins for SQL adapters, `$lookup` stages for MongoDB.

## Next Steps

- [Loading Relations](./loading) — `$with` controls, nested loading, per-relation controls
- [Referential Actions](./referential-actions) — control cascade, restrict, set-null behavior
- [Deep Operations](./deep-operations) — insert, replace, and update across related tables
