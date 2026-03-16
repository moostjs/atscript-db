import type {
  AggregateExpr,
  AggregateQuery,
  FilterExpr,
  Uniquery,
  UniqueryControls,
} from "@uniqu/core";

import { resolveAlias } from "../agg";
import type { BaseDbAdapter } from "../base-adapter";
import { UniquSelect } from "../query/uniqu-select";
import type { DbControls, DbQuery } from "../types";
import type { TableMetadata } from "../table/table-metadata";
import { FieldMappingStrategy, toBool, toDecimalString } from "./field-mapping";

/**
 * Field mapper for relational adapters (e.g. SQLite, MySQL).
 * Flattens nested objects to `__`-separated column names and
 * reconstructs them on read. Applies full physical-name translation
 * for queries, filters, and controls.
 */
export class RelationalFieldMapper extends FieldMappingStrategy {
  // ── Read path ───────────────────────────────────────────────────────────

  reconstructFromRead(row: Record<string, unknown>, meta: TableMetadata): Record<string, unknown> {
    if (!meta.requiresMappings) {
      return this.applyFromStorageFormatters(this.coerceFieldValues(row, meta), meta);
    }

    const result: Record<string, unknown> = {};
    const fromFmts = meta.fromStorageFormatters;

    for (const physical of Object.keys(row)) {
      const fd = meta.leafByPhysical.get(physical);
      if (!fd) {
        result[physical] = row[physical];
        continue;
      }

      let raw = row[physical];
      const fromFmt = fromFmts?.get(physical);
      if (fromFmt && raw !== null && raw !== undefined) {
        raw = fromFmt(raw);
      }
      const value =
        fd.designType === "boolean"
          ? toBool(raw)
          : fd.designType === "decimal"
            ? toDecimalString(raw)
            : raw;

      if (fd.storage === "json") {
        this.setNestedValue(result, fd.path, typeof value === "string" ? JSON.parse(value) : value);
      } else if (fd.storage === "flattened") {
        this.setNestedValue(result, fd.path, value);
      } else {
        result[fd.path] = value;
      }
    }

    // Collapse null parent objects
    for (const parentPath of meta.flattenedParents) {
      this.reconstructNullParent(result, parentPath, meta);
    }

    return result;
  }

