import {
  normalizeForType,
  typeHasNormalizers,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeArray,
} from "@atscript/typescript/utils";
import type { FilterExpr } from "@uniqu/core";

import { isPlainObject, mapItems } from "../shared/object";
import type { TableMetadata } from "../table/table-metadata";

/**
 * Marks a filter the database layer builds from STORED values (relation
 * loading, cascade child filters, a row pinned by its stored primary key):
 * {@link normalizeFilterEquality} leaves it, and every condition inside it,
 * as it is — a stored value is compared as stored, so a row written before
 * its field gained `@normalize.*` is still found by the rows that reference
 * it. Marked by identity: wrap it (`{ $and: [marked, other] }`), never copy it.
 */
export function storedValuesFilter<F extends object>(filter: F): F {
  STORED_VALUES.add(filter);
  return filter;
}

const STORED_VALUES = new WeakSet<object>();

/**
 * Equality lookups on a field with `@normalize.*`: the operands of implicit equality, `$eq`, `$ne`, `$in` and `$nin` get the
 * field's normalizers, so `{ email: " Ann@X.io" }` finds the stored
 * `"ann@x.io"` — the form every write stores. Array fields normalize an
 * element operand by their element type.
 *
 * Never touched: `$regex` (and a bare `RegExp`), range operators, `$exists`,
 * `$search` / fulltext and every other operator, relational predicates (the
 * related table normalizes its own operand when it translates it), and keys
 * of other tables. Callers leave `$having` and aggregate conditions out.
 * Pure, copy-on-change; a table without normalizers returns `filter` at once.
 */
export function normalizeFilterEquality(filter: FilterExpr, meta: TableMetadata): FilterExpr {
  const root = meta.rootType;
  if (!root || !typeHasNormalizers(root)) return filter;
  return walk(filter, meta);
}

function walk(filter: FilterExpr, meta: TableMetadata): FilterExpr {
  if (!isPlainObject(filter) || STORED_VALUES.has(filter)) return filter;
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(filter)) {
    const value = (filter as Record<string, unknown>)[key];
    let next = value;
    if (key === "$and" || key === "$or" || key === "$nor") {
      if (Array.isArray(value)) next = mapItems(value, (f) => walk(f as FilterExpr, meta));
    } else if (key === "$not") {
      next = walk(value as FilterExpr, meta);
    } else if (!key.startsWith("$") && !meta.navFields.has(key)) {
      const def = meta.flatMap.get(key);
      if (def && typeHasNormalizers(def)) next = normalizeCondition(def, value);
    }
    if (next !== value) {
      out ??= { ...(filter as Record<string, unknown>) };
      out[key] = next;
    }
  }
  return (out ?? filter) as FilterExpr;
}

/** A field's condition: an operator object, or a value compared for equality. */
function normalizeCondition(def: TAtscriptAnnotatedType, value: unknown): unknown {
  if (!isPlainObject(value)) return normalizeOperand(def, value);
  const ops = Object.keys(value);
  if (!ops.some((k) => k.startsWith("$"))) return normalizeOperand(def, value);
  let out: Record<string, unknown> | undefined;
  for (const op of ops) {
    const operand = value[op];
    let next = operand;
    if (op === "$eq" || op === "$ne") {
      next = normalizeOperand(def, operand);
    } else if ((op === "$in" || op === "$nin") && Array.isArray(operand)) {
      next = mapItems(operand, (v) => normalizeOperand(def, v));
    }
    if (next !== operand) {
      out ??= { ...value };
      out[op] = next;
    }
  }
  return out ?? value;
}

/** One equality operand of field `def` (an array field's element operand by its element type). */
function normalizeOperand(def: TAtscriptAnnotatedType, operand: unknown): unknown {
  if (operand === null || operand === undefined || operand instanceof RegExp) return operand;
  if (def.type.kind === "array" && !Array.isArray(operand)) {
    return normalizeForType((def.type as TAtscriptTypeArray).of, operand);
  }
  return normalizeForType(def, operand);
}
