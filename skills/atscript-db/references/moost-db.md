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
const missing = assertExposed(app, atscriptModels); // default: only @db.http.path models
// Prefix-bound repos (no @db.http.path anywhere): audit EVERY passed model
assertExposed(app, atscriptModels, { all: true, exclude: [InternalCache] });
```

Detects token + instance bindings; lazy-factory bindings can't name their model — with `all: true` they false-positive, so list them in `exclude`.

## Writable table access in readable controllers

`AsDbReadableController` (and subclasses) expose `this.table` — the bound readable as a writable `AtscriptDbTable`. Action handlers write through it; NEVER keep a module-scope `db.getTable(Model)` just to regain write access. Throws for view-bound controllers.

## $search fallback + write-only fields

- `@db.column.searchable` fields: `$search` works without native search (escaped case-insensitive substring, `$or` across annotated fields; native search wins when configured; `/meta` reports `searchable: true`). "Native search" means TEXT search: a vector-only table (`@db.search.vector` and no `@db.index.fulltext`) reports `searchable: false`, so the fallback applies there and `/meta` still reports `vectorSearchable: true` (since 0.1.131).
- `@db.writeOnly` fields: settable via insert/update/replace, sealed out of ALL reads (projections force-exclude them; filter/sort/`$groupBy` on them → 400; `/meta` serves the type with `fields[path].writeOnly: true`). Server-side `table.findOne` still sees the value — the seal is HTTP-layer. Related-model writeOnly fields are NOT sealed through `$with` nav loads — seal at that model's own controller/overlay.

## Testing fixture

```ts
import { provideTestDbSpace, resetTestDbSpaces } from "@atscript/moost-db/testing";
beforeAll(() => provideTestDbSpace([User, Post])); // in-memory space, registered for token binding
afterAll(() => resetTestDbSpaces());
```

No DB connection or import-order dance — see [testing.md](testing.md).

## Generated routes

| Method | Path               | Purpose                                                                                                                                                               | Class                    |
| ------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| GET    | `/query`           | Query rows (or `$count`, or `$groupBy` aggregate).                                                                                                                    | `AsDbReadableController` |
| GET    | `/pages`           | Paginated query. Returns `{ data, page, itemsPerPage, pages, count }`.                                                                                                | `AsDbReadableController` |
| GET    | `/one/:id`         | Single row by scalar PK.                                                                                                                                              | `AsDbReadableController` |
| GET    | `/one?a=1&b=2`     | Single row by composite PK / compound unique.                                                                                                                         | `AsDbReadableController` |
| GET    | `/geo`             | Distance-ranked geo search (`$center=lng,lat` required; `$maxDistance`/`$minDistance` meters; rows carry `$distance`). All adapters → [geo-search.md](geo-search.md). | `AsDbReadableController` |
| GET    | `/meta`            | Serialized type + relations + field capability map.                                                                                                                   | `AsDbReadableController` |
| GET    | `/meta/form/:name` | Serialized `TSerializedAnnotatedType` of an action's `@InputForm` form (404 unknown name).                                                                            | `AsDbReadableController` |
| POST   | `/`                | Insert one or many (array body → `insertMany`).                                                                                                                       | `AsDbController`         |
| PUT    | `/`                | Replace one or many by PK.                                                                                                                                            | `AsDbController`         |
| PATCH  | `/`                | Update one or many by PK.                                                                                                                                             | `AsDbController`         |
| DELETE | `/:id`             | Delete by scalar PK.                                                                                                                                                  | `AsDbController`         |
| DELETE | `/?a=1&b=2`        | Delete by composite PK / compound unique.                                                                                                                             | `AsDbController`         |

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

### `$actions=true` augmentation

Opt-in URL/control flag (`?$actions=true`, or `controls: { $actions: true }`). When set, every returned row gets `$actions: string[]` listing `'row'`/`'rows'`-level action names that are NOT disabled for that row. The pipeline:

1. Discover row/rows-level envelopes for the controller (memoized).
2. Filter through per-request `applyMetaOverlay()` (`meta()` skipped when overlay is identity).
3. Pre-widen `$select` to union all `requiredFields` when caller restricted projection.
4. Run the read.
5. Run each `disabled` predicate once on the full result (length-mismatch → HTTP 500).
6. Strip widened-only fields the caller didn't ask for.

Not augmented: `$count`, `$groupBy`. See [actions.md § `$actions=true`](actions.md#actionstrue--server-evaluated-row-availability).

## Hooks (override on subclass)

```ts
@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {
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
  protected computeEmbedding(text: string) {
    return myEmbed.embed(text);
  } // enables $vector
}
```

- `transformFilter` / `transformOne` / `transformProjection` may be async (session / ACL lookups).
- `hasField(path)` = THE per-request field-visibility hook: `false` → the same 400 as a nonexistent field (`Unknown field "x"`; `$with` → `Unknown relation "x"`, hidden relations not listed). Since 0.1.133 EVERY gated path consults it first — filter keys (any `$and`/`$or`/`$not` depth, `$exists`), `$sort`, `$select`, `$groupBy`, `$having`, aggregate/bucket `$field`, `$with` roots + sub-paths, `$search` fallback fields. 0.1.128–0.1.132: stored leaves skipped it → filter/sort on a hidden column was a value oracle. It only rejects references: pair with `transformProjection` (strip values) + `applyMetaOverlay` (`/meta` is cached, never consults it). Native `$search` / `$vector` indexes are out of its reach — don't index hidden fields.
- `transformOne(filter)` — gates `/one/:id` and `/one?…` reads. Defaults to `transformFilter`, so any row-level read overlay also applies to id-based reads (existence not leaked via `findById`). Override to scope `/one` differently.
- The framework unions `preferredId` into the projection AFTER `transformProjection()` resolves — overrides cannot suppress preferred-id fields (see § Read-response baseline). Quantity-ref projection (`@db.amount.currency.ref` / `@db.unit.ref`) also auto-widens `$select` so currency/unit ref fields are present.
- `onWrite` / `onRemove` returning `undefined` aborts with HTTP 500; returning an `Error` instance throws it (since 0.1.128 — was passed on as data).
- Write pipeline (since 0.1.128): shape gate 400 (`errors[{ path: "" | "[i]", message: "Expected an object" }]`, body must be an object / array of objects, hooks not called) → `onWrite` (outside tx; must return the shape it received — object / array of objects — else 500 "Not saved") → table op (the TABLE's own tx: validate → guard, only when `guardWrite` / `guardRemove` is overridden → re-validate → write) → 404/409 disambiguation AFTER the table call. Unmodified controllers: the table is called exactly as before, no guard, no double validation. There is no `transactionalWrites` flag — overriding a guard is the switch.
- `guardWrite(ctx)` = the table's `TWriteOptions.guard` (see `crud.md`): `ctx.action`, `ctx.rows` (validated; `undefined` props pruned; defaults applied on insert/replace; `$cas` stripped on update — mutate in place, re-validated), `ctx.expectedVersions[i]`, `ctx.current(i)` (lazy memoised pre-image inside the tx; `null` when missing or no key yet, never throws). `guardRemove(ctx)` = `deleteOne`'s `TDeleteOptions.guard`: `ctx.id`, `ctx.filter`, `ctx.current()` — a missing row still reaches the guard (`current()` → `null`; the 404 comes AFTER the guard); only an id that resolves to no filter (malformed for the key type) is 404 BEFORE the guard. Reject by THROWING (`HttpError`) — the table rolls back, the error propagates unchanged.
- Guard rules: never swallow `DbError` (PG aborted tx); never await external I/O on SQLite (holds the only connection → deadlock, 503 only with `transactionWaitTimeoutMs`); Mongo replica set may RE-RUN the guard (idempotent); standalone Mongo / memory adapter: no rollback. A guard writing the same row bumps its version twice.
- `this.withTransaction(fn)` — one tx across table ops in custom routes/actions (`this.table.getAdapter().withTransaction`).
- `version` + differing `$cas` → 400 at `$cas` (`Ambiguous version: "version" and "$cas.version" differ`, `[i].$cas` in bulk); a malformed `$cas` beside `version` reports `separateCas`'s own message (shared `reconcileCas` from `@atscript/db`).
- Built-in write failures are THROWN `HttpError`s (wire-identical; a throw also rolls back a wrapper `withTransaction` around `super.update()`; on a throw the router may fall through to a later matching route).
- `computeEmbedding` enables `$vector` on `/query` — without it, `$vector` → HTTP 501.

## Optimistic concurrency over HTTP

Tables annotated with `@db.column.version` get auto-lifted CAS on PATCH and PUT. The full SDK side lives in [versioning.md](versioning.md); this section covers the wire contract.

### `/meta` exposes `versionColumn`

```jsonc
// Versioned table
{ "primaryKeys": ["id"], "versionColumn": "version", "fields": { … }, … }

