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
  DbActionPK,
  DbActionPKs,
  DbActionRow,
  DbActionRows,
  // Class decorators
  DbActions,
  DbTableActions,
  DbRowActions,
  DbRowsActions,
  // Composables (gate-cached PKs / rows)
  useDbActionPk,
  useDbActionPks,
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

Peer deps: `@wooksjs/http-body` (PK body parse), `@wooksjs/event-core` + `@wooksjs/event-http` (slots + gate interceptor).

## Decorators

| Decorator                | Target | Effect                                                                                                         |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| `@DbAction(name, opts?)` | method | Backend action. Pair with `@Post(...)`. Registers gate interceptor when `disabled` or `@DbActionRow*` present. |
| `@DbActionDefault()`     | method | Sugar for `opts.default = true`. Order-independent.                                                            |
| `@DbActionPK()`          | param  | Single PK from JSON body. Infers `level: 'row'`.                                                               |
| `@DbActionPKs()`         | param  | PK array from body. Infers `level: 'rows'`.                                                                    |
| `@DbActionRow()`         | param  | Injects gate-loaded row (no double-fetch). Infers `level: 'row'`.                                              |
| `@DbActionRows()`        | param  | Injects gate-loaded rows (survivors only in `'skip'` mode). Infers `level: 'rows'`.                            |
| `@DbActions(dict)`       | class  | Generic dict; each entry must include `level`.                                                                 |
| `@DbTableActions(dict)`  | class  | Sugar — pins `level: 'table'`.                                                                                 |
| `@DbRowActions(dict)`    | class  | Sugar — pins `level: 'row'`.                                                                                   |
| `@DbRowsActions(dict)`   | class  | Sugar — pins `level: 'rows'`.                                                                                  |

## Level inference (method decorators)

| Param decorators                                           | Level       |
| ---------------------------------------------------------- | ----------- |
| `@DbActionPK()` or `@DbActionRow()` (no rows-cardinality)  | `row`       |
| `@DbActionPKs()` or `@DbActionRows()` (no row-cardinality) | `rows`      |
| neither                                                    | `table`     |
| mixing row + rows cardinality                              | warn + drop |
| any `@DbAction*` + `@Body()`                               | warn + drop |

## Processor

| `processor`  | `value` at definition                                   | `value` in `/meta`                   | UI dispatch                                                                                    |
| ------------ | ------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `'backend'`  | required (class) / N/A (method, auto from `@Post` path) | bound POST path / dict path verbatim | UI POSTs PK as JSON body                                                                       |
| `'navigate'` | required, non-empty (class only)                        | dict value verbatim                  | UI routes to `value`; `$1` → row PK (URL-encoded; composite joined `/` in `primaryKeys` order) |
| `'custom'`   | **forbidden** (class only)                              | dict key (auto-filled)               | UI dispatches event named `value`                                                              |

`'navigate'`/`'backend'` empty/missing `value` → drop. `'custom'` with `value` → drop.

## DbActionOpts

| Opt              | Type                                                                | Semantics                                                                                                                   |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `label`          | `string`                                                            | Required (or use `@Label('...')`; `opts.label` wins on conflict).                                                           |
| `icon`           | `string`                                                            | UI icon name.                                                                                                               |
| `intent`         | `'positive' \| 'negative' \| 'warning' \| 'primary' \| 'secondary'` | Color/prominence hint.                                                                                                      |
| `description`    | `string`                                                            | Tooltip.                                                                                                                    |
| `order`          | `number`                                                            | Display order.                                                                                                              |
| `default`        | `boolean`                                                           | One per `(controller × level)`; subsequent demoted with warn.                                                               |
| `promptText`     | `string \| [string, string]`                                        | Tuple = `[singular, plural]`; UI picks `[0]` for single PK, `[1]` otherwise. UI substitutes `$1` (PK), `$N` (count).        |
| `shortcut`       | `string`                                                            | Single char. UI binds modifier (Alt+/Ctrl+/bare); server is opaque.                                                         |
| `disabled`       | `(row: TRow) => boolean`                                            | Per-row gate. **Annotate `row` arg explicitly** — TS decorators can't infer `TRow` from class generic.                      |
| `requiredFields` | `string[]`                                                          | Dot-paths the UI unions into `$select` for predicate eval. Stripped if `disabled` absent.                                   |
| `onDisabledRows` | `'reject' \| 'skip'`                                                | `'rows'`-level only. Default `'reject'`.                                                                                    |
| `table`          | `AtscriptDbTable<any>`                                              | Required on plain controllers when declaring `disabled` or `@DbActionRow*`. Ignored on `AsDbReadableController` subclasses. |

