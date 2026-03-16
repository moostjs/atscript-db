import type { AggregateQuery, FilterExpr, Uniquery } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import { UniquSelect } from "../query/uniqu-select";
import type { DbQuery } from "../types";
import type { TableMetadata } from "../table/table-metadata";

// ── Coercion helpers ────────────────────────────────────────────────────────

/** Coerces a storage value (0/1/null) back to a JS boolean. */
export function toBool(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  return !!value;
}

export function toDecimalString(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return value;
}

// ── Abstract base ───────────────────────────────────────────────────────────

/**
 * Strategy for mapping data between logical field shapes and physical storage.
 * Two implementations: {@link DocumentFieldMapper} (nested objects, NoSQL)
 * and `RelationalFieldMapper` (flattened columns, SQL).
 */
export abstract class FieldMappingStrategy {
  // ── Read path ───────────────────────────────────────────────────────────

  abstract reconstructFromRead(
    row: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown>;

  abstract translateQuery(query: Uniquery, meta: TableMetadata): DbQuery;

  abstract translateAggregateQuery(query: AggregateQuery, meta: TableMetadata): DbQuery;

  /**
   * Recursively walks a filter expression, applying adapter-specific value
   * formatting via `formatFilterValue`. Shared by both document and relational
   * mappers (relational adds key-renaming via `translateFilterWithRename`).
   */
  translateFilter(filter: FilterExpr, meta: TableMetadata): FilterExpr {
    if (!filter || typeof filter !== "object") {
      return filter;
    }
    if (!meta.toStorageFormatters) {
      return filter;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      if (key === "$and" || key === "$or") {
        result[key] = (value as FilterExpr[]).map((f) => this.translateFilter(f, meta));
      } else if (key === "$not") {
        result[key] = this.translateFilter(value as FilterExpr, meta);
      } else if (key.startsWith("$")) {
        result[key] = value;
      } else {
        result[key] = this.formatFilterValue(key, value, meta);
      }
    }
    return result as FilterExpr;
  }

  // ── Write path ──────────────────────────────────────────────────────────

  abstract prepareForWrite(
    payload: Record<string, unknown>,
    meta: TableMetadata,
    adapter: BaseDbAdapter,
  ): Record<string, unknown>;

  abstract translatePatchKeys(
    update: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown>;

  // ── Shared implementations ──────────────────────────────────────────────

  /**
   * Coerces field values from storage representation to JS types
   * (booleans from 0/1, decimals from number to string).
   */
  protected coerceFieldValues(
    row: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (meta.booleanFields.size === 0 && meta.decimalFields.size === 0) {
      return row;
    }
    for (const field of meta.booleanFields) {
      if (field in row) {
        row[field] = toBool(row[field]);
      }
    }
    for (const field of meta.decimalFields) {
      if (field in row) {
        row[field] = toDecimalString(row[field]);
      }
    }
    return row;
  }

  /**
   * Applies adapter-specific fromStorage formatting to a row read from the database.
   * Converts storage representations back to JS values (e.g. Date → epoch ms).
   */
  protected applyFromStorageFormatters(
    row: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (!meta.fromStorageFormatters) {
      return row;
    }
    for (const [col, fmt] of meta.fromStorageFormatters) {
      const val = row[col];
      if (val !== null && val !== undefined) {
        row[col] = fmt(val);
      }
    }
    return row;
  }

  /**
   * Sets a value at a dot-notation path, creating intermediate objects as needed.
   */
  protected setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
    const parts = dotPath.split(".");
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  /**
   * If all children of a flattened parent are null, collapse the parent to null.
   */
  protected reconstructNullParent(
    obj: Record<string, unknown>,
    parentPath: string,
    meta: TableMetadata,
  ): void {
    const parts = parentPath.split(".");
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined) {
        return;
      }
      current = current[parts[i]] as Record<string, unknown>;
    }

    const lastPart = parts[parts.length - 1];
    const parentObj = current[lastPart];
    if (typeof parentObj !== "object" || parentObj === null) {
      return;
    }

    let allNull = true;
    const parentKeys = Object.keys(parentObj as Record<string, unknown>);
    for (const k of parentKeys) {
      const v = (parentObj as Record<string, unknown>)[k];
      if (v !== null && v !== undefined) {
        allNull = false;
        break;
      }
    }

    if (allNull) {
      const parentType = meta.flatMap?.get(parentPath);
      current[lastPart] = parentType?.optional ? null : {};
    }
  }

