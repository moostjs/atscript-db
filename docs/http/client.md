---
outline: deep
---

# HTTP Client

`@atscript/db-client` is an HTTP client that maps 1:1 to moost-db controller endpoints. Each method corresponds to a specific HTTP request — `query()` is `GET /query`, `insert()` is `POST /`, and so on. Works in browsers, Node.js, and any runtime with `fetch`.

In SSR environments, Moost's `fetch` automatically routes local requests to handlers in-process, so the same `Client` instance works on both server and browser with zero configuration.

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

When you provide `<typeof User>`, all methods become fully typed:

- **Filters** check field names against the model's own properties
- **`$sort`** keys are constrained to valid field names
- **`$with`** entries are constrained to declared navigation properties
- **Primary key** type flows through `one()` and `remove()`
- **Insert/update data** is checked against the model's field types

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

### query {#query}

`GET /query` — returns all matching records. See [CRUD — GET /query](./crud#get-query).

```typescript
const active = await users.query({
  filter: { status: "active" },
  controls: { $sort: { createdAt: -1 }, $limit: 50 },
});
```

The `$search`, `$vector`, `$index`, and `$threshold` controls are also passed through `query()`:

```typescript
// Text search
const results = await users.query({
  controls: { $search: "alice" },
});

// Vector search
const similar = await posts.query({
  controls: { $vector: "embedding", $search: "machine learning" },
});
```

### count {#count}

`GET /query` with `$count: true` — returns the number of matching records.

```typescript
const total = await users.count({ filter: { role: "admin" } });
```

### aggregate {#aggregate}

`GET /query` with `$groupBy` — typed aggregation. See [Relations & Search — Aggregation](./advanced#groupby).

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

When `$groupBy` fields and `$select` are typed, the result type is inferred — `stats[0].total` is `number`, `stats[0].status` preserves the original field type.

### pages {#pages}

`GET /pages` — page-based pagination. See [CRUD — GET /pages](./crud#get-pages).

```typescript
const page = await users.pages(
  { filter: { active: true } },
  2, // page (default: 1)
  25, // size (default: 10)
);
// → { data: [...], page: 2, itemsPerPage: 25, pages: 10, count: 243 }
```

### one {#one}

`GET /one/:id` — fetch by primary key. Returns `null` on 404. See [CRUD — GET /one](./crud#get-one).

```typescript
// Scalar PK
const user = await users.one("abc-123");

// Composite PK
const row = await users.one({ tenantId: "t1", userId: "u1" });
```

Supports `controls` for projection and relation loading:

```typescript
const user = await users.one("abc", {
  controls: { $select: ["id", "name"], $with: ["posts"] },
});
```

## Relation Loading

Load relations using `$with` in controls. See [Relations & Search](./advanced#with) for full syntax.

```typescript
const orders = await client.query({
  controls: { $with: ["customer", "items"] },
});
```

## Write Operations {#writes}

Write methods are available when the server uses `AsDbController` (not `AsDbReadableController`).

### insert {#insert}

`POST /` — insert one or many records. See [CRUD — POST /](./crud#post-insert).

```typescript
// Single insert → { insertedId }
const { insertedId } = await users.insert({
  name: "Alice",
  email: "alice@example.com",
});

// Batch insert → { insertedCount, insertedIds }
const { insertedCount } = await users.insert([{ name: "Alice" }, { name: "Bob" }]);
```

### update {#update}

`PATCH /` — partial update. Include the primary key and changed fields only. See [CRUD — PATCH /](./crud#patch-update).

```typescript
// Single or bulk → { matchedCount, modifiedCount }
await users.update({ id: "abc", name: "Updated" });

// Bulk
await users.update([
  { id: "a", status: "active" },
  { id: "b", status: "active" },
]);
```

Supports [field operations](/api/update-patch#field-operations) like `$inc`, `$dec`, `$mul`.

### replace {#replace}

`PUT /` — full document replace. All required fields must be present. See [CRUD — PUT /](./crud#put-replace).

```typescript
await users.replace({
  id: "abc",
  name: "Alice",
  email: "new@example.com",
  role: "admin",
});

// Bulk
await users.replace([...]);
```

### remove {#remove}

`DELETE /:id` — remove by primary key. See [CRUD — DELETE](./crud#delete).

```typescript
// Scalar PK
const { deletedCount } = await users.remove("abc");

// Composite PK
await users.remove({ tenantId: "t1", userId: "u1" });
```

## Metadata {#meta}

`GET /meta` — fetch table/view metadata. The result is cached after the first call.

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
  await users.insert({ name: "" });
} catch (e) {
  if (e instanceof ClientError) {
    e.status; // 400
    e.message; // "Validation failed"
    e.errors; // [{ path: "name", message: "required" }]
    e.body; // full server error response
  }
}
```

`one()` is the exception — it returns `null` on 404 instead of throwing.

## Client-Side Validation {#validation}

Write methods (`insert`, `update`, `replace`) automatically validate data client-side against the Atscript type fetched from `/meta`. This catches type errors before they reach the server.

```typescript
// Throws ClientValidationError before sending the request
await users.insert({ name: 123 }); // name must be string
```

Access the validator directly for form generation or custom validation:

```typescript
const validator = await users.getValidator();
validator.flatMap; // Map of field paths → annotated types
validator.navFields; // Set of navigation field names
validator.validate(data, "insert"); // throws on failure
```

## Re-exported Types

The package re-exports query types from `@uniqu/core` for convenience:

- `Uniquery`, `UniqueryControls` — query and control types
- `FilterExpr` — filter expression type
- `AggregateQuery`, `AggregateResult` — aggregation types
- `TypedWithRelation` — relation loading type

```typescript
import type { FilterExpr, Uniquery } from "@atscript/db-client";
```

## Method ↔ Endpoint Reference

| Method        | HTTP   | Endpoint                 | Returns                                    |
| ------------- | ------ | ------------------------ | ------------------------------------------ |
| `query()`     | GET    | `/query`                 | `DataOf<T>[]`                              |
| `count()`     | GET    | `/query` (`$count`)      | `number`                                   |
| `aggregate()` | GET    | `/query` (`$groupBy`)    | `AggregateResult[]`                        |
| `pages()`     | GET    | `/pages`                 | `PageResult<DataOf<T>>`                    |
| `one()`       | GET    | `/one/:id` or `/one?k=v` | `DataOf<T> \| null`                        |
| `insert()`    | POST   | `/`                      | `TDbInsertResult` or `TDbInsertManyResult` |
| `update()`    | PATCH  | `/`                      | `TDbUpdateResult`                          |
| `replace()`   | PUT    | `/`                      | `TDbUpdateResult`                          |
| `remove()`    | DELETE | `/:id` or `/?k=v`        | `TDbDeleteResult`                          |
| `meta()`      | GET    | `/meta`                  | `MetaResponse`                             |
