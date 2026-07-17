---
outline: deep
---

# Model Manifest

<!--@include: ../_experimental-warning.md-->

Adding a model to your project requires remembering to add it to the sync list — a forgotten entry means silently missing tables and indexes. The **generated model manifest** removes that failure mode: `dbPlugin({ manifest })` makes every full build emit an inventory module of all exported `@db.table` / `@db.view` entities, so startup code consumes a list that can never be out of date.

```ts
// atscript.config.mts
import { defineConfig } from "@atscript/core";
import ts from "@atscript/typescript";
import { dbPlugin } from "@atscript/db/plugin";

export default defineConfig({
  rootDir: "src",
  // Path is rootDir-relative → emits src/atscript.models.ts
  plugins: [ts(), dbPlugin({ manifest: "atscript.models.ts" })],
  format: "dts",
});
```

```ts
// startup
import { atscriptModels } from "./atscript.models";
import { syncSchema } from "@atscript/db/sync";

await syncSchema(db, atscriptModels); // instead of a hand-maintained import array
```

## Generated exports

The manifest lists each model exactly once and derives the aggregates:

```ts
export const dbTables = [User, Post] as const;
export const dbViews = [ActiveUsers] as const;
/** Every @db.table / @db.view model in this project. */
export const atscriptModels = [...dbTables, ...dbViews] as const;
/** Models grouped by @db.space (absent annotation → "default"). */
export const modelsBySpace = {
  default: atscriptModels,
} as const;
```

Selection rule: every export carrying `@db.table` or `@db.view` metadata — the same rule the [`asc db sync` CLI](./cli) uses for discovery. Colliding export names across `.as` files are alias-deduplicated in the imports (`import { User as User_1 } from …`).

## The manifest is an inventory, not an action

Nothing syncs automatically — you pass the arrays to [`syncSchema`](./programmatic) yourself, so full control stays at the call site:

- **Exclude**: `syncSchema(db, atscriptModels.filter(m => m !== LegacyTable))` — an intentional exclusion is a visible, greppable filter, while doing nothing safely defaults to "synced".
- **Extend**: models from external npm packages are outside your project's `.as` build — append them: `syncSchema(db, [...atscriptModels, AsPresetEntry])`.

## Multi-database apps: `@db.space`

`@db.space "analytics"` on a model (interface-level, sibling of `@db.schema`) assigns it to a named space. Absent → `"default"`. The manifest groups by it, so a mixed Mongo + Postgres startup is mechanical:

```ts
await syncSchema(mongo, modelsBySpace.default);
await syncSchema(pg, modelsBySpace.analytics);
```

The same annotation drives [token-based controller binding](../http/) in `@atscript/moost-db`: `@TableController(Model)` resolves the named space from the ambient registry automatically. Moving a model between databases is a one-annotation change.

## Guarding exposure completeness: `assertExposed`

The manifest guards _sync_ completeness; `assertExposed` (from `@atscript/moost-db`) guards _exposure_ completeness with the same input. After `app.init()`:

```ts
const missing = assertExposed(app, atscriptModels); // default: audits @db.http.path models only
// Prefix-bound repos (@TableController(Model, 'db/x') everywhere):
const missing = assertExposed(app, atscriptModels, {
  all: true, // every passed model must have a bound controller
  exclude: [EmbeddingCache], // internal-on-purpose collections, greppable
});
if (missing.length && process.env.CI) throw new Error("unexposed models");
```

Lazy-factory bindings can't name their model and will false-positive under `all: true` — list them in `exclude`.

## DOs and DON'Ts

- **DO** commit the generated file — it is imported by your startup code and regenerates on every full build (`npx asc -f dts`).
- **DON'T** hand-edit it; edits are overwritten on the next build.
- **DO** remember the `manifest` path resolves relative to the config's `rootDir`, **not** the package root — with `rootDir: "src"`, `"atscript.models.ts"` emits `src/atscript.models.ts` (a `src/` prefix would emit `src/src/…`).
- **DON'T** worry about narrowed special-purpose builds (like the `asc db sync` temp compile) — manifest generation only runs for full `dts`/default-format builds, so they never shrink a committed manifest.

## See also

- [Programmatic API](./programmatic) — `syncSchema`, `planSchema`, sync options
- [CLI](./cli) — `asc db sync` and its discovery rules
- [Annotations Reference](../adapters/annotations) — `@db.table`, `@db.view`, `@db.space`
