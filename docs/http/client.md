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
  "preferredId": ["id"],
  "relations": [{ "name": "posts", "direction": "from", "isArray": true }],
  "fields": {
    "id": { "sortable": true, "filterable": true },
    "name": { "sortable": false, "filterable": true }
  },
  "type": { "...": "serialized Atscript type schema" },
  "actions": [
    {
      "name": "ship",
      "label": "Ship",
      "level": "row",
      "processor": "backend",
      "value": "/orders/actions/ship",
      "intent": "primary",
      "disabled": "(orders) => orders.map((o) => o.status !== \"processing\")"
    }
  ],
  "crud": {
    "query": [
      "filter",
      "insights",
      "skip",
      "limit",
      "count",
      "sort",
      "select",
      "search",
      "index",
      "vector",
      "threshold",
      "with",
      "groupBy",
      "actions"
    ],
    "pages": [
      "filter",
      "page",
      "size",
      "sort",
      "select",
      "search",
      "index",
      "vector",
      "threshold",
      "with",
      "actions"
    ],
    "one": ["select", "with", "actions"],
    "insert": [],
    "update": [],
    "replace": [],
    "remove": []
  }
}
```

| Field              | Description                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `searchable`       | Table has fulltext search indexes                                                                                                                                                                                                                                                                                              |
| `vectorSearchable` | Table has vector search indexes                                                                                                                                                                                                                                                                                                |
| `searchIndexes`    | Available search index definitions                                                                                                                                                                                                                                                                                             |
| `primaryKeys`      | Primary key field names                                                                                                                                                                                                                                                                                                        |
| `preferredId`      | Logical field names of the table's preferred identifier (PK or a `@db.index.unique` group via `@db.table.preferredId.uniqueIndex`). Always populated; defaults to `primaryKeys`. Used for navigate `$1` substitution and as a guaranteed read-response baseline (see [Read-response baseline](./crud#read-response-baseline)). |
| `relations`        | Available navigation properties                                                                                                                                                                                                                                                                                                |
| `fields`           | Per-field capability flags (sortable, filterable)                                                                                                                                                                                                                                                                              |
| `type`             | Full serialized Atscript type definition                                                                                                                                                                                                                                                                                       |
| `actions`          | Declared domain actions — see [Actions](./actions) for the wire shape and how UIs consume the `processor` / `value` / `level` fields                                                                                                                                                                                           |
| `crud`             | Built-in CRUD permissions — see [Permissions](./permissions). Key absent = denied; value is the accepted UniQuery control whitelist (`[]` for write ops).                                                                                                                                                                      |

> **Read-only check:** consumers derive the boolean from `crud` inline:
> `!('insert' in meta.crud) && !('update' in meta.crud) && !('replace' in meta.crud) && !('remove' in meta.crud)`.

## Actions {#actions}

`action<R>()` invokes any [declared action](./actions) on the controller by name. The client reads `/meta` (cached), looks up the action descriptor, then dispatches based on `processor`.

The identifier is **object-only** — single object for `'row'` actions, array of objects for `'rows'` actions, omitted for `'table'` actions. Even single-field PK tables send `{ id: "abc" }`, never bare `"abc"`. See [Actions — Identifier shape](./actions#identifier-shape) for the full server-side contract.

```typescript
// processor: 'backend', level: 'row' — POST identifier object as JSON body
const result = await users.action("block", { id: "abc123" });
// → { message: "User abc123 blocked" }

// level: 'rows' — pass an array of identifier objects
await users.action("lock", [{ id: "a" }, { id: "b" }]);

// composite PK
await members.action("promote", { tenantId: "acme", userId: "u1" });

// unique-index addressing (same controller, different identification)
await users.action("promote", { email: "jane@example.com" });

// level: 'table' — no identifier
await users.action("refresh-cache");

// processor: 'navigate' — substitutes $1 with preferredId and navigates
await users.action("edit", { slug: "alpha" }); // → /users/alpha/edit

