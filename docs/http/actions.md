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

Backend actions can additionally declare a **form input** via [`@InputForm()`](#input-form): the controller advertises a `.as` interface as the action's payload schema, the UI fetches it from a per-controller endpoint, renders a form, and submits the user-filled data alongside the identifier — no manual modal plumbing.

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
import { AsDbController, TableController, DbAction, DbActionID } from "@atscript/moost-db";
import { Post } from "@moostjs/event-http";
import { User } from "./schema/user.as";
import { usersTable } from "./db";

@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {
  @Post("actions/block")
  @DbAction("block", { label: "Block", icon: "i-as-block", intent: "negative" })
  async blockUser(@DbActionID() id: { id: string }) {
    await this.table.updateOne({ id: id.id, blocked: true });
    return { message: `User ${id.id} blocked` };
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

A UI consuming `/meta` renders a per-row "Block" button. When the user clicks it, the client POSTs the row's identifier wrapped in the action **envelope**:

```bash
curl -X POST http://localhost:3000/users/actions/block \
  -H "Content-Type: application/json" \
  -d '{"ids":{"id":"abc123"}}'
# → { "message": "User abc123 blocked" }
```

::: tip The body is an envelope: `{ ids?, input? }`
Every action request body is an object envelope. `ids` carries the identifier(s); `input` carries the optional `@InputForm` payload, validated server-side against the declared form (see [Form input](#input-form)). Both fields are optional: a `'table'`-level action with no form declares no `ids`, and an action without `@InputForm` carries no `input`. Even single-field PK tables send `{ "ids": { "id": "abc" } }`, never the bare scalar. See [Body envelope](#body-envelope).
:::

## Action Levels

The `level` tells the UI where the action belongs. It is **inferred** from the parameter decorators of the handler — you never set it directly on `@DbAction`:

| Parameter decorator(s)                | Inferred level | Body envelope (JSON)                                             |
| ------------------------------------- | -------------- | ---------------------------------------------------------------- |
| `@DbActionID()` or `@DbActionRow()`   | `row`          | `{ "ids": { ... } }` — identifier object as the `ids` field      |
| `@DbActionIDs()` or `@DbActionRows()` | `rows`         | `{ "ids": [ ... ] }` — array of identifier objects               |
| _(none)_                              | `table`        | empty body (or `{ "input": ... }` when paired with `@InputForm`) |
| Both row + rows cardinality           | _illegal_      | action dropped from `/meta` with a `[moost-db actions]` warning  |

`@InputForm()` is **orthogonal** to level — it adds an `input` field to the envelope without affecting whether the action is row/rows/table.

`@DbActionRow()` / `@DbActionRows()` inject the actual row(s) (already loaded by the gate); they are described under [Server-side Gate § Row injection](#row-injection).

For class-level actions (declared via `@DbActions` family), you set `level` on the dict entry — see [Class-level actions](#class-level-actions) below.

## Body envelope {#body-envelope}

Every action POST body is a JSON object **envelope** with two optional fields:

```ts
{
  ids?: object | object[],   // identifier(s) — see Identifier shape below
  input?: unknown,           // payload for @InputForm — see Form input below
}
```

The envelope shape is fixed: arrays or scalars at the body root are rejected with HTTP 400 `ValidatorError`. This is a **breaking change** from the pre-`@InputForm()` shape that placed identifiers at the root — older clients sending the bare identifier (e.g. `{"id":"abc"}` or `[{"id":"a"}]`) need to be updated to wrap them in `ids`.

Empty `{}` is always valid — it means "table-level action, no input, no identifier". A `'table'`-level action with no `@InputForm` may be invoked with no body at all; the client SHOULD omit the body in that case (and `@atscript/db-client` does).

## Identifier shape {#identifier-shape}

The `ids` field is **always an object** (single) or **array of objects** (multi) — never a scalar. Each object's field set must EXACTLY match one **legitimate identification** on the table:

- the **primary key** (`primaryKeys`), or
- any declared `@db.index.unique` group (single-field or compound).

The validator is **strict** — unknown fields are rejected with HTTP 400. Precedence: PK first, then unique-index groups in declaration order. The same `@DbActionIDs()` array MAY mix shapes per-element (one element by PK, another by `email`, etc.).

```json
{ "ids": { "id": "abc123" } }                                  // row, single-field PK
{ "ids": { "tenantId": "acme", "userId": "u1" } }              // row, composite PK
{ "ids": { "email": "jane@example.com" } }                     // row, unique-index addressing
{ "ids": [{ "id": "a" }, { "id": "b" }] }                      // rows, single-field PK
{ "ids": [{ "id": 1 }, { "email": "x@y" }] }                   // rows, mixed identifier shapes
```

Even single-field PK tables MUST send `{ "ids": { "id": "abc" } }`, never bare `"abc"`. `Content-Type: application/json` only.

Field names are **logical** (the `.as` prop names) — never physical column names from `@db.column "..."`. The matcher always operates in logical-name space.

## Preferred row identifier {#preferred-id}

The interface-level annotation `@db.table.preferredId.uniqueIndex(name?: string)` picks a unique-index group as the row's display/addressing identifier. When omitted, `preferredId` defaults to `primaryKeys`.

```atscript
@db.table 'users'
@db.table.preferredId.uniqueIndex 'by_slug'
interface User {
    @meta.id @db.default.uuid
    id: string
    @db.index.unique 'by_slug'
    slug: string
    name: string
}
```

`/meta.preferredId: string[]` is always populated and always logical names. Used by:

- **Navigate URLs** — `$1` substitution walks `preferredId` field declaration order.
- **Backend action body** — clients can POST the preferred-id shape (`{ slug: 'alpha' }`) instead of the PK.
- **Reactive list keys** — guaranteed present on every read response (see [Read-response baseline](./crud#read-response-baseline)).

The table API exposes the same fields via `readable.preferredId: readonly string[]` alongside `readable.primaryKeys`.

## Three Processors

### `'backend'` — server-side POST handler

The most common case. Decorate a method with `@DbAction(name, opts)` plus `@Post(path)` and Moost binds the route normally:

```typescript
@Post("actions/approve")
@DbAction("approve", { label: "Approve", intent: "positive" })
async approve(@DbActionID() id: { id: string }) {
  await this.table.updateOne({ id: id.id, approved: true })
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

The `$1` placeholder is substituted client-side with the row's `preferredId` field values, walking `meta.preferredId` declaration order (NOT object-key insertion order). Each value is `encodeURIComponent`'d; compound preferred-ids are joined with `/`; missing fields render as empty segments (`acme//jane`), not the literal `"undefined"`. The server emits `value` verbatim. See [Preferred row identifier](#preferred-id) and the [identifier rendering helpers](./client#identifier-helpers) (`formatIdentifier` / `encodeNavigateId`) the client exports for use outside `Client.action()`.

`'rows'`- and `'table'`-level navigate entries do NOT substitute `$1` — `value` is sent verbatim.

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

### `@DbAction<TRow, const R>(name, opts?)`

Marks a method as an action. Does **not** register an HTTP route — pair it with `@Post(...)`. The `name` is the action's stable identifier surfaced to the UI.

The decorator is generic over `TRow` (the bound table's row type) and `R` (the literal `requiredFields` tuple). Annotate `<TRow>` at the call site — TS decorators can't infer it from the enclosing controller's class generic. `R` is captured via `const R` from the `requiredFields` literal.

| Option           | Type                                                                | Description                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`          | `string`                                                            | Human-readable label. Required (or use `@Label('...')`).                                                                                                                                                                                                                                                                          |
| `icon`           | `string`                                                            | Icon name; UI maps to its own icon set.                                                                                                                                                                                                                                                                                           |
| `intent`         | `'positive' \| 'negative' \| 'warning' \| 'primary' \| 'secondary'` | Semantic colour/prominence hint. Suggested ordering (most → least): `negative` (destructive) > `warning` (risky-but-not-destructive: retry, force-recompute) > `primary` > `positive` > `secondary`.                                                                                                                              |
| `description`    | `string`                                                            | Tooltip / longer description.                                                                                                                                                                                                                                                                                                     |
| `order`          | `number`                                                            | Display order hint.                                                                                                                                                                                                                                                                                                               |
| `default`        | `boolean`                                                           | Marks this as the level's default (e.g. row dblclick handler).                                                                                                                                                                                                                                                                    |
| `promptText`     | `string \| [string, string]`                                        | Confirmation prompt. Tuple form is `[singular, plural]` — UI picks `[0]` when executing against a single ID, `[1]` otherwise. UI substitutes `$1` (preferred-id values) and `$N` (count).                                                                                                                                         |
| `shortcut`       | `string`                                                            | Single-character keyboard hint. Modifier prefix (Alt+, Ctrl+, bare key) and activation scope are UI/UX concerns; server forwards the character verbatim and does no conflict resolution.                                                                                                                                          |
| `requiredFields` | `readonly FlatKey<TRow>[]` (literal tuple)                          | **Required when `disabled` is set.** Dot-notation paths the predicate references. Server-internal — never on the wire. Type-narrows `disabled`'s row argument and drives projection widening (`@DbActionRow*` fetch + `$actions` augmentation). Listing a relation field is a TS error. See [`requiredFields`](#required-fields). |
| `disabled`       | `(rows: Pick<FlatOf<TRow>, R[number]>[]) => boolean[]`              | Sync batch gate predicate. One verdict per input row, parallel by index. Without `requiredFields` → action dropped at discovery. See [Server-side Gate](#server-side-gate).                                                                                                                                                       |
| `onDisabledRows` | `'reject' \| 'skip'`                                                | `'rows'`-level batch policy. Default `'reject'`. See [Batch mode](#rows-batch-mode).                                                                                                                                                                                                                                              |
| `table`          | `AtscriptDbTable<TRow>`                                             | Required when declaring `disabled` or any `@DbActionRow*` on a class that does **not** extend `AsDbReadableController`. Silently ignored on subclasses (the bound table wins). See [Bound-table requirement](#bound-table-requirement).                                                                                           |

`FlatKey<TRow> = keyof FlatOf<TRow> & string` — dot-paths over scalars; relations excluded. When `TRow = unknown` (no `<TRow>` generic), all string keys are accepted at the type level and `disabled`'s row arg falls back to `any[]`. The runtime still drops `disabled` without `requiredFields`.

::: tip Label resolution
The label resolves in this order: `opts.label` > `@Label('...')` decorator > drop-with-warning. Pick one — both with the same value is benign; mismatched values let `opts.label` win.
:::

### `@DbActionDefault()`

Sugar for `default: true`. Equivalent to passing `opts.default = true` on `@DbAction`. Decorator order does not matter:

```typescript
@Post("actions/edit")
@DbAction("edit", { label: "Edit" })
@DbActionDefault()
async edit(@DbActionID() id: { id: string }) { /* ... */ }
```

The default action is what UIs invoke on row double-click (or the default key in batch toolbars). At most one default per `(controller × level)` — extra defaults are demoted with a warning.

### `@DbActionID()` / `@DbActionIDs()`

Parameter resolvers that read the identifier object(s) from the JSON request body and validate them against the table's legitimate identifications (PK or any `@db.index.unique` group):

```typescript
// Single row, single-field PK
@Post("actions/block")
@DbAction("block", { label: "Block" })
async block(@DbActionID() id: { id: string }) {
  // body: { "ids": { "id": "abc" } }
}

// Single row, composite PK
@Post("actions/promote")
@DbAction("promote", { label: "Promote" })
async promote(@DbActionID() id: { tenantId: string; userId: string }) {
  // body: { "ids": { "tenantId": "acme", "userId": "u1" } }
}

// Single row, unique-index addressing (same controller, same endpoint)
@Post("actions/promote")
async promoteByEmail(@DbActionID() id: { email: string }) {
  // body: { "ids": { "email": "jane@example.com" } } — works as long as `email` is `@db.index.unique`
}

// Multiple rows
@Post("actions/lock")
@DbAction("lock", { label: "Lock Selected" })
async lock(@DbActionIDs() ids: Array<{ id: string }>) {
  // body: { "ids": [{ "id": "a" }, { "id": "b" }] }  (mixed shapes per element are allowed)
}
```

Validation is **strict** — unknown fields are rejected, no coercion. The identifier object's field set must EXACTLY match one legitimate identification on the table. See [Identifier shape](#identifier-shape) for precedence rules and the full contract.

::: warning `rows`-level `ids` is always an array
A `'rows'` action MUST receive a JSON array under `ids`, even when the client invokes it on a single row. Send `{ "ids": [{"id":"a"}] }`, not `{ "ids": {"id":"a"} }`. The `@DbActionIDs()` resolver rejects non-array `ids` with HTTP 400. An empty array `[]` is accepted — `client.action(name, [])` posts `{ "ids": [] }`, and your handler runs with `ids === []`.
:::

::: danger `@DbActionID*` requires a bound table
`@DbActionID()` and `@DbActionIDs()` validate the body against the controller's bound table schema. The bound table is resolved in this order:

1. `opts.table` (any controller class) — declare it on `@DbAction(name, { table })`.
2. Subclass of `AsDbController` / `AsDbReadableController` (wired with `@TableController` / `@ReadableController`) — bound table comes from the controller automatically.
3. Duck-type fallback — a `readable` or `table` instance property on the controller (legacy support).

If none resolves at request time, the resolver throws **HTTP 500** — a server-misconfiguration signal, not a client error. For controllers that genuinely have no typed table, use Moost's `@Body()` and parse / validate the identifier yourself.

When you also declare `disabled` or any `@DbActionRow*` decorator on a non-`AsDbReadableController` class, the duck-type fallback is **NOT** sufficient — you must pass `opts.table` explicitly so discovery can validate at first `/meta` (see [Bound-table requirement](#bound-table-requirement)).
:::

Validation errors flow through the existing validation interceptor and emit the same envelope as DTO failures:

```json
{
  "statusCode": 400,
  "message": "...",
  "errors": [{ "path": "userId", "message": "Missing field \"userId\"" }]
}
```

::: warning No `@Body()` alongside `@DbActionID*`
Mixing `@DbActionID()` or `@DbActionIDs()` with `@Body()` on the same method drops the action with a warning. If your action needs additional input beyond the identifier, model it as `processor: 'custom'` and POST to a regular `@Post`-decorated handler from your UI client.
:::

## Form input — `@InputForm()` {#input-form}

Some actions need more than just an identifier — "Approve with comment", "Transfer amount", "Update status to one of N values". Without a declarative form contract, this falls back to a custom modal hand-rolled per action: the UI doesn't know what fields to render, the server doesn't know how to validate them, and the two drift over time.

`@InputForm(FormType)` collapses this into a single declaration. You point the parameter at a `.as` interface; the discoverer surfaces the form's name on `/meta`; a UI client fetches the schema from a per-controller `GET /meta/form/:name` endpoint and renders a form generically; the user-filled payload arrives at your handler in the action envelope's `input` field.

### Quick example

```atscript
// schema/comment.as
export interface CommentForm {
    note: string

    visibility?: 'public' | 'internal'
}
```

```typescript
import {
  AsDbController,
  TableController,
  DbAction,
  DbActionID,
  InputForm,
} from "@atscript/moost-db";
import { Post } from "@moostjs/event-http";
import { Order } from "./schema/order.as";
import { CommentForm } from "./schema/comment.as";
import { ordersTable } from "./db";

@TableController(ordersTable)
export class OrdersController extends AsDbController<typeof Order> {
  @Post("actions/approve")
  @DbAction("approve", { label: "Approve", intent: "positive" })
  async approve(@DbActionID() id: { id: string }, @InputForm(CommentForm) input: CommentForm) {
    await this.table.updateOne({ id: id.id, status: "approved", note: input.note });
    return { message: `Approved order ${id.id}` };
  }
}
```

`/meta` for `OrdersController` carries `inputForm: "CommentForm"` on the `approve` action:

```json
{
  "actions": [
    {
      "name": "approve",
      "label": "Approve",
      "level": "row",
      "processor": "backend",
      "value": "/orders/actions/approve",
      "intent": "positive",
      "inputForm": "CommentForm"
    }
  ]
}
```

The client (or your UI) fetches the form schema from `GET /orders/meta/form/CommentForm`, renders a form (the `@atscript/ui` form components consume `TSerializedAnnotatedType` directly), then submits the envelope:

```bash
curl -X POST http://localhost:3000/orders/actions/approve \
  -H "Content-Type: application/json" \
  -d '{"ids":{"id":"o1"},"input":{"note":"looks good","visibility":"internal"}}'
```

### Form name resolution

The form's wire name is `FormType.name` — the compiled `.as` class's identifier. Compiled atscript interfaces are real classes with stable names, so `InputForm(CommentForm)` is enough; the decorator never asks for an explicit string.

A single `FormType` may be reused across multiple actions on the same controller — this is fine, the registry maps `name → type`. If two actions on the same controller declare different type refs but share the same `name` (e.g. via two anonymous classes that compile to the same identifier), discovery emits a `[moost-db actions]` warning and **drops** the second action: the discovery endpoint can only serve one schema per name.

### `GET /meta/form/:name` {#meta-form-endpoint}

Every `AsReadableController` subclass automatically exposes:

```
GET /<controller>/meta/form/:name
→ TSerializedAnnotatedType
```

Returns the serialized form schema for the named `@InputForm` type. Annotation allowlist matches `/meta.type` (kept: `meta.*`, `expect.*`, `db.rel.*`, plus a small `db.json` / `db.patch.strategy` / `db.default*` / `db.http.path` whitelist). Schemas are serialized once and cached per `(controller, name)`.

Discovery is lazy: hitting `/meta/form/:name` triggers `discoverActions` if `/meta` hasn't been called yet on this process. Unknown names → HTTP 404.

### Inferring the form from the parameter type

The `FormType` argument may be omitted — `@InputForm()` reads the parameter's reflected design type and resolves the form from it:

```typescript
async approve(@DbActionID() id: { id: string }, @InputForm() input: CommentForm) { ... }
```

Inference relies on `design:paramtypes`, so it works only when the parameter is annotated with the compiled `.as` class through a **value import** — an `import type { CommentForm }` elides the class and reflection yields `Object`. When the reflected type is unusable (plain interface annotation, `import type`, circular import, metadata emission off), decoration **throws at import time** with a fix hint rather than silently serving an action without a form. Passing the form explicitly sidesteps reflection entirely and always wins over the parameter annotation.

::: warning Keep `.as` imports as value imports
Lint rules that force type-only imports (`typescript/consistent-type-imports` and friends) convert `.as` imports used only in type positions to `import type`, breaking inference and any other `design:paramtypes` consumer. Keep such rules off in projects importing `.as` files.
:::

### Validation — built-in

The `input` payload is validated **before your handler fires**: the decorator's resolver runs `FormType.validator(validatorOpts).validate(input ?? {})`. On mismatch it throws `ValidatorError`, which the controllers' built-in `validationErrorTransform()` shapes into a structured HTTP 400 — the same envelope as strict-`ids` failures and DTO validation errors:

```json
{
  "message": "...",
  "statusCode": 400,
  "errors": [{ "path": "note", "message": "Required" }]
}
```

Semantics worth knowing:

- **Absent `input` validates as `{}`** — an all-optional form passes, required fields produce per-field errors. Your handler always receives an object, never `undefined`.
- **Unknown properties are rejected** by the atscript validator's strict default, matching the strict `ids` contract.
- **Validator options** pass through the second argument: `@InputForm(CommentForm, { partial: "deep" })` forwards to `FormType.validator(opts)`.
- An app-level atscript validator pipe (e.g. `validatorPipe()` from `@atscript/moost-validator`) re-validating the same parameter is harmless — same validator, same result.

The decorator also stamps two pieces of param metadata: `atscript_db_action_input_form` (`{ type, name }`, consumed by discovery for `/meta` and `GET /meta/form/:name`) and `atscript_type` (a generic hook for atscript-aware Moost pipes).

### Constraints

- **One `@InputForm` per action.** For multiple structured inputs, compose them into a single `.as` interface (object with sub-objects, or an array field for repeated items).
- **No class-level support.** `@DbActions` / `@DbRowActions` / `@DbRowsActions` cannot bind a form — class-level entries point at endpoints that may live in other controllers, so the form binding can't be derived. If the target endpoint needs a form, declare it with `@DbAction(name, ...) + @InputForm(...)` on the actual handler.
- **Body shape stays the envelope.** With or without `@InputForm`, the body is still `{ ids?, input? }`. Mixing `@InputForm` with `@Body()` on the same method is allowed but unusual: `@Body()` would receive the full envelope while `@InputForm` resolves to `body.input`.

### Composable

```typescript
import { useDbActionInput } from "@atscript/moost-db";

const input = await useDbActionInput().load(); // body.input — `unknown`, no validation
```

For interceptors that need to inspect the form payload alongside the gate-cached identifier or row.

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
Use `processor: 'backend'` at the class level to point an action at a shared or legacy path. The dev-supplied path **must** be served by a `@Post`-bound handler somewhere — typically a method using `@DbActionID()` / `@DbActionIDs()` so the identifier-shaped JSON body is parsed and validated. The meta builder does not validate that the path resolves; that's your contract.
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
import { AsDbController, TableController, DbAction, DbActionID } from "@atscript/moost-db";
import { Post } from "@moostjs/event-http";
import { Order } from "./schema/order.as";
import { ordersTable } from "./db";

@TableController(ordersTable)
export class OrdersController extends AsDbController<typeof Order> {
  @Post("actions/ship")
  @DbAction<Order, ["status"]>("ship", {
    label: "Ship",
    intent: "primary",
    requiredFields: ["status"],
    disabled: (orders) => orders.map((o) => o.status !== "processing"),
  })
  async ship(@DbActionID() id: { id: string }) {
    await this.table.updateOne({ id: id.id, status: "shipped" });
    return { message: "Shipped" };
  }
}
```

The gate interceptor runs **after** auth guards and **before** the handler. When `disabled[i]` is `true`, the request is rejected with `ActionDisabledError` (HTTP 409) and the handler never runs. No guard code in the handler body — by the time `ship()` executes, the gate has already vetted the row.

The predicate signature is `(rows: Pick<FlatOf<TRow>, R[number]>[]) => boolean[]`:

- **Sync** — `Promise<boolean[]>` is rejected by the type system.
- **Batched** — for `'row'`-level the gate calls `disabled([row])` and reads `verdicts[0]`; for `'rows'`-level it calls `disabled(survivorRows)` once.
- **Parallel by index** — verdict array length MUST equal input length. Length mismatch (e.g. `() => [true]` ignoring inputs, or `rows.filter(...).map(...)`) throws HTTP 500 — the gate cannot map verdicts back to rows.
- **Type-narrowed row arg** — only fields listed in `requiredFields` are visible. Reading another field is a TS error.

::: tip Annotate `<TRow>` and `requiredFields` at the call site
TypeScript decorators can't infer `TRow` from the enclosing class generic. Use the explicit form `@DbAction<Order, ["status"]>("ship", { ... })` so the predicate's row arg is type-narrowed and `requiredFields` becomes a literal tuple. Without `<TRow>`, the row arg falls back to `any[]` and you lose the field-narrowing safety net.
:::

::: warning `requiredFields` is mandatory when `disabled` is set
Setting `disabled` without a non-empty `requiredFields` tuple drops the action at discovery with a warning. Field-deps must be declared explicitly — the system uses them to widen `@DbActionRow*` projection AND to widen `$select` for the [`$actions=true`](#actions-augmentation) augmentation. See [`requiredFields`](#required-fields).
:::

### `perRow()` helper {#perrow}

Most predicates are per-row in spirit; `perRow()` lifts a per-row function into the batch shape required by `disabled`. Polarity is preserved — `true` from the inner function means "disabled for that row":

```typescript
import { perRow } from "@atscript/moost-db";

@DbAction<Order, ["status"]>("archive", {
  label: "Archive",
  requiredFields: ["status"],
  disabled: perRow((o) => o.status === "archived"),
})
```

Equivalent to `disabled: (rows) => rows.map(o => o.status === "archived")`. Use the explicit batch form when the predicate genuinely needs the whole list (e.g. cross-row checks).

### Row injection — `@DbActionRow()` / `@DbActionRows()` {#row-injection}

The gate already loaded the row(s) to evaluate `disabled`. The same loaded row(s) can be injected into the handler — no second fetch:

```typescript
import { DbAction, DbActionID, DbActionRow } from "@atscript/moost-db";

@Post("actions/ship")
@DbAction<Order, ["status"]>("ship", {
  label: "Ship",
  requiredFields: ["status"],
  disabled: (orders) => orders.map((o) => o.status !== "processing"),
})
async ship(@DbActionID() id: { id: string }, @DbActionRow() order: Order) {
  // `order` is the same row the gate evaluated. No re-fetch.
  await this.table.updateOne({ id: id.id, status: "shipped", shippedAt: Date.now() });
  return { message: `Shipped order ${id.id}` };
}
```

`@DbActionRow()` / `@DbActionRows()` are also recognized as level signals (see [Action Levels](#action-levels)) — `@DbActionRow()` infers `'row'`, `@DbActionRows()` infers `'rows'`. They are interchangeable with `@DbActionID*` for level inference; mixing row-cardinality and rows-cardinality decorators on the same method drops the action with a warning.

::: tip Row projection is narrowed
The injected row(s) are projected to `identifier-shape ∪ preferredId ∪ requiredFields`. Other table columns are absent. To access fields the gate doesn't read, add them to `requiredFields` (or re-fetch with `findOne`). There is no auto-deps tracker — the field set is exactly what you declare.
:::

In `'rows'` + `'skip'` mode, `@DbActionRows()` resolves to filtered survivors only — the original request rows are not retrievable post-filter.

### `'rows'`-level batch mode {#rows-batch-mode}

For `@DbActionIDs()` / `@DbActionRows()` actions, `onDisabledRows` controls how the gate handles partial failures:

| Mode                 | Predicate evaluated     | On any failure                                                    | Handler runs with  |
| -------------------- | ----------------------- | ----------------------------------------------------------------- | ------------------ |
| `'reject'` (default) | every survivor row once | throws `ActionDisabledError` listing **all** failing IDs          | n/a                |
| `'skip'`             | every survivor row once | filters cached IDs + rows to passing-only; zero survivors → throw | only the survivors |

Identifiers whose row didn't resolve (no DB match) are treated as failing without invoking `disabled` against `undefined`. Surviving rows are passed in one batched `disabled` call.

```typescript
@Post("actions/archive")
@DbAction<Order, ["archived"]>("archive", {
  label: "Archive Selected",
  requiredFields: ["archived"],
  disabled: (orders) => orders.map((o) => o.archived === true),
  onDisabledRows: "skip",   // archive only un-archived rows; ignore the rest
})
async archive(@DbActionIDs() ids: Array<{ id: string }>) {
  // `ids` contains only survivors when `onDisabledRows: 'skip'`.
  await this.table.bulkUpdate(ids.map(({ id }) => ({ id, archived: true })));
  return { message: `${ids.length} orders archived` };
}
```

Two notes:

- `'reject'` is the default because it preserves request-atomicity — partial success is opt-in.
- The cached identifier slot stores **the original submitted object references** — `'skip'`-mode filtering preserves reference equality; `useDbActionIds().load()` returns the filtered subset.

### Bound-table requirement {#bound-table-requirement}

The gate / `@DbActionRow*` need a typed table at request time to load the row(s). Discovery enforces this at first `/meta`:

| Controller                                                               | What's required for `disabled` / `@DbActionRow*`                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `AsDbController` / `AsDbReadableController` subclass                     | nothing — bound table comes from `@TableController` / `@ReadableController`; `opts.table` is silently ignored    |
| Plain Moost controller (no extends, no `readable`/`table` field)         | **MUST** declare `opts.table` on `@DbAction(name, { table })`                                                    |
| Plain Moost controller WITH `readable` / `table` instance field (legacy) | duck-type fallback covers plain `@DbActionID*` only — gates and `@DbActionRow*` still need explicit `opts.table` |

When the requirement isn't met, discovery emits a `[moost-db actions]` warning and **drops** the action from `/meta`. Plain `@DbActionID()` / `@DbActionIDs()` (no gate, no row injection) still works on any controller via the existing duck-type fallback — only gated / row-injecting actions need the explicit `table` opt.

```typescript
// Plain controller — gated action MUST pass opts.table
@Controller()
export class AdminController {
  @Post("orders/ship")
  @DbAction<Order, ["status"]>("ship", {
    label: "Ship",
    table: ordersTable, // ← required
    requiredFields: ["status"],
    disabled: (orders) => orders.map((o) => o.status !== "processing"),
  })
  async ship(@DbActionID() id: { id: string }, @DbActionRow() row: Order) {
    /* ... */
  }
}
```

### `requiredFields` {#required-fields}

`requiredFields` declares the dot-notation field paths the `disabled` predicate reads. It is **server-internal only** — the array never crosses the `/meta` wire. The system uses it for three things:

1. **Type narrowing** — `disabled`'s row argument is `Pick<FlatOf<TRow>, R[number]>[]`. Reading a field not listed in `requiredFields` is a TS error.
2. **`@DbActionRow*` projection widening** — the row(s) injected into the handler include `requiredFields` (in addition to identifier-shape + `preferredId` fields). Other columns are absent.
3. **`$actions=true` augmentation** — when a read endpoint is asked to compute `$actions`, the server widens `$select` to include all `requiredFields` across the controller's row/rows-level actions, runs the predicates, then strips fields the caller didn't request. See [`$actions=true`](#actions-augmentation).

```typescript
@DbAction<Order, ["status", "tenantId"]>("ship", {
  label: "Ship",
  requiredFields: ["status", "tenantId"],
  disabled: (orders) =>
    orders.map((o) => o.status !== "processing" || o.tenantId !== currentTenant.value),
})
```

Without (non-empty) `requiredFields`, `disabled` is dropped at discovery with a `[moost-db actions]` warning.

### Closure-emission pitfall

The wire emits `fn.toString()` of the predicate **verbatim** — captured outer-scope identifiers come along. The server doesn't validate closure-cleanliness; it runs the original closure successfully. The UI, on the other hand, evaluates the stringified source in a different scope and throws `ReferenceError` on captured names.

::: warning Predicate body must reference only the rows arg
Outer-scope identifiers (constants, helpers, imports, `this.*`) work server-side but break UI mirroring. Keep predicates pure and self-contained.

```typescript
// ✅ self-contained — works server + UI
disabled: (orders) => orders.map((o) => o.status !== "processing");

// ❌ captures outer-scope SHIPPED — server runs, UI throws ReferenceError
const SHIPPED = "shipped";
disabled: (orders) => orders.map((o) => o.status === SHIPPED);

// ❌ captures `this` — same problem
disabled: (orders) => orders.map((o) => o.tenantId === this.currentTenant);
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
  "id": { "id": "abc" }
}
```

For `'rows'`-level rejections, `ids: [...]` replaces `id` — each entry is the originally-submitted identifier object (`Record<string, unknown>` in PK or unique-index form):

- `'reject'` mode: `ids` lists ALL failing identifiers in original request order (predicate-rejected + missing-row both included).
- `'skip'` mode with zero survivors: `ids` lists ALL request identifiers.

The error class lives in `@atscript/moost-db` (`ActionDisabledError extends HttpError`). The discriminator `name: 'ActionDisabledError'` lets `@atscript/db-client` construct the typed `ActionDisabledError` subclass on the consumer side — see [HTTP Client — Actions § Error cases](./client#error-cases).

### Class-level dict entries

Class-level `@DbActions` / `@DbRowActions` / `@DbRowsActions` accept `disabled` (with required `requiredFields`) but they do **not** register a server interceptor — the dict entry's `value` may point at an endpoint in another controller (or a method that doesn't exist in this scope). The predicate still runs in two places:

1. **`$actions=true` augmentation** on the read endpoints of the controller declaring the dict — rows get `$actions` reflecting the dict-level predicates.
2. **UI mirror** via the wire `disabled` string — the UI greys out the button.

POSTs to the dict's `value` endpoint are **NOT** blocked here. For symmetric server enforcement at the actual `@Post`-bound handler, also declare `@DbAction(name, { requiredFields, disabled })` on that method.

### Composables

Useful when composing custom interceptors that need access to the gate's cached identifiers / rows without re-parsing the body or re-fetching:

```typescript
import { useDbActionId, useDbActionIds, useDbActionRow, useDbActionRows } from "@atscript/moost-db";

const id = await useDbActionId().load(); // cached, validated single identifier object
const ids = await useDbActionIds().load(); // cached, validated identifier-object array
const row = await useDbActionRow().load(); // cached single row (gate-loaded)
const rows = await useDbActionRows().load(); // cached row array (gate-loaded; filtered in skip mode)
```

All four follow the Wooks `defineWook` pattern and return `{ load() }`. The gate runs at `AFTER_GUARD` priority so reads are safe inside any `INTERCEPTOR`-priority custom interceptor.

In `'skip'` mode, `useDbActionIds().load()` returns the **filtered subset of original objects** (reference-equal to the entries the client posted), and `useDbActionRows().load()` returns the parallel-aligned filtered rows — no `undefined` gaps.

## Request and Response Contracts

### Request body

All action requests use `Content-Type: application/json`. The body is always the envelope `{ ids?, input? }` — see [Body envelope](#body-envelope).

| Level                  | Identification (`ids` field) | Form input (`input` field) | JSON body                                                       |
| ---------------------- | ---------------------------- | -------------------------- | --------------------------------------------------------------- |
| `row`                  | single-field PK              | n/a                        | `{ "ids": { "id": "abc" } }`                                    |
| `row`                  | composite PK                 | n/a                        | `{ "ids": { "tenantId": "acme", "userId": "u1" } }`             |
| `row`                  | unique-index addr.           | n/a                        | `{ "ids": { "email": "jane@example.com" } }`                    |
| `row` + `@InputForm`   | single-field PK              | form payload               | `{ "ids": { "id": "abc" }, "input": { "note": "looks good" } }` |
| `rows`                 | single-field PK              | n/a                        | `{ "ids": [{ "id": "a" }, { "id": "b" }] }`                     |
| `rows`                 | mixed identifications        | n/a                        | `{ "ids": [{ "id": 1 }, { "email": "x@y" }] }`                  |
| `table`                | none                         | n/a                        | empty body (or `{}`)                                            |
| `table` + `@InputForm` | none                         | form payload               | `{ "input": { "msg": "hi" } }`                                  |

Strict typing on `ids` — no coercion, unknown fields rejected. Schema mismatches return HTTP 400 with the same envelope as DTO validation failures. **`rows`-level `ids` is always an array** even for a single identifier — send `{ "ids": [{"id":"a"}] }`, never `{ "ids": {"id":"a"} }`. Validation of `input` depends on a user-installed atscript validator pipe — see [Form input — Validation](#input-form).

### Success response

Backend actions may return any JSON. There is one **convention** UI clients SHOULD honour:

> If the response body has a top-level `"message": string`, the UI displays it (toast, banner, etc.). Otherwise the UI uses a generic per-level message ("Action completed", "5 rows updated", …).

This is a documented convention, not a runtime contract — no `TDbActionResult` type, no server-side validation. You're free to return whatever shape your client expects:

```typescript
@Post("actions/block")
@DbAction("block", { label: "Block" })
async block(@DbActionID() id: { id: string }) {
  await this.table.updateOne({ id: id.id, blocked: true })
  return { message: `User ${id.id} blocked` }   // ← UI toasts this
}

@Post("actions/lock")
@DbAction("lock", { label: "Lock Selected" })
async lock(@DbActionIDs() ids: Array<{ id: string }>) {
  await this.table.bulkUpdate(ids.map(({ id }) => ({ id, locked: true })))
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
async block(@DbActionID() id: { id: string }) {
  /* runs only if adminGuard passes */
}
```

If the guard rejects the request, the handler body never runs and the auth-failure response is returned — exactly as for any other Moost handler.

The internal gate interceptor (registered automatically when `disabled` or `@DbActionRow*` is present) runs at `AFTER_GUARD` priority — so auth guards run first, the gate runs after, then any custom `INTERCEPTOR`-priority interceptors, then the handler.

### Worked recipe — auth + gate + `requiredFields` {#auth-gate-recipe}

A full row-level action that combines an `@Authenticate` admin guard, a `disabled` predicate gated on row state, `@DbActionRow()` row injection, and audited fields:

```typescript
import {
  AsDbController,
  TableController,
  DbAction,
  DbActionID,
  DbActionRow,
} from "@atscript/moost-db";
import { Post, Authenticate } from "@moostjs/event-http";
import { Order } from "./schema/order.as";
import { ordersTable } from "./db";

@TableController(ordersTable)
export class OrdersController extends AsDbController<typeof Order> {
  @Post("actions/refund")
  @Authenticate(adminGuard)
  @DbAction<Order, ["status", "paidAmount"]>("refund", {
    label: "Refund",
    intent: "negative",
    requiredFields: ["status", "paidAmount"],
    disabled: (orders) => orders.map((o) => o.status !== "paid" || o.paidAmount <= 0),
    promptText: ["Refund order $1?", "Refund $N orders?"],
  })
  async refund(
    @DbActionID() id: { id: string },
    @DbActionRow() order: Pick<Order, "id" | "status" | "paidAmount">,
  ) {
    // adminGuard passed, the gate already verified status === 'paid'
    // and paidAmount > 0 against this exact row.
    await this.processRefund(order);
    await this.table.updateOne({ id: id.id, status: "refunded" });
    return { message: `Refunded order ${id.id}` };
  }
}
```

What happens per request:

1. `@Authenticate(adminGuard)` — Moost runs the auth guard. On failure: standard auth-failure response, handler never runs.
2. `requiredFields` widens the projection used to load the row.
3. The gate interceptor (`AFTER_GUARD`) loads the row, evaluates `disabled([row])`. On failure: HTTP 409 `ActionDisabledError`.
4. `@DbActionRow()` injects the gate-loaded row into the handler — no second fetch.
5. Handler runs.

The same `disabled` predicate also drives:

- **`/meta.actions[].disabled`** — emitted as `fn.toString()` for the UI to grey out the button.
- **`$actions=true` augmentation** on read endpoints — each row carries `$actions: string[]` listing the actions whose predicate did NOT reject it.

::: tip Keep `disabled` self-contained
The predicate's source string is shipped to UI clients verbatim. Outer-scope identifiers work server-side but break UI evaluation — see [Closure-emission pitfall](#closure-emission-pitfall).
:::

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
  disabled?: string; // fn.toString() — UI mirror only; server-evaluated availability is in row-level $actions
  inputForm?: string; // FormType.name when @InputForm declared; client fetches GET /meta/form/<name>
}
```

`requiredFields` is **server-internal only** — it never crosses the wire. Predicate field-deps are declared by the dev, drive server-side projection widening, and reach UI clients implicitly via the row-level [`$actions`](#actions-augmentation) overlay rather than as an explicit `$select` hint.

The server emits `fn.toString()` of `disabled` verbatim — closures and outer-scope references included. No parsing, no AST transform. The UI evaluates the source against a level-specific scope (the row for `'row'`-level, each row for `'rows'`-level) to grey-out / hide the button. Server enforcement is authoritative; this field is purely a UI hint.

Discovery is **lazy** — it runs on the first `GET /meta` request and the result is cached alongside the rest of the meta envelope. Startup is unaffected. Warnings (missing label, missing `@Post`, `@Body` co-occurrence, duplicate `default`, …) emit on that first call, not at `app.init()` time.

The `@atscript/db-client` consumer reads `actions` off the meta response — see [HTTP Client — Metadata](./client#meta) — and exposes a typed `client.action<R>(name, id?)` helper that resolves and dispatches actions for you. See [HTTP Client — Actions](./client#actions) for the consumer-side API.

## `$actions=true` — server-evaluated row availability {#actions-augmentation}

Asking which actions a row qualifies for can be answered server-side as part of the read. Set `$actions=true` on any read endpoint and every returned row carries an additional `$actions: string[]` field — the names of `'row'` and `'rows'`-level actions whose `disabled` predicate did NOT reject this row:

```bash
GET /users/query?status=active&$actions=true
# → [{ "id": "u1", "status": "active", "$actions": ["edit", "block"] }, ...]
```

Available on `/query`, `/pages`, `/one`, `/one/:id` (including `$search` and vector-search paths). NOT augmented on `$count` and `$groupBy` responses (no row shape).

Action ordering follows `/meta.actions[]` declaration order. `'table'`-level actions never appear in `$actions`. Actions without a `disabled` predicate are unconditionally present in every row's array.

### Pipeline

For each request that sets `$actions=true` on a controller extending `AsDbReadableController`:

1. Discover row/rows-level action envelopes (memoized per controller ctor).
2. Filter through the per-request `applyMetaOverlay()` hook — actions stripped by the overlay are absent from `$actions`. The `meta()` call is skipped when `applyMetaOverlay` is the default no-op.
3. Pre-widen `$select` to union all `requiredFields` across the surviving envelopes (only when the caller restricted projection).
4. Run the underlying read (find / pages / search / vector / findById).
5. Run each `disabled` predicate **once** against the full result set (length-mismatch verdict → HTTP 500, same contract as the gate).
6. Strip widened-only fields the caller didn't ask for, so the response shape matches the original `$select`.

### Programmatic use from `@atscript/db-client`

```typescript
const r = await users.query({
  filter: { active: true },
  controls: { $actions: true } as const,
});
r[0].$actions; // typed `string[] | undefined` via ClientResponse<T, Q>
```

The control is also accepted on the URL (`?$actions=true` or `?$actions=1`); the server coerces the string back to a boolean before DTO validation.

### Same predicate, three call sites

The `disabled` predicate runs in three places per request lifecycle:

- **`$actions=true` augmentation** — against the full result set on the read endpoints.
- **Server-side gate** — against the loaded row(s) at POST time, blocking the handler with HTTP 409 on any rejection.
- **UI mirror** — the `fn.toString()` source is evaluated client-side to grey out the button before invocation.

Server enforcement on POST is authoritative. `$actions` and the UI mirror are availability hints used to render correctly without an extra round-trip.

## Validation Rules and Warnings

The meta builder enforces several rules. Every violation emits a console warning prefixed `[moost-db actions]` and **drops** the offending action from `/meta` rather than throwing — this keeps `/meta` deliverable even with misconfigurations.

| Rule                                                                                | Outcome                          |
| ----------------------------------------------------------------------------------- | -------------------------------- |
| `@DbAction` method has no `@Post(...)`                                              | warn + drop                      |
| `@DbAction` method's only verb is non-POST (`@Get`, `@Put`, …)                      | warn + drop                      |
| Both `@DbActionID()` and `@DbActionIDs()` on the same method                        | warn + drop                      |
| `@DbActionID*` / `@DbActionRow*` co-occurs with `@Body()`                           | warn + drop                      |
| Method has no label (no `opts.label`, no `@Label`)                                  | warn + drop                      |
| `@DbActionDefault()` applied without a corresponding `@DbAction(name)`              | warn + drop                      |
| Class-level `'navigate'` or `'backend'` entry has missing/empty `value`             | warn + drop                      |
| Class-level `'custom'` entry supplies a `value`                                     | warn + drop                      |
| Two actions with `default: true` at the same level                                  | first wins, second demoted, warn |
| `'table'`-level action declares `disabled`                                          | warn + drop                      |
| Gated / row-injecting on a non-`AsDbReadableController` class without `opts.table`  | warn + drop                      |
| `disabled` set without (non-empty) `requiredFields`                                 | warn + drop                      |
| Mixing row + rows cardinality (`@DbActionID*` / `@DbActionRow*`) on the same method | warn + drop                      |
| Duplicate action name within the same controller                                    | warn + drop second declaration   |
| Two actions sharing the same `@InputForm` form name with **different** type refs    | warn + drop second declaration   |

The single greppable prefix `[moost-db actions]` makes it easy to detect issues in CI logs.

## Value-Help Controllers Are Excluded

`AsValueHelpController` and `AsJsonValueHelpController` (used for FK pickers and dictionary surfaces) do **not** participate in action discovery. Action decorators applied to them are silently ignored — `actions` is always emitted as `[]` for shape uniformity. Adding actions to a value-help picker doesn't make sense; the contract is intentionally narrow.

## Inspecting Action Metadata — `getAtscriptDbMate()`

`@atscript/moost-db` writes its action metadata to the standard Moost mate workspace, but with a typed accessor so consumers don't have to retype string keys or hand-cast results:

```typescript
import { getAtscriptDbMate } from "@atscript/moost-db";

const mate = getAtscriptDbMate();

// Class- / method-level
const meta = mate.read(OrdersController.prototype, "approve");
meta?.atscript_db_action; // { name, opts } | undefined  — written by @DbAction
meta?.atscript_db_actions; // class-level dict entries written by @DbActions / @DbRowActions / …

// Param-level
meta?.params?.[0]?.atscript_db_action_param; // 'id' | 'ids' — written by @DbActionID / @DbActionIDs
meta?.params?.[0]?.atscript_db_action_row; // true — written by @DbActionRow
meta?.params?.[0]?.atscript_db_action_rows; // true — written by @DbActionRows
meta?.params?.[0]?.atscript_db_action_input_form; // { type, name } — written by @InputForm
meta?.params?.[0]?.atscript_type; // FormType — also written by @InputForm
```

The returned `Mate` is the same singleton as `getMoostMate()` from `moost`, but narrowed via TypeScript declaration merging to every key `@atscript/moost-db` writes. Reach for it when:

- Writing a custom Moost pipe that reads `atscript_type` to validate `@InputForm` payloads.
- Building tooling that introspects the action surface without going through `/meta`.
- Composing your own decorator on top of `@DbAction` / `@InputForm` and needing to read what they wrote.

### Companion type exports

| Export                   | Use for                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `AtscriptDbMate`         | Return type of `getAtscriptDbMate()` — the fully-typed `Mate` shape.                                |
| `AtscriptDbMeta`         | Class- / method-level keys (`atscript_db_action`, `atscript_db_actions`, …).                        |
| `AtscriptDbParamsMeta`   | Param-level keys (`atscript_db_action_param`, `atscript_db_action_input_form`, `atscript_type`, …). |
| `TDbActionMeta`          | `{ name, opts }` payload written by `@DbAction`.                                                    |
| `TDbActionInputFormMeta` | `{ type, name }` payload written by `@InputForm`.                                                   |
| `TDbActionParamKind`     | `'id' \| 'ids'` written by `@DbActionID` / `@DbActionIDs`.                                          |
| `TDbClassActionMeta`     | Class-level dict entry written by `@DbActions` and the level-pinned shortcuts.                      |

## Next Steps

- [HTTP Client](./client) — Consume the `actions` field from `@atscript/db-client`
- [Customization](./customization) — Hooks for intercepting CRUD (different concept; complements actions)
- [HTTP Setup](./) — Controller installation and wiring
