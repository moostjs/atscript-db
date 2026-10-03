---
outline: deep
---

# Actions on a View

Since 0.1.147. A view's rows often stand for rows of a table — an issue board lists issues joined with their tickets. `@DbActionsFrom` lists the table controller's row actions on the view controller, so a UI over the view can offer "Close" on each row without the view re-implementing the action:

```typescript
import { AsDbReadableController, DbActionsFrom, ViewController } from "@atscript/moost-db";

@ViewController(IssueBoard)
@DbActionsFrom(() => IssueController) // IssueBoard.id ← Issue.id, derived from the view
export class IssueBoardController extends AsDbReadableController<typeof IssueBoard> {}
```

The actions stay the source's. Its route runs them, and its guards, `prepareRequest`, row overlay, [`actionRowScope`](./actions#action-row-scope) and `disabled` decide. The view only maps its rows to source ids.

## Options

| Option    | Meaning                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `idMap`   | Source identification field → path in the view's rows. Its keys must be exactly one identification of the source (primary key or a unique index). Required when the controller is not bound to a view. |
| `actions` | The source's row / rows-level actions to delegate. Default: all of them.                                                                                                                               |

```typescript
@DbActionsFrom(() => IssueController, { idMap: { id: "issueId" } })                     // renamed column
@DbActionsFrom(() => LineController, { idMap: { issueId: "issue", lineNo: "line" } })   // composite key
@DbActionsFrom(() => IssueController, { actions: ["close", "reopen"] })                 // a subset
```

Without `idMap`, each of the source's `preferredId` fields must map to exactly one plain view column (not aggregated, not inside a JSON column). Otherwise the first request that needs the delegation fails with a configuration error naming the field. A left-joined (nullable) column is fine: a view row whose value is `null` simply gets no delegated actions.

The decorator is repeatable (several sources; `/meta` lists them in declaration order, the top decorator first). The source is referenced lazily, so controllers can reference each other without import cycles, and it must be registered with the app. Unknown or table-level action names, a name already used by the view's own actions or another delegation, and an `idMap` that is not an identification are configuration errors.

## What the view answers

| Surface                        | Delegated actions                                                                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /meta`                    | Listed after the view's own actions, as the source lists them for this caller, with `owner` (the source's base path), `idMap` (unless the ids are the view's `preferredId` unchanged) and `formUrl` pointing at the source's form. No `disabled` string is sent. |
| `$actions` on reads            | Each row carries the source's verdict for the row it maps to — exactly what the source's own `GET /meta/actions/:id` answers. The `idMap` columns are always selected and kept, even when `$select` omits them (unless `transformProjection` drops them).        |
| `GET /meta/actions/:id` / `?…` | Answered when the source id is the request id renamed (every `idMap` path is a field of the id used, e.g. `?issueId=7`). Otherwise only the view's own actions are listed; ask the `owner` directly.                                                             |
| Running an action              | The client POSTs to the action's `value` — the source's route — with ids mapped through `idMap`. [`client.action()`](./client#delegated-actions) does the mapping.                                                                                               |
| "All matching" (query target)  | When the source action declares [`queryTarget`](./query-targets), the view takes the query on `queryTarget.url` — see below.                                                                                                                                     |

A caller whose source `prepareRequest` refuses (401 / 403) simply gets no delegated actions; any other error propagates. The source's hooks run as the source in a child of the view's request that shares its DI scope, so a `FOR_EVENT` dependency of the source (a request principal, say) resolves to the view request's instance. A view whose [`hasField`](./customization#hasfield) hides an `idMap` path — or whose [`transformProjection`](./customization) drops one — drops that delegation for the request.

## Query targets on delegated actions

`POST {view}/delegated-actions/:name` with `{ query, input? }` (the [query-target body](./query-targets#the-request)). The route exists only on controllers declaring `@DbActionsFrom` (and their subclasses).

1. The **source** must list the action for the caller (its `allowedActions`, as for `$actions`) — otherwise 403, dry runs included. An action of the delegation that takes no query target answers 400 `TARGET_INVALID`; an unknown name 404.
2. The **view** resolves the matching view rows under its own read scope: `transformFilter(q) ∧ queryTargetScope(name) ∧ ¬exclude`. `expectCount`, `maxRows` (the source action's) and `dryRun` work as for any query target and count view rows.
3. Each row is mapped to a source id. A row without one is reported as skipped with reason `"unmapped"` (its `id` lists only view identity fields the caller can see); duplicate source ids run once. `exclude` entries may use the view's identifications or the `idMap` paths — either way the **source row** they map to is left out, even when other view rows map to it too (a view joining one issue to several labels).
4. The **source's action route** runs on the ids in batches (`min(batchSize, maxIds)` of the source action), inside the same request. Before each batch after the first the view rows are re-checked against the query: a source id none of whose view rows still matches is skipped as `"stale"`. Every batch passes the source's full pipeline: guards and other interceptors, `prepareRequest`, row overlay, `actionRowScope`, `disabled`, `@InputForm` validation. Ids its gate refuses are skipped with their reasons (the batch reruns once without them).

The answer is a `TDbActionTargetSummary`:

| Field                  | Meaning                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matched`              | View rows the query matched                                                                                                                                     |
| `processed`            | Source rows the source handlers processed                                                                                                                       |
| `skipped`              | `"unmapped"`, `"stale"`, the gate's refusals (with reasons)                                                                                                     |
| `failed`               | Rows a handler reported, rows of a batch no handler ran for (`"not run"` — an interceptor answered instead), and the rows of an aborted run                     |
| `aborted`              | `{ status, message }` when a batch failed once a source handler had started — earlier batches stay applied, the failed batch and every later id are in `failed` |
| `messages` / `message` | The `message` string each batch's handler returned, in order / the distinct ones joined by newlines                                                             |

