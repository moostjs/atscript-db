# Security Report — atscript-db

Findings discovered during atscript-ui Phase-2 e2e probes (Section 20 — framework rigidity / security, batch L). Each finding is a server-side gate that's either missing, weaker than documented, or returns the wrong response envelope. None of them have known active exploits in atscript-ui's demo, but they represent contract divergences worth closing.

Severity legend:

- **HIGH** — privacy / authorization leak with a clear exploit path
- **MEDIUM** — gate enforced but envelope wrong (cosmetic for clients but breaks structured-error contracts)
- **LOW** — gate works, only doc-vs-impl divergence

---

## 🚨 HIGH — `AsDbReadableController.getOne` bypasses the read-gate overlay

**Discovered:** 2026-05-07, atscript-ui batch L e2e (Scenario 20.6 — preset isolation).

**Symptom:** A `viewer` can fetch any other user's private preset by id via `GET /api/db/_presets/one/<uuid>?$select=id,user,label`. The presets controller's read-gate (`$or: [{ user: <self> }, { public: true, preset: true }]`) is wired into `transformFilter()` and applied to `/query` and `/pages` — but **NOT** to `/one/:id`. The latter inherits `AsDbReadableController.getOne` which calls `findById()` directly, skipping the overlay.

**Wire-shape leak:**

```
GET /api/db/_presets/one/<manager-private-preset-id>?$select=id,user,label
→ HTTP 200
→ { id: "<uuid>", user: "manager", label: "Manager view" }
```

(Default `?$select` with no narrow trips a separate downstream null-deref — `Cannot read properties of null (reading 'columns')` — which masks the leak unless the attacker passes a narrow projection.)

**Where it lives:** atscript-db's `@atscript/moost-db` package. The `AsDbReadableController.getOne` route handler does not pass `findById()` through the same `applyMetaOverlay` / `transformFilter` pipeline used by `/query` and `/pages`. Consumer controllers that override `transformFilter()` (e.g. `AsPresetsController`) silently lose the gate on `/one/:id`.

**Fix:** route `/one/:id` reads through `transformFilter()` like `/query` and `/pages`. Either always-applied at the base, or via a parallel `transformOne()` hook with the same default behaviour.

**Reproducer:** any `AsDbReadableController` subclass that overrides `transformFilter` to enforce row-level read isolation. Issue `GET /<table>/one/<id>?$select=...` for a row the caller's filter would normally hide. Compare against `/query` which correctly applies the overlay.

**Atscript-ui workaround:** test 20.6 verifies the leak via raw HTTP and is currently `test.skip(...)` pending this fix. See `tests/e2e/l-security/section-20-security.spec.ts` Scenario 20.6.

---

## 🟡 MEDIUM — `RelationalFieldMapper.reconstructNullParent` null-deref leaks as HTTP 500 on read-during-update

**Discovered:** 2026-05-07, atscript-ui batch L e2e (Scenario 20.7 — preset edit by non-owner).

**Originally filed as HIGH; downgraded after stack-trace analysis.** The `requireOwner` gate IS reached and rejects correctly when the read succeeds — there is no auth bypass. The 500 happens at the `findOne` step inside `processUpdateRow` BEFORE `requireOwner` runs, so a malicious viewer never reaches row data. It's a wrong envelope (500 instead of 403) caused by a missing null-guard in atscript-db's flattened-parent reconstruction loop.

**Symptom:** PATCH `/api/db/_presets` with `{ id: <existing-row-id>, data: {...} }` returns HTTP 500 with body:

```json
{
  "statusCode": 500,
  "message": "Cannot read properties of null (reading 'columns')",
  "error": "Internal Server Error"
}
```

**Stack trace from the live demo:**

```
TypeError: Cannot read properties of null (reading 'columns')
    at RelationalFieldMapper.reconstructNullParent
        (@atscript/db/dist/db-view-B89noqL9.mjs:708:28)
    at RelationalFieldMapper.reconstructFromRead
        (@atscript/db/dist/db-view-B89noqL9.mjs:850:56)
    at AtscriptDbTable.findOne
        (@atscript/db/dist/db-view-B89noqL9.mjs:1350:33)
    at async processUpdateRow
        (moost-ui-presets/dist/index.mjs:181:19)
```

**Note on grep-ability:** searching atscript-db source for the literal string `.columns` won't surface the bug — the `'columns'` in the error message is the runtime value of `lastPart` (the final segment of `parentPath.split('.')` for a path like `"data.content.columns"`). The actual fix-site has no literal `.columns` in source.

