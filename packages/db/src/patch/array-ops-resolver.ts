import type { TAtscriptAnnotatedType, TAtscriptTypeArray } from "@atscript/typescript/utils";

import { getPath, stableJson } from "../shared/object";
import type { AtscriptDbTable } from "../table/db-table";
import { getKeyProps } from "./patch-types";

/**
 * Resolves array patch operator keys (`__$insert`, `__$remove`, `__$upsert`,
 * `__$update`, `__$keys`) in a decomposed update into plain resolved arrays.
 *
 * This is the generic fallback for adapters that don't support native patch
 * operations (e.g., SQLite). It performs a read‑modify‑write:
 *
 * 1. Detects `__$` operator keys in the update object
 * 2. Reads the current record to get existing array values: the column's
 *   `fromStorage` formatter's result when it is an array (since 0.1.178;
 *   e.g. a vector stored as a Float32 BLOB on SQLite), else the stored value
 *   with JSON text parsed; a `null` / missing value is `[]`. A value that is
 *   still not an array throws (since 0.1.178; it was spread item by item —
 *   a string into its characters)
 * 3. Applies operations in‑memory
 * 4. Replaces operator keys with resolved plain values (written as any
 *   other update value — no `toStorage` formatting of the result)
 *
 * @param update - The decomposed update (from `decomposePatch`) with physical
 *   column keys, potentially containing `field.__$insert`, `field.__$remove`, etc.
 * @param currentRecord - The current record fetched from the database (a raw
 *   adapter row, physical column keys — or, on an adapter that stores nested
 *   objects, the document a dotted column path leads into, since 0.1.182).
 *   Can be `null` if the record doesn't exist.
 * @param table - The AtscriptDbTable for metadata access (key props, unique items,
 *   merge strategy — found by the column's logical path since 0.1.178, so a
 *   `@db.column`-renamed or flattened array column keeps them).
 * @returns A new update object with all `__$` keys resolved to plain values.
 * @throws Error when a field's stored value is not an array.
 */
export function resolveArrayOps(
  update: Record<string, unknown>,
  currentRecord: Record<string, unknown> | null,
  table: AtscriptDbTable,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  // Group ops by field: { "tags" → { insert?: [...], remove?: [...], ... } }
  const opsMap = new Map<string, TFieldOps>();
  const seenOpsFields = new Set<string>();

  for (const [key, value] of Object.entries(update)) {
    const match = key.match(/^(.+?)\.__\$(.+)$/);
    if (!match) {
      resolved[key] = value;
      continue;
    }

    const field = match[1];
    const op = match[2]; // 'insert' | 'remove' | 'upsert' | 'update' | 'keys'
    seenOpsFields.add(field);

    let fieldOps = opsMap.get(field);
    if (!fieldOps) {
      fieldOps = {};
      opsMap.set(field, fieldOps);
    }

    switch (op) {
      case "insert": {
        fieldOps.insert = value as unknown[];
        break;
      }
      case "remove": {
        fieldOps.remove = value as unknown[];
        break;
      }
      case "upsert": {
        fieldOps.upsert = value as unknown[];
        break;
      }
      case "update": {
        fieldOps.update = value as unknown[];
        break;
      }
      case "keys": {
        fieldOps.keys = value as string[];
        break;
      }
    }
  }

  // Resolve each field's ops. `field` is the physical column: the key of the
  // raw row and of `fromStorageFormatters` (a `@db.column` rename included).
  const meta = table.getMetadata();
  const { fromStorageFormatters: fromStorage, leafByPhysical, mergePaths } = meta;
  for (const [field, ops] of opsMap) {
    const stored = storedValue(currentRecord, field);
    const decoded = stored == null ? undefined : fromStorage?.get(field)?.(stored);
    let current: unknown = Array.isArray(decoded) ? decoded : (stored ?? []);
    // SQL adapters store an array column as JSON text — parse it
    if (typeof current === "string") current = JSON.parse(current);
    if (!Array.isArray(current)) {
      throw new Error(
        `Cannot apply array patch operators to "${field}": its stored value is not an array`,
      );
    }
    // The array's settings (key props, `uniqueItems`, merge strategy) are
    // annotations of the logical field — `flatMap` is keyed by its path. A
    // nested-object adapter keys it by document path: a renamed top-level key
    // reads back to its field (since 0.1.184).
    const top = field.split(".")[0]!;
    const renamed = [...meta.columnMap].find(([, column]) => column === top)?.[0];
    const path =
      leafByPhysical.get(field)?.path ?? (renamed ? renamed + field.slice(top.length) : field);
    const arrayType = table.flatMap.get(path) as
      | TAtscriptAnnotatedType<TAtscriptTypeArray>
      | undefined;
    const keyProps = arrayType ? getKeyProps(arrayType) : new Set<string>();
    const uniqueItems = arrayType?.metadata?.get("expect.array.uniqueItems") as
      | { message?: string }
      | undefined;
    const mergeStrategy = mergePaths.has(path);

    // Use keys from decomposer if available, otherwise from type metadata
    const effectiveKeys = ops.keys && ops.keys.length > 0 ? new Set(ops.keys) : keyProps;

    // A null / missing array stays null when the operators have nothing to
    // apply (empty item lists, `$update` without key props) — MongoDB sets
    // nothing then either (since 0.1.180; before, `[]` was written)
    const idle =
      !ops.remove?.length &&
      !ops.upsert?.length &&
      !ops.insert?.length &&
      !(ops.update?.length && effectiveKeys.size > 0);
    resolved[field] =
      stored == null && idle
        ? null
        : applyOps(current, ops, effectiveKeys, !!uniqueItems, mergeStrategy);
  }

  return resolved;
}

