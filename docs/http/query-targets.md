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

| `query` key   | Meaning                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`           | The `GET /query` string — the filter plus `$search` / `$index` only. Parsed and gated as `/query`, but see [`$search` follows the read](#search). |
| `exclude`     | Identifiers to leave out (any identification of the table), at most `maxIds`.                                                                     |
| `expectCount` | Fail with 409 `TARGET_CHANGED` when the query no longer matches exactly this many rows.                                                           |
| `maxRows`     | A client-side cap. It never raises the action's `maxRows`.                                                                                        |
| `dryRun`      | Count only: the answer is `{ matched }` and the handler does not run.                                                                             |

`ids` and `query` together, a control other than `$search` / `$index` (`$sort`, `$limit`, `$select`, `$with`, `$vector`, …), an unknown key, or `query` on an action without `queryTarget` → 400 `TARGET_INVALID`. A body with a `query` key on any `'rows'` action is validated this way — it is never ignored.

The query is checked once, **as a read** of the table: [`validateControls`](./customization#validatecontrols) (per-control authorization), the field / index gate, [`hasField`](./customization#hasfield) and the `exclude` identifications run after `prepareRequest({ endpoint: "query", controls, filter })` in a child of the action request whose controller method is `query` (see [`queryTargetScope`](#which-rows)). A filter or `$index` on a hidden field answers exactly like `/query` does (`Unknown field`): a field the caller can't read can't filter a target, and its `matched` count is no oracle for it.

### `$search` follows the read {#search}

The `$search` fallback (the `@db.column.searchable` substring match — string and integer fields alike — and the choice between native and fallback search) is resolved by the **read's** field visibility, never the action's. If the read can't apply the term — every searchable field is hidden from the reader, or the table has neither a native search nor a searchable column — the request is a 400 `TARGET_INVALID` (`$search is not available here`). A term that matched every row would turn "act on rows matching this search" into "act on every row". `/query`, `/pages` and grouped reads stay lenient and ignore such a term; `/meta` already turns `searchable` off in that case, so a conforming UI never sends one.

On a natively searchable table the default text index answers a `$search` with no `$index`. When it reads a field the read hides, the index gate refuses first — the same 400 `No search index available` a `/query` gets — rather than `TARGET_INVALID`; the `$search is not available here` answer is for the searchable-column fallback and for tables with no search at all.

## Which rows

The target is resolved once ("phase 1") as

```
q (filter + $search) ∧ row overlay (transformOne) ∧ queryTargetScope(action) ∧ ¬exclude
```

`queryTargetScope(action)` is a protected hook on `AsDbReadableController` that defaults to `transformFilter({})`, the read scope of `/query`. It runs **as a read**: in a child of the action request whose controller method is `query`, after `prepareRequest({ endpoint: "query", controls, filter })` — so the overlay is the caller's READ scope even when the action request's own state (a permission layer's action grant) is wider, and a `prepareRequest` that refuses the read (403) refuses the query target. The target's `q` is validated in that same read (`validateControls`, the field and index gate, `hasField`, the `exclude` identifications), and its relational predicates take `transformRelationFilter` there — `filter` is the target's own, so a permission layer resolves the policy of the relations they touch exactly as on `/query`. Nothing it writes leaks back into the action request. So the target is "the rows the user could list that match the query" AND "the rows the action may run on" — a caller with an action grant but no read grant can still run the action on ids, never on "all matching". Override it to refuse query targets to a caller (throw an `HttpError`) or to narrow them differently:

```typescript
protected override queryTargetScope(action: string) {
  if (!canListIssues()) throw new HttpError(403); // no read grant → no "all matching"
  return super.queryTargetScope(action);
}
```

More matching rows than the cap (`min(queryTarget.maxRows, query.maxRows)`, and for materialized handlers also `maxIds`) → 400 `TARGET_TOO_LARGE` with `cap`. A count other than `expectCount` → 409 `TARGET_CHANGED` with the current `matched`.

## Consistency

The target is a **snapshot** of the ids matching at phase 1. Each row is checked again when it is processed: against the query (filter, search, overlay, `queryTargetScope`, `exclude`), the action's [`actionRowScope`](./actions#action-row-scope-candidates) (called per batch with `purpose: "execute"`) and `disabled`. The query check is skipped for the first batch (all rows of a `@DbActionIDs()` / `@DbActionRows()` handler), which runs right after the snapshot in the same request.

- A row that no longer matches the query is skipped as `"stale"` (from the second batch on).
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

A `@DbActionTarget()` handler that throws **after it received a batch** answers its partial summary instead of the bare error: `aborted: { status, message }`, the batch it was on in `failed` with the error's message (it may be half-applied), and every row not reached in `failed` as `"not run"`. Earlier batches stay counted in `processed`. An error before the first batch reached the handler — or before the handler started at all, such as an `@InputForm` 400 or a refusing interceptor — stays the request's error.

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

## From your own command — `resolveQuery` {#resolve-query}

Since 0.1.149. A command you wrote (an action on a ticket that attaches "every issue matching this search") often needs the rows of **another** table controller that match a client's query. `resolveQuery` returns them, resolved as that controller's read for the current caller:

```typescript
import { useControllerContext } from "moost";
import { Body, Post } from "@moostjs/event-http";
import type { AtscriptDbTable } from "@atscript/db";
import { DbAction, DbActionID, type TDbActionQueryTarget } from "@atscript/moost-db";

// In your ticket controller; `links` is the ticket-to-issue link table, `TicketIssueController` the issues controller.
declare const links: AtscriptDbTable;

