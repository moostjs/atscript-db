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
  InputForm,
  // Class decorators
  DbActions,
  DbTableActions,
  DbRowActions,
  DbRowsActions,
  // Composables (gate-cached identifiers / rows / form input)
  useDbActionId,
  useDbActionIds,
  useDbActionRow,
  useDbActionRows,
  useDbActionInput,
  // Helpers
  perRow,
  // Errors
  ActionDisabledError,
  // Typed metadata accessor (see § getAtscriptDbMate())
  getAtscriptDbMate,
} from "@atscript/moost-db";

import type {
  TDbActionInfo,
  TDbActionLevel,
  TDbActionIntent,
  TDbActionProcessor,
  TDbActionsEntry,
  DbActionOpts,
  TDbActionInputFormMeta,
  TDbActionMeta,
  TDbActionParamKind,
  TDbClassActionMeta,
  AtscriptDbMate,
  AtscriptDbMeta,
  AtscriptDbParamsMeta,
  ActionDisabledErrorBody,
} from "@atscript/moost-db";
```

Peer deps: `@wooksjs/http-body` (identifier body parse), `@wooksjs/event-core` + `@wooksjs/event-http` (slots + gate interceptor).

## Decorators

| Decorator                | Target | Effect                                                                                                                                            |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@DbAction(name, opts?)` | method | Backend action. Pair with `@Post(...)`. Registers gate interceptor when `disabled` or `@DbActionRow*` present.                                    |
| `@DbActionDefault()`     | method | Sugar for `opts.default = true`. Order-independent.                                                                                               |
| `@DbActionID()`          | param  | Single identifier object from JSON body. Infers `level: 'row'`.                                                                                   |
| `@DbActionIDs()`         | param  | Identifier-object array from body. Infers `level: 'rows'`.                                                                                        |
| `@DbActionRow()`         | param  | Injects gate-loaded row (no double-fetch). Infers `level: 'row'`.                                                                                 |
| `@DbActionRows()`        | param  | Injects gate-loaded rows (survivors only in `'skip'` mode). Infers `level: 'rows'`.                                                               |
| `@InputForm(FormType?)`  | param  | Injects `body.input` **validated** against the form; form inferred from the param's type when arg omitted. Does NOT affect level. One per action. |
| `@DbActions(dict)`       | class  | Generic dict; each entry must include `level`.                                                                                                    |
| `@DbTableActions(dict)`  | class  | Sugar — pins `level: 'table'`.                                                                                                                    |
| `@DbRowActions(dict)`    | class  | Sugar — pins `level: 'row'`.                                                                                                                      |
| `@DbRowsActions(dict)`   | class  | Sugar — pins `level: 'rows'`.                                                                                                                     |

## Level inference (method decorators)

| Param decorators                                           | Level       |
| ---------------------------------------------------------- | ----------- |
| `@DbActionID()` or `@DbActionRow()` (no rows-cardinality)  | `row`       |
| `@DbActionIDs()` or `@DbActionRows()` (no row-cardinality) | `rows`      |
| neither                                                    | `table`     |
| mixing row + rows cardinality                              | warn + drop |
| any `@DbAction*` + `@Body()`                               | warn + drop |

## Body envelope — `{ ids?, input? }`

Every action POST body is a JSON object envelope. `ids` carries the identifier(s); `input` carries `@InputForm` payload. Both fields optional.

```json
// row              { "ids": { "id": "abc" } }
// rows             { "ids": [{ "id": "a" }, { "id": "b" }] }
// table (no form)  {}                              ← or no body at all
// row + form       { "ids": { "id": "abc" }, "input": { "note": "looks good" } }
// table + form     { "input": { "message": "hi" } }
```

Array or scalar root → HTTP 400 `ValidatorError` (envelope is strict; this is the breaking change vs the pre-`InputForm` shape that placed identifiers at the root).

### Identifier shape (`ids` field)

`ids` is **always an object** (single) or **array of objects** (multi) — never a scalar. Each object's field set must EXACTLY match one **legitimate identification** on the table:

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

### Input shape (`input` field)

Validated server-side against the action's form before the handler fires (see § InputForm). Meaningful iff the action declares `@InputForm(...)`. Empty `{}` body is fine; absent `input` is validated as `{}` — all-optional forms pass, required fields produce a structured 400.

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

