# Collections & CRUD — @atscript/db-mongo

> Using AsMongo and AsCollection for database operations.

## AsMongo

Entry point for MongoDB operations. Wraps a `MongoClient` and provides a collection registry.

```typescript
import { AsMongo } from "@atscript/db-mongo";

// From connection string
const asMongo = new AsMongo("mongodb://localhost:27017/mydb");

// From existing MongoClient
const asMongo = new AsMongo(existingClient);

// With logger
const asMongo = new AsMongo(connectionString, myLogger);
```

### `getCollection<T>(type, logger?)`

Returns an `AsCollection<T>` for the given Atscript annotated type. Collections are cached per type.

```typescript
import { User } from "./user.as";

const users = asMongo.getCollection(User);
```

## AsCollection

Core collection abstraction providing validation, CRUD operations, and index management.

### Properties

- **`name`** — Collection name (from `@db.table`)
- **`collection`** — Raw MongoDB `Collection` instance
- **`flatMap`** — `Map<string, TAtscriptAnnotatedType>` of all fields in dot-notation

### Insert

```typescript
// Insert one
const result = await users.insert({
  email: "alice@example.com",
  name: "Alice",
  isActive: true,
});

// Insert many
const result = await users.insert([
  { email: "alice@example.com", name: "Alice", isActive: true },
  { email: "bob@example.com", name: "Bob", isActive: false },
]);
```

Validates the payload before inserting. Auto-generates `ObjectId` for `_id` if type is `mongo.objectId`.

### Replace

```typescript
await users.replace({
  _id: "507f1f77bcf86cd799439011",
  email: "alice@new.com",
  name: "Alice Updated",
  isActive: true,
});
```

Validates the full document and replaces by `_id`.

### Update (Patch)

```typescript
await users.update({
  _id: "507f1f77bcf86cd799439011",
  name: "New Name",
  // Only updates specified fields
});
```

Uses `CollectionPatcher` internally to build MongoDB aggregation pipelines. See [patches.md](patches.md) for array patch operations.

### Validation

```typescript
// Get a validator for different contexts
const insertValidator = users.getValidator("insert");
const updateValidator = users.getValidator("update");
const patchValidator = users.getValidator("patch");

// Create a custom validator
const validator = users.createValidator({
  partial: true,
  plugins: [myPlugin],
  skipList: new Set(["internalField"]),
});
```

### Index Management

```typescript
// Sync indexes — creates/drops to match .as definitions
await users.syncIndexes();
```

Only manages indexes prefixed with `atscript__`. User-created indexes are not touched.

Reads index definitions from:

- `@db.index.plain` → standard indexes
- `@db.index.unique` → unique indexes
- `@db.index.fulltext` → text indexes (weight 1)
- `@db.mongo.index.text` → text indexes (custom weight)
- `@db.mongo.search.*` → Atlas Search indexes

### Querying

```typescript
// Find documents
const cursor = users.collection.find({ isActive: true });

// Use the raw MongoDB collection for queries
const doc = await users.collection.findOne({ _id: users.prepareId(id) });
```

### `prepareId(id)`

Converts a string ID to `ObjectId` if the collection uses `mongo.objectId` type for `_id`.

```typescript
const objectId = users.prepareId("507f1f77bcf86cd799439011");
```

## Best Practices

- Use `getValidator()` for context-specific validation before custom operations
- Call `syncIndexes()` on application startup to ensure indexes match definitions
- Use `prepareId()` when working with raw MongoDB queries to handle ObjectId conversion
- The `flatMap` property is lazily built — first access triggers computation
