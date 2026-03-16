---
outline: deep
---

# Loading Relations

<!--@include: ../_experimental-warning.md-->

Navigation properties are **not** populated by default. They are only loaded when you explicitly request them via `$with` in your query controls. This design is intentional — it avoids the N+1 problem common in ORMs with lazy loading and gives you full control over which relations are fetched and how.

Throughout this page, we use the following schema as a running example:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    @db.default.increment
    id: number
    name: string
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
    projectId: Project.id

    @db.rel.FK 'assignee'
    assigneeId?: User.id

    @db.rel.to
    project: Project

    @db.rel.to 'assignee'
    assignee?: User

    @db.rel.via TaskTag
    tags: Tag[]
}
```

(Plus the supporting `Tag` and `TaskTag` junction types from the [Navigation Properties](./navigation) page.)

## Explicit Loading with `$with`

To load a navigation property, include it in the `$with` array inside `controls`:

```typescript
const tasks = await taskTable.findMany({
  controls: {
    $with: [{ name: "project" }],
  },
});
// tasks[0].project → { id: 1, name: 'Website Redesign', ownerId: 3 }
```

Without `$with`, navigation properties are `undefined` on returned objects — they simply don't exist:

```typescript
const tasks = await taskTable.findMany();
// tasks[0].project === undefined
```

This applies to all query methods that accept controls: `findMany`, `findOne`, and `findById`:

```typescript
const task = await taskTable.findOne({
  filter: { id: 42 },
  controls: { $with: [{ name: "project" }] },
});

const task = await taskTable.findById(42, {
  controls: { $with: [{ name: "project" }] },
});
```

## Loading Multiple Relations

Pass multiple entries in the `$with` array to load several relations at once:

```typescript
const tasks = await taskTable.findMany({
  controls: {
    $with: [{ name: "project" }, { name: "assignee" }, { name: "tags" }],
  },
});
// tasks[0].project   → Project object
// tasks[0].assignee  → User object or null (FK is optional)
// tasks[0].tags      → Tag[] (may be empty)
```

All relations in a single `$with` array are loaded **in parallel** — the queries for `project`, `assignee`, and `tags` run concurrently, not sequentially.

## Nested (Deep) Loading

Load relations of relations by nesting `$with` controls inside a relation entry:

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
// projects[0].owner               → User
// projects[0].tasks[0].assignee   → User | null
// projects[0].tasks[0].tags       → Tag[]
```

There is no hard limit on nesting depth. Each level of nesting adds one or more queries, so keep depth reasonable for performance.

## Per-Relation Controls

Each `$with` entry accepts its own `controls` object. You can sort, filter, paginate, and project on loaded relations independently of the parent query:

```typescript
const projects = await projectTable.findMany({
  controls: {
    $with: [
      {
        name: "tasks",
        controls: {
          $sort: { done: 1, title: 1 },
          $limit: 10,
          $filter: { done: false },
          $with: [{ name: "tags" }],
        },
      },
    ],
  },
});
```

This loads each project's tasks sorted by `done` then `title`, limited to 10 incomplete tasks, each with their tags attached.

::: tip
Per-relation controls are especially useful for FROM and VIA relations where you want to limit the number of loaded children. For example, loading only the 5 most recent comments on a post, or only active tags on a task.
:::

## Field Selection on Relations

Use `$select` within relation controls to load only specific fields from related records:

```typescript
const tasks = await taskTable.findMany({
  controls: {
    $with: [
      {
        name: "project",
        controls: { $select: ["name"] },
      },
    ],
  },
});
// tasks[0].project → { id: 1, name: 'Website Redesign' }
```

::: info
Primary key and foreign key fields used for joining are always included in the query, even if not listed in `$select`. They are needed internally to match related records to their parents. In the example above, `id` appears in the result even though only `name` was selected.
:::

## Filtering Loaded Relations

Use `filter` on a `$with` entry to restrict which related records are returned:

```typescript
const projects = await projectTable.findMany({
  controls: {
    $with: [
      {
        name: "tasks",
        filter: { done: false },
      },
    ],
  },
});
// projects[0].tasks → only incomplete tasks
```

This is a query-time filter applied when loading the relation. It is different from `@db.rel.filter`, which is a permanent filter baked into the schema definition. Both can be active at the same time — the schema filter and the query-time filter are combined with `$and`.