| `processor`  | `value` at definition                                   | `value` in `/meta`                   | UI dispatch                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'backend'`  | required (class) / N/A (method, auto from `@Post` path) | bound POST path / dict path verbatim | UI POSTs envelope `{ ids?, input? }` as JSON body (omits body for table-level + no form)                                                                                                          |
| `'navigate'` | required, non-empty (class only)                        | dict value verbatim                  | UI routes to `value`; `$1` → row's `preferredId` field values (URL-encoded; compound joined `/` in `preferredId` declaration order; missing fields → empty segments, never literal `"undefined"`) |
| `'custom'`   | **forbidden** (class only)                              | dict key (auto-filled)               | UI dispatches event named `value`                                                                                                                                                                 |

`'navigate'`/`'backend'` empty/missing `value` → drop. `'custom'` with `value` → drop.

## DbActionOpts

`@DbAction<TRow, const R>(name, opts)` — annotate `<TRow>` at the call site (TS decorators can't infer it from the enclosing class). `R` is the literal `requiredFields` tuple (inferred via `const R`).

| Opt              | Type                                                                | Semantics                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`          | `string`                                                            | Required (or `@Label('...')`; `opts.label` wins).                                                                                                                                                                                                                         |
| `icon`           | `string`                                                            | UI icon name.                                                                                                                                                                                                                                                             |
| `intent`         | `'positive' \| 'negative' \| 'warning' \| 'primary' \| 'secondary'` | Color/prominence.                                                                                                                                                                                                                                                         |
| `description`    | `string`                                                            | Tooltip.                                                                                                                                                                                                                                                                  |
| `order`          | `number`                                                            | Display order.                                                                                                                                                                                                                                                            |
| `default`        | `boolean`                                                           | One per `(controller × level)`; later demoted with warn.                                                                                                                                                                                                                  |
| `promptText`     | `string \| [string, string]`                                        | Tuple = `[singular, plural]`. UI substitutes `$1` (preferred-id values), `$N` (count).                                                                                                                                                                                    |
| `shortcut`       | `string`                                                            | Single char. UI binds modifier.                                                                                                                                                                                                                                           |
| `requiredFields` | `readonly FlatKey<TRow>[]` (literal tuple)                          | **Required when `disabled` is set.** Dot-paths the predicate reads. Server-internal — never on the wire. Type-narrows `disabled`'s row arg AND drives projection widening (`@DbActionRow*` fetch + `$actions` augmentation read). Listing a relation field is a TS error. |
| `disabled`       | `(rows: Pick<FlatOf<TRow>, R[number]>[]) => boolean[]`              | **Sync batch gate.** Row arg is narrowed to `requiredFields` only; reading another field is a TS error. One verdict per input row, parallel by index. Length mismatch → HTTP 500. `Promise<boolean[]>` not permitted. Without `requiredFields` → action dropped.          |
| `onDisabledRows` | `'reject' \| 'skip'`                                                | `'rows'`-level only. Default `'reject'`.                                                                                                                                                                                                                                  |
| `table`          | `AtscriptDbTable<TRow>`                                             | Required on plain controllers when `disabled`, `@DbActionID*`, or `@DbActionRow*` present. Ignored on `AsDbReadableController` subclasses.                                                                                                                                |

`FlatKey<TRow> = keyof FlatOf<TRow> & string` (dot-paths over scalars; relations excluded). When `TRow = unknown` (no `<TRow>` generic), all string keys allowed; `disabled` row arg falls back to `any[]` and `requiredFields` is loosely `string[]` — runtime still drops `disabled` without `requiredFields`.

### `perRow()` helper

Lift a per-row predicate into batch shape; polarity preserved (`true` = disabled).

