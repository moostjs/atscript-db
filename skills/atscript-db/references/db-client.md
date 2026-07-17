# db-client

Browser/SSR fetch client for `moost-db` REST endpoints. Zero runtime deps apart from `@atscript/db` types (type-only at runtime).

## Install

```bash
pnpm add @atscript/db-client
```

## Basic usage

```ts
import { Client } from "@atscript/db-client";
import type { User } from "./schema/user.as";

const users = new Client<typeof User>("/api/users");

await users.query(); // GET /api/users/query
await users.query({ filter: { active: true } });
await users.pages({ controls: { $sort: { name: 1 } } }, 1, 20);
// Geo (tables with @db.index.geo; all adapters → geo-search.md):
await listings.geoSearch([-122.42, 37.77], { controls: { $maxDistance: 50_000 } }); // rows + $distance
await listings.geoPages([-122.42, 37.77], {}, 1, 20);
await users.one(42); // GET /api/users/one/42 — server calls `resolveIdFilter(id)` which matches the PK or any primary identification (configurable via `@db.table.preferredId.uniqueIndex`)
await users.one({ username: "admin" }); // single-field unique idx → GET /api/users/one?username=admin (deterministic field-shape, no ambiguity)
await users.one({ orderId: 1, productId: 2 }); // composite key → GET /api/users/one?orderId=1&productId=2
await users.count({ filter: { active: true } }); // GET /api/users/query?$count=1
await users.aggregate({ controls: { $groupBy: ["role"], $select: [...] } });

await users.insert({ name: "Alice", email: "a@e.com" });
await users.insert([{ ... }, { ... }]); // array body → insertMany
await users.update({ id: 1, status: "active" }); // PATCH
await users.replace({ id: 1, ...full }); // PUT
await users.remove(42); // DELETE
await users.remove({ orderId: 1, productId: 2 }); // composite → DELETE /?orderId=1&productId=2

await users.meta(); // TMetaResponse — cached on the client instance
```

## Generic surface

```ts
class Client<T extends AtscriptClientShape = AtscriptClientShape>
```

`T` is the Atscript-annotated type for the endpoint (e.g. `typeof User`). The constraint accepts any object with the standard Atscript brand fields (`__pk`, `__ownProps`, `__navProps`, `type`); plain interfaces and `Record<string, unknown>` also satisfy it. **`new Client('/users')` (no generic) keeps working** with `unknown` / `Record<string, unknown>` fallbacks — typed callers gain inference, untyped callers see no breakage.

Per-method generic narrowing on `query()`, `pages()`, `one()`:

```ts
const r = await users.query({
  controls: { $with: [{ name: "posts" }] as const },
});
r[0].posts; // typed (no `any`) — relations not in $with are stripped from the row type
```

The narrowing mirrors backend `AtscriptDbReadable.findMany`: the row type omits `__navProps` by default, then re-adds the relations literally listed in `$with`. The `as const` (or a literal `$with: [...]`) is what TS needs to extract the relation names at the type level.

## Constructor options

```ts
new Client<T>(path, {
  baseUrl?: string,                  // prepended to every URL
  fetch?: typeof fetch,              // custom fetch (SSR / testing / auth proxying)
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>),
  navigate?: (url: string) => void | Promise<void>,  // SPA router for action() navigate dispatch
})
```

`headers` may be a function — re-evaluated per request, useful for token refresh. `navigate` overrides the default browser `window.location.assign` for `Client.action(name)` invocations of `processor: 'navigate'` actions.

## Actions

```ts
client.action<R = unknown>(
  name: string,
  id?: Partial<Own<T>> | Partial<Own<T>>[],
  input?: unknown
): Promise<R>

client.getActionForm(name: string): Promise<TAtscriptAnnotatedType | null>
```

Body shape on the wire is the **envelope** `{ ids?, input? }`:

- `ids` carries `id` (object for `'row'`, array of objects for `'rows'`, omitted for `'table'`).
- `input` carries the third arg, present only when supplied.
- Table-level + no `input` ⇒ no body sent (back-compat with bare table actions).

Identifier shape is **object-only** — single object for `'row'` actions, array of objects for `'rows'` actions, omitted for `'table'` actions. Even single-field PK tables send `{ id: "abc" }`, never the bare scalar. See [actions.md](actions.md) for the full server-side contract (legitimate identification list, strict unknown-field rejection, precedence).

```ts
import {
  Client,
  ActionNotFoundError,
  ActionUnsupportedError,
  ActionDisabledError,
} from "@atscript/db-client";

await users.action("block", { id: "abc" }); // backend, row → POST { ids: { id: "abc" } }
await users.action("lock", [{ id: "a" }, { id: "b" }]); // rows → POST { ids: [...] }
await users.action("promote", { tenantId, userId }); // composite PK
await users.action("promote", { email: "jane@example.com" }); // unique-index addressing
await users.action("refresh-cache"); // table, no form → no body
await users.action("edit", { slug: "alpha" }); // navigate → /users/alpha/edit (preferredId-driven)

// @InputForm payload (third arg)
await users.action("approve", { id: "o1" }, { note: "ok" }); // → POST { ids: ..., input: ... }
await users.action("broadcast", undefined, { msg: "hi" }); // table + form → POST { input: ... }

await users.action<{ message: string }>("block", { id: "abc" }); // typed return shape

new Client("/api/users", { navigate: (url) => router.push(url) }); // SPA integration
```

