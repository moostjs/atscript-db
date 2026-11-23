---
outline: deep
---

# Update & Patch

<!--@include: ../_experimental-warning.md-->

This page covers fine-grained update operations on **single-table data** — embedded objects and embedded arrays stored directly on a record. For patching related records across foreign keys (FROM and VIA navigation properties), see [Relations — Relational Patches](/relations/patches).

::: warning Nested writes need `@db.depth.limit`
`bulkUpdate`, `bulkReplace`, and `insertMany` validate nested-write depth against [`@db.depth.limit N`](/relations/deep-operations) on the target table. The default — annotation absent — is `0`, which rejects every payload that crosses a `@db.rel.from` / `@db.rel.via` relation. Opt in explicitly when you want the server to accept deep writes.
:::

## Simple Updates

The simplest update sets scalar fields directly. The primary key must be in the payload to identify the record:

```typescript
await users.updateOne({
  id: 1,
  name: "Alice Smith",
  status: "active",
});
```

Only the provided fields are changed — other fields remain untouched. A key whose value is `undefined` counts as _not provided_ (since 0.1.128): it never reaches the `SET` list, so the stored value stays as it was; send `null` to clear a column (optional columns only — the validator accepts `null` for every optional prop, and since 0.1.128 the read-side filter types admit `null` for them as well, so a cleared row is found with `{ note: null }` and excluded with `{ note: { $ne: null } }`). Inside a nested object without [`@db.patch.strategy 'merge'`](#replace-strategy-default) the block is replaced as a whole, so an `undefined` optional leaf behaves exactly like omitting it (the leaf is null-filled) — with the merge strategy it is left untouched.

::: tip Empty patches
A payload with only the identifying fields writes nothing and reports whether the row exists (`{ matchedCount: 1 | 0, modifiedCount: 0 }`); the version column does not move. Add `$cas` to turn it into a [versioned touch](./versioning#versioned-touch).
:::

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

The operand must be a **finite number**: `$inc(NaN)`, `$dec(Infinity)` or `$mul(-Infinity)` fail validation with `Field operation operand must be a finite number, got NaN` (since 0.1.148). Floating-point arithmetic with a non-finite operand would poison the stored value.

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

::: tip HTTP usage
The helpers return plain JSON objects (`$inc(5)` → `{ $inc: 5 }`), so they serialize naturally. See the [HTTP PATCH endpoint](/http/crud#patch-update) for REST examples.
:::

## `$cas` — Optimistic Concurrency {#cas-operator}

`$cas` is a top-level payload operator (sibling to plain SET fields and the field ops above) that turns any `updateOne`, `replaceOne`, or per-item `bulkUpdate` into a **conditional** write. It is the opt-in surface for optimistic concurrency control on tables that declare a [`@db.column.version`](./versioning#the-db-column-version-annotation) column.

```typescript
const ok = await tasks.updateOne({
  id: 1,
  status: "done",
  $cas: { version: row.version }, // ← only commits if the row is still at this version
});

if (ok.matchedCount === 0) {
  // Either the row doesn't exist OR another writer touched it. Retry.
}
```

On a mismatch the call returns `{ matchedCount: 0, modifiedCount: 0 }` — no exception, no partial write. `$cas` composes atomically with `$inc` / `$dec` / `$mul` in the same payload (single statement on SQL, single `findOneAndUpdate` on Mongo). With no other fields at all it is the [versioned touch](./versioning#versioned-touch) — a conditional bump that fences the row.

A patch that writes only [`@db.column.version.exempt`](./versioning#version-exempt) fields (and carries no `$cas`) skips the version bump; with `$cas` it still checks and bumps.

`$cas` is **not** supported on `updateMany` (a single `expectedVersion` cannot sensibly match N rows). Per-row version locking goes through `bulkUpdate` where each payload carries its own `$cas`.

See [Optimistic Concurrency (Row Versioning)](./versioning) for the full reference — annotation constraints, the `withOptimisticRetry` helper, `CasExhaustedError`, direct-write rejection, and the [HTTP wire contract](/http/crud#occ-over-http).

### Operation Helpers

The `@atscript/db/ops` module also exports helpers for [array patch operators](#embedded-array-patches):

```typescript
import { $insert, $remove, $replace, $upsert, $update } from "@atscript/db/ops";

await posts.updateOne({ id: 1, tags: $insert(["urgent"]) });
await posts.updateOne({ id: 1, tags: $remove(["draft"]) });
```

### Where Field Ops Work

Field operations require that the target field maps to its own database column (or document key) so the database engine can apply the arithmetic atomically. This means:

| Context                                        | Works? | Why                                                                                  |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| Top-level numeric field                        | Yes    | Maps directly to a column / document key                                             |
| Nested field with `@db.patch.strategy 'merge'` | Yes    | Each sub-field is stored as its own column (SQL) or dot-path key (MongoDB)           |
| Inside a navigation property (relation)        | Yes    | The related table's `bulkUpdate` handles ops on its own fields                       |
| `updateMany` — same contexts as `updateOne`    | Yes    | The patch is decomposed the same way — nested merge-strategy ops become dot-path ops |

### Where Field Ops Do NOT Work

| Context                                                                                              | Result                               | Why                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Inside a `@db.json` field                                                                            | **Validation error**                 | JSON fields are stored as an opaque blob — the database cannot reach inside to increment a single key |
| Inside a nested object **without** `@db.patch.strategy 'merge'`                                      | **Validation error**                 | Without merge strategy the entire object is replaced — there is no individual column to increment     |
| Inside an embedded-array item (any array operator or plain set)                                      | **Validation error**                 | The array is written whole — an operator inside an item would be stored as data (since 0.1.153)       |
| Inside a tuple element, a union member, or a `T \| null` object without `@db.patch.strategy 'merge'` | **Validation error** (since 0.1.184) | Written as one value, like a replaced object — see [Where Merge Applies](#where-merge-applies)        |

The error is a `FIELD_OP_CONTEXT` entry at the field's path — under a `T | null` object too (since 0.1.185; before, it sat in the `details` of a union entry at the object's field). Under a member of a union of objects, the validator reports the union instead: one entry at the field, whose `details` hold the `FIELD_OP_CONTEXT` entry. Through a relation, the path starts with the relation field (`author.stats.views`).

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

Nested objects stored on a record (not navigation properties) use a strategy-based approach controlled by `@db.patch.strategy`. The mental model is:

- **Default = replace = strict.** Every branch is treated as replace unless explicitly annotated otherwise. The validator requires every **required** child to be present on a replace branch — partial sub-shapes that omit required fields are rejected with a 400 to keep the database constraint and the API contract aligned.
- **`@db.patch.strategy 'merge'` is a one-level opt-in.** It applies only to the level it's annotated on; descendants revert to default replace unless they too carry the annotation. Merge does not propagate.
- **Optional children of a replace branch are null-filled when omitted.** That's what distinguishes replace from merge — replace clears unspecified optional sub-fields, merge preserves them.
- **Merge stays merge.** A merge-strategy object inside a replaced one still keeps the children the patch leaves out — see [Merge Inside a Replaced Object](#merge-inside-a-replaced-object).
- **`@db.json` is always strict** — the column is an opaque blob; partial sub-shapes can't be decomposed.
- **Merge applies only where a patch reaches the object by its own path** — not inside an array element, a JSON or encrypted field, a union member or a tuple element. See [Where Merge Applies](#where-merge-applies).

### Replace Strategy (Default)

Without `@db.patch.strategy`, the nested object is **overwritten**: every required child must be supplied, and any optional child the user omits is explicitly set to `null` so the storage matches the input shape on both SQL (column-decomposed) and MongoDB (sub-document):

```atscript
// schema
address: {
    line1: string
    line2?: string         // optional
    city: string
    state: string
    zip: string
}
```

```typescript
// Current: { address: { line1: '123 Main St', line2: 'Apt 4', city: 'Portland', state: 'OR', zip: '97201' } }

// ✅ Full required shape — optional line2 omitted, gets null-filled
await table.updateOne({
  id: 1,
  address: { line1: "1 Pike Pl", city: "Seattle", state: "WA", zip: "98101" },
});
// Result: address.line1='1 Pike Pl', address.line2=null, address.city='Seattle', …

// ❌ Missing a required child — rejected at the validator
await table.updateOne({ id: 1, address: { city: "Seattle" } });
// ValidatorError: address.line1 is required, address.state is required, …
//   (replace = strict; required children must be supplied)
```

If you want to update one field of `address` and preserve the rest, switch the parent to merge:

```atscript
@db.patch.strategy 'merge'
address: { ... }
```

[Field operations](#field-ops) (`$inc`, `$dec`, `$mul`) are **not allowed** inside replace-strategy objects — the validator will reject them. Use `@db.patch.strategy 'merge'` if you need atomic operations on nested fields, or to preserve omitted siblings.

### Merge Strategy

With `@db.patch.strategy 'merge'`, only the provided nested fields are updated — others are preserved. The annotation applies to that one level only; nested objects under a merge parent revert to default replace unless they also carry the annotation:

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

A merge-strategy object stored as `null`, or never stored, takes the patch too: it becomes the object the patch sends (`{ city: 'Seattle' }` above). This holds at any depth and in `updateOne`, `bulkUpdate`, `updateMany` and HTTP `PATCH` on every adapter — since 0.1.183 for MongoDB's `updateMany`, which threw `Cannot create field 'city' in element {address: null}` before.

Merge-strategy fields also support [field operations](#field-ops) on their nested numeric sub-fields:

```typescript
import { $inc } from "@atscript/db/ops";

await products.updateOne({
  id: 1,
  stats: { views: $inc(), rating: 4.5 },
});
// views is atomically incremented, rating is set to 4.5, other stats fields preserved
```

### Merge Inside a Replaced Object

A merge-strategy object keeps the children the patch leaves out even when its parent is replaced. The parent's own omitted children are still cleared, as with any replaced object:

```atscript
profile?: {                 // default strategy: replace
    bio?: string
    @db.patch.strategy 'merge'
    settings?: {
        theme?: string
        lang?: string
    }
}
```

```typescript
// Current: { profile: { bio: 'Hi', settings: { theme: 'dark', lang: 'en' } } }

await table.updateOne({ id: 1, profile: { settings: { theme: "light" } } });
// Result: { profile: { bio: null, settings: { theme: 'light', lang: 'en' } } }
// bio is cleared (profile is replaced), lang is kept (settings merges)
```

- **Leave the merge object out, or send `null`, to clear it** — it is an omitted child of the replaced parent like any other.
- **Send it empty (`settings: {}`) to keep it as stored.**
- **A required merge object must still be sent** — the replaced parent is strict — but its own required children may be left out and keep their stored values.
- The rule holds at any depth (a replace-strategy object inside the merge object is replaced again), with [array operators](#embedded-array-patches) inside the merge object, and in `updateOne`, `bulkUpdate`, `updateMany` and the HTTP `PATCH` endpoints.

Every adapter gives this result since 0.1.183. Before, SQLite, PostgreSQL and MySQL cleared the merge object's omitted columns too (a required child included), the in-memory adapter stored the replaced parent as sent (so the merge object lost every child the patch left out), and MongoDB's `updateMany` did the same; MongoDB's `updateOne` and `bulkUpdate` already kept them.

### Where Merge Applies {#where-merge-applies}

A merge strategy applies to an object only where a patch reaches that object by its own path: from the top of the row through stored nested objects. A field typed `T | null` with an object `T` is a `T` here — `@db.patch.strategy 'merge'` on it, or on an object inside it, merges like on any nested object (on `T[] | null` the annotation is a build error: array operators are refused there). Everywhere else the strategy has no effect, on every adapter (since 0.1.184): the object is validated in full — a partial one is rejected, as an insert rejects it — and written as part of the whole value, and a field operator (`$inc`, `$dec`, `$mul`) inside it is refused as inside an array element. That is the case

- inside an array element: a whole array, or a `$update` / `$upsert` item — also on an array with `@db.patch.strategy 'merge'`, which merges the item into the element one level deep, so the item's nested objects replace the stored ones;
- inside a `@db.json` or `@db.encrypted` field, and on such a field itself;
- inside a union member (`Prefs | string`, `Card | Bank`) or a tuple element, and on a field typed as such a union.
- inside a type that contains itself, below its first repeat: with `Node { @db.patch.strategy 'merge' child?: Node }` stored at `root`, `root.child` merges and `root.child.child` is written as one value.

One type can sit in both kinds of place: its merge field merges where a patch reaches it and is validated in full elsewhere.

```atscript
interface Prefs {
    @db.patch.strategy 'merge'
    geo?: { lat: number, lng: number, note?: string }
}

@db.table 'users'
export interface User {
    @meta.id
    id: number

    @db.patch.strategy 'merge'
    prefs?: Prefs        // { prefs: { geo: { lat: 9 } } } keeps lng and note

    @db.json
    saved?: Prefs        // { saved: { geo: { lat: 9 } } } is rejected: lng is required

    history?: Prefs[]    // an element is written as sent
}
```

Written where it can never apply, the annotation is a build error, shown in your editor: on a field that also has `@db.json` or `@db.encrypted`, and inside an array element or a `@db.json` / `@db.encrypted` field, where the annotation is written. The build checks the annotation where it is written: inside one of these places, a merge-strategy field that arrives through a referenced type, through an object written in a type group (`( … ) | null`, `&`, a union, a tuple) or through `annotate` is not a build error, and it has no effect there. The same field merges wherever a patch reaches it by its own path.

Before 0.1.184 a partial merge-strategy object in these places was stored without the children it left out — see [Upgrading](/guide/upgrading#v0-1-184).

## Embedded Array Patches

Arrays stored directly on the record support five patch operators for fine-grained manipulation:

| Operator   | Effect                        |
| ---------- | ----------------------------- |
| `$replace` | Replace the entire array      |
| `$insert`  | Append new items              |
| `$upsert`  | Insert or update items by key |
| `$update`  | Update existing items by key  |
| `$remove`  | Remove items by key or value  |

When multiple operators appear on the same field, they are always applied in order: **remove → update → upsert → insert** — regardless of the order they appear in the object (on MongoDB since 0.1.180; before, it ran the update last).

Every adapter gives the same array for the same patch (since 0.1.180): `$insert` appends, `$upsert` and `$update` change an element where it is, `$remove` takes out the matching elements, and the rest of the array keeps its order and its duplicates.

`$replace` stands alone: operators sent next to it on the same field are ignored (on MongoDB since 0.1.180; before, it applied them to the new array).

Array operators work in `updateOne`, `bulkUpdate` and `updateMany` (since 0.1.182). In `updateMany` they apply to each matched row's own stored array, so every row ends with the array `updateOne` gives it — see [Array operators in `updateMany`](#array-ops-update-many).

An array inside a nested object takes the operators too, at any depth (on the in-memory adapter since 0.1.182, see [Field Operations](/adapters/memory#field-operations-defaults)): `{ box: { labels: { $insert: ["y"] } } }`. The rest of the object follows the parent's [patch strategy](#embedded-object-patches): under the default (replace), the optional children the patch leaves out are cleared, as with any replaced object; under `@db.patch.strategy 'merge'` they stay. A merge-strategy object inside a replaced one keeps its omitted children (see [Merge Inside a Replaced Object](#merge-inside-a-replaced-object); since 0.1.183 — before, SQL and in-memory adapters cleared them).

Items are validated like the items of a plain array set (since 0.1.153): an optional item field accepts `null` in `$update` too, and an error names the item property (`items.$update[0].qty`). Primitive `$remove` / `$update` values are checked one by one against the element type. Items are [normalized](/api/crud#normalization) first (since 0.1.170), keys included: `$remove: [" RED "]` removes the stored `"red"` when the element type lowercases and trims.

::: warning SQL Adapters
In relational databases (SQLite, PostgreSQL, MySQL), arrays are stored as JSON columns. Patch operators work via read-modify-write. For collections that need frequent partial updates in SQL, consider modeling them as separate tables with [FROM or VIA relations](/relations/patches) instead.
:::

### Read-modify-write {#read-modify-write}

On every adapter but MongoDB, which applies the operators natively, the update reads the row, applies the operators to the stored array and writes the whole array back, in one transaction. Since 0.1.182 the read locks the row where the engine takes row locks (`FOR UPDATE` on PostgreSQL and MySQL), so two concurrent operator patches of one row run one after the other; before, both could read the same array and the second write dropped the first one's change. SQLite already ran them one at a time. Since 0.1.178 the stored array is decoded the way a read decodes it, so a [SQLite vector](/adapters/sqlite#vector-storage) stored as a Float32 `BLOB` is patched as its numbers (and stored back as JSON text). A stored value that is still not an array, such as JSON text of a string or an object written by SQL of your own, fails the update with `Cannot apply array patch operators to "<column>": its stored value is not an array`, and nothing is written. `<column>` is the column as stored (`box__labels` for `box.labels`, the `@db.column` name of a renamed field). Before 0.1.178 such a value was spread item by item, a string into its characters.

### Array operators in `updateMany` {#array-ops-update-many}

_Since 0.1.182; 0.1.180 and 0.1.181 refused them with `DbError("INVALID_QUERY")`._ `$insert`, `$upsert`, `$update` and `$remove` in `updateMany` apply to the stored array of each matched row, so rows that hold different arrays get different results — each the one `updateOne` with the same patch gives that row. Plain sets and [field operations](#field-ops) in the same patch apply to every matched row as usual:

```typescript
// every open ticket gets "triaged" added to and "stale" removed from its own tags
await tickets.updateMany(
  { status: "open" },
  { status: "queued", tags: { $insert: ["triaged"], $remove: ["stale"] } },
);
```

- **MongoDB** runs one `updateMany` statement with the update pipeline `updateOne` uses — for every patch with `$insert`, `$upsert`, `$update` or `$remove`, and for every patch that writes a field inside an embedded object, a `$replace` inside a nested object included. A top-level `$replace` is a plain set of the array and runs as a plain `updateMany` (since 0.1.183), which stores the same array.
- **SQLite, PostgreSQL, MySQL and the in-memory adapter** read the patched arrays of the matched rows and write each row by its primary key: one `UPDATE` per row, all in one transaction — the caller's when [`withTransaction`](/api/transactions) is open, so a failing row rolls the whole call back (the in-memory adapter has no rollback). The rows are picked once, before any write, as a single statement picks them; on PostgreSQL and MySQL they stay locked (`FOR UPDATE`) until the transaction ends, and their arrays are read with the same lock, so they are the latest committed ones even when the caller's transaction read the rows earlier (MySQL's REPEATABLE READ would otherwise return that older snapshot). On the in-memory adapter, concurrent calls in one process run one after the other. For large match sets, loop a [bounded write](/api/crud#bounded-writes) to keep each transaction short.
- **A table without a primary key** cannot be written row by row: on those adapters the call throws `DbError("INVALID_QUERY")` naming the field. Patch such rows with `updateOne` or `bulkUpdate`.
- **Counts:** `matchedCount` and `modifiedCount` add up the row writes, counted as a plain `updateMany` counts them on the same adapter. A row deleted between the pick and its write is not counted.
- **Bounded writes** (`{ limit, sort }`) take the operators too, on every adapter — see [Bounded writes](/api/crud#bounded-writes).
- **Versions:** each written row's [version](./versioning) goes up by one, unless the patch writes only version-exempt fields; `$cas` stays refused on `updateMany`.

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

`$update` has no key to find a value by, so it changes nothing on a primitive array (on MongoDB since 0.1.180; before, it added the values as a set union).

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

This holds for an array renamed with `@db.column` and for one inside a nested object too. Before 0.1.178, on every adapter but MongoDB, `$insert` on such a field could store a duplicate.

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

`$insert` skips an item whose key is already stored — it never adds a second element with the same key (since 0.1.180; before, MongoDB upserted the item and the other adapters appended a duplicate unless the array had `@expect.array.uniqueItems`). `$upsert` changes the stored element in place and appends an item with a new key.

Under replace strategy, `$update` and `$upsert` replace the **entire** matched element — every required field must be present, and an optional field the item leaves out is removed from the element. Since 0.1.180 this holds for `$update` on every adapter; before, SQLite, MySQL, PostgreSQL and the in-memory adapter merged the item into the element under both strategies. A `$update` item whose key matches no element changes nothing, and items that name the same key apply in order.

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

`$upsert` of an element that matches a stored one merges into it the same way. This holds for an array renamed with `@db.column` and for one inside a nested object too. Before 0.1.178, on every adapter but MongoDB, `$upsert` on such a field replaced the matched element instead.

## Keyless Object Arrays

For object arrays without `@expect.array.key`, matching falls back to **full deep value equality**. This means `$remove` works (match entire objects), but `$update` is effectively a no-op (there are no key fields to locate a target element for partial update). This is the same on every adapter since 0.1.180; before, MongoDB added the `$update` items to the array as a set union.

The order of an element's properties does not matter, at any depth, on every adapter. `$remove`, `$upsert` and `$insert` on a `uniqueItems` array find `{ ts: 1, message: "Deployed" }` when `{ message: "Deployed", ts: 1 }` is stored. An array inside an element is compared in order, and a missing property is not equal to `null`. On MongoDB this holds since 0.1.182, on every server version the adapter supports, with one exception: an item property whose name contains `.`, starts with `$` or is empty is compared with `$getField`, which needs MongoDB 5.0 or later (as storing such a name does). Before, it compared embedded documents in their stored property order, so an item sent in another order removed nothing, and `$upsert` or a unique `$insert` appended a second copy. On PostgreSQL and MySQL it holds since 0.1.180; they store JSON objects with re-ordered keys, so before, a stored object was never found there.

When `$upsert` or a unique `$insert` finds an equal element, the stored element stays as it is. An item that is appended is stored as you sent it. Before 0.1.182, a key-less `$upsert` on SQLite and the in-memory adapter replaced the equal element with the item, so the element took the item's property order.

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

The same applies to `@db.json` arrays — send the whole array instead of patch operators. An array operator (`$insert`, `$remove`, `$upsert`, `$update`, `$replace`) on a `@db.json` field fails with the code `ARRAY_OP_ON_JSON` (since 0.1.175), on the server and in the [db-client preflight](/http/client) alike:

```typescript
// ❌ ARRAY_OP_ON_JSON — tags is `@db.json string[]`
await table.updateOne({ id: 1, tags: { $insert: ["new"] } });

// ✅ Read, change, send the whole array
await table.updateOne({ id: 1, tags: [...row.tags, "new"] });
```

A JSON field has no merge strategy: it is written as one value — see [Where Merge Applies](#where-merge-applies). To patch parts of the object, drop `@db.json` so it is stored in columns.

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

## Typed operators {#typed-operators}

_Since 0.1.168._ The update payload type `DbPatch<Row>` (`updateOne`, `bulkUpdate`, `updateMany`, and `PatchOf<T>` of the [HTTP client](/http/client)) types the operators of top-level fields, so no cast is needed:

- a `number` field takes the number or `{ $inc | $dec | $mul: n }` (the helpers' return type `TDbFieldOp`);
- an array field takes the array or the array operators (`TDbArrayOps<Element>`: `$replace` / `$insert` / `$upsert` take elements, `$update` / `$remove` take partial elements — or the values themselves for an array of primitives);
- the payload takes `$cas`.

```typescript
await jobs.updateOne({ id, attempts: { $inc: 1 } }); // was a type error
await jobs.updateOne({ id, tags: { $insert: ["urgent"] }, $cas: { version: 3 } });
```

An operator on a field of another type is a type error (`{ title: { $inc: 1 } }`), and inserts (`DbInsert<Row>`) take no operators and no `$cas`. The types cannot tell a `@db.json` array from a plain one — the operators on a `@db.json` array are rejected [at runtime](#json-fields). Operators inside nested objects (merge strategy) are not typed; build those payloads as `DbPatch<Row>` with a cast.

## `maxDepth` Option

`bulkUpdate` and `bulkReplace` (and through them, `updateOne` / `replaceOne`) accept an optional second argument that caps how deep the runtime is allowed to recurse into nested relation payloads:

```typescript
await users.bulkUpdate(payloads, { maxDepth: 5 });
```

- The default is `3` — enough for typical "user → profile → address" chains.
- This is a **runtime** cap on recursion; it sits below `@db.depth.limit`, which is the **declarative** server-boundary check. Both have to allow the depth for a deep write to succeed.
- Setting `maxDepth` lower than your payload's depth raises a `DepthLimitExceededError` (`DEPTH_EXCEEDED`) before any database write.

## What This Page Does NOT Cover

Navigation property patches — operating on related records across foreign keys using the same `$insert`, `$update`, `$remove`, `$upsert`, and `$replace` operators on FROM and VIA relations — are covered in [Relations — Relational Patches](/relations/patches).

## Next Steps

- [CRUD Operations](/api/crud) — Basic insert, read, update, delete
- [Queries & Filters](/api/queries) — Filtering, sorting, and projection
- [Transactions](/api/transactions) — Atomic multi-table operations
- [Relations — Relational Patches](/relations/patches) — Patching navigation properties
