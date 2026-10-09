# moost-db

`@atscript/moost-db` exposes a table/view as a Moost HTTP controller.

For declarative row/rows/table **actions** (Block, Approve, Edit-navigate, Export-CSV, …) surfaced via `/meta`, see [actions.md](actions.md). This file covers controllers, generated CRUD routes, hooks, gates, errors, and value-help.

## Install

```bash
pnpm add @atscript/moost-db @moostjs/event-http moost
```

## Write controller (full CRUD)

Preferred: bind by **model token** — no DbSpace needed at import time.

```ts
import { AsDbController, TableController } from "@atscript/moost-db";
import { Todo } from "./todo.as";

@TableController(Todo) // Provide + Controller + Inherit; resolves at app.init()
export class TodoController extends AsDbController<typeof Todo> {}
```

Register (the space BEFORE `app.init()`):

```ts
import { Moost } from "moost";
import { MoostHttp } from "@moostjs/event-http";
import { provideDbSpace } from "@atscript/moost-db";
import { db } from "./db";

const app = new Moost();
app.adapter(new MoostHttp()).listen(3000);
provideDbSpace(db); // ambient registry — token bindings resolve against it
app.registerControllers(["todos", TodoController]); // URL prefix segment
await app.init();
```

## Insert ignore and closing spaces (0.1.148) {#insert-ignore-and-closing-spaces-01148}

- **`POST /?$onConflict=ignore`** — skip rows colliding on the PK / a unique index. Object body → `{ insertedId?, conflict }`, array body → `{ insertedCount, insertedIds, inserted, conflicts }` (index-based; same 2xx status even when all rows conflicted). `$onConflict` ∈ `error` (default) | `ignore`; other value or any other `$` control on POST → 400. Nested TO-parent payload / validation / NOT NULL / FK errors → 400/409 as for a plain insert. `guardWrite` / `checkWrite` run as usual (guard sees every submitted row). `prepareRequest` gets `ctx.onConflict === "ignore"` on `endpoint: "insert"` — throw to refuse the mode. `/meta.crud.insert` = `["onConflict"]` when the adapter supports it (`supportsInsertIgnore()`). Existence disclosure = an input index only (no row data, no constraint name).
- **`closeDbSpaces()`** (`@atscript/moost-db`) closes every distinct `provideDbSpace()`-registered space (`AggregateError` on failures) and clears the registry. NOT hooked into `Moost.dispose()` (the registry outlives app instances; Vite HMR reloads would close the live connection) — wire it into your shutdown: `app.disposeOnSignals()` + a DI singleton `@MoostDispose() close() { return closeDbSpaces() }`; one space: `await app.dispose(); await space.close()`. Requests after close → `DbError("SPACE_CLOSED")` → 503.

## Binding forms

`TableController` / `ReadableController` / `ViewController` all accept three
binding forms (second arg: prefix string or `{ prefix?, space? }`):

| Form                                                  | Resolves           | Use when                                                                       |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `@TableController(Model)`                             | lazily at `init()` | Default. Space from `@db.space` annotation → `{ space }` option → `"default"`. |
| `@TableController(() => db.getTable(Model), "todos")` | lazily at `init()` | Table needs custom construction. Explicit prefix REQUIRED (throws otherwise).  |
| `@TableController(todosTable)`                        | eagerly at import  | Legacy — DbSpace must exist when the controller module loads.                  |

Rules:

1. Token/factory forms kill module-eval-order coupling: import controllers anywhere, connect the DB, `provideDbSpace(db)`, then `await app.init()`.
2. Multi-space: `provideDbSpace(analyticsDb, "analytics")` + `@db.space "analytics"` on the model (or `@TableController(Model, { space: "analytics" })` to override).
3. Subclass with its own constructor (extra DI services): call `super(moost)` — the base ctor is `(app, readable?)`; omit the readable and the base resolves it from the decorator's class metadata. No module-scope `getTable` needed:

```ts
@TableController(Job)
export class JobsController extends AsDbController<typeof Job> {
  constructor(
    moost: Moost,
    private readonly registry: JobRegistry,
  ) {
    super(moost);
  }
}
```

4. Missing space at init → descriptive throw naming `provideDbSpace`. `clearDbSpaces()` resets the registry (tests).
5. Mount prefixes: the tuple form `registerControllers(["api/todos", Ctrl])` REPLACES the model-derived prefix — pass the full path. To mount many controllers under a base path while keeping derived prefixes, use `registerControllers({ prefix: "api", controllers: [CtrlA, CtrlB] })` (prepends by default; moost ≥ 0.6.32) or Moost's `globalPrefix` option.

## Read-only controller (views, public read endpoints)

```ts
import { AsDbReadableController, ReadableController } from "@atscript/moost-db";
import { ActiveTasks } from "./active-tasks.as";

@ReadableController(ActiveTasks) // token form; instance + factory forms work too
export class ActiveTasksController extends AsDbReadableController<typeof ActiveTasks> {}
```

## Exposure assertion (dev)

After `init()`, warn for models with no bound controller:

```ts
import { assertExposed } from "@atscript/moost-db";
const missing = assertExposed(app, atscriptModels); // default: only models that declare @db.http.path in the schema
// Prefix-bound repos (no @db.http.path anywhere): audit EVERY passed model
assertExposed(app, atscriptModels, { all: true, exclude: [InternalCache] });
```

A `@db.alias` type in the list is skipped (0.1.141) — a join scope, not a model a controller serves.

Detects token + instance bindings; lazy-factory bindings can't name their model — with `all: true` they false-positive, so list them in `exclude`.

## Writable table access in readable controllers

`AsDbReadableController` (and subclasses) expose `this.table` — the bound readable as a writable `AtscriptDbTable`. Action handlers write through it; NEVER keep a module-scope `db.getTable(Model)` just to regain write access. Throws for view-bound controllers.

## $search fallback + write-only fields

- The native index gate also treats `@db.writeOnly` fields as not visible (an index reading one is refused even without a `hasField` override); `@db.writeOnly` cannot be combined with `@db.index.fulltext` / `@db.column.searchable` (compile error). Native `$count` passes the request's sealed search controls (`$fuzzy`, …) through the same builder as `/query` / `/pages`.
- `@db.column.searchable` fields (string or integer — an integer matches by substring of its decimal text, since 0.1.150; numeric IDs need no `applySearchFallback` override): `$search` works without native search (escaped case-insensitive substring, `$or` across annotated fields; native search wins when configured; `/meta` reports `searchable: true`). "Native search" means TEXT search: a vector-only table (`@db.search.vector` and no `@db.index.fulltext`) reports `searchable: false`, so the fallback applies there and `/meta` still reports `vectorSearchable: true` (since 0.1.131).
- `@db.writeOnly` fields: settable via insert/update/replace, sealed out of ALL reads (projections force-exclude them; filter/sort/`$groupBy` on them → 400; `/meta` serves the type with `fields[path].writeOnly: true`). Server-side `table.findOne` still sees the value — the seal is HTTP-layer. Joined rows are sealed too (0.1.143, every controller): each `$with` entry at any depth drops the TARGET table's writeOnly fields from its `$select` (default included), and a `$with` sub-filter / sub-sort on one → the same 400 naming the full path (`owner.password`). ≤ 0.1.142 joined rows carried the values. View columns over a writeOnly source inherit the seal → [tables-and-views.md § Read seals](tables-and-views.md#read-seals-01143).

## Testing fixture

```ts
import { provideTestDbSpace, resetTestDbSpaces } from "@atscript/moost-db/testing";
beforeAll(() => provideTestDbSpace([User, Post])); // in-memory space, registered for token binding
afterAll(() => resetTestDbSpaces());
```

No DB connection or import-order dance — see [testing.md](testing.md).

## Generated routes

