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

## ✅ RESOLVED (3a + 3b) — Validator-error envelope was HTTP 500 due to demo-side wiring; not an atscript-db bug

**Originally filed as one MEDIUM finding with three sub-cases (3a, 3b, 3c).** Re-investigation 2026-05-07 (after atscript-db agent's "doesn't reproduce" report) traced the actual cause of 3a + 3b to an atscript-ui demo-side wiring gap, not atscript-db. **3c is a separate, genuine atscript-db issue and remains open below.**

### Root cause (3a + 3b)

The atscript-ui demo applies `validatorPipe()` from `@atscript/moost-validator` globally:

```ts
// packages/vue-demo/src/server/main.ts (before fix)
app.applyGlobalInterceptors(auditInterceptor, latencyInterceptor);
app.applyGlobalPipes(validatorPipe());
```

`validatorPipe()` runs at `TPipePriority.VALIDATE` during arg-resolve. When it throws `ValidatorError`, the throw happens BEFORE the controller method body executes. The controller-level `@UseValidationErrorTransform()` (on `AsReadableController`) only catches errors thrown FROM controller method bodies — pipe-stage throws propagate past it and surface as generic HTTP 500.

The fix is to ALSO register `moost-validator`'s own `validationErrorTransform()` interceptor globally (it runs at `CATCH_ERROR` priority and DOES catch pipe-stage throws):

```ts
// after fix
import { validatorPipe, validationErrorTransform } from "@atscript/moost-validator";

app.applyGlobalInterceptors(validationErrorTransform(), auditInterceptor, latencyInterceptor);
app.applyGlobalPipes(validatorPipe());
```

### Verification

After the demo-side fix (committed in atscript-ui), direct curl probes return HTTP 400 with structured `_body`:

- 3a (`@db.json` inner-shape, `appConf.appearance: 'invalid'`) → 400 + `_body` array of nested validation errors ✓
- 3b (`@InputForm` payload, action `Suspend` with `reason: 42`) → 400 + `_body: [{ path: 'reason', message: 'Expected string, got number' }]` ✓

**No atscript-db change needed for 3a + 3b.** The atscript-db agent's regression tests (`packages/moost-db/src/__test__/validation-error-envelope.spec.ts`) at HEAD correctly verify the envelope contract — they pass because they exercise the full Moost pipeline including the global `validationErrorTransform()`. The atscript-ui demo was missing that registration.

---

## 🟡 MEDIUM — Identifier strict-mode validator throw doesn't reach the global error interceptor (3c)

**Discovered:** 2026-05-07, atscript-ui batch L e2e (Scenario 20.17 — identifier strict-mode).

**Originally part of finding 3 (3c). After demo-side fix above, 3a + 3b return 400; 3c still returns 500.** This is a genuine atscript-db issue — the identifier-validation throw mechanism differs from `validatorPipe()`'s.

**Symptom:** POST action `ids` payloads that violate moost-db invariant #11 (identifier shape must match exactly one PK or unique-index group):

```
{ ids: [{ username: "alice", "; DROP TABLE users; --": 1 }] }   # unknown field
{ ids: [{ id: 5, username: "alice" }] }                          # heterogeneous, no single match
{ ids: "alice" }                                                  # bare scalar
```

All return:

```json
{
  "statusCode": 500,
  "message": "[0]: Identifier fields must exactly match one of: [id], [username], [email]",
  "error": "Internal Server Error"
}
```

The message format with `[0]:` index prefix is a `ValidatorError` thrown from `validateMultiId` / `validateSingleId` in `packages/moost-db/src/actions/id-validation.ts`. It IS a `ValidatorError` (same class identity as 3a/3b — both bundles symlink to the same `@atscript/typescript@0.1.50` copy).

**The throw site differs from `validatorPipe()`.** The identifier validation runs from inside a `cached(...)` wook-slot resolved via `defineWook` (`dbActionIdsSlot`/`dbActionIdSlot` consumed by `useDbActionIds`/`useDbActionId`):

```ts
// packages/moost-db/src/actions/... (relevant excerpts)
async function resolveValidatedId(ctx, validate) {
  ...
  validate(env.ids, table);  // throws ValidatorError on bad shape
  return env.ids;
}
const dbActionIdsSlot = cached(async (ctx) => {
  return await resolveValidatedId(ctx, validateMultiId);
});
const useDbActionIds = defineWook((ctx) => ({ load: () => ctx.get(dbActionIdsSlot) }));
```

When this throw propagates up through Moost's resolver chain, it appears to bypass the global interceptor's `error` callback that `validatorPipe()` throws DO reach. atscript-ui's e2e test 20.17 catches this divergence — 3a/3b return 400, 3c still returns 500.

**Where it lives:** `@atscript/moost-db` — the `dbActionIdSlot`/`dbActionIdsSlot` resolution path, OR the `useDbActionId(s)` defineWook integration with Moost's pipe/interceptor stack.

**Fix candidates:**

- Wrap the slot's resolution in a try/catch that rethrows as an `HttpError(400)` at the throw site (cosmetic, but loses the structured `_body` shape).
- Move identifier validation INTO a Moost pipe (`definePipeFn(...)`) so it goes through the same machinery as `validatorPipe()` and reaches the global error interceptor.
- Investigate why `defineWook`-based resolver throws don't surface to global interceptors when `validatorPipe()` throws do.

**Fix-when:** convenient. The gate IS enforced (returns non-2xx, blocks the action). Only the envelope is wrong. atscript-ui's 20.17 test asserts a status range `[400, 422, 500]` pending this fix.

**Reproducer:** any moost-db controller with an action declared via `@DbActionIDs` / `@DbActionID`. POST an envelope where `ids` violates the strict-shape contract. Compare against a `validatorPipe`-stage throw on the same controller (e.g. `@InputForm` payload that's wrong type) — that one returns 400 correctly.

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
