---
outline: deep
---

# Customization

`AsDbController` and `AsDbReadableController` expose protected hooks that let you extend default behavior without reimplementing endpoints. Override the hooks you need to add access control, data transformation, and business logic.

::: tip Looking for "Block User", "Approve", or "Edit" buttons?
This page is about **intercepting existing CRUD**. For exposing **new domain operations** alongside CRUD — and having them surface in `/meta` so any UI can render row buttons, batch toolbars, and navigation entries generically — see [Actions](./actions).
:::

## Available Hooks

All hooks are protected methods with sensible defaults (pass-through or no-op). Override only the ones you need.

| Hook                                   | Available On   | Called When                      | Purpose                                                           |
| -------------------------------------- | -------------- | -------------------------------- | ----------------------------------------------------------------- |
| `transformFilter(filter)`              | Both           | Before `/query` / `/pages` reads | Modify filters (add tenant, soft-delete)                          |
| `transformOne(filter)`                 | Both           | Before `/one` / `/one/:id` reads | Filter overlay for id-based reads (defaults to `transformFilter`) |
| `transformProjection(projection)`      | Both           | Before every read                | Restrict visible fields                                           |
| `hasField(path)`                       | Both           | Every field a request references | Hide fields per request — answered as `Unknown field`             |
| `validateInsights(insights)`           | Both           | After query parsing              | Field-level access control                                        |
| `computeEmbedding(search, fieldName?)` | Both           | When `$vector` is present        | Convert text to embedding vector                                  |
| `onWrite(action, data)`                | AsDbController | Before insert/replace/update     | Transform or reject write data (untrusted body, outside any tx)   |
| `onRemove(id)`                         | AsDbController | Before delete                    | Allow or prevent deletion                                         |
| `guardWrite(ctx)`                      | AsDbController | Inside the table's tx, validated | Validated-stage checks / enrichment (since 0.1.128)               |
| `guardRemove(ctx)`                     | AsDbController | Inside the table's tx, id known  | Validated-stage delete checks (since 0.1.128)                     |
| `withTransaction(fn)`                  | AsDbController | Called by you                    | One transaction across several table ops in a custom route        |
| `meta()`                               | Both           | On `GET /meta` request           | Enrich the metadata response (cached)                             |
| `applyMetaOverlay(meta)`               | Both           | Per request, after `meta()`      | Per-principal `crud` / `actions` filtering (returns a clone)      |
| `init()`                               | Both           | On controller construction       | One-time setup                                                    |

::: info Deprecated hook
`checkGates(parsed)` still runs after the field capability gate but is deprecated since 0.1.128: the gate derived from `/meta.fields` already rejects every unlisted or non-sortable / non-filterable path before it. Override the read hooks above, or the table-level `guard` options, instead.
:::

## Read Hooks

### transformFilter {#transformfilter}

Receives the parsed filter expression and returns a modified one. Every query passes through this hook, making it ideal for cross-cutting read concerns.

**Multi-tenant filtering:**

```typescript
@TableController(todosTable)
export class TodoController extends AsDbController<typeof Todo> {
  protected transformFilter(filter: FilterExpr): FilterExpr {
    const tenantId = this.getCurrentTenantId();
    return { $and: [filter, { tenantId }] };
  }
}
```

The returned filter replaces the original for all read endpoints (`/query`, `/pages`, `/one/:id`).

**Soft deletes:**

```typescript
protected transformFilter(filter: FilterExpr): FilterExpr {
  return { $and: [filter, { deletedAt: { $exists: false } }] }
}
```

**Async lookups:** the hook may return a `Promise` — useful when the filter additions depend on session, permissions, or a remote lookup.

```typescript
protected async transformFilter(filter: FilterExpr): Promise<FilterExpr> {
  const tenantId = await this.resolveTenantFromSession()
  return { $and: [filter, { tenantId }] }
}
```

### transformOne {#transformone}

Filter overlay applied to `GET /one/:id` and `GET /one?...`. Defaults to calling `transformFilter` so existence is not leaked through id-based reads. Override only when `/one` needs different scoping than `/query` (rare):

