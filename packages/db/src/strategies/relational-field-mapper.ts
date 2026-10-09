import type { FilterExpr, Uniquery, UniqueryControls } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import { containsRelationFilter, resolveRelationFilterTree } from "../query/relation-filter";
import { rewriteIntegerRegex } from "../query/integer-regex";
import { UniquSelect } from "../query/uniqu-select";
import type { DbControls, DbQuery } from "../types";
import type { TableMetadata } from "../table/table-metadata";
import { FieldMappingStrategy, toBool, toDecimalString, type TReadControls } from "./field-mapping";

/**
 * Field mapper for relational adapters (e.g. SQLite, MySQL).
 * Flattens nested objects to `__`-separated column names and
 * reconstructs them on read. Applies full physical-name translation
 * for queries, filters, and controls.
 */
export class RelationalFieldMapper extends FieldMappingStrategy {
  // ── Read path ───────────────────────────────────────────────────────────

  // A derived column is a real (generated) column here — `_controls` is unused.
  reconstructFromRead(
    row: Record<string, unknown>,
    meta: TableMetadata,
    _controls?: TReadControls,
  ): Record<string, unknown> {
    if (!meta.requiresMappings) {
      return this.applyFromStorageFormatters(this.coerceFieldValues(row, meta), meta);
    }

    // Column-rename-only: coerce/format while row still has physical keys, then rename
    if (meta.onlyColumnRenames) {
      this.coerceFieldValues(row, meta);
      this.applyFromStorageFormatters(row, meta);
      this.reverseColumnRenames(row, meta);
      return row;
    }

    const plan = readPlanFor(meta);
    const cols = plan.columns;
    const result: Record<string, unknown> = {};

    for (const physical of Object.keys(row)) {
      const col = cols.get(physical);
      if (col === undefined) {
        result[physical] = row[physical];
        continue;
      }

      let value = row[physical];
      if (col.fromFmt !== undefined && value !== null && value !== undefined) {
        value = col.fromFmt(value);
      }
      if (col.coerce !== undefined) {
        value = col.coerce(value);
      }
      if (col.json && typeof value === "string") {
        value = JSON.parse(value);
      }

      const parents = col.parents;
      if (parents === undefined) {
        result[col.path] = value;
        continue;
      }
      // Nested leaf: walk / create the parent objects.
      let current = result;
      for (let i = 0; i < parents.length; i++) {
        const part = parents[i]!;
        const next = current[part];
        if (next === undefined || next === null) {
          const created: Record<string, unknown> = {};
          current[part] = created;
          current = created;
        } else {
          current = next as Record<string, unknown>;
        }
      }
      current[col.last] = value;
    }

    // Collapse null parent objects (same order as `flattenedParents` — a
    // deeper parent collapsed first lets its ancestor collapse too).
    for (const parent of plan.parents) {
      collapseNullParent(result, parent);
    }

    return result;
  }

