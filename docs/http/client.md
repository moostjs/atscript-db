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

| Option     | Type                                                                | Description                                                                             |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `baseUrl`  | `string`                                                            | Prepended to the path for every request                                                 |
| `headers`  | `Record<string, string>` or `() => Promise<Record<string, string>>` | Default headers for every request — factory is called **before each request**           |
| `fetch`    | `typeof fetch`                                                      | Custom fetch implementation                                                             |
| `navigate` | `(url: string) => void \| Promise<void>`                            | SPA-router hook for `processor: 'navigate'` actions (see [Navigate dispatch](#actions)) |

### SSR and auth — async headers factory {#ssr-auth}

The `headers` option accepts an **async factory** that the client awaits on every request — ideal for token refresh, SSR cookie forwarding, and Authorization rotation.

**Per-request token refresh:**

```typescript
import { Client } from "@atscript/db-client";

const users = new Client<typeof User>("/api/users", {
  headers: async () => {
    const token = await getAccessToken(); // your refresh logic
    return { Authorization: `Bearer ${token}` };
  },
});
```

`getAccessToken()` runs on every method call (`query`, `insert`, `action`, ...) — keep it cheap or memoize internally. The client never caches the resolved headers.

**SSR cookie forwarding** — on the server, forward the incoming request's cookies to the moost-db endpoint so authenticated session reuse works in-process:

```typescript
import { Client } from "@atscript/db-client";

function makeServerClient(req: { headers: { cookie?: string } }) {
  return new Client<typeof User>("/api/users", {
    headers: async () => ({
      cookie: req.headers.cookie ?? "",
    }),
  });
}
```

Moost's `fetch` automatically routes local requests to handlers in-process — the same `Client` instance works on both server and browser; only the `headers` factory needs to change.

**Refreshing on 401** — the client does not implement automatic retry; wrap with a thin helper:

```typescript
async function withRefresh<R>(call: () => Promise<R>): Promise<R> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof ClientError && e.status === 401) {
      await refreshAccessToken(); // your refresh implementation
      return call(); // headers factory re-runs and picks up the new token
    }
    throw e;
  }
}

const rows = await withRefresh(() => users.query({ filter: { active: true } }));
```

Because `headers` is awaited on every call, the retried request automatically picks up the new token — no need to recreate the `Client`.

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

Filters may select rows by their related rows with [`$some` / `$none`](/api/queries#relational-filters) (since 0.1.147). The client sends them as [URL predicates](./query-syntax#relational-predicates); the relation must be [`@db.rel.filterable`](/relations/navigation#db-rel-filterable) on the server:

```typescript
const open = await issues.query({
  filter: { ticket: { $some: { status: "open" } } },
});
const orphans = await issues.count({ filter: { ticket: { $none: {} } } });
```

The filter type accepts a predicate on navigation keys only — `{ title: { $some: {} } }` and unknown keys are compile errors; the operand itself is not typed field by field. `query`, `count`, `pages` and the geo methods all take it. `meta().relations[i].filterable` is `true` on the relations that accept one.

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

When `$groupBy` fields and `$select` are typed, the result type is inferred — `stats[0].total` is `number`, `stats[0].status` preserves the original field type. A `$groupBy` entry that is neither a field nor a bucket alias from `$select` is a type error (`ValidGroupBy`).

[Calendar buckets](/api/calendar-buckets) go in `$select` in object form; the client serializes them to `bucket(…)` (since 0.1.132):

```typescript
import { nextBucketLabel } from "@atscript/db-client";

const weekly = await tickets.aggregate({
  filter: { openedAt: { $gte: from } },
  controls: {
    $select: [
      { $bucket: "week", $field: "openedAt", $tz: "Europe/Berlin", $as: "week" },
      { $fn: "count", $field: "*", $as: "n" },
    ],
    $groupBy: ["week"],
    $sort: { week: 1 },
  },
});
weekly[0].week; // string — "YYYY-MM-DD" (string | null when openedAt is optional)
```

`nextBucketLabel(label, unit, weekStart?)` and `bucketStartInstant(label, tz)` are re-exported for filling empty buckets and placing labels on a time axis (for `hour` buckets pass the zone: `nextBucketLabel(label, "hour", { tz })`, type `NextBucketOptions`) — see [Filling gaps](/api/calendar-buckets#filling-gaps). Check `meta.bucketUnits` and `meta.fields[path].bucketable` before offering time grouping in a UI.

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

`GET /one/:id` (scalar) or `GET /one?key=val` (object) — fetch by any registered identification: primary key, single-field unique index, or compound unique index. Returns `null` on 404. See [CRUD — GET /one](./crud#get-one).

```typescript
// Scalar — resolves through every identification (PK + every unique index).
// When the table declares an explicit `@db.table.preferredId.uniqueIndex`,
// the scalar lookup is restricted to that field for determinism.
const user = await users.one("abc-123");

// Object — recommended for non-PK lookups; deterministic (avoids any ambiguity
// when the same scalar could match multiple unique fields). The client routes
// any object id to the named-form `/one?key=val` endpoint.
const userByName = await users.one({ username: "admin" });
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

Payloads are typed as `PatchOf<T>` — every key optional, optional columns also accept `null` (explicit NULL). On a versioned table the `version` column is server-managed: leave it out (preflight accepts its absence since 0.1.128) — a value passes through and is stored as sent. `$cas` is rejected on insert with a `ClientValidationError` at path `$cas`.

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

For tables with `@db.column.version`, round-trip the `version` field — the server auto-lifts it to `$cas` and returns `409` on conflict. See [OCC over HTTP](./crud#occ-over-http) and the [versioning guide](/api/versioning).

```typescript
import { VersionMismatchError, ClientError } from "@atscript/db-client";

const row = await users.one("abc");

try {
  await users.update({ id: "abc", name: "Updated", version: row.version });
} catch (err) {
  if (err instanceof VersionMismatchError) {
    // Row moved on; re-read and retry. err.currentVersion is the new version.
  } else if (err instanceof ClientError && err.status === 404) {
    // Row was deleted.
  } else {
    throw err;
  }
}
```

The client throws `VersionMismatchError` (a `ClientError` subclass) automatically whenever the server response carries `kind: "version_mismatch"` — `instanceof` is the recommended discriminator since `@atscript/db-client` 0.1.84. On older versions, inspect `err.body?.kind === "version_mismatch"` and `err.body.currentVersion` directly.

Since 0.1.128 the SDK shape works too: `users.update({ id, $cas: { version: row.version } })` is lifted to the wire `version` field before preflight and sending, so code shared with the server SDK needs no rewrite. The lift is validated with the same rules as the server (`ClientValidationError` before any request is sent):

| Payload                                                 | Result                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `{ id, $cas: { version: 4 } }`                          | sent as `{ id, version: 4 }`                                           |
| `{ id, version: 4, $cas: { version: 3 } }`              | `ClientValidationError` at `$cas` (`Ambiguous version: … differ`)      |
| `{ id, $cas: { version: 4 } }` on a non-versioned table | `ClientValidationError` at `$cas` (no `@db.column.version`)            |
| `{ id, $cas: { v: 4 } }` / non-integer value            | `ClientValidationError` at `$cas.v` / `$cas.version` (shared messages) |
| array bodies                                            | per item; paths are prefixed `[i].`                                    |

A PK-only `update({ id, version })` (or `$cas`) is a real write — the server bumps the version on a hit. See [OCC over HTTP](./crud#occ-over-http).

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

`replace` accepts the same `version` round-trip as `update` — same 409 behavior, same `$cas` semantics (and the same `$cas` lift). Catch conflicts with `instanceof VersionMismatchError` exactly as shown above. Payloads are typed as `RowOf<T>`: required columns stay required, optional ones also accept `null`; the version column itself is optional in replace preflight.

### remove {#remove}

`DELETE /:id` — remove by primary key. See [CRUD — DELETE](./crud#delete).

```typescript
// Scalar PK
const { deletedCount } = await users.remove("abc");

// Composite PK
await users.remove({ tenantId: "t1", userId: "u1" });
```

## Metadata {#meta}

`GET /meta` — fetch table/view metadata. The result is cached after the first call; `action()`, `getActionForm()` and write validation reuse it.

```typescript
const meta = await users.meta();
```

The payload is documented field by field in [CRUD Endpoints — GET /meta](./crud#get-meta). To tell whether the table is read-only, derive it from `meta.crud` — see [Permissions — Read-only check](./permissions#read-only-check).

## Actions {#actions}

`action<R>()` invokes any [declared action](./actions) on the controller by name. The client reads `/meta` (cached), looks up the action descriptor, then dispatches based on `processor`.

```typescript
client.action<R>(name: string, id?: ..., input?: unknown): Promise<R>
```

The identifier is **object-only** — single object for `'row'` actions, array of objects for `'rows'` actions, omitted for `'table'` actions. Even single-field PK tables send `{ id: "abc" }`, never bare `"abc"`. The third `input` argument carries the action's `@InputForm` payload — see [Form input](./actions#input-form). The wire body is the envelope `{ ids?, input? }`; the client wraps your call's args into it.

```typescript
// processor: 'backend', level: 'row' — POST { "ids": { "id": "abc123" } }
const result = await users.action("block", { id: "abc123" });
// → { message: "User abc123 blocked" }

// level: 'rows' — pass an array of identifier objects
await users.action("lock", [{ id: "a" }, { id: "b" }]);

// composite PK
await members.action("promote", { tenantId: "acme", userId: "u1" });

// unique-index addressing (same controller, different identification)
await users.action("promote", { email: "jane@example.com" });

// level: 'table' — no identifier, no input → no body sent
await users.action("refresh-cache");

// processor: 'navigate' — substitutes $1 with preferredId and navigates
await users.action("edit", { slug: "alpha" }); // → /users/alpha/edit

// @InputForm payload (third arg) — POST { "ids": ..., "input": ... }
await users.action("approve", { id: "o1" }, { note: "looks good" });

// Table-level + @InputForm (no id) — POST { "input": ... }
await users.action("broadcast", undefined, { message: "hi" });

// Typed return shape
const r = await users.action<{ message: string }>("block", { id: "abc" });
r.message; // typed
```

The `<R>` return-type generic asserts the server handler's response shape (commonly `{ message?: string, ... }` per convention). Default `R = unknown`.

`action()` is always POST for `processor: 'backend'`. The path comes from the meta builder — method-decorator actions resolve to the bound HTTP path; class-level backend actions use the dev-supplied path verbatim.

### Form-schema discovery — `getActionForm()` {#get-action-form}

When an action declares [`@InputForm()`](./actions#input-form), `/meta` carries an `inputForm` field with the form's name. `getActionForm(name)` lazily fetches the schema from `GET <controller>/meta/form/<inputForm>`, deserializes it via `deserializeAnnotatedType`, and returns the `TAtscriptAnnotatedType` ready to hand to a form renderer.

```typescript
const meta = await users.meta();
const action = meta.actions.find((a) => a.name === "approve");

if (action?.inputForm) {
  const form = await users.getActionForm("approve");
  // → TAtscriptAnnotatedType, ready for @atscript/ui form components
  // Render the form, collect input, then:
  await users.action("approve", { id: "o1" }, collectedInput);
}
```

When the action also carries `formUrl` (a [class-level form served by another controller](./actions#class-level-input-form)), the schema is fetched from `baseUrl + formUrl` instead.

Returns `null` when the action has no `inputForm`, or the action name isn't on `/meta`. Cached per resolved URL on the client instance — repeated calls for the same form make only one HTTP request. Failed fetches are evicted from the cache so retries can re-fetch.

### Available actions for one row — `availableActions()` {#available-actions}

Since 0.1.145. `availableActions(id)` asks the server which row-level actions the caller may run on one row right now, including rows the caller cannot read. It calls [`GET /meta/actions/:id`](./actions#available-actions); an object id uses the composite form `?k1=v1&k2=v2`. Id forms are the same as [`one()`](#one):

```typescript
const { actions, disabledReasons } = await orders.availableActions("o2");
// actions: ["edit"]; disabledReasons: { ship: "Order already shipped" }
```

An unknown id and an id the caller may not act on both resolve to `{ actions: [] }`. Use it for a detail view opened from a link or a notification. On lists, [`$actions`](./actions#actions-augmentation) gives the same answer per row, as part of the read.

### Delegated actions — `idMap` {#delegated-actions}

Since 0.1.147. An action listed by a view with [`@DbActionsFrom`](./view-actions) carries `owner` (the controller that runs it) and, when the ids are renamed, `idMap`. Pass the view's rows as usual — `action()` maps each one to the owner's identification (`{ [ownerField]: row[path] }`) before POSTing to `value`, and navigate `$1` uses the mapped id in `idMap` key order. A dot path reads a nested value (`{ org: { id } }`) or a flat key spelled like the path (`{ "org.id": … }`, checked first). A row missing a mapped path throws `TypeError` naming the action and the path.

```typescript
const board = new Client<typeof IssueBoard>("/api/issue-board");
const rows = await board.query({ controls: { $actions: true } as const });
await board.action("close", [rows[0], rows[1]]); // POST /api/issues/actions/close { ids: [{ id: … }, …] }
```

`actionIdentifier(action, rowOrId, preferredId)` is the same mapping as a standalone export (with no `idMap` it picks the `preferredId` fields) — use it when a UI builds `ids` itself. [`availableActions(id)`](#available-actions) on the view answers delegated actions only when the source id is the view id renamed; otherwise ask the `owner`.

### Query targets — `actionOnQuery()` / `countActionTarget()` {#query-targets}

Since 0.1.147. Run a `'rows'` action whose `/meta` entry carries `queryTarget` on every row matching a query (see [Query targets](./query-targets)):

```typescript
const target = { filter: { teamId: "a" }, search: "login", exclude: [{ id: 7 }] };
const { matched } = await issues.countActionTarget("close", target); // dry run
const summary = await issues.actionOnQuery("close", { ...target, expectCount: matched });
// → { matched, processed, skipped: [{ id, reason? }], failed: [{ id, reason }], aborted?, messages?, message? }
```

- The target is `{ filter?, search?, index?, exclude?, expectCount?, maxRows? }` (`TDbQueryTarget<T>`); the client sends `{ query: { q, … }, input? }` with `q` built from `filter` / `search` / `index`.
- The request goes to `queryTarget.url` when present (a delegated action: the view's route), else to `value`.
- An action without `queryTarget` throws `ActionUnsupportedError` before any request.
- Server refusals throw `ActionTargetError` with `code` (`TARGET_INVALID`, `TARGET_TOO_LARGE`, `TARGET_CHANGED`), `cap` and `matched`. On `TARGET_CHANGED`, re-confirm with the new `matched` and retry.
- The return type defaults to `TDbActionTargetSummary`; pass a type argument when the handler returns something else.
- A run that stopped part-way answers normally (no throw) with `aborted: { status, message }`; the batches before it stayed applied and `failed` lists the rest. Show it as a partial result, not a success.
- A delegated run passes on the source handler's `message`: `messages` per batch, `message` the distinct ones joined by newlines.

### Client-side validation

The client refuses obviously-wrong shapes BEFORE the network round-trip:

- `'row'` level + non-object (scalar, `null`, array) for `id` → `TypeError`.
- `'rows'` level + non-array (single object included — no auto-wrap) for `id` → `TypeError`.
- `input` is `unknown` at the type level — the client does **not** validate it. The caller's responsibility is to match the action's `inputForm` schema; server-side validation depends on a Moost atscript validator pipe being installed (see [Actions — Validation](./actions#input-form)).

The TypeScript signature catches the `id`-shape cases at compile time when `Client<typeof T>` is used; untyped `Client<>` clients fall back to `Partial<Record<string, unknown>>` and get only the runtime guard.

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
    e.reason; // "Order already shipped" — shared reason, when the predicate returned one
    e.reasons; // ["Locked", null]      — rows-level, aligned with e.ids (null = no reason)
  } else if (e instanceof ClientError) {
    /* any other server non-2xx — same shape as other endpoints */
  }
}
```

`ActionDisabledError extends ClientError`, so a generic `instanceof ClientError` catch still handles gate rejections — use the typed branch when you want `e.action` / `e.id` / `e.ids` / `e.reason` / `e.reasons` without indexing into `body`. When the server's predicate returned a [reason](./actions#disabled-reasons), `e.message` is already that reason — show it as is. See [Actions — Server-side Gate](./actions#server-side-gate) for the server-side declaration.

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

// Actions disabled WITH a reason (predicate returned a string) — action name → reason
r[0].$disabledReasons?.ship; // Record<string, string> | undefined
```

`$disabledReasons` is present only on rows where some action was disabled with a reason; its keys never appear in `$actions`. See [Actions — `$disabledReasons`](./actions#disabled-reasons-augmentation).

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

When the error response is not JSON (a proxy or gateway page), `e.body` is `{ message, statusCode }` with `message` = the HTTP status text, or `HTTP <status>` when the response carries none (HTTP/2 has no status text) — `e.body.message` is never empty.

### `TransportError` — no server verdict {#transport-error}

A `ClientError` means the server **answered and rejected**. A `TransportError` (since 0.1.129) means there is **no verdict at all**: `fetch` itself rejected (network down, DNS, CORS, an `AbortError` from an `AbortSignal`), or a 2xx response carried a body that is not JSON. The request may or may not have reached the server, so **a write may have committed** — reload the row before retrying a non-idempotent write instead of blindly re-sending it.

```typescript
import { Client, ClientError, TransportError } from "@atscript/db-client";

try {
  await users.update({ id: 7, status: "active", version: 3 });
} catch (e) {
  if (e instanceof ClientError) {
    // the server rejected — e.status / e.errors are authoritative
  } else if (e instanceof TransportError) {
    e.method; // "PATCH"
    e.url; // full request URL
    e.cause; // the original error (e.g. cause.name === "AbortError")
    // unknown outcome: re-read the row, then decide whether to retry
    const current = await users.one(7);
    if (current?.version === 3) await users.update({ id: 7, status: "active", version: 3 });
  }
}
```

`TransportError` does not extend `ClientError`; it exposes `method`, `url` and the standard `cause`.

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

Server-managed fields follow the server's rules, read from the annotations the [`/meta` type](./crud#get-meta) keeps: insert and replace accept a missing `@db.default*`, `@db.rel.FK` or `@db.column.version` field (since 0.1.128) and a missing [derived column](/api/storage#derived-columns) (since 0.1.142), and `$inc` / `$dec` / `$mul` on a derived column is a `ClientValidationError` before any request is sent (since 0.1.142).

```typescript
// customerId / amount are @db.column.derived (required in the type)
await orders.insert({ id: 1, status: "open", payload: { customer: { id: "c1" }, total: 3 } }); // ok
await orders.update({ id: 1, amount: { $inc: 1 } }); // ClientValidationError at "amount"
```

Patch preflight is **merge-aware** (since 0.1.124), mirroring the server's update validation exactly: a nested [`@db.patch.strategy 'merge'`](../api/update-patch#embedded-object-patches) block validates as a deep partial — absent required keys (e.g. server-stamped fields) pass, present keys are still type-checked — while non-merge nested objects keep full validation, since they are `$set` as a whole. Insert and replace always validate the full shape.

### Lenient writes (projected metas) {#lenient-writes}

When the served `/meta` type is a **projection** of the full server-side type (e.g. an ARBAC read overlay strips fields the caller may write but not read), strict preflight rejects legitimate writes carrying those fields. Opt into tolerance for _unknown_ properties on writes — required fields and formats stay enforced, and the server remains authoritative:

```typescript
const users = new Client<typeof User>("/api/users", { lenientWrites: true });
// or standalone:
const validator = createClientValidator(meta, { lenientWrites: true });
```

Leave it off elsewhere — strict preflight catches typos. Note that servers on `@aooth/arbac-moost` ≥ 0.1.57 stamp write-granted fields into the served type as [`writeOnly`](./crud#write-only) instead of stripping them, which removes the need for this flag in most setups.

## Re-exports

### Query types (from `@uniqu/core`)

- `Uniquery`, `UniqueryControls` — query and control types
- `FilterExpr` — filter expression type
- `AggregateQuery`, `AggregateResult` — aggregation types
- `BucketExpr`, `BucketUnit`, `WeekStart`, `CalendarBucketLabel` — calendar-bucket entry and label types (since 0.1.132)
- `ValidGroupBy` — the `$groupBy` check `aggregate()` applies (since 0.1.132)
- `TypedWithRelation` — relation loading type

```typescript
import type { FilterExpr, Uniquery } from "@atscript/db-client";
```

### Calendar-bucket helpers (from `@uniqu/core`, since 0.1.132)

- `nextBucketLabel(label, unit, weekStart?)` — the label of the following bucket; calendar arithmetic, no time zone
- `bucketStartInstant(label, tz)` — the first instant (epoch ms) of a label's local date in `tz`

See [Calendar Buckets — Filling gaps](/api/calendar-buckets#filling-gaps).

### Wire / shape types (from `@atscript/db`)

- `TDbActionInfo`, `TDbActionLevel`, `TDbActionIntent`, `TDbActionProcessor` — `/meta.actions[]` entry shape
- `TDbAvailableActions` — [`availableActions()`](#available-actions) response (since 0.1.145)
- `TDbActionTargetSummary` — [`actionOnQuery()`](#query-targets) result of a summary-returning handler (since 0.1.147)
- `TDbQueryTarget<T>` — the [`actionOnQuery()`](#query-targets) target (since 0.1.147)
- `TCrudOp`, `TCrudPermissions` — `/meta.crud` shape (see [Permissions](./permissions))
- `TDbInsertResult`, `TDbInsertManyResult`, `TDbUpdateResult`, `TDbDeleteResult` — write-method return shapes

### Identifier helpers

Standalone exports of the same logic used internally for navigate `$1` substitution — handy when rendering identifiers outside `Client.action()`:

- `formatIdentifier(id, preferredId)` — raw `/`-joined identifier (no URL encoding)
- `encodeNavigateId(id, preferredId)` — URL-encoded `/`-joined identifier
- `formatIdentifierField(value)` — single-value coercion (`null` / `undefined` → `""`)
- `actionIdentifier(action, rowOrId, preferredId)` — the ids an action takes for a row, through a [delegated action's `idMap`](#delegated-actions) (since 0.1.147)

See [Identifier rendering helpers](#identifier-helpers) for usage.

### Errors

All error classes — generic and action-specific — are exported as runtime values for `instanceof` discrimination:

- `ClientError` — base class for every non-2xx response. `status`, `body`, `errors` accessors.
- `ActionDisabledError extends ClientError` — HTTP 409 from the server-side action gate. Typed `action`, `id`, `ids`, `reason`, `reasons` accessors.
- `ActionTargetError extends ClientError` — a refused [query target](#query-targets) (400 / 409). Typed `code`, `action`, `matched`, `cap` accessors (since 0.1.147).
- `TransportError` — no server verdict: `fetch` rejected, or a 2xx body was not JSON. `method`, `url`, `cause`. Does **not** extend `ClientError`. See [TransportError](#transport-error).
- `ActionNotFoundError` — `Client.action(name)` called with a name not present in `/meta`.
- `ActionUnsupportedError` — `processor: 'custom'`, or `processor: 'navigate'` with no browser env and no `navigate` option; also `actionOnQuery()` on an action without `queryTarget`.
- `ClientValidationError` (type) — thrown by client-side validation on `insert` / `update` / `replace` before sending. Type export — the runtime class lives in `@atscript/db-client/validator`.

```typescript
import {
  ClientError,
  TransportError,
  ActionDisabledError,
  ActionNotFoundError,
  ActionUnsupportedError,
} from "@atscript/db-client";
import type { ClientValidationError } from "@atscript/db-client";
```

### Action error body shape

`ActionDisabledError.body` matches this wire envelope (HTTP 409):

```ts
{
  name: "ActionDisabledError";
  statusCode: 409;
  message: string;
  action: string;                          // action name that rejected
  id?: Record<string, unknown>;            // 'row'-level rejections
  ids?: Record<string, unknown>[];         // 'rows'-level rejections
  reason?: string;                         // reason shared by every rejected row (since 0.1.141)
  reasons?: (string | null)[];             // 'rows'-level, aligned with ids (since 0.1.141)
}
```

## Method ↔ Endpoint Reference

| Method                | HTTP   | Endpoint                               | Returns                                                 |
| --------------------- | ------ | -------------------------------------- | ------------------------------------------------------- |
| `query()`             | GET    | `/query`                               | `DataOf<T>[]`                                           |
| `count()`             | GET    | `/query` (`$count`)                    | `number`                                                |
| `aggregate()`         | GET    | `/query` (`$groupBy`)                  | `AggregateResult[]`                                     |
| `pages()`             | GET    | `/pages`                               | `PageResult<DataOf<T>>`                                 |
| `one()`               | GET    | `/one/:id` or `/one?k=v`               | `DataOf<T> \| null`                                     |
| `insert()`            | POST   | `/`                                    | `TDbInsertResult` or `TDbInsertManyResult`              |
| `update()`            | PATCH  | `/`                                    | `TDbUpdateResult`                                       |
| `replace()`           | PUT    | `/`                                    | `TDbUpdateResult`                                       |
| `remove()`            | DELETE | `/:id` or `/?k=v`                      | `TDbDeleteResult`                                       |
| `meta()`              | GET    | `/meta`                                | `MetaResponse`                                          |
| `getActionForm()`     | GET    | `/meta/form/:name` or `formUrl`        | `TAtscriptAnnotatedType \| null`                        |
| `getValidator()`      | —      | _client-side; uses `/meta`_            | `ClientValidator` (lazy, cached)                        |
| `action()`            | POST   | _resolved from `/meta`_                | `unknown` (server response, or `void` for `'navigate'`) |
| `actionOnQuery()`     | POST   | `queryTarget.url` or `value`           | `TDbActionTargetSummary` (or the handler's response)    |
| `countActionTarget()` | POST   | `queryTarget.url` or `value` (dry run) | `{ matched: number }`                                   |
