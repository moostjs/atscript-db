---
outline: deep
---

# HTTP Client

`@atscript/db-client` is a browser-compatible HTTP client that mirrors the server-side `AtscriptDbTable` API over REST. It works in browsers, Node.js, and any runtime with `fetch`. Under the hood it translates method calls into the [URL query syntax](./query-syntax) understood by `@atscript/moost-db` controllers.

## Installation

```bash
pnpm add @atscript/db-client
```

## Creating a Client

```typescript
import { Client } from "@atscript/db-client";

// Untyped — Record<string, unknown> generics
const users = new Client("/api/users");

// Type-safe — pass the Atscript model as generic
import type { User } from "./models/user.as";
const users = new Client<typeof User>("/api/users");
```

### Options

```typescript
const users = new Client<typeof User>("/api/users", {
  // Base URL for all requests
  baseUrl: "https://api.example.com",

  // Static headers
  headers: { Authorization: "Bearer token123" },

  // Async header factory (e.g. token refresh)
  headers: async () => ({
    Authorization: `Bearer ${await getToken()}`,
  }),

  // Custom fetch (e.g. for testing or interceptors)
  fetch: myCustomFetch,
});
```

| Option    | Type                                                                | Description                             |
| --------- | ------------------------------------------------------------------- | --------------------------------------- |
| `baseUrl` | `string`                                                            | Prepended to the path for every request |
| `headers` | `Record<string, string>` or `() => Promise<Record<string, string>>` | Default headers for every request       |
| `fetch`   | `typeof fetch`                                                      | Custom fetch implementation             |

## Querying

All query methods accept a [Uniquery](./query-syntax) object with `filter` and `controls`.

### findMany {#findmany}

