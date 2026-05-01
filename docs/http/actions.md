---
outline: deep
---

# Actions

Actions are domain operations that live alongside CRUD — "Block User", "Approve Order", "Export CSV", "Edit (navigate)". `@atscript/moost-db` exposes a decorator family that lets you declare these once on a controller and have them surface in `GET /meta` so any UI client can render row buttons, batch toolbars, header buttons, and double-click gestures generically.

A declared action is one of three kinds (`processor`):

- **`backend`** — server-side POST handler (your method).
- **`navigate`** — UI route push (URL template, no server call).
- **`custom`** — UI-dispatched event (no server call, no navigation).

Actions also carry a **level** — `'row'`, `'rows'`, or `'table'` — telling the UI where the affordance belongs.

> See [Permissions](./permissions) for the built-in CRUD surface (`/meta.crud`).
> Actions and CRUD permissions are sibling fields on `/meta` with the same
> overlay strategy but distinct dispatch paths — typed client methods for
> CRUD, `Client.action()` for actions.

## Quick Example

A row-level "Block" action that POSTs to a server handler:

```atscript
// schema/user.as
@db.table 'users'
export interface User {
    @meta.id
    id: string

    name: string

    @db.default 'false'
    blocked: boolean
}
```

```typescript
import { AsDbController, TableController, DbAction, DbActionPK } from "@atscript/moost-db";
import { Post } from "@moostjs/event-http";
import { User } from "./schema/user.as";
import { usersTable } from "./db";

@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {
  @Post("actions/block")
  @DbAction("block", { label: "Block", icon: "i-as-block", intent: "negative" })
  async blockUser(@DbActionPK() id: string) {
    await this.table.updateOne({ id, blocked: true });
    return { message: `User ${id} blocked` };
  }
}
```

Fetch `GET /users/meta` and the `actions` array now contains:

```json
{
  "actions": [
    {
      "name": "block",
      "label": "Block",
      "level": "row",
      "processor": "backend",
      "value": "/users/actions/block",
      "icon": "i-as-block",
      "intent": "negative"
    }
  ]
}
```

A UI consuming `/meta` renders a per-row "Block" button. When the user clicks it, the client POSTs the row's primary key as a JSON body:

```bash
curl -X POST http://localhost:3000/users/actions/block \
  -H "Content-Type: application/json" \
  -d '"abc123"'
# → { "message": "User abc123 blocked" }
```

## Action Levels

The `level` tells the UI where the action belongs. It is **inferred** from the parameter decorators of the handler — you never set it directly on `@DbAction`:

| Parameter decorator(s)                | Inferred level | Body shape (JSON)                                               |
| ------------------------------------- | -------------- | --------------------------------------------------------------- |
| `@DbActionPK()` or `@DbActionRow()`   | `row`          | scalar PK (e.g. `"abc"`, `42`) or composite-PK object           |
| `@DbActionPKs()` or `@DbActionRows()` | `rows`         | array of scalar PKs or array of composite-PK objects            |
| _(none)_                              | `table`        | typically empty body (or whatever your handler defines)         |
| Both row + rows cardinality           | _illegal_      | action dropped from `/meta` with a `[moost-db actions]` warning |