  translateQuery(query: Uniquery, meta: TableMetadata): DbQuery {
    const logical = rewriteIntegerRegex(query.filter as FilterExpr, meta);
    const has = containsRelationFilter(logical);
    const filter = has ? resolveRelationFilterTree(logical, meta, 0) : logical;
    if (!meta.requiresMappings) {
      const controls = query.controls;
      return {
        filter: meta.toStorageFormatters
          ? this.noteTranslated(logical, this.translateResolvedFilter(filter, meta), has)
          : filter,
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
      filter: this.noteTranslated(logical, this.translateFilterWithRename(filter, meta), has),
      controls: query.controls ? this.translateControls(query.controls, meta) : {},
      insights: query.insights,
    };
  }

  /** The flattened column of a logical path (`contact.email` → `contact__email`). */
  protected physicalPath(logical: string, meta: TableMetadata): string {
    return meta.leafByLogical.get(logical)?.physicalName ?? logical;
  }

  /**
   * Overrides the base `translateResolvedFilter` to use `leafByLogical` for key resolution
   * (handles flattened nested paths like `contact.email` → `contact__email`).
   */
  protected override translateResolvedFilter(filter: FilterExpr, meta: TableMetadata): FilterExpr {
    if (!filter || typeof filter !== "object") {
      return filter;
    }
    if (!meta.requiresMappings && !meta.toStorageFormatters) {
      return filter;
    }
    return this.translateFilterWithRename(filter, meta);
  }

  /**
   * Translates filter with key renaming from logical to physical names.
   * Used by the relational query path where field paths must be mapped
   * to `__`-separated column names. Relational predicates must already be
   * resolved (`translateFilter` / `translateQuery` do it); a resolved
   * predicate passes through under its navigation-field key.
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
      } else if (meta.navFields.has(key)) {
        result[key] = value;
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
    // Full flatten: the output is a new object, so the payload is read as is
    // (no private copy) — `prepareCommon`'s key preparation and stripping are
    // applied per key while flattening.
    if (meta.requiresMappings && !meta.onlyColumnRenames) {
      return this.formatWriteValues(this.flattenWritePayload(payload, meta, adapter), meta);
    }

    const data = { ...payload };
    this.prepareCommon(data, meta, adapter);

    // Column-rename-only: apply renames without full flatten
    if (meta.onlyColumnRenames) {
      for (const [logical, physical] of meta.columnMap.entries()) {
        if (logical in data) {
          data[physical] = data[logical];
          delete data[logical];
        }
      }
    }
    return this.formatWriteValues(data, meta);
  }

  translatePatchKeys(
    update: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (!meta.requiresMappings && !meta.toStorageFormatters) {
      return update;
    }

    // Column-rename-only: direct key mapping without regex/JSON handling
    if (meta.onlyColumnRenames && !meta.toStorageFormatters) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(update)) {
        result[meta.leafByLogical.get(key)?.physicalName ?? key] = update[key];
      }
      return result;
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
   * Flattens nested objects into __-separated keys and JSON-stringifies
   * @db.json / array fields — with `prepareCommon` folded in: primary-key
   * values prepared (`adapter.prepareId`), top-level ignored fields (skipped
   * by {@link writeFlattenedField}) and derived fields left out. `payload`
   * itself is not modified.
   */
  private flattenWritePayload(
    payload: Record<string, unknown>,
    meta: TableMetadata,
    adapter: BaseDbAdapter,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const primaryKeys = meta.primaryKeys;
    const root = writePlanFor(meta);
    for (const key of Object.keys(payload)) {
      if (meta.derivedFields.has(key)) {
        continue;
      }
      let value = payload[key];
      if (value !== undefined && primaryKeys.includes(key)) {
        const fieldType = meta.flatMap?.get(key);
        if (fieldType) {
          value = adapter.prepareId(value, fieldType);
        }
      }
      writeFlattenedField(root, "", key, value, result, meta);
    }
    return result;
  }
}

// ── Compiled read plan ──────────────────────────────────────────────────────

/** One stored column of the read plan (see {@link readPlanFor}). */
interface TReadColumn {
  /** Logical dot-path. */
  path: string;
  /** Parent segments of a nested (flattened / dotted json) leaf; `undefined` = set `path` directly. */
  parents?: string[];
  /** Last segment of a nested leaf. */
  last: string;
  json: boolean;
  coerce?: (value: unknown) => unknown;
  fromFmt?: (value: unknown) => unknown;
}

/** A flattened parent collapsed to `null` / `{}` when every child read null. */
interface TReadParent {
  /** Segments leading to the parent's container. */
  ancestors: string[];
  last: string;
  optional: boolean;
}

interface TReadPlan {
  columns: Map<string, TReadColumn>;
  parents: TReadParent[];
}

/**
 * Per-table read plan of {@link RelationalFieldMapper.reconstructFromRead}:
 * the per-column decisions (coercion, JSON, nesting — the dot-path pre-split)
 * and the parent-collapse list, compiled once per built metadata instead of
 * per row. Metadata is immutable after `build()`, which precedes any read.
 */
const readPlans = new WeakMap<TableMetadata, TReadPlan>();

function readPlanFor(meta: TableMetadata): TReadPlan {
  let plan = readPlans.get(meta);
  if (plan === undefined) {
    plan = compileReadPlan(meta);
    readPlans.set(meta, plan);
  }
  return plan;
}

function compileReadPlan(meta: TableMetadata): TReadPlan {
  const fromFmts = meta.fromStorageFormatters;
  const columns = new Map<string, TReadColumn>();
  for (const [physical, fd] of meta.leafByPhysical) {
    const nested = (fd.storage === "json" || fd.storage === "flattened") && fd.path.includes(".");
    const segs = nested ? fd.path.split(".") : undefined;
    columns.set(physical, {
      path: fd.path,
      parents: segs?.slice(0, -1),
      last: segs ? segs[segs.length - 1]! : fd.path,
      json: fd.storage === "json",
      coerce:
        fd.designType === "boolean"
          ? toBool
          : fd.designType === "decimal"
            ? toDecimalString
            : undefined,
      fromFmt: fromFmts?.get(physical),
    });
  }
  const parents: TReadParent[] = [];
  for (const parentPath of meta.flattenedParents) {
    const segs = parentPath.split(".");
    parents.push({
      ancestors: segs.slice(0, -1),
      last: segs[segs.length - 1]!,
      optional: !!meta.flatMap?.get(parentPath)?.optional,
    });
  }
  return { columns, parents };
}

/** If every child of a flattened parent is null / undefined, collapse it (`null` when optional, else `{}`). */
function collapseNullParent(obj: Record<string, unknown>, parent: TReadParent): void {
  let current = obj;
  const ancestors = parent.ancestors;
  for (let i = 0; i < ancestors.length; i++) {
    const next = current[ancestors[i]!];
    if (next === undefined || next === null) {
      return;
    }
    current = next as Record<string, unknown>;
  }
  const parentObj = current[parent.last];
  if (typeof parentObj !== "object" || parentObj === null) {
    return;
  }
  for (const k of Object.keys(parentObj)) {
    const v = (parentObj as Record<string, unknown>)[k];
    if (v !== null && v !== undefined) {
      return;
    }
  }
  current[parent.last] = parent.optional ? null : {};
}

// ── Compiled write plan ─────────────────────────────────────────────────────

/** How one logical path is written (see {@link writePlanFor}). */
interface TWriteNode {
  kind: "ignored" | "parent" | "json" | "leaf";
  /** Logical dot-path. */
  path: string;
  /** Physical column of a leaf / json node. */
  physical: string;
  /** Child nodes of a flattened parent, by key (filled on first use). */
  children?: Map<string, TWriteNode>;
  /** Columns a `null` / `undefined` parent sets to `null`. */
  nullChildren?: readonly string[];
}

/**
 * Per-table write plan of the relational flatten: each logical path's
 * classification (ignored / flattened parent / json / plain column) and
 * physical column, resolved once per path instead of per row (no per-key
 * path concatenation and map lookups). Only schema paths are memoised — a
 * key the metadata does not know is resolved per call, so arbitrary payload
 * keys cannot grow the plan.
 */
const writePlans = new WeakMap<TableMetadata, Map<string, TWriteNode>>();

function writePlanFor(meta: TableMetadata): Map<string, TWriteNode> {
  let root = writePlans.get(meta);
  if (root === undefined) {
    root = new Map();
    writePlans.set(meta, root);
  }
  return root;
}

function resolveWriteNode(path: string, meta: TableMetadata): { node: TWriteNode; known: boolean } {
  if (meta.ignoredFields.has(path)) {
    return { node: { kind: "ignored", path, physical: "" }, known: true };
  }
  if (meta.flattenedParents.has(path)) {
    return {
      node: {
        kind: "parent",
        path,
        physical: "",
        children: new Map(),
        nullChildren: meta.childrenByParent.get(path) ?? [],
      },
      known: true,
    };
  }
  const fd = meta.leafByLogical.get(path);
  return {
    node: {
      kind: fd?.storage === "json" ? "json" : "leaf",
      path,
      physical: fd?.physicalName ?? path.replace(/\./g, "__"),
    },
    known: fd !== undefined,
  };
}

/**
 * Classifies and writes a single field to the result object — recursing into
 * nested objects that are flattened; JSON-stringifies @db.json / array fields.
 */
function writeFlattenedField(
  level: Map<string, TWriteNode>,
  prefix: string,
  key: string,
  value: unknown,
  result: Record<string, unknown>,
  meta: TableMetadata,
): void {
  let node = level.get(key);
  if (node === undefined) {
    const resolved = resolveWriteNode(prefix ? `${prefix}.${key}` : key, meta);
    node = resolved.node;
    if (resolved.known) level.set(key, node);
  }
  switch (node.kind) {
    case "ignored": {
      return;
    }
    case "parent": {
      if (value === null || value === undefined) {
        // A null parent nulls all its flattened children.
        for (const physical of node.nullChildren!) {
          result[physical] = null;
        }
      } else if (typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        for (const childKey of Object.keys(obj)) {
          writeFlattenedField(node.children!, node.path, childKey, obj[childKey], result, meta);
        }
      }
      return;
    }
    case "json": {
      result[node.physical] = value !== undefined && value !== null ? JSON.stringify(value) : value;
      return;
    }
    default: {
      result[node.physical] = value;
    }
  }
}