Returns all matching records. Maps to [`GET /query`](./crud#get-query).

```typescript
const active = await users.findMany({
  filter: { status: "active" },
  controls: { $sort: { createdAt: -1 }, $limit: 50 },
});
```

### findOne {#findone}

Returns the first matching record or `null`. Internally sets `$limit: 1`.

```typescript
const user = await users.findOne({ filter: { email: "alice@example.com" } });
```

### findById {#findbyid}

Fetch by primary key. Returns `null` on 404. Maps to [`GET /one/:id`](./crud#get-one).

```typescript
// Scalar PK
const user = await users.findById("abc-123");

// Composite PK
const row = await users.findById({ tenantId: "t1", userId: "u1" });
```

Supports `controls` for projection and relation loading:

```typescript
const user = await users.findById("abc", {
  controls: { $select: ["id", "name"], $with: ["posts"] },
});
```

### count {#count}

Returns the number of matching records. Uses `$count` control.

```typescript
const total = await users.count({ filter: { role: "admin" } });
```

### pages {#pages}

Page-based pagination. Maps to [`GET /pages`](./crud#get-pages).

```typescript
const page = await users.pages({
  filter: { active: true },
  controls: { $page: 2, $size: 25 },
});
// → { data: [...], page: 2, itemsPerPage: 25, pages: 10, count: 243 }
```

### findManyWithCount {#findmanywithcount}

Offset-based pagination that also returns the total count. Uses the pages endpoint internally.

```typescript
const { data, count } = await users.findManyWithCount({
  controls: { $limit: 10, $skip: 20 },
});
```

## Relation Loading

Load relations using `$with` in controls. See [Relations & Search](./advanced#with) for full syntax.

```typescript
const orders = await client.findMany({
  controls: { $with: ["customer", "items"] },
});
```

## Search

### Text Search {#text-search}

Full-text search across configured indexes. Maps to `$search` control.

```typescript
const results = await users.search("alice");

// With specific index
const results = await posts.search("typescript guide", undefined, "title_idx");

// Combined with filters
const results = await posts.search("guide", { filter: { published: true } });
```

### Vector Search

Vector search is available through the regular query controls:

```typescript
const similar = await posts.findMany({
  controls: { $vector: "content_embedding", $search: "machine learning concepts" },
});
```

See [Relations & Search — Vector Search](./advanced#vector-search) for details.

## Aggregation {#aggregation}

Maps to `$groupBy` and aggregate select functions. See [Relations & Search — Aggregation](./advanced#aggregation).

```typescript
const stats = await orders.aggregate({
  controls: {
    $groupBy: ["status"],
    $select: [
      "status",
      { $fn: "count", $field: "*", $as: "total" },
      { $fn: "sum", $field: "amount", $as: "revenue" },
    ],
  },
});
```

## Write Operations {#writes}

Write methods are available when the server uses `AsDbController` (not `AsDbReadableController`).

### Insert {#insert}

```typescript
// Single insert → { insertedId }
const { insertedId } = await users.insertOne({
  name: "Alice",
  email: "alice@example.com",
});

// Batch insert → { insertedCount, insertedIds }
const { insertedCount } = await users.insertMany([{ name: "Alice" }, { name: "Bob" }]);
```

Maps to [`POST /`](./crud#post-insert).

### Update {#update}

Partial update — include the primary key and changed fields only.

```typescript
// Single update → { matchedCount, modifiedCount }
const { modifiedCount } = await users.updateOne({ id: "abc", name: "Updated" });

// Bulk update
await users.bulkUpdate([
  { id: "a", status: "active" },
  { id: "b", status: "active" },
]);
```

Maps to [`PATCH /`](./crud#patch-update). Supports [field operations](/api/update-patch#field-operations) like `$inc`, `$dec`, `$mul`.

### Replace {#replace}

Full document replace — all required fields must be present.

```typescript
await users.replaceOne({
  id: "abc",
  name: "Alice",
  email: "new@example.com",
  role: "admin",
});

// Bulk replace
await users.bulkReplace([...]);
```

Maps to [`PUT /`](./crud#put-replace).

### Delete {#delete}

```typescript
// Scalar PK
const { deletedCount } = await users.deleteOne("abc");

// Composite PK
await users.deleteOne({ tenantId: "t1", userId: "u1" });
```

Maps to [`DELETE /:id`](./crud#delete).

## Metadata {#meta}

Fetch table/view metadata. The result is cached after the first call.

```typescript
const meta = await users.meta();
```

**Response shape:**

```json
{
  "searchable": true,
  "vectorSearchable": false,
  "searchIndexes": [{ "name": "title_idx", "type": "text" }],
  "primaryKeys": ["id"],
  "readOnly": false,
  "relations": [{ "name": "posts", "direction": "from", "isArray": true }],
  "fields": {
    "id": { "sortable": true, "filterable": true },
    "name": { "sortable": false, "filterable": true }
  },
  "type": { "...": "serialized Atscript type schema" }
}
```

| Field              | Description                                       |
| ------------------ | ------------------------------------------------- |
| `searchable`       | Table has fulltext search indexes                 |
| `vectorSearchable` | Table has vector search indexes                   |
| `searchIndexes`    | Available search index definitions                |
| `primaryKeys`      | Primary key field names                           |
| `readOnly`         | `true` for `AsDbReadableController` / views       |
| `relations`        | Available navigation properties                   |
| `fields`           | Per-field capability flags (sortable, filterable) |
| `type`             | Full serialized Atscript type definition          |

## Error Handling {#errors}

Non-2xx responses throw a `ClientError` with the HTTP status and structured error body. The error shape matches the server's [error response format](./crud#error-handling).

```typescript
import { Client, ClientError } from "@atscript/db-client";

try {
  await users.insertOne({ name: "" });
} catch (e) {
  if (e instanceof ClientError) {
    e.status; // 400
    e.message; // "Validation failed"
    e.errors; // [{ path: "name", message: "required" }]
    e.body; // full server error response
  }
}
```

`findById` is the exception — it returns `null` on 404 instead of throwing.

## SSR / Isomorphic Usage {#ssr}

The `DbInterface<T>` type is shared between the server-side `AtscriptDbTable` and the client. This enables isomorphic code that works on both sides:

```typescript
import type { DbInterface } from "@atscript/db-client";
import type { User } from "./models/user.as";

async function getActiveUsers(db: DbInterface<typeof User>) {
  return db.findMany({ filter: { active: true } });
}

// Server — pass AtscriptDbTable directly
const users = getActiveUsers(usersTable);

// Browser — pass Client instance
const users = getActiveUsers(new Client<typeof User>("/api/users"));
```

## Re-exported Types

The package re-exports query types from `@uniqu/core` for convenience, so consumers don't need a separate dependency:

- `Uniquery`, `UniqueryControls` — query and control types
- `FilterExpr` — filter expression type
- `AggregateQuery` — aggregation query type
- `TypedWithRelation` — relation loading type

```typescript
import type { FilterExpr, Uniquery } from "@atscript/db-client";
```