```ts
import { perRow } from "@atscript/moost-db";

@DbAction<Order, ["status"]>("archive", {
  requiredFields: ["status"],
  disabled: perRow((o) => o.status === "archived"),
})
```

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
  @DbAction<Order, ["status"]>("ship", {
    label: "Ship",
    intent: "primary",
    requiredFields: ["status"], // REQUIRED with `disabled`; narrows row arg
    disabled: (orders) => orders.map((o) => o.status !== "processing"),
  })
  async ship(@DbActionID() id: { id: string }, @DbActionRow() order: Order) {
    // gate already vetted; `order` is gate-loaded (no second fetch).
    // `order` is projected to identifier-shape ∪ preferredId ∪ requiredFields.
    // To access `orderNumber`, add it to requiredFields.
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
// Client POSTs `{ "ids": { "slug": "alpha" } }` — slug is a `@db.index.unique` field.
// Same controller can also accept `{ "ids": { "id": "<uuid>" } }` (PK precedence) on
// the same endpoint; both shapes are legitimate identifications.
```

### Plain controller (must pass `opts.table`)

```ts
@Controller()
export class AdminController {
  @Post("orders/ship")
  @DbAction<Order, ["status"]>("ship", {
    label: "Ship",
    table: ordersTable, // REQUIRED — no AsDbReadableController extends
    requiredFields: ["status"],
    disabled: (orders) => orders.map((o) => o.status !== "processing"),
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

`disabled` predicate — Moost interceptor at `AFTER_GUARD` priority (auth → gate → handler). Server is authoritative. Wire ships `fn.toString()` for UI mirror.

**Signature:** sync `(rows: Pick<FlatOf<TRow>, R[number]>[]) => boolean[]`. Runs **once per request**. `Promise<boolean[]>` not permitted.

| Level    | Gate calls                                    |
| -------- | --------------------------------------------- |
| `'row'`  | `disabled([row])` → reads `verdicts[0]`       |
| `'rows'` | `disabled(survivorRows)` (existing rows only) |

Verdicts MUST be parallel by index. Length mismatch → HTTP 500.

Same predicate runs in three places: gate enforcement on POST, `$actions` augmentation on reads, and UI mirror via wire string.

**Missing rows (`'rows'` level):** unresolved identifiers fail without invoking `disabled` against `undefined`. Surviving rows are batched into one call.

**Batch mode (`'rows'`):**

| `onDisabledRows`     | On any failure                                                        | Handler runs with |
| -------------------- | --------------------------------------------------------------------- | ----------------- |
| `'reject'` (default) | throws `ActionDisabledError` listing all failing IDs in request order | n/a               |
| `'skip'`             | filters to passing-only; throws if zero survivors                     | survivors only    |

Cached identifier slot holds the original submitted object references; skip-mode filtering preserves reference equality.

**Closure-emission rule:** `disabled` body must reference only the rows arg — outer-scope captures (`this`, imports, `const`s) work server-side but break UI eval (`ReferenceError`).

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

`@DbActions*` accept `disabled` (with required `requiredFields`) but DO NOT register a server interceptor — the dict's `value` may target another controller. The predicate runs in two places: (1) `$actions=true` augmentation against the controller's own read result; (2) UI mirror via wire `disabled` string. POSTs to the dict's `value` endpoint are NOT blocked here. For server enforcement on the actual handler, also declare `@DbAction(name, { requiredFields, disabled })` on it.

## `@DbActionRow*` projection narrowing

Handlers using `@DbActionRow()` / `@DbActionRows()` receive rows projected to:

```
identifier-shape fields ∪ preferredId ∪ requiredFields
```

Other table columns are absent. `requiredFields` is the only knob — there is no auto-deps tracker.

```ts
@DbAction<Order, ["archived", "orderNumber"]>("archive", {
  requiredFields: ["archived", "orderNumber"],
  disabled: (orders) => orders.map((o) => o.archived === true),
})
async archive(@DbActionIDs() ids, @DbActionRows() orders: Order[]) {
  // `orders[i]` contains identifier fields ∪ preferredId ∪ ['archived', 'orderNumber'].
  // To access `customerEmail`, add it to requiredFields.
}
```

### Composables

```ts
const id = await useDbActionId().load(); // single identifier object: Record<string, unknown>
const ids = await useDbActionIds().load(); // identifier-object array: Record<string, unknown>[]
const row = await useDbActionRow().load(); // gate-loaded row
const rows = await useDbActionRows().load(); // gate-loaded rows (survivors in `'skip'` mode)
const input = await useDbActionInput().load(); // body.input — unknown; not validated by default
```

`defineWook`-based, return `{ load() }`. Read inside `INTERCEPTOR`-priority interceptors — gate (`AFTER_GUARD`) has populated them.

In skip-mode, `useDbActionIds().load()` returns the **filtered subset of original objects** (reference-equal to the entries the client posted), and `useDbActionRows().load()` returns the parallel-aligned filtered rows. No `undefined` gaps.

## `@InputForm(FormType?, validatorOpts?)` — structured user input

Marks a param as the action's `input` payload (`body.input`). `FormType` is a compiled `.as` interface class. One per action; for multiple structured inputs, compose a single `.as` interface.

`FormType` may be **omitted** — `@InputForm() input: CommentForm` infers the form from the param's reflected type (`design:paramtypes`). Inference requires the compiled `.as` class as the param annotation through a **value import** (`import type` elides the class → reflection yields `Object`). When the reflected type is unusable, decoration **throws at import time** with a fix hint — never a silently form-less action. The explicit arg sidesteps reflection and always wins over the annotation.

Stamps two param mate keys:

| Key                             | Value                                | Consumer                                                                         |
| ------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `atscript_db_action_input_form` | `{ type: FormType, name: <string> }` | Discovery — emits `inputForm` on `/meta`; registers form for `/meta/form/:name`. |
| `atscript_type`                 | `FormType`                           | Generic atscript-aware Moost pipe hook.                                          |

**Validation is built in.** The resolver runs `FormType.validator(validatorOpts).validate(input ?? {})` before the handler fires; a mismatch throws `ValidatorError` → structured HTTP 400 via the controllers' own `validationErrorTransform()` (same envelope as strict-`ids` failures). Absent `input` validates as `{}` and the handler always receives an object, never `undefined`. An app-level `validatorPipe()` re-validating the same param is harmless.

Form name on the wire is `FormType.name` (compiled `.as` classes have stable names). Reusing the same `FormType` across multiple actions on the same controller is allowed; clashing names with different type refs → discovery warns and drops the second action.

Co-occurrence rules: orthogonal to level — `@InputForm` alone keeps the action `'table'`-level. Combines freely with `@DbActionID*` / `@DbActionRow*`. NOT supported on class-level dict actions (no params to decorate).

### Example — `@InputForm` on a row action

```atscript
// schema/comment.as
export interface CommentForm {
    note: string

    visibility?: 'public' | 'internal'
}
```

```ts
import { CommentForm } from "./schema/comment.as";

@TableController(ordersTable)
export class OrdersController extends AsDbController<typeof Order> {
  @Post("actions/approve")
  @DbAction("approve", { label: "Approve", intent: "positive" })
  async approve(@DbActionID() id: { id: string }, @InputForm(CommentForm) input: CommentForm) {
    await this.table.updateOne({ id: id.id, status: "approved", note: input.note });
    return { message: `Approved ${id.id}` };
  }
}
```

Wire body: `{ "ids": { "id": "abc" }, "input": { "note": "ok", "visibility": "public" } }`.

`/meta.actions[*]` for this action carries `inputForm: "CommentForm"`. Clients fetch the schema via `GET /orders/meta/form/CommentForm` and render a form.

### `GET /meta/form/:name` — form schema discovery

Per-controller route on every `AsReadableController` subclass. Returns the serialized `TSerializedAnnotatedType` of the named form (same annotation-allowlist policy as `/meta.type`). 404 when the name is unregistered.

```bash
GET /orders/meta/form/CommentForm
→ <TSerializedAnnotatedType>
```

Discovery is lazy — calling `metaForm` triggers `discoverActions` if `/meta` hasn't been hit yet. Schemas are serialized once and cached per `(controller, name)`.

### `useDbActionInput()` composable

```ts
const input = await useDbActionInput().load(); // body.input — unknown
```

Reads the cached envelope; safe inside any `INTERCEPTOR`-priority interceptor.

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
  disabled?: string; // fn.toString() — UI mirror only; server-evaluated availability is in row-level $actions
  inputForm?: string; // FormType.name when @InputForm declared; client fetches GET /meta/form/<name>
}
```

`requiredFields` is **server-internal only** — it never crosses the wire. Predicate field-deps are declared by the dev, drive server-side projection widening, and are surfaced to UIs implicitly via the row-level `$actions` overlay (see § `$actions=true`).

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
- Class-level dict entry missing `level` (use `@DbTableActions`/`@DbRowActions`/`@DbRowsActions` or set `level` explicitly).
- Class-level dict entry missing `label`.
- Two `default: true` at same `(controller × level)` — first wins, second demoted.
- `'table'`-level action with `disabled` (no row scope; gate via auth/arbac).
- Gate / `@DbActionRow*` on plain controller without `opts.table`.
- **`disabled` set without (non-empty) `requiredFields` → drop the action.** Field-deps must be declared explicitly.
- Duplicate action name within a controller — second declaration dropped.
- Two actions with the same `@InputForm` form name but different type refs on the same controller — second declaration dropped.

Value-help controllers (`AsValueHelpController` / `AsJsonValueHelpController`) silently emit `actions: []`; decorators on them are ignored.

## Class-level `'backend'` row/rows caveat

Dict-supplied `value` MUST point to a `@Post`-bound endpoint accepting the identifier-shaped JSON body — typically a method using `@DbActionID()` / `@DbActionIDs()` on the controller serving that path. Builder does NOT validate; dev-side contract.

## `$actions=true` — server-evaluated row availability

URL control on `/query`, `/pages`, `/one`, `/one/:id` (and `$search` / vector paths). When set, every returned row carries `$actions: string[]` — names of `'row'` and `'rows'`-level actions NOT disabled for that row. Action ordering follows `/meta.actions[]` declaration order.

```
GET /users/query?status=active&$actions=true
→ [{ id, status, $actions: ['edit', 'archive'] }, ...]
```

Pipeline (per request, on `AsDbReadableController`):

1. Discover row/rows-level envelopes (memoized per controller ctor).
2. Filter through per-request `applyMetaOverlay()` — actions stripped by overlay are absent. Skipped when overlay is the default no-op.
3. Pre-widen `$select` to union all `requiredFields` (only when caller restricted projection).
4. Run the read.
5. Run each `disabled` once on the full result, fan verdicts into per-row `$actions`. Actions without `disabled` are unconditionally included.
6. Strip `requiredFields`-only fields the caller didn't ask for (so the response shape matches the original `$select`).

Notes:

- `'table'`-level actions never appear in `$actions`.
- `$count` / `$groupBy` paths are NOT augmented (no row shape).
- A `disabled` length mismatch on the result-set still throws HTTP 500 — same contract as the gate.
- Caller boolean control: URL (`?$actions=true`/`1`) → server coerces; programmatic (`controls: { $actions: true }`) → boolean.
- Same predicate also runs in two other places — server-side gate enforcement on POST and UI mirror via `disabled` string.

```ts
// Client
const r = await users.query({
  filter: { active: true },
  controls: { $actions: true } as const,
});
r[0].$actions; // typed string[] on ClientResponse<T, Q>
```

## Client side: `client.action(name, id?, input?)` + `client.getActionForm(name)`

```ts
const users = new Client<typeof User>("/api/users", { navigate: (url) => router.push(url) });

await users.action("block", { id: "abc123" }); // backend, row → POST { ids: { id: "abc123" } }
await users.action("lock", [{ id: "a" }, { id: "b" }]); // rows → POST { ids: [...] }
await users.action("promote", { tenantId: "acme", userId: "u1" }); // composite PK
await users.action("promote", { email: "jane@example.com" }); // unique-index addressing (same endpoint)
await users.action("refresh-cache"); // table, no form → no body
await users.action("edit", { slug: "alpha" }); // navigate → /users/alpha/edit (preferredId-driven $1)

// Form input (third arg)
await users.action("approve", { id: "o1" }, { note: "ok" }); // → POST { ids: ..., input: { note: "ok" } }
await users.action("broadcast", undefined, { msg: "hi" }); // table + form → POST { input: ... }

await users.action<{ message: string }>("block", { id: "abc" }); // typed return shape

// Discovery — fetch the deserialized form schema for an action's @InputForm
const form = await users.getActionForm("approve"); // TAtscriptAnnotatedType | null
// → null when action has no inputForm or the action name is unknown.
// → cached per form name on the client instance.
```

- POST always (hardcoded for `'backend'`). Body is the `{ ids?, input? }` envelope; table-level + no form ⇒ no body sent.
- Single object on `'rows'`-level → **TypeError client-side** (no auto-wrap; pass `[{...}]`).
- Scalars / `null` for `id` → **TypeError client-side** for both row and rows. TS signature also rejects them at compile time when `Client<typeof T>` is used.
- `input` is `unknown` at the type level — caller's responsibility to match `FormType` (no client-side validation).
- Compound preferred-id navigate: each `preferredId` field's value URL-encoded, joined `/` in field-declaration order (NOT object-key insertion order).
- `'rows'` / `'table'` navigate: `value` verbatim (no `$1` substitution).
- `'custom'` → `ActionUnsupportedError` (UI dispatches itself).
- Unknown name → `ActionNotFoundError`.
- HTTP 409 (gate) → `ActionDisabledError extends ClientError` with `e.action` / `e.id` / `e.ids`.
- Other non-2xx → `ClientError` (same shape as other endpoints).

See [db-client.md](db-client.md) for the full client surface.

## `getAtscriptDbMate()` — typed metadata accessor

Public API for inspecting metadata written by the action decorators. Returns a `Mate` instance narrowed to every key `@atscript/moost-db` writes — no magic strings, no manual casts.

```ts
import { getAtscriptDbMate } from "@atscript/moost-db";

const mate = getAtscriptDbMate();

// Class- / method-level
const meta = mate.read(ControllerCtor.prototype, "approve");
meta?.atscript_db_action; // TDbActionMeta | undefined  — { name, opts }
meta?.atscript_db_actions; // TDbClassActionMeta[] | undefined  — class-level dict entries
meta?.handlers; // standard moost handlers[]
meta?.label; // standard @Label

// Param-level
meta?.params?.[0]?.atscript_db_action_param; // 'id' | 'ids' | undefined
meta?.params?.[0]?.atscript_db_action_row; // true | undefined
meta?.params?.[0]?.atscript_db_action_rows; // true | undefined
meta?.params?.[0]?.atscript_db_action_input_form; // TDbActionInputFormMeta | undefined
meta?.params?.[0]?.atscript_type; // TAtscriptAnnotatedType | undefined
```

Re-exports the same singleton as `getMoostMate()` from `moost`, just with the workspace-wide `TMoostMetadata` / `TMoostParamsMetadata` augmentation that `@atscript/moost-db` declares. Prefer it over `getMoostMate()` when reading `atscript_db_*` keys — the typed shape removes the need to retype string literals or hand-cast.

Companion type exports for typing your own helpers:

| Export                   | Use for                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `AtscriptDbMate`         | The fully-typed `Mate` shape (return type of `getAtscriptDbMate()`).                                |
| `AtscriptDbMeta`         | Class- and method-level keys (`atscript_db_action`, `atscript_db_actions`, …).                      |
| `AtscriptDbParamsMeta`   | Param-level keys (`atscript_db_action_param`, `atscript_db_action_input_form`, `atscript_type`, …). |
| `TDbActionMeta`          | Method-level `{ name, opts }` payload written by `@DbAction`.                                       |
| `TDbActionInputFormMeta` | Param-level `{ type, name }` payload written by `@InputForm`.                                       |
| `TDbActionParamKind`     | `'id' \| 'ids'` written by `@DbActionID*`.                                                          |
| `TDbClassActionMeta`     | Class-level dict entry written by `@DbActions` and the level-pinned shortcuts.                      |

Typical use cases: writing a custom Moost pipe that consumes `atscript_type` for validation, building tooling that introspects the `actions[]` surface without going through `/meta`, or composing a downstream decorator that needs to read what the action decorators wrote.

## Advanced internals (re-exports)

Low-level slot/cache primitives backing the composables — exported from `@atscript/moost-db` for advanced integrations (custom pipes, alternate body readers): `dbActionBodySlot`, `dbActionInputSlot`, type `DbActionEnvelope` (`actions/index.ts:13-18`). Use the composables (`useDbAction*`) by default; reach for these only when bypassing the standard envelope path.