```typescript
protected transformOne(filter: FilterExpr): FilterExpr {
  // Allow self-lookup by id without the tenant scope `/query` enforces
  if (this.isCurrentUser()) return filter
  return this.transformFilter(filter)
}
```

If you only need to scope BOTH `/query` and `/one` the same way (the common case), override `transformFilter` alone — `transformOne` will pick it up automatically.

### transformProjection {#transformprojection}

Intercepts the projection before every read. If the client sends `$select`, `projection` contains it; otherwise it is `undefined`. Use this to enforce field exclusions:

```typescript
protected transformProjection(projection?: UniqueryControls['$select']) {
  return projection ?? { password: 0, apiKey: 0, secret: 0 }
}
```

When `projection` is `undefined` (no `$select` from the client), the hook supplies a default exclusion list. When the client does send `$select`, you can merge or override as needed. This hook may also return a `Promise` for async decisions (e.g. per-user field visibility).

### validateInsights {#validateinsights}

Runs after the URL query string is parsed. The `insights` map contains every field referenced in the query — whether in a filter, projection, or sort order. Return a string to reject with HTTP `400`, or `undefined` to allow.

```typescript
const RESTRICTED_FIELDS = new Set(['salary', 'ssn', 'internalNotes'])

protected validateInsights(insights: Map<string, unknown>): string | undefined {
  // Run the default validation first (rejects unknown fields)
  const base = super.validateInsights(insights)
  if (base) return base

  const user = this.getCurrentUser()
  if (!user?.isAdmin) {
    for (const field of insights.keys()) {
      if (RESTRICTED_FIELDS.has(field)) {
        return `Access denied: cannot query field "${field}"`
      }
    }
  }
  return undefined
}
```

This catches every reference to a restricted field — whether in a filter (`salary>=100000`), a projection (`$select=ssn`), or a sort order (`$sort=salary`).

### hasField {#hasfield}

The field-visibility hook. Return `false` for a path the current request must not see, and the server answers exactly as for a field that does not exist — `Unknown field "x"` (or `Unknown relation "x"` in `$with`) — so the reply reveals nothing about the hidden field.

```typescript
protected hasField(path: string): boolean {
  const hidden = useHiddenFields() // e.g. from the caller's read scopes
  return super.hasField(path) && !hidden.has(path.split('.')[0])
}
```

Since 0.1.133 every field reference is checked against it before any capability rule: filter keys (inside `^` / `!( )` groups and `$exists` included), `$sort`, `$select`, `$groupBy`, `$having`, aggregate and calendar-bucket fields, `$with` relation names and sub-query fields, and the `$search` fallback fields. From 0.1.128 to 0.1.132 a hidden **stored column** skipped it, so a filter or sort on it still ran — a value oracle. Upgrade if you hide fields this way.

It only rejects references. Pair it with:

- [`transformProjection`](#transformprojection) to strip the hidden values from rows (a request without `$select` returns every column);
- [`applyMetaOverlay`](./permissions) to prune `/meta`, which is cached and does not consult `hasField`.

Native text search and vector search (`$vector` names an index) run inside the database over their indexes, out of this hook's reach — keep hidden fields out of those indexes.

### computeEmbedding {#computeembedding}

Called when `$vector` is present in query controls. Receives the search text and an optional field name. Must return a `number[]` (the embedding vector).

The default implementation throws HTTP `501 Not Implemented`.

```typescript
@TableController(articlesTable)
export class ArticlesController extends AsDbController<typeof Article> {
  protected async computeEmbedding(search: string, fieldName?: string): Promise<number[]> {
    // Use any embedding provider (OpenAI, Cohere, local model, etc.)
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: search,
    });
    return response.data[0].embedding;
  }
}
```

The `fieldName` parameter identifies which vector field was specified in `$vector`, allowing different embedding models per field if needed.

See [Vector Search in URLs](./advanced#vector-search) for how this hook integrates with the URL parameters.

## Write Hooks

Every built-in write endpoint runs the same pipeline (since 0.1.128):

```
shape gate (400)  →  onWrite / onRemove (untrusted body, outside any transaction)
  →  table op — the table's own transaction:
       validate → guardWrite / guardRemove (only when overridden) → re-validate → write
  →  404 / 409 disambiguation
```

- **Shape gate** — the body must be a plain object (`POST`/`PUT`/`PATCH` with an object) or an array of plain objects (array bodies). `null`, primitives and `[1, "x"]` answer `400` with `errors: [{ path: "" | "[i]", message: "Expected an object" }]` before any hook runs. The gate is applied again to what `onWrite` returns: a hook that returns a non-object (or an object for a `*Many` action) aborts with `500 "Not saved"`, like returning `undefined`.
- **`onWrite` / `onRemove`** keep their contract and run _outside_ any transaction (they coerce untrusted input; on MongoDB a transaction callback may re-run, so hooks with side effects stay out of it).
- **`guardWrite` / `guardRemove`** are the table's [write guards](/api/crud#write-guards): the override is passed as the `guard` option of the table call and runs _inside the table's transaction_, after defaults + validation. Overriding a guard is the switch — unmodified controllers pass no guard and pay nothing: the table is called exactly as before, no second validation.
- **Built-in failures are thrown** as `HttpError` — see [Thrown errors](#thrown-errors).

### onWrite {#onwrite}

Intercepts all write operations before they reach the database. Return the (possibly modified) data to proceed — in the shape received: an object for the single actions, an array of objects for the `*Many` actions — or `undefined` to abort (HTTP `500 "Not saved"`; any other non-conforming return value aborts the same way). Return an `Error` instance (an `HttpError` for a chosen status) to respond with that error — since 0.1.128; it used to be passed on as data — or throw one.

The `action` parameter identifies the operation:

| Action        | Triggered By               |
| ------------- | -------------------------- |
| `insert`      | `POST /` with object body  |
| `insertMany`  | `POST /` with array body   |
| `replace`     | `PUT /` with object body   |
| `replaceMany` | `PUT /` with array body    |
| `update`      | `PATCH /` with object body |
| `updateMany`  | `PATCH /` with array body  |

**Audit fields:**

```typescript
protected onWrite(
  action: 'insert' | 'insertMany' | 'replace' | 'replaceMany' | 'update' | 'updateMany',
  data: unknown
) {
  const record = data as Record<string, unknown>
  if (action === 'insert') {
    return { ...record, createdBy: this.getCurrentUserId() }
  }
  if (action === 'update') {
    return { ...record, updatedBy: this.getCurrentUserId() }
  }
  return data
}
```

**Authorization:**

```typescript
protected onWrite(action: string, data: unknown) {
  if (!this.getCurrentUser()?.canWrite) {
    return undefined  // abort — returns HTTP 500
  }
  return data
}
```

`onWrite` may also be `async` — every call site already awaits the result:

```typescript
protected async onWrite(action: string, data: unknown) {
  const approved = await this.approveWithAuditService(action, data)
  return approved ? data : undefined
}
```

### onRemove {#onremove}

Intercepts DELETE requests. Receives the record ID (a string for single-key tables, or an object for composite keys). Return the ID to proceed with deletion, or `undefined` to abort (returns HTTP `500`); return or throw an `Error` to respond with it.

**Delete guard:**

```typescript
protected async onRemove(id: unknown) {
  const record = await this.table.findById(id as string)
  if (record?.protected) {
    return undefined  // abort
  }
  return id
}
```

**Soft delete (replace DELETE with UPDATE):**

::: warning Returning `undefined` from `onRemove` produces HTTP 500
The abort path always emits HTTP `500 "Not deleted"` to the client — there is no "soft success" return slot. If you simply soft-delete in `onRemove` and `return undefined`, the row is marked deleted but the client sees a 500 and may retry. Prefer one of the patterns below.
:::

**Recommended pattern A — intercept DELETE with a custom route**, hide the generated one behind a guard, and expose your own soft-delete handler:

```typescript
import { Delete, Param } from "@moostjs/event-http";

@TableController(todosTable)
export class TodoController extends AsDbController<typeof Todo> {
  // Returning undefined here aborts the built-in DELETE with HTTP 500;
  // route DELETEs through a sibling endpoint instead.
  protected onRemove() {
    return undefined;
  }

  @Delete(":id/soft")
  async softDelete(@Param("id") id: string) {
    await this.table.updateOne({ id, deletedAt: Date.now() } as any);
    return { deletedCount: 1 };
  }
}
```

**Recommended pattern B — model soft-delete as a `'row'`-level [action](./actions)**, which gives you a typed `client.action('archive', { id })`, server-side `disabled` gating, and `/meta`-driven UI buttons:

```typescript
@Post("actions/archive")
@DbAction<Todo, ["deletedAt"]>("archive", {
  label: "Archive",
  intent: "negative",
  requiredFields: ["deletedAt"],
  disabled: (rows) => rows.map((r) => r.deletedAt != null),
})
async archive(@DbActionID() id: { id: string }) {
  await this.table.updateOne({ id: id.id, deletedAt: Date.now() } as any)
  return { message: "Archived" }
}
```

In either case, combine with `transformFilter` to exclude soft-deleted records from reads:

```typescript
protected transformFilter(filter: FilterExpr): FilterExpr {
  return { $and: [filter, { deletedAt: { $exists: false } }] }
}
```

::: tip Why not just `return undefined` from `onRemove`?
The original "soft delete inside `onRemove`, return `undefined`" recipe still succeeds at the DB level — the row IS soft-deleted — but the HTTP response is `500 "Not deleted"`. Clients (including `@atscript/db-client`) treat that as a server error and may surface a generic failure toast. Use one of the patterns above to keep the wire response consistent with the actual outcome.
:::

### guardWrite / guardRemove {#guardwrite}

The validated stage (since 0.1.128). Override `guardWrite(ctx)` to check or enrich rows _after_ defaults and validation and _before_ the write, inside the table's own transaction: the override becomes the `guard` option of the table call ([`TWriteOptions.guard`](/api/crud#write-guards)), so it runs exactly once per endpoint call, and the table validates the rows again after it. A throw rolls the table's transaction back — including any rows the guard itself wrote through tables that joined it — and the error propagates unchanged. The OCC 404/409 disambiguation runs after the table call.

```typescript
import { HttpError } from "@moostjs/event-http";
import { AsDbController, TableController } from "@atscript/moost-db";
import type { TDbWriteGuardContext, TDbRemoveGuardContext } from "@atscript/moost-db";

@TableController(rulesTable)
export class RulesController extends AsDbController<typeof Rule> {
  protected override async guardWrite(ctx: TDbWriteGuardContext<Rule>) {
    for (let i = 0; i < ctx.rows.length; i++) {
      const row = ctx.rows[i];
      // Enrich in place — the table op re-validates what it receives.
      row.updatedBy = this.currentUserId();
      // Lazy, memoised pre-image (read inside the transaction; null for inserts without a key).
      const before = await ctx.current(i);
      if (before?.locked) throw new HttpError(409, "rule is locked");
      // Same transaction: an audit row rolls back with the write.
      await auditTable.insertOne({ ruleId: row.id, action: ctx.action });
    }
  }

  protected override async guardRemove(ctx: TDbRemoveGuardContext<Rule>) {
    const row = await ctx.current();
    if (row?.isFallback) throw new HttpError(409, "cannot delete the fallback rule");
  }
}
```

`ctx.action` is the endpoint's action (`insert` … `updateMany`); `ctx.rows` are the validated rows — defaults applied on insert/replace (static `@db.default 'x'` values are filled on every adapter, so the guard sees the full row; native function defaults such as a SQL `@db.default.now` stay absent until the engine fills them), identifying fields present and `$cas` removed on update; `ctx.expectedVersions[i]` is the version lifted from `version` / raw `$cas` (or `undefined`). For deletes, `ctx.id` is the id after `onRemove`, `ctx.filter` its resolved filter and `ctx.current()` the row about to be deleted. A missing row reaches `guardRemove` with `current()` resolving to `null`; the `404` comes after the guard — unless the id itself is malformed (it cannot be resolved to a filter, e.g. a non-numeric value for a numeric key), which is a `404` before the guard.

Overriding a guard is the only switch: there is no separate flag, and a no-op override still passes a guard (the table then validates twice). For a transaction around several table operations in a custom route, use [`withTransaction`](#withtransaction).

**DO / DON'T**

- **Do reject by throwing** (`HttpError` for a chosen status) — a returned value is ignored.
- **Don't swallow `DbError`s** inside a guard: on PostgreSQL the transaction is aborted after a failed statement, and the next statement fails with "current transaction is aborted".
- **Don't await external I/O on SQLite** — the guard holds the only connection; a self-call to your own API waits forever by default. See [SQLite concurrency](/adapters/sqlite#concurrency-and-transactions).
- **MongoDB replica sets may re-run the callback** on transient errors — a guard may execute more than once; keep it idempotent. On standalone MongoDB and on the memory adapter there is no transaction, so guard side effects are not rolled back.
- **A guard that writes the same row** (e.g. a [versioned touch](/api/versioning#versioned-touch) as a fence) bumps the version twice — once for the touch, once for the main write.
- Guard rows are validated twice (once before the guard, once after it): that cost exists only when a guard is overridden.

### withTransaction {#withtransaction}

`this.withTransaction(fn)` runs `fn` inside the bound table's adapter transaction — the same nesting rules as [`adapter.withTransaction`](/api/transactions). Use it for custom routes and actions that must be atomic across several table operations:

```typescript
@Post("actions/close")
@DbAction("close", { label: "Close" })
async close(@DbActionID() id: { id: number }) {
  return this.withTransaction(async () => {
    await this.table.updateOne({ id: id.id, status: "closed" });
    await auditTable.insertOne({ orderId: id.id, action: "close" });
    return { message: "Closed" };
  });
}
```

### Thrown errors {#thrown-errors}

Since 0.1.128 every built-in write failure is **thrown** as an `HttpError` — `500 "Not saved"` / `"Not deleted"`, `404`, the OCC `409`, the shape gate `400` — instead of being returned. The response is identical (Moost renders returned and thrown `HttpError`s the same way), but a throw also rolls back a transaction a subclass opened around `super.update()`. One nuance: when a handler _throws_, the HTTP router may fall through to a later route that also matches the request before responding; a _returned_ error responds immediately. This only matters when a catch-all route shadows a controller path.

| Case                                                       | Status                | Table transaction                                 |
| ---------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| Body not an object / array of objects                      | 400                   | not opened                                        |
| `onWrite` / `onRemove` returns `undefined` or a non-object | 500                   | not opened                                        |
| `onWrite` / `onRemove` returns or throws an error          | that                  | not opened                                        |
| `version` + differing `$cas`, malformed `$cas`             | 400                   | not opened                                        |
| Validation fails before the guard                          | 400                   | rolled back                                       |
| Guard throws                                               | that                  | rolled back — nothing written                     |
| Re-validation after the guard fails                        | 400                   | rolled back                                       |
| OCC mismatch / missing row                                 | 409 / 404             | committed with no match; the `findOne` runs after |
| DELETE of a missing row (guard ran, `current()` = null)    | 404                   | committed with no match                           |
| DELETE with an id that resolves to no filter               | 404                   | not opened, guard not called                      |
| SQLite transaction-gate wait timeout                       | 503                   | n/a                                               |
| Success (POST / PUT / PATCH / DELETE)                      | 201 / 201 / 202 / 202 | committed                                         |

## Metadata Hook

### meta {#meta}

Returns the payload emitted by `GET /meta`. Override to enrich the response with derived or remote data — the method may be sync or `async`.

```typescript
protected async meta() {
  const base = await super.meta()
  return { ...base, featureFlags: await this.loadFlags() }
}
```

The base implementation caches its own result. Subclasses overriding with async enrichment should cache their own computation if they need per-request dedup. Use `meta()` for **static** enrichment that is the same for every caller. For **per-principal** filtering of `crud` / `actions`, override `applyMetaOverlay()` instead — it runs after caching, on every request.

### applyMetaOverlay {#applymetaoverlay}

Runs on every `GET /meta` request, **after** `meta()` has resolved (and the result has been cached). Use it to prune `crud` keys, narrow `crud[op]` control whitelists, or filter the `actions[]` array based on the current request principal (user role, tenant, etc.).

```typescript
protected applyMetaOverlay(meta: TMetaResponse): TMetaResponse {
  const user = this.getCurrentUser()
  if (user?.isAdmin) return meta

  // Shallow clone — DO NOT mutate the cached envelope.
  const out: TMetaResponse = { ...meta, crud: { ...meta.crud } }

  // Hide write operations from non-admin users.
  delete out.crud.insert
  delete out.crud.update
  delete out.crud.replace
  delete out.crud.remove

  // Drop the "Delete All" table-level action from this principal.
  out.actions = meta.actions.filter((a) => a.name !== "deleteAll")
  return out
}
```

::: warning Always return a shallow clone — never mutate `meta`
The argument is the cached envelope shared across all requests. Mutating it leaks the per-request overlay to every subsequent caller. Spread (`{ ...meta }`) and re-spread nested objects you modify (`crud: { ...meta.crud }`, `actions: meta.actions.filter(...)`).
:::

::: warning Discoverability, not security
`applyMetaOverlay` controls what the UI **renders**. It does NOT stop a client from hitting the underlying route — for real per-principal route enforcement, use Moost auth guards (`@Authenticate`) and the [server-side action gate](./actions#server-side-gate). See [Permissions](./permissions) for the broader contract.
:::

May return a `Promise`. The hook is invoked even when other meta-derived endpoints (`/meta/form/:name`, `$actions=true` augmentation) consult the meta envelope.

## Initialization

### init {#init}

Runs once during controller construction. Use it for schema setup, seeding, or registering watchers. Can be async — errors are caught and logged automatically.

```typescript
protected async init() {
  await this.table.ensureTable()
  await this.table.syncIndexes()
}
```

## Accessing the Underlying Table

Inside any hook or custom method, you have access to the underlying table instance:

```typescript
this.table; // AtscriptDbTable — full read/write access (table-bound controllers)
this.readable; // AtscriptDbReadable — read-only access (all controllers)
```

Both controllers expose `this.readable` **and** the writable `this.table` — including `AsDbReadableController`, where named `@DbAction` handlers are the mutation surface. This is the canonical write access for the "generic reads + named actions" posture: no module-scope `db.getTable(Model)` needed. `this.table` throws for view-bound controllers.

```typescript
// In any hook or custom method
const count = await this.readable.count({ filter: {}, controls: {} });
this.logger.info(`Primary keys: ${this.table.primaryKeys}`);
this.logger.info(`Indexes: ${this.table.indexes.size}`);
```

## Extending Controllers

### Adding Custom Routes

Add methods with Moost decorators to create custom endpoints alongside the generated ones:

```typescript
import { Get } from "@moostjs/event-http";

@TableController(todosTable)
export class TodoController extends AsDbController<typeof Todo> {
  @Get("stats")
  async getStats() {
    const total = await this.readable.count({ filter: {}, controls: {} });
    const completed = await this.readable.count({
      filter: { completed: true },
      controls: {},
    });
    return { total, completed, pending: total - completed };
  }
}
```

This adds `GET /todos/stats` alongside the generated CRUD endpoints.

### Multiple Controllers

Mount multiple tables and views on different prefixes:

```typescript
app.registerControllers(
  ["todos", TodoController],
  ["projects", ProjectController],
  ["active-tasks", ActiveTasksViewController], // read-only view
);
```

## Combined Example

A complete controller combining multi-tenancy, audit fields, soft deletes, and field restrictions:

```typescript
const RESTRICTED = new Set(["internalNotes", "costPrice"]);

@TableController(productsTable, "api/products")
export class ProductController extends AsDbController<typeof Product> {
  protected async init() {
    await this.table.ensureTable();
  }

  protected transformFilter(filter: FilterExpr): FilterExpr {
    return {
      $and: [
        filter,
        {
          tenantId: this.getTenantId(),
          deletedAt: { $exists: false },
        },
      ],
    };
  }

  protected transformProjection(projection?: UniqueryControls["$select"]) {
    return projection ?? { costPrice: 0 };
  }

  protected onWrite(action: string, data: unknown) {
    const record = data as Record<string, unknown>;
    if (action === "insert") {
      return {
        ...record,
        tenantId: this.getTenantId(),
        createdBy: this.getUserId(),
      };
    }
    return {
      ...record,
      tenantId: this.getTenantId(),
      updatedBy: this.getUserId(),
    };
  }

  // Block the built-in DELETE — soft delete is exposed via a custom route
  // below. Returning undefined here produces HTTP 500 if a client still hits
  // DELETE /:id, which is the desired outcome.
  protected onRemove() {
    return undefined;
  }

  @Delete(":id/soft")
  async softDelete(@Param("id") id: string) {
    await this.table.updateOne({ id, deletedAt: Date.now() } as any);
    return { deletedCount: 1 };
  }

  protected validateInsights(insights: Map<string, unknown>): string | undefined {
    const base = super.validateInsights(insights);
    if (base) return base;

    for (const field of insights.keys()) {
      if (RESTRICTED.has(field) && !this.isAdmin()) {
        return `Access denied: cannot query field "${field}"`;
      }
    }
    return undefined;
  }
}
```

## Multi-Tenant Route Recipe {#multi-tenant}

A common pattern: mount the same controller under a `/tenant/:tenantId/...` prefix and scope every read/write to the URL-supplied tenant. The route prefix is supplied at registration time; the tenant scope is enforced in `transformFilter` / `transformOne` / `onWrite`.

**Read the tenant from the route param via Moost composables** — the table API knows nothing about routing, so the hooks bridge them:

```typescript
import { useRouteParams } from "@wooksjs/event-core";
import { HttpError } from "@moostjs/event-http";
import { AsDbController, TableController, type FilterExpr } from "@atscript/moost-db";
import { Todo } from "./schema/todo.as";
import { todosTable } from "./db";

@TableController(todosTable)
export class TenantTodoController extends AsDbController<typeof Todo> {
  private getTenantId(): string {
    const { tenantId } = useRouteParams<{ tenantId: string }>().get();
    if (!tenantId) throw new HttpError(400, "tenantId route param missing");
    return tenantId;
  }

  protected transformFilter(filter: FilterExpr): FilterExpr {
    return { $and: [filter, { tenantId: this.getTenantId() }] };
  }

  // No override needed for `/one` — `transformOne` falls through to `transformFilter`.

  protected onWrite(_action: string, data: unknown) {
    const record = data as Record<string, unknown>;
    return { ...record, tenantId: this.getTenantId() };
  }
}
```

Register under a nested route prefix at app boot:

```typescript
app.registerControllers(["tenant/:tenantId/todos", TenantTodoController]);
await app.init();
```

The generated endpoints become:

- `GET    /tenant/acme/todos/query`
- `GET    /tenant/acme/todos/one/42`
- `POST   /tenant/acme/todos/`
- `PATCH  /tenant/acme/todos/`
- ...

Every operation is automatically scoped to `tenantId = "acme"`. Cross-tenant access through the API is not possible because the filter overlay is applied unconditionally — even direct PK lookups like `GET /tenant/acme/todos/one/42` are rejected with 404 if record `42` belongs to a different tenant.

::: tip Combine with `transformOne` for asymmetric scoping
If `/one` should bypass the tenant scope (e.g. when an admin can address any row by PK), override `transformOne` separately and leave `transformFilter` strict.
:::

## Next Steps

- [HTTP Setup](./) — Controller installation and wiring
- [CRUD Endpoints](./crud) — Endpoint reference
- [CRUD Operations](/api/crud) — Programmatic `AtscriptDbTable` API
- [Transactions](/api/transactions) — Transaction integration