/**
 * The stored value of `field` in a raw row: its own key — a column, a
 * flattened `a__b` one included — or, on an adapter that stores nested
 * objects (in-memory), the value the dotted path leads to in the document
 * (since 0.1.182; before, such an array read as missing and its stored items
 * were dropped).
 */
function storedValue(row: Record<string, unknown> | null, field: string): unknown {
  if (!row) return undefined;
  return field in row ? row[field] : getPath(row, field);
}

/**
 * Extracts the set of field names that have array ops in the update.
 * Used to determine which fields need to be fetched from the current record.
 */
export function getArrayOpsFields(update: Record<string, unknown>): Set<string> {
  const fields = new Set<string>();
  for (const key of Object.keys(update)) {
    const match = key.match(/^(.+?)\.__\$(.+)$/);
    if (match) {
      fields.add(match[1]);
    }
  }
  return fields;
}

interface TFieldOps {
  insert?: unknown[];
  remove?: unknown[];
  upsert?: unknown[];
  update?: unknown[];
  keys?: string[];
}

/**
 * Applies patch operations to an array in‑memory.
 * Order: remove → update → upsert → insert (most intuitive semantics).
 */
function applyOps(
  current: unknown[],
  ops: TFieldOps,
  keyProps: Set<string>,
  uniqueItems: boolean,
  mergeStrategy: boolean,
): unknown[] {
  let result = [...current];

  // 1. $remove
  if (ops.remove) {
    result = applyRemove(result, ops.remove, keyProps);
  }

  // 2. $update — replaces the matched element, or merges into it under
  //    `@db.patch.strategy 'merge'` (since 0.1.180; it always merged before)
  if (ops.update) {
    result = applyUpdate(result, ops.update, keyProps, mergeStrategy);
  }

  // 3. $upsert
  if (ops.upsert) {
    result = applyUpsert(result, ops.upsert, keyProps, mergeStrategy);
  }

  // 4. $insert
  if (ops.insert) {
    result = applyInsert(result, ops.insert, keyProps, uniqueItems);
  }

  return result;
}

// ── Individual operations ────────────────────────────────────────────────────

