# Improvement proposals — from the rvmode 0.1.116 → 0.1.122 migration (2026-07-17)

Context: the downstream rvmode repo executed the full migration to the new train (token-bound
controllers, generated manifest, `@InputForm` server validation, the ObjectId hex↔native
mapping — which let it delete its whole coercion workaround layer; the earlier `ACTIONS.md`
report is resolved). These are the gaps that REMAINED after the migration — each one is a
place where the downstream code still carries a workaround or an idiom the framework could
absorb. Ordered by value. Report/proposal only — no source changes made.

---

## 1. Write-capable table accessor on readable controllers

**Gap:** `AsDbReadableController` exposes `protected readable: AtscriptDbReadable<T>` —
a read-only surface. But the _canonical_ use of a readable controller is "pipeline-written
rows + a few named `@DbAction` mutations" (no generic CRUD), and those action handlers need
to WRITE. `AtscriptDbTable`'s write methods are unreachable through the base, so every such
controller keeps a module-scope `db.getTable(Model)` (plus, typically, `as unknown as
NarrowView` casts for db-decoupled cores) purely to regain write access:

```ts
// downstream, after full token-binding adoption — these consts exist ONLY because
// this.readable can't write (5 controllers: leads, lead-deliveries, email-suppressions,
// wf-states, openai-batches):
const leadDeliveriesTable = db.getTable(LeadDelivery);
const replayView = leadDeliveriesTable as unknown as ReplayDeliveriesView;
```

Token binding removed the _binding_ coupling to the DbSpace module; this is the last thing
keeping controller modules import-coupled to it.

**Proposal:** when the bound readable is in fact a table, expose it:

```ts
/** The bound readable as a writable table; throws for views. */
protected get table(): AtscriptDbTable<T>
```

on `AsDbReadableController` (the writable `AsDbController` already has exactly this getter —
it just isn't shared down). A runtime `instanceof AtscriptDbTable` check with a clear throw
for views keeps it honest. With it, the downstream consts (and their import of the DbSpace
module) all disappear.

## 2. `/meta` + db-client: write-only field descriptors (the encrypted-credentials blocker)

**Gap:** db-client builds its client-side preflight validator from the server-served
`/meta` type. When an ARBAC overlay projects fields by READ scope, write-only fields —
the classic case is `@db.encrypted` secrets that are deliberately never readable
(downstream: `dealer.credit.credentials`, `feedSource.auth`) — are absent from the served
type entirely. Result, live-caught: a legitimate PATCH carrying such a field is rejected
**client-side** with `Unexpected property` before the request is ever sent, while the same
payload posted directly returns 202 and validates fine against the full server-side type.
The downstream project had to route around its own generic form (a dedicated
set-credentials action is now planned) purely because the wire contract cannot express
"you may write this field but never read it".

**Proposal:** let `/meta` carry write-only field descriptors:

- serialization: include fields with `writeOnly: true` (their TYPE only — never values;
  they stay excluded from projections, rows, and `$select`),
- the ARBAC overlay keys their presence off the caller's WRITE scopes instead of the read
  projection,
- db-client's validator accepts `writeOnly` fields in insert/update payloads and never
  expects them in responses.

This makes sealed/secret fields first-class in generic forms instead of forcing every
consumer into bespoke actions. (The same contract likely benefits `AsForm` rendering —
a `writeOnly` field renders as a set-only input with no current value.)

## 3. `assertExposed` is a no-op for decorator-prefix-bound models

**Gap:** `assertExposed(app, models)` only warns for models annotated `@db.http.path`.
A repo that mounts everything through decorator prefixes (`@TableController(Model,
'db/x')`) — arguably the mainstream pattern after token binding — gets zero coverage; the
downstream migration evaluated the helper and skipped it as dead weight for exactly this
reason. That leaves the generated manifest guarding _sync_ completeness but nothing
guarding _exposure_ completeness.

**Proposal:** an opt-in mode that audits the whole passed list:

```ts
assertExposed(app, atscriptModels, {
  all: true, // any @db.table/@db.view with no bound controller warns
  exclude: [EmbeddingCache, CreditReportRow], // deliberately internal collections
});
```

The binding metadata needed for the check already exists (`TReadableBindingMeta.model`
feeds the current implementation); this only widens which models are candidates. The
explicit `exclude` list turns "internal on purpose" into greppable code instead of silence.

## 4. Declarative `$search` fields on readable controllers

**Gap:** every grid with a search box, where adapter-native search isn't configured (the
db-memory adapter always; Mongo without Atlas Search indexes), repeats the same override:

```ts
protected async transformFilter(filter?: Record<string, unknown>) {
  return withSearchFilter(await super.transformFilter(filter), this.searchFields)
  // …where withSearchFilter merges { $or: fields.map(f => ({ [f]: { $regex, $options: 'i' } })) }
}
```

The downstream repo hand-rolls this in 4+ controllers plus a shared helper — it's pure
boilerplate encoding one decision: _which fields participate in `$search`_.

**Proposal:** make that decision declarative:

```ts
@ReadableController(Job, { prefix: 'db/jobs', searchFields: ['jobName', 'label', 'description'] })
```

(or a `@db.search.fields` model annotation). The base maps `$search` to the case-insensitive
`$or`/`$regex` fallback — or to adapter-native search where the adapter reports the
capability — and `transformFilter` overrides stay for genuinely custom policy only.
Escaping (`escapeRegExp`) belongs in the framework implementation; hand-rolled versions of
this idiom are exactly where unescaped-regex injection slips in.

---

_Not proposed here:_ nothing new for wooks (0.7.21's Response-header forwarding closed the
one open report) or moost (the `{ prefix, controllers, mode }` group registration covered
the registration repetition; the new DI/inheritance diagnostics all verified clean
downstream).
