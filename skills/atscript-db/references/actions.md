# Actions

`@atscript/moost-db` actions — declarative row / rows / table operations surfaced via `/meta`. Use to expose row buttons, batch toolbars, header buttons, navigation entries, and UI-dispatched events without bespoke per-controller contracts.

## When to use

- A row button (Block, Archive, Approve) that POSTs to a server handler.
- A batch toolbar action over selected rows (Lock Selected, Bulk Export).
- A table-scope action (Refresh Cache, Import CSV).
- A row-level navigation entry (Edit, View Details) — no server call.
- A UI-dispatched event (open modal, copy to clipboard) — no server call.

If the operation already fits CRUD (`POST` / `PUT` / `PATCH` / `DELETE`), use CRUD. If it's a hook over CRUD (multi-tenant filter, audit fields, soft delete), use `transformFilter` / `onWrite` / etc. — see `moost-db.md`.

## Decorator cheat sheet

| Decorator               | Target    | Effect                                                                    |
| ----------------------- | --------- | ------------------------------------------------------------------------- |
| `@DbAction(name,opts)`  | method    | Marks method as backend action. Pair with `@Post(...)`. Metadata only.    |
| `@DbActionDefault()`    | method    | Sugar for `opts.default = true`. Decorator order does not matter.         |
| `@DbActionPK()`         | parameter | Reads + validates a single PK from JSON body. Infers `level: 'row'`.      |
| `@DbActionPKs()`        | parameter | Reads + validates an array of PKs from JSON body. Infers `level: 'rows'`. |
| `@DbActions(dict)`      | class     | Class-level dict; each entry must include `level`.                        |
| `@DbTableActions(dict)` | class     | Sugar — injects `level: 'table'` into each entry.                         |
| `@DbRowActions(dict)`   | class     | Sugar — injects `level: 'row'`.                                           |
| `@DbRowsActions(dict)`  | class     | Sugar — injects `level: 'rows'`.                                          |

## Level inference (method decorator only)

| Param decorators present              | Level     | On violation               |
| ------------------------------------- | --------- | -------------------------- |
| `@DbActionPK()` (no `@DbActionPKs()`) | `row`     | —                          |
| `@DbActionPKs()` (no `@DbActionPK()`) | `rows`    | —                          |
| Neither                               | `table`   | —                          |
| Both                                  | _illegal_ | warn-and-drop from `/meta` |
| Any `@DbActionPK*` + `@Body()`        | _illegal_ | warn-and-drop from `/meta` |

## Processor cheat sheet

| `processor`  | Required `value` (definition)            | `value` (in `/meta`)                                                  | UI behaviour                                                              |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `'backend'`  | required (class) / N/A (method)          | Moost-bound POST path (method) or dict-supplied path verbatim (class) | UI POSTs PK as JSON body to `value`                                       |
| `'navigate'` | required, non-empty (class only)         | dict value verbatim                                                   | UI routes to `value`; `$1` → row PK, joined `/` URL-encoded for composite |
| `'custom'`   | **forbidden** at definition (class only) | dict key                                                              | UI dispatches event named `value`; payload is UI's call                   |

For `'navigate'` and `'backend'` class entries, `undefined` / `null` / `''` are treated as missing → warn-and-drop. For `'custom'`, supplying any `value` → warn-and-drop.

## Method-decorator example (PK action)

```ts
import { AsDbController, TableController, DbAction, DbActionPK } from "@atscript/moost-db";
import { Post, Authenticate } from "@moostjs/event-http";
import { adminGuard } from "./guards";

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

`/users/meta` then includes:

```json
{
  "name": "block",
  "label": "Block",
  "level": "row",
  "processor": "backend",
  "value": "/users/actions/block",
  "icon": "i-as-block",
  "intent": "negative"
}
```

## Class-level dict example

```ts
import { DbRowActions, DbTableActions } from "@atscript/moost-db";

@TableController(usersTable)
@DbRowActions({
  edit: { label: "Edit", processor: "navigate", value: "/users/$1/edit" },
  view: { label: "View", processor: "navigate", value: "/users/$1" },
  block: { label: "Block", processor: "backend", value: "/admin/users/block" }, // backend escape hatch
})
@DbTableActions({
  refresh: { label: "Refresh", processor: "custom" }, // value filled with "refresh"
  importCsv: { label: "Import CSV", processor: "custom" },
})
export class UsersController extends AsDbController<typeof User> {}
```

## Request body shapes

```json
// row, scalar PK
"abc123"

// row, composite PK
{ "tenantId": "acme", "userId": "u1" }

// rows, scalar PK — ALWAYS an array, even for one row
["a", "b", "c"]