// Typed return shape
const r = await users.action<{ message: string }>("block", { id: "abc" });
r.message; // typed
```

The `<R>` return-type generic asserts the server handler's response shape (commonly `{ message?: string, ... }` per convention). Default `R = unknown`.

`action()` is always POST for `processor: 'backend'`. The path comes from the meta builder — method-decorator actions resolve to the bound HTTP path; class-level backend actions use the dev-supplied path verbatim.

### Client-side validation

The client refuses obviously-wrong shapes BEFORE the network round-trip:

- `'row'` level + non-object (scalar, `null`, array) → `TypeError`.
- `'rows'` level + non-array (single object included — no auto-wrap) → `TypeError`.

The TypeScript signature catches the same cases at compile time when `Client<typeof T>` is used; untyped `Client<>` clients fall back to `Partial<Record<string, unknown>>` and get only the runtime guard.

When the server's [disabled gate](./actions#server-side-gate) rejects, `action()` throws `ActionDisabledError` (HTTP 409) — see [Error cases](#error-cases) below.

### Navigate dispatch

By default, navigate actions call `window.location.assign(url)`. Inject a SPA router via the `navigate` option:

```typescript
import { useRouter } from "vue-router";
const router = useRouter();

const users = new Client<typeof User>("/api/users", {
  navigate: (url) => router.push(url),
});

await users.action("edit", { slug: "alpha" }); // → router.push('/users/alpha/edit')
```

For `'row'`-level navigate, the client substitutes `$1` by walking `meta.preferredId` declaration order — NOT object-key insertion order. Each value is `encodeURIComponent`'d, compound preferred-ids are joined with `/`. Missing fields render as empty segments (e.g. `acme//jane`), not the literal `"undefined"`.

```typescript
// preferredId = ['tenantId', 'userId']
await users.action("edit", { userId: "jane", tenantId: "acme/co" });
// → navigate('/members/acme%2Fco/jane/edit') — order from preferredId, not object keys
```

For `level: 'rows'` and `level: 'table'` navigate actions, `value` is used verbatim — no `$1` substitution.

### Identifier rendering helpers {#identifier-helpers}

The same identifier-to-string logic the client uses internally for `$1` substitution is exported as standalone helpers. Reach for these when you need to render a row identifier outside `Client.action()` — prompt text in a confirm dialog, log lines, deep-link copy, audit messages.

```typescript
import { formatIdentifier, encodeNavigateId, formatIdentifierField } from "@atscript/db-client";

// Raw form (no URL encoding) — for prompt text, error messages, logs.
formatIdentifier({ tenantId: "acme/co", userId: "jane" }, ["tenantId", "userId"]);
// → "acme/co/jane"

// URL-encoded form — same logic Client.action() applies for navigate $1.
encodeNavigateId({ tenantId: "acme/co", userId: "jane" }, ["tenantId", "userId"]);
// → "acme%2Fco/jane"

// Single-value coercion (null / undefined → "", primitives via String,
// objects/arrays via JSON.stringify).
formatIdentifierField(undefined); // ""
formatIdentifierField(123n); // "123"
formatIdentifierField({ a: 1 }); // '{"a":1}'
```

| Helper                  | Encoding   | Use for                                                                |
| ----------------------- | ---------- | ---------------------------------------------------------------------- |
| `formatIdentifier`      | none       | Prompt text, error messages, log lines, dialog titles                  |
| `encodeNavigateId`      | URL-encode | Navigate-URL templates (only when building deep links outside actions) |
| `formatIdentifierField` | none       | Single-value coercion with `null`/`undefined` → `""` semantics         |

### Error cases {#error-cases}

