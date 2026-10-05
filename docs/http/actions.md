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

Every action POST body is a JSON object **envelope** with optional fields:

```ts
{
  ids?: object | object[],   // identifier(s) — see Identifier shape below
  input?: unknown,           // payload for @InputForm — see Form input below
  query?: { q: string, … },  // since 0.1.147: "every row matching" — see Query targets
}
```

`query` is accepted only by `'rows'` actions declaring `queryTarget`, never together with `ids` — see [Query targets](./query-targets). Since 0.1.147 a `query` key on any other `'rows'` action is a 400 `TARGET_INVALID` (it used to be ignored), and every `'rows'` action reads and validates `ids` in its gate interceptor — the same 400 as before, but ahead of interceptors of a lower priority and before the handler's arguments resolve.

The envelope shape is fixed: arrays or scalars at the body root are rejected with HTTP 400 `ValidatorError`. This is a **breaking change** from the pre-`@InputForm()` shape that placed identifiers at the root — older clients sending the bare identifier (e.g. `{"id":"abc"}` or `[{"id":"a"}]`) need to be updated to wrap them in `ids`.

Empty `{}` is always valid — it means "table-level action, no input, no identifier". A `'table'`-level action with no `@InputForm` may be invoked with no body at all; the client SHOULD omit the body in that case (and `@atscript/db-client` does).

## Identifier shape {#identifier-shape}

The `ids` field is **always an object** (single) or **array of objects** (multi) — never a scalar. Each object's field set must EXACTLY match one **legitimate identification** on the table:

- the **primary key** (`primaryKeys`), or
- any declared `@db.index.unique` group (single-field or compound).

A unique group over a field the controller's [`hasField`](./customization#hasfield) hides is not an identification (since 0.1.134). It is rejected like an unknown shape, and the error does not list it.

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

Identifier values must be scalars (since 0.1.143). An object or array value, such as `{ "id": { "$ne": null } }`, is rejected with 400 whatever the field's type.

