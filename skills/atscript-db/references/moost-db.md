# moost-db

`@atscript/moost-db` exposes a table/view as a Moost HTTP controller.

For declarative row/rows/table **actions** (Block, Approve, Edit-navigate, Export-CSV, …) surfaced via `/meta`, see [actions.md](actions.md). This file covers controllers, generated CRUD routes, hooks, gates, errors, and value-help.

## Install

```bash
pnpm add @atscript/moost-db @moostjs/event-http moost
```

## Write controller (full CRUD)

```ts
import { AsDbController, TableController } from "@atscript/moost-db";
import { Todo } from "./todo.as";
import { todosTable } from "./db";

@TableController(todosTable) // Provide + Controller + Inherit
export class TodoController extends AsDbController<typeof Todo> {}
```

Register:

```ts
import { Moost } from "moost";
import { MoostHttp } from "@moostjs/event-http";

const app = new Moost();
app.adapter(new MoostHttp()).listen(3000);
app.registerControllers(["todos", TodoController]); // URL prefix segment
await app.init();
```

## Read-only controller (views, public read endpoints)

```ts
import { AsDbReadableController, ReadableController } from "@atscript/moost-db";
import { activeTasksView } from "./db";

@ReadableController(activeTasksView)
export class ActiveTasksController extends AsDbReadableController<typeof ActiveTasks> {}
```

## Generated routes

| Method | Path           | Purpose                                                                | Class                    |
| ------ | -------------- | ---------------------------------------------------------------------- | ------------------------ |
| GET    | `/query`       | Query rows (or `$count`, or `$groupBy` aggregate).                     | `AsDbReadableController` |
| GET    | `/pages`       | Paginated query. Returns `{ data, page, itemsPerPage, pages, count }`. | `AsDbReadableController` |
| GET    | `/one/:id`     | Single row by scalar PK.                                               | `AsDbReadableController` |
| GET    | `/one?a=1&b=2` | Single row by composite PK / compound unique.                          | `AsDbReadableController` |
| GET    | `/meta`        | Serialized type + relations + field capability map.                    | `AsDbReadableController` |
| POST   | `/`            | Insert one or many (array body → `insertMany`).                        | `AsDbController`         |
| PUT    | `/`            | Replace one or many by PK.                                             | `AsDbController`         |
| PATCH  | `/`            | Update one or many by PK.                                              | `AsDbController`         |
| DELETE | `/:id`         | Delete by scalar PK.                                                   | `AsDbController`         |
| DELETE | `/?a=1&b=2`    | Delete by composite PK / compound unique.                              | `AsDbController`         |

`ViewController` is an alias for `ReadableController` — same behaviour, different label.

## `@db.http.path` resolution

- If an author writes `@db.http.path '/authors'`, `TableController` / `ReadableController` uses that as the controller prefix when no explicit `prefix` arg is passed.
- At runtime the controller writes the final absolute path (Moost `globalPrefix` + computed prefix, leading `/`) back onto `type.metadata["db.http.path"]`.
- The `/meta` endpoint exposes this value so FK references carry the correct URL for browser value-help pickers.

## Read-response baseline

Every row-returning read endpoint (`/query`, `/pages`, `/one`, `/one/:id`, including `$search` and vector-search paths) silently unions the table's `preferredId` field set into the projection BEFORE the readable is called. Rows always carry the preferred-id fields regardless of `$select`.

| `$select` shape                              | Behaviour                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent / `undefined`                         | full projection — preferred-id fields already present, no widening needed                                                                          |
| `string[]` inclusion                         | dedupe + append missing preferred-id fields                                                                                                        |
| pure inclusion map (`{ name: 1 }`)           | add missing preferred-id keys with value `1`                                                                                                       |
| pure exclusion map (`{ id: 0 }`)             | rewritten to inclusion (all non-ignored own-table fields minus excluded) + every preferred-id field — exclusion CANNOT remove a preferred-id field |
| mixed inclusion/exclusion (`{ a: 1, b: 0 }`) | rejected before the readable call (HTTP 400)                                                                                                       |

NOT widened: `$groupBy` aggregate path (group keys are the only fields), `$count` (returns a number).

The widening happens AFTER any `transformProjection()` override resolves — devs cannot suppress preferred-id fields from a specific consumer via projection. That's intentional: every row returned by a read op is guaranteed addressable. Hide identifiers at the network/authz layer instead.

