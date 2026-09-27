---
outline: deep
---

# Upgrading

Changes that need action or attention when you upgrade. Each entry links to the page that documents the current behavior.

## 0.1.136 {#v0-1-136}

### Managed views are recreated once

- **Every managed view is recreated on the first sync after the upgrade.** The view definition now includes each column's physical source and its aggregate, so every stored hash changes. `plan()` / `--dry-run` shows each view as an alter on that run. Plan for the costs listed in [What gets synced → Views](/sync/what-gets-synced#views).
- **MongoDB inner joins are now inner.** Before, every `@db.view.joins` kept unmatched documents on MongoDB (left-join behavior), while SQL adapters dropped them. Add `'left'` as the third argument where you relied on the old MongoDB behavior — see [Joins](/views/#joins).
- **Invalid view predicates fail at sync.** Join conditions and filters with `in`, `not in`, `exists` or `not exists` used to render wrong SQL silently; they now render correctly. `matches` in a view predicate on SQL, and any predicate that can't be rendered, now fails the sync instead of creating a broken view — see [View Filters](/views/#view-filters).
- **A view ref to a `@db.ignore` field or a navigation relation fails at sync** (`… has no column — "x" is @db.ignore or a navigation relation`) instead of producing a broken column.
- **View sync refuses aggregate functions the adapter doesn't declare.** A `@db.agg.*` field whose function is missing from the adapter's [`aggregateFns()`](/adapters/creating-adapters#aggregate-functions) fails the sync. Every built-in adapter declares all six functions; this affects custom adapters only.
- **MongoDB `@db.view.filter` / `@db.view.having` use query semantics.** `exists` now means "holds a value" (a stored `null` counts as absent) instead of key presence, `not exists` works, and `matches` accepts `/pattern/flags` — see [MongoDB → Views](/adapters/mongodb#views).

### Query results

- **MongoDB `count(field)` no longer counts documents where the field is missing** — it now matches SQL `COUNT(field)`, which counts only values that are present and not null. See [Aggregate functions](/api/aggregation#aggregate-functions).
- **The default aggregate alias over a `@db.column`-renamed field is the logical name.** `sum(amount)` over `@db.column 'amount_cents'` used to return `sum_amount_cents`, and a `$having` or `$sort` on `sum_amount` did not match it. It now returns `sum_amount` on every adapter. Update clients that read the physical-name key.

### Types and APIs

- **Compiled `db.agg.*` metadata is `{ field?, condition? }`.** It used to be a string (the field) or `true` (bare `@db.agg.count`). The runtime reads every shape, so models compiled by older versions keep working. Update any tooling that reads the metadata directly — see [Conditional Aggregates](/views/aggregations#conditional-aggregates).
- **`TDbAggregateFn` (`@atscript/db/agg`) includes `countDistinct`.** A `Record<TDbAggregateFn, …>` lookup table in your code needs a `countDistinct` entry.
- **`AGG_FN_SQL` (`@atscript/db-sql-tools`) is keyed by `Exclude<TDbAggregateFn, "countDistinct">`.** It still maps `sum`, `count`, `avg`, `min` and `max`, but indexing it with a plain `TDbAggregateFn` no longer type-checks. `countDistinct` has no function name to map — render it as `COUNT(DISTINCT x)` yourself.
- **`resolveCalendarBuckets` is deprecated.** Use `normalizeComputedSelect`, which has the same signature — see [Calendar buckets for adapter authors](/adapters/creating-adapters#calendar-buckets).
- **Class-level actions can declare an input form.** `@DbActions` / `@DbRowActions` / `@DbRowsActions` entries take `inputForm`: a compiled `.as` type, or `{ name, url }` for a form served by another controller. Any other shape is a type error; JavaScript callers that pass one get the entry dropped with a warning. See [Input forms on class-level entries](/http/actions#class-level-input-form).
