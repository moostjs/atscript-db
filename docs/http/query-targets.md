---
outline: deep
---

# Query Targets

Since 0.1.147. A `'rows'` action normally runs on the identifiers the client sends. A **query target** runs it on "every row matching this query" instead — the filter and search the user is looking at — without the client loading and listing every id. Opt in per action with `queryTarget`:

```typescript
import { DbAction, DbActionTarget, type TDbActionTarget } from "@atscript/moost-db";

@TableController(IssueTable)
export class IssuesController extends AsDbController<typeof IssueTable> {
  @Post("actions/close")
  @DbAction<Issue>("close", {
    label: "Close",
    requiredFields: ["status"],
    disabled: perRow((r) => r.status === "closed" && "Already closed"),
    queryTarget: { maxRows: 5_000, batchSize: 500 }, // or `true` = 10 000 / 500
  })
  async close(@DbActionTarget() target: TDbActionTarget<Issue>) {
    for await (const { ids } of target.batches()) {
      await this.table.bulkUpdate(ids.map(({ id }) => ({ id, status: "closed" })));
    }
    return target.summary();
  }
}
```

```bash
POST /issues/actions/close
{ "query": { "q": "teamId=a&$search=login", "expectCount": 120 } }
# → { "matched": 120, "processed": 118, "skipped": [{ "id": { "id": 7 }, "reason": "Already closed" }, …], "failed": [] }
```

The action's `/meta` entry carries `queryTarget: { maxRows }`, so a UI knows it may offer "select all matching" — for a materialized handler (`@DbActionIDs` / `@DbActionRows`) that is already `min(maxRows, maxIds)`, the most rows it accepts. On the client use [`actionOnQuery`](./client#query-targets).

## The request