// Non-versioned table — key omitted
{ "primaryKeys": ["id"], "fields": { … }, … }
```

Clients use this pointer to decide whether to round-trip `version`. UI generators may render the version field as read-only.

### Auto-lift on PATCH / PUT

- `version` present in the body → stripped from SET, lifted to `$cas: { version: N }`, dispatched to `updateOne` / `replaceOne`.
- `version` absent → write goes through with no `$cas` (last-write-wins; client opted out).
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

Discriminate on `kind === "version_mismatch"` plus `currentVersion`. The Wooks framework owns the `error` field and overrides whatever the controller sets — that's why the discriminator lives on `kind`.

### 404 disambiguation

CAS-bearing PATCH / PUT on a row that doesn't exist returns `404 Not Found`, NOT `409`. The post-mismatch `findOne` is what tells the two states apart. The extra read fires only on the conflict path, never on the happy path.

### Bulk PATCH / PUT

Array bodies carry one optional `version` per item. Mismatches are silently skipped. The response is the aggregate shape:

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

- `fields[<path>]` = `{ filterable, filterOps?, sortable, indexed?, bucketable?, encrypted?, geo?, writeOnly? }`:
  - `filterable` — value comparisons: adapter `canFilterField(fd)` ∧ ¬`@db.writeOnly` ∧ ¬`@db.encrypted`; in `@db.table.filterable 'manual'` additionally only `@db.column.filterable` fields.
  - `filterOps` (since 0.1.132) — only when `filterable` is false yet narrower operators pass the same conjunction with the predicate's own physical rule: SQL JSON / array column → `["$exists"]`, SQL `geoPoint` → `["$exists"]` + `"$geoWithin"` only when the adapter is geo-searchable. writeOnly / encrypted / missing manual annotation block every predicate (no `filterOps`; `$exists` would leak whether a sealed value is set). A filter UI must offer only these ops. Each filter entry is judged by its own predicate class (core `canFilterLeaf` / `narrowerFilterOps`) per occurrence — see [queries.md § `$exists`](queries.md).
  - `sortable` — adapter `canSortField(fd)` ∧ ¬writeOnly ∧ ¬encrypted; in `@db.table.sortable 'manual'` additionally only `@db.column.sortable` fields. Auto mode advertises EVERY adapter-sortable field (before 0.1.128 only index-backed ones).
  - `indexed` — present when index-backed (explicit `@db.index*`, PK, unique). Advisory; never affects acceptance.
  - `bucketable` (since 0.1.132) — present (`true`) exactly when a calendar bucket over `P` passes the gate: ¬`@db.writeOnly` ∧ core `bucketSourceVerdict` (the same rule the core runs — list in [calendar-buckets.md](calendar-buckets.md) #6). Top-level `bucketUnits` (omitted when none). Rejection: `Bucketing field "P" is not permitted — <reason>.` → [calendar-buckets.md](calendar-buckets.md).
- **The index is rebuilt when adapter capabilities change (since 0.1.132)** — keyed on `isGeoSearchable()` + `calendarBucketUnits()`, so `/meta` and the gate follow a post-construction schema sync (PostgreSQL learns PostGIS there). ≤ 0.1.131 it was a constructor snapshot: a controller built before `syncSchema()` advertised/enforced stale geo capability until restart. Subclasses overriding `/meta` caching: `metaCacheKey()` (default constant) decides when the cached envelope is rebuilt.
- **Manual-mode policy applies to filters and `$sort` only.** `$groupBy`, `$having` field keys and aggregate `$field` use the physical capability (adapter ∧ ¬writeOnly ∧ ¬encrypted) — `@db.column.filterable` is not required to group by a column. `$having` keys must additionally be aggregate aliases or `$groupBy` fields (core `checkHavingKeys`, answered by the gate with the same wording): a real but non-grouped column is a 400 `$having key "<key>" must be an aggregate alias or a $groupBy field` (since 0.1.128).
- **Adapter capability is a hard gate over the annotation policy.** `BaseDbAdapter.canFilterField(fd)` defaults to `fd.storage !== 'json'` (vetoes value comparison only — a sole `$exists` entry bypasses it, `$geoWithin` is checked by the geo guard); `canSortField(fd)` vetoes `storage === 'json'` AND `designType 'json' | 'array'` (so Mongo/memory, which keep arrays inline as `column`, report `sortable: false` and 400 `$sort=tags` since 0.1.128). Mongo/memory override `canFilterField` to `!fd.encrypted`.
- **Never listed, always rejected for filter/sort/groupBy:** nested-object parents (`contact` — 400 names its leaves), navigation properties and their descendants (`assignee`, `assignee.name` — 400 says `use $with=assignee(...)`; since 0.1.128 Mongo/memory no longer list nav descendants), JSON descendants on SQL adapters (`prefs.theme` — 400 says select the parent; Mongo/memory list and accept them), `@db.ignore`d fields, unknown fields (`Unknown field "x"`).
- `$select`: listed fields, flattened parents (expand), JSON parents (whole value) and `@db.writeOnly` fields (stripped by the seal after the gate) pass; JSON descendants on SQL, encrypted descendants, root nav paths and unknown fields → 400. Applies to `/query`, `/pages`, `/geo`, `/one/:id` and `/one?…` (the composite endpoint was unvalidated before 0.1.128).
- Messages (locked): `Filtering on field "x" is not permitted — add @db.column.filterable to enable.` / `… — adapter cannot filter on this storage type.` (with ` (accepted operators: $exists).` before the period when `filterOps` exists) / `… — field is @db.writeOnly.`; `Sorting on field "x" is not permitted — …`; `"contact" is a nested object — filter or sort on one of its leaves (contact.email, …)`; `"assignee.name" is a navigation path — use $with=assignee(...) …`; `"prefs.theme" is inside JSON-stored column "prefs" — this adapter cannot filter JSON paths; select "prefs" and read the value client-side.`; `Unsupported filter operator "$nor" — use $and, $or or $not` (one wording with the core `guardPaths`, from `unsupportedOperatorMessage`); `$having key "region" must be an aggregate alias or a $groupBy field`.
- The core layer (`@atscript/db`) runs the same existence + physical checks in `guardPaths` for every read, aggregate, `updateMany` / `deleteMany` (`DbError("INVALID_QUERY")`), so programmatic callers and `transformFilter` overlays hit the same wall — physical column names (`contact__email`) are no longer accepted anywhere.

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

| Source                                                                                                                                                     | HTTP                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ValidatorError`                                                                                                                                           | 400                                                                                                               |
| `DbError` code `CONFLICT`                                                                                                                                  | 409                                                                                                               |
| `DbError` code `TX_WAIT_TIMEOUT` (SQLite gate waiter timed out — `transactionWaitTimeoutMs`)                                                               | 503                                                                                                               |
| `DbError` code `BUCKET_TZ_UNAVAILABLE` (engine can't resolve a calendar bucket's zone — MySQL tz tables, stale tzdata; since 0.1.132)                      | 501                                                                                                               |
| `DbError` code `CAS_MISMATCH` (`table.touchMany` stale/missing key — only via a custom route, since 0.1.129)                                               | 409                                                                                                               |
| Write body not an object / array of objects (shape gate, since 0.1.128)                                                                                    | 400 with `errors[{ path: "" \| "[i]", message: "Expected an object" }]`                                           |
| `DbError` any other code (`FK_VIOLATION`, `NOT_FOUND`, `CASCADE_CYCLE`, `INVALID_QUERY`, `DEPTH_EXCEEDED`, `VERSION_COLUMN_WRITE`, `BUCKET_NOT_SUPPORTED`) | 400                                                                                                               |
| CAS version mismatch on PATCH/PUT (`@db.column.version` table)                                                                                             | 409 with `kind: "version_mismatch"` — see [§ Optimistic concurrency over HTTP](#optimistic-concurrency-over-http) |
| `ActionDisabledError` (server-side action gate rejection — see [actions.md](actions.md))                                                                   | 409                                                                                                               |

## Value-help controllers

`AsReadableController`, `AsValueHelpController`, and `AsJsonValueHelpController` back non-DB `@db.rel.FK` sources (enums, static lists, JSON documents) so forms can resolve picker URLs from `@db.http.path` regardless of whether the target is a table.

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

### `AsJsonValueHelpController` query engine

Filter, sort, and projection run on the shared `@atscript/db-memory` engine (`buildMemoryPredicate` + `sortRows` + `projectRow`) — the same JS-native engine the MemoryAdapter uses. Engine semantics (null model, regex, dot-paths, operator set) are owned there: [adapters-memory.md](adapters-memory.md). Pipeline order: **filter → `$search` → sort → paginate → project**.

Gained for every static value-help surface (via the shared engine):

- dot-path field access (`a.b.c`) in filters, sort, and `$select`.
- `$exists` — "holds a value" (`null` ≡ absent since 0.1.132; see [queries.md § `$exists`](queries.md)).
- Mongo-like null model — `$eq:null` matches null AND missing; `$ne:null` matches only concrete present values.
- nested-path projection via `$select`.

Preserved (controller-owned, not the engine):

- `$search` — case-insensitive substring across `@ui.dict.searchable` fields (the engine has no `$search`; the controller applies it).
- flexible `$sort` grammar — `"field:asc,-other"`, arrays, `{ field: 'asc' | 'desc' }`.
- pagination (`/pages`).
- `@ui.dict.*` remain UI hints only; the controller stays **action-less** (`actions: []` — see [actions.md](actions.md)).

Behavior-change gotchas (were silent before the shared-engine move):

- **Unsupported filter operator → HTTP 400** (`DbError('INVALID_QUERY')`), previously a silent mis-match returning no rows.
- **`$regex` honors `/pat/flags`** — `$regex:'/foo/i'` is a real case-insensitive match (flags were ignored before).

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
  versionColumn?: string; // logical field name of the `@db.column.version` field; omitted when none. See versioning.md.
  bucketUnits?: BucketUnit[]; // calendar-bucket units; omitted when none (since 0.1.132). See calendar-buckets.md.
  relations: { name; direction: "to" | "from" | "via"; isArray }[];
  fields: Record<
    string,
    { sortable; filterable; filterOps?; indexed?; bucketable?; encrypted?; geo?; writeOnly? }
  >; // exact — see Gate mode
  type: TSerializedAnnotatedType; // always refDepth: 0.5 (FK refs shallow; chained refs resolve to the terminal field — see relations.md)
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

- Overlay filtering is informational only — hiding a `crud` key or `actions[]` entry does NOT block the underlying route. Per-principal enforcement is a separate concern.
- `client.meta()` caches per `Client` instance — instantiate per request for per-principal overlays in SSR.
- `actions[].disabled` is the stringified predicate (`fn.toString()`) — UI mirror only. Server enforcement on POST is the gate interceptor; per-row availability on read endpoints is `$actions=true` (see [actions.md § `$actions=true`](actions.md#actionstrue--server-evaluated-row-availability)). `requiredFields` is server-internal and never on the wire.

Consumed by `@atscript/db-client` to build a client-side validator matching the server's.

Wire CORS / auth / rate-limiting as Moost interceptors (`@Intercept`) — routes from `AsDbController`/`AsDbReadableController` participate normally.
