# Actions

`@atscript/moost-db` declarative actions surfaced via `/meta`. Three levels: `'row'` (per-row button), `'rows'` (batch over selection), `'table'` (header / scope).

Use for: row-level button (Block/Approve/Archive), batch toolbar (Lock Selected, Bulk Export), table-scope (Refresh, Import CSV), nav entry (Edit/View — no server call), UI event (open modal — no server call). Not for: CRUD ops (use built-in), CRUD-with-side-effects (use `transformFilter` / `onWrite` — see `moost-db.md`).

`actions[]` and `crud` (CRUD permissions) are siblings on `/meta`; both subject to per-request `applyMetaOverlay()`.

## Imports

```ts
import {
  // Method decorators
  DbAction,
  DbActionDefault,
  DbActionID,
  DbActionIDs,
  DbActionRow,
  DbActionRows,
  // Class decorators
  DbActions,
  DbTableActions,
  DbRowActions,
  DbRowsActions,
  // Composables (gate-cached identifiers / rows)
  useDbActionId,
  useDbActionIds,
  useDbActionRow,
  useDbActionRows,
  // Errors
  ActionDisabledError,
} from "@atscript/moost-db";

import type {
  TDbActionInfo,
  TDbActionLevel,
  TDbActionIntent,
  TDbActionProcessor,
  TDbActionsEntry,
  DbActionOpts,
  ActionDisabledErrorBody,
} from "@atscript/moost-db";
```

Peer deps: `@wooksjs/http-body` (identifier body parse), `@wooksjs/event-core` + `@wooksjs/event-http` (slots + gate interceptor).

## Decorators

| Decorator                | Target | Effect                                                                                                         |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| `@DbAction(name, opts?)` | method | Backend action. Pair with `@Post(...)`. Registers gate interceptor when `disabled` or `@DbActionRow*` present. |
| `@DbActionDefault()`     | method | Sugar for `opts.default = true`. Order-independent.                                                            |
| `@DbActionID()`          | param  | Single identifier object from JSON body. Infers `level: 'row'`.                                                |
| `@DbActionIDs()`         | param  | Identifier-object array from body. Infers `level: 'rows'`.                                                     |
| `@DbActionRow()`         | param  | Injects gate-loaded row (no double-fetch). Infers `level: 'row'`.                                              |
| `@DbActionRows()`        | param  | Injects gate-loaded rows (survivors only in `'skip'` mode). Infers `level: 'rows'`.                            |
| `@DbActions(dict)`       | class  | Generic dict; each entry must include `level`.                                                                 |
| `@DbTableActions(dict)`  | class  | Sugar — pins `level: 'table'`.                                                                                 |
| `@DbRowActions(dict)`    | class  | Sugar — pins `level: 'row'`.                                                                                   |
| `@DbRowsActions(dict)`   | class  | Sugar — pins `level: 'rows'`.                                                                                  |

## Level inference (method decorators)

| Param decorators                                           | Level       |
| ---------------------------------------------------------- | ----------- |
| `@DbActionID()` or `@DbActionRow()` (no rows-cardinality)  | `row`       |
| `@DbActionIDs()` or `@DbActionRows()` (no row-cardinality) | `rows`      |
| neither                                                    | `table`     |
| mixing row + rows cardinality                              | warn + drop |
| any `@DbAction*` + `@Body()`                               | warn + drop |

## Identifier shape — object only

The request body for an action is **always an object** (single) or **array of objects** (multi) — never a scalar. Each object's field set must EXACTLY match one **legitimate identification** on the table:

- the **primary key** (`primaryKeys`), or
- any declared `@db.index.unique` group (single-field or compound).

The validator is **strict** — unknown fields are rejected with HTTP 400. Precedence: PK first, then unique-index groups in declaration order. The same `@DbActionIDs()` array MAY mix shapes per-element (one element by PK, another by `email`, etc.).

```json
{ "id": "abc123" }                                  // row, single-field PK as object
{ "tenantId": "acme", "userId": "u1" }              // row, composite PK
{ "email": "jane@example.com" }                     // row, unique-index addressing
[{ "id": "a" }, { "id": "b" }]                      // rows, single-field PK
[{ "id": 1 }, { "email": "x@y" }]                   // rows, mixed identifier shapes
```

Even single-field PK tables MUST send `{ id: "abc" }`, never bare `"abc"`. `Content-Type: application/json` only.