@Post("actions/attach-matching")
@DbAction("attachMatching", { label: "Attach matching issues" })
async attachMatching(
  @DbActionID() ticket: { id: number },
  @Body() body: { input: { query: TDbActionQueryTarget } },
) {
  const issues = await useControllerContext().instantiate(TicketIssueController);
  const { dryRun, ...query } = body.input.query; // resolveQuery takes no dryRun
  return this.withTransaction(async () => {
    const rows = await issues.resolveQuery(query, {
      select: ["issueId"],
      scope: { ticketId: { $exists: false } },
    });
    if (dryRun) return { matched: rows.length };
    await links.insertMany(rows.map((r) => ({ ticketId: ticket.id, issueId: r.issueId })));
    return { attached: rows.length };
  });
}
```

```typescript
resolveQuery<K extends string = never>(
  q: TDbResolveQueryInput, // a `/query` string, or { q, exclude?, expectCount?, maxRows? }
  opts?: TDbResolveQueryOpts<K>, // { select?, cap?, scope? }
): Promise<Array<Pick<Data, K> & Record<string, unknown>>>
```

It is available on every table and view controller (not value-help controllers). Obtain the instance by injecting the controller class, or with `await useControllerContext().instantiate(Controller)` (use the latter for circular pairs); both give the registered singleton, bound to its table.

| Option   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select` | Fields to return besides the identity, gated by [`hasField`](./customization#hasfield) and the capability index like `/query` `$select`: a hidden, nonexistent, `@DbDecorations` or navigation path is `Unknown field` (400), a visible `@db.writeOnly` field a 400. An object parent expands to its visible leaves; write-only and hidden leaves never return (a parent with none is `Unknown field`). [`transformProjection`](./customization#transformprojection) is **not** applied to it — hide fields with `hasField`. |
| `cap`    | The most rows, default 1000. `q.maxRows` can only lower it. More rows → 400 `TARGET_TOO_LARGE` with `cap`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scope`  | A server-side restriction, ANDed in. It is trusted: not gated (it may name a hidden field) and not shown to `prepareRequest`.                                                                                                                                                                                                                                                                                                                                                                                                |

What it does, in order:

1. Parses `q` in the caller's event — a `dryRun` key is a 400 `TARGET_INVALID` (read it yourself, as above). Errors carry the calling action's name, or `""` from a plain route.
2. Runs as a **read** of the target, in a child of the current event: `prepareRequest({ endpoint: "query", controls, filter })` with the **client's** filter (not `scope`), then `validateControls`, the field / index / relational gate, `exclude` and the `select` gate — all under the read's `hasField`.
3. Applies the read overlay (`transformFilter`) and the [`$search` rule](#search). [`queryTargetScope`](#which-rows) is **not** called: it is a per-action hook and there is no action of that controller here.
4. Reads once: identity plus `select`, ordered by identity (`preferredId`, else the primary key), at most `cap + 1` rows, via native search when the table has it. The identity fields are always returned, even when `hasField` hides them from the reader (they address rows; they are not a way to read other columns). A readable with no identity (an aggregate view) is ordered by `select` instead, and each of those fields must be sortable like a `$sort` — otherwise 400 `TARGET_INVALID`. `expectCount` other than the match count → 409 `TARGET_CHANGED` with `matched`.

The errors are the ones a query target answers (`ActionTargetError`, plus 403 from `prepareRequest` and the `Unknown field` 400), so a command forwarding a client's `{ query }` answers like any query target and the "select all matching → `expectCount` → 409 → refresh" flow works unchanged. A programmer error (bad `cap`, non-string `select` entry, a readable with no identity and no `select`) is a plain `Error`. Calling it outside a running event handler throws `[moost-db] resolveQuery must be awaited inside an event handler`.

**Authorization.** Route interceptors and guards on the target's `query` route do **not** run — the call never goes through HTTP. Read authorization belongs in [`prepareRequest`](./permissions) (an aooth-style permission layer does this), which does run. The calling command's own route guards protect the call itself. The read runs with the current event's identity.

**Route params.** The target's read hooks (`prepareRequest`, `transformFilter`, …; `resolveQuery` never calls `queryTargetScope`) see **no** route params of the calling route: the child carries an empty set, so a hook written like the [multi-tenant recipe](./customization#multi-tenant) fails closed (400) when the param is missing. Only a call made from the routed event's own controller instance (a custom route of that very controller) keeps its params; a call from another controller, or from a [`@DbActionsFrom`](./view-actions) source hook running for a view's action, gets none. Pass route-derived restrictions as `scope` — a hook that treats a missing param as "unrestricted" is an app bug.

**Transactions.** `resolveQuery` never opens a transaction and takes no row locks. Awaited inside the caller's `withTransaction` callback it reads **in that transaction** (it sees the transaction's own uncommitted writes) when both tables share the adapter owner: the same `DbSpace` driver for SQLite / PostgreSQL / MySQL, the same client (and a replica set) for MongoDB. The memory adapter has no transactions and reads live state. The adapter's isolation level applies; a native search the engine refuses inside a transaction (Atlas `$search`) surfaces as its `DbError`.

### DOs and DON'Ts

- **Don't** put client input into `scope` field names — it is trusted, not gated, and can only narrow the read.
- **Don't** call it after the handler returned (a detached promise, a timer, a queue): the event is gone.
- **Don't** read the target's table directly instead — that skips the user's read policy.
- **Don't** expect `$sort`, `$limit`, `$select`, `$with` or `$vector` in `q`; this is a query target, not `/query` in-process.

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
- [Customization](./customization) — `transformFilter`, `hasField`, multi-tenant hooks