**Where it lives:** [`packages/db/src/strategies/field-mapping.ts:174`](https://github.com/[upstream]/atscript-db/blob/main/packages/db/src/strategies/field-mapping.ts#L174) — `FieldMappingStrategy.reconstructNullParent`. The walk-the-parent-path loop only guards `=== undefined`, not `=== null`:

```ts
protected reconstructNullParent(
  obj: Record<string, unknown>,
  parentPath: string,
  meta: TableMetadata,
): void {
  const parts = parentPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined) {     // ← misses null
      return;
    }
    current = current[parts[i]] as Record<string, unknown>;  // ← can become null
  }
  const lastPart = parts[parts.length - 1];
  const parentObj = current[lastPart];          // ← line 708 in bundled output: throws
  ...
}
```

When an intermediate segment of `parentPath` is `null` (rather than `undefined`), `current` becomes `null` on the next loop iteration, and the property access on the line after the loop (`current[lastPart]`) throws.

**One-line fix:** change the guard to cover both:

```ts
if (current[parts[i]] == null) return; // covers null AND undefined
```

**Why it surfaces on the e2e path but is hard to repro standalone:** The trigger condition is a flattened-parent map whose intermediate value is exactly `null` rather than `undefined` on a row read. In batch L, the test creates a preset, then PATCHes it as a different user — the `findOne` inside `processUpdateRow` triggers `reconstructFromRead` which iterates over `meta.flattenedParents` calling `reconstructNullParent`. Whichever preset/row state hits this is timing-dependent on prior tests in the suite. (Earlier reports of "curl returns 403, Playwright returns 500" likely reflect different test orderings, not different HTTP-client behavior.)

**Reproducer:** any `findOne` (or any read passing through `reconstructFromRead`) on a row whose flattened-parent chain has a `null` intermediate value. The presets table's `data: @db.json` carrying nested optional structures is one trigger.

**Atscript-ui workaround:** test 20.7 asserts a status range tolerant of both shapes (`[200, 403, 404, 500]`) with a comment documenting the wire-shape divergence pending this fix.

---

## 🟡 MEDIUM — Validator-error envelope is HTTP 500 instead of 400 on multiple paths

Three related symptoms with the same root cause: `ValidatorError` throws don't always reach the `validationErrorTransform` interceptor, so they bubble as generic 500.

### 3a. `@db.json` column inner-shape validation returns 500

**Discovered:** 2026-05-07, atscript-ui batch J e2e (Scenario 17.6 — `useAppPrefs` validator rejection).

**Symptom:** POST a payload that fails moost-validator on a `@db.json` column's inner shape (e.g. `data: { appearance: 'invalid' }` against an `AppConfData`-typed JSON column whose union doesn't include that string). Server responds:

```json
{
  "statusCode": 500,
  "message": "data: Value does not match any of the allowed types: [object(0)], [object(1)], [object(2)]",
  "error": "Internal Server Error"
}
```

The message is a real moost-validator throw — but it bubbles as 500, not the 400 that surface-level (top-level field) validation produces.

### 3b. Action `@InputForm` payload validation returns 500

**Discovered:** 2026-05-07, atscript-ui batch L e2e (Scenarios 20.4 + 20.17 — InputForm + identifier strict-mode).

**Symptom:** POST `/api/db/tables/users/actions/suspend` with an `input` payload that fails `SuspendUsersInput` schema validation:

```
POST { ids: [{username:"alice"}], input: { reason: 42 } }   # wrong type
POST { ids: [{username:"alice"}], input: { reason: "x" } }  # below @expect.minLength
POST { ids: [{username:"alice"}], input: { sneakyAdmin: true } }  # unknown field
```

All three return:

```json
{
  "statusCode": 500,
  "message": "<field>: <ValidatorError message>",
  "error": "Internal Server Error"
}
```

The `validationErrorTransform` interceptor (which maps `ValidatorError` → HTTP 400 with structured field-errors) lives on `AsReadableController` only. Action endpoints declared via `@Post("actions/<name>")` on subclasses inherit the class-level `@Inherit()` but the validator-pipe error appears to bubble past the catch interceptor.

### 3c. Identifier strict-mode rejection returns 500

**Discovered:** 2026-05-07, atscript-ui batch L e2e (Scenario 20.17 — identifier strict-mode).

**Symptom:** POST action `ids` payloads that violate moost-db invariant #11:

```
{ ids: { username: "alice", "; DROP TABLE users; --": 1 } }   # unknown field
{ ids: { id: 5, username: "alice" } }                          # heterogeneous, no single match
{ ids: "alice" }                                                # bare scalar
```

All return 500 with the validator's throw message instead of a structured 400.

### Common cause

`validationErrorTransform` registration scope. Outer-shape validation (top-level field constraints) hits the right pipe and returns 400. Inner JSON-column validation (3a), `@InputForm` payload validation (3b), and `ids` envelope validation (3c) all throw raw and get caught by the generic 500 fallback.

**Where it lives:** `@atscript/moost-db` — the `validationErrorTransform` interceptor's registration site, OR the validator-pipe's throw type coercion. Either:

- The interceptor registration needs to wrap a wider scope (action endpoints + JSON-column inner validation)
- The validator throw needs to be wrapped in a typed error class (`ValidationError`, not generic `Error`) earlier in the pipeline so the catch matches.

**Fix-when:** convenient. The gate IS enforced in all three cases — only the response envelope is wrong. atscript-ui tests use status-range tolerance pending fix.

**Reproducer:** any moost-db controller exposing an action with `@InputForm`, OR any controller with a `@db.json` column. Send a payload that violates the inner schema.

---

## 🟡 MEDIUM — `@db.json` column filter silently accepted instead of rejected

**Discovered:** 2026-05-07, atscript-ui batch L e2e (Scenario 20.19 — JSON-column server-side enforcement).

**Symptom:** `GET /api/db/tables/customers/pages?address=foo` returns HTTP 200 with an empty result set, even though `customers.address` is a `@db.json` column. The `/meta` response correctly advertises `filterable: false` for that field, but the `/pages` endpoint doesn't enforce the same constraint server-side.

**Wire-shape divergence:**

```
GET /api/db/tables/customers/meta
→ fields[address].filterable: false   ✓ correct

GET /api/db/tables/customers/pages?address=foo
→ HTTP 200 + { rows: [] }              ✗ should be 400
```

**Where it lives:** atscript-db `BaseDbAdapter`. The `canFilterField(fd)` veto is consulted when emitting `/meta` flags (so the client correctly hides filter UI), but the `/pages` request handler doesn't re-consult it before binding the filter parameter. The query is parameter-safe (no SQL injection vector), and the result is empty because no rows match the literal value against the JSON column's binary representation — but the contract divergence (`/meta` says `filterable: false` while `/pages` accepts the filter) breaks downstream consumers that mirror /meta to a security policy.

The default in `BaseDbAdapter.canFilterField` is `fd.storage !== 'json'` per atscript-db invariant #14 (per the skill docs). The veto is correctly applied to `/meta`. The gap is at request-time enforcement.

**Fix:** at the `/pages` request handler, walk the filter AST and reject any clause targeting a field where `canFilterField(fd) === false`. Same for `$sort` (which IS already enforced — verified in 20.19 sort sub-test).

**Note:** sort enforcement on `@db.json` columns IS working correctly. `GET /customers/pages?$sort=address:1` returns HTTP 400 as expected. The fix is symmetry — apply the same veto to filter clauses.

**Atscript-ui workaround:** test 20.19's filter sub-test is `test.skip(...)` pending this fix. The sort sub-tests are passing.

---

## Reproducer harness

All findings are reproducible against the atscript-ui demo at `:3200` with `DEMO_TEST_MODE=1`. The full e2e probe lives at:

`/Users/mavrik/code/atscript-ui/tests/e2e/l-security/section-20-security.spec.ts`

Scenario references inline above for each finding. Each `test.skip(...)` block carries a 1-2 line rationale referencing this report.

---

## Out-of-scope (not atscript-db concerns, tracked elsewhere)

- **Audit interceptor doesn't fire on gate-rejected actions.** The `auditInterceptor.error` hook isn't invoked when an `AFTER_GUARD`-priority interceptor throws. Fix: register audit at `BEFORE_ALL` priority — the interceptor stack mirrors at response/error time, so a `BEFORE_ALL` `before` handler gets its `error` callback fired even when later interceptors throw. Lives in atscript-ui's vue-demo.
- **`AsPresetsController.requireOwner` always returns 403, never 404.** Same response for non-existent and not-owned ids — actually doesn't leak existence (probe gives same 403 either way), so this is just a doc divergence, not a real privacy issue. Lives in atscript-ui's `@atscript/moost-ui-presets`.