function applyRemove(arr: unknown[], items: unknown[], keyProps: Set<string>): unknown[] {
  if (keyProps.size === 0) {
    // Primitive: remove by value equality
    const removeSet = new Set(items.map(canonical));
    return arr.filter((el) => !removeSet.has(canonical(el)));
  }
  // Object: remove by key match
  return arr.filter((el) => {
    const elObj = el as Record<string, unknown>;
    return !items.some((item) => matchByKeys(elObj, item as Record<string, unknown>, keyProps));
  });
}

function applyUpdate(
  arr: unknown[],
  items: unknown[],
  keyProps: Set<string>,
  mergeStrategy: boolean,
): unknown[] {
  // Without key props there is nothing to find an element by: no change
  if (keyProps.size === 0) {
    return arr;
  }
  // Items apply one after another, so a key given twice ends as its last item
  // (merged over the first under merge strategy)
  let result = arr;
  for (const item of items) {
    const itemObj = item as Record<string, unknown>;
    result = result.map((el) => {
      const elObj = el as Record<string, unknown>;
      if (!matchByKeys(elObj, itemObj, keyProps)) return el;
      return mergeStrategy ? { ...elObj, ...itemObj } : itemObj;
    });
  }
  return result;
}

function applyUpsert(
  arr: unknown[],
  items: unknown[],
  keyProps: Set<string>,
  mergeStrategy: boolean,
): unknown[] {
  // Without key props: append unless an equal element is stored. The stored
  // element stays as it is, as on MongoDB (since 0.1.182; before, it was
  // replaced by the item — an equal object then took the item's property order)
  if (keyProps.size === 0) {
    return appendAbsent(arr, items);
  }
  const result = [...arr];
  for (const item of items) {
    // Merge into / replace every element of that key, in place — or append
    // when none has it
    const itemObj = item as Record<string, unknown>;
    let found = false;
    for (let i = 0; i < result.length; i++) {
      const elObj = result[i] as Record<string, unknown>;
      if (!matchByKeys(elObj, itemObj, keyProps)) continue;
      found = true;
      result[i] = mergeStrategy ? { ...elObj, ...itemObj } : itemObj;
    }
    if (!found) result.push(item);
  }
  return result;
}

function applyInsert(
  arr: unknown[],
  items: unknown[],
  keyProps: Set<string>,
  uniqueItems: boolean,
): unknown[] {
  // Without key props a plain array takes every item; under `uniqueItems` an
  // item equal to a stored one is skipped
  if (keyProps.size === 0) {
    return uniqueItems ? appendAbsent(arr, items) : [...arr, ...items];
  }

  // An item whose key is already there is skipped — two elements with one key
  // are never meant (since 0.1.180; before, only under `uniqueItems`)
  const result = [...arr];
  for (const item of items) {
    const exists = result.some((el) =>
      matchByKeys(el as Record<string, unknown>, item as Record<string, unknown>, keyProps),
    );
    if (!exists) {
      result.push(item);
    }
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The form elements without key props are compared by: JSON text with the
 * keys of every object sorted. PostgreSQL `JSONB` and MySQL `JSON` return an
 * object's keys in their own order, so the plain JSON text of an equal
 * element differs there (since 0.1.180; before, `$remove` of a stored object
 * matched nothing on those two).
 */
const canonical = stableJson;

/** `arr` with each item appended unless an equal element — stored or appended before it — is there. */
function appendAbsent(arr: unknown[], items: unknown[]): unknown[] {
  const result = [...arr];
  const seen = new Set(result.map(canonical));
  for (const item of items) {
    const form = canonical(item);
    if (seen.has(form)) continue;
    seen.add(form);
    result.push(item);
  }
  return result;
}

/** Whether stored element `a` has the key values of item `b` (a stored `null` or scalar never has). */
function matchByKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keys: Set<string>,
): boolean {
  if (a === null || typeof a !== "object") return false;
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}