`preferredId` defaults to `primaryKeys`. To make it a slug or other unique-index field, declare `@db.table.preferredId.uniqueIndex(name?)` on the interface — see [annotations.md](annotations.md) and [actions.md § Preferred row identifier](actions.md#preferred-row-identifier).

## Hooks (override on subclass)

```ts
@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {
  protected transformFilter(filter) {
    return { ...filter, tenantId: useTenant() };
  }
  protected transformProjection(sel) {
    return sel;
  }
  protected async onWrite(action, data) {
    return this.sanitize(data);
  } // return undefined to abort
  protected async onRemove(id) {
    return id;
  }
  protected computeEmbedding(text: string) {
    return myEmbed.embed(text);
  } // enables $vector
}
```

- `transformFilter` / `transformProjection` may be async (session / ACL lookups). The framework unions `preferredId` into the projection AFTER `transformProjection()` resolves — overrides cannot suppress preferred-id fields (see § Read-response baseline).
- `onWrite` / `onRemove` returning `undefined` aborts with HTTP 500 (override to throw a richer error).
- `computeEmbedding` enables `$vector` on `/query` — without it, `$vector` → HTTP 501.

## Gate mode

- `@db.table.filterable 'manual'` + `@db.column.filterable` → server rejects any `/query` filter referencing fields lacking the field-level annotation. HTTP 400 with `path` pointing to the offending field.
- `@db.table.sortable 'manual'` + `@db.column.sortable` → same for sort keys.
- `/meta` reflects the gate: `fields[<path>].filterable` / `.sortable` mirror what the server will accept.

## Errors

Write endpoints run the server validator for the matching mode (`insert` / `patch` / `replace`). Both `ValidatorError` and `DbError` are transformed to:

```json
{
  "statusCode": 400,
  "message": "...",
  "errors": [{ "path": "email", "message": "Expected email format" }]
}
```

Status-code mapping (`validation-interceptor.ts`):

| Source                                                                                                     | HTTP |
| ---------------------------------------------------------------------------------------------------------- | ---- |
| `ValidatorError`                                                                                           | 400  |
| `DbError` code `CONFLICT`                                                                                  | 409  |
| `DbError` any other code (`FK_VIOLATION`, `NOT_FOUND`, `CASCADE_CYCLE`, `INVALID_QUERY`, `DEPTH_EXCEEDED`) | 400  |
| `ActionDisabledError` (server-side action gate rejection — see [actions.md](actions.md))                   | 409  |

## Value-help controllers

`AsReadableController`, `AsValueHelpController`, and `AsJsonValueHelpController` back non-DB `@db.rel.FK` sources (enums, static lists, JSON documents) so forms can resolve picker URLs from `@db.http.path` regardless of whether the target is a table. Typical wiring:

```ts
import { AsValueHelpController, ReadableController } from "@atscript/moost-db";

@ReadableController(RolesDictionary) // an interface with @db.rel.FK target fields
export class RolesController extends AsValueHelpController<typeof RolesDictionary> {
  // Override source(): returns the in-memory list.
}
```

`AsJsonValueHelpController` loads entries from a JSON file at startup.

## Meta endpoint shape

```ts
type TCrudOp = "query" | "pages" | "one" | "insert" | "update" | "replace" | "remove";
type TCrudPermissions = Partial<Record<TCrudOp, string[]>>;

interface TMetaResponse {
  searchable: boolean;
  vectorSearchable: boolean;
  searchIndexes: { name; description?; type? }[];
  primaryKeys: string[];
  preferredId: string[]; // logical field names, always populated; defaults to primaryKeys
  relations: { name; direction: "to" | "from" | "via"; isArray }[];
  fields: Record<string, { sortable; filterable }>;
  type: TSerializedAnnotatedType; // always refDepth: 0.5 (FK refs shallow; see relations.md)
  actions: TDbActionInfo[]; // declared actions; `[]` when none. See actions.md.
  crud: TCrudPermissions; // built-in CRUD surface; key absent = denied
}
```

`crud` declares which built-in CRUD operations the controller exposes and the
accepted UniQuery control whitelist per read op (`[]` for write ops). Per-base-class emission:

- `AsDbReadableController` → `{ query, pages, one }`
- `AsDbController` → inherits + `{ insert: [], update: [], replace: [], remove: [] }`
- `AsValueHelpController` / `AsJsonValueHelpController` → `{ query, pages, one }`

Whitelists are exported as constants from `@atscript/moost-db`: `QUERY_CONTROLS`, `PAGES_CONTROLS`, `ONE_CONTROLS`.

There is no `readOnly` field; consumers compute it inline as
`!('insert' in crud) && !('update' in crud) && !('replace' in crud) && !('remove' in crud)`.

### Per-request overlay hook

`AsReadableController` exposes a protected `applyMetaOverlay(meta): TMetaResponse | Promise<TMetaResponse>`
that runs on every `/meta` request after the cached static envelope is built.
Default no-op. Subclasses override it to prune `crud` keys, `crud[op]`
controls arrays, and `actions[]` based on the current request principal —
derive the principal via `@wooksjs/event-http` composables inside the hook
(`useAuthorization()`, `useHeaders()`, `useCookies()`, `useRequest()`,
`useHttpContext()` — there is no `useRequestContext`). Must shallow-clone
before pruning; mutating the cached envelope leaks per-request state.

### Pitfalls

- Overlay filtering is informational only — hiding a `crud` key or `actions[]`
  entry does NOT block the underlying route. Custom `applyMetaOverlay()`
  overrides are discoverability hints, not access control; per-principal
  request enforcement is a separate concern.
- `client.meta()` caches per `Client` instance. SSR setups that share a Client
  across users will pin the first principal's overlay; instantiate a Client
  per request when running per-principal overlays server-side.
- `actions[].disabled` and `actions[].requiredFields` are UI hints emitted by
  `discoverActions()`; server enforcement is via the gate interceptor on the
  decorated `@Post` handler (authoritative). See [actions.md § Server-side gate](actions.md#server-side-gate).

Consumed by `@atscript/db-client` to build a client-side validator matching the server's.

Wire CORS / auth / rate-limiting as Moost interceptors (`@Intercept`) — routes from `AsDbController`/`AsDbReadableController` participate normally.