## Behavior by Relation Type

Different relation types return different shapes when loaded:

| Relation type              | No matches          | Null FK | Return type      |
| -------------------------- | ------------------- | ------- | ---------------- |
| `@db.rel.to` (required FK) | N/A — FK must exist | N/A     | Object           |
| `@db.rel.to` (optional FK) | N/A                 | `null`  | Object or `null` |
| `@db.rel.from` (array)     | `[]`                | N/A     | Array            |
| `@db.rel.from` (singular)  | `null`              | N/A     | Object or `null` |
| `@db.rel.via`              | `[]`                | N/A     | Array            |

Key behaviors to remember:

- **Null FK produces null navigation**: When an optional FK field is `null`, the corresponding `@db.rel.to` property returns `null` — not `undefined`, not an error.
- **Empty collections, not null**: `@db.rel.from` and `@db.rel.via` always return `[]` when no matching records exist, never `null`.
- **Without `$with`**: Navigation properties are `undefined` — they are not present on the returned object at all. This is distinct from `null`, which means "loaded but no match."

## Nullable FK Lifecycle {#nullable-fk-lifecycle}

Optional foreign keys follow a clear lifecycle through insert, query, update, and relation loading:

```typescript
// 1. Insert with null FK
await taskTable.insertOne({
  title: "Unassigned task",
  done: false,
  projectId: 1,
  assigneeId: null,
});

// 2. Query for null FKs
const unassigned = await taskTable.findMany({
  filter: { assigneeId: null },
});

// 3. Load relation on null FK — returns null, not an error
const task = await taskTable.findOne({
  filter: { assigneeId: null },
  controls: { $with: [{ name: "assignee" }] },
});
// task.assignee === null

// 4. Assign a user
await taskTable.updateOne({ id: task.id, assigneeId: 5 });

// 5. Unassign (set back to null)
await taskTable.updateOne({ id: task.id, assigneeId: null });
```

::: warning
Setting an FK to a non-existent ID results in a foreign key violation error. Via the HTTP controller, this surfaces as a `400` response with an `FK_VIOLATION` error code. Programmatically, the adapter throws an error.
:::

## How It Works Internally

Under the hood, relations are loaded via **separate batched queries** — not JOINs. Each relation in `$with` triggers one additional query (or two for VIA). Understanding this strategy helps explain why `$with` scales well.

### TO relations

FK values are collected from all result rows, deduplicated, and sent as a single `$in` query to the target table. Results are indexed by primary key and assigned back to each row. If 100 tasks all reference 5 distinct projects, only 1 query runs against the `projects` table with `{ id: { $in: [1, 2, 3, 4, 5] } }`.

### FROM relations

Primary key values are collected from the result set, and the target table is queried with `{ fkField: { $in: [pkValues] } }`. Results are grouped by foreign key and assigned as arrays (or singular values for 1:1 FROM relations).

### VIA relations

Two queries run in sequence:

1. The junction table is queried for all junction rows matching the local PKs
2. The target table is queried for the collected target FK values from step 1

Results are grouped through the junction mapping and assigned to each row.

### Composite keys

When a relation involves composite primary or foreign keys, the loader uses `$or` filters with all unique key combinations instead of `$in`. The matching logic uses composite key indexing internally.

::: tip Performance
This batching strategy means loading a relation on 100 records requires exactly **1 extra query** (or 2 for VIA), not 100. The N+1 problem is avoided by design. Relations within the same `$with` level are loaded in parallel.
:::

## HTTP Equivalent

When using the HTTP controller (`AsDbController`), relation loading maps to the `$with` query parameter:

```bash
# Load a single relation
curl "http://localhost:3000/tasks/query?\$with=project"

# Load multiple relations
curl "http://localhost:3000/tasks/query?\$with=project,assignee,tags"
```

For nested loading and per-relation controls in URLs, see [CRUD Endpoints](/http/crud).

## Next Steps

- [Navigation Properties](./navigation) — defining TO, FROM, VIA, and filter relations in the schema
- [Referential Actions](./referential-actions) — cascade, restrict, and set-null behavior on delete/update
- [CRUD Operations](/api/crud) — the full programmatic API for inserts, reads, updates, and deletes
