export { createDbValidatorPlugin } from "./db-validator-plugin";
export type { DbValidationContext } from "./db-validator-plugin";
export { isDbFieldOp } from "./ops";
export type { TDbFieldOp, TDbCas } from "./ops";
export { getKeyProps } from "./patch/patch-types";
export type { TArrayPatch, TDbPatch } from "./patch/patch-types";

// Re-export field & array op helpers (browser-safe convenience)
export { $inc, $dec, $mul, $cas, $replace, $insert, $upsert, $update, $remove } from "./ops";

import {
  flattenAnnotatedType,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeObject,
  type TValidatorPlugin,
  type Validator,
} from "@atscript/typescript/utils";

import { createDbValidatorPlugin } from "./db-validator-plugin";

/** Write operation mode for validator configuration. */
export type ValidatorMode = "insert" | "patch" | "replace";

/** Singleton db validator plugin — stateless, safe to share across all validators. */
export const dbPlugin = createDbValidatorPlugin();

/**
 * Builds a validator for a given write mode.
 *
 * Shared between server-side (`AtscriptDbTable`) and client-side (`ClientValidator`).
 * Both use the same plugin, same `replace`, same `partial` logic.
 *
 * @param type - The annotated type to validate against.
 * @param mode - The write operation mode.
 * @param extraPlugins - Additional adapter-specific plugins (prepended before the db plugin).
 * @param opts - `unknownProps` overrides the validator's unknown-property policy
 *   (used by db-client's `lenientWrites`, where the served type may be a
 *   projection of the full server-side type).
 */
export function buildDbValidator(
  type: TAtscriptAnnotatedType,
  mode: ValidatorMode,
  extraPlugins?: TValidatorPlugin[],
  opts?: { unknownProps?: "strip" | "ignore" | "error" },
): Validator<any> {
  const plugins = extraPlugins ? [...extraPlugins, dbPlugin] : [dbPlugin];
  return type.validator({
    plugins,
    partial: mode === "patch" ? buildPatchPartial(collectNavRoots(type)) : false,
    replace: forceNavNonOptional,
    ...(opts?.unknownProps ? { unknownProps: opts.unknownProps } : {}),
  });
}

/**
 * Path-aware `partial` callback for patch/update validation — the single
 * implementation shared by the server's `bulkUpdate` validator and the
 * client's patch preflight:
 *
 * - the root object is partial (a patch names only the fields it touches)
 * - nav-relation subtrees are partial (nested data is validated by its own table)
 * - `@db.patch.strategy "merge"` blocks are partial (the decomposer merges
 *   per leaf, so absent keys survive server-side by design)
 *
 * Every other nested object stays strict: non-merge blocks are `$set` as a
 * whole (replace semantics), so their required fields really are required.
 */
export function buildPatchPartial(
  navPaths: ReadonlySet<string>,
): (def: TAtscriptAnnotatedType<TAtscriptTypeObject>, path: string) => boolean {
  return (def, path) => {
    if (path === "") return true;
    const root = path.split(".")[0];
    if (navPaths.has(root)) return true;
    return def.metadata.get("db.patch.strategy") === "merge";
  };
}

/** Collects top-level nav-relation (TO/FROM/VIA) prop names from an object type. */
function collectNavRoots(type: TAtscriptAnnotatedType): ReadonlySet<string> {
  const roots = new Set<string>();
  if (type.type.kind === "object") {
    for (const [key, prop] of (type as TAtscriptAnnotatedType<TAtscriptTypeObject>).type.props) {
      if (isNavRelation(prop)) roots.add(key);
    }
  }
  return roots;
}

// ── Shared validator option helpers ─────────────────────────────────────────

/** Returns true if the annotated type is a navigation relation (TO/FROM/VIA). */
export function isNavRelation(type: TAtscriptAnnotatedType): boolean {
  return (
    !!type.metadata &&
    (type.metadata.has("db.rel.to") ||
      type.metadata.has("db.rel.from") ||
      type.metadata.has("db.rel.via"))
  );
}

/**
 * Forces nav fields non-optional so the plugin handles null/undefined checks.
 * The Validator caches replace results internally, so this allocates at most once per type node.
 */
export function forceNavNonOptional(type: TAtscriptAnnotatedType): TAtscriptAnnotatedType {
  if (!type.optional) return type;
  if (isNavRelation(type)) return { ...type, optional: false };
  return type;
}

// ── Validation context ──────────────────────────────────────────────────────

/** Result of {@link buildValidationContext}. */
export interface ValidationContext {
  /** Flat map of dotted field paths → annotated types (same shape the server builds). */
  flatMap: Map<string, TAtscriptAnnotatedType>;
  /** Set of field paths that are navigation relations (TO/FROM/VIA). */
  navFields: ReadonlySet<string>;
}

/**
 * Builds a lightweight validation context from a deserialized Atscript type.
 *
 * This is the client-side equivalent of the server's `TableMetadata.build()`,
 * without any adapter-specific processing (physical columns, index resolution, etc.).
 *
 * @param type - A deserialized annotated type (from `deserializeAnnotatedType(meta.type)`).
 * @returns `flatMap` and `navFields` suitable for passing to `createDbValidatorPlugin` via `DbValidationContext`.
 */
export function buildValidationContext(
  type: TAtscriptAnnotatedType<TAtscriptTypeObject>,
): ValidationContext {
  const navFields = new Set<string>();
  const flatMap = flattenAnnotatedType(type, {
    topLevelArrayTag: "db.__topLevelArray",
    onField: (path, _type, metadata) => {
      if (metadata.has("db.rel.to") || metadata.has("db.rel.from") || metadata.has("db.rel.via")) {
        navFields.add(path);
      }
    },
  });
  return { flatMap, navFields };
}