`@DbActionRow()` / `@DbActionRows()` inject the actual row(s) (already loaded by the gate); they are described under [Server-side Gate § Row injection](#row-injection).

For class-level actions (declared via `@DbActions` family), you set `level` on the dict entry — see [Class-level actions](#class-level-actions) below.

## Three Processors

### `'backend'` — server-side POST handler

The most common case. Decorate a method with `@DbAction(name, opts)` plus `@Post(path)` and Moost binds the route normally:

```typescript
@Post("actions/approve")
@DbAction("approve", { label: "Approve", intent: "positive" })
async approve(@DbActionPK() id: string) {
  await this.table.updateOne({ id, approved: true })
  return { message: 'Approved' }
}
```

The `value` field in `/meta` is filled in by the meta builder with the bound HTTP path (controller prefix + method path). You don't compute it.

### `'navigate'` — UI route push

For "Edit", "View Details", or any action that just routes to another page. Declared at the class level only:

```typescript
import { DbRowActions } from "@atscript/moost-db";

@TableController(usersTable)
@DbRowActions({
  edit: { label: "Edit", processor: "navigate", value: "/users/$1/edit" },
})
export class UsersController extends AsDbController<typeof User> {}
```

The `$1` placeholder is the row's primary key. Substitution is the **UI client's** job — the server emits `value` verbatim. For composite keys, the UI joins the URL-encoded segments with `/`.

### `'custom'` — UI-dispatched event

For actions whose entire behaviour lives in the UI (open a modal, copy to clipboard, kick off a client-only export). No server call, no navigation:

```typescript
@DbTableActions({
  exportCsv: { label: "Export CSV", processor: "custom" },
})
export class OrdersController extends AsDbController<typeof Order> {}
```

The UI receives `processor: 'custom'` and `value: 'exportCsv'` (the dict key). It dispatches an event with that name and your client code handles it. `value` is **forbidden** in `'custom'` entries — the meta builder fills it.

## Method Decorators

Use these when the action has a server-side handler.

### `@DbAction(name, opts?)`

Marks a method as an action. Does **not** register an HTTP route — pair it with `@Post(...)`. The `name` is the action's stable identifier surfaced to the UI.

| Option           | Type                                                                | Description                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`          | `string`                                                            | Human-readable label. Required (or use `@Label('...')`).                                                                                                                                                                                |
| `icon`           | `string`                                                            | Icon name; UI maps to its own icon set.                                                                                                                                                                                                 |
| `intent`         | `'positive' \| 'negative' \| 'warning' \| 'primary' \| 'secondary'` | Semantic colour/prominence hint. Suggested ordering (most → least): `negative` (destructive) > `warning` (risky-but-not-destructive: retry, force-recompute) > `primary` > `positive` > `secondary`.                                    |
| `description`    | `string`                                                            | Tooltip / longer description.                                                                                                                                                                                                           |
| `order`          | `number`                                                            | Display order hint.                                                                                                                                                                                                                     |
| `default`        | `boolean`                                                           | Marks this as the level's default (e.g. row dblclick handler).                                                                                                                                                                          |
| `promptText`     | `string \| [string, string]`                                        | Confirmation prompt. Tuple form is `[singular, plural]` — UI picks `[0]` when the action will execute against a single PK, `[1]` otherwise. `$1` (single PK) and `$N` (count) substituted by UI.                                        |
| `shortcut`       | `string`                                                            | Single-character keyboard hint. Modifier prefix (Alt+, Ctrl+, bare key) and activation scope are UI/UX concerns; server forwards the character verbatim and does no conflict resolution.                                                |
| `disabled`       | `(row: TRow) => boolean`                                            | Per-row gate predicate. Truthy → action is disabled for that row. Server enforces; UI mirrors. See [Server-side Gate](#server-side-gate). Annotate `row` arg explicitly — TS decorators can't infer `TRow` from class generic.          |
| `requiredFields` | `string[]`                                                          | Dot-notation paths the UI should union into `$select` for predicate evaluation. Stripped if `disabled` absent. See [`requiredFields`](#requiredfields).                                                                                 |
| `onDisabledRows` | `'reject' \| 'skip'`                                                | `'rows'`-level batch policy. Default `'reject'`. See [Batch mode](#rows-batch-mode).                                                                                                                                                    |
| `table`          | `AtscriptDbTable<any>`                                              | Required when declaring `disabled` or any `@DbActionRow*` on a class that does **not** extend `AsDbReadableController`. Silently ignored on subclasses (the bound table wins). See [Bound-table requirement](#bound-table-requirement). |

::: tip Label resolution
The label resolves in this order: `opts.label` > `@Label('...')` decorator > drop-with-warning. Pick one — both with the same value is benign; mismatched values let `opts.label` win.
:::

### `@DbActionDefault()`

Sugar for `default: true`. Equivalent to passing `opts.default = true` on `@DbAction`. Decorator order does not matter:

```typescript
@Post("actions/edit")
@DbAction("edit", { label: "Edit" })
@DbActionDefault()
async edit(@DbActionPK() id: string) { /* ... */ }
```

The default action is what UIs invoke on row double-click (or the default key in batch toolbars). At most one default per `(controller × level)` — extra defaults are demoted with a warning.

### `@DbActionPK()` / `@DbActionPKs()`

Parameter resolvers that read the primary key from the JSON request body and validate it against the table's PK schema:

```typescript
// Single row, scalar PK
@Post("actions/block")
@DbAction("block", { label: "Block" })
async block(@DbActionPK() id: string) { /* id === "abc" */ }

// Single row, composite PK
@Post("actions/promote")
@DbAction("promote", { label: "Promote" })
async promote(@DbActionPK() id: { tenantId: string; userId: string }) { /* ... */ }

// Multiple rows
@Post("actions/lock")
@DbAction("lock", { label: "Lock Selected" })
async lock(@DbActionPKs() ids: string[]) { /* ids === ["a", "b", "c"] */ }
```

Validation is **strict** — no type coercion. If the PK is numeric, JSON `"42"` (a string) is rejected with HTTP 400 before your handler runs.

| Body shape per PK type                       | Single-field PK        | Composite PK                                  |
| -------------------------------------------- | ---------------------- | --------------------------------------------- |
| `@DbActionPK()` (row)                        | `42`, `"abc"`, `true`  | `{ "tenantId": "acme", "userId": "u1" }`      |
| `@DbActionPKs()` (rows, **always an array**) | `["a", "b"]`, `[1, 2]` | `[{ "tenantId": "acme", "userId": "u1" }, …]` |

::: warning `rows`-level body is always an array
A `'rows'` action MUST receive a JSON array, even when the client invokes it on a single row. Send `["a"]`, not `"a"`. The `@DbActionPKs()` resolver rejects non-array bodies with HTTP 400. An empty array `[]` is accepted — `client.action(name)` with no PK posts `[]`, and your handler runs with `ids === []`.
:::

::: danger `@DbActionPK*` requires a bound table
`@DbActionPK()` and `@DbActionPKs()` validate the body against the controller's bound table schema. The bound table is resolved in this order:

1. `opts.table` (any controller class) — declare it on `@DbAction(name, { table })`.
2. Subclass of `AsDbController` / `AsDbReadableController` (wired with `@TableController` / `@ReadableController`) — bound table comes from the controller automatically.
3. Duck-type fallback — a `readable` or `table` instance property on the controller (legacy support).

If none resolves at request time, the resolver throws **HTTP 500** — a server-misconfiguration signal, not a client error. For controllers that genuinely have no typed table, use Moost's `@Body()` and parse / validate the PK yourself.

When you also declare `disabled` or any `@DbActionRow*` decorator on a non-`AsDbReadableController` class, the duck-type fallback is **NOT** sufficient — you must pass `opts.table` explicitly so discovery can validate at first `/meta` (see [Bound-table requirement](#bound-table-requirement)).
:::

Validation errors flow through the existing validation interceptor and emit the same envelope as DTO failures:

```json
{
  "statusCode": 400,
  "message": "...",
  "errors": [{ "path": "userId", "message": "Missing primary-key field \"userId\"" }]
}
```

::: warning No `@Body()` alongside `@DbActionPK*`
Mixing `@DbActionPK()` or `@DbActionPKs()` with `@Body()` on the same method drops the action with a warning. If your action needs additional input beyond the PK, model it as `processor: 'custom'` and POST to a regular `@Post`-decorated handler from your UI client.
:::

## Class-level Actions

Use these for `'navigate'` and `'custom'` actions that never need a server method, and as an escape hatch for `'backend'` actions that point to a shared or legacy endpoint.

### `@DbActions(dict)`

Generic — every entry must specify `level`:

```typescript
@DbActions({
  edit:    { level: "row",   label: "Edit",      processor: "navigate", value: "/users/$1/edit" },
  refresh: { level: "table", label: "Refresh",   processor: "custom" },
  block:   { level: "row",   label: "Block",     processor: "backend",  value: "/admin/block" },
})
```

### Level-pinned shortcuts

`@DbTableActions`, `@DbRowActions`, `@DbRowsActions` inject `level` into every entry of the dict — purely a DX optimisation:

```typescript
import { DbRowActions, DbTableActions, DbRowsActions } from "@atscript/moost-db";

@TableController(usersTable)
@DbRowActions({
  edit: { label: "Edit", processor: "navigate", value: "/users/$1/edit" },
  view: { label: "View", processor: "navigate", value: "/users/$1" },
})
@DbTableActions({
  importCsv: { label: "Import CSV", processor: "custom" },
})
@DbRowsActions({
  bulkBlock: { label: "Block Selected", processor: "backend", value: "/admin/users/bulk-block" },
})
export class UsersController extends AsDbController<typeof User> {}
```

The dictionary key serves as the action `name`. Class-level entries do **not** bind any HTTP route — they are surfaced in `/meta` only.

### `value` rules per processor

| Processor    | `value` at definition time           | `value` in `/meta`                  |
| ------------ | ------------------------------------ | ----------------------------------- |
| `'navigate'` | required, non-empty (URL template)   | passes through unchanged            |
| `'backend'`  | required, non-empty (full HTTP path) | passes through unchanged            |
| `'custom'`   | **forbidden** at definition time     | filled by builder with the dict key |

For `'navigate'` and `'backend'`, `undefined`, `null`, and `''` are all treated as missing — the entry is dropped with a `[moost-db actions]` warning. For `'custom'`, supplying any `value` drops the entry.

::: tip Class-level `'backend'` is the escape hatch
Use `processor: 'backend'` at the class level to point an action at a shared or legacy path. The dev-supplied path **must** be served by a `@Post`-bound handler somewhere — typically a method using `@DbActionPK()` / `@DbActionPKs()` so the PK-shaped JSON body is parsed and validated. The meta builder does not validate that the path resolves; that's your contract.
:::

### When to use class- vs. method-level

- **Method decorator** (`@DbAction`): the action has a server handler living on this controller. The path, validation, and label all live in one place.
- **Class decorator** (`@DbActions` family): the action is `'navigate'` or `'custom'` (no server handler at all), or it points at a shared/legacy `'backend'` endpoint that lives elsewhere. Also useful for declaring many actions compactly.

## Server-side Gate {#server-side-gate}

Many actions only apply under specific row state — "Ship" should run only on orders with `status === 'processing'`, "Approve" only on pending requests. Without a declarative gate, the controller has to guard the handler manually and return `{ ok: false, message: 'Already shipped' }` after the user clicks; the UI button stays live for every row because the UI has no machine-readable predicate. The same predicate ends up duplicated (or, today, missing) in the UI, and the two drift.

The gate collapses this to **one declaration**: the server enforces it via an interceptor, and the wire emits the predicate's source so a UI can grey-out / hide the button per row.

### Basic recipe

A row-level "Ship" action gated on order status:

```typescript
import { AsDbController, TableController, DbAction, DbActionPK } from "@atscript/moost-db";
import { Post } from "@moostjs/event-http";
import { Order } from "./schema/order.as";
import { ordersTable } from "./db";

@TableController(ordersTable)
export class OrdersController extends AsDbController<typeof Order> {
  @Post("actions/ship")
  @DbAction("ship", {
    label: "Ship",
    intent: "primary",
    disabled: (order: Order) => order.status !== "processing",
  })
  async ship(@DbActionPK() id: string) {
    await this.table.updateOne({ id, status: "shipped" });
    return { message: "Shipped" };
  }
}
```

The gate interceptor runs **after** auth guards and **before** the handler. When `disabled` returns truthy, the request is rejected with `ActionDisabledError` (HTTP 409) and the handler never runs. No guard code in the handler body — by the time `ship()` executes, the gate has already vetted the row.

::: tip TS row-arg annotation is required
TypeScript decorators can't infer `TRow` from the enclosing controller's class generic, so the dev MUST annotate the row arg explicitly: `(order: Order) => …`. Without it, TS infers `unknown` and you lose autocomplete.
:::

### Row injection — `@DbActionRow()` / `@DbActionRows()` {#row-injection}

The gate already loaded the row(s) to evaluate `disabled`. The same loaded row(s) can be injected into the handler — no second fetch:

```typescript
import { DbAction, DbActionPK, DbActionRow } from "@atscript/moost-db";

@Post("actions/ship")
@DbAction("ship", {
  label: "Ship",
  disabled: (order: Order) => order.status !== "processing",
})
async ship(@DbActionPK() id: string, @DbActionRow() order: Order) {
  // `order` is the same row the gate evaluated. No re-fetch.
  await this.table.updateOne({ id, status: "shipped", shippedAt: Date.now() });
  return { message: `Shipped order ${order.orderNumber}` };
}
```

`@DbActionRow()` / `@DbActionRows()` are also recognized as level signals (see [Action Levels](#action-levels)) — `@DbActionRow()` infers `'row'`, `@DbActionRows()` infers `'rows'`. They are interchangeable with `@DbActionPK*` for level inference; mixing row-cardinality and rows-cardinality decorators on the same method drops the action with a warning.

In `'rows'` + `'skip'` mode, `@DbActionRows()` resolves to filtered survivors only — the original request rows are not retrievable post-filter.

### `'rows'`-level batch mode {#rows-batch-mode}

For `@DbActionPKs()` / `@DbActionRows()` actions, `onDisabledRows` controls how the gate handles partial failures:

| Mode                 | Predicate evaluated   | On any failure                                                    | Handler runs with  |
| -------------------- | --------------------- | ----------------------------------------------------------------- | ------------------ |
| `'reject'` (default) | every row (FULL scan) | throws `ActionDisabledError` listing **all** failing PKs          | n/a                |
| `'skip'`             | every row (FULL scan) | filters cached PKs + rows to passing-only; zero survivors → throw | only the survivors |

```typescript
@Post("actions/archive")
@DbAction("archive", {
  label: "Archive Selected",
  disabled: (order: Order) => order.archived,
  onDisabledRows: "skip",   // archive only un-archived rows; ignore the rest
})
async archive(@DbActionPKs() ids: string[]) {
  // `ids` contains only survivors when `onDisabledRows: 'skip'`.
  await this.table.bulkUpdate(ids.map((id) => ({ id, archived: true })));
  return { message: `${ids.length} orders archived` };
}
```

Two notes:

- `'reject'` is the default because it preserves request-atomicity — partial success is opt-in.
- Both modes do a **FULL scan** (not short-circuit) before throwing — so the rejection body lists every failing PK, not just the first. Predicates with side-effects (rare; predicates should be pure) are called for every row.

### Bound-table requirement {#bound-table-requirement}

The gate / `@DbActionRow*` need a typed table at request time to load the row(s). Discovery enforces this at first `/meta`:

| Controller                                                               | What's required for `disabled` / `@DbActionRow*`                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `AsDbController` / `AsDbReadableController` subclass                     | nothing — bound table comes from `@TableController` / `@ReadableController`; `opts.table` is silently ignored    |
| Plain Moost controller (no extends, no `readable`/`table` field)         | **MUST** declare `opts.table` on `@DbAction(name, { table })`                                                    |
| Plain Moost controller WITH `readable` / `table` instance field (legacy) | duck-type fallback covers plain `@DbActionPK*` only — gates and `@DbActionRow*` still need explicit `opts.table` |

When the requirement isn't met, discovery emits a `[moost-db actions]` warning and **drops** the action from `/meta`. Plain `@DbActionPK()` / `@DbActionPKs()` (no gate, no row injection) still works on any controller via the existing duck-type fallback — only gated / row-injecting actions need the explicit `table` opt.

```typescript
// Plain controller — gated action MUST pass opts.table
@Controller()
export class AdminController {
  @Post("orders/ship")
  @DbAction("ship", {
    label: "Ship",
    table: ordersTable, // ← required
    disabled: (order: Order) => order.status !== "processing",
  })
  async ship(@DbActionPK() id: string, @DbActionRow() row: Order) {
    /* ... */
  }
}
```

### `requiredFields` {#requiredfields}

`requiredFields` is a UI hint listing dot-notation paths the predicate references. The UI unions these into `$select` so it can evaluate `disabled` against fetched rows.

- Without `disabled` → stripped at discovery with a `[moost-db actions]` warning. The action itself stays.
- When present → UI uses verbatim, no parsing of the stringified `disabled` source.
- When absent (and `disabled` set) → UI parses `fn.toString()` itself for property accesses (works against minified output where property names aren't mangled).
- Plain `string[]` of dot-notation paths in v1 (typed `PathOf<TRow>[]` is a future upgrade).

### Closure-emission pitfall

The wire emits `fn.toString()` of the predicate **verbatim** — captured outer-scope identifiers come along. The server doesn't validate closure-cleanliness; it runs the original closure successfully. The UI, on the other hand, evaluates the stringified source in a different scope and throws `ReferenceError` on captured names.

::: warning Predicate body must reference only the row arg
Outer-scope identifiers (constants, helpers, imports, `this.*`) work server-side but break UI mirroring. Keep predicates pure and self-contained.

```typescript
// ✅ self-contained — works server + UI
disabled: (order: Order) => order.status !== "processing";

// ❌ captures outer-scope SHIPPED — server runs, UI throws ReferenceError
const SHIPPED = "shipped";
disabled: (order: Order) => order.status === SHIPPED;

// ❌ captures `this` — same problem
disabled: (order: Order) => order.tenantId === this.currentTenant;
```

:::

### `ActionDisabledError` (HTTP 409)

When the gate rejects, the response is HTTP 409 with this body:

```json
{
  "name": "ActionDisabledError",
  "message": "Action \"ship\" is disabled for this row",
  "statusCode": 409,
  "action": "ship",
  "pk": "abc"
}
```

For `'rows'`-level rejections, `pks: [...]` replaces `pk`:

- `'reject'` mode: `pks` lists ALL failing PKs (full-scan, not just the first).
- `'skip'` mode with zero survivors: `pks` lists ALL request PKs.

The error class lives in `@atscript/moost-db` (`ActionDisabledError extends HttpError`). The discriminator `name: 'ActionDisabledError'` lets `@atscript/db-client` construct the typed `ActionDisabledError` subclass on the consumer side — see [HTTP Client — Actions § Error cases](./client#error-cases).

### Class-level dict entries are UI-only

Class-level `@DbActions` / `@DbRowActions` / `@DbRowsActions` accept `disabled` and `requiredFields`, but they only forward to the wire — no interceptor registers, because the dict entry's `value` may point at an endpoint in another controller (or a method that doesn't exist in this scope). The UI still grays out the button.

For symmetric server enforcement at the actual `@Post`-bound handler, also declare `@DbAction(name, { disabled })` on that method. The wire shape is identical either way.

### Composables

Useful when composing custom interceptors that need access to the gate's cached PKs / rows without re-parsing the body or re-fetching:

```typescript
import { useDbActionPk, useDbActionPks, useDbActionRow, useDbActionRows } from "@atscript/moost-db";

const pk = await useDbActionPk().load(); // cached, validated single PK
const pks = await useDbActionPks().load(); // cached, validated PK array
const row = await useDbActionRow().load(); // cached single row (gate-loaded)
const rows = await useDbActionRows().load(); // cached row array (gate-loaded; filtered in skip mode)
```

All four follow the Wooks `defineWook` pattern and return `{ load() }`. The gate runs at `AFTER_GUARD` priority so reads are safe inside any `INTERCEPTOR`-priority custom interceptor.

## Request and Response Contracts

### Request body

All action requests use `Content-Type: application/json`:

| Level   | PK shape      | JSON body                                     |
| ------- | ------------- | --------------------------------------------- |
| `row`   | scalar        | `42` or `"abc"` or `true`                     |
| `row`   | composite     | `{ "tenantId": "acme", "userId": "u1" }`      |
| `rows`  | scalar        | `["a", "b", "c"]`                             |
| `rows`  | composite     | `[{ "tenantId": "acme", "userId": "u1" }, …]` |
| `table` | none required | empty body (or whatever your handler accepts) |

Strict typing — no coercion. Schema mismatches return HTTP 400 with the same envelope as DTO validation failures. **`rows`-level bodies are always arrays** even for a single PK — send `["a"]`, never `"a"`.

### Success response

Backend actions may return any JSON. There is one **convention** UI clients SHOULD honour:

> If the response body has a top-level `"message": string`, the UI displays it (toast, banner, etc.). Otherwise the UI uses a generic per-level message ("Action completed", "5 rows updated", …).

This is a documented convention, not a runtime contract — no `TDbActionResult` type, no server-side validation. You're free to return whatever shape your client expects:

```typescript
@Post("actions/block")
@DbAction("block", { label: "Block" })
async block(@DbActionPK() id: string) {
  await this.table.updateOne({ id, blocked: true })
  return { message: `User ${id} blocked` }   // ← UI toasts this
}

@Post("actions/lock")
@DbAction("lock", { label: "Lock Selected" })
async lock(@DbActionPKs() ids: string[]) {
  await this.table.bulkUpdate(ids.map((id) => ({ id, locked: true })))
  return { message: `${ids.length} users locked`, locked: ids }
}

@Post("actions/refresh-cache")
@DbAction("refresh-cache", { label: "Refresh" })
async refreshCache() {
  await this.warmCache()
  // No "message" → UI falls back to a generic toast.
  return { ok: true }
}
```

### Error response

Errors flow through the existing validation interceptor — same envelope as CRUD endpoints. PK validation failures, missing fields, and wrong types all emit HTTP 400 with structured `errors[]`. See [CRUD — Error Handling](./crud#error-handling).

Gate rejections are HTTP **409** with the `ActionDisabledError` body shape — see [Server-side Gate § `ActionDisabledError`](#actiondisablederror-http-409).

## Composing with Auth and Interceptors

`@DbAction` does not interfere with any other Moost decorator. `@Authenticate`, `@Intercept`, pipe decorators, and parameter decorators all behave as if `@DbAction` were absent:

```typescript
import { Authenticate } from "@moostjs/event-http";

@Post("actions/block")
@Authenticate(adminGuard)
@DbAction("block", { label: "Block" })
async block(@DbActionPK() id: string) {
  /* runs only if adminGuard passes */
}
```

If the guard rejects the request, the handler body never runs and the auth-failure response is returned — exactly as for any other Moost handler.

The internal gate interceptor (registered automatically when `disabled` or `@DbActionRow*` is present) runs at `AFTER_GUARD` priority — so auth guards run first, the gate runs after, then any custom `INTERCEPTOR`-priority interceptors, then the handler.

## The `/meta` Surface

The `actions` field of the `/meta` response is an array of `TDbActionInfo`:

```typescript
interface TDbActionInfo {
  name: string;
  label: string;
  level: "table" | "row" | "rows";
  processor: "backend" | "navigate" | "custom";
  value: string;
  icon?: string;
  intent?: "positive" | "negative" | "warning" | "primary" | "secondary";
  description?: string;
  order?: number;
  default?: boolean;
  promptText?: string | [string, string]; // [singular, plural]
  shortcut?: string; // single character; UI binds the modifier
  disabled?: string; // fn.toString() of the gate predicate
  requiredFields?: string[]; // UI's $select union hint
}
```

The server emits `fn.toString()` verbatim — closures and outer-scope references included. No parsing, no AST transform. The UI evaluates the source against a level-specific scope (the row for `'row'`-level, each row for `'rows'`-level) to grey-out / hide the button. Server enforcement is authoritative; this field is purely a UI hint. Class-level dict entries with a `disabled` predicate also emit `disabled` on the wire — but the server cannot enforce them (see [Class-level dict entries are UI-only](#class-level-dict-entries-are-ui-only)).

Discovery is **lazy** — it runs on the first `GET /meta` request and the result is cached alongside the rest of the meta envelope. Startup is unaffected. Warnings (missing label, missing `@Post`, `@Body` co-occurrence, duplicate `default`, …) emit on that first call, not at `app.init()` time.

The `@atscript/db-client` consumer reads `actions` off the meta response — see [HTTP Client — Metadata](./client#meta) — and exposes a typed `client.action(name, pk?)` helper that resolves and dispatches actions for you. See [HTTP Client — Actions](./client#actions) for the consumer-side API.

## Validation Rules and Warnings

The meta builder enforces several rules. Every violation emits a console warning prefixed `[moost-db actions]` and **drops** the offending action from `/meta` rather than throwing — this keeps `/meta` deliverable even with misconfigurations.

| Rule                                                                                | Outcome                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `@DbAction` method has no `@Post(...)`                                              | warn + drop                                 |
| `@DbAction` method's only verb is non-POST (`@Get`, `@Put`, …)                      | warn + drop                                 |
| Both `@DbActionPK()` and `@DbActionPKs()` on the same method                        | warn + drop                                 |
| `@DbActionPK*` co-occurs with `@Body()`                                             | warn + drop                                 |
| Method has no label (no `opts.label`, no `@Label`)                                  | warn + drop                                 |
| `@DbActionDefault()` applied without a corresponding `@DbAction(name)`              | warn + drop                                 |
| Class-level `'navigate'` or `'backend'` entry has missing/empty `value`             | warn + drop                                 |
| Class-level `'custom'` entry supplies a `value`                                     | warn + drop                                 |
| Two actions with `default: true` at the same level                                  | first wins, second demoted, warn            |
| `'table'`-level action declares `disabled`                                          | warn + drop                                 |
| Gated / row-injecting on a non-`AsDbReadableController` class without `opts.table`  | warn + drop                                 |
| `requiredFields` set without `disabled`                                             | warn + strip `requiredFields` (action kept) |
| Mixing row + rows cardinality (`@DbActionPK*` / `@DbActionRow*`) on the same method | warn + drop                                 |

The single greppable prefix `[moost-db actions]` makes it easy to detect issues in CI logs.

## Value-Help Controllers Are Excluded

`AsValueHelpController` and `AsJsonValueHelpController` (used for FK pickers and dictionary surfaces) do **not** participate in action discovery. Action decorators applied to them are silently ignored — `actions` is always emitted as `[]` for shape uniformity. Adding actions to a value-help picker doesn't make sense; the contract is intentionally narrow.

## Next Steps

- [HTTP Client](./client) — Consume the `actions` field from `@atscript/db-client`
- [Customization](./customization) — Hooks for intercepting CRUD (different concept; complements actions)
- [HTTP Setup](./) — Controller installation and wiring