  translateQuery(query: Uniquery, meta: TableMetadata): DbQuery {
    if (!meta.requiresMappings) {
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
    return {
      filter: this.translateFilterWithRename(query.filter as FilterExpr, meta),
      controls: query.controls ? this.translateControls(query.controls, meta) : {},
      insights: query.insights,
    };
  }

  translateAggregateQuery(query: AggregateQuery, meta: TableMetadata): DbQuery {
    const controls = query.controls;

    // Translate filter (pre-aggregation WHERE clause)
    const filter = meta.requiresMappings
      ? this.translateFilterWithRename((query.filter ?? {}) as FilterExpr, meta)
      : meta.toStorageFormatters
        ? this.translateFilter((query.filter ?? {}) as FilterExpr, meta)
        : ((query.filter ?? {}) as FilterExpr);

    // Translate $groupBy: logical → physical
    const groupBy = controls.$groupBy.map(
      (field) => meta.leafByLogical.get(field)?.physicalName ?? field,
    );

    // Translate $select: strings → physical, AggregateExpr.$field → physical
    let select: UniqueryControls["$select"] | undefined;
    if (controls.$select) {
      select = controls.$select.map((item) => {
        if (typeof item === "string") {
          return meta.leafByLogical.get(item)?.physicalName ?? item;
        }
        // AggregateExpr: translate $field (except '*'), keep $as
        if (item.$field === "*") {
          return item;
        }
        return {
          ...item,
          $field: meta.leafByLogical.get(item.$field)?.physicalName ?? item.$field,
        } as AggregateExpr;
      }) as UniqueryControls["$select"];
    }

    // Build alias set from $select AggregateExpr entries for $sort pass-through
    const aliases = new Set<string>();
    if (controls.$select) {
      for (const item of controls.$select) {
        if (typeof item !== "string") {
          aliases.add(resolveAlias(item));
        }
      }
    }

    // Translate $sort: alias keys pass through, others → physical
    let sort: DbControls["$sort"];
    if (controls.$sort) {
      const translated: Record<string, unknown> = {};
      for (const [key, dir] of Object.entries(controls.$sort)) {
        if (aliases.has(key)) {
          translated[key] = dir;
        } else {
          const physical = meta.leafByLogical.get(key)?.physicalName ?? key;
          translated[physical] = dir;
        }
      }
      sort = translated as DbControls["$sort"];
    }

    // Translate $having: same as filter translation (aliases pass through via ?? key fallback)
    let having: FilterExpr | undefined;
    if (controls.$having) {
      having = meta.requiresMappings
        ? this.translateFilterWithRename(controls.$having, meta)
        : meta.toStorageFormatters
          ? this.translateFilter(controls.$having, meta)
          : controls.$having;
    }

    return {
      filter,
      controls: {
        $groupBy: groupBy,
        $select: select ? new UniquSelect(select, meta.allPhysicalFields) : undefined,
        $sort: sort,
        $having: having,
        $skip: controls.$skip,
        $limit: controls.$limit,
        $count: controls.$count,
      },
      insights: query.insights,
    };
  }

  /**
   * Translates filter with key renaming from logical to physical names.
   * Used by the relational query path where field paths must be mapped
   * to `__`-separated column names.
   */
  translateFilterWithRename(filter: FilterExpr, meta: TableMetadata): FilterExpr {
    if (!filter || typeof filter !== "object") {
      return filter;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      if (key === "$and" || key === "$or") {
        result[key] = (value as FilterExpr[]).map((f) => this.translateFilterWithRename(f, meta));
      } else if (key === "$not") {
        result[key] = this.translateFilterWithRename(value as FilterExpr, meta);
      } else if (key.startsWith("$")) {
        result[key] = value;
      } else {
        const physical = meta.leafByLogical.get(key)?.physicalName ?? key;
        result[physical] = this.formatFilterValue(physical, value, meta);
      }
    }
    return result as FilterExpr;
  }

  // ── Write path ──────────────────────────────────────────────────────────

  prepareForWrite(
    payload: Record<string, unknown>,
    meta: TableMetadata,
    adapter: BaseDbAdapter,
  ): Record<string, unknown> {
    const data = { ...payload };
    this.prepareCommon(data, meta, adapter);

    // Fast path: no nested/json fields — just do column mapping
    if (!meta.requiresMappings) {
      for (const [logical, physical] of meta.columnMap.entries()) {
        if (logical in data) {
          data[physical] = data[logical];
          delete data[logical];
        }
      }
      return this.formatWriteValues(data, meta);
    }

    // Flatten nested objects and apply physical names
    return this.formatWriteValues(this.flattenPayload(data, meta), meta);
  }

  translatePatchKeys(
    update: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (!meta.requiresMappings && !meta.toStorageFormatters) {
      return update;
    }

    const result: Record<string, unknown> = {};
    const updateKeys = Object.keys(update);
    for (const key of updateKeys) {
      const value = update[key];
      // Handle array patch operator keys like "tags.__$insert"
      const operatorMatch = key.match(/^(.+?)(\.__\$.+)$/);
      const basePath = operatorMatch ? operatorMatch[1] : key;
      const suffix = operatorMatch ? operatorMatch[2] : "";

      const fd = meta.leafByLogical.get(basePath);
      const finalKey = (fd?.physicalName ?? basePath) + suffix;

      if (fd?.storage === "json" && typeof value === "object" && value !== null && !suffix) {
        result[finalKey] = JSON.stringify(value);
      } else {
        result[finalKey] = value;
      }
    }
    return this.formatWriteValues(result, meta);
  }

  // ── Private helpers (relational-only) ───────────────────────────────────

  /**
   * Translates field names in sort and projection controls from
   * logical dot-paths to physical column names.
   */
  private translateControls(controls: UniqueryControls, meta: TableMetadata): DbControls {
    if (!controls) {
      return {};
    }

    const result: DbControls = { ...controls, $select: undefined, $with: undefined };

    if (controls.$sort) {
      const translated: Record<string, unknown> = {};
      const sortObj = controls.$sort as Record<string, unknown>;
      const sortKeys = Object.keys(sortObj);
      for (const key of sortKeys) {
        if (meta.flattenedParents.has(key)) {
          continue;
        }
        const physical = meta.leafByLogical.get(key)?.physicalName ?? key;
        translated[physical] = sortObj[key];
      }
      result.$sort = translated as UniqueryControls["$sort"];
    }

    if (controls.$select) {
      let translatedRaw: UniqueryControls["$select"];
      if (Array.isArray(controls.$select)) {
        const expanded: string[] = [];
        for (const key of controls.$select) {
          const expansion = meta.selectExpansion.get(key as string);
          if (expansion) {
            expanded.push(...expansion);
          } else {
            expanded.push((meta.leafByLogical.get(key as string)?.physicalName ?? key) as string);
          }
        }
        translatedRaw = expanded;
      } else {
        const translated: Record<string, number> = {};
        const selectObj = controls.$select as Record<string, number>;
        const selectKeys = Object.keys(selectObj);
        for (const key of selectKeys) {
          const val = selectObj[key];
          const expansion = meta.selectExpansion.get(key);
          if (expansion) {
            for (const leaf of expansion) {
              translated[leaf] = val;
            }
          } else {
            const physical = meta.leafByLogical.get(key)?.physicalName ?? key;
            translated[physical] = val;
          }
        }
        translatedRaw = translated as UniqueryControls["$select"];
      }
      result.$select = new UniquSelect(translatedRaw, meta.allPhysicalFields);
    }

    return result;
  }

  /**
   * Flattens nested object fields into __-separated keys and
   * JSON-stringifies @db.json / array fields.
   */
  private flattenPayload(
    data: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      this.writeFlattenedField(key, data[key], result, meta);
    }
    return result;
  }

  /**
   * Classifies and writes a single field to the result object.
   * Recurses into nested objects that should be flattened.
   */
  private writeFlattenedField(
    path: string,
    value: unknown,
    result: Record<string, unknown>,
    meta: TableMetadata,
  ): void {
    if (meta.ignoredFields.has(path)) {
      return;
    }

    if (meta.flattenedParents.has(path)) {
      if (value === null || value === undefined) {
        this.setFlattenedChildrenNull(path, result, meta);
      } else if (typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
          this.writeFlattenedField(`${path}.${key}`, obj[key], result, meta);
        }
      }
    } else {
      const fd = meta.leafByLogical.get(path);
      const physical = fd?.physicalName ?? path.replace(/\./g, "__");
      if (fd?.storage === "json") {
        result[physical] = value !== undefined && value !== null ? JSON.stringify(value) : value;
      } else {
        result[physical] = value;
      }
    }
  }

  /**
   * When a parent object is null/undefined, set all its flattened children to null.
   */
  private setFlattenedChildrenNull(
    parentPath: string,
    result: Record<string, unknown>,
    meta: TableMetadata,
  ): void {
    const prefix = `${parentPath}.`;
    for (const [path, fd] of meta.leafByLogical.entries()) {
      if (path.startsWith(prefix)) {
        result[fd.physicalName] = null;
      }
    }
  }
}