```typescript
import {
  ActionNotFoundError,
  ActionUnsupportedError,
  ActionDisabledError,
  ClientError,
} from "@atscript/db-client";

try {
  await users.action("ship", { id: "abc" });
} catch (e) {
  if (e instanceof ActionNotFoundError) {
    /* action name not in /meta */
  }
  if (e instanceof ActionUnsupportedError) {
    /* processor: 'custom' (handle the event yourself), or
       processor: 'navigate' with no browser env and no navigate option */
  }
  if (e instanceof ActionDisabledError) {
    /* HTTP 409 — server-side disabled gate rejected the row(s).
       Typed accessors layered on top of ClientError: */
    e.action; // "ship"
    e.id; // { id: "abc" }  (row-level rejection — submitted identifier object)
    e.ids; // [...]          (rows-level rejection — full list of failing identifier objects)
  } else if (e instanceof ClientError) {
    /* any other server non-2xx — same shape as other endpoints */
  }
}
```

`ActionDisabledError extends ClientError`, so a generic `instanceof ClientError` catch still handles gate rejections — use the typed branch when you want `e.action` / `e.id` / `e.ids` without indexing into `body`. See [Actions — Server-side Gate](./actions#server-side-gate) for the server-side declaration.

`processor: 'custom'` actions cannot be invoked through the client — those describe UI events your application dispatches itself. The client throws `ActionUnsupportedError` in that case.

### Success response convention

Backend action handlers may return any JSON. Convention: if the response has `{ message: string }`, the UI toasts it; otherwise the UI uses a generic per-level message. See [Actions — Success response](./actions#success-response) for the server side.

```typescript
const result = await users.action<{ message?: string }>("block", { id: "abc" });
if (result?.message) toast(result.message);
else toast("Action completed");
```

## Per-row action availability — `$actions=true` {#dollar-actions}

Add `$actions: true` to any read-method `controls` to ask the server which row/rows-level actions each returned row qualifies for. The server runs every row/rows-level `disabled` predicate against the result set and attaches `$actions: string[]` (action names that did NOT reject the row) to each row.

```typescript
const r = await users.query({
  filter: { active: true },
  controls: { $actions: true } as const,
});
r[0].$actions; // string[] | undefined  (typed via ClientResponse<T, Q>)

// Pages and one() too
const page = await users.pages({ controls: { $actions: true } as const }, 1, 25);
page.data[0].$actions;

const single = await users.one({ id: "abc" }, { controls: { $actions: true } as const });
single?.$actions;
```

NOT augmented on `count()` and `aggregate()` — no row shape. `'table'`-level actions never appear in `$actions`. Action ordering follows `/meta.actions[]` declaration order.

See [Actions — `$actions=true`](./actions#actions-augmentation) for the full server-side pipeline (overlay filtering, `requiredFields`-driven projection widening, length-mismatch handling).

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

| Method        | HTTP   | Endpoint                 | Returns                                                 |
| ------------- | ------ | ------------------------ | ------------------------------------------------------- |
| `query()`     | GET    | `/query`                 | `DataOf<T>[]`                                           |
| `count()`     | GET    | `/query` (`$count`)      | `number`                                                |
| `aggregate()` | GET    | `/query` (`$groupBy`)    | `AggregateResult[]`                                     |
| `pages()`     | GET    | `/pages`                 | `PageResult<DataOf<T>>`                                 |
| `one()`       | GET    | `/one/:id` or `/one?k=v` | `DataOf<T> \| null`                                     |
| `insert()`    | POST   | `/`                      | `TDbInsertResult` or `TDbInsertManyResult`              |
| `update()`    | PATCH  | `/`                      | `TDbUpdateResult`                                       |
| `replace()`   | PUT    | `/`                      | `TDbUpdateResult`                                       |
| `remove()`    | DELETE | `/:id` or `/?k=v`        | `TDbDeleteResult`                                       |
| `meta()`      | GET    | `/meta`                  | `MetaResponse`                                          |
| `action()`    | POST   | _resolved from `/meta`_  | `unknown` (server response, or `void` for `'navigate'`) |
