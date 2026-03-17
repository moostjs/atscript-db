---
outline: deep
---

# Update & Patch

This page covers fine-grained update operations on **single-table data** — embedded objects and embedded arrays stored directly on a record. For patching related records across foreign keys (FROM and VIA navigation properties), see [Relations — Relational Patches](/relations/patches).

## Simple Updates

The simplest update sets scalar fields directly. The primary key must be in the payload to identify the record:

```typescript
await users.updateOne({
  id: 1,
  name: "Alice Smith",
  status: "active",
});
```

Only the provided fields are changed — other fields remain untouched.

## Field Operations {#field-ops}

Field operations let you atomically increment, decrement, or multiply numeric fields without reading the current value first. This is essential for counters, stock levels, scores, and any field where concurrent updates must not lose data.

### Available Operations

| Operator | Effect                           | SQL                 | MongoDB           |
| -------- | -------------------------------- | ------------------- | ----------------- |
| `$inc`   | Add a number to the field        | `SET col = col + ?` | `$inc`            |
| `$dec`   | Subtract a number from the field | `SET col = col - ?` | `$inc` (negative) |
| `$mul`   | Multiply the field by a number   | `SET col = col * ?` | `$mul`            |

All operations are **atomic** — they execute as a single database operation, safe for concurrent use.

### Usage

Import the operation helpers from `@atscript/db/ops` — this module has **zero dependencies** and is safe for frontend use:

```typescript
import { $inc, $dec, $mul } from "@atscript/db/ops";

// Increment views by 1
await posts.updateOne({ id: 1, views: $inc() });

// Decrement stock by 5
await products.updateOne({ id: 42, stock: $dec(5) });

// Apply a 10% price increase
await products.updateOne({ id: 42, price: $mul(1.1) });
```

Field operations can be mixed with regular field assignments in the same update:

```typescript
await posts.updateOne({
  id: 1,
  views: $inc(),
  title: "Updated Title",
  status: "published",
});
```

### With `updateMany`

Field operations also work with filter-based batch updates:

```typescript
// Give all active users 100 bonus points
await users.updateMany({ status: "active" }, { points: $inc(100) });
```

### With `bulkUpdate`

Multiple records can receive different operations in one call:

```typescript
await products.bulkUpdate([
  { id: 1, stock: $dec(2) },
  { id: 2, stock: $dec(5) },
  { id: 3, price: $mul(0.9) },
]);
```

### Over HTTP

The helpers return plain JSON objects (`$inc(5)` → `{ $inc: 5 }`), so they work naturally over HTTP:

```bash
curl -X PATCH http://localhost:3000/products/ \
  -H "Content-Type: application/json" \
  -d '{"id": 42, "views": {"$inc": 1}, "stock": {"$dec": 1}}'
```

### Operation Helpers

