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

## Relational predicates {#relational-predicates}

Since 0.1.147. A client [relational predicate](./query-syntax#relational-predicates) (`ticket=$some(status=open)`) filters the **parent** rows by their related rows — so the count of returned issues tells the client something about tickets. moost-db accepts one only under this rule:

> A predicate on relation `n` reveals nothing that `$with=n(<same filter>)` would not reveal under the same controller policy — same visibility, same field rules on the related table, same row overlay — **and** the relation opted in with [`@db.rel.filterable`](/relations/navigation#db-rel-filterable).

Every predicate in the URL filter and in `$with` sub-filters is checked before anything runs. Each failure is a 400 with the validation envelope:

| Check                                                                                                                                                                           | Rejection message                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The relation is visible — [`hasField`](./customization#hasfield) at its path                                                                                                    | `Unknown field "ticket"` (a hidden relation answers like a nonexistent one)                                                                                                                                                                                               |
| It is a navigation property                                                                                                                                                     | `"$some" / "$none" are only valid on a navigation relation — "title" is not one`                                                                                                                                                                                          |
| It opted in                                                                                                                                                                     | `Filtering by related "ticket" rows is not permitted — add @db.rel.filterable to enable.`                                                                                                                                                                                 |
| Its table is available                                                                                                                                                          | `Filtering by related "ticket" rows is not possible — the related table is not available.`                                                                                                                                                                                |
| Each operand field is visible at its full path (`hasField("ticket.code")`) and filterable under the **related table's** rules                                                   | the related table's own message, with the full path: `Unknown field "ticket.secret"`, `Filtering on field "ticket.code" is not permitted — field is @db.writeOnly.`, encrypted and JSON-storage rejections, `… — add @db.column.filterable to enable.` in `'manual'` mode |
| Nested predicates pass the same checks at their full path (`ticket.team`)                                                                                                       | as above                                                                                                                                                                                                                                                                  |
| One relation per level                                                                                                                                                          | `"ticket.team" is a navigation path — nest the predicates, one relation per level: ticket=$some(team=$some(…))`                                                                                                                                                           |
| At most 3 nested levels per chain, at most 8 predicates in the whole request (`$with` sub-filters included; `$with` hops do not count as levels) — the client's predicates only | `Relational predicates nest at most 3 levels deep ("ticket.team.tickets.issues")`, `At most 8 relational predicates per query`                                                                                                                                            |
| Not in `$having`                                                                                                                                                                | 400                                                                                                                                                                                                                                                                       |

A `@db.column.derived` operand field whose source is hidden answers `Unknown field`, as at the root. An adapter without predicate support answers `REL_FILTER_NOT_SUPPORTED` as a 400.

**Row overlay.** Filtering on visible fields is not enough when the caller may see only some related rows — a ticket of another team must neither make `$some` true nor `$none` false. Override [`transformRelationFilter`](./customization#transformrelationfilter) to AND the related table's row scope into each operand; `$none` then means "no **visible** related row matches", exactly what `$with` would show.

**Identification.** A predicate never identifies a row: `/one?…`, `DELETE /?…` and action ids accept identifications only.

**Server-side filters are not gated.** [`transformFilter`](./customization#transformfilter), [`transformOne`](./customization#transformone) and [`actionRowScope`](./actions#action-row-scope) may use predicates on any relation, without the opt-in or the overlay — they are the authorization rule. The same holds for row scopes a [`validateControls`](./customization#validatecontrols) override conjoins into `$with` entry filters: the gate judges the client's `$with` tree as it was **before** `validateControls` ran, and the overlay rewrites only the client's predicates. Such an override must wrap the client's filter object (`entry.filter = { $and: [scope, entry.filter] }`), not copy or drop it — with `transformRelationFilter` overridden, a client `$with` predicate that is no longer found answers 500 rather than run without its overlay. Server predicates do not count against the client's 8-predicate budget; the core's own limits (4 levels, 16 predicates) leave room for them.

**Permission layers.** [`prepareRequest`](./customization#preparerequest) receives the parsed client filter as `ctx.filter`, so a policy can resolve the relations its predicates touch alongside `ctx.controls.$with` (check `ctx.hasRelationFilters` first — reading `ctx.filter` copies it). With `@aooth/arbac-moost`, a client predicate on relation `R` is allowed exactly when the request's `$with` relation policy allows `R`, and the related table's row scope is conjoined into the operand through `transformRelationFilter` — see the [Aooth docs](https://aooth.moost.org).

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
