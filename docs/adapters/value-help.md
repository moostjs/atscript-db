---
outline: deep
---

<!--@include: ../_experimental-warning.md-->

# Value-Help Controllers

Value help is the dropdown/autocomplete/row-picker UI that renders on FK fields. The source can be a DB table, a static JSON array, a read-only view of a legacy system, or any custom source — as long as it implements the small wire contract defined by `AsReadableController`.

## What changed

Before this release, value help only fired for fields whose `.ref` resolved to a `@db.table` interface — anything else (static enums, external lookups, view-backed entities) had no path through. Now:

- **Any interface can be a value-help source**, as long as it is bound to a controller that registers the shared `/query`, `/pages`, `/one(/:id)`, `/meta` surface and gets `@db.http.path` published for it after `app.init()`.
- **`@db.rel.FK` is the explicit marker** on the field side. The client-side picker looks for this annotation to decide whether a field should render a value-help picker. See the [annotations page](annotations#db-rel-fk-dual-role) for the dual-role semantics. A field can also be bound **without** a foreign key by `@ui.valueHelp` (see [Constraint-free binding](#ui-value-help) below).
- **Capability hints live on the bound interface** via `@ui.dict.filterable`, `@ui.dict.sortable`, and `@ui.dict.searchable` — the client picker reads these from `/meta` to decide which controls to render. They are **hints only**: the server accepts any filter/sort the client sends. `$search` uses `@ui.dict.searchable` to pick which fields to match (falling back to every string prop when absent).

## Controllers

Three classes in `@atscript/moost-db`:

- **`AsReadableController<T>`** — abstract base. Handles the `@db.http.path` publication (derived from the route the controller is mounted on), the shared `/meta` route, serialization options, Uniquery control validation, and the helper surface reused by every subclass.
- **`AsValueHelpController<T>`** — abstract subclass for read-only value-help sources. Adds `/query`, `/pages`, `/one(/:id)`, `/one` routes. Subclasses implement `query(controls)` and `getOne(id)`. Value-help controllers do not support actions. Since 0.1.143, `@DbAction` / `@DbActions*` on one is a hard error (see [Actions](../http/actions#value-help-controllers-are-excluded)).
- **`AsJsonValueHelpController<T>`** — concrete subclass backed by a static in-memory array. Handy for enum-style dictionaries that ship with the application and don't warrant a DB table.

`AsDbReadableController` / `AsDbController` now extend `AsReadableController` too; DB-backed tables and views participate in the same contract. See the [CRUD docs](../http/crud) for the DB-side details.

## Wire contract

Every value-help controller exposes the same four routes:

| Route       | Method | Purpose                                                                                                                                                              |
| ----------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/query`    | GET    | Filter + sort + search + (optionally skip) a window of rows. Returns `T[]`.                                                                                          |
| `/pages`    | GET    | Same query surface, plus `$page` / `$size` pagination. Returns `{ data, count, … }`. Without `$sort` (and `$search`) rows come in primary-key order (since 0.1.153). |
| `/one/:id`  | GET    | Look up a single row by primary key. 404 on miss.                                                                                                                    |
| `/one?pk=…` | GET    | Look up by primary-key query param (falls back when the PK is not URL-safe).                                                                                         |
| `/meta`     | GET    | Returns the bound interface's serialized type plus capability hints (see below).                                                                                     |

Clients rely on the `/meta` response for both the field contract (label, description, attribute projection) and the **capability hints** (`fields[path].filterable`, `.sortable`, and the top-level `.searchable`). The client picker uses these to decide which controls to render.

## Capability annotations

These are defined in `@atscript/ui` (one-time server-agnostic import) and surfaced by the value-help controller in its `/meta` response so the client picker can wire them into its UI. **They are client-side hints only** — the server does not reject requests for fields that lack them.

| Annotation            | Applies To         | Effect                                                                                                                                                                |
| --------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ui.dict.filterable` | Field              | Picker renders a filter chip for this field. Server still accepts filters on any field.                                                                               |
| `@ui.dict.sortable`   | Field              | Picker offers this field in the sort dropdown. Server still accepts sorts on any field.                                                                               |
| `@ui.dict.searchable` | Field OR Interface | Picker renders a search input. `AsJsonValueHelpController.query` uses the annotation to pick which fields to match; if absent, every `string`-typed prop is searched. |

## Example — static JSON dictionary

```ts
import { AsJsonValueHelpController } from "@atscript/moost-db";
import { Controller } from "moost";
import { Moost } from "moost";

import { StatusDict } from "./value-help/status-dict.as";

const STATUSES = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
  { id: "draft", label: "Draft" },
];

@Controller("/api/dicts/status")
export class StatusDictController extends AsJsonValueHelpController<typeof StatusDict> {
  constructor(app: Moost) {
    // `'status'` is the controller name — used for logging and diagnostics only; the
    // `db.http.path` comes from the route the controller is mounted on. Required
    // unless the bound type carries a `@db.table` annotation.
    super(StatusDict, STATUSES, app, "status");
  }
}
```

`AsJsonValueHelpController` already carries an `@Inherit()` decorator on the base class, so subclasses **do not** need to repeat it. The constructor signature is `(boundType, rows, app, controllerName?, opts?)`. The fourth argument is optional — when omitted, the controller falls back to `boundType.metadata.get('db.table')` and finally to the literal `"value-help"`; it only names the controller in logs (the published `db.http.path` comes from the route). If one dictionary is mounted on several routes, mark the one whose route pickers should use with `{ canonical: true }` as the trailing `opts` argument (`super(StatusDict, STATUSES, app, "status", { canonical: true })`); `AsValueHelpController` takes the same option as its fourth constructor argument. The full rules live in [Several controllers over one model](../http/index#several-controllers).

On the Atscript side:

```atscript
export interface StatusDict {
    @meta.id
    id: string

    @ui.dict.filterable
    @ui.dict.sortable
    label: string
}
```

Elsewhere — e.g., in a form schema — you reference the dictionary via `@db.rel.FK`:

```atscript
export interface InviteForm {
    email: string

    @db.rel.FK
    status: StatusDict.id
}
```

The picker resolves via `prop.ref.type().metadata.get('db.http.path')` (published for the app after `app.init()`) → `/api/dicts/status`. It fetches `/api/dicts/status/meta` once, caches it app-wide, and uses the capability hints to drive its UI.

## Constraint-free binding with `@ui.valueHelp` {#ui-value-help}

`@db.rel.FK` needs the target to be a unique key of a `@db.table` and creates a database constraint. When the values live in a shared dictionary (an attribute-value table, a country list) and no constraint is wanted, bind the field with the `@ui.valueHelp` annotation of `@atscript/ui` instead:

```atscript
export interface TicketOverview {
    @ui.valueHelp AttributeValue, 'value', `attribute = 'color'`
    color: Ticket.color

    @ui.valueHelp Country, 'code'
    countryCode: Ticket.countryCode
}
```

Arguments: the dictionary interface, the field the picker commits, and an optional static filter (literal comparisons on the dictionary's own fields). The binding creates no foreign key and no DDL; it travels through chain refs and `extends` like a value-domain annotation. The dictionary must be served by a controller (a DB controller or any value-help controller): `/meta` carries the binding as `{ target: { id, metadata: { "db.http.path": … } }, field, filter }`, with the path published for the app. The binding wins over a `@db.rel.FK` on the same field. The server applies the usual row scope and field visibility of the dictionary controller to every picker query; the filter is applied by the client as a forced filter and is not a permission boundary.

### Distinct values of a column {#distinct-values}

To offer the values already stored in a column as picker options, mark it `@ui.valueHelp.distinct`. The client then queries the column's own controller with a plain aggregation (`$groupBy=city&$select=city&$sort=city&$limit=…`), so no dictionary is needed. It is offered only when `/meta.fields[path]` has both `filterable: true` and `groupable: true` (`groupable` is present exactly when `$groupBy` on that field passes the gate; on a table declaring `@db.column.dimension`, only dimensions are groupable). A permission overlay that strips the `$groupBy` control removes the offer too.

## Per-request scoping {#scoping}

Since 0.1.143, `AsValueHelpController` has the same three scoping seams as the DB controllers. The base routes apply them to every value-help source, so a permission layer needs no extra code per subclass. Each hook may be async.

| Hook                          | Default             | Applied to                                                                                                                                                                                                        |
| ----------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transformFilter(filter)`     | identity            | `/query` and `/pages`: receives the request filter and returns the one `query()` runs. `/one` checks the found row against `transformFilter({})` in memory: a row outside it is a 404, the same as a missing row. |
| `transformProjection(select)` | identity            | Receives the request `$select` (`undefined` when absent; `/one` always passes `undefined`). Returns the projection to apply: an inclusion list or `{ path: 1 }` map, or an exclusion `{ path: 0 }` map.           |
| `hasField(path)`              | every declared prop | A path it rejects in the filter, `$sort` or `$select` gets the same `Unknown field "x"` 400 as a nonexistent one. A hidden field never matches `$search`.                                                         |

`hasField` gates the request only. To also remove a hidden column from responses, return an exclusion from `transformProjection`:

```ts
@Controller("/api/dicts/accounts")
export class AccountDictController extends AsJsonValueHelpController<typeof AccountDict> {
  constructor(app: Moost) {
    super(AccountDict, ACCOUNTS, app, "accounts");
  }

  protected override transformFilter(filter: FilterExpr): FilterExpr {
    return { $and: [filter, { tenantId: currentTenant() }] };
  }

  protected override transformProjection(select?: ValueHelpSelect<Account>) {
    return select ?? { internalCode: 0 };
  }

  protected override hasField(path: string): boolean {
    return path !== "internalCode" && super.hasField(path);
  }
}
```

`prepareRequest` runs first on `/query`, `/pages` and `/one`, before any of these hooks. See [Customization](../http/customization).

A custom `AsValueHelpController` subclass receives the filter and `$select` that already went through the hooks in `query(controls)`. It must apply both. `getOne(id)` returns the raw row; the base route applies the overlay and projection to it.

## JSON-source semantics

The built-in `AsJsonValueHelpController.query` implementation iterates the constructor-provided array and applies Uniquery controls in this order, delegating filter, sort, and projection to the shared JS-native engine from the [Memory adapter](./memory) (`buildMemoryPredicate` / `sortRows` / `projectRow` — the same engine that backs in-memory tables):

1. **Filter** — MongoDB-style comparison operators (`$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$regex`, `$exists`) and logical combinators (`$and`, `$or`, `$not`, `$nor`), over **dot-path** access into nested objects. `$regex` honors inline flags (`/foo/i`). The [MongoDB-like null model](./memory#comparison-semantics) applies: `$eq: null` matches an explicit `null` **or** a missing field; `$ne: null` matches only a concrete present value. Any field can be filtered — no gate.
2. **Search** — case-insensitive substring match, applied by the controller itself (the engine has no `$search`). Fields to match come from `@ui.dict.searchable`: field-level annotation narrows to those props; absent or interface-level defaults to every `string`-typed prop. A field [`hasField`](#scoping) hides is skipped.
3. **Sort** — stable, multi-key. Accepts the flexible value-help grammar: a leading `-`, `"field:asc,-other"` strings, arrays, or the `{ [field]: 'asc' \| 'desc' }` form. Any field can be sorted — no gate. Since 0.1.153 the URL suffix `:first` / `:last` (`$sort=-label:last`) places `null` / missing values ([NULL placement](/api/queries#nulls)), and `/pages` without `$sort` or `$search` sorts by the primary key so pages never overlap. A custom `AsValueHelpController` receives that default as `controls.$sort = { [pk]: 1 }` and the placement as `controls.$nulls`.
4. **Projection** — `$select` resolves nested dot-paths.
5. **Pagination** — `$skip` + `$limit` applied after filter/search/sort. `/pages` returns the full total count.

::: warning Two behavior notes after the engine consolidation

- An **unsupported filter operator returns HTTP 400** (`DbError('INVALID_QUERY')`), not a silent fall-through to equality.
- **`$regex` now honors inline flags** — a consumer sending `/foo/i` gets a real case-insensitive match (previously the flags were dropped).
  :::

The `new AsJsonValueHelpController(Type, rows, app)` constructor and the action-less contract are unchanged. If you need richer semantics (locale-aware sort, tokenized search, FTS-style ranking), subclass `AsValueHelpController` directly and implement `query` / `getOne` yourself — everything above the data source (routing, meta serialization) stays the same.

## Client resolution order

On the client (`@atscript/ui`), value help resolves from the FK prop as follows:

1. `extractValueHelp(prop)` returns `undefined` unless the prop carries a `@ui.valueHelp` binding or `prop.metadata.has('db.rel.FK')` (the binding wins when both are present).
2. It reads `prop.ref.type().metadata.get('db.http.path')` to get the picker URL.
3. On picker open, the client fetches `{url}/meta` once and caches it app-wide.
4. The picker calls `{url}/query` / `{url}/pages` with the user's filter/sort/search input.

See the UI docs for the full client-side story.
