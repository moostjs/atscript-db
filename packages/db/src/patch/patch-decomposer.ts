import {
  isPhantomType,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeArray,
  type TAtscriptTypeObject,
} from "@atscript/typescript/utils";

import { DbError } from "../db-error";
import type { AtscriptDbTable } from "../table/db-table";
import type { TableMetadata } from "../table/table-metadata";
import { getKeyProps } from "./patch-types";

/** Metadata tag the flattener puts on top-level array fields (shared with `isVersionExemptPatch`). */
export const TOP_LEVEL_ARRAY_TAG = "db.__topLevelArray";

/**
 * Decomposes a patch payload into a flat update object for adapters
 * that don't support native patch operations.
 *
 * Handles:
 * - Top-level array patches (`$replace`, `$insert`, `$upsert`, `$update`, `$remove`)
 * - Merge strategy for nested objects
 * - Simple field sets
 *
 * For adapters with native patch support (e.g., MongoDB aggregation pipelines),
 * use {@link BaseDbAdapter.nativePatch} instead.
 *
 * @param payload - The patch payload from the user.
 * @param table - The AtscriptDbTable instance for metadata access.
 * @returns A flat update object suitable for a basic `updateOne` call.
 */
export function decomposePatch(
  payload: Record<string, unknown>,
  table: AtscriptDbTable,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  // Table metadata read once per patch, not per key.
  flattenPatchPayload(payload, "", update, table.getMetadata());

  return update;
}

function flattenPatchPayload(
  payload: Record<string, unknown>,
  prefix: string,
  update: Record<string, unknown>,
  meta: TableMetadata,
): void {
  const primaryKeys = meta.primaryKeys;
  const flatMap = meta.flatMap;
  for (const _key of Object.keys(payload)) {
    const value = payload[_key];
    const key = prefix ? `${prefix}.${_key}` : _key;

    // Skip primary key fields in updates
    if (primaryKeys.includes(key)) {
      continue;
    }

    if (!isObjectValue(value)) {
      if (value === null && meta.flattenedParents.has(key)) {
        // A flattened object set to null nulls its columns — every one is
        // nullable when the object is (optional or `| null`)
        for (const lp of meta.optionalLeavesByLogicalParent.get(key) ?? []) update[lp] = null;
        continue;
      }
      // Simple field set
      update[key] = value;
      continue;
    }
    const flatType = flatMap.get(key);

    if (isPatchableArray(flatType)) {
      // Top-level array with patch operators (@db.json fields are excluded; plain arrays fall through as $replace)
      decomposeArrayPatch(key, value, flatType!, update);
    } else if (flatType?.metadata?.get("db.patch.strategy") === "merge") {
      // Merge: omitted siblings preserved.
      flattenPatchPayload(value, key, update, meta);
    } else if (meta.flattenedParents.has(key)) {
      // Replace: required-missing leaves are caught earlier by the strict validator;
      // null-fill the optional ones so the omission isn't silently lost.
      flattenPatchPayload(value, key, update, meta);
      const optLeaves = meta.optionalLeavesByLogicalParent.get(key);
      if (optLeaves) {
        for (const lp of optLeaves) {
          if (!(lp in update)) update[lp] = null;
        }
      }
    } else if (isStoredObject(flatType) && carriesArrayOps(value, key, meta)) {
      // An object a nested-object adapter stores whole, with array operators
      // inside: they need the stored arrays, so it is set leaf by leaf as the
      // flattening adapters set it (since 0.1.182; before, the operator object
      // itself was stored as the array's value)
      decomposeReplaceObject(value, key, update, meta);
    } else {
      // Simple field set
      update[key] = value;
    }
  }
}

/** An object value, not an array — a nested object or an array-operator value (`{ $insert: [...] }`). */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `type` is an object stored as such — not `@db.json`, not a union. */
function isStoredObject(type: TAtscriptAnnotatedType | undefined): boolean {
  return type?.type.kind === "object" && !type.metadata?.has("db.json");
}

/** Whether `type` is a top-level array that takes the array operators — not `@db.json`. */
function isPatchableArray(type: TAtscriptAnnotatedType | undefined): boolean {
  return !!type?.metadata?.get(TOP_LEVEL_ARRAY_TAG) && !type.metadata.has("db.json");
}

/**
 * Whether a patch payload holds an array operator — `$replace` included — on
 * an array field at any depth, top-level or inside nested objects (since
 * 0.1.182). Decomposed, `$replace` is a plain set that no longer shows: a
 * native-patch adapter's `updateMany` asks this to take such a patch to
 * `nativePatchMany`, where it ends as `updateOne` leaves it.
 */
export function hasArrayOperators(
  payload: Record<string, unknown>,
  table: AtscriptDbTable,
): boolean {
  return carriesArrayOps(payload, "", table.getMetadata());
}