The `@atscript/db/ops` module also exports helpers for [array patch operators](#embedded-array-patches):

```typescript
import { $insert, $remove, $replace, $upsert, $update } from "@atscript/db/ops";

await posts.updateOne({ id: 1, tags: $insert(["urgent"]) });
await posts.updateOne({ id: 1, tags: $remove(["draft"]) });
```

### Where Field Ops Work

Field operations require that the target field maps to its own database column (or document key) so the database engine can apply the arithmetic atomically. This means:

| Context                                        | Works? | Why                                                                        |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| Top-level numeric field                        | Yes    | Maps directly to a column / document key                                   |
| Nested field with `@db.patch.strategy 'merge'` | Yes    | Each sub-field is stored as its own column (SQL) or dot-path key (MongoDB) |
| Inside a navigation property (relation)        | Yes    | The related table's `bulkUpdate` handles ops on its own fields             |
| `updateMany` — top-level fields                | Yes    | Same as `updateOne`                                                        |

### Where Field Ops Do NOT Work

| Context                                                         | Result                          | Why                                                                                                   |
| --------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Inside a `@db.json` field                                       | **Validation error**            | JSON fields are stored as an opaque blob — the database cannot reach inside to increment a single key |
| Inside a nested object **without** `@db.patch.strategy 'merge'` | **Validation error**            | Without merge strategy the entire object is replaced — there is no individual column to increment     |
| `updateMany` — nested fields inside merge-strategy objects      | **Ignored** (stored as literal) | `updateMany` does not decompose nested objects — only top-level ops are detected                      |

```typescript
import { $inc } from "@atscript/db/ops";

// ❌ Validation error — @db.json field
await table.updateOne({ id: 1, metadata: { clicks: $inc() } });

// ❌ Validation error — no merge strategy
await table.updateOne({ id: 1, address: { zip: $inc() } });

// ✅ Works — merge strategy present
await table.updateOne({ id: 1, stats: { views: $inc() } });
```

::: tip
If you need atomic operations on nested fields, add `@db.patch.strategy 'merge'` to the parent field. This stores each sub-field as a separate column (SQL) or allows dot-path updates (MongoDB).
:::

## Embedded Object Patches

Nested objects stored on a record (not navigation properties) use a strategy-based approach controlled by `@db.patch.strategy`.

### Replace Strategy (Default)

Without `@db.patch.strategy`, the entire nested object is **overwritten**. Omitted sub-fields are lost:

```typescript
// Current: { address: { line1: '123 Main St', line2: 'Apt 4', city: 'Portland' } }

await table.updateOne({ id: 1, address: { city: "Seattle" } });
// Result: { address: { city: 'Seattle' } }
// ⚠️ line1 and line2 are gone
```

[Field operations](#field-ops) (`$inc`, `$dec`, `$mul`) are **not allowed** inside replace-strategy objects — the validator will reject them. Use `@db.patch.strategy 'merge'` if you need atomic operations on nested fields.

### Merge Strategy

With `@db.patch.strategy 'merge'`, only the provided nested fields are updated — others are preserved:

```atscript
@db.patch.strategy 'merge'
address: {
    line1: string
    line2?: string
    city: string
}
```

```typescript
// Current: { address: { line1: '123 Main St', line2: 'Apt 4', city: 'Portland' } }

await table.updateOne({ id: 1, address: { city: "Seattle" } });
// Result: { address: { line1: '123 Main St', line2: 'Apt 4', city: 'Seattle' } }
// ✅ line1 and line2 preserved
```

Merge-strategy fields also support [field operations](#field-ops) on their nested numeric sub-fields:

```typescript
import { $inc } from "@atscript/db/ops";

await products.updateOne({
  id: 1,
  stats: { views: $inc(), rating: 4.5 },
});
// views is atomically incremented, rating is set to 4.5, other stats fields preserved
```

## Embedded Array Patches

Arrays stored directly on the record support five patch operators for fine-grained manipulation:

| Operator   | Effect                        |
| ---------- | ----------------------------- |
| `$replace` | Replace the entire array      |
| `$insert`  | Append new items              |
| `$upsert`  | Insert or update items by key |
| `$update`  | Update existing items by key  |
| `$remove`  | Remove items by key or value  |

When multiple operators appear on the same field, they are always applied in order: **remove → update → upsert → insert** — regardless of the order they appear in the object.

::: warning SQL Adapters
In relational databases (SQLite, PostgreSQL, MySQL), arrays are stored as JSON columns. Patch operators work via read-modify-write. For collections that need frequent partial updates in SQL, consider modeling them as separate tables with [FROM or VIA relations](/relations/patches) instead.
:::

## Primitive Arrays

For simple value arrays like `tags: string[]`, operators work by **value equality** — no key fields are needed:

```typescript
import { $insert, $remove, $replace } from "@atscript/db/ops";

// Append items
await table.updateOne({ id: 1, tags: $insert(["urgent", "reviewed"]) });

// Remove by value
await table.updateOne({ id: 1, tags: $remove(["draft"]) });

// Full replacement
await table.updateOne({ id: 1, tags: $replace(["final", "approved"]) });
```

### Unique Primitive Arrays

When `@expect.array.uniqueItems` is set, `$insert` automatically skips duplicates:

```atscript
@expect.array.uniqueItems
tags: string[]
```

```typescript
import { $insert } from "@atscript/db/ops";

// Current tags: ['api', 'backend']
await table.updateOne({ id: 1, tags: $insert(["api", "frontend"]) });
// Result: ['api', 'backend', 'frontend'] — 'api' was silently skipped
```

## Keyed Object Arrays

`@expect.array.key` marks which properties identify an element inside an embedded object array. Keys are required for `$update`, `$upsert`, and key-based `$remove`:

```atscript
variants: {
    @expect.array.key
    sku: string
    color: string
    stock: number
}[]
```

Multiple fields can be marked as keys to form a **composite key** — an element matches only when all key fields match.

### Operations with Replace Strategy (Default)

```typescript
import { $insert, $update, $remove, $upsert } from "@atscript/db/ops";

// Insert a new variant
await table.updateOne({
  id: 1,
  variants: $insert([{ sku: "B2", color: "blue", stock: 10 }]),
});

// Update — replaces the entire matched element
await table.updateOne({
  id: 1,
  variants: $update([{ sku: "B2", color: "navy", stock: 8 }]),
});

// Remove by key
await table.updateOne({
  id: 1,
  variants: $remove([{ sku: "B2" }]),
});

// Upsert — insert if not found, replace if found
await table.updateOne({
  id: 1,
  variants: $upsert([{ sku: "C3", color: "green", stock: 3 }]),
});
```

Under replace strategy, `$update` and `$upsert` replace the **entire** matched element — every required field must be present.

### Operations with Merge Strategy

With `@db.patch.strategy 'merge'`, updates merge into the existing element, preserving fields not explicitly provided:

```atscript
@db.patch.strategy 'merge'
attributes: {
    @expect.array.key
    name: string
    value: string
    visible: boolean
}[]
```

```typescript
import { $update } from "@atscript/db/ops";

// Current: [{ name: 'size', value: 'M', visible: true }]
await table.updateOne({
  id: 1,
  attributes: $update([{ name: "size", value: "XL" }]),
});
// Result: [{ name: 'size', value: 'XL', visible: true }] — 'visible' preserved
```

## Keyless Object Arrays

For object arrays without `@expect.array.key`, matching falls back to **full deep value equality**. This means `$remove` works (match entire objects), but `$update` is effectively a no-op (there are no key fields to locate a target element for partial update):

```typescript
import { $insert, $remove, $replace } from "@atscript/db/ops";

// Append
await table.updateOne({
  id: 1,
  logs: $insert([{ message: "Deployed", ts: 1710000000 }]),
});

// Remove by exact match
await table.updateOne({
  id: 1,
  logs: $remove([{ message: "Deployed", ts: 1710000000 }]),
});

// Full replacement
await table.updateOne({ id: 1, logs: $replace([]) });
```

For anything beyond simple append/remove, add `@expect.array.key` to enable key-based matching.

## JSON Fields

Fields annotated with `@db.json` reject **all** patch operators and **field operations** (`$inc`, `$dec`, `$mul`). The field is stored as a single opaque JSON column — the database cannot operate on individual keys inside it. Only plain replacement is allowed:

```atscript
@db.json
settings: {
    theme: string
    notifications: boolean
}
```

```typescript
// ✅ Works — plain replacement
await table.updateOne({
  id: 1,
  settings: { theme: "dark", notifications: false },
});

// ❌ Fails — patch operators rejected on @db.json fields
await table.updateOne({
  id: 1,
  settings: $replace({ theme: "dark" }),
});

// ❌ Fails — field ops rejected inside @db.json fields
await table.updateOne({
  id: 1,
  settings: { notifications: $inc() },
});
```

The same applies to `@db.json` arrays — use a plain array value instead of patch operators.

## Combining Operators

Multiple operators can be used on the same field, and multiple fields can be patched in one request. When combining operators on a single field, use the raw object form — sentinel helpers return single-operator objects and cannot be merged:

```typescript
import { $insert, $inc } from "@atscript/db/ops";

await table.updateOne({
  id: 1,
  // Multiple ops on one field — use raw object
  variants: {
    $remove: [{ sku: "OLD" }],
    $update: [{ sku: "A1", color: "red", stock: 5 }],
    $insert: [{ sku: "NEW", color: "green", stock: 10 }],
  },
  // Single op on a field — use sentinel helper
  tags: $insert(["reviewed"]),
  views: $inc(),
  title: "Updated title",
});
```

Operators are always applied in order: **remove → update → upsert → insert**.

## What This Page Does NOT Cover

Navigation property patches — operating on related records across foreign keys using the same `$insert`, `$update`, `$remove`, `$upsert`, and `$replace` operators on FROM and VIA relations — are covered in [Relations — Relational Patches](/relations/patches).

## Next Steps

- [CRUD Operations](/api/crud) — Basic insert, read, update, delete
- [Queries & Filters](/api/queries) — Filtering, sorting, and projection
- [Transactions](/api/transactions) — Atomic multi-table operations
- [Relations — Relational Patches](/relations/patches) — Patching navigation properties