| Method | Path                               | Purpose                                                                                                                                                                                                                         | Class                    |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| GET    | `/query`                           | Query rows (or `$count`, or `$groupBy` aggregate).                                                                                                                                                                              | `AsDbReadableController` |
| GET    | `/pages`                           | Paginated query. Returns `{ data, page, itemsPerPage, pages, count }`.                                                                                                                                                          | `AsDbReadableController` |
| GET    | `/one/:id`                         | Single row by scalar id — PK first, among rows the `transformOne` overlay admits (0.1.143; see § Hooks).                                                                                                                        | `AsDbReadableController` |
| GET    | `/one?a=1&b=2`                     | Single row by composite PK / compound unique.                                                                                                                                                                                   | `AsDbReadableController` |
| GET    | `/geo`                             | Distance-ranked geo search (`$center=lng,lat` required; `$maxDistance`/`$minDistance` meters; rows carry `$distance`). Validated like `/query` (0.1.143). → [geo-search.md](geo-search.md).                                     | `AsDbReadableController` |
| GET    | `/meta`                            | Serialized type + relations + field capability map.                                                                                                                                                                             | `AsDbReadableController` |
| GET    | `/meta/form/:name`                 | Serialized `TSerializedAnnotatedType` of an action's `@InputForm` form (404 unknown name, or `authorizeForm` → `false`).                                                                                                        | `AsDbReadableController` |
| GET    | `/meta/actions/:id` (+ `?a=1&b=2`) | Row-level actions runnable on one row: `{ actions, disabledReasons? }` — no read grant, unknown ≡ out-of-scope → `{ actions: [] }` (0.1.145). → [actions.md](actions.md#get-metaactionsid--available-actions-for-one-row-01145) | `AsDbReadableController` |
| POST   | `/delegated-actions/:name`         | Query target for a `@DbActionsFrom` action whose source declares `queryTarget` (0.1.147); 404 otherwise. → [view-actions.md](view-actions.md)                                                                                   | `AsDbReadableController` |
| POST   | `/`                                | Insert one or many (array body → `insertMany`).                                                                                                                                                                                 | `AsDbController`         |
| PUT    | `/`                                | Replace one or many by PK.                                                                                                                                                                                                      | `AsDbController`         |
| PATCH  | `/`                                | Update one or many by PK.                                                                                                                                                                                                       | `AsDbController`         |
| DELETE | `/:id`                             | Delete by scalar id (PK first). Out of the `transformOne` overlay → 404 like missing (0.1.143).                                                                                                                                 | `AsDbController`         |
| DELETE | `/?a=1&b=2`                        | Delete by composite PK / compound unique.                                                                                                                                                                                       | `AsDbController`         |

`ViewController` is an alias for `ReadableController` — same behaviour, different label.

## `@db.http.path` resolution

- If an author writes `@db.http.path '/authors'`, `TableController` / `ReadableController` uses that as the controller prefix when no explicit `prefix` arg is passed.
- After `app.init()` (0.1.150) each app publishes the model's value-help URL — the controller's own bound route (Moost `globalPrefix` + computed prefix, leading `/`, no `//` or trailing `/`) — derived from `app.getControllersOverview()` in a moost `addInitHook` (needs moost >= 0.6.46, `@atscript/typescript` >= 0.1.101). Constructors never write it; registration order and constructor injection don't matter. The runtime `type.metadata["db.http.path"]` mirrors the last app that published; `/meta` and `/meta/form/:name` are resolved per serving app (`annotationOverrides`), so FK refs, terminal refs, `@ui.valueHelp` targets and decorations carry the model's canonical path.
- Decorators and `assertExposed` read the schema's design-time value (`@db.http.path` as written), never a published path.
- Own root: the root of a controller's own `/meta` carries that controller's own mount (a secondary mount answers with its route); references to the model elsewhere carry the canonical one.
- **Several controllers over one model:** `canonical: true` on the binding decorator (`@TableController(Model, { canonical: true })`, also `@ReadableController` / `@ViewController`) or as the trailing `{ canonical }` constructor option of `AsValueHelpController` (4th arg) / `AsJsonValueHelpController` (5th arg) picks the published route; `canonical: false` excludes a mount. Without markers: one distinct mount wins; else the mount whose prefix came from the model's own `@db.http.path` (no explicit prefix) wins; else the model is ambiguous: no path is published and one deduped warning (`app.getLogger("moost-db")`) names the routes. Never throws. Two `canonical: true` mounts on different routes also warn. Parametric mounts (`:param`, `*`) never publish. The same class imported twice needs a subclass to be marked.
- Delete app-side `@MoostInit` hooks that repair `db.http.path` (`getHandlerPaths` + `type.metadata.set`) — superseded.
- FOR_EVENT readables publish with the app's singletons; an app with only FOR_EVENT readables publishes on first construction or first `/meta`. A subclass that overrides `serializeForMeta` and calls `getSerializeOptions()` directly loses the per-app overrides (falls back to the mirror); a subclass `annotationOverrides` is composed (its entry wins). `resolveMeta()` is async in the base since 0.1.150.

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

### `$actions=true` augmentation

Opt-in URL/control flag (`?$actions=true`, or `controls: { $actions: true }`). When set, every returned row gets `$actions: string[]` listing `'row'`/`'rows'`-level action names that are NOT disabled for that row. The pipeline:

1. Discover row/rows-level envelopes for the controller (memoized).
2. Filter through `allowedActions(names)` (0.1.145; default = per-request `applyMetaOverlay()`) (`meta()` skipped when overlay is identity); rows outside an action's `actionRowScope` (0.1.145) don't list it.
3. Pre-widen `$select` to union all `requiredFields` when caller restricted projection.
4. Run the read.
5. Run each `disabled` predicate once on the full result (length-mismatch → HTTP 500); string verdicts also set `$disabledReasons: { [action]: reason }` on that row.
6. Strip widened-only fields the caller didn't ask for.

Not augmented: `$count`, `$groupBy`. See [actions.md § `$actions=true`](actions.md#actionstrue--server-evaluated-row-availability).

## Hooks (override on subclass)

```ts
@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {
  protected async prepareRequest(ctx: TDbRequestContext) {
    requestScopes.set(await loadScopes(ctx.endpoint)); // FIRST on every endpoint; throw HttpError to deny
  }
  protected transformFilter(filter) {
    return { ...filter, tenantId: useTenant() };
  }
  protected transformOne(filter) {
    return this.transformFilter(filter);
  } // defaults to transformFilter
  protected transformProjection(sel) {
    return sel;
  }
  protected async onWrite(action, data) {
    return this.sanitize(data);
  } // untrusted body, OUTSIDE any tx; return undefined → 500, return/throw an Error → that error
  protected async onRemove(id) {
    return id;
  }
  protected async guardWrite(ctx: TDbWriteGuardContext<User>) {
    // validated rows, INSIDE the table's own tx (the override becomes the table's `guard` option)
    if ((await ctx.current(0))?.locked) throw new HttpError(409, "locked");
    ctx.rows[0].updatedBy = useUserId(); // enrich in place; the table re-validates afterwards
  }
  protected async guardRemove(ctx: TDbRemoveGuardContext<User>) {
    if ((await ctx.current())?.isFallback) throw new HttpError(409);
  }
  protected async checkWrite(ctx: TDbWriteCheckContext) {
    // post-image, INSIDE the tx after main write + nested phases (the override becomes the table's `check`)
    const n = await ctx.count({ $and: [{ $or: [...ctx.filters] }, { tenantId: useTenant() }] });
    if (n !== ctx.filters.length) throw new HttpError(403);
  }
  protected authorizeForm(name: string, actionNames: readonly string[]) {
    return actionNames.some((a) => mayRun(a)); // false → 404 like an unknown form
  }
  protected computeEmbedding(text: string) {
    return myEmbed.embed(text);
  } // enables $vector
  protected async decorateRows(rows: Record<string, unknown>[], ctx: TDbDecorateContext) {
    const unread = await countUnread(rows.map((r) => r.id)); // one batch per response
    for (const row of rows) row.$unread = unread.get(row.id) ?? 0;
  } // optional; defining it switches it on
}
```

- `transformFilter` / `transformOne` / `transformProjection` may be async (session / ACL lookups).
- `prepareRequest(ctx)` (0.1.143; `TDbRequestContext = { endpoint, controls?, filter?, action? }` — `filter` (0.1.147) = parsed CLIENT filter on `query`/`pages`/`geo`, absent when empty) = THE async entry point for permission layers: resolve policy here, the sync hooks (`hasField`, `validateControls`, capability gate) read it back. No base impl — defining it switches it on (awaited only then). Runs ONCE per request before anything else looks at it: reads (`query`/`pages`/`geo`/`one`) right after URL parse, before validation + every other hook, `ctx.controls` = the parsed controls (mutate to rewrite; the pipeline validates what you leave); writes (`insert`/`replace`/`update`/`remove`) at handler start, before the shape gate + `onWrite`/`onRemove`; `meta`/`metaForm` first; `availableActions` (`GET /meta/actions/:id`, 0.1.145) first; every `@DbAction` handler (`endpoint: "action"`, `ctx.action` = name) from the action interceptor after the guards, before ids/rows/overlay ([actions.md § prepareRequest on actions](actions.md#preparerequest-on-actions-01143)). Throw (`HttpError`) to deny. Value-help controllers call it too. Every built-in route enters through `parseRequest(endpoint, url?)` (parse + `$actions` coercion + the hook; returns `TDbParsedRequest = { parsed, controls, hasNonControl }`; no `url` → hook only) — custom routes on a subclass: `const { parsed, controls } = await this.parseRequest("query", url)` / `await this.parseRequest("insert")`. No per-row work here — row policy belongs in `transformFilter` / `guardWrite` / `checkWrite`.
- `hasField(path)` = THE per-request field-visibility hook: `false` → the same 400 as a nonexistent field (`Unknown field "x"`; `$with` → `Unknown relation "x"`, hidden relations not listed). `$with` relation names are checked at EVERY level (0.1.143): nested `$with` and each dotted segment against their own target table, `hasField` at the full path (`owner.org` for `$with=owner($with=org)`), BEFORE the sub-query paths — so an unknown/hidden nested relation is `Unknown relation "org"` (listing that level's visible relations), never `Unknown field "owner.org"`. The wording's single source is the exported `unknownRelationError(name, visible): HttpError` — throw it from a permission layer instead of re-typing the 400. Since 0.1.133 EVERY gated path consults it first — filter keys (any `$and`/`$or`/`$not` depth, `$exists`), `$sort`, `$select`, `$groupBy`, `$having`, aggregate/bucket `$field`, `$with` roots + sub-paths, `$search` fallback fields. 0.1.128–0.1.132: stored leaves skipped it → filter/sort on a hidden column was a value oracle. It only rejects references: pair with `transformProjection` (strip values) + `applyMetaOverlay` (`/meta` is cached, never consults it). Since 0.1.143 an override also gates INDEXES by their logical paths (`indexFieldPaths()`; an integer `@db.index.fulltext` member is an index field like any other — an index reading a hidden integer member is refused like one reading a hidden string): `$search&$index=<n>` reading a hidden field → `400 Search index "<n>" not found`; hidden DEFAULT text index → `400 No search index available` for `$search` without `$index` (0.1.147; ≤ 0.1.146 it fell back to the substring search) — tables WITHOUT native search keep the `@db.column.searchable` fallback over visible fields; `$vector[=<n>]` → `400 Vector index "<n>" not found` / `No vector index available` (before `computeEmbedding` runs); `/geo` → the missing-geo-index 400. Unknown names answer identically. A `@db.column.derived` field follows its source: visible only while `hasField(sourcePath)`; source hidden → sealed out of every read projection for the request (joined `$with` rows too, source checked as `rel.<source>`), like writeOnly, and never loaded as an action `requiredFields` entry. The controller's `fieldVisibility` (`TDbFieldVisibility`: `scoped`, `isVisible(path)`, `sealedFor(readable, prefix?)`) is the one object every surface consults. Since 0.1.134 it also gates ROW IDENTIFICATION: a unique index over a hidden field is not an identification — `/one/<v>` → 404 like a no-match, `/one?<k>=<v>` → the `?nope=x` 400 (`Query params do not match any primary key or unique index`), `DELETE /<v>` / `DELETE /?<k>=<v>` same, PK-less `PATCH` keyed by it → identifies no row, action `ids` → rejected like an unknown shape (message lists visible keys only). PK / `preferredId` / `@meta.id` always addressable. The nested-object hint (`"a" is a nested object — … (leaves)`) lists visible leaves only; all leaves hidden → `Unknown field "a"`. The identification narrowing is only active when `hasField` is overridden (the default accepts every real path); the controller's `idSource` getter exposes the narrowed identifications (one stable object per outcome, the readable itself when nothing is hidden).
- `transformProjection(projection)` receives the WIRE `$select`: inclusion = ARRAY (`['a']`), exclusion = OBJECT (`{ a: 0 }`). Normalize the array to `{ a: 1 }` before intersecting with a role projection — an object-expecting helper reads `['a']` as an exclusion keyed `"0"` and stops narrowing.
- `transformOne(filter)` — gates `/one/:id` and `/one?…` reads. Defaults to `transformFilter`, so any row-level read overlay also applies to id-based reads (existence not leaked via `findById`). Override to scope `/one` differently. Since 0.1.143 the overlay also scopes id RESOLUTION and deletes: `/one/:id`, `/one?…`, `DELETE /:id`, `DELETE /?…` resolve PK-first among in-scope rows only (`resolveRowFilter(id, { scope })` → [crud.md § Id resolution](crud.md#id-resolution--one-row-primary-key-first-01143)); `DELETE` never removes an out-of-scope row → 404 like missing. It also scopes `@DbAction` ids / rows → [actions.md § Row scoping](actions.md#row-scoping-01143).
- The framework unions `preferredId` into the projection AFTER `transformProjection()` resolves — overrides cannot suppress preferred-id fields (see § Read-response baseline). Quantity-ref projection (`@db.amount.currency.ref` / `@db.unit.ref`) also auto-widens `$select` so currency/unit ref fields are present.
- `onWrite` / `onRemove` returning `undefined` aborts with HTTP 500; returning an `Error` instance throws it (since 0.1.128 — was passed on as data).
- Write pipeline (since 0.1.128): `prepareRequest` (when implemented, 0.1.143) → shape gate 400 (`errors[{ path: "" | "[i]", message: "Expected an object" }]`, body must be an object / array of objects, hooks not called) → `onWrite` (outside tx; must return the shape it received — object / array of objects — else 500 "Not saved") → table op (the TABLE's own tx: validate → guard, only when `guardWrite` / `guardRemove` is overridden → re-validate → write → nested phases → `checkWrite`, only when overridden) → 404/409 disambiguation AFTER the table call. Unmodified controllers: the table is called exactly as before, no guard, no double validation. There is no `transactionalWrites` flag — overriding a guard is the switch.
- `guardWrite(ctx)` = the table's `TWriteOptions.guard` (see `crud.md`): `ctx.action`, `ctx.rows` (validated; `undefined` props pruned; defaults applied on insert/replace; `$cas` stripped on update — mutate in place, re-validated), `ctx.expectedVersions[i]`, `ctx.current(i)` (lazy memoised pre-image inside the tx; `null` when missing or no key yet, never throws), `ctx.currentAll()` / `ctx.filterFor(i)` (0.1.143, → crud.md). `guardRemove(ctx)` = `deleteOne`'s `TDeleteOptions.guard`: `ctx.id`, `ctx.filter` (exact, PK first — 0.1.143), `ctx.current()` — a missing row still reaches the guard (`current()` → `null`; the 404 comes AFTER the guard); only an id that resolves to no filter (malformed for the key type) is 404 BEFORE the guard. Reject by THROWING (`HttpError`) — the table rolls back, the error propagates unchanged.
- Guard rules: never swallow `DbError` (PG aborted tx); never await external I/O on SQLite (holds the only connection → deadlock, 503 only with `transactionWaitTimeoutMs`); Mongo replica set may RE-RUN the guard (idempotent); standalone Mongo / memory adapter: no rollback. A guard writing the same row bumps its version twice.
- `checkWrite(ctx)` (0.1.143) = the table's `TWriteOptions.check` → [crud.md § Post-write check](crud.md#post-write-check-check-01143). Overriding is the switch. Once per insert / replace / update call (bulk included), inside the tx AFTER the main write + nested phases; never on deletes. `ctx.transactional === false` (standalone Mongo, memory) → nothing rolls back: enforce in `guardWrite` there.
- `authorizeForm(name, actionNames)` (0.1.143, default `true`, may be async): `false` → the same `404 Unknown form "<name>"` as an unknown form. `actionNames` = discovered actions using that form — allow iff the caller may run one. `$actions=true` augmentation and `metaForm` read the overlaid envelope via `resolveMeta()` (`applyMetaOverlay` over the cached envelope, not an overridden `meta()`) and never re-run `prepareRequest`.
- `indexFieldPaths()` (0.1.143, protected, cached): `TDbIndexFieldPaths[]` = `{ name, type: "text" | "vector" | "geo", fields, isDefault }` — logical paths each index reads. Since 0.1.147 `/meta` prunes itself by the gate's rule under an overridden `hasField` (`searchIndexes` minus indexes reading a hidden field; `searchable` / `vectorSearchable` / `geoSearchable` off when the default index of that type reads one; `searchable` stays on for the fallback of a non-native table while a fallback field is visible; `crud.query`/`crud.pages` drop `index`+`fuzzy` when no text index (nor fallback) is visible, `vector`+`threshold` when no vector index is, `search` when neither; `crud.geo` removed when no geo index is visible — a named visible index keeps its controls) — no `applyMetaOverlay` pruning needed. Text/vector entries = the adapter's `getSearchIndexes()` (`TSearchIndexInfo.fields` / `isDefault`); no `fields` (e.g. a dynamic Mongo search mapping) → every field (fail-closed); no flagged default → `DEFAULT`-named, else the first of its type. Override to describe an index the model can't express.
- `validateControls(controls, type)` — `type` includes `"geo"` since 0.1.143 (`/geo` used to skip it).
- `this.withTransaction(fn)` — one tx across table ops in custom routes/actions (`this.table.getAdapter().withTransaction`).
- `version` + differing `$cas` → 400 at `$cas` (`Ambiguous version: "version" and "$cas.version" differ`, `[i].$cas` in bulk); a malformed `$cas` beside `version` reports `separateCas`'s own message (shared `reconcileCas` from `@atscript/db`).
- Built-in write failures are THROWN `HttpError`s (wire-identical; a throw also rolls back a wrapper `withTransaction` around `super.update()`; on a throw the router may fall through to a later matching route).
- `allowedActions(names)` (0.1.145, sync or async): the subset of row-level action names the caller may run — what `$actions` and `GET /meta/actions/:id` list. Default = names in the `applyMetaOverlay` action set (no call when `applyMetaOverlay` isn't overridden). Override to answer from per-action permission checks instead of building the full `/meta` overlay per `$actions` read. Listing only — the action gate still enforces each call.
- `getDbEndpoint(controllerOrClass, method)` (0.1.145, exported): the `prepareRequest` endpoint a framework handler delegates its authorization to — `"availableActions"` for both `meta/actions` handlers, `"delegatedAction"` for `POST delegated-actions/:name` (0.1.147), `undefined` for every other handler (normal per-route authorization). Authorization interceptors: `if (getDbEndpoint(ctrl, method)) return;` instead of hard-coding moost-db method names. Inherited by subclass overrides.
- `discoverRowLevelActions(ctor, app, logger)` (exported 0.1.145): the `'row'`/`'rows'` subset of `discoverActions` (`TDbActionEnvelope[]`, `/meta.actions` order), memoized per class.
- `resolveRowIds(ids, ctx)` (0.1.148): map stale / alias ids to the row's current id — one hook for `/one`, `DELETE`, `/meta/actions` and action ids. → [§ resolveRowIds](#resolverowids--stale--alias-ids-01148)
- `actionRowScope(actionName, ctx)` (0.1.145; `ctx` = candidate rows since 0.1.147): the rows an action may run on — enforced by the action gate (404 / missing-id slot; asked BEFORE the load without an overlay — an unrestricted answer loads nothing), reflected in `$actions` and `GET /meta/actions/:id`. May use `$some` / `$none` on any relation (server-side → no opt-in, 0.1.147). → [actions.md § actionRowScope](actions.md#actionrowscope--per-action-row-scope-01145)
- `transformRelationFilter(path, filter)` (0.1.147): row overlay of the related table inside CLIENT `$some` / `$none` → [§ Relational predicates over HTTP](#relational-predicates-over-http-01147).
- `queryTargetScope(action)` (0.1.147): read scope a query target resolves under (default `transformFilter({})`); throw to refuse "all matching". → [query-targets.md](query-targets.md)
- `resolveQuery(q, { select?, cap?, scope? })` (0.1.149): rows of THIS controller matching a `/query` string or query-target envelope, as its READ for the current caller. → [query-targets.md](query-targets.md)
- `@DbActionsFrom(() => Source, { idMap?, actions? })` (0.1.147): list a source controller's row actions on this (view) controller. → [view-actions.md](view-actions.md)
- `computeEmbedding` enables `$vector` on `/query` — without it, `$vector` → HTTP 501.
- `@DbDecorations(DecoInterface, { requires: { key: ["ownerId"] } })` (0.1.148, class decorator, inherited under `@Inherit()`; value-help controllers refuse it): DECLARES the display-only keys `decorateRows` computes. `DecoInterface` = a plain `.as` interface (no `@db.table` / `@db.view`; keys = top-level identifiers, no `$`, no dots, no collision with a field / relation of the readable). `/meta` gains `decorations` (serialized interface — `@meta.*` / `@expect.*` / `@ui.*` travel) + `fields[key] = { sortable: false, filterable: false, decoration: true }`; NOT in `/meta.type` (forms + client write validation unaffected). Clients `$select` a key like a field; no `$select` = all visible served; `-key` excludes. Filter / `$exists` / `$sort` / `$groupBy` / `$having` / aggregate / bucket / grouped `$select` on a key → 400 `Field "x" is display-only…` (hidden source → `Unknown field`). `requires` = own readable paths (not nav, not `@db.writeOnly` — boot error), or a parent object of own fields (SQL flattens nested objects to leaves; the parent expands to them so the hook gets the whole object on every adapter; a parent with any `@db.writeOnly` descendant is a boot error on every adapter; a parent narrowed to leaves by `transformProjection` is served only when every leaf survives, and a hidden leaf hides it) the hook reads: auto-selected, stripped from the response unless the client selected them; a decoration is served + listed in `/meta` ONLY while every `requires` path is visible (`hasField`) and kept by `transformProjection` (silently dropped otherwise). Decoration keys never reach `transformProjection` / `hasField` / `applyMetaOverlay`'s `fields` (an overlay may delete a prop from `meta.decorations`). `TDbDecorateContext.decorations: ReadonlySet<string>` = keys requested ∧ served — compute only those; a declared key not in it is deleted from the rows after the hook. Undeclared `$` keys unchanged. Data from outside the table is the developer's to protect. → [db-client.md](db-client.md#decorations-since-01148)
- `decorateRows(rows, ctx)` (since 0.1.136; `TDbDecorateContext` exported from `@atscript/moost-db`): post-read hook with no base impl — defining it switches it on. Mutate `rows` in place (return ignored; may be async). Runs ONCE per response with the top-level rows on `/query`, `/pages`, `/geo`, `/one` (`/one/:id` + `/one?…`), AFTER `$actions` augmentation. `ctx = { endpoint: "query" | "pages" | "geo" | "one", projection, controls }` — `projection` = effective `$select` after `transformProjection` + write-only seal (`undefined` = all columns). NOT called for `$count`, `$groupBy`, a `/one` 404, value-help controllers; nested `$with` rows are never passed on their own. Rules: prefix added keys with `$` (convention, not enforced); never overwrite `$actions` / `$disabledReasons`; columns pulled in only by an action's `requiredFields` are already stripped — widen via `transformProjection` if the hook needs a column (it then ships in the response). NEVER "correct" a stored (native) column in the hook: the DB filters / sorts / groups / counts on the STORED value (shown value ≠ sort/filter value), and `requires` inputs are read only for a requested decoration key — a `$select` naming no decoration reads none, so the correction runs without its inputs. Derived value → view field with `@db.compute` ([tables-and-views.md § Computed columns](tables-and-views.md#computed-columns-01147)) or a declared decoration under its own name; wrong value → fix the stored data.

### `resolveRowIds` — stale / alias ids (0.1.148)

`protected resolveRowIds(ids: readonly TDbRowIdInput[], ctx: TDbRowIdsContext)` (`TDbRowIdInput = string | number | boolean | Record`; `ctx.purpose`: `"action"` (`ctx.action`, `ctx.level`) | `"available"` | `"one"` | `"remove"`; `ctx.overlay`) → one id per input, same order. Called once per request on action ids, `GET /meta/actions/:id|?…`, `GET /one/:id|?…`, `DELETE /:id|?…`, AFTER `prepareRequest` + the request's own validation (bad request 400s before the hook), BEFORE any row read. Not overridden → zero cost.

| #   | Rule                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An id that already names a row, or that you can't resolve, comes back UNCHANGED (current holder wins over an alias). NEVER throw for an unknown alias — an oracle.                                                                                                    |
| 2   | Output validated; a bad one = 500 (server bug): wrong length; for `"action"` every entry an object that is a visible identification; else a scalar (path-scalar semantics, PK first) or a visible identification object (never a `hasField`-hidden unique key).       |
| 3   | Handlers (`@DbActionID(s)`, `useDbActionId(s)`, `@DbActionRow(s)`), `actionRowScope` `ctx.ids`, `target.batches()`, `onRemove`, `guardRemove` get the RESOLVED ids. `ActionDisabledError.ids` / `id` and `summary().skipped` / `failed` echo the ids the CLIENT sent. |
| 4   | `'rows'` duplicates after resolution collapse to the first. Query-target ids (read from rows) never go through it. Write bodies are NOT resolved — use `onWrite`.                                                                                                     |
| 5   | The resolved id is never trusted for access: still read under the overlay + visible identifications. Resolve INSIDE `ctx.overlay` if an alias can name several rows. Unreachable alias ≡ missing ≡ unknown alias on every endpoint.                                   |
| 6   | `@DbActionsFrom` view: the view resolves its own id, the SOURCE'S hook (`"available"`) resolves the source id. Value-help controllers don't have the hook.                                                                                                            |

## Optimistic concurrency over HTTP

Tables annotated with `@db.column.version` get auto-lifted CAS on PATCH and PUT. This section is the canonical wire contract; the SDK side (`$cas`, `withOptimisticRetry`, `touchMany`) and client-side 409 handling live in [versioning.md](versioning.md).

### `/meta` exposes `versionColumn`

Present only on versioned tables — see [§ Meta endpoint shape](#meta-endpoint-shape). Its value is the LOGICAL field name — the body / `$cas` / row key; a `@db.column` rename never changes it (0.1.141; ≤ 0.1.140 it was the stored column → renamed version fields got no HTTP OCC). Examples below say `version` = whatever it names. Clients round-trip the field only when it is set; UI generators render it read-only.

### Auto-lift on PATCH / PUT

- `version` present in the body → stripped from SET, lifted to `$cas: { version: N }`, dispatched to `updateOne` / `replaceOne`.
- `version` absent → write goes through with no `$cas` (last-write-wins; client opted out). It still bumps, except for [version-exempt](versioning.md) bodies (0.1.150).
- Raw `$cas: { version: N }` accepted as sent (since 0.1.128; same 404/409 disambiguation). `version` + DIFFERENT `$cas` → 400 at `$cas` / `[i].$cas`.
- PK-only `PATCH { id, version }` = versioned touch: executes, bumps (409/404 on stale/missing). `PATCH { id }` → `{ 1|0, 0 }`, no write.

Presence-based policy. No 428 "Precondition Required" gate.

### 409 Conflict body shape

When CAS misses on a row that exists, the controller does a disambiguation `findOne(id)` and returns:

```jsonc
{
  "statusCode": 409,
  "error": "Conflict", // overridden by Wooks framework — DO NOT discriminate on this
  "message": "version_mismatch",
  "kind": "version_mismatch", // ← discriminator
  "currentVersion": 6, // ← row's current version
}
```

Discriminate on `kind === "version_mismatch"` plus `currentVersion`. The Wooks framework owns the `error` field and overrides whatever the controller sets — that's why the discriminator lives on `kind`. Client side (`VersionMismatchError`, raw `fetch`): [versioning.md § Handling 409](versioning.md#handling-409).

### 404 disambiguation

CAS-bearing PATCH / PUT on a row that doesn't exist returns `404 Not Found`, NOT `409`. The post-mismatch `findOne` is what tells the two states apart — it resolves the row PK-first like the write (0.1.143), so `currentVersion` is never read from a unique-value namesake. The extra read fires only on the conflict path, never on the happy path.

### Bulk PATCH / PUT

Array bodies carry one optional `version` per item. Mismatches are silently skipped. Detect partial application via `matchedCount < N` — `modifiedCount` can be lower for unchanged values (version-exempt writes on MySQL / Mongo). The response is the aggregate shape:

```
PATCH /users/
Body: [
  { "id": "u1", "name": "a", "version": 5 },  // applies
  { "id": "u2", "name": "b", "version": 9 },  // stale → skipped
  { "id": "u3", "name": "c" }                 // no $cas → applies
]
Response: 200 OK { "matchedCount": 2, "modifiedCount": 2 }
```

Detect partial failure with `matchedCount < items.length`. **Per-item conflict status (e.g. 207 Multi-Status with per-row `version_mismatch` entries) is deferred** — see [versioning.md § Limitations](versioning.md#limitations).

### Status-code summary

| Code  | When                                                             | Body                                            |
| ----- | ---------------------------------------------------------------- | ----------------------------------------------- |
| `200` | PATCH/PUT success (CAS hit or no CAS)                            | usual write response                            |
| `400` | `version` and `$cas` present with different values               | `errors[0].path === "$cas"`                     |
| `404` | CAS-bearing single-row PATCH/PUT on a missing row                | usual 404                                       |
| `409` | CAS-bearing single-row PATCH/PUT on a row whose version moved on | `kind: "version_mismatch"`, `currentVersion: N` |

## Gate mode (capability index, since 0.1.128)

`/meta.fields` and the request gate are two projections of ONE per-controller `FieldCapabilityIndex` — parity is structural: `fields[P].sortable === ($sort=P accepted)`, `fields[P].filterable === (value-comparison filter on P accepted)`, `(fields[P].filterOps ?? []).includes(op)` ⇔ a narrower `op` entry accepted when `filterable` is false, on every adapter, mode and field kind. Every root path a request uses (filter tree, `$sort`, `$select`, `$groupBy`, `$having` keys minus aggregate aliases, aggregate `$field`) is checked — `hasField` visibility first (since 0.1.133), then capability — BEFORE `transformFilter` / `transformProjection`; rejections are the structured envelope `{ message, statusCode: 400, errors: [{ path, message }] }`. `checkGates(parsed)` still runs after the gate but is deprecated since 0.1.128 — override the read hooks or table guards instead.

- `fields[<path>]` = `{ filterable, filterOps?, sortable, indexed?, bucketable?, groupable?, numeric?, encrypted?, geo?, writeOnly? }` (`numeric` since 0.1.148: `true` on a numeric field that may be an operand of aggregate arithmetic — plain `number`, ¬decimal ¬timestamp, aggregatable, ¬writeOnly — when top-level `aggregateExpressions` is `true`; request-time `hasField` still gates each operand):
  - `filterable` — value comparisons: adapter `canFilterField(fd)` ∧ ¬`@db.writeOnly` ∧ ¬`@db.encrypted`; in `@db.table.filterable 'manual'` additionally only `@db.column.filterable` fields.
  - `filterOps` (since 0.1.132) — only when `filterable` is false yet narrower operators pass the same conjunction with the predicate's own physical rule: SQL JSON / array column → `["$exists"]`, SQL `geoPoint` → `["$exists"]` + `"$geoWithin"` only when the adapter is geo-searchable. writeOnly / encrypted / missing manual annotation block every predicate (no `filterOps`; `$exists` would leak whether a sealed value is set). A filter UI must offer only these ops. Each filter entry is judged by its own predicate class (core `canFilterLeaf` / `narrowerFilterOps`) per occurrence — see [queries.md § `$exists`](queries.md).
  - `sortable` — adapter `canSortField(fd)` ∧ ¬writeOnly ∧ ¬encrypted; in `@db.table.sortable 'manual'` additionally only `@db.column.sortable` fields. Auto mode advertises EVERY adapter-sortable field (before 0.1.128 only index-backed ones).
  - `indexed` — present when index-backed (explicit `@db.index*`, PK, unique). Advisory; never affects acceptance.
  - `groupable` (since 0.1.148) — present (`true`) exactly when `$groupBy` on `P` passes the gate: physically filterable (adapter ∧ ¬`@db.writeOnly` ∧ ¬`@db.encrypted`) ∧, on a table with `@db.column.dimension` / `.measure`, a dimension (else 400 `Grouping by field "P" is not permitted — not a dimension.`). Physical: independent of `@db.table.filterable 'manual'`. Distinct-values pickers (`$groupBy=f&$select=f`) need `filterable ∧ groupable`; a permission overlay (`$groupBy` control policy) may strip it.
  - `bucketable` (since 0.1.132) — present (`true`) exactly when a calendar bucket over `P` passes the gate: ¬`@db.writeOnly` ∧ core `bucketSourceVerdict` (the same rule the core runs — list in [calendar-buckets.md](calendar-buckets.md) #6). Top-level `bucketUnits` (omitted when none). Rejection: `Bucketing field "P" is not permitted — <reason>.` → [calendar-buckets.md](calendar-buckets.md).
- **The index is rebuilt when adapter capabilities change (since 0.1.132)** — keyed on `isGeoSearchable()` + `calendarBucketUnits()`, so `/meta` and the gate follow a post-construction schema sync (PostgreSQL learns PostGIS there). ≤ 0.1.131 it was a constructor snapshot: a controller built before `syncSchema()` advertised/enforced stale geo capability until restart. Subclasses overriding `/meta` caching: `metaCacheKey()` (default constant) decides when the cached envelope is rebuilt.
- **Manual-mode policy applies to filters and `$sort` only.** `$groupBy`, `$having` field keys and aggregate `$field` use the physical capability (adapter ∧ ¬writeOnly ∧ ¬encrypted) — `@db.column.filterable` is not required to group by a column. `$having` keys must additionally be aggregate aliases or `$groupBy` fields (core `checkHavingKeys`, answered by the gate with the same wording): a real but non-grouped column is a 400 `$having key "<key>" must be an aggregate alias or a $groupBy field` (since 0.1.128).
- **Adapter capability is a hard gate over the annotation policy.** `BaseDbAdapter.canFilterField(fd)` defaults to `fd.storage !== 'json'` (vetoes value comparison only — a sole `$exists` entry bypasses it, `$geoWithin` is checked by the geo guard); `canSortField(fd)` vetoes `storage === 'json'` AND `designType 'json' | 'array'` (so Mongo/memory, which keep arrays inline as `column`, report `sortable: false` and 400 `$sort=tags` since 0.1.128). Mongo/memory override `canFilterField` to `!fd.encrypted`.
- **Never listed, always rejected for filter/sort/groupBy:** nested-object parents (`contact` — 400 names its leaves), navigation properties and their descendants as plain paths (`assignee`, `assignee.name` — 400 says `use assignee=$some(…) … (requires @db.rel.filterable), or $with=assignee(...)` since 0.1.147; filter by them with a predicate → § Relational predicates over HTTP; since 0.1.128 Mongo/memory no longer list nav descendants), JSON descendants on SQL adapters (`prefs.theme` — 400 says select the parent; Mongo/memory list and accept them), `@db.ignore`d fields, unknown fields (`Unknown field "x"`).
- `$select`: listed fields, flattened parents (expand), JSON parents (whole value) and `@db.writeOnly` fields (stripped by the seal after the gate) pass; JSON descendants on SQL, encrypted descendants, root nav paths and unknown fields → 400. Applies to `/query`, `/pages`, `/geo`, `/one/:id` and `/one?…` (the composite endpoint was unvalidated before 0.1.128).
- Messages (locked): `Filtering on field "x" is not permitted — add @db.column.filterable to enable.` / `… — adapter cannot filter on this storage type.` (with ` (accepted operators: $exists).` before the period when `filterOps` exists) / `… — field is @db.writeOnly.`; `Sorting on field "x" is not permitted — …`; `"contact" is a nested object — filter or sort on one of its leaves (contact.email, …)`; `"assignee.name" is a navigation path — use $with=assignee(...) …`; `"prefs.theme" is inside JSON-stored column "prefs" — this adapter cannot filter JSON paths; select "prefs" and read the value client-side.`; `Unsupported filter operator "$nor" — use $and, $or or $not` (one wording with the core `guardPaths`, from `unsupportedOperatorMessage`); `$having key "region" must be an aggregate alias or a $groupBy field`.
- The core layer (`@atscript/db`) runs the same existence + physical checks in `guardPaths` for every read, aggregate, `updateMany` / `deleteMany` (`DbError("INVALID_QUERY")`), so programmatic callers and `transformFilter` overlays hit the same wall — physical column names (`contact__email`) are no longer accepted anywhere.

## Relational predicates over HTTP (0.1.147)

Client `ticket=$some(…)` / `$none(…)` (URL grammar → [http-query-syntax.md](http-query-syntax.md#relational-predicates--some--none-01147)) filters PARENT rows. Invariant: a predicate on relation `n` reveals nothing `$with=n(<same filter>)` would not reveal under the same policy — plus explicit opt-in.

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Gate order (all 400, every one the validation envelope `errors: [{ path, message }]`): `hasField(nav)` else `Unknown field "ticket"` → nav field else `"$some" / "$none" are only valid on a navigation relation — "x" is not one` → `@db.rel.filterable` else `Filtering by related "ticket" rows is not permitted — add @db.rel.filterable to enable.` → related table resolvable else `Filtering by related "ticket" rows is not possible — the related table is not available.`                                                                          |
| 2   | Operand fields: `hasField("ticket.<path>")` + the RELATED table's `FieldCapabilityIndex` (writeOnly, encrypted, SQL JSON, `'manual'` mode → `… add @db.column.filterable to enable.`, derived-over-hidden-source → `Unknown field`), paths prefixed (`ticket.code`). Nested predicates recurse at `ticket.team`; a chain may cross the same relation again (`parent=$some(parent=$some(…))`).                                                                                                                                                                |
| 3   | Dotted key as predicate (`ticket.team=$some(…)`) → `"ticket.team" is a navigation path — nest the predicates, one relation per level: ticket=$some(team=$some(…))`.                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | Caps (CLIENT predicates only; `REL_FILTER_CLIENT_MAX_DEPTH` / `_NODES` from `@atscript/moost-db`): depth 3 per predicate chain (`$with` hops don't count), 8 predicates per WHOLE request incl. `$with` sub-filters. Core caps (4 / 16, server predicates included, path-less errors) leave headroom for overlays. `$having` with a predicate → 400. `REL_FILTER_NOT_SUPPORTED` → 400.                                                                                                                                                                       |
| 5   | `$with` sub-filters may hold predicates, same rules recursively; paths from the controller's table (`$with=tickets(issues=$some(…))` → `tickets.issues`).                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | Never an identification: `/one?…`, `DELETE /?…` → 400 `Query params do not match any primary key or unique index`; action ids → id-shape 400.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | `protected transformRelationFilter(path, filter): FilterExpr \| Promise<FilterExpr>` (default identity) = related-table row overlay for CLIENT predicates only — `/query` (incl. `$count`, `$groupBy`), `/pages`, `/geo`, `/one` (`$with`), query-target `q` (read context). After the gate, BEFORE `transformFilter`. POST-ORDER (nested operand rewritten first; parent gets the rewritten operand); output not re-walked. Under an overlay `$none` = "no VISIBLE related row matches". Zero cost unless overridden.                                       |
| 8   | Server-side filters (`transformFilter`, `transformOne`, `actionRowScope`) use predicates on ANY relation — not gated, no opt-in, no overlay. Same for row scopes a `validateControls` override conjoins into `$with` entries: the gate judges the client `$with` tree recorded BEFORE `validateControls`; the overlay rewrites only client predicates (identity). Wrap the client filter object (`entry.filter = { $and: [scope, entry.filter] }`) — never copy/drop it: with `transformRelationFilter` overridden a missing client `$with` predicate → 500. |
| 9   | ARBAC (`@aooth/arbac-moost`): a client predicate on R is allowed exactly when the request's `$with` relation policy allows R; R's row scope is conjoined via `transformRelationFilter`. Custom permission layers: read `ctx.filter` in `prepareRequest` (a deep-frozen copy made on first access — read-only); `ctx.hasRelationFilters` (boolean, read endpoints) says whether it holds any predicate — check it first to skip the copy.                                                                                                                     |

```ts
protected transformRelationFilter(path: string, filter: FilterExpr) {
  return path === "ticket" ? { $and: [{ teamId: { $in: currentTeams() } }, filter] } : filter;
}
```

Fix (0.1.147): the write-only `$select` seal no longer lists related tables' `@db.writeOnly` paths (made `$count` fail with `Cannot select "ticket.code" — navigation path`).

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

| Source                                                                                                                                                                                                       | HTTP                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ValidatorError`                                                                                                                                                                                             | 400                                                                                                               |
| `DbError` code `CONFLICT` (unique violation; nested write outside the record's relation — 0.1.143, [relations.md](relations.md#nested-write-integrity-01143))                                                | 409                                                                                                               |
| `DbError` code `TX_WAIT_TIMEOUT` (SQLite gate waiter timed out — `transactionWaitTimeoutMs`)                                                                                                                 | 503                                                                                                               |
| `DbError` code `DEADLOCK` / `LOCK_TIMEOUT` / `SERIALIZATION_FAILURE` (concurrency contention, `retryable: true` — since 0.1.153)                                                                             | 503                                                                                                               |
| `DbError` code `BUCKET_TZ_UNAVAILABLE` (engine can't resolve a calendar bucket's zone — MySQL tz tables, stale tzdata; since 0.1.132)                                                                        | 501                                                                                                               |
| `DbError` code `CAS_MISMATCH` (`table.touchMany` stale/missing key — only via a custom route, since 0.1.129)                                                                                                 | 409                                                                                                               |
| Write body not an object / array of objects (shape gate, since 0.1.128)                                                                                                                                      | 400 with `errors[{ path: "" \| "[i]", message: "Expected an object" }]`                                           |
| `DbError` any other code (`FK_VIOLATION`, `NOT_FOUND`, `CASCADE_CYCLE`, `INVALID_QUERY`, `DEPTH_EXCEEDED`, `VERSION_COLUMN_WRITE`, `BUCKET_NOT_SUPPORTED`, `AGG_FN_NOT_SUPPORTED`, `AGG_EXPR_NOT_SUPPORTED`) | 400                                                                                                               |
| CAS version mismatch on PATCH/PUT (`@db.column.version` table)                                                                                                                                               | 409 with `kind: "version_mismatch"` — see [§ Optimistic concurrency over HTTP](#optimistic-concurrency-over-http) |
| `ActionDisabledError` (server-side action gate rejection — see [actions.md](actions.md))                                                                                                                     | 409                                                                                                               |

## Value-help controllers

`AsReadableController`, `AsValueHelpController`, and `AsJsonValueHelpController` back non-DB `@db.rel.FK` sources (enums, static lists, JSON documents) so forms can resolve picker URLs from `@db.http.path` regardless of whether the target is a table.

- Field-side binding: `@db.rel.FK` (constraint) OR `@ui.valueHelp Target, 'field', <static filter>` (atscript-ui, 0.1.148 — no FK, no DDL; `/meta` carries `{ target: { id, metadata: { "db.http.path" } }, field, filter }`; the app publishes the path for the dictionary's controller (`canonical` if mounted more than once), the dictionary `.as` need not declare it). `@ui.valueHelp.distinct` on a column = distinct stored values via `$groupBy=f&$select=f`, offered only when `fields[f].filterable ∧ groupable`.
- `AsValueHelpController` — **abstract**. `query()` and `getOne()` are abstract; subclass must implement them (`as-value-help.controller.ts:105,111`).
- `AsJsonValueHelpController` — **the only concrete subclass shipped**. `new AsJsonValueHelpController(Type, rows, app)` — holds a static in-memory row set and serves `/query` `/pages` `/one` `/meta` over it. Filter/sort/projection delegate to the shared `@atscript/db-memory` engine (see § query engine below).

```ts
import { AsValueHelpController, ReadableController } from "@atscript/moost-db";

@ReadableController(RolesDictionary) // an interface with @db.rel.FK target fields
export class RolesController extends AsValueHelpController<typeof RolesDictionary> {
  protected async query(controls) {
    /* impl */
  }
  protected async getOne(id) {
    /* impl */
  }
}
```

- `@DbAction` / `@DbActions*` on a value-help controller THROWS (0.1.143 — at decoration, or at construction when inherited from a non-value-help base). ≤ 0.1.142 it was silently ignored while the `@Post` route ran ungated.
- Scoping hooks (0.1.143, may be async), applied by the base routes to every value-help source — no per-subclass code for a permission layer:

| Hook                          | Default             | Applied to                                                                                                                                                                   |
| ----------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transformFilter(filter)`     | identity            | `/query`, `/pages` filter. `/one` checks the found row against `transformFilter({})` in memory — outside = 404 like missing.                                                 |
| `transformProjection(select)` | identity            | Request `$select` (`undefined` when absent; `/one` always `undefined`) → inclusion list / `{ p: 1 }` / exclusion `{ p: 0 }` (`ValueHelpSelect`).                             |
| `hasField(path)`              | every declared prop | Hidden → `Unknown field "x"` 400 in filter / `$sort` / `$select`; never matches `$search`. Gates the REQUEST only — strip the column with a `transformProjection` exclusion. |

- `prepareRequest` runs first on `/query`, `/pages`, `/one`. A custom `AsValueHelpController.query(controls)` receives the already-hooked filter + `$select` and MUST apply both; `getOne(id)` returns the raw row — the base applies overlay + projection.

### `AsJsonValueHelpController` query engine

Filter, sort, and projection run on the shared `@atscript/db-memory` engine (`buildMemoryPredicate` + `sortRows` + `projectRow`) — the same JS-native engine the MemoryAdapter uses. Engine semantics (null model, regex, dot-paths, operator set) are owned there: [adapters-memory.md](adapters-memory.md). Pipeline order: **filter → `$search` → sort → paginate → project**.

Gained for every static value-help surface (via the shared engine):

- dot-path field access (`a.b.c`) in filters, sort, and `$select`.
- `$exists` — "holds a value" (`null` ≡ absent since 0.1.132; see [queries.md § `$exists`](queries.md)).
- Mongo-like null model — `$eq:null` matches null AND missing; `$ne:null` matches only concrete present values.
- nested-path projection via `$select`.

Preserved (controller-owned, not the engine):

- `$search` — case-insensitive substring across `@ui.dict.searchable` fields `hasField` keeps visible (the engine has no `$search`; the controller applies it).
- flexible `$sort` grammar — `"field:asc,-other"`, arrays, `{ field: 'asc' | 'desc' }`.
- pagination (`/pages`).
- `@ui.dict.*` remain UI hints only; the controller stays **action-less** (`actions: []` — see [actions.md](actions.md)).

Behavior-change gotchas (were silent before the shared-engine move):

- **Unsupported filter operator → HTTP 400** (`DbError('INVALID_QUERY')`), previously a silent mis-match returning no rows.
- **`$regex` honors `/pat/flags`** — `$regex:'/foo/i'` is a real case-insensitive match (flags were ignored before).

## Meta endpoint shape

```ts
type TCrudOp = "query" | "pages" | "one" | "geo" | "insert" | "update" | "replace" | "remove";
type TCrudPermissions = Partial<Record<TCrudOp, string[]>>;

interface TMetaResponse {
  searchable: boolean;
  vectorSearchable: boolean;
  geoSearchable?: boolean; // adapter supports geo AND the table has a geo index (then `crud.geo` is set). See geo-search.md.
  searchIndexes: { name; description?; type? }[];
  primaryKeys: string[];
  preferredId: string[]; // logical field names, always populated; defaults to primaryKeys
  versionColumn?: string; // LOGICAL field name of the `@db.column.version` field (a `@db.column` rename does not change it); omitted when none → round-trip it only when set. See § Optimistic concurrency over HTTP.
  bucketUnits?: BucketUnit[]; // calendar-bucket units; omitted when none (since 0.1.132). See calendar-buckets.md.
  aggregateFns?: AggregateFn[]; // the adapter's aggregateFns(), canonical order; always sent by moost-db. See aggregation.md.
  relations: { name; direction: "to" | "from" | "via"; isArray; filterable?: true }[]; // filterable (0.1.147) = @db.rel.filterable; not visibility-aware
  fields: Record<
    string,
    {
      sortable;
      filterable;
      filterOps?;
      indexed?;
      bucketable?;
      groupable?;
      encrypted?;
      geo?;
      writeOnly?;
      derived?;
      computed?; // @db.compute view column (0.1.147) — advisory; hidden with any hidden operand or intermediate computed field
    }
  >; // exact — see Gate mode; `derived: true` (0.1.141) = `@db.column.derived`, read-only (a written value is dropped)
  type: TSerializedAnnotatedType; // always refDepth: 0.5 (FK refs shallow; chained refs resolve to the terminal field — see relations.md); annotations kept: meta.*, expect.*, db.rel.*, db.json, db.patch.strategy, db.default*, db.http.path, db.writeOnly, db.column.version, db.column.derived (0.1.142) — other db.* stripped (override getSerializeOptions())
  actions: TDbActionInfo[]; // declared actions; `[]` when none. See actions.md.
  crud: TCrudPermissions; // built-in CRUD surface; key absent = denied
}
```

`crud` declares which built-in CRUD operations the controller exposes and the
accepted UniQuery control whitelist per read op (`[]` for write ops). Per-base-class emission:

- `AsDbReadableController` → `{ query, pages, one }` (+ `geo` when `geoSearchable`)
- `AsDbController` → inherits + `{ insert: [], update: [], replace: [], remove: [] }`
- `AsValueHelpController` / `AsJsonValueHelpController` → `{ query, pages, one }`

Whitelists are exported as constants from `@atscript/moost-db`: `QUERY_CONTROLS`, `PAGES_CONTROLS`, `ONE_CONTROLS`. The handler METHODS per op (0.1.143, frozen): `DB_CRUD_HANDLERS` (`query`→`query`, `pages`→`pages`, `one`→`getOne`+`getOneComposite`, `geo`→`geo`, `insert`/`update`/`replace`→same name, `remove`→`remove`+`removeComposite`) and `VALUE_HELP_CRUD_HANDLERS` (`query`→`runQuery`, `pages`→`runPages`, `one`→`runGetOne`+`runGetOneComposite`) — authorize a `crud` entry through them (allowed when ANY handler is). `crud.geo` (no exported constant) = `filter, insights` + the strict `GeoControlsDto` keys (0.1.143): `center, maxDistance, minDistance, index, select, skip, limit, page, size, with, actions`.

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
before pruning; mutating the cached envelope leaks per-request state. Return `meta` unchanged when nothing is pruned (keeps the `/meta` ETag — see § `/meta` HTTP caching).

### `/meta` HTTP caching (0.1.151)

`GET /meta` + `GET /meta/form/:name` send `Cache-Control: private, no-cache`, `Vary: Authorization, Cookie` (merged) and a weak `ETag` = hash of the final bytes; matching `If-None-Match` → `304`, empty body. Docs: `docs/http/crud.md#meta-caching`.

| #   | Rule                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | ETag is computed after every overlay / `hasField` index pruning / delegated actions → another role (or re-login) with a carried tag gets `200` + a new tag. `304` only when the bytes are identical. Never derive a cache key from the URL alone (SW / client caches).                                                                                 |
| 2   | `prepareRequest` throwing → its error status, never `304`. An after-interceptor `reply(x)` with a new body → no ETag for that response.                                                                                                                                                                                                                |
| 3   | ETag + serialize-once only when the served object is reused across requests: `applyMetaOverlay` must return `meta` itself, or memoized variants passed through `stableMeta(obj)` (deep-freeze + mark; `Object.freeze` alone does NOT count) — a fresh object per request is correct but uncached (no ETag). An overridden `meta()` never gets an ETag. |
| 4   | Never mutate a served `/meta` object (or the envelope) in place — stale bytes would be served. `NODE_ENV=test`/`development` or `ATSCRIPT_DB_FREEZE_META=1` deep-freeze served objects → mutation throws `TypeError` (500).                                                                                                                            |
| 5   | Override `protected metaHttpCaching(): TDbMetaHttpCaching \| false` — `false` = no headers/ETag/304; `{ cacheControl: "no-store" }` for no browser copy; `{ vary: [..., "X-Tenant"] }` when another header identifies the caller. An existing `Cache-Control` header is kept.                                                                          |
| 6   | Needs `moost` / `@moostjs/event-http` >= 0.6.48 (`prerenderJson` re-export).                                                                                                                                                                                                                                                                           |

### Pitfalls

- Overlay filtering is informational only — hiding a `crud` key or `actions[]` entry does NOT block the underlying route. Per-principal enforcement is a separate concern.
- `client.meta()` caches per `Client` instance — instantiate per request for per-principal overlays in SSR.
- `actions[].disabled` is the stringified predicate (`fn.toString()`) — UI mirror only. Server enforcement on POST is the gate interceptor; per-row availability on read endpoints is `$actions=true` (see [actions.md § `$actions=true`](actions.md#actionstrue--server-evaluated-row-availability)). `requiredFields` is server-internal and never on the wire.

Consumed by `@atscript/db-client` to build a client-side validator matching the server's.

Wire CORS / auth / rate-limiting as Moost interceptors (`@Intercept`) — routes from `AsDbController`/`AsDbReadableController` participate normally.
