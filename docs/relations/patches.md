---
outline: deep
---

# Relational Patches

<!--@include: ../_experimental-warning.md-->

When using `updateOne` or `bulkUpdate` (PATCH), FROM and VIA navigation properties require explicit **patch operators** instead of plain arrays. This gives you fine-grained control over which related records to create, update, or remove.

For single-table patch operations and embedded array patches, see [Update & Patch](/api/update-patch).

## Where Relational Patches Apply

Relational patches work on **navigation properties** — fields declared with `@db.rel.from` or `@db.rel.via`. They translate to real INSERT, UPDATE, and DELETE operations on the related tables and junction rows.

| Relation type  | Operators available | What happens                                     |
| -------------- | ------------------- | ------------------------------------------------ |
| `@db.rel.to`   | None needed         | Send partial object — parent is updated directly |
| `@db.rel.from` | All five operators  | INSERT / UPDATE / DELETE on child table          |
| `@db.rel.via`  | All five operators  | Manages both target records and junction entries |

## Operators

The same five patch operators used for [embedded array patches](/api/update-patch#embedded-array-patches) apply to relational patches — but instead of modifying JSON data in a single column, they translate to real INSERT, UPDATE, and DELETE operations on related tables.

When multiple operators appear on the same field, they are always applied in order: **remove -> update -> upsert -> insert** — regardless of the order they appear in the payload object.

## FROM Relation Patches {#from}

Operators on 1:N relations (`@db.rel.from`) translate to real database operations on the child table. The FK is automatically wired to the parent. Elements are identified by their **primary key** (`@meta.id`).

The following schema is used for FROM examples:

```atscript
import { Comment } from './comment.as'

@db.table 'tasks'
export interface Task {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.from
    comments: Comment[]
}
```

### `$insert` — Create New Children

```typescript
await tasks.updateOne({
  id: 1,
  comments: {
    $insert: [{ body: "Looks good!", authorId: 3 }],
  },
});
// INSERT INTO comments (body, authorId, taskId) VALUES ('Looks good!', 3, 1)
```

The FK (`taskId`) is set automatically from the parent's PK.

### `$remove` — Delete Children by PK

```typescript
await tasks.updateOne({
  id: 1,
  comments: {
    $remove: [{ id: 5 }],
  },
});
// DELETE FROM comments WHERE id = 5 AND taskId = 1
```

### `$update` — Patch Children by PK

```typescript
await tasks.updateOne({
  id: 1,
  comments: {
    $update: [{ id: 7, body: "Edited comment" }],
  },
});
// UPDATE comments SET body = 'Edited comment' WHERE id = 7
```

### `$upsert` — Insert or Update by PK

```typescript
await tasks.updateOne({
  id: 1,
  comments: {
    $upsert: [
      { id: 7, body: "Updated" }, // Has PK → update
      { body: "Brand new", authorId: 2 }, // No PK → insert with FK wired
    ],
  },
});
```

Items with a primary key are updated. Items without a primary key are inserted, with the FK automatically set to the parent's PK.

### `$replace` — Replace All Children

Deletes all existing children and inserts the new set:

```typescript
await tasks.updateOne({
  id: 1,
  comments: { $replace: [{ body: "Only comment", authorId: 1 }] },
});
```

This uses identity-preserving diff-sync — children with matching PKs are updated in place, not deleted and re-created. Only children whose PKs are absent from the new set are deleted.

## VIA Relation Patches {#via}

Operators on M:N relations (`@db.rel.via`) manage both the **target records** and the **junction table entries**:

```atscript
import { Tag } from './tag.as'
import { TaskTag } from './task-tag.as'

@db.table 'tasks'
export interface Task {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.via TaskTag
    tags: Tag[]
}
```

### `$insert` — Add Tags

```typescript
// Create new target + junction entry
await tasks.updateOne({ id: 1, tags: { $insert: [{ name: "new-tag" }] } });

// Reference existing target — creates junction row only
await tasks.updateOne({ id: 1, tags: { $insert: [{ id: 5 }] } });
```

When a PK is provided, the target record is assumed to exist — only the junction entry is created. Without a PK, a new target record is inserted first.

### `$remove` — Unlink Tags

```typescript
await tasks.updateOne({ id: 1, tags: { $remove: [{ id: 5 }] } });
```

Removes the **junction entry** only — the target record (`Tag`) is preserved. To delete the target record itself, delete it from its own table.

### `$update` — Update Target Records

```typescript
await tasks.updateOne({ id: 1, tags: { $update: [{ id: 5, name: "renamed" }] } });
```

Updates the target record. The junction entry is untouched.

### `$upsert` — Insert or Update Targets

```typescript
await tasks.updateOne({
  id: 1,
  tags: {
    $upsert: [
      { id: 5, name: "renamed" }, // Has PK → update target + ensure junction exists
      { name: "brand-new" }, // No PK → insert target + create junction
    ],
  },
});
```

For items with a PK: the target record is updated, and a junction entry is created if one does not already exist. For items without a PK: a new target record is inserted and a junction entry is created.

### `$replace` — Replace All Links

```typescript
await tasks.updateOne({ id: 1, tags: { $replace: [{ name: "only-tag" }] } });
```

Clears all existing junction entries for this parent, then creates new ones. Target records with a PK are updated in place; target records without a PK are inserted as new rows.

## TO Relation Patches

TO relations don't need operators — send a partial object and the parent is updated directly:

```typescript
await tasks.updateOne({
  id: 1,
  project: { id: 2, title: "Updated Title" },
});
// UPDATE projects SET title = 'Updated Title' WHERE id = 2
```

If the FK value is not present in the patch payload, it is read from the database before the update. If the FK is `null`, the patch returns an error — you cannot patch a TO relation when the FK has no target.

::: warning Nested FROM inside TO
Patching a TO parent's FROM children in a single call is not supported. The nested relation data exceeds the allowed depth and returns a `400` error:

```typescript
// NOT SUPPORTED — will error
await tasks.updateOne({
  id: 1,
  project: { id: 2, tasks: { $insert: [{ title: "New" }] } },
});
```

Update the parent and its children in separate calls instead.
:::

## Plain Arrays Rejected on PATCH

::: warning
Passing a plain array on a FROM or VIA navigation property during `updateOne` / `bulkUpdate` returns a `400` validation error:

```typescript
// ERROR — plain array on FROM relation
await tasks.updateOne({ id: 1, comments: [{ body: "Hi" }] });

// Error: Cannot patch 1:N relation 'comments' with a plain value
//        — use patch operators ({ $insert, $remove, $replace, $update, $upsert })
```

Plain arrays are only accepted on `replaceOne` (PUT), where they trigger the diff-based sync described in [Deep Operations](./deep-operations). For partial updates, always use explicit operators.
:::

## Combining Operators

Multiple operators on the same field and across multiple fields in one request:

```typescript
await tasks.updateOne({
  id: 1,
  comments: {
    $remove: [{ id: 3 }],
    $update: [{ id: 7, body: "Revised" }],
    $insert: [{ body: "New comment", authorId: 1 }],
  },
  tags: { $insert: [{ name: "reviewed" }] },
  title: "Updated title", // scalar field — updated directly
});
```

Remember: operators execute in order **remove -> update -> upsert -> insert**, not in the order they appear in the object.

::: info Scalar fields alongside operators
You can mix scalar field updates with relational patch operators in the same `updateOne` call. Scalar fields are updated on the main table; relational operators are applied to their respective related tables. All operations run within the same transaction (where the adapter supports transactions).
:::

## Next Steps

- [Deep Operations](./deep-operations) — nested inserts, replaces, and full relation writes
- [Navigation Properties](./navigation) — defining TO, FROM, and VIA relations
- [Update & Patch](/api/update-patch) — single-table patches, embedded arrays, `@db.patch.strategy`
