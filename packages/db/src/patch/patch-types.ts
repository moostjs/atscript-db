import type { TAtscriptAnnotatedType, TAtscriptTypeArray } from "@atscript/typescript/utils";

// ── Generic building block for one array field ──────────────────────────────

export interface TArrayPatch<A extends readonly unknown[]> {
  $replace?: A;
  $insert?: A;
  $upsert?: A;
  $update?: Array<Partial<TArrayElement<A>>>;
  $remove?: Array<Partial<TArrayElement<A>>>;
}

type TArrayElement<ArrayType extends readonly unknown[]> =
  ArrayType extends ReadonlyArray<infer ElementType> ? ElementType : never;

/**
 * Maps each property of T into a patch payload:
 * - Array properties become `TArrayPatch<T[K]>`
 * - Non-array properties become `Partial<T[K]>`
 */
export type TDbPatch<T> = {
  [K in keyof T]?: T[K] extends Array<infer _> ? TArrayPatch<T[K]> : Partial<T[K]>;
};

/**
 * Extracts `@expect.array.key` properties from an array-of-objects type.
 * These keys uniquely identify an element inside the array and are used
 * for `$update`, `$remove`, and `$upsert` operations.
 *
 * @param def - Atscript array type definition.
 * @returns Set of property names marked as keys; empty set if none.
 */
export function getKeyProps(def: TAtscriptAnnotatedType<TAtscriptTypeArray>): Set<string> {
  if (def.type.of.type.kind === "object") {
    const objType = def.type.of.type;
    const keyProps = new Set<string>();
    for (const [key, val] of objType.props.entries()) {
      if (val.metadata.get("expect.array.key")) {
        keyProps.add(key);
      }
    }
    return keyProps;
  }
  return new Set<string>();
}
