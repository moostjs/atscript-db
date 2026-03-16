---
outline: deep
---

# CRUD Operations

Atscript's DB layer provides a type-safe API for creating, reading, updating, and deleting records. All operations go through `AtscriptDbTable`, which handles validation, default values, nested object flattening, and adapter translation automatically.

## Getting a Table Instance

```typescript
import { DbSpace } from "@atscript/db";
import { User } from "./schema/user.as";

const users = db.getTable(User); // AtscriptDbTable<typeof User>
```

`getTable()` returns a cached instance — calling it again with the same type returns the same table. See [Setup](/guide/setup) for how to create a `DbSpace`.

## Inserting Records

### Insert One

Insert a single record and get back the generated primary key:

```typescript
const result = await users.insertOne({
  email: "alice@example.com",
  name: "Alice",
  status: "active",
});
// result: { insertedId: 1 }
```

Fields with `@db.default.*` annotations (`@db.default.increment`, `@db.default.uuid`, `@db.default.now`, or `@db.default 'value'`) are applied automatically — you can omit them from the input.

### Insert Many

Insert multiple records in a single transaction:

```typescript
const result = await users.insertMany([
  { email: "alice@example.com", name: "Alice" },
  { email: "bob@example.com", name: "Bob" },
  { email: "charlie@example.com", name: "Charlie" },
]);
// result: { insertedCount: 3, insertedIds: [1, 2, 3] }
```

::: info Nested Creation
Both `insertOne` and `insertMany` support nested relation data — inserting related records across foreign keys in a single call. This is covered in [Relations — Deep Operations](/relations/deep-operations).
:::

## Reading Records

### Find by ID

Look up a single record by primary key:

```typescript
const user = await users.findById(1);
// Returns the record or null
```

`findById` is flexible — it accepts:

- A single primary key value
- An object with composite key fields
- A value matching a single-field unique index
- An object matching a compound unique index

### Find One

Return the first record matching a filter:

```typescript
const user = await users.findOne({
  filter: { email: "alice@example.com" },
});
// Returns the first match or null
```

### Find Many

Return all records matching a filter, with optional sorting and pagination:

```typescript
const active = await users.findMany({
  filter: { status: "active" },
  controls: {
    $sort: { name: 1 },
    $limit: 10,
    $skip: 0,
  },
});
```

For a full reference on filter operators and controls, see [Queries & Filters](/api/queries).

### Count

Count matching records without fetching data:

```typescript
const total = await users.count({
  filter: { status: "active" },
});
```

Pass no arguments to count all records:

```typescript
const allUsers = await users.count();
```

### Find Many with Count

Get both data and total count in one call — useful for paginated UIs:

```typescript
const { data, count } = await users.findManyWithCount({
  filter: { status: "active" },
  controls: { $limit: 10, $skip: 20 },
});
// data: first 10 records after skipping 20
// count: total matching records (ignoring $limit/$skip)
```

## Updating Records

### Update One

Partially update a record. The primary key field(s) must be included to identify the record — only the other provided fields are changed:

```typescript
const result = await users.updateOne({
  id: 1,
  name: "Alice Smith",
});
// result: { matchedCount: 1, modifiedCount: 1 }
```

::: info Patch Operators
For updating embedded arrays and nested objects with fine-grained control, see [Update & Patch](/api/update-patch).
:::

### Update Many

Update all records matching a filter:

```typescript
const result = await users.updateMany(
  { status: "inactive" }, // filter
  { status: "archived" }, // data to set
);
// result: { matchedCount: 5, modifiedCount: 5 }
```

`updateMany` does not support nested relation operations — only own fields.

## Replacing Records

### Replace One

Replace an entire record by primary key. Unlike `updateOne`, **all fields must be provided** — missing fields are not preserved:

```typescript
const result = await users.replaceOne({
  id: 1,
  email: "alice.new@example.com",
  name: "Alice Smith",
  status: "active",
});
```

::: tip Replace vs. Update

- **`updateOne`** — sends only the fields you want to change (partial)
- **`replaceOne`** — replaces the entire record with new data (full)
  :::

## Deleting Records

### Delete One

Delete a single record by ID:

```typescript
const result = await users.deleteOne(1);
// result: { deletedCount: 1 }
```

`deleteOne` accepts the same flexible ID format as `findById` — primary key, composite key object, or unique index value.

### Delete Many

Delete all records matching a filter:

```typescript
const result = await users.deleteMany({
  status: "archived",
});
// result: { deletedCount: 12 }
```

::: info Cascade & Set-Null
When a deleted record is referenced by other tables via foreign keys, cascade and set-null behaviors are handled automatically based on `@db.rel.onDelete` annotations. See [Relations](/relations/deep-operations) for details.
:::

## Validation

Tables automatically validate data on every write operation using constraints from your `.as` definitions (`@expect.*` annotations). Validation is purpose-aware:

| Purpose         | Used by                     | Behavior                                                                                          |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `'insert'`      | `insertOne`, `insertMany`   | PK, defaulted, and FK fields become optional                                                      |
| `'bulkUpdate'`  | `updateOne`, `bulkUpdate`   | Top level is partial; merge-strategy objects partial, replace-strategy objects require all fields |
| `'bulkReplace'` | `replaceOne`, `bulkReplace` | All non-optional fields required                                                                  |
| `'patch'`       | `updateMany`                | Fully partial                                                                                     |

You can access validators directly for manual checks:

```typescript
const validator = users.getValidator("insert");
if (!validator.validate(data, true)) {
  // safe = true → returns false instead of throwing
  console.log(validator.errors);
  // [{ path: 'email', message: 'Required field' }, ...]
}
```

## Error Handling

Database operations throw `DbError` with a `code` property indicating the error type:

| Code            | Meaning                         |
| --------------- | ------------------------------- |
| `CONFLICT`      | Unique constraint violation     |
| `FK_VIOLATION`  | Foreign key constraint violated |
| `NOT_FOUND`     | Record not found                |
| `CASCADE_CYCLE` | Circular cascade detected       |
| `INVALID_QUERY` | Malformed query or filter       |

Handle errors by checking the code:

```typescript
import { DbError } from "@atscript/db";

try {
  await users.insertOne({ email: "alice@example.com", name: "Alice" });
} catch (err) {
  if (err instanceof DbError) {
    switch (err.code) {
      case "CONFLICT":
        console.log("Email already exists:", err.errors);
        break;
      case "FK_VIOLATION":
        console.log("Referenced record missing:", err.errors);
        break;
    }
  }
}
```

Each error includes an `errors` array with `{ path, message }` entries for detailed diagnostics.

### Error Paths in Nested Data

When validation fails inside nested or array payloads, error paths use dot notation to pinpoint the exact location:

| Context            | Example path              | Meaning                                            |
| ------------------ | ------------------------- | -------------------------------------------------- |
| Top-level field    | `"title"`                 | The `title` field failed validation                |
| TO navigation      | `"project.title"`         | The `title` field inside inline `project` data     |
| FROM array element | `"comments.0.body"`       | The `body` field of the first comment in the array |
| Deep nesting       | `"tasks.2.project.title"` | The `title` of the project in the third task       |

This makes it straightforward to map errors back to specific fields in complex nested payloads — useful for building form validation UIs.

## Next Steps

- [Queries & Filters](/api/queries) — Advanced filtering, sorting, and projection
- [Update & Patch](/api/update-patch) — Embedded array and object patch operators
- [Transactions](/api/transactions) — Atomic multi-table operations
- [Relations — Deep Operations](/relations/deep-operations) — Nested creation and replacement across relations