  /**
   * Applies adapter-specific value formatting to a single filter value.
   * Handles direct values, operator objects ({$gt: v}), and $in/$nin arrays.
   */
  protected formatFilterValue(physicalName: string, value: unknown, meta: TableMetadata): unknown {
    const fmt = meta.toStorageFormatters?.get(physicalName);
    if (!fmt) {
      return value;
    }

    if (value === null || value === undefined) {
      return value;
    }

    // Direct value: { field: 123 }
    if (typeof value !== "object") {
      return fmt(value);
    }

    // Operator object: { $gt: 123, $lt: 456 }
    const ops = value as Record<string, unknown>;
    const formatted: Record<string, unknown> = {};
    for (const [op, opVal] of Object.entries(ops)) {
      if ((op === "$in" || op === "$nin") && Array.isArray(opVal)) {
        formatted[op] = opVal.map((v) => (v === null || v === undefined ? v : fmt(v)));
      } else if (op.startsWith("$") && opVal !== null && opVal !== undefined) {
        formatted[op] = fmt(opVal);
      } else {
        formatted[op] = opVal;
      }
    }
    return formatted;
  }

  /**
   * Applies adapter-specific value formatting to prepared (physical-named) data.
   */
  protected formatWriteValues(
    data: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (!meta.toStorageFormatters) {
      return data;
    }
    for (const [col, fmt] of meta.toStorageFormatters) {
      const val = data[col];
      if (val !== null && val !== undefined) {
        data[col] = fmt(val);
      }
    }
    return data;
  }

  /**
   * Prepares primary key values and strips ignored fields.
   * Shared pre-processing for both document and relational write paths.
   */
  protected prepareCommon(
    data: Record<string, unknown>,
    meta: TableMetadata,
    adapter: BaseDbAdapter,
  ): void {
    // Prepare primary key values
    for (const pk of meta.primaryKeys) {
      if (data[pk] !== undefined) {
        const fieldType = meta.flatMap?.get(pk);
        if (fieldType) {
          data[pk] = adapter.prepareId(data[pk], fieldType);
        }
      }
    }

    // Strip top-level ignored fields
    for (const field of meta.ignoredFields) {
      if (!field.includes(".")) {
        delete data[field];
      }
    }
  }
}

// ── Document field mapper (NoSQL — passthrough) ─────────────────────────────

/**
 * Field mapper for document-oriented adapters (e.g. MongoDB).
 * Nested objects are preserved as-is. Only applies column renames and
 * value coercion.
 */
export class DocumentFieldMapper extends FieldMappingStrategy {
  reconstructFromRead(row: Record<string, unknown>, meta: TableMetadata): Record<string, unknown> {
    return this.applyFromStorageFormatters(this.coerceFieldValues(row, meta), meta);
  }

  translateQuery(query: Uniquery, meta: TableMetadata): DbQuery {
    const controls = query.controls;
    return {
      filter: meta.toStorageFormatters
        ? this.translateFilter(query.filter as FilterExpr, meta)
        : (query.filter as FilterExpr),
      controls: {
        ...controls,
        $with: undefined,
        $select: controls?.$select
          ? new UniquSelect(controls.$select, meta.allPhysicalFields)
          : undefined,
      },
      insights: query.insights,
    };
  }

  translateAggregateQuery(query: AggregateQuery, meta: TableMetadata): DbQuery {
    const controls = query.controls;
    return {
      filter: meta.toStorageFormatters
        ? this.translateFilter(query.filter as FilterExpr, meta)
        : ((query.filter ?? {}) as FilterExpr),
      controls: {
        ...controls,
        $with: undefined,
        $select: controls.$select
          ? new UniquSelect(controls.$select as any, meta.allPhysicalFields)
          : undefined,
      },
      insights: query.insights,
    };
  }

  prepareForWrite(
    payload: Record<string, unknown>,
    meta: TableMetadata,
    adapter: BaseDbAdapter,
  ): Record<string, unknown> {
    const data = { ...payload };
    this.prepareCommon(data, meta, adapter);

    // Column renames only (no flattening)
    for (const [logical, physical] of meta.columnMap.entries()) {
      if (logical in data) {
        data[physical] = data[logical];
        delete data[logical];
      }
    }
    return this.formatWriteValues(data, meta);
  }

  translatePatchKeys(
    update: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    return this.formatWriteValues(update, meta);
  }
}