/** Whether `value` (the object at `prefix`, `""` for the payload) holds array operators, at any depth. */
function carriesArrayOps(
  value: Record<string, unknown>,
  prefix: string,
  meta: TableMetadata,
): boolean {
  for (const [prop, child] of Object.entries(value)) {
    if (!isObjectValue(child)) continue;
    const key = prefix ? `${prefix}.${prop}` : prop;
    const childType = meta.flatMap.get(key);
    if (isPatchableArray(childType)) return true;
    if (isStoredObject(childType) && carriesArrayOps(child, key, meta)) return true;
  }
  return false;
}

/**
 * Sets a replaced object of a nested-object adapter leaf by leaf, as the
 * flattening adapters store it: a given leaf is set, an omitted optional
 * child cleared (`null`), an array operator decomposed, and a nested object
 * replaced the same way — also one with `@db.patch.strategy 'merge'`, whose
 * omitted optional leaves the flattening adapters clear under a replaced
 * parent. Required children are present (the strict validator ran).
 */
function decomposeReplaceObject(
  value: Record<string, unknown>,
  prefix: string,
  update: Record<string, unknown>,
  meta: TableMetadata,
): void {
  const objType = meta.flatMap.get(prefix)!;
  for (const [prop, propType] of (objType.type as TAtscriptTypeObject).props) {
    const key = `${prefix}.${prop}`;
    if (isPhantomType(propType) || meta.ignoredFields.has(key)) continue;
    const child = value[prop];
    if (child === undefined) {
      if (propType.optional) update[key] = null;
      continue;
    }
    const childType = meta.flatMap.get(key);
    if (isObjectValue(child) && isPatchableArray(childType)) {
      decomposeArrayPatch(key, child, childType!, update);
    } else if (isObjectValue(child) && isStoredObject(childType)) {
      decomposeReplaceObject(child, key, update, meta);
    } else {
      update[key] = child;
    }
  }
}

/**
 * Decomposes array patch operators into simple field updates.
 *
 * For adapters without native array operations, this does a best-effort
 * decomposition:
 * - `$replace` → direct set
 * - `$insert` → value to append (adapter must handle)
 * - `$upsert` → value to upsert by key (adapter must handle)
 * - `$update` → value to update by key (adapter must handle)
 * - `$remove` → value to remove by key (adapter must handle)
 *
 * Note: For full correctness with `$insert`/`$upsert`/`$update`/`$remove`,
 * the adapter should implement native patch support. This generic decomposition
 * handles `$replace` directly and stores the other operations in a structured
 * format the adapter can interpret.
 */
function decomposeArrayPatch(
  key: string,
  value: Record<string, unknown>,
  fieldType: TAtscriptAnnotatedType,
  update: Record<string, unknown>,
): void {
  const keyProps =
    fieldType.type.kind === "array"
      ? getKeyProps(fieldType as TAtscriptAnnotatedType<TAtscriptTypeArray>)
      : new Set<string>();

  // $replace takes precedence — full array replacement
  if (value.$replace !== undefined) {
    update[key] = value.$replace;
    return;
  }

  // For other operations, store them in a structured format
  // that the adapter's updateOne can interpret.
  // Adapters without native patch support get a simplified view.
  if (value.$insert !== undefined) {
    update[`${key}.__$insert`] = value.$insert;
  }
  if (value.$upsert !== undefined) {
    update[`${key}.__$upsert`] = value.$upsert;
  }
  if (value.$update !== undefined) {
    update[`${key}.__$update`] = value.$update;
  }
  if (value.$remove !== undefined) {
    update[`${key}.__$remove`] = value.$remove;
  }

  // Store key props once if any keyed operation is present
  if (
    keyProps.size > 0 &&
    (value.$upsert !== undefined || value.$update !== undefined || value.$remove !== undefined)
  ) {
    update[`${key}.__$keys`] = [...keyProps];
  }
}

/**
 * Throws if the payload attempts to write the version column directly.
 *
 * The version column is server-managed: the adapter auto-increments it
 * on every update. Direct writes (plain SET, `$inc`, `$mul`) would
 * either silently no-op (overwritten by the auto-bump) or corrupt the
 * OCC invariant. Reject them at the patch layer so the failure is
 * loud and adapter-agnostic.
 *
 * Inspects the payload AFTER `separateCas` has stripped `$cas` (so
 * that the legitimate `$cas` → expectedVersion path is not flagged).
 *
 * The check is intentionally narrow: only the physical column name at
 * the top level of the (already-decomposed) payload. Nested objects
 * cannot reach the version column through dot-paths because the
 * decomposer flattens those into top-level dot-keys; the version
 * column, being a scalar at the root, cannot be nested.
 *
 * Zero-allocation when the version column is not present.
 *
 * @throws {DbError} with code `VERSION_COLUMN_WRITE` when the version
 *   column appears as a top-level key in `data` or as the target of a
 *   `$inc`/`$mul` field op.
 */
export function assertNoVersionWrites(data: Record<string, unknown>, versionColumn: string): void {
  if (!(versionColumn in data)) return;

  throw new DbError("VERSION_COLUMN_WRITE", [
    {
      path: versionColumn,
      message:
        `Cannot write to version column "${versionColumn}" directly; ` +
        `omit it from the payload or use $cas for conflict detection`,
    },
  ]);
}
