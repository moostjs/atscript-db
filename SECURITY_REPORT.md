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

## 🟡 MEDIUM — Identifier strict-mode validator throw doesn't reach the global error interceptor (3c) — ROOT CAUSE LOCATED

**Discovered:** 2026-05-07, atscript-ui batch L e2e (Scenario 20.17 — identifier strict-mode).

**Update 2026-05-07b** (after atscript-db agent's "doesn't reproduce in unit tests" report): the bug DOES reproduce in atscript-ui's demo, and the root cause is a **moost interceptor-registration ordering issue** that only surfaces when a `defineBeforeInterceptor` at priority `< CATCH_ERROR` throws. The agent's isolated unit tests don't reproduce because they don't reproduce moost-db's gate-interceptor path — which IS the throw site for action ID validation in production.

### What we ruled out

- ❌ **Class-identity divergence (off-tree hypothesis 1).** `pnpm -ls` against atscript-ui shows 10 separate `@atscript/typescript@0.1.50` copies under `node_modules/.pnpm/`, each with a different peer-deps suffix. But `readlink` on the actual `@atscript/typescript` symlinks reveals that both `@atscript/moost-db@0.1.68` AND `@atscript/moost-validator@0.1.50` resolve to the **same** copy (`_5f3340f540726e581b2ad93bb59f9692/node_modules/@atscript/typescript`). Same physical path → same module instance → same `ValidatorError` class identity → `instanceof ValidatorError` would correctly match.

- ❌ **auditInterceptor / latencyInterceptor swallow (off-tree hypothesis 2).** `auditInterceptor.error(err)` calls `void writeRows(...).catch(logAuditError)` and returns undefined — never calls `reply()`, so it can't preempt validationErrorTransform. `latencyInterceptor` is `defineBeforeInterceptor` (no `error` handler at all). Both ruled out.

### Actual root cause: moost registers `error`/`after` callbacks DURING the same loop that runs `before()`

Inspection of `moost@0.6.8/dist/index.mjs` reveals that `InterceptorHandler.before()` iterates handlers in priority-ascending order and calls `registerDef(def, entry, ci)` for each:

```js
// moost@0.6.8/dist/index.mjs — registerDef, line 540-554
registerDef(def, entry, ci) {
  if (def.after) (this.after ?? (this.after = [])).unshift({ name: entry.name, fn: def.after });
  if (def.error) (this.onError ?? (this.onError = [])).unshift({ name: entry.name, fn: def.error });
  if (def.before) {
    const result = ... def.before(this.getReplyFn());
    if (isThenable(result)) return result;  // ← async before's pending promise
  }
  return void 0;
}
```

`registerDef` is called per-handler within the iteration. If a `before()` handler at priority N throws, **only `error` callbacks from interceptors with priority ≤ N have been registered.** Interceptors with priority > N never get their `error` callbacks added to `this.onError`.

In atscript-ui's demo, the priorities at play are:

| interceptor                         | source                      | priority          | has `error`? |
| ----------------------------------- | --------------------------- | ----------------- | ------------ |
| `auditInterceptor`                  | demo                        | `BEFORE_ALL = 0`  | ✓            |
| `latencyInterceptor`                | demo                        | `BEFORE_ALL = 0`  | ✗            |
| `buildGateInterceptor` (per-action) | `@atscript/moost-db`        | `AFTER_GUARD = 3` | ✗            |
| `validationErrorTransform()`        | `@atscript/moost-validator` | `CATCH_ERROR = 5` | ✓            |

The gate-interceptor's `before` is `async () => { ... await ctx.get(dbActionIdsSlot); ... }`. When `dbActionIdsSlot`'s factory rejects (via `validateMultiId` throwing `ValidatorError`), the gate's `before` rejects.

**Iteration order:**

1. `auditInterceptor` (0) — registers `audit.error` to `this.onError`. ✓
2. `latencyInterceptor` (0) — runs `before`, no `error` registered.
3. **`buildGateInterceptor` (3) — runs `before`, throws `ValidatorError`.** Loop aborts.
4. `validationErrorTransform` (5) — **NEVER REACHED**, `error` callback NEVER registered.

`fireAfter(error)` then runs against `this.onError = [audit.error]` only. `audit.error` doesn't call `reply()`, so the response stays as the unhandled `ValidatorError`. wooks-http catches it as the route handler's last-chance fallback, logs `"Uncaught route handler exception"`, and returns HTTP 500.

### Direct evidence (atscript-ui server log during e2e Section 20.17)

```
[wooks-http] ■ Uncaught route handler exception: /api/db/tables/users/actions/suspend
Validation Error: [0]: Identifier fields must exactly match one of: [id], [username], [email]
    at validateMultiId (...moost-db/dist/index.mjs:2086:31)
    at resolveValidatedId (...moost-db/dist/index.mjs:2165:2)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
```

The `[wooks-http] ■ Uncaught route handler exception` line is the smoking gun — it's logged ONLY when no Moost interceptor catches the error. If `validationErrorTransform.error` had fired, this log line would be absent and the response would be HTTP 400.

### Why the agent's isolated tests don't reproduce

The agent built "the exact production-mirror scenario (bare controller without class-level `@UseValidationErrorTransform()`, only `validationErrorTransform()` registered globally)". But a **bare** controller doesn't include a `@DbActionRow*` / `@DbActionRows` parameter decorator, so `discoverActions` doesn't wire up the gate-interceptor. Without the gate, identifier validation runs during arg-resolve (`runPipes`) — which fires AFTER all `before` interceptors complete, so by the time the throw happens, all `error` callbacks (including validationErrorTransform's) are registered.

To reproduce in atscript-db's own test suite: declare an action that uses `@DbActionRows()` (or any decorator that triggers `buildGateInterceptor`), register `validationErrorTransform()` globally, POST a bad-shape `ids` payload, observe HTTP 500.

### Fix candidates (in order of preference)

1. **Two-pass interceptor lifecycle in moost** (correct fix, breaks no contracts): in `InterceptorHandler.before()`, split `registerDef` into two passes — first pass registers all `after`/`error` callbacks across all handlers, second pass runs `before()` calls in priority order. A throw in any `before()` then has the full set of `error` handlers available. Requires a moost release.

2. **Workaround in atscript-db**: bundle a `defineInterceptor({ error: transformValidationError }, BEFORE_ALL)` and register it via `Moost.applyGlobalInterceptors` from `AsDbController` / `AsDbReadableController` setup, so it sits at priority 0 and registers its `error` BEFORE any gate fires. This works without a moost change but means atscript-db ships its own ValidatorError envelope handling rather than relying on moost-validator's.

3. **Workaround in atscript-db**: move identifier shape validation OUT of the gate-interceptor's `before` and INTO a Moost pipe (`definePipeFn(..., TPipePriority.VALIDATE)`) attached to `@DbActionID*` / `@DbActionRow*` parameters. Pipes run during arg-resolve which is AFTER the before-interceptor loop completes — so validationErrorTransform's `error` would already be registered when the pipe throws. The gate-interceptor's `await ctx.get(dbActionIdsSlot)` would then re-read an already-validated value (slot caches the resolved value).

4. **Workaround in atscript-ui** (deferred): catch `ValidatorError` directly in `auditInterceptor.error` and call `reply(new HttpError(400, ...))`. Pollutes a fire-and-forget audit hook with general validator awareness, and only works because audit IS registered before the gate (priority 0 vs 3). Brittle to interceptor ordering changes.

**Recommended:** fix #1 in moost. It's a correctness improvement to the interceptor lifecycle that fixes this and any future class of "before-time throw at priority N misses error handler at priority > N" bugs.

**Atscript-ui workaround:** test 20.17 currently asserts status range `[400, 422, 500]` pending the upstream fix. Tighten to `toBe(400)` once one of the fixes lands.

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
