---
outline: deep
---

# Permissions

Every `/meta` response carries a `crud` field that advertises which built-in
CRUD operations the controller exposes. UI clients read it to decide which
edit / delete / insert affordances to render.

```typescript
type TCrudOp = "query" | "pages" | "one" | "insert" | "update" | "replace" | "remove";
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
| `AsDbReadableController`    | `query`, `pages`, `one`                            |
| `AsDbController`            | inherits + `insert`, `update`, `replace`, `remove` |
| `AsValueHelpController`     | `query`, `pages`, `one`                            |
| `AsJsonValueHelpController` | `query`, `pages`, `one`                            |

The read-op control whitelists are static per handler. Importable as constants:

```typescript
import { QUERY_CONTROLS, PAGES_CONTROLS, ONE_CONTROLS } from "@atscript/moost-db";
```

| Op      | Controls                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| `query` | `filter, insights, skip, limit, count, sort, select, search, index, vector, threshold, with, actions, groupBy` |
| `pages` | `filter, page, size, sort, select, search, index, vector, threshold, with, actions`                            |
| `one`   | `select, with, actions`                                                                                        |

`actions` is the URL-control name for [`$actions=true`](./actions#actions-augmentation) — when the caller asks the server to compute per-row action availability.

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