## Examples

### Method-decorator (PK + auth)

```ts
@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {
  @Post("actions/block")
  @Authenticate(adminGuard)
  @DbAction("block", { label: "Block", icon: "i-as-block", intent: "negative" })
  async blockUser(@DbActionPK() id: string) {
    await this.table.updateOne({ id, blocked: true });
    return { message: `User ${id} blocked` };
  }
}
```

### Method-decorator (gated, with row injection)

```ts
@TableController(ordersTable)
export class OrdersController extends AsDbController<typeof Order> {
  @Post("actions/ship")
  @DbAction("ship", {
    label: "Ship",
    intent: "primary",
    disabled: (order: Order) => order.status !== "processing",
  })
  async ship(@DbActionPK() id: string, @DbActionRow() order: Order) {
    // gate already vetted; `order` is gate-loaded (no second fetch)
    await this.table.updateOne({ id, status: "shipped" });
    return { message: `Shipped order ${order.orderNumber}` };
  }
}
```

### Plain controller (must pass `opts.table`)

```ts
@Controller()
export class AdminController {
  @Post("orders/ship")
  @DbAction("ship", {
    label: "Ship",
    table: ordersTable, // REQUIRED — no AsDbReadableController extends
    disabled: (order: Order) => order.status !== "processing",
  })
  async ship(@DbActionPK() id: string, @DbActionRow() order: Order) {
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

## Server-side gate

`disabled` predicate enforced via Moost interceptor at `AFTER_GUARD` priority (auth → gate → handler). Wire emits `fn.toString()` for UI mirroring. Server is authoritative.

### Batch mode (`'rows'` only)

| `onDisabledRows`     | On any failure                                                    | Handler runs with |
| -------------------- | ----------------------------------------------------------------- | ----------------- |
| `'reject'` (default) | throws `ActionDisabledError` listing **all** failing PKs          | n/a               |
| `'skip'`             | filters cached PKs/rows to passing-only; throws if zero survivors | survivors only    |

Both modes FULL-scan (no short-circuit) — `pks` lists every failing PK, predicates with side-effects run for every row (predicates should be pure).

### Closure-emission rule

`disabled` body must reference only the row arg. Outer-scope captures (`this`, `const`s, imports) work server-side but break UI eval (`ReferenceError`).

```ts
// ✅ self-contained
disabled: (order: Order) => order.status !== "processing";
// ❌ captures SHIPPED — server runs, UI breaks
const SHIPPED = "shipped";
disabled: (order: Order) => order.status === SHIPPED;
```

### `ActionDisabledError` (HTTP 409)

```json
{
  "name": "ActionDisabledError",
  "message": "...",
  "statusCode": 409,
  "action": "ship",
  "pk": "abc"
}
```

`'rows'` rejection: `pks: [...]` instead of `pk` — all failing PKs in `'reject'`, all request PKs in `'skip'`-zero-survivors.

Server class: `@atscript/moost-db` (`extends HttpError`). Client class: `@atscript/db-client` (`extends ClientError`, typed `e.action` / `e.pk` / `e.pks`). Bridged by JSON body's `name` discriminator — neither package depends on the other.

### Class-level dict gating is UI-only

`@DbActions*` accept `disabled` / `requiredFields` but DO NOT register a server interceptor (the dict's `value` may target another controller). Wire still emits `disabled` for UI gating; for server enforcement, also declare `@DbAction(name, { disabled })` on the actual `@Post` handler.

### Composables

```ts
const pk = await useDbActionPk().load(); // single PK
const pks = await useDbActionPks().load(); // PK array
const row = await useDbActionRow().load(); // gate-loaded row
const rows = await useDbActionRows().load(); // gate-loaded rows (survivors in `'skip'` mode)
```

`defineWook`-based, return `{ load() }`. Read inside `INTERCEPTOR`-priority interceptors — gate (`AFTER_GUARD`) has populated them.

## Bound-table resolution (request time)

For `@DbActionPK*` PK validation and gate / `@DbActionRow*` row loading:

1. `opts.table` (any class).
2. `AsDbController` / `AsDbReadableController` subclass — auto from `@TableController` / `@ReadableController`.
3. Duck-type fallback — `controller.readable ?? controller.table` (legacy; PK-only, NOT enough for gate or row injection).

If none → HTTP 500 (server-misconfig). For controllers with no typed table at all, use `@Body()` and validate PK yourself. Gate / `@DbActionRow*` on plain controller without `opts.table` → discovery drops the action.

## Request body

```json
"abc123"                                            // row, scalar PK
{ "tenantId": "acme", "userId": "u1" }              // row, composite PK
["a", "b", "c"]                                     // rows, scalar — ALWAYS array (single = ["a"])
[{ "tenantId": "acme", "userId": "u1" }, ...]       // rows, composite
```

`Content-Type: application/json` only. Strict types — `"42"` rejected for numeric PK. Mismatch → HTTP 400 with `{ statusCode, message, errors: [{ path, message }] }`. Empty `[]` accepted (omitted `pk` in `client.action(name)` posts `[]`, handler runs with `ids === []`).

## Success response (convention)

Backend handler returns any JSON. Top-level `"message": string` → UI toasts it; otherwise generic per-level toast. No type validation.

```ts
return { message: `User ${id} blocked` }; // toast
return { message: "5 users locked", locked: ids }; // toast + payload
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
  promptText?: string | [string, string]; // [singular, plural]; UI substitutes $1 (PK), $N (count)
  shortcut?: string; // single char; UI binds modifier
  disabled?: string; // fn.toString() — UI mirrors via eval; server is authoritative
  requiredFields?: string[]; // UI's $select union hint
}
```

`TMetaResponse.actions: TDbActionInfo[]`. Always present; `[]` when none declared. Discovery is **lazy** — runs on first `GET /meta`; warnings (greppable `[moost-db actions]`) emit then, not at `app.init()`.

## Validation drops (warn + remove from `/meta`)

- `@DbAction` without `@Post(...)` (or with `@Get`/`@Put`/`@Patch`/`@Delete`).
- `@Body()` co-occurring with any `@DbActionPK*` / `@DbActionRow*`.
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

Dict-supplied `value` MUST point to a `@Post`-bound endpoint accepting the PK-shaped JSON body — typically a method using `@DbActionPK()` / `@DbActionPKs()` on the controller serving that path. Builder does NOT validate; dev-side contract.

## Client side: `client.action(name, pk?)`

```ts
const users = new Client<typeof User>("/api/users", { navigate: (url) => router.push(url) });

await users.action("block", "abc123"); // backend, row → POST PK as body
await users.action("lock", ["a", "b"]); // rows → POST PK array
await users.action("lock", "a"); // single PK auto-wrapped → ["a"]
await users.action("refresh-cache"); // table → POST empty
await users.action("edit", "abc"); // navigate → router.push('/users/abc/edit')
```

- POST always (hardcoded for `'backend'`).
- Composite PK navigate: each value URL-encoded, joined `/`.
- `'rows'` / `'table'` navigate: `value` verbatim (no `$1` substitution).
- `'custom'` → `ActionUnsupportedError` (UI dispatches itself).
- Unknown name → `ActionNotFoundError`.
- HTTP 409 (gate) → `ActionDisabledError extends ClientError` with `e.action` / `e.pk` / `e.pks`.
- Other non-2xx → `ClientError` (same shape as other endpoints).
