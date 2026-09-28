---
outline: deep
---

# Upgrading

Changes that need action or attention when you upgrade. Each entry links to the page that documents the current behavior.

## 0.1.137 {#v0-1-137}

### MongoDB

- **A `@db.column` on a nested field is ignored on MongoDB.** Documents rename top-level keys only, and the nested field was always written at its logical path (`address.zip`), but filters, `$sort`, `$groupBy`, indexes and view pipelines addressed the `@db.column` name as a top-level key (`zip_code`) — they matched nothing, sorted by nothing, and views read an empty column. Every path now uses `address.zip`, so these queries return rows for the first time. Stored data needs no migration. SQL adapters are unchanged (`address__zip_code`) — see [MongoDB → Renamed Fields](/adapters/mongodb#renamed-fields).
- **The first sync after the upgrade reports such a field once** as added (`address.zip`) and its old name (`zip_code`) as removed, and recreates an index declared on it on the stored path. Outside `--safe` mode the removal unsets a top-level `zip_code` key — only an `updateMany` merge patch on 0.1.136 could have written one.
- **Sync safety fix: the default backfill no longer overwrites stored values.** Adding a field with a literal `@db.default` used to write the default into every document; it now fills only documents that don't hold the field — which also keeps the stored `address.zip` values above intact. See [What gets synced → Add](/sync/what-gets-synced#add).
- **Every managed MongoDB view is recreated once** on the first sync after the upgrade (`plan()` / `--dry-run` shows each as an alter), so existing views pick up the fixes below. Views are metadata-only on MongoDB — no data is copied. External views are untouched.
- **Fields under a renamed top-level object resolve to their stored path everywhere.** For `profile.bio` under `@db.column 'prof'`: an index declared on it now covers `prof.bio` — the first sync recreates it (before, it indexed the non-existent `profile.bio`); `updateMany` merge patches write `prof.bio`; and `$inc` / `$mul` on a renamed field update its `@db.column` key (before, both wrote a stray key under the logical name). The first sync also reports `prof.bio` added and `profile.bio` removed once — the removal unsets a path that holds no data, and the backfill never overwrites `prof.bio`.
- **View filters with a field-to-field comparison may return fewer rows.** `` `Item.qty > Item.cap` `` in `@db.view.filter` / `@db.view.having` used to match documents where either field is null or missing (a missing value compares below every number); it now excludes them, as on SQL — see [MongoDB → Views](/adapters/mongodb#views). Add an explicit `or Item.cap not exists` where you relied on the old result.

### Memory

- **Sync fix: a model removed from the schema is really dropped.** Sync reported the table as `drop` but kept its rows, and a model added back was reported `in-sync` and served them again. The table's rows, unique indexes and increment counter are now deleted; added back, it is reported `create` and starts empty, as on SQL. Removed views are dropped too. See [Memory → Schema Sync](/adapters/memory#schema-sync).
- **Tables are keyed by name within a `DbSpace`.** Two compiled types that name the same table now share its rows, as on a real database; before, each type had its own store. A new space still starts empty.

### PostgreSQL

- **Sync fix: `@db.sync.method 'recreate'` handles a required column's type change.** The copy step failed with `invalid input syntax for type double precision: ""` (number → string), so the table could never be recreated. Changed columns are now converted to their new type the way an in-place type change converts them. A value that does not convert fails the sync inside the transaction, and the table keeps its rows. See [PostgreSQL → Column Type Changes](/adapters/postgresql#column-type-changes).
- **Shrinking a `VARCHAR` / `CHAR` column fails instead of truncating.** Lowering `@expect.maxLength` below a stored value used to cut the value silently; the sync now fails with `value too long for type character varying(n)`. Shorten the data first.

### Custom adapters

- **New optional capability [`viewRenderRevision()`](/adapters/creating-adapters#view-render-revision)** — bump it to have sync recreate your adapter's managed views once.
- **A missing drop primitive is an error, not a silent skip.** [`dropTableByName`](/adapters/creating-adapters#droptablebyname-name) and `dropViewByName` are no longer optional: the `BaseDbAdapter` defaults throw `… is not supported by this adapter`. Before, `DbSpace` skipped the drop when the adapter lacked the method, and sync reported the table or view dropped. Sync now reports it as an `error` entry and keeps it tracked. All built-in adapters implement both.
- **New hook [`registerSpace(space)`](/adapters/creating-adapters#register-space).** `DbSpace` calls it on every adapter it builds. It does nothing by default; override it to share state across a space's adapters.

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
