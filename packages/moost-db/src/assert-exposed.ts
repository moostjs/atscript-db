import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type { Moost } from "moost";

import { findReadableBinding } from "./decorators";

/** Options for {@link assertExposed}. */
export interface TAssertExposedOptions {
  logger?: { warn: (...args: unknown[]) => void };
  /**
   * Audit EVERY passed model, not only those annotated `@db.http.path`.
   * Use with a generated model manifest so exposure completeness is guarded
   * the same way sync completeness is. Deliberately-internal collections go
   * in {@link exclude}.
   */
  all?: boolean;
  /**
   * Models exempt from the audit (internal-on-purpose collections). Only
   * meaningful with {@link all} — the default `@db.http.path` mode is already
   * opt-in per model.
   */
  exclude?: readonly TAtscriptAnnotatedType[];
}

/**
 * Dev-mode wiring assertion: warns for every model that should have a
 * registered db controller but doesn't.
 *
 * Default mode audits models annotated with `@db.http.path`. With
 * `{ all: true }` every passed model is a candidate (minus `exclude`) — the
 * right mode for repos that mount everything through decorator prefixes
 * (`@TableController(Model, 'db/x')`) and keep a generated model manifest.
 *
 * Call AFTER `await app.init()` (controller bindings are collected during
 * init). Detection reads the binding metadata written by `@TableController` /
 * `@ReadableController` / `@ViewController`, so it covers the model-token and
 * instance forms; **lazy-factory bindings can't name their model until
 * resolved and are invisible to the check** — with `all: true` such models
 * will warn even though they are exposed; list them in `exclude`.
 *
 * Returns the list of unexposed models so callers can escalate (e.g. throw in
 * CI):
 *
 * ```ts
 * await app.init()
 * const missing = assertExposed(app, atscriptModels, {
 *   all: true,
 *   exclude: [EmbeddingCache], // internal on purpose
 * })
 * if (missing.length && process.env.CI) throw new Error("unexposed models")
 * ```
 */
export function assertExposed(
  app: Moost,
  models: readonly TAtscriptAnnotatedType[],
  options?: TAssertExposedOptions,
): TAtscriptAnnotatedType[] {
  const logger = options?.logger ?? console;
  const auditAll = options?.all === true;
  const excluded = new Set(options?.exclude ?? []);

  const exposed = new Set<TAtscriptAnnotatedType>();
  for (const overview of app.getControllersOverview()) {
    const model = findReadableBinding(overview.type as Function)?.model;
    if (model) {
      exposed.add(model);
    }
  }

  const missing: TAtscriptAnnotatedType[] = [];
  for (const model of models) {
    const httpPath = model.metadata.get("db.http.path") as string | undefined;
    if (!auditAll && httpPath === undefined) continue;
    if (excluded.has(model) || exposed.has(model)) continue;
    missing.push(model);
    const name = (model as { id?: string }).id ?? httpPath ?? "(unnamed model)";
    logger.warn(
      httpPath === undefined
        ? `[moost-db] Model "${name}" has no registered controller bound to it. ` +
            `Register its controller, or list it in assertExposed's \`exclude\` if it is internal on purpose.`
        : `[moost-db] Model "${name}" declares @db.http.path "${httpPath}" ` +
            `but no registered controller is bound to it. Did you forget to register its controller?`,
    );
  }
  return missing;
}