A source handler counts as run once it starts — after its guards, the gate, every other interceptor and its argument pipes (`@InputForm` validation included) passed. A failure before any source handler started is the request's error, exactly as the source's own route answers it; nothing ran. That covers a 403 because the caller holds no grant for the action, and an `input` the source's `@InputForm` rejects: every batch carries the same `input`, so the first batch's 400 (with its `errors`) is the answer. A source `@DbActionTarget()` handler that fails mid-batch answers its own partial summary; the view merges it and stops there (`aborted`). A refusal before the handler started (the gate's `ActionDisabledError`) reruns the batch once without the refused ids; a handler that throws `ActionDisabledError` itself is never rerun.

### What the source sees in a batch

The batch runs through `MoostHttp.invoke()` (moost 0.6.43): a child of the view's request.

| Source code reads                                                                   | Value                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------- |
| `@Body()`, `@RawBody()`, `useBody()`, `useRequest().rawBody()`, `@DbActionIDs()`, … | The batch body `{ ids, input }`              |
| Route params, `useControllerContext()`                                              | The source route's own                       |
| `FOR_EVENT` dependencies                                                            | Fresh per batch, released when it settles    |
| Request headers, authorization, cookies, `useRequest().url`, query string           | The view request's                           |
| `useResponse()` writes (status, headers, cookies)                                   | Discarded — the view's response is untouched |

`prepareRequest` on the view runs first with `endpoint: "delegatedAction"` and `ctx.action`. [`getDbEndpoint`](./customization#getdbendpoint) reports that endpoint for the route.

## DOs and DON'Ts

- **Do** put permissions on the source controller — they apply wherever its actions are listed.
- **Do** give the view the source's id column under the same name when you can: the `idMap` then stays off the wire.
- **Do** return a `message` from the source handler when the UI should show one — a delegated run passes it on in `messages` / `message`.
- **Don't** re-declare the action on the view controller — a name collision is a configuration error.
- **Don't** authorize a source action on the request URL, query string or `content-length` — inside a delegated batch they describe the view's request. Authorize on the body (`ids`) or the row overlay.
- **Don't** write to the raw response (`useResponse().getRawRes()`) from a source action: inside a delegated batch that is the view's socket.
- **Don't** read state that depends on "the current controller" from a cached event slot computed before the delegation: source hooks run as the source in a child of the view's event (sharing its `FOR_EVENT` instances), and their writes stay there.

## See also

- [Actions](./actions) — the gate, `actionRowScope`, `GET /meta/actions/:id`
- [Query targets](./query-targets)
- [Querying views](/views/querying-views)
