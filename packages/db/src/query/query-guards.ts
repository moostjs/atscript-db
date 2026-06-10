import type { AggregateQuery, FilterExpr } from "@uniqu/core";

import { DbError } from "../db-error";
import type { BaseDbAdapter } from "../base-adapter";
import { findAncestorInSet, isGeoPointType, type TableMetadata } from "../table/table-metadata";

/**
 * Engine-agnostic query-time guards, applied in the core layer BEFORE filter
 * translation (field-encryption spec §6, geo-index spec §4.2):
 *
 * - filters referencing an `@db.encrypted` field (incl. nested paths into an
 *   encrypted object) → `ENC_FIELD_FILTER`
 * - `$sort` on an encrypted field → `ENC_FIELD_SORT`
 * - `$groupBy` / aggregate refs on an encrypted field → `ENC_FIELD_AGG`
 * - `$geoWithin` on a non-geoPoint field → `FILTER_TYPE_MISMATCH`
 * - `$geoWithin` with a malformed circle → `INVALID_QUERY`
 * - `$geoWithin` on an adapter without geo support → `GEO_NOT_SUPPORTED`
 */

/** Validates a `[lng, lat]` tuple (GeoJSON coordinate order). */
export function assertGeoPoint(point: unknown, path: string): asserts point is [number, number] {
  const valid =
    Array.isArray(point) &&
    point.length === 2 &&
    typeof point[0] === "number" &&
    typeof point[1] === "number" &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    point[0] >= -180 &&
    point[0] <= 180 &&
    point[1] >= -90 &&
    point[1] <= 90;
  if (!valid) {
    throw new DbError("INVALID_QUERY", [
      {
        path,
        message: `Invalid geo point at "${path}" — expected [lng, lat] with lng ∈ [-180, 180], lat ∈ [-90, 90]`,
      },
    ]);
  }
}

function isEncryptedRef(meta: TableMetadata, field: string): boolean {
  return (
    meta.encryptedFields.has(field) || findAncestorInSet(field, meta.encryptedFields) !== undefined
  );
}

function encryptedRefError(
  code: "ENC_FIELD_FILTER" | "ENC_FIELD_SORT" | "ENC_FIELD_AGG",
  field: string,
  what: string,
): DbError {
  return new DbError(code, [{ path: field, message: `Cannot ${what} encrypted field "${field}"` }]);
}

function guardGeoWithin(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  field: string,
  value: unknown,
): void {
  const fieldType = meta.flatMap?.get(field);
  if (!fieldType || !isGeoPointType(fieldType)) {
    throw new DbError("FILTER_TYPE_MISMATCH", [
      { path: field, message: `$geoWithin requires a db.geoPoint field; "${field}" is not one` },
    ]);
  }
  const circle = value as { center?: unknown; radius?: unknown } | null;
  if (typeof circle !== "object" || circle === null || Array.isArray(circle)) {
    throw new DbError("INVALID_QUERY", [
      { path: field, message: "$geoWithin expects { center: [lng, lat], radius: meters }" },
    ]);
  }
  assertGeoPoint(circle.center, `${field}.$geoWithin.center`);
  if (typeof circle.radius !== "number" || !Number.isFinite(circle.radius) || circle.radius <= 0) {
    throw new DbError("INVALID_QUERY", [
      { path: field, message: "$geoWithin radius must be a positive number of meters" },
    ]);
  }
  if (!adapter.isGeoSearchable()) {
    throw new DbError("GEO_NOT_SUPPORTED", [
      { path: field, message: "$geoWithin is not supported by this adapter" },
    ]);
  }
}

/**
 * Walks a filter expression, rejecting encrypted-field references and
 * validating `$geoWithin` operator nodes.
 */
export function guardFilter(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  filter: FilterExpr | undefined,
  encCode: "ENC_FIELD_FILTER" | "ENC_FIELD_AGG" = "ENC_FIELD_FILTER",
): void {
  if (!filter || typeof filter !== "object") {
    return;
  }
  const hasEncrypted = meta.encryptedFields.size > 0;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and" || key === "$or") {
      for (const child of (value as FilterExpr[]) ?? []) {
        guardFilter(meta, adapter, child, encCode);
      }
      continue;
    }
    if (key === "$not") {
      guardFilter(meta, adapter, value as FilterExpr, encCode);
      continue;
    }
    if (key.startsWith("$")) {
      continue;
    }
    if (hasEncrypted && isEncryptedRef(meta, key)) {
      throw encryptedRefError(encCode, key, "filter on");
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        if (op === "$geoWithin") {
          guardGeoWithin(meta, adapter, key, opValue);
        }
      }
    }
  }
}

/** Rejects `$sort` keys referencing encrypted fields. */
export function guardSort(meta: TableMetadata, sort: unknown): void {
  if (!sort || typeof sort !== "object" || meta.encryptedFields.size === 0) {
    return;
  }
  for (const key of Object.keys(sort as Record<string, unknown>)) {
    if (isEncryptedRef(meta, key)) {
      throw encryptedRefError("ENC_FIELD_SORT", key, "sort by");
    }
  }
}

/** Shared read-path guard: filter + $sort. */
export function guardQuery(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  query: { filter?: FilterExpr; controls?: { $sort?: unknown } } | undefined,
): void {
  if (!query) {
    return;
  }
  guardFilter(meta, adapter, query.filter);
  guardSort(meta, query.controls?.$sort);
}

/** Aggregate-path guard: $groupBy / $select / $having refs + filter + $sort. */
export function guardAggregate(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  query: AggregateQuery,
): void {
  guardFilter(meta, adapter, query.filter as FilterExpr | undefined);
  if (meta.encryptedFields.size === 0) {
    return;
  }
  const controls = query.controls;
  for (const field of controls.$groupBy ?? []) {
    if (isEncryptedRef(meta, field)) {
      throw encryptedRefError("ENC_FIELD_AGG", field, "group by");
    }
  }
  if (controls.$select) {
    for (const item of controls.$select) {
      const field = typeof item === "string" ? item : item.$field;
      if (field !== "*" && isEncryptedRef(meta, field)) {
        throw encryptedRefError("ENC_FIELD_AGG", field, "aggregate over");
      }
    }
  }
  if (controls.$having) {
    guardFilter(meta, adapter, controls.$having, "ENC_FIELD_AGG");
  }
  guardSort(meta, controls.$sort);
}