### Client-side validation

The client refuses obviously-wrong shapes BEFORE the network round-trip:

- `'row'` level + non-object (scalar, `null`, array) for `id` → `TypeError`.
- `'rows'` level + non-array (single object included — no auto-wrap) for `id` → `TypeError`.
- `input` is `unknown` — no client-side validation. Caller must match the action's `inputForm` schema; server-side validation depends on a Moost atscript validator pipe (see [actions.md § `@InputForm`](actions.md#inputformformtype--structured-user-input)).

The TypeScript signature catches the `id`-shape cases at compile time when `Client<typeof T>` is used. Untyped `Client<>` clients fall back to `Partial<Record<string, unknown>>` and get only the runtime guard.

### Form-schema discovery — `getActionForm(name)`

Lazily fetches `GET <controller>/meta/form/<inputForm>` and returns the deserialized `TAtscriptAnnotatedType`. Returns `null` when the action has no `inputForm` declared, or the action name isn't on `/meta`. Cached per form name on the client instance; failed fetches are evicted.

```ts
const meta = await users.meta();
const action = meta.actions.find((a) => a.name === "approve");
if (action?.inputForm) {
  const form = await users.getActionForm("approve");
  // → pass `form` to a UI form-renderer (e.g. @atscript/ui)
}
```

### `<R>` return-type generic

`action<R>(name, id?)` lets the caller assert the action handler's return shape. The server returns whatever the handler emits (commonly `{ message?: string, ... }` per convention); the client cannot validate. Use `<R>` to move the cast onto the call site:

```ts
const result = await users.action<{ message: string; affected: number }>("block", { id });
result.affected; // typed
```

Default `R = unknown` when omitted.

### Navigate URL substitution

For `level: 'row'` + `processor: 'navigate'`, the client substitutes `$1` in the action's `value` template by walking `meta.preferredId` field declaration order — NOT object-key insertion order. Each value is `encodeURIComponent`'d, compound preferred-id values are joined with `/`. Missing fields render as empty segments (e.g. `acme//jane`), NOT the literal `"undefined"`.

```ts
// preferredId = ['tenantId', 'userId']
await users.action("edit", { userId: "jane", tenantId: "acme/co" });
// → navigate('/members/acme%2Fco/jane/edit') — order from preferredId, not object keys
```

For `'rows'` / `'table'` navigate, `value` is sent verbatim (no substitution).

### Identifier rendering helpers

Same logic `Client.action()` uses for `$1` substitution, exported for consumers rendering identifiers elsewhere (prompt text, log lines, deep-link copy). `undefined` / `null` → `""` (never literal `"undefined"`); `bigint` → string; objects → JSON.

```ts
import { formatIdentifier, encodeNavigateId, formatIdentifierField } from "@atscript/db-client";
```

| Export                  | Use for                                                                  | Output for `{ tenantId: "acme/co", userId: "jane" }`, `["tenantId","userId"]` |
| ----------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `formatIdentifier`      | Human-readable (prompts, error messages, dialog titles). Raw, no encode. | `"acme/co/jane"`                                                              |
| `encodeNavigateId`      | Building deep-link URL templates outside `Client.action()`.              | `"acme%2Fco/jane"`                                                            |
| `formatIdentifierField` | Single-value coercion (one field, not whole object).                     | n/a — scalar in, string out                                                   |

### Errors

Throws:

