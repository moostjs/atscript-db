# Value-Help Controllers

Value help is the dropdown/autocomplete/row-picker UI that renders on FK fields. The source can be a DB table, a static JSON array, a read-only view of a legacy system, or any custom source — as long as it implements the small wire contract defined by `AsReadableController`.

## What changed

Before this release, value help only fired for fields whose `.ref` resolved to a `@db.table` interface — anything else (static enums, external lookups, view-backed entities) had no path through. Now:

- **Any interface can be a value-help source**, as long as it is bound to a controller that registers the shared `/query`, `/pages`, `/one(/:id)`, `/meta` surface and stamps `@db.http.path` on the interface metadata.
- **`@db.rel.FK` is the explicit marker** on the field side. The client-side picker looks for this annotation to decide whether a field should render a value-help picker. See the [annotations page](annotations#db-rel-fk-dual-role) for the dual-role semantics.
- **Capability hints live on the bound interface** via `@ui.dict.filterable`, `@ui.dict.sortable`, and `@ui.dict.searchable` — the client picker reads these from `/meta` to decide which controls to render. They are **hints only**: the server accepts any filter/sort the client sends. `$search` uses `@ui.dict.searchable` to pick which fields to match (falling back to every string prop when absent).

## Controllers

Three classes in `@atscript/moost-db`:

- **`AsReadableController<T>`** — abstract base. Handles `@db.http.path` stamping, the shared `/meta` route, serialization options, Uniquery control validation, and the helper surface reused by every subclass.
- **`AsValueHelpController<T>`** — abstract subclass for read-only value-help sources. Adds `/query`, `/pages`, `/one(/:id)`, `/one` routes. Subclasses implement `query(controls)` and `getOne(id)`.
- **`AsJsonValueHelpController<T>`** — concrete subclass backed by a static in-memory array. Handy for enum-style dictionaries that ship with the application and don't warrant a DB table.

`AsDbReadableController` / `AsDbController` now extend `AsReadableController` too; DB-backed tables and views participate in the same contract. See the [CRUD docs](../http/crud) for the DB-side details.

## Wire contract

Every value-help controller exposes the same four routes:

| Route       | Method | Purpose                                                                              |
| ----------- | ------ | ------------------------------------------------------------------------------------ |
| `/query`    | GET    | Filter + sort + search + (optionally skip) a window of rows. Returns `T[]`.          |
| `/pages`    | GET    | Same query surface, plus `$page` / `$size` pagination. Returns `{ data, count, … }`. |
| `/one/:id`  | GET    | Look up a single row by primary key. 404 on miss.                                    |
| `/one?pk=…` | GET    | Look up by primary-key query param (falls back when the PK is not URL-safe).         |
| `/meta`     | GET    | Returns the bound interface's serialized type plus capability hints (see below).     |

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

import { StatusDict } from "./value-help/status-dict.as";

const STATUSES = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
  { id: "draft", label: "Draft" },
];

@Controller("/api/dicts/status")
export class StatusDictController extends AsJsonValueHelpController<typeof StatusDict> {
  constructor(app) {
    super(StatusDict, STATUSES, app);
  }
}
```

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

The picker resolves via `prop.ref.type().metadata.get('db.http.path')` (stamped by the controller at registration) → `/api/dicts/status`. It fetches `/api/dicts/status/meta` once, caches it app-wide, and uses the capability hints to drive its UI.

## JSON-source semantics

The built-in `AsJsonValueHelpController.query` implementation iterates the constructor-provided array and applies Uniquery controls in this order:

1. **Filter** — MongoDB-style comparison operators (`$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$regex`) and logical combinators (`$and`, `$or`, `$not`, `$nor`). Unknown operators fall through to strict equality. Any field can be filtered — no gate.
2. **Search** — case-insensitive substring match. Fields to match come from `@ui.dict.searchable`: field-level annotation narrows to those props; absent or interface-level defaults to every `string`-typed prop.
3. **Sort** — stable, multi-key, lexicographic. Direction via a leading `-` or via the explicit `{ [field]: 'asc' \| 'desc' }` form. Any field can be sorted — no gate.
4. **Pagination** — `$skip` + `$limit` applied after filter/search/sort. `/pages` returns the full total count.

If you need richer semantics (locale-aware sort, tokenized search, FTS-style ranking), subclass `AsValueHelpController` directly and implement `query` / `getOne` yourself — everything above the data source (routing, meta serialization) stays the same.

## Client resolution order

On the client (`@atscript/ui`), value help resolves from the FK prop as follows:

1. `extractValueHelp(prop)` returns `undefined` unless `prop.metadata.has('db.rel.FK')`.
2. It reads `prop.ref.type().metadata.get('db.http.path')` to get the picker URL.
3. On picker open, the client fetches `{url}/meta` once and caches it app-wide.
4. The picker calls `{url}/query` / `{url}/pages` with the user's filter/sort/search input.

See the UI docs for the full client-side story.
