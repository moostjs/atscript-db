import { selfOrAncestor } from "@atscript/db";
import type { TMetaResponse } from "@atscript/db";
import type { TAtscriptAnnotatedType, TSerializedAnnotatedType } from "@atscript/typescript/utils";

import type { TDbDecorationsMeta } from "./db-decorations.decorator";

/** A decoration key is a valid `$select` URL name: top-level, no `$` prefix, no dots. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What the declared decorations of one controller class are (validated). */
export interface TDecorationIndex {
  /** The declared interface. */
  readonly type: TAtscriptAnnotatedType;
  /** The decoration keys, in declaration order. */
  readonly keys: readonly string[];
  readonly keySet: ReadonlySet<string>;
  /** Decoration key → the readable's field paths it reads. */
  readonly requires: ReadonlyMap<string, readonly string[]>;
  /** Per class (and readable) state the planner fills: the serialized type, the visible `/meta` envelopes. */
  readonly memo: {
    serialized?: TSerializedAnnotatedType;
    /** `/meta` envelopes through the decoration step, per input (while visibility is not request-scoped). */
    meta: WeakMap<TMetaResponse, TMetaResponse>;
  };
}

/** The members of the bound readable the validation reads. */
export interface TDecorationSource {
  readonly flatMap?: ReadonlyMap<string, unknown>;
  readonly relations?: ReadonlyMap<string, unknown>;
  readonly navFields: ReadonlySet<string>;
  /** The readable's own (non-navigation) field paths. */
  readonly ownPaths: ReadonlySet<string>;
  readonly writeOnly: ReadonlySet<string>;
}

/**
 * Validates `@DbDecorations` metadata against the bound readable and indexes
 * it. Throws `[moost-db]` errors (once per class — the caller memoizes).
 */
export function buildDecorationIndex(
  controller: string,
  meta: TDbDecorationsMeta,
  source: TDecorationSource,
): TDecorationIndex {
  const fail = (message: string): never => {
    throw new Error(`[moost-db] ${controller}: @DbDecorations ${message}`);
  };
  const { type } = meta;
  if (type.type.kind !== "object") fail("expects an object interface");
  if (type.metadata.has("db.table") || type.metadata.has("db.view")) {
    fail("expects a plain interface — it must not carry @db.table or @db.view");
  }
  const props = (type.type as unknown as { props: ReadonlyMap<string, unknown> }).props;
  const keys = [...props.keys()];
  // Every field path and each of its ancestors: a key naming either collides.
  const fieldPaths = new Set<string>();
  for (const path of source.flatMap?.keys() ?? []) {
    for (let at = path.indexOf("."); ; at = path.indexOf(".", at + 1)) {
      fieldPaths.add(at < 0 ? path : path.slice(0, at));
      if (at < 0) break;
    }
  }
  const isField = (path: string): boolean => fieldPaths.has(path);
  for (const key of keys) {
    if (!KEY_RE.test(key)) {
      fail(`key "${key}" must be a plain top-level identifier (no "$" prefix, no dots)`);
    }
    if (isField(key) || source.relations?.has(key) || source.navFields.has(key)) {
      fail(`key "${key}" collides with a field or relation of the bound readable`);
    }
  }
  const requires = new Map<string, readonly string[]>();
  for (const key of keys) requires.set(key, []);
  for (const [key, paths] of Object.entries(meta.requires)) {
    if (!requires.has(key)) fail(`\`requires\` names "${key}", which is not a declared decoration`);
    for (const path of paths) {
      if (!source.ownPaths.has(path)) {
        fail(`"${key}" requires "${path}", which is not an own field of the bound readable`);
      }
      if (selfOrAncestor(path, source.writeOnly) !== undefined) {
        fail(`"${key}" requires "${path}", which is @db.writeOnly (a sealed value cannot be read)`);
      }
    }
    requires.set(key, [...new Set(paths)]);
  }
  return { type, keys, keySet: new Set(keys), requires, memo: { meta: new WeakMap() } };
}
