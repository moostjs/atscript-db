# Patch Strategies — @atscript/db-mongo

> How `@db.mongo.patch.strategy` and array patch operations work.

## Overview

When updating documents via `AsCollection.update()`, the `CollectionPatcher` converts your patch payload into MongoDB aggregation pipeline stages. The behavior depends on two things:

1. **`@db.mongo.patch.strategy`** on objects — controls whether nested objects are replaced or merged
2. **Array key fields** (`@expect.array.key`) and patch operations — controls how array elements are matched and modified

## Object Patch Strategies

### Default (no annotation) — Replace

Without `@db.mongo.patch.strategy`, nested objects are fully replaced:

```atscript
@db.table 'users'
export interface User {
    address: {
        line1: string
        city: string
        zip: string
    }
}
```

```typescript
// This replaces the entire address object
await users.update({
  _id: id,
  address: { line1: "123 Main St", city: "NYC", zip: "10001" },
});
```

### `@db.mongo.patch.strategy 'replace'`

Explicit replacement — same as default. The entire nested object is overwritten.

### `@db.mongo.patch.strategy 'merge'`

Individual fields within the nested object are updated without affecting unspecified fields:

```atscript
@db.table 'users'
export interface User {
    @db.mongo.patch.strategy 'merge'
    contacts: {
        email: string
        phone: string
    }
}
```

```typescript
// Only updates phone, email is preserved
await users.update({
  _id: id,
  contacts: { phone: "+1-555-0100" },
});
```

### Nested strategies

Strategies can be applied at any nesting level:

```atscript
@db.table 'config'
export interface Config {
    @db.mongo.patch.strategy 'merge'
    settings: {
        @db.mongo.patch.strategy 'replace'
        theme: { primary: string, secondary: string }

        @db.mongo.patch.strategy 'merge'
        notifications: { email: boolean, push: boolean }
    }
}
```

## Array Patch Operations

Top-level arrays in a patch payload use a structured format with operation keys.

### `$replace`

Replaces the entire array:

```typescript
await collection.update({
  _id: id,
  tags: { $replace: ["new", "tags", "only"] },
});
```

### `$insert`

Appends items to the array:

```typescript
await collection.update({
  _id: id,
  tags: { $insert: ["newTag1", "newTag2"] },
});
```

If `@db.mongo.array.uniqueItems` is set, duplicates are silently dropped (uses `$setUnion`).

### `$upsert`

Insert-or-update by key. For keyed arrays (`@expect.array.key`), removes existing elements matching the key(s) and appends the new ones:

```atscript
@db.table 'products'
export interface Product {
    items: {
        @expect.array.key
        sku: string
        quantity: number
        price: number
    }[]
}
```

```typescript
await products.update({
  _id: id,
  items: {
    $upsert: [
      { sku: "ABC", quantity: 10, price: 9.99 }, // replaces existing ABC or inserts
    ],
  },
});
```

For non-keyed arrays, behaves like `$addToSet` (deep equality).

### `$update`

Updates existing array elements matched by key:

```typescript
await products.update({
  _id: id,
  items: {
    $update: [
      { sku: "ABC", quantity: 20 }, // updates only quantity for sku=ABC
    ],
  },
});
```

With `@db.mongo.patch.strategy 'merge'` on the array field, uses `$mergeObjects` to merge into the matched element. Without it, replaces the matched element entirely.

### `$remove`

Removes array elements:

```typescript
// Keyed — removes by key match
await products.update({
  _id: id,
  items: {
    $remove: [{ sku: "ABC" }],
  },
});

// Non-keyed — removes by deep equality
await collection.update({
  _id: id,
  tags: {
    $remove: ["obsoleteTag"],
  },
});
```

## Array Keys

Use `@expect.array.key` to mark fields that uniquely identify array elements:

```atscript
export interface Translations {
    entries: {
        @expect.array.key
        lang: string
        @expect.array.key
        key: string
        value: string
    }[]
}
```

Multiple key fields form a composite key — elements are matched when ALL key fields match.

## Implementation Details

The `CollectionPatcher` converts patch payloads into MongoDB aggregation pipeline stages using:

- `$reduce` + `$filter` + `$concatArrays` for keyed upsert/remove
- `$map` + `$cond` + `$mergeObjects` for keyed update with merge
- `$setUnion` for unique/non-keyed insert
- `$setDifference` for non-keyed remove
- `$concatArrays` for plain append

All operations are performed atomically in a single `updateOne()` call using an aggregation pipeline.