A `'rows'` request carries at most `maxIds` identifiers (default 1000, since 0.1.143). See [Id-count cap](#id-cap).

### Resolving ids — `resolveRowIds` {#resolve-row-ids}

Since 0.1.148. A controller that overrides [`resolveRowIds(ids, ctx)`](./customization#resolverowids) maps each action id through it once per request (`ctx.purpose === "action"`, with `ctx.action` and `ctx.level`). Handlers (`@DbActionID()` / `@DbActionIDs()`, `useDbActionId(s)`, `@DbActionRow(s)`), [`actionRowScope`](#action-row-scope) and `target.batches()` receive the resolved ids; a `'rows'` request whose ids resolve to the same row keeps the first. The [`ActionDisabledError`](#action-disabled-error) ids and a [target summary](./query-targets)'s `skipped` / `failed` ids are the ones the client sent. A query target's ids come from rows and never go through the hook. The contract and the safety rules are on the [`resolveRowIds`](./customization#resolverowids) page.

## Row scoping {#row-scoping}

Since 0.1.143, action ids and rows obey the controller's row overlay. The overlay is the one `GET /one/:id` uses: `transformOne({})`, which defaults to [`transformFilter`](./customization#transformfilter). Since 0.1.145 the loaded rows must also lie inside the action's own [`actionRowScope`](#action-row-scope). Whether the gate verifies a request's ids before the handler runs depends on what there is to verify (see the [gate table](#gate-table) below). This applies with or without `disabled`:

| Action                                                       | Id outside the overlay                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'row'`: `@DbActionRow()` or a `disabled` gate               | The row load includes the overlay. The request gets the same 404 as a missing row: `"Row not found for action identifier"`.                                                 |
| `'row'`: `@DbActionID()` only                                | With an overlay or a restricting `actionRowScope`, the row is loaded (`id AND overlay AND scope`) before the handler, like `@DbActionRow()`. The request gets the same 404. |
| `'rows'`: `@DbActionIDs()` / `@DbActionRows()`, gated or not | The id fails like a missing id: same position in `ids`, `null` reason. `onDisabledRows` then applies (`'reject'` → 409, `'skip'` → dropped).                                |

An out-of-scope id gets exactly the answer a nonexistent id gets. Nothing in the status, body, `ids` or `reasons` tells them apart. A `disabled` reason is never computed for an out-of-scope row, so the reason cannot leak that row's state. The handler never runs for an out-of-scope id.

```typescript
@TableController(OrderTable)
export class OrdersController extends AsDbController<typeof OrderTable> {
  protected override transformFilter(filter: FilterExpr): FilterExpr {
    return { $and: [filter, { ownerId: currentUserId() }] };
  }

  @Post("actions/cancel")
  @DbAction("cancel", { label: "Cancel" })
  async cancel(@DbActionID() id: { id: string }) {
    // Reached only for the caller's own orders. Any other id → 404.
  }
}
```

Notes:

- The check costs nothing when there is nothing to verify (see the [gate table](#gate-table)). No query is added. Without an overlay and a restricting scope, `'rows'` actions keep an unmatched id as an `undefined` gap in `@DbActionRows()` (gated actions still fail it).
- Under an overlay, an ungated `'rows'` action rejects unmatched ids by default, missing and out-of-scope alike. Set `onDisabledRows: 'skip'` to drop them instead.
- The checks run in an interceptor that `@DbAction` registers. A `@DbActionID*` param on a route without `@DbAction` is not checked. `@DbActionRow*` loads still include the overlay.
- The overlay applies only to the controller's own table. An `opts.table` binding on a plain controller has no overlay.
- A `requiredFields` entry that the controller's [`hasField`](./customization#hasfield) hides is never loaded, nor is a `@db.column.derived` field whose source it hides. The `disabled` predicate and `@DbActionRow*` see it as `undefined`, so a hidden column never drives a verdict.

### What the gate verifies {#gate-table}

Since 0.1.148 the gate asks the action's [`actionRowScope`](#action-row-scope) **first**, with the request's ids, and loads rows only when its answer restricts. An override that restricts nothing — it returns `undefined`, `null` or `{}` for this action, as a permission layer does for the actions a caller may run on any row — makes the gate load nothing ([upgrading](/guide/upgrading#v0-1-148-behavior)).

| Row overlay | `actionRowScope` for the action         | Gate on `'row'` / ungated `'rows'`                                                                                                                                                  |
| ----------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none        | not overridden, or unrestricted         | Nothing. A missing id reaches the handler: `@DbActionRow` / `useDbActionRow` answer 404 when they load it; an id-only handler sees the miss itself (for example `matchedCount: 0`). |
| none        | restricted, ids in `preferredId` shape  | One query `id AND scope`. A miss or an out-of-scope id gets the same 404 / failing id.                                                                                              |
| none        | restricted, ids in a unique-index shape | The row loads, then the scope is asked for the loaded candidate (the hook sees its `preferredId`).                                                                                  |
| present     | any                                     | The row loads as `id AND overlay`, then the scope is asked for the loaded candidate.                                                                                                |

The gate verifies existence only when it has something to verify: a row overlay, a non-empty action scope, a `disabled` rule or a query target. `403` means no grant (from `prepareRequest`); an out-of-scope id and a missing one stay indistinguishable (404 / failing id with a `null` reason). The hook's presence no longer changes behavior — only its answer does — and no new oracle appears, because the unrestricted case is exactly a controller without the hook. A `disabled` gate and handler-side `@DbActionRow*` loads fold a restricting scope into their one row query, too.

### Per-action scope — `actionRowScope` {#action-row-scope}

Since 0.1.145. A permission layer may let a caller read many rows but run an action on only some of them, for example `approve` only on their own orders. Override `actionRowScope(actionName, ctx)` to return the rows that action may run on, as a filter. `undefined` or `{}` means no restriction, which is the default:

```typescript
@TableController(OrderTable)
export class OrdersController extends AsDbController<typeof OrderTable> {
  protected override actionRowScope(action: string) {
    return action === "approve" ? { ownerId: currentUserId() } : undefined; // may be async
  }
}
```

- **Enforced by the action gate.** The action's ids and rows load under the row overlay above and must match this filter (without an overlay the filter joins the load — see the [gate table](#gate-table)), with the same outcomes as the table: an out-of-scope id gets `404 "Row not found for action identifier"` on `'row'` actions and fails like a missing id on `'rows'` actions. You need no `transformOne` override for this.
- **Reflected in reads.** [`$actions`](#actions-row-scope) and [`GET /meta/actions/:id`](#available-actions) list the action only on rows inside its scope.
- It runs after [`prepareRequest`](#preparerequest-on-actions), at most once per action per evaluation, and may be async. Equal filters share one query: the same object, or (since 0.1.147) structurally equal ones.
- The filter may use fields [`hasField`](./customization#hasfield) hides. It is never exposed in a response.
- It applies only to the controller's own table, like the overlay. Nothing extra runs when it is not overridden.

The scope may depend on **related** rows through a [relational predicate](/api/queries#relational-filters) (since 0.1.147). It is a server-side filter, so the relation needs no `@db.rel.filterable` and no [`transformRelationFilter`](./customization#transformrelationfilter) applies. On an issue controller, `resolve` runs only on issues whose ticket is open and belongs to one of the caller's teams:

```typescript
@TableController(IssueTable)
export class IssuesController extends AsDbController<typeof IssueTable> {
  protected override actionRowScope(action: string) {
    return action === "resolve"
      ? { ticket: { $some: { teamId: { $in: currentTeams() }, status: "open" } } }
      : undefined;
  }
}
```

The same filter drives the action gate, [`$actions`](#actions-row-scope) and [`GET /meta/actions/:id`](#available-actions).

#### Scopes that depend on the candidate rows {#action-row-scope-candidates}

Since 0.1.147 the hook receives the candidate rows as its second argument, a `TDbActionScopeContext`. Use it when the rule can't be written as a relational predicate — for example the rule's table has no declared relation to this one, or the check is not a filter at all. Here the issue table carries a `ticketKey` but declares no `ticket` relation:

```typescript
import type { TDbActionScopeContext } from "@atscript/moost-db";

@TableController(IssueTable)
export class IssuesController extends AsDbController<typeof IssueTable> {
  protected override async actionRowScope(action: string, ctx: TDbActionScopeContext) {
    if (action !== "resolve") return undefined;
    const issues = await ctx.loadRows(["ticketKey"]);
    const tickets = await ticketTable.findMany({
      filter: { key: { $in: issues.map((i) => i.ticketKey) }, teamId: currentTeamId() },
      controls: { $select: ["key"] },
    });
    return { ticketKey: { $in: tickets.map((t) => t.key) } };
  }
}
```

| `ctx` member       | What it is                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purpose`          | `"execute"` — the action gate; `"rows"` — `$actions` on a read (also a [view's delegated verdicts](./view-actions)); `"available"` — `GET /meta/actions/:id`.                                                                                                  |
| `ids`              | The candidates' identities (`preferredId` shape), deduped, never empty. The same array object for every action of one evaluation, so you can memoize on it with a `WeakMap`. At `"execute"` without a row overlay these are the **request's** ids (see below). |
| `loadRows(fields)` | The candidates' `fields` plus their id fields, read from the bound table without any overlay. Memoized per evaluation and field set. Nothing it reads reaches the response.                                                                                    |

- Candidates are bounded: the read's rows (at most its `$limit`), the action's ids (at most `maxIds`), one batch of a [query target](./query-targets), or the single row.
- Candidates are inside the row overlay: ids that fall outside it never reach the hook. On the action route **without a row overlay** (and ids in `preferredId` shape, not a query target) the hook is asked **before** any load: `ctx.ids` are then the request's ids and may name rows that don't exist — `ctx.loadRows` omits them. With no candidate, the hook is not called and no scope query runs.
- The result only restricts the candidates. A throw fails the request; it is never read as "allow".
- **Order on the action route:** `prepareRequest` → row overlay (before the body is read) → ids from the body → [`resolveRowIds`](#resolve-row-ids) → `actionRowScope` (before the load when there is no overlay) → row load → `actionRowScope` on the loaded candidates otherwise.
- One-parameter overrides keep compiling and behaving as before, and so does `super.actionRowScope(name)` — `ctx` is optional in the signature only; moost-db always passes it.
- An `actionRowScope` override on a controller over a table without a primary key (a view) is warned about only when the controller has row actions of its own — their `$actions` can't be scoped without an identity.

## prepareRequest on actions {#preparerequest-on-actions}

Since 0.1.143, every `@DbAction` handler — `'row'`, `'rows'` and `'table'` level, gated or not — runs the controller's [`prepareRequest`](./customization#preparerequest) with `{ endpoint: "action", action: "<name>" }`. It runs once per request, after the guards and **before** anything reads the request's ids, loads its rows or builds its row overlay: id validation (which consults [`hasField`](./customization#hasfield)), `@DbActionRow*` loads, the `disabled` gate and the row scoping above all see the policy it resolved. A throw aborts the request with the thrown error, even when the body is malformed.

```typescript
@TableController(OrderTable)
export class OrdersController extends AsDbController<typeof OrderTable> {
  protected async prepareRequest(ctx: TDbRequestContext) {
    // ctx.endpoint === "action", ctx.action === "cancel" for the route below
    const scopes = await loadScopes(ctx.action ?? ctx.endpoint);
    if (!scopes) throw new HttpError(403);
    requestScopes.set(scopes); // read back by transformFilter / hasField
  }

  @Post("actions/cancel")
  @DbAction("cancel", { label: "Cancel" })
  async cancel(@DbActionID() id: { id: string }) {}
}
```

A permission layer that resolves its policy in `prepareRequest` therefore needs no action guard of its own. Controllers that don't define `prepareRequest` pay nothing: the interceptor returns without awaiting. A plain controller (not an `AsReadableController` subclass) has no `prepareRequest`; its `'table'`-level actions get no interceptor at all.

## Id-count cap {#id-cap}

`@DbActionIDs()` / `@DbActionRows()` accept at most `maxIds` identifiers per request. The default is 1000 (since 0.1.143). A longer `ids` array is rejected with 400 before any row is loaded:

```json
{
  "statusCode": 400,
  "errors": [{ "path": "", "message": "Too many identifiers: 1500 (at most 1000 per request)" }]
}
```

To raise or lower the cap for one action:

```typescript
@DbAction("purge", { label: "Purge", maxIds: 5000 })
```

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
| `disabled`       | `(rows: Pick<FlatOf<TRow>, R[number]>[]) => (boolean \| string)[]`  | Sync batch gate predicate. One verdict per input row, parallel by index: truthy = disabled, a string also gives the [reason](#disabled-reasons). Without `requiredFields` → action dropped at discovery. See [Server-side Gate](#server-side-gate).                                                                               |
| `onDisabledRows` | `'reject' \| 'skip'`                                                | `'rows'`-level batch policy. Default `'reject'`. See [Batch mode](#rows-batch-mode).                                                                                                                                                                                                                                              |
| `maxIds`         | `number`                                                            | `'rows'` level: the most identifiers one request may carry. Default `1000`. Above it → 400. Server-internal. Since 0.1.143. See [Id-count cap](#id-cap).                                                                                                                                                                          |
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

The id the handler receives is the **resolved** one when the controller overrides [`resolveRowIds`](#resolve-row-ids).

Validation is **strict** — unknown fields are rejected, no coercion. The identifier object's field set must EXACTLY match one legitimate identification on the table. See [Identifier shape](#identifier-shape) for precedence rules and the full contract.

::: warning `rows`-level `ids` is always an array
A `'rows'` action MUST receive a JSON array under `ids`, even when the client invokes it on a single row. Send `{ "ids": [{"id":"a"}] }`, not `{ "ids": {"id":"a"} }`. The `@DbActionIDs()` resolver rejects non-array `ids` with HTTP 400. An empty array `[]` is accepted — `client.action(name, [])` posts `{ "ids": [] }`, and your handler runs with `ids === []`. An array longer than [`maxIds`](#id-cap) (default 1000) is rejected with 400.
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
- **Class-level entries declare a form, they don't validate it.** `@DbActions` / `@DbRowActions` / `@DbRowsActions` entries take `inputForm` — see [Input forms on class-level entries](#class-level-input-form). Validation still happens only in the handler that owns the route, through its own `@InputForm(...)` parameter.
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

### Input forms on class-level entries {#class-level-input-form}

Since 0.1.136. A class-level entry can tell the UI which form to collect before the action runs. This is the case when a listing controller shows a `'backend'` action whose handler lives on another controller. Pass the form in one of two ways:

```typescript
import { ShipForm } from "./forms.as";

@TableController(ordersTable)
@DbRowActions({
  // 1. The compiled .as type — served by THIS controller's /meta/form/ShipForm
  ship: {
    label: "Ship",
    processor: "backend",
    value: "/api/shipping/actions/ship",
    inputForm: ShipForm,
  },
  // 2. The form's name + the path where another controller serves its schema
  refund: {
    label: "Refund",
    processor: "backend",
    value: "/api/payments/actions/refund",
    inputForm: { name: "RefundForm", url: "/api/payments/meta/form/RefundForm" },
  },
})
export class OrdersController extends AsDbController<typeof Order> {}
```

| `inputForm`         | `/meta` entry                     | Schema served by                         |
| ------------------- | --------------------------------- | ---------------------------------------- |
| compiled `.as` type | `inputForm: Type.name`            | this controller's `GET /meta/form/:name` |
| `{ name, url }`     | `inputForm: name`, `formUrl: url` | whatever serves `url`                    |

Any other shape is a type error. JavaScript callers that pass one anyway, or set `inputForm` on a `processor: 'navigate'` entry, get the entry dropped with a warning.

`url` is a server-absolute path, the same convention as `value` for `'backend'` actions: clients prefix their base URL. [`getActionForm()`](./client#get-action-form) in `@atscript/db-client` handles both shapes.

The entry only describes the form. The handler behind `value` must still validate `input`, normally with its own `@InputForm(ShipForm)` parameter. A type registered here shares this controller's form-name registry with method-level `@InputForm` parameters, and a name clash with a different type drops the entry.

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

The gate interceptor runs **after** auth guards and **before** the handler. When `disabled[i]` is truthy, the request is rejected with `ActionDisabledError` (HTTP 409) and the handler never runs. No guard code in the handler body — by the time `ship()` executes, the gate has already vetted the row.

The predicate signature is `(rows: Pick<FlatOf<TRow>, R[number]>[]) => (boolean | string)[]`:

- **Truthy = disabled** — `false` (or `""`) enables the row, `true` disables it, a non-empty string disables it with that [reason](#disabled-reasons).
- **Sync** — a `Promise` return is rejected by the type system.
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

### Disabled reasons {#disabled-reasons}

Return a string instead of `true` to say **why** the action is disabled for that row. The string is the human-readable reason; `false` still means enabled:

```typescript
@DbAction<Order, ["status"]>("ship", {
  label: "Ship",
  requiredFields: ["status"],
  disabled: perRow((o) => {
    if (o.status === "shipped") return "Order already shipped";
    if (o.status !== "processing") return "Only processing orders can be shipped";
    return false;
  }),
})
```

The reason reaches clients in two places:

- **POST rejected by the gate** — the 409 `message` is the reason, and the body carries `reason` / `reasons`. See [`ActionDisabledError`](#action-disabled-error).
- **`$actions=true` reads** — each row gets `$disabledReasons: { ship: "Order already shipped" }` next to `$actions`, so a UI can show a disabled button with a tooltip instead of hiding it. See [`$disabledReasons`](#disabled-reasons-augmentation).

Boolean predicates are unaffected — `true` still disables without a reason, and nothing new appears on the wire. The verdict type is exported as `TDbActionDisabledVerdict` (`boolean | string`) from `@atscript/moost-db`.

::: warning Reasons are user-facing text
Reasons go to the browser verbatim. Don't put data in them that the caller may not see (other rows' values, internal state) — the `requiredFields` projection strip does not apply to reason strings.
:::

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
The injected row(s) are projected to `identifier-shape ∪ preferredId ∪ requiredFields`. Other table columns are absent. To access fields the gate doesn't read, add them to `requiredFields` (or re-fetch with `findOne`). There is no auto-deps tracker — the field set is exactly what you declare. Since 0.1.143, `requiredFields` that the controller's `hasField` hides are left out, and rows outside the controller's row overlay are not loaded. See [Row scoping](#row-scoping).
:::

In `'rows'` + `'skip'` mode, `@DbActionRows()` resolves to filtered survivors only — the original request rows are not retrievable post-filter.

### `'rows'`-level batch mode {#rows-batch-mode}

For `@DbActionIDs()` / `@DbActionRows()` actions, `onDisabledRows` controls how the gate handles partial failures:

| Mode                 | Predicate evaluated     | On any failure                                                             | Handler runs with  |
| -------------------- | ----------------------- | -------------------------------------------------------------------------- | ------------------ |
| `'reject'` (default) | every survivor row once | throws `ActionDisabledError` listing **all** failing IDs (+ their reasons) | n/a                |
| `'skip'`             | every survivor row once | filters cached IDs + rows to passing-only; zero survivors → throw          | only the survivors |

Identifiers whose row didn't resolve (no DB match, or outside the controller's [row overlay](#row-scoping)) are treated as failing without invoking `disabled` against `undefined`. Their `reasons` entry is `null`. Surviving rows are passed in one batched `disabled` call.

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
- `'skip'` drops rows disabled with a [reason](#disabled-reasons) exactly like `true` ones. Since 0.1.147 the handler can read what was skipped, with the reasons, from `useDbActionTarget().summary()` — see [Query targets](./query-targets#summary).

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

Since 0.1.143, a `requiredFields` entry that the controller's [`hasField`](./customization#hasfield) hides for the current request is never loaded, nor is a `@db.column.derived` field whose source it hides. The predicate sees it as `undefined`, and the `@DbActionRow*` row does not carry it.

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

### `ActionDisabledError` (HTTP 409) {#action-disabled-error}

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

For `'rows'`-level rejections, `ids: [...]` replaces `id` — each entry is the originally-submitted identifier object (`Record<string, unknown>` in PK or unique-index form). `id` / `ids` are the ids **you sent**, even when [`resolveRowIds`](#resolve-row-ids) mapped them to others:

- `'reject'` mode: `ids` lists ALL failing identifiers in original request order (predicate-rejected + missing-row both included).
- `'skip'` mode with zero survivors: `ids` lists ALL request identifiers.

When the predicate returned [reasons](#disabled-reasons) (since 0.1.141):

| Field     | Present when                                                      | Value                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`  | every rejected row has the same reason (`'row'`: the row has one) | that reason                                                                                                                                                                   |
| `reasons` | `'rows'` level, at least one rejected row has a reason            | `(string \| null)[]` aligned index-by-index with `ids`; `null` = no reason (`true` verdict or row not found)                                                                  |
| `message` | always                                                            | `reason` when set; otherwise the generic text, followed by up to three distinct reasons — `Action "archive" is disabled for 3 of the selected rows: Locked; Already archived` |

```json
{
  "name": "ActionDisabledError",
  "message": "Order already shipped",
  "statusCode": 409,
  "action": "ship",
  "id": { "id": "abc" },
  "reason": "Order already shipped"
}
```

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

The internal action interceptor (the `disabled` gate, the row scoping, and — since 0.1.143 — [`prepareRequest`](#preparerequest-on-actions), which it runs first) is at `AFTER_GUARD` priority — so auth guards run first, then `prepareRequest`, then the gate, then any custom `INTERCEPTOR`-priority interceptors, then the handler.

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
   Then the controller's [`prepareRequest`](#preparerequest-on-actions) runs, when it defines one.
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
  disabled?: string; // fn.toString() — UI mirror only; truthy verdict = disabled, string = reason; server-evaluated availability is in row-level $actions / $disabledReasons
  inputForm?: string; // form name (@InputForm param or class-level inputForm); client fetches GET /meta/form/<name>
  formUrl?: string; // class-level inputForm { name, url }; client fetches baseUrl + formUrl instead
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

### `$disabledReasons` {#disabled-reasons-augmentation}

When a predicate returns a [reason](#disabled-reasons) for a row, that row also carries `$disabledReasons` — action name → reason — for the actions it disabled with a reason:

```bash
GET /orders/query?$actions=true
# → [{ "id": "o1", "status": "processing", "$actions": ["ship", "edit"] },
#    { "id": "o2", "status": "shipped", "$actions": ["edit"],
#      "$disabledReasons": { "ship": "Order already shipped" } }]
```

- Present only on rows with at least one reason — rows (and whole responses) from boolean-only predicates look exactly as before.
- Its keys are never in `$actions`. An action missing from `$actions` **and** from `$disabledReasons` was disabled without a reason (`true`).
- UI rule of thumb: in `$actions` → enabled; in `$disabledReasons` → show disabled with the reason as tooltip; in neither → hide.

### Per-action row scope {#actions-row-scope}

Since 0.1.145, a row lists an action only when it lies inside that action's [`actionRowScope`](#action-row-scope), the same filter the action gate enforces. An action outside its scope gets no `$disabledReasons` entry either. For each distinct filter (since 0.1.147 structurally distinct), the server runs one extra query over the page's rows, `{ $and: [{ $or: <row ids> }, <filter AND the row overlay>] }`. The row overlay is included because the gate applies it too, so a `transformOne` stricter than the read's `transformFilter` is honored for scoped actions. The query selects only the id columns (`preferredId`, which is the primary key unless re-pointed) and runs directly on the bound table or view. [`hasField`](./customization#hasfield) does not apply to it, and the response keeps its shape. A readable without a primary key withholds every scoped action, and a warning is logged once per controller class.

### Pipeline

For each request that sets `$actions=true` on a controller extending `AsDbReadableController`:

1. Discover row/rows-level action envelopes (memoized per controller ctor).
2. Filter through [`allowedActions(names)`](./customization#allowedactions) (since 0.1.145), which defaults to the per-request `applyMetaOverlay()` hook — actions stripped by the overlay are absent from `$actions`. The `meta()` call is skipped when `applyMetaOverlay` is the default no-op. When [`actionRowScope`](#action-row-scope) is overridden, start resolving the row overlay alongside the read.
3. Pre-widen `$select` to union all `requiredFields` across the surviving envelopes (only when the caller restricted projection).
4. Run the underlying read (find / pages / search / vector / findById).
5. Call [`actionRowScope`](#action-row-scope-candidates) with the page's rows as candidates (`purpose: "rows"`), run one id-only scope query per distinct filter (in parallel), then each `disabled` predicate **once** against the full result set (length-mismatch verdict → HTTP 500, same contract as the gate). An action is listed only on rows inside its scope. Since 0.1.145 each predicate sees the rows narrowed to the columns its gate loads (id columns plus visible `requiredFields`), so it gives the same verdict as the gate. A predicate that reads an undeclared column sees `undefined` in both places.
6. Strip widened-only fields the caller didn't ask for, so the response shape matches the original `$select`.

### Available actions for one row — `GET /meta/actions/:id` {#available-actions}

Since 0.1.145. `$actions` rides on a read, so it cannot answer for a row the caller may act on but not read. `GET /meta/actions/:id` answers for one row without a read grant and without returning row data:

```bash
GET /orders/meta/actions/o2
# → { "actions": ["edit"], "disabledReasons": { "ship": "Order already shipped" } }
GET /orders/meta/actions?tenantId=t1&orderNo=42   # composite key, the /one?… rules
```

- The id forms are those of [`/one/:id` and `/one?…`](./crud#get-one); a query that matches no identification is a 400.
- The answer is exactly what calling each `'row'` / `'rows'` action would do. The id resolves once, like `/one/:id`, under the [row overlay](#row-scoping). An action is then listed when it is in [`allowedActions`](./customization#allowedactions), which defaults to the `applyMetaOverlay()` set, the row lies inside its [`actionRowScope`](#action-row-scope), and its `disabled` rule passes on the columns its gate loads.
- The answer is per row and per caller. Unlike `/meta`, a cache or CDN must not share it across rows or callers.
- An unknown id and an out-of-scope id both answer `200 { "actions": [] }`, so the route never reveals whether a row exists.
- [`prepareRequest`](./customization#preparerequest) runs first with `endpoint: "availableActions"`, so a permission layer can authorize the route. [`getDbEndpoint`](./customization#getdbendpoint) reports that endpoint for both handlers, so an authorization interceptor can let them through without naming them. `transformOne` / `transformFilter` then run in this request exactly as they do for the action itself.
- The response keys match the `$actions` / `$disabledReasons` rules above; the type is `TDbAvailableActions` from `@atscript/db`. On the client, use [`availableActions(id)`](./client#available-actions).

### Programmatic use from `@atscript/db-client`

```typescript
const r = await users.query({
  filter: { active: true },
  controls: { $actions: true } as const,
});
r[0].$actions; // typed `string[] | undefined` via ClientResponse<T, Q>
r[0].$disabledReasons?.ship; // typed `Record<string, string> | undefined`
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
| Class-level `inputForm` that is neither a compiled type nor `{ name, url }` (JS)    | warn + drop                      |
| Class-level `inputForm` on a `'navigate'` entry                                     | warn + drop                      |

The single greppable prefix `[moost-db actions]` makes it easy to detect issues in CI logs.

One misconfiguration throws instead: an action on a value-help controller (since 0.1.143, see [below](#value-help-controllers-are-excluded)).

## Value-Help Controllers Are Excluded

`AsValueHelpController` and `AsJsonValueHelpController` (used for FK pickers and dictionary surfaces) do **not** support actions. `/meta` always emits `actions: []` for shape uniformity.

Since 0.1.143, an action on a value-help controller is a **hard error**:

- `@DbAction` on a value-help method, or `@DbActions` / `@DbTableActions` / `@DbRowActions` / `@DbRowsActions` on a value-help class, throws when the decorator is applied.
- An action inherited from a non-value-help base throws when the controller is constructed.

Before 0.1.143 these decorators were silently ignored, and the `@Post` route still ran with no gate. Move the action to an `AsDbReadableController` / `AsDbController`.

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

- [Query targets](./query-targets) — Run a `'rows'` action on every row matching a query
- [Actions on a view](./view-actions) — List and run a source table's actions on a view's rows
- [HTTP Client](./client) — Consume the `actions` field from `@atscript/db-client`
- [Customization](./customization) — Hooks for intercepting CRUD (different concept; complements actions)
- [HTTP Setup](./) — Controller installation and wiring