// rows, composite PK
[{ "tenantId": "acme", "userId": "u1" }, { "tenantId": "acme", "userId": "u2" }]
```

`Content-Type: application/json` only. Strict typing — `"42"` is rejected for a numeric PK. Mismatches return HTTP 400 with the same error envelope as DTO validation:

```json
{
  "statusCode": 400,
  "message": "...",
  "errors": [{ "path": "userId", "message": "Missing primary-key field \"userId\"" }]
}
```

**`rows`-level body is always a JSON array** — `@DbActionPKs()` rejects non-array bodies with HTTP 400. If the client invokes the action on a single row, it still sends `["a"]`, not `"a"`. Omitted `pk` (`client.action(name)`) sends `[]` — your handler runs with `ids === []`.

### `@DbActionPK*` requires an attached typed table

These resolvers validate against the controller's bound table (read via `this.readable` / `this.table`). They only work on subclasses of `AsDbController` / `AsDbReadableController` (controllers wired with `@TableController` / `@ReadableController`). Applied to a controller without a typed table, the resolver throws **HTTP 500** at request time — server-misconfig signal, not a client error.

If you need PK-shaped bodies on a controller without a typed table, use Moost's `@Body()` and parse / validate the PK yourself.

## Success response (convention, not enforced)

Backend handlers may return any JSON. Convention: if the body has a top-level `"message": string`, the UI client toasts it; otherwise the UI uses a generic per-level message. No `TDbActionResult` type, no runtime validation — pick whatever shape your client expects.

```ts
return { message: `User ${id} blocked` }; // UI toasts the message
return { message: "5 users locked", locked: ids }; // toast + extra payload
return { ok: true }; // no message → generic toast
```

## `/meta` payload shape

```ts
type TDbActionLevel = "table" | "row" | "rows";
type TDbActionIntent = "positive" | "negative" | "primary" | "secondary";
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
  promptText?: string;
}
```

`TMetaResponse.actions: TDbActionInfo[]`. Always present; `[]` when no actions are declared.

## Pitfalls

- **No `@Body()` with `@DbActionPK*`** — drops the action. Need extra payload? Use `processor: 'custom'` and a regular `@Post` handler.
- **Must have `@Post(...)`** — `@DbAction` is metadata-only. `@Get`, `@Put`, `@Patch`, `@Delete` on the same method drops the action (must be POST).
- **Label is required** — `opts.label` > `@Label('...')` > drop-with-warning. Pick one.
- **`'navigate'` / `'backend'` class entries need a non-empty `value`** — `undefined`, `null`, `''` all drop the entry.
- **`'custom'` class entries forbid `value`** — the meta builder fills it with the dict key.
- **At most one `default: true` per `(controller × level)`** — second one is demoted with a warning, first wins.
- **Stranded `@DbActionDefault()`** — `@DbActionDefault()` on a method without `@DbAction(name)` drops the action with a warning. The sugar must always pair with a name-bearing decorator.
- **Value-help controllers don't surface actions** — `AsValueHelpController` / `AsJsonValueHelpController` always emit `actions: []`; decorators applied there are silently ignored.
- **Discovery is lazy** — runs on the first `GET /meta` request, not at `app.init()`. Warnings appear on that first call. Greppable prefix: `[moost-db actions]`.
- **Composite PK in `'navigate'` `$1`** — UI joins the URL-encoded segments with `/` in `primaryKeys` order. Server emits `value` verbatim.
- **Class-level `'backend'` row/rows** — the dev-supplied `value` path MUST point to a `@Post`-bound endpoint accepting the PK-shaped JSON body — typically a method using `@DbActionPK()` / `@DbActionPKs()` on the controller serving that path. Builder does NOT validate this; it's a dev-side contract.

## Imports

```ts
import {
  // Method decorators
  DbAction,
  DbActionDefault,
  DbActionPK,
  DbActionPKs,
  // Class decorators
  DbActions,
  DbTableActions,
  DbRowActions,
  DbRowsActions,
} from "@atscript/moost-db";

import type {
  TDbActionInfo,
  TDbActionLevel,
  TDbActionIntent,
  TDbActionProcessor,
  TDbActionsEntry,
  DbActionOpts,
} from "@atscript/moost-db";
```

`@atscript/moost-db` adds `@wooksjs/http-body` as a peer dep — required by `@DbActionPK()` / `@DbActionPKs()` to read the parsed JSON body. Install alongside:

```bash
pnpm add @wooksjs/http-body
```

## Client side: `Client.action(name, pk?)`

`@atscript/db-client` exposes `client.action(name, pk?)` for invoking actions by name. Reads `/meta` (cached), resolves the action, dispatches:

```ts
import { Client, ActionNotFoundError, ActionUnsupportedError } from "@atscript/db-client";

const users = new Client<typeof User>("/api/users");

// processor: 'backend' — POSTs PK as JSON body, returns parsed response.
const result = await users.action("block", "abc123"); // → { message: "blocked" }

// level: 'rows' — pass an array; a single PK is wrapped automatically.
await users.action("lock", ["a", "b"]);
await users.action("lock", "a"); // wrapped → ["a"]

// level: 'table' — no PK.
await users.action("refresh-cache");

// processor: 'navigate' — substitutes $1, calls navigate hook.
await users.action("edit", "abc"); // window.location.assign('/users/abc/edit')

// SPA router integration
new Client("/api/users", { navigate: (url) => router.push(url) });
```

- POST is hardcoded for `'backend'` — actions are always POST.
- For composite PK row navigates: each value URL-encoded, joined with `/`.
- `'rows'` / `'table'` navigates use `value` verbatim (no `$1` substitution).
- `'custom'` → throws `ActionUnsupportedError` (clients dispatch events themselves).
- Unknown action → throws `ActionNotFoundError`.
- Server non-2xx → throws `ClientError` (same shape as other endpoints).
