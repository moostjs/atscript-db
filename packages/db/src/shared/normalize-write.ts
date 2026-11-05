import {
  normalizeForType,
  typeHasNormalizers,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeArray,
  type TAtscriptTypeObject,
  type TValidatorOptions,
} from "@atscript/typescript/utils";

import { isPatchOperatorObject } from "../db-validator-plugin";
import { getDbFieldOp } from "../ops";
import type { ValidatorMode } from "../validator";
import { isPlainObject, mapItems } from "./object";

/**
 * A write payload (one row) with its type's `@normalize.*` applied, the way a
 * write in `mode` reads it — what the write paths store and what
 * `@atscript/db-client` sends.
 *
 * - `insert` / `replace`: the row is a value of `type` — `normalizeForType`.
 * - `patch`: plain values are normalized against their field, nested objects
 *   field by field, array-operator items (the `$update` / `$remove` keys
 *   included) as items, a `@db.rel.to` object and relation `$update` /
 *   `$upsert` / `$remove` items as patches of the related rows; field ops
 *   (`$inc`, …) are left as they are.
 *
 * Pure and copy-on-change. `opts` are the validator options the result is
 * validated with (union branches are judged with them); pass the same object
 * every call (it keys a cache). Never validates.
 *
 * @since 0.1.170
 */
export function normalizeWritePayload<P>(
  type: TAtscriptAnnotatedType,
  payload: P,
  mode: ValidatorMode,
  opts?: Partial<TValidatorOptions>,
): P {
  if (mode !== "patch") return normalizeForType(type, payload, opts);
  if (!isPlainObject(payload) || type.type.kind !== "object" || !typeHasNormalizers(type)) {
    return payload;
  }
  return normalizePatchRow(
    type as TAtscriptAnnotatedType<TAtscriptTypeObject>,
    payload,
    opts,
    "",
  ) as P;
}

/**
 * {@link normalizeWritePayload}'s options for a value at `path` of the patch:
 * `normalizeForType` judges union branches with the value as their root, so
 * a path-aware `partial` is re-rooted at `path` — a field is judged as the
 * validator judges it there (strict below a non-merge field, partial below a
 * merge object or a relation), not as a partial root.
 */
const optionsByPath = new WeakMap<object, Map<string, Partial<TValidatorOptions>>>();

function optionsAt(
  opts: Partial<TValidatorOptions> | undefined,
  path: string,
): Partial<TValidatorOptions> | undefined {
  const partial = opts?.partial;
  if (!opts || !partial || partial === "deep") return opts;
  let byPath = optionsByPath.get(opts);
  if (!byPath) optionsByPath.set(opts, (byPath = new Map()));
  let out = byPath.get(path);
  if (!out) {
    // `true`: the payload's own object only
    const base = typeof partial === "function" ? partial : (_def: unknown, p: string) => p === "";
    out = { ...opts, partial: (def, p) => base(def, p ? `${path}.${p}` : path) };
    byPath.set(path, out);
  }
  return out;
}

/**
 * A patch of one row of object type `def` (see {@link normalizeWritePayload}),
 * at `path` of the payload (`""`: the payload itself).
 */
function normalizePatchRow(
  def: TAtscriptAnnotatedType<TAtscriptTypeObject>,
  row: Record<string, unknown>,
  opts: Partial<TValidatorOptions> | undefined,
  path: string,
): Record<string, unknown> {
  const type = def.type;
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(row)) {
    let prop = type.props.get(key);
    // (a pattern prop's key is input: its path segment is the pattern's, to bound the cache)
    let segment = key;
    if (!prop) {
      const pattern = type.propsPatterns.find((p) => p.pattern.test(key));
      if (!pattern) continue;
      prop = pattern.def;
      segment = `/${pattern.pattern.source}/`;
    }
    // (nothing below can change — its path and options are never built)
    if (!typeHasNormalizers(prop)) continue;
    const value = row[key];
    const next = normalizePatchValue(prop, value, opts, path ? `${path}.${segment}` : segment);
    // (`{ ...row }` copies a `__proto__` key as an own property: assigning it never sets the prototype)
    if (next !== value) (out ??= { ...row })[key] = next;
  }
  return out ?? row;
}

/** One patch value of field `prop`, at `path` of the payload. */
function normalizePatchValue(
  prop: TAtscriptAnnotatedType,
  value: unknown,
  opts: Partial<TValidatorOptions> | undefined,
  path: string,
): unknown {
  if (value === undefined || value === null || getDbFieldOp(value)) return value;
  const meta = prop.metadata;
  const kind = prop.type.kind;
  const relation = meta.has("db.rel.from") || meta.has("db.rel.via");
  if (kind === "array" && (relation || !meta.has("db.json")) && isPatchOperatorObject(value)) {
    return normalizeArrayOps(
      prop as TAtscriptAnnotatedType<TAtscriptTypeArray>,
      value,
      opts,
      path,
      relation,
    );
  }
  if (!relation && kind === "object" && isPlainObject(value) && !meta.has("db.json")) {
    // a nested object, or a `@db.rel.to` row patched in place: field by field
    return normalizePatchRow(
      prop as TAtscriptAnnotatedType<TAtscriptTypeObject>,
      value,
      opts,
      path,
    );
  }
  return normalizeForType(prop, value, optionsAt(opts, path));
}

/**
 * The operands of an array patch on field `prop`: whole items for `$replace`
 * / `$insert` (and an embedded array's `$upsert`); for `$update` / `$remove`
 * (and a relation's `$upsert`) each item — a relation's object items as
 * patches of the related rows.
 */
function normalizeArrayOps(
  prop: TAtscriptAnnotatedType<TAtscriptTypeArray>,
  ops: Record<string, unknown>,
  opts: Partial<TValidatorOptions> | undefined,
  path: string,
  relation: boolean,
): Record<string, unknown> {
  const element = prop.type.of;
  const rowPatch = relation && element.type.kind === "object";
  const here = optionsAt(opts, path);
  let out: Record<string, unknown> | undefined;
  for (const op of Object.keys(ops)) {
    const items = ops[op];
    let next: unknown;
    if (op === "$replace" || op === "$insert" || (op === "$upsert" && !relation)) {
      next = normalizeForType(prop, items, here);
    } else if (Array.isArray(items)) {
      next = mapItems(items, (item) =>
        rowPatch && isPlainObject(item)
          ? normalizePatchRow(
              element as TAtscriptAnnotatedType<TAtscriptTypeObject>,
              item,
              opts,
              path,
            )
          : normalizeForType(element, item, here),
      );
    } else {
      continue;
    }
    if (next !== items) (out ??= { ...ops })[op] = next;
  }
  return out ?? ops;
}
