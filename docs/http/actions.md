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

| Parameter decorator | Inferred level | Body shape (JSON)                                               |
| ------------------- | -------------- | --------------------------------------------------------------- |
| `@DbActionPK()`     | `row`          | scalar PK (e.g. `"abc"`, `42`) or composite-PK object           |
| `@DbActionPKs()`    | `rows`         | array of scalar PKs or array of composite-PK objects            |
| _(neither)_         | `table`        | typically empty body (or whatever your handler defines)         |
| Both `@DbActionPK*` | _illegal_      | action dropped from `/meta` with a `[moost-db actions]` warning |

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

| Option        | Type                                                   | Description                                                                 |
| ------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `label`       | `string`                                               | Human-readable label. Required (or use `@Label('...')`).                    |
| `icon`        | `string`                                               | Icon name; UI maps to its own icon set.                                     |
| `intent`      | `'positive' \| 'negative' \| 'primary' \| 'secondary'` | Semantic colour/prominence hint.                                            |
| `description` | `string`                                               | Tooltip / longer description.                                               |
| `order`       | `number`                                               | Display order hint.                                                         |
| `default`     | `boolean`                                              | Marks this as the level's default (e.g. row dblclick handler).              |
| `promptText`  | `string`                                               | Confirmation prompt template; `$1` (PK) and `$N` (count) substituted by UI. |

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

::: danger `@DbActionPK*` requires an attached typed table
`@DbActionPK()` and `@DbActionPKs()` validate the body against the controller's bound table schema — they only work on subclasses of `AsDbController` / `AsDbReadableController` (controllers wired with `@TableController` / `@ReadableController`). Applied to a controller without a typed table (e.g. a value-help controller, or a plain Moost controller without `@TableController`), the resolver throws **HTTP 500** at request time. That's a server-misconfiguration signal — not a client error.

If you need to accept PK-shaped bodies on a controller without a typed table, use Moost's `@Body()` and parse / validate the PK yourself. The control and the responsibility are then yours.
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
  intent?: "positive" | "negative" | "primary" | "secondary";
  description?: string;
  order?: number;
  default?: boolean;
  promptText?: string;
}
```

Discovery is **lazy** — it runs on the first `GET /meta` request and the result is cached alongside the rest of the meta envelope. Startup is unaffected. Warnings (missing label, missing `@Post`, `@Body` co-occurrence, duplicate `default`, …) emit on that first call, not at `app.init()` time.

The `@atscript/db-client` consumer reads `actions` off the meta response — see [HTTP Client — Metadata](./client#meta) — and exposes a typed `client.action(name, pk?)` helper that resolves and dispatches actions for you. See [HTTP Client — Actions](./client#actions) for the consumer-side API.

## Validation Rules and Warnings

The meta builder enforces several rules. Every violation emits a console warning prefixed `[moost-db actions]` and **drops** the offending action from `/meta` rather than throwing — this keeps `/meta` deliverable even with misconfigurations.

| Rule                                                                    | Outcome                          |
| ----------------------------------------------------------------------- | -------------------------------- |
| `@DbAction` method has no `@Post(...)`                                  | warn + drop                      |
| `@DbAction` method's only verb is non-POST (`@Get`, `@Put`, …)          | warn + drop                      |
| Both `@DbActionPK()` and `@DbActionPKs()` on the same method            | warn + drop                      |
| `@DbActionPK*` co-occurs with `@Body()`                                 | warn + drop                      |
| Method has no label (no `opts.label`, no `@Label`)                      | warn + drop                      |
| `@DbActionDefault()` applied without a corresponding `@DbAction(name)`  | warn + drop                      |
| Class-level `'navigate'` or `'backend'` entry has missing/empty `value` | warn + drop                      |
| Class-level `'custom'` entry supplies a `value`                         | warn + drop                      |
| Two actions with `default: true` at the same level                      | first wins, second demoted, warn |

The single greppable prefix `[moost-db actions]` makes it easy to detect issues in CI logs.

## Value-Help Controllers Are Excluded

`AsValueHelpController` and `AsJsonValueHelpController` (used for FK pickers and dictionary surfaces) do **not** participate in action discovery. Action decorators applied to them are silently ignored — `actions` is always emitted as `[]` for shape uniformity. Adding actions to a value-help picker doesn't make sense; the contract is intentionally narrow.

## Next Steps

- [HTTP Client](./client) — Consume the `actions` field from `@atscript/db-client`
- [Customization](./customization) — Hooks for intercepting CRUD (different concept; complements actions)
- [HTTP Setup](./) — Controller installation and wiring
