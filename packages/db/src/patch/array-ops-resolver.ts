import type { TAtscriptAnnotatedType, TAtscriptTypeArray } from "@atscript/typescript/utils";

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
 * 2. Reads the current record to get existing array values
 * 3. Applies operations in‑memory
 * 4. Replaces operator keys with resolved plain values
 *
 * @param update - The decomposed update (from `decomposePatch`), potentially
 *   containing `field.__$insert`, `field.__$remove`, etc.
 * @param currentRecord - The current record fetched from the database (only the
 *   fields that have array ops). Can be `null` if the record doesn't exist.
 * @param table - The AtscriptDbTable for metadata access (key props, unique items).
 * @returns A new update object with all `__$` keys resolved to plain values.
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

  // Resolve each field's ops
  for (const [field, ops] of opsMap) {
    // SQLite stores arrays as JSON text — parse if needed
    const raw = currentRecord?.[field] ?? [];
    const current = (typeof raw === "string" ? JSON.parse(raw) : raw) as unknown[];
    const arrayType = table.flatMap.get(field) as
      | TAtscriptAnnotatedType<TAtscriptTypeArray>
      | undefined;
    const keyProps = arrayType ? getKeyProps(arrayType) : new Set<string>();
    const uniqueItems = arrayType?.metadata?.get("expect.array.uniqueItems") as
      | { message?: string }
      | undefined;
    const mergeStrategy = arrayType?.metadata?.get("db.patch.strategy") === "merge";

    // Use keys from decomposer if available, otherwise from type metadata
    const effectiveKeys = ops.keys && ops.keys.length > 0 ? new Set(ops.keys) : keyProps;

    resolved[field] = applyOps(current, ops, effectiveKeys, !!uniqueItems, mergeStrategy);
  }

  return resolved;
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

  // 2. $update (always merges — update is inherently partial)
  if (ops.update) {
    result = applyUpdate(result, ops.update, keyProps);
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
    const removeSet = new Set(items.map((i) => JSON.stringify(i)));
    return arr.filter((el) => !removeSet.has(JSON.stringify(el)));
  }
  // Object: remove by key match
  return arr.filter((el) => {
    const elObj = el as Record<string, unknown>;
    return !items.some((item) => matchByKeys(elObj, item as Record<string, unknown>, keyProps));
  });
}

function applyUpdate(arr: unknown[], items: unknown[], keyProps: Set<string>): unknown[] {
  if (keyProps.size === 0) {
    return arr;
  }
  return arr.map((el) => {
    const elObj = el as Record<string, unknown>;
    const match = items.find((item) =>
      matchByKeys(elObj, item as Record<string, unknown>, keyProps),
    );
    if (match) {
      return { ...elObj, ...(match as Record<string, unknown>) };
    }
    return el;
  });
}

function applyUpsert(
  arr: unknown[],
  items: unknown[],
  keyProps: Set<string>,
  mergeStrategy: boolean,
): unknown[] {
  const result = [...arr];
  for (const item of items) {
    if (keyProps.size === 0) {
      // Primitive: replace by value or append
      const idx = result.findIndex((el) => JSON.stringify(el) === JSON.stringify(item));
      if (idx >= 0) {
        result[idx] = item;
      } else {
        result.push(item);
      }
    } else {
      // Object: find by key, merge/replace or append
      const itemObj = item as Record<string, unknown>;
      const idx = result.findIndex((el) =>
        matchByKeys(el as Record<string, unknown>, itemObj, keyProps),
      );
      if (idx >= 0) {
        result[idx] = mergeStrategy
          ? { ...(result[idx] as Record<string, unknown>), ...itemObj }
          : itemObj;
      } else {
        result.push(item);
      }
    }
  }
  return result;
}

function applyInsert(
  arr: unknown[],
  items: unknown[],
  keyProps: Set<string>,
  uniqueItems: boolean,
): unknown[] {
  if (!uniqueItems) {
    return [...arr, ...items];
  }

  // Deduplicate: only add items not already present
  const result = [...arr];
  for (const item of items) {
    const exists =
      keyProps.size > 0
        ? result.some((el) =>
            matchByKeys(el as Record<string, unknown>, item as Record<string, unknown>, keyProps),
          )
        : result.some((el) => JSON.stringify(el) === JSON.stringify(item));
    if (!exists) {
      result.push(item);
    }
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchByKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keys: Set<string>,
): boolean {
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}
