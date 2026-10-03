---
outline: deep
---

# Permissions

Every `/meta` response carries a `crud` field that advertises which built-in
CRUD operations the controller exposes. UI clients read it to decide which
edit / delete / insert affordances to render.

```typescript
type TCrudOp = "query" | "pages" | "one" | "geo" | "insert" | "update" | "replace" | "remove";
type TCrudPermissions = Partial<Record<TCrudOp, string[]>>;
```

- **Key absent** → operation is denied / not exposed.
- **Key present** → operation is allowed; the `string[]` value is the accepted
  UniQuery control whitelist for read ops (`[]` for write ops, which take no
  controls — presence still signals "allowed").

A typical writable controller emits all seven keys:

```json
{
  "crud": {
    "query": [
      "filter",
      "insights",
      "skip",
      "limit",
      "count",
      "sort",
      "select",
      "search",
      "index",
      "fuzzy",
      "vector",
      "threshold",
      "with",
      "actions",
      "groupBy"
    ],
    "pages": [
      "filter",
      "page",
      "size",
      "sort",
      "select",
      "search",
      "index",
      "fuzzy",
      "vector",
      "threshold",
      "with",
      "actions"
    ],
    "one": ["select", "with", "actions"],
    "insert": [],
    "update": [],
    "replace": [],
    "remove": []
  }
}
```

## Default emission per controller class

| Class                       | Emitted keys                                       |
| --------------------------- | -------------------------------------------------- |
| `AsDbReadableController`    | `query`, `pages`, `one`; `geo` when geo-searchable |
| `AsDbController`            | inherits + `insert`, `update`, `replace`, `remove` |
| `AsValueHelpController`     | `query`, `pages`, `one`                            |
| `AsJsonValueHelpController` | `query`, `pages`, `one`                            |

`geo` advertises the [`/geo` endpoint](/search/geo-search#http-access-get-geo). It is emitted only when `/meta` reports `geoSearchable: true` — the adapter supports geo search **and** the table declares a `@db.index.geo` index — and is absent otherwise (so `AsDbController` inherits it on the same condition). Value-help controllers never emit it.

The read-op control whitelists are static per handler. The `query`, `pages` and `one` lists are importable as constants (the `geo` list has none):

```typescript
import { QUERY_CONTROLS, PAGES_CONTROLS, ONE_CONTROLS } from "@atscript/moost-db";
```

| Op      | Controls                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| `query` | `filter, insights, skip, limit, count, sort, select, search, index, fuzzy, vector, threshold, with, actions, groupBy` |
| `pages` | `filter, page, size, sort, select, search, index, fuzzy, vector, threshold, with, actions`                            |
| `one`   | `select, with, actions`                                                                                               |
| `geo`   | `filter, insights, center, maxDistance, minDistance, index, select, skip, limit, page, size, with, actions`           |

`actions` is the URL-control name for [`$actions=true`](./actions#actions-augmentation) — when the caller asks the server to compute per-row action availability.

## Handler methods per op {#crud-handlers}

Since 0.1.143 the handler method(s) serving each op are exported, so a permission layer can authorize a `crud` entry exactly as its route is authorized (an op is allowed when any of its handlers is):

```typescript
import { DB_CRUD_HANDLERS, VALUE_HELP_CRUD_HANDLERS } from "@atscript/moost-db";
```

| Op        | `DB_CRUD_HANDLERS` (`AsDbReadableController` / `AsDbController`) | `VALUE_HELP_CRUD_HANDLERS`        |
| --------- | ---------------------------------------------------------------- | --------------------------------- |
| `query`   | `query`                                                          | `runQuery`                        |
| `pages`   | `pages`                                                          | `runPages`                        |
| `one`     | `getOne`, `getOneComposite`                                      | `runGetOne`, `runGetOneComposite` |
| `geo`     | `geo`                                                            | —                                 |
| `insert`  | `insert`                                                         | —                                 |
| `update`  | `update`                                                         | —                                 |
| `replace` | `replace`                                                        | —                                 |
| `remove`  | `remove`, `removeComposite`                                      | —                                 |

Both maps are frozen. A readable serves only the read ops.

## Read-only check

`readOnly` was removed in favor of `crud`. Derive the boolean inline:

```typescript
const isReadOnly =
  !("insert" in meta.crud) &&
  !("update" in meta.crud) &&
  !("replace" in meta.crud) &&
  !("remove" in meta.crud);
```

::: warning Discoverability only — not a security boundary
The `crud` field tells the UI what to render. It does **NOT** stop a client
from hitting the underlying route. Real per-principal enforcement is the job
of the upcoming **ARBAC** package, which wires the same permission set into
the dispatchers and keeps `/meta` in sync automatically.
:::

## Relationship to `actions[]`

`crud` and `actions[]` are sibling fields on `/meta` with distinct dispatch
paths:

- `crud[op]` → typed client methods (`client.query()`, `client.insert()`, …).
- `actions[]` → `Client.action(name, pk?)`. POST-locked, single-PK-per-call.

See [Actions](./actions) for the actions wire shape.

## Action authorization at a glance (since 0.1.147)

- **Per-row action scope.** [`actionRowScope(action, ctx)`](./actions#action-row-scope-candidates) receives the candidate rows, so a scope may be derived from them. On the action route it now runs after the request body is read (it needs the ids); `prepareRequest` and the row overlay still run before it.
- **Query targets.** "Every row matching the query" resolves under the row overlay AND [`queryTargetScope(action)`](./query-targets#which-rows) — by default the read scope (`transformFilter({})`) — so a caller can target only rows they could list and may act on. `queryTargetScope` and the query's validation run **as a read** (`prepareRequest({ endpoint: "query" })` in a child of the action request): your `prepareRequest` sees a read there, and its per-request state (a read grant, field visibility) applies to the target without touching the action request's. Refuse the read (throw 403) and the caller can still act on ids, never on "all matching". Throw from `queryTargetScope` to refuse query targets otherwise.
- **Actions listed on a view.** [`@DbActionsFrom`](./view-actions) actions are authorized by their source controller, evaluated as itself: its `prepareRequest`, `allowedActions`, row overlay and `actionRowScope` decide `/meta`, `$actions` and execution. The view's `applyMetaOverlay` never sees them. A view's query target for such an action runs the source's route per batch inside the same request (the source's guards see each batch's own body), so the source re-checks every batch; source hooks share the request's `FOR_EVENT` instances.
