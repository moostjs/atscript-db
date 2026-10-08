import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

const KEY = "db.http.path";

/** The `@db.http.path` value a model carried before moost-db first wrote its published path. */
const designTime = new WeakMap<TAtscriptAnnotatedType, string | undefined>();

/**
 * Remembers the model's own `@db.http.path` (or its absence) before the first
 * published path is mirrored into its runtime metadata. Idempotent.
 *
 * @since 0.1.150
 */
export function captureDesignTime(type: TAtscriptAnnotatedType): void {
  if (!designTime.has(type)) {
    designTime.set(type, type.metadata.get(KEY) as string | undefined);
  }
}

/**
 * The route hint a model declares with `@db.http.path` — never the path
 * moost-db mirrored into the runtime metadata afterwards. Decorators and
 * `assertExposed` read this.
 *
 * @since 0.1.150
 */
export function designTimeHttpPath(type: TAtscriptAnnotatedType): string | undefined {
  return designTime.has(type)
    ? designTime.get(type)
    : (type.metadata.get(KEY) as string | undefined);
}

/** The captured design-time value (`undefined` when none was captured or declared). */
export function getDesignTime(type: TAtscriptAnnotatedType): string | undefined {
  return designTime.get(type);
}
