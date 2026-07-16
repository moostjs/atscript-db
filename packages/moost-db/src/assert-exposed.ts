import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type { Moost } from "moost";

import { findReadableBinding } from "./decorators";

/** Minimal logger surface for {@link assertExposed}. */
export interface TAssertExposedOptions {
  logger?: { warn: (...args: unknown[]) => void };
}

/**
 * Dev-mode wiring assertion: warns for every model annotated with
 * `@db.http.path` that has no registered db controller.
 *
 * Call AFTER `await app.init()` (controller bindings are collected during
 * init). Detection reads the binding metadata written by `@TableController` /
 * `@ReadableController` / `@ViewController`, so it covers the model-token and
 * instance forms; lazy-factory bindings can't name their model until resolved
 * and are ignored.
 *
 * Returns the list of unexposed models so callers can escalate (e.g. throw in
 * CI):
 *
 * ```ts
 * await app.init()
 * const missing = assertExposed(app, atscriptModels)
 * if (missing.length && process.env.CI) throw new Error("unexposed models")
 * ```
 */
export function assertExposed(
  app: Moost,
  models: readonly TAtscriptAnnotatedType[],
  options?: TAssertExposedOptions,
): TAtscriptAnnotatedType[] {
  const logger = options?.logger ?? console;

  const exposed = new Set<TAtscriptAnnotatedType>();
  for (const overview of app.getControllersOverview()) {
    const model = findReadableBinding(overview.type as Function)?.model;
    if (model) {
      exposed.add(model);
    }
  }

  const missing: TAtscriptAnnotatedType[] = [];
  for (const model of models) {
    if (!model.metadata.has("db.http.path")) continue;
    if (exposed.has(model)) continue;
    missing.push(model);
    const path = model.metadata.get("db.http.path") as string;
    logger.warn(
      `[moost-db] Model "${(model as { id?: string }).id ?? path}" declares @db.http.path "${path}" ` +
        `but no registered controller is bound to it. Did you forget to register its controller?`,
    );
  }
  return missing;
}
