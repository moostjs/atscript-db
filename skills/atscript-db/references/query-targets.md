# Query targets — "run on every row matching the query" (0.1.147)

A `'rows'` action declaring `queryTarget` also accepts `{ query: { q, exclude?, expectCount?, maxRows?, dryRun? }, input? }` instead of `{ ids }`. Docs: `docs/http/query-targets.md`.

## Quick start

```ts
import { DbAction, DbActionTarget, perRow, type TDbActionTarget } from "@atscript/moost-db";

@Post("actions/close")
@DbAction<Issue>("close", {
  label: "Close",
  requiredFields: ["status"],
  disabled: perRow((r) => r.status === "closed" && "Already closed"),
  queryTarget: { maxRows: 5_000, batchSize: 500 }, // `true` = 10_000 / 500
})
async close(@DbActionTarget() target: TDbActionTarget<Issue>) {
  for await (const { ids } of target.batches()) await closeAll(ids);
  return target.summary(); // { matched, processed, skipped[{id,reason?}], failed[{id,reason}] }
}
```

Client: `client.countActionTarget(name, { filter, search, index, exclude })` → `{ matched }` (dry run), then `client.actionOnQuery(name, { ...target, expectCount: matched }, input?)` — see [db-client.md](db-client.md).

## Invariants

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Opt-in per action (`queryTarget`, method `@DbAction` only); `'rows'` level only — on a `'row'`/`'table'` action the action is DROPPED from `/meta` (warn). Wire: `info.queryTarget = { maxRows }` — for materialized handlers already `min(maxRows, maxIds)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | `q` = the `GET /query` string: filter + `$search` / `$index` ONLY. Any other control (`$sort`, `$limit`, `$select`, `$with`, `$vector`, …), unknown `query` key, `ids`+`query`, or `query` on an action without `queryTarget` → 400 `ActionTargetError` `TARGET_INVALID` (a `query` key on ANY `'rows'` action is validated, never ignored). Checked as a READ (child event, `prepareRequest({ endpoint: "query", controls, filter })` with the TARGET's filter — a permission layer resolves its relation-predicate policy there; `validateControls`, field/index gate, `hasField`, `exclude` identifications, `transformRelationFilter`): a field the read grant hides → 400, so `matched` is no count oracle. Delegated targets: the VIEW's check + read hooks (`transformFilter`, `queryTargetScope`) run the same way. |
| 3   | Phase 1 resolves ONCE: `q ∧ transformOne({}) ∧ queryTargetScope(action) ∧ ¬{$or: exclude}`. `queryTargetScope` (protected hook, default `transformFilter({})`) RUNS AS A READ: child event, controller method `query`, after `prepareRequest({ endpoint: "query", controls, filter })` → the caller's READ scope even when the action grant is wider; a refused read (403) → no query targets (ids still work). Throw `HttpError` there to refuse query targets.                                                                                                                                                                                                                                                                                                                                                            |
| 4   | Cap = `min(queryTarget.maxRows, query.maxRows)` (materialized handlers also `maxIds`); more rows → 400 `TARGET_TOO_LARGE {cap}`. `expectCount` ≠ matched → 409 `TARGET_CHANGED {matched}`. `dryRun` → `{ matched }`, handler not run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | SNAPSHOT semantics: each row is re-checked when processed (query, overlay, `queryTargetScope`, `exclude`, `actionRowScope` per batch with `purpose: "execute"`, `disabled`); the QUERY re-check is skipped for the first batch (= all rows when materialized) — it directly follows the snapshot. Changed-out rows → skipped `reason: "stale"`; rows inserted after phase 1 are not included. No cross-batch transaction. A query matching NO row never runs the handler → empty summary.                                                                                                                                                                                                                                                                                                                                   |
| 6   | `@DbActionIDs` / `@DbActionRows` + `queryTarget` = materialized: no handler change, the `'rows'` gate runs over the whole target, `onDisabledRows` honoured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | `@DbActionTarget()` = streamed: batches of `batchSize`, ALWAYS skip semantics (`onDisabledRows: 'reject'` ignored + warn). Also serves `{ ids }` (`kind: "ids"`). Not combinable with `@DbActionID*` / `@DbActionRow*` (dropped + warn). `batches()` is single-pass. Handler throwing AFTER a batch was yielded → 201 partial summary `aborted {status,message}` (held batch + unreached ids in `failed`); before any batch, or before the handler started (`@InputForm` 400, later interceptor, arg pipe) → the error.                                                                                                                                                                                                                                                                                                     |
| 8   | `useDbActionTarget()` works in ANY `'rows'` handler: with `onDisabledRows: 'skip'` its `summary().skipped` lists the dropped ids + reasons (since 0.1.147 the skip is recorded).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 9   | Delegated actions (`@DbActionsFrom`) take a query on the VIEW's `queryTarget.url`, not on `value` — see [view-actions.md](view-actions.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Key imports

```ts
import { DbActionTarget, useDbActionTarget, ActionTargetError } from "@atscript/moost-db";
import type {
  TDbActionTarget,
  TDbActionQueryTarget,
  TDbQueryTargetOpts,
  TDbActionTargetSummary,
} from "@atscript/moost-db";
import {
  ActionTargetError as ClientActionTargetError,
  type TDbQueryTarget,
} from "@atscript/db-client";
```

## See also

| Domain                          | File                               | When                                                   |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| Actions, gate, `actionRowScope` | [actions.md](actions.md)           | Declaring the action, `disabled`, row scope            |
| View delegation                 | [view-actions.md](view-actions.md) | "All matching" on a view listing a table's actions     |
| Client                          | [db-client.md](db-client.md)       | Calling `actionOnQuery` / handling `ActionTargetError` |