The body is `{ query, input? }` instead of `{ ids, input? }` (see [Body envelope](./actions#body-envelope)):

| `query` key   | Meaning                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`           | The query string `GET /query` accepts — the filter plus `$search` / `$index` only. Same parsing, `$search` fallback and field gate as `/query`. |
| `exclude`     | Identifiers to leave out (any identification of the table), at most `maxIds`.                                                                   |
| `expectCount` | Fail with 409 `TARGET_CHANGED` when the query no longer matches exactly this many rows.                                                         |
| `maxRows`     | A client-side cap. It never raises the action's `maxRows`.                                                                                      |
| `dryRun`      | Count only: the answer is `{ matched }` and the handler does not run.                                                                           |

`ids` and `query` together, a control other than `$search` / `$index` (`$sort`, `$limit`, `$select`, `$with`, `$vector`, …), an unknown key, or `query` on an action without `queryTarget` → 400 `TARGET_INVALID`. A body with a `query` key on any `'rows'` action is validated this way — it is never ignored.

The query is checked twice, and must pass both:

- as the **action** request sees it: [`validateControls`](./customization#validatecontrols) (per-control authorization), the field / index gate and [`hasField`](./customization#hasfield) — a filter or `$index` on a hidden field answers exactly like `/query` does (`Unknown field`);
- as a **read**: the same checks, plus the `exclude` identifications, run after `prepareRequest({ endpoint: "query", controls })` in a child of the action request whose controller method is `query` (see [`queryTargetScope`](#which-rows)). A field the caller can't read can't filter a target, and its `matched` count is no oracle for it.

## Which rows

The target is resolved once ("phase 1") as

```
q (filter + $search) ∧ row overlay (transformOne) ∧ queryTargetScope(action) ∧ ¬exclude
```

`queryTargetScope(action)` is a protected hook on `AsDbReadableController` that defaults to `transformFilter({})`, the read scope of `/query`. It runs **as a read**: in a child of the action request whose controller method is `query`, after `prepareRequest({ endpoint: "query", controls })` — so the overlay is the caller's READ scope even when the action request's own state (a permission layer's action grant) is wider, and a `prepareRequest` that refuses the read (403) refuses the query target. Nothing it writes leaks back into the action request. So the target is "the rows the user could list that match the query" AND "the rows the action may run on" — a caller with an action grant but no read grant can still run the action on ids, never on "all matching". Override it to refuse query targets to a caller (throw an `HttpError`) or to narrow them differently:

```typescript
protected override queryTargetScope(action: string) {
  if (!canListIssues()) throw new HttpError(403); // no read grant → no "all matching"
  return super.queryTargetScope(action);
}
```

More matching rows than the cap (`min(queryTarget.maxRows, query.maxRows)`, and for materialized handlers also `maxIds`) → 400 `TARGET_TOO_LARGE` with `cap`. A count other than `expectCount` → 409 `TARGET_CHANGED` with the current `matched`.

## Consistency

The target is a **snapshot** of the ids matching at phase 1. Each row is checked again when it is processed: against the query (filter, search, overlay, `queryTargetScope`, `exclude`), the action's [`actionRowScope`](./actions#action-row-scope-candidates) (called per batch with `purpose: "execute"`) and `disabled`.

- A row that no longer matches the query is skipped as `"stale"`.
- Rows created after phase 1 are not included.
- A query matching no row never runs the handler: the answer is the empty summary `{ matched: 0, processed: 0, skipped: [], failed: [] }`.
- There is no transaction across batches. Open one per batch in the handler if you need it.

## Two handler styles

| Parameter                            | How the handler gets the rows                                                                                                                   | Gate failures                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `@DbActionIDs()` / `@DbActionRows()` | All at once, after the [`'rows'` gate](./actions#rows-batch-mode) ran over the whole target. No handler change needed — just add `queryTarget`. | `onDisabledRows` applies: `'reject'` → 409 for the whole target, `'skip'` → skipped. |
| `@DbActionTarget()`                  | In `batchSize` batches, each gated when the handler reaches it.                                                                                 | Always skipped (a `'reject'` cannot be honored after earlier batches ran).           |

`@DbActionTarget()` also serves plain `{ ids }` bodies (`kind: "ids"`), so one handler covers both a selection and "all matching". It cannot be combined with `@DbActionID*` / `@DbActionRow*` (the action is dropped with a warning).

### `TDbActionTarget`

| Member          | Use                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `kind`          | `"ids"` or `"query"`.                                                                                                               |
| `matched`       | Rows the target resolved to (after `exclude`, before the per-batch gate).                                                           |
| `batches()`     | `for await (const { ids, rows } of target.batches())` — single pass. `rows` carry the id fields and the visible `requiredFields`.   |
| `fail(id, why)` | Report a row the handler could not process.                                                                                         |
| `summary()`     | `{ matched, processed, skipped, failed }` (`TDbActionTargetSummary` from `@atscript/db`). Returning it is the recommended response. |

A `@DbActionTarget()` handler that throws **after it received a batch** answers its partial summary instead of the bare error: `aborted: { status, message }`, the batch it was on in `failed` with the error's message (it may be half-applied), and every row not reached in `failed` as `"not run"`. Earlier batches stay counted in `processed`. An error before the first batch reached the handler stays the request's error.

### Reading the summary in a materialized handler {#summary}

`useDbActionTarget()` returns the same object inside any `'rows'` action handler. With `@DbActionIDs` / `@DbActionRows` the gate already ran, so `summary().skipped` lists the ids `onDisabledRows: 'skip'` dropped, with their reasons:

```typescript
@DbAction("archive", { label: "Archive", requiredFields: ["status"], disabled, onDisabledRows: "skip", queryTarget: true })
async archive(@DbActionIDs() ids: Array<{ id: number }>) {
  await archiveAll(ids);
  return useDbActionTarget().summary();
}
```

## Errors

`ActionTargetError` (`name: "ActionTargetError"`, exported from `@atscript/moost-db`):

| `code`             | Status | Extra     |
| ------------------ | ------ | --------- |
| `TARGET_INVALID`   | 400    | —         |
| `TARGET_TOO_LARGE` | 400    | `cap`     |
| `TARGET_CHANGED`   | 409    | `matched` |

`@atscript/db-client` maps it to its own typed [`ActionTargetError`](./client#query-targets).

## DOs and DON'Ts

- **Do** confirm with a dry run first and pass its `matched` as `expectCount` — the run then fails instead of acting on a different set.
- **Do** return `target.summary()` (or include it) so the UI can report skipped and failed rows.
- **Do** catch per-row failures in a `@DbActionTarget()` handler and `target.fail()` them — a thrown error aborts the rest of the run.
- **Don't** rely on rows being processed in one transaction — batches commit independently.
- **Don't** set `onDisabledRows: "reject"` on a `@DbActionTarget()` action — it is ignored (and warned about).
- **Don't** expect a delegated action (from [`@DbActionsFrom`](./view-actions)) to take a query on the owner's route — it takes it on the view's `queryTarget.url`.

## See also

- [Actions](./actions) — levels, the gate, `actionRowScope`
- [Actions on a view](./view-actions) — query targets for delegated actions
- [Permissions](./permissions) — how `prepareRequest`, overlays and scopes compose