- `ActionNotFoundError` — unknown name (not in `/meta`).
- `ActionUnsupportedError` — `'custom'` processor (UI dispatches the event itself); or `'navigate'` with no browser + no `navigate` option.
- `ActionDisabledError` — HTTP 409 from server-side gate. `extends ClientError`; adds typed `e.action` / `e.id` / `e.ids` accessors. See [actions.md § Server-side gate](actions.md#server-side-gate).
- `VersionMismatchError` — HTTP 409 from OCC `$cas` mismatch. `extends ClientError`; adds typed `e.currentVersion: number` accessor. Auto-dispatched when the server response body has `kind: "version_mismatch"`. See [versioning.md § Handling 409](versioning.md#handling-409).
- `ClientError` — server non-2xx (other). `ActionDisabledError` and `VersionMismatchError` extend `ClientError`, so a generic catch still works.
- `TypeError` — client-side shape validation (non-object on row, non-array on rows).

## Typed filters

`Own<T>` / `Nav<T>` / `Id<T>` / `Data<T>` / `ClientResponse<T, Q>` are computed from the `.as` type:

```ts
// Own<User>: own-prop fields (no nav props)
// Nav<User>: nav-relation fields (Record<string, unknown> when no nav present)
// Id<User>:  composite id shape when PK is composite, scalar otherwise
// Data<T>:   full data shape (Own + Nav)
// ClientResponse<T, Q>: response row — narrowed by literal $with; carries optional $actions?: string[]
```

Autocomplete works on every filter path, sort key, and `$select` element. The query/one/pages return-type narrowing is automatic when `$with` is a literal (use `as const` if TS doesn't infer it as literal).

## Per-row action availability — `$actions=true`

Opt-in URL control on read methods. When set, every returned row carries `$actions: string[]` — names of `'row'`/`'rows'`-level actions NOT disabled for that row. See [actions.md § `$actions=true`](actions.md#actionstrue--server-evaluated-row-availability) for the server-side pipeline.

```ts
const r = await users.query({
  filter: { active: true },
  controls: { $actions: true } as const,
});
r[0].$actions; // string[] | undefined  (typed via ClientResponse<T, Q>)
```

Available on `query()` / `pages()` / `one()` / `count()` is N/A. `$count` and `$groupBy` paths are not augmented. `'table'`-level actions never appear.

## Error handling

```ts
import { ClientError, ActionDisabledError, VersionMismatchError } from "@atscript/db-client";

try {
  await users.insert({ email: "bad" });
} catch (e) {
  if (e instanceof ActionDisabledError) {
    // HTTP 409 from server-side action gate (only thrown by client.action()).
    e.action; // the @DbAction name that rejected
    e.id; // row-level rejection — Record<string, unknown> (the submitted identifier object)
    e.ids; // rows-level rejection — Record<string, unknown>[]
  } else if (e instanceof VersionMismatchError) {
    // HTTP 409 from OCC $cas mismatch (PATCH/PUT with `version` in body).
    e.currentVersion; // row's now-stored version — refresh + retry
  } else if (e instanceof ClientError) {
    e.status; // HTTP status
    e.body; // parsed JSON body from the server (includes `errors[]`)
    e.errors; // convenience: `body.errors ?? []`
  }
}
```

## Meta + validator caching

- `client.meta()` lazy-fetches `/meta` on first call and caches the response.
- `meta.preferredId: string[]` is a guaranteed field (always populated; defaults to `primaryKeys`). Used internally for `'navigate'` URL substitution; consumers can read it to drive their own list-key selection or link-building.
- The client builds a runtime validator from the meta type (same validator engine as the server). Meta ships `refDepth: 0.5` so FK refs carry target discovery metadata only; nested-write depth is enforced server-side via `@db.depth.limit`.
- The meta envelope carries `crud: TCrudPermissions` (see [moost-db.md](moost-db.md) for the full shape) — built-in CRUD discoverability surface. Key absent = denied; value is the accepted UniQuery control whitelist (`[]` for write ops). There is no `readOnly` field; consumers compute it inline as `!('insert' in meta.crud) && !('update' in meta.crud) && !('replace' in meta.crud) && !('remove' in meta.crud)`.
- `TCrudOp` and `TCrudPermissions` are re-exported from `@atscript/db-client` for consumer convenience.

```ts
const validator = await client.getValidator();
validator.validate(payload, "insert"); // throws ClientValidationError with `errors: { path, message }[]`
validator.validate(payload, "patch");
validator.validate(payload, "replace");
```

Pre-flight validation saves a round-trip on bad payloads.

Patch preflight is merge-aware (≥ 0.1.124): nested `@db.patch.strategy 'merge'` blocks validate as deep partials, same as the server — do NOT hand-fill server-stamped required keys just to satisfy the client validator. Non-merge nested objects still require their full shape on patch ($set as a whole); insert/replace always validate fully. See [validation.md](validation.md) for the per-mode contract.

`new Client(path, { lenientWrites: true })` makes write preflight tolerate UNKNOWN properties (required fields/formats still enforced). Use it when the served `/meta` type is a projection of the full server type (e.g. an ARBAC read overlay strips write-only fields) — otherwise a legitimate write carrying a stripped field is rejected client-side while the server accepts it. Leave off elsewhere: strict preflight catches typos. (`createClientValidator(meta, { lenientWrites })` for standalone validators.)

## Auth

Use `headers` for bearer / cookie / CSRF:

```ts
const client = new Client<typeof User>("/api/users", {
  headers: async () => ({
    Authorization: `Bearer ${await getToken()}`,
    "X-CSRF-Token": readCsrfCookie(),
  }),
});
```

For cookie-based auth, pass `credentials: 'include'` via a custom `fetch`:

```ts
new Client<typeof User>("/api/users", {
  fetch: (input, init) => globalThis.fetch(input, { ...init, credentials: "include" }),
});
```

URL serialization uses `@uniqu/url/builder` — same grammar the server parses (see `http-query-syntax.md`). For SSR, pass a fetch-compatible function via `fetch` and request-scoped tokens via `headers`.

## `null` on 404

`client.one(id)` returns `null` for HTTP 404. All other non-2xx responses throw `ClientError`.

## Read-response baseline

Server-side, every row-returning read endpoint silently widens `$select` to include `meta.preferredId` fields. So `users.query({ controls: { $select: ['name'] } })` against a `slug`-keyed table still returns rows containing both `slug` AND `name`. See [moost-db.md § Read-response baseline](moost-db.md#read-response-baseline) for the full contract — the consequence on the client side is that list/table UIs can rely on `preferredId` fields being present without remembering to include them in `$select`.