Field names are **logical** (the `.as` prop names) — never physical column names from `@db.column "..."`. The matcher always operates in logical-name space.

## Preferred row identifier

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

The wire ships `meta.preferredId: string[]`, always populated, always logical names. The UI uses these fields to:

- Build `'navigate'` URLs (`$1` substitution, see § Processor).
- Pick the identifier object to send to backend actions (e.g. `{ slug: 'alpha' }` instead of `{ id: '...' }`).
- Key reactive list views (no risk of "PK was stripped from `$select`").

The table API exposes the same fields via `readable.preferredId: readonly string[]` alongside `readable.primaryKeys`.

### Read-response baseline

Every row-returning read endpoint (`GET /query`, `/pages`, `/one`, `/one/:id`, including `$search` and vector-search paths) silently widens the projection so each row carries the `preferredId` fields, regardless of `$select`. See [moost-db.md § Read-response baseline](moost-db.md#read-response-baseline) for the full contract.

## Processor

| `processor`  | `value` at definition                                   | `value` in `/meta`                   | UI dispatch                                                                                                                         |
| ------------ | ------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `'backend'`  | required (class) / N/A (method, auto from `@Post` path) | bound POST path / dict path verbatim | UI POSTs identifier object (or array of objects) as JSON body                                                                       |
| `'navigate'` | required, non-empty (class only)                        | dict value verbatim                  | UI routes to `value`; `$1` → row's `preferredId` field values (URL-encoded; compound joined `/` in `preferredId` declaration order) |
| `'custom'`   | **forbidden** (class only)                              | dict key (auto-filled)               | UI dispatches event named `value`                                                                                                   |

`'navigate'`/`'backend'` empty/missing `value` → drop. `'custom'` with `value` → drop.

## DbActionOpts

| Opt              | Type                                                                | Semantics                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`          | `string`                                                            | Required (or use `@Label('...')`; `opts.label` wins on conflict).                                                                                                                                                                                                   |
| `icon`           | `string`                                                            | UI icon name.                                                                                                                                                                                                                                                       |
| `intent`         | `'positive' \| 'negative' \| 'warning' \| 'primary' \| 'secondary'` | Color/prominence hint.                                                                                                                                                                                                                                              |
| `description`    | `string`                                                            | Tooltip.                                                                                                                                                                                                                                                            |
| `order`          | `number`                                                            | Display order.                                                                                                                                                                                                                                                      |
| `default`        | `boolean`                                                           | One per `(controller × level)`; subsequent demoted with warn.                                                                                                                                                                                                       |
| `promptText`     | `string \| [string, string]`                                        | Tuple = `[singular, plural]`; UI picks `[0]` for single ID, `[1]` otherwise. UI substitutes `$1` (preferred-id values), `$N` (count).                                                                                                                               |
| `shortcut`       | `string`                                                            | Single char. UI binds modifier (Alt+/Ctrl+/bare); server is opaque.                                                                                                                                                                                                 |
| `disabled`       | `(rows: TRow[]) => boolean[]`                                       | **Sync batch gate.** One verdict per input row, parallel by index. Length mismatch → HTTP 500. **Annotate `rows` arg explicitly** — TS decorators can't infer `TRow` from class generic. Also widens `@DbActionRow*` projection for the fields the predicate reads. |
| `requiredFields` | `string[]`                                                          | Dot-paths the UI unions into `$select` for predicate eval. Server-side: also unioned into `@DbActionRow*` fetch projection (rows are otherwise projected to identifier-shape fields only). Stripped from `/meta` if `disabled` absent.                              |
| `onDisabledRows` | `'reject' \| 'skip'`                                                | `'rows'`-level only. Default `'reject'`.                                                                                                                                                                                                                            |
| `table`          | `AtscriptDbTable<TRow>`                                             | Required on plain controllers when declaring `disabled`, `@DbActionID*`, or `@DbActionRow*`. Ignored on `AsDbReadableController` subclasses.                                                                                                                        |

## Examples

### Method-decorator (single ID + auth)

```ts
@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {
  @Post("actions/block")
  @Authenticate(adminGuard)
  @DbAction("block", { label: "Block", icon: "i-as-block", intent: "negative" })
  async blockUser(@DbActionID() id: { id: string }) {
    await this.table.updateOne({ id: id.id, blocked: true });
    return { message: `User ${id.id} blocked` };
  }
}
```

### Method-decorator (gated, batch disabled, with row injection)

```ts
@TableController(ordersTable)
export class OrdersController extends AsDbController<typeof Order> {
  @Post("actions/ship")
  @DbAction("ship", {
    label: "Ship",
    intent: "primary",
    // Sync batch predicate — one verdict per input row.
    disabled: (orders: Order[]) => orders.map((o) => o.status !== "processing"),
  })
  async ship(@DbActionID() id: { id: string }, @DbActionRow() order: Order) {
    // gate already vetted; `order` is gate-loaded (no second fetch).
    // NOTE: `order` is projected to ONLY identifier-shape fields + the fields
    // `disabled` read (`status` here). Add `requiredFields: ['orderNumber']`
    // to widen.
    await this.table.updateOne({ id: id.id, status: "shipped" });
    return { message: `Shipped order ${id.id}` };
  }
}
```

### Slug-keyed action (unique-index addressing)

```ts
@TableController(usersTable)
@Provide(usersTable)
export class UsersController extends AsDbController<typeof User> {
  @Post("actions/promote")
  @DbAction("promote", { label: "Promote" })
  async promote(@DbActionID() id: { slug: string }) {
    await this.table.updateOne({ slug: id.slug, role: "admin" });
    return { message: `Promoted ${id.slug}` };
  }
}
// Client POSTs `{ "slug": "alpha" }` — slug is a `@db.index.unique` field.
// Same controller can also accept `{ "id": "<uuid>" }` (PK precedence) on
// the same endpoint; both shapes are legitimate identifications.
```

### Plain controller (must pass `opts.table`)

```ts
@Controller()
export class AdminController {
  @Post("orders/ship")
  @DbAction("ship", {
    label: "Ship",
    table: ordersTable, // REQUIRED — no AsDbReadableController extends
    disabled: (orders: Order[]) => orders.map((o) => o.status !== "processing"),
  })
  async ship(@DbActionID() id: { id: string }, @DbActionRow() order: Order) {
    /* ... */
  }
}
```

### Class-level dict

```ts
@TableController(usersTable)
@DbRowActions({
  edit: { label: "Edit", processor: "navigate", value: "/users/$1/edit" },
  view: { label: "View", processor: "navigate", value: "/users/$1" },
  block: { label: "Block", processor: "backend", value: "/admin/users/block" }, // backend escape hatch
})
@DbTableActions({
  refresh: { label: "Refresh", processor: "custom" }, // value auto-filled with "refresh"
  importCsv: { label: "Import CSV", processor: "custom" },
})
export class UsersController extends AsDbController<typeof User> {}
```

For `'navigate'` actions, `$1` is substituted with the row's `preferredId` field values — see § Processor.

## Server-side gate

`disabled` predicate enforced via Moost interceptor at `AFTER_GUARD` priority (auth → gate → handler). Wire emits `fn.toString()` for UI mirroring. Server is authoritative.

### Batch contract — sync `(rows: TRow[]) => boolean[]`

The predicate runs **once per request** with all relevant rows in one call:

| Level    | Gate calls                                    |
| -------- | --------------------------------------------- |
| `'row'`  | `disabled([row])` → reads `verdicts[0]`       |
| `'rows'` | `disabled(survivorRows)` (existing rows only) |

Verdicts MUST be **parallel by index** to the input rows. Mixed `true`/`false` is normal — partial-disabled is the whole point of the gate. The verdict array LENGTH MUST equal the input length; length mismatch (e.g. a buggy `() => [true]` predicate, or `rows.filter(...).map(...)`) throws HTTP 500 identifying the offending action — the gate cannot map verdicts back to rows.

`Promise<boolean[]>` is **not** permitted. The TS type `(rows: TRow[]) => boolean[]` enforces this.

### Missing-row handling (`'rows'` level)

Per-identifier `(id, row | undefined)` pairs are walked in original request order. If the row didn't resolve (no DB match), the identifier is treated as failing without invoking `disabled` against `undefined`. Surviving rows are passed in one batched `disabled` call.

### Batch mode (`'rows'` only)

| `onDisabledRows`     | On any failure                                                            | Handler runs with                                  |
| -------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| `'reject'` (default) | throws `ActionDisabledError` listing **all** failing IDs in request order | n/a                                                |
| `'skip'`             | filters cached IDs/rows to passing-only; throws if zero survivors         | survivors only (parallel-aligned `ids` and `rows`) |

Reject mode preserves request order across both failure types (missing-row + predicate-rejected). The cached identifier slot stores **the original submitted object references** — skip-mode filtering preserves reference equality.

### Closure-emission rule

`disabled` body must reference only the rows arg. Outer-scope captures (`this`, `const`s, imports) work server-side but break UI eval (`ReferenceError`).

```ts
// ✅ self-contained
disabled: (orders: Order[]) => orders.map((o) => o.status !== "processing");
// ❌ captures SHIPPED — server runs, UI breaks
const SHIPPED = "shipped";
disabled: (orders: Order[]) => orders.map((o) => o.status === SHIPPED);
```

### `ActionDisabledError` (HTTP 409)

```json
{
  "name": "ActionDisabledError",
  "message": "...",
  "statusCode": 409,
  "action": "ship",
  "id": { "id": "abc" }
}
```

`'rows'` rejection: `ids: [...]` instead of `id` — all failing identifier objects in `'reject'`, all request identifiers in `'skip'`-zero-survivors. Each entry is `Record<string, unknown>` in the shape originally submitted by the client (PK or unique-index form).

Server class: `@atscript/moost-db` (`extends HttpError`). Client class: `@atscript/db-client` (`extends ClientError`, typed `e.action` / `e.id` / `e.ids`). Bridged by JSON body's `name` discriminator — neither package depends on the other.

### Class-level dict gating is UI-only

`@DbActions*` accept `disabled` / `requiredFields` but DO NOT register a server interceptor (the dict's `value` may target another controller). Wire still emits `disabled` for UI gating; for server enforcement, also declare `@DbAction(name, { disabled })` on the actual `@Post` handler.

## `@DbActionRow*` projection narrowing

Handlers using `@DbActionRow()` / `@DbActionRows()` receive rows projected to ONLY the **identifier-shape fields** the request used (the union of every distinct field set across the submitted identifiers, plus any `requiredFields`). Other table columns are absent.

```ts
@DbAction("archive", {
  disabled: (orders: Order[]) => orders.map((o) => o.archived === true),
  // Without requiredFields, only identifier-shape fields appear on `orders[i]`.
  // `o.archived` is the field the predicate reads — server unions it from
  // the predicate's stringified body (see DbActionOpts.requiredFields).
})
async archive(@DbActionIDs() ids, @DbActionRows() orders: Order[]) {
  // `orders[i]` contains identifier fields + `archived`. To access
  // `orderNumber`, declare `requiredFields: ['orderNumber']` or re-fetch.
}
```

`requiredFields` is the explicit knob: `requiredFields: ['name', 'email']` widens both the UI's `$select` AND the server's row fetch projection.

### Composables

```ts
const id = await useDbActionId().load(); // single identifier object: Record<string, unknown>
const ids = await useDbActionIds().load(); // identifier-object array: Record<string, unknown>[]
const row = await useDbActionRow().load(); // gate-loaded row
const rows = await useDbActionRows().load(); // gate-loaded rows (survivors in `'skip'` mode)
```

`defineWook`-based, return `{ load() }`. Read inside `INTERCEPTOR`-priority interceptors — gate (`AFTER_GUARD`) has populated them.

In skip-mode, `useDbActionIds().load()` returns the **filtered subset of original objects** (reference-equal to the entries the client posted), and `useDbActionRows().load()` returns the parallel-aligned filtered rows. No `undefined` gaps.

## Bound-table resolution (request time)

For `@DbActionID*` identifier validation and gate / `@DbActionRow*` row loading:

1. `opts.table` (any class).
2. `AsDbController` / `AsDbReadableController` subclass — auto from `@TableController` / `@ReadableController`.
3. Duck-type fallback — `controller.readable ?? controller.table` (legacy; identifier-only, NOT enough for gate or row injection).

If none → HTTP 500 (server-misconfig). For controllers with no typed table at all, use `@Body()` and validate manually. Gate / `@DbActionRow*` on plain controller without `opts.table` → discovery drops the action.

## Success response (convention)

Backend handler returns any JSON. Top-level `"message": string` → UI toasts it; otherwise generic per-level toast. No type validation.

```ts
return { message: `User ${id.id} blocked` }; // toast
return { message: `${ids.length} users locked`, locked: ids }; // toast + payload
return { ok: true }; // generic toast
```

## `/meta` wire shape

```ts
type TDbActionLevel = "table" | "row" | "rows";
type TDbActionIntent = "positive" | "negative" | "warning" | "primary" | "secondary";
type TDbActionProcessor = "backend" | "navigate" | "custom";

interface TDbActionInfo {
  name: string;
  label: string;
  level: TDbActionLevel;
  processor: TDbActionProcessor;
  value: string;
  icon?: string;
  intent?: TDbActionIntent;
  description?: string;
  order?: number;
  default?: boolean;
  promptText?: string | [string, string]; // [singular, plural]; UI substitutes $1 (preferred-id values), $N (count)
  shortcut?: string; // single char; UI binds modifier
  disabled?: string; // fn.toString() — UI mirrors via eval; server is authoritative (batch contract)
  requiredFields?: string[]; // UI's $select union hint
}
```

`TMetaResponse.actions: TDbActionInfo[]`. Always present; `[]` when none declared. Discovery is **lazy** — runs on first `GET /meta`; warnings (greppable `[moost-db actions]`) emit then, not at `app.init()`.

`TMetaResponse.preferredId: string[]` is also part of the same envelope — see [moost-db.md § Meta endpoint shape](moost-db.md#meta-endpoint-shape).

## Validation drops (warn + remove from `/meta`)

- `@DbAction` without `@Post(...)` (or with `@Get`/`@Put`/`@Patch`/`@Delete`).
- `@Body()` co-occurring with any `@DbActionID*` / `@DbActionRow*`.
- Mixing row + rows cardinality on same method.
- `@DbActionDefault()` without `@DbAction(name)` (stranded sugar).
- Missing label (no `opts.label`, no `@Label`).
- `'navigate'` / `'backend'` class entry with empty/missing `value`.
- `'custom'` class entry supplying `value`.
- Two `default: true` at same `(controller × level)` — first wins, second demoted.
- `'table'`-level action with `disabled` (no row scope; gate via auth/arbac).
- Gate / `@DbActionRow*` on plain controller without `opts.table`.
- `requiredFields` set without `disabled` → strip the field (action kept).

Value-help controllers (`AsValueHelpController` / `AsJsonValueHelpController`) silently emit `actions: []`; decorators on them are ignored.

## Class-level `'backend'` row/rows caveat

Dict-supplied `value` MUST point to a `@Post`-bound endpoint accepting the identifier-shaped JSON body — typically a method using `@DbActionID()` / `@DbActionIDs()` on the controller serving that path. Builder does NOT validate; dev-side contract.

## Client side: `client.action(name, id?)`

```ts
const users = new Client<typeof User>("/api/users", { navigate: (url) => router.push(url) });

await users.action("block", { id: "abc123" }); // backend, row → POST identifier object
await users.action("lock", [{ id: "a" }, { id: "b" }]); // rows → POST array of identifier objects
await users.action("promote", { tenantId: "acme", userId: "u1" }); // composite PK
await users.action("promote", { email: "jane@example.com" }); // unique-index addressing (same endpoint)
await users.action("refresh-cache"); // table → POST empty
await users.action("edit", { slug: "alpha" }); // navigate → /users/alpha/edit (preferredId-driven $1)

await users.action<{ message: string }>("block", { id: "abc" }); // typed return shape
```

- POST always (hardcoded for `'backend'`).
- Single object on `'rows'`-level → **TypeError client-side** (no auto-wrap; pass `[{...}]`).
- Scalars / `null` → **TypeError client-side** for both row and rows. The TS signature also rejects them at compile time when `Client<typeof T>` is used.
- Compound preferred-id navigate: each `preferredId` field's value URL-encoded, joined `/` in field-declaration order (NOT object-key insertion order).
- `'rows'` / `'table'` navigate: `value` verbatim (no `$1` substitution).
- `'custom'` → `ActionUnsupportedError` (UI dispatches itself).
- Unknown name → `ActionNotFoundError`.
- HTTP 409 (gate) → `ActionDisabledError extends ClientError` with `e.action` / `e.id` / `e.ids`.
- Other non-2xx → `ClientError` (same shape as other endpoints).

See [db-client.md](db-client.md) for the full client surface.
