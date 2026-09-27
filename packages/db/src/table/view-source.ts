import type {
  TAtscriptAnnotatedType,
  TAtscriptTypeObject,
  TMetadataMap,
} from "@atscript/typescript/utils";
import { flattenAnnotatedType } from "@atscript/typescript/utils";

import { resolveDesignType } from "./db-readable";
import {
  documentPath,
  findAncestorInSet,
  isNavRelation,
  relationalColumnName,
} from "./table-metadata";

/**
 * Where a view reads one logical source path from, in PHYSICAL terms.
 *
 * Produced by {@link resolveViewSource} — a pure function of the source
 * table's annotated type that lays the table out with `TableMetadata`'s
 * rules (flattened `__` columns, `@db.column` renames, `@db.json` / array
 * JSON columns, document paths on nested-object adapters).
 * @since 0.1.136
 */
export interface TViewSource {
  /**
   * Physical column (relational) or document path (nested-object adapters).
   * For a path inside a JSON column this is the JSON column; for a flattened
   * object it is the object's `__` prefix (no such column exists — its leaves do).
   */
  column: string;
  /** Segments inside {@link column} when the path descends into a JSON column (relational only). */
  jsonPath?: string[];
  /** Design type of the addressed node (`string`, `number`, `object`, `array`, …; `unknown` when undeclared). */
  designType: string;
  /** Set for a relational object stored as one column per leaf. */
  flattened?: true;
  /**
   * `true` when the value may be absent: the path or an ancestor segment is
   * optional, or it reads inside a JSON-stored value.
   */
  optional: boolean;
}

/** Per-type layout index, built once per annotated type (`TableMetadata`'s build rules). */
interface TSourceIndex {
  flatMap: Map<string, TAtscriptAnnotatedType>;
  /** `@db.column` overrides by logical path. */
  columnMap: Map<string, string>;
  /** Paths without storage: `@db.ignore` fields and navigation relations. */
  unstored: Set<string>;
  /**
   * Outermost JSON-stored paths (`@db.json` objects and arrays) — arrays and
   * `@db.json` objects inside a JSON column are part of it, not separate roots.
   */
  jsonRoots: Set<string>;
  /** Outermost `@db.encrypted` paths (one opaque column each). */
  encrypted: Set<string>;
  /** Paths declared optional. */
  optional: Set<string>;
}

const indexCache = new WeakMap<TAtscriptAnnotatedType, TSourceIndex>();

function sourceIndex(type: TAtscriptAnnotatedType): TSourceIndex {
  let idx = indexCache.get(type);
  if (idx) return idx;
  idx = {
    flatMap: new Map(),
    columnMap: new Map(),
    unstored: new Set(),
    jsonRoots: new Set(),
    encrypted: new Set(),
    optional: new Set(),
  };
  if (type.type.kind === "object") {
    // `onField` runs children-first, so navigation relations are known only
    // once flattening is done — collect, then skip their descendants (their
    // annotations belong to the target table), as `TableMetadata.build` does.
    const navFields = new Set<string>();
    const collected: Array<[string, TAtscriptAnnotatedType, TMetadataMap<AtscriptMetadata>]> = [];
    idx.flatMap = flattenAnnotatedType(type as TAtscriptAnnotatedType<TAtscriptTypeObject>, {
      excludePhantomTypes: true,
      onField: (path, fieldType, metadata) => {
        if (isNavRelation(metadata)) navFields.add(path);
        collected.push([path, fieldType, metadata]);
      },
    });
    // Storage candidates, outer-first: an encrypted or JSON-stored path
    // inside another one is covered by the outer column.
    const storage: Array<[path: string, json: boolean]> = [];
    for (const [path, fieldType, metadata] of collected) {
      if (!path || findAncestorInSet(path, navFields) !== undefined) continue;
      const column = metadata.get("db.column") as string | undefined;
      if (column) idx.columnMap.set(path, column);
      if (metadata.has("db.ignore") || navFields.has(path)) idx.unstored.add(path);
      if (metadata.has("db.encrypted")) {
        storage.push([path, false]);
      } else if (metadata.has("db.json") || resolveDesignType(fieldType) === "array") {
        storage.push([path, true]);
      }
    }
    storage.sort(([a], [b]) => a.split(".").length - b.split(".").length);
    for (const [path, json] of storage) {
      if (
        findAncestorInSet(path, idx.jsonRoots) === undefined &&
        findAncestorInSet(path, idx.encrypted) === undefined
      ) {
        (json ? idx.jsonRoots : idx.encrypted).add(path);
      }
    }
    for (const [path, node] of idx.flatMap) {
      if (path && node.optional) idx.optional.add(path);
    }
  }
  indexCache.set(type, idx);
  return idx;
}

/** `path` itself if it is in `set`, else its nearest ancestor in `set`. */
function selfOrAncestor(path: string, set: ReadonlySet<string>): string | undefined {
  return set.has(path) ? path : findAncestorInSet(path, set);
}

/**
 * Resolves a LOGICAL path of a source table (a view field's chain ref, an
 * aggregate's field, a predicate operand) to where it is physically stored.
 * Internal — `AtscriptDbView.resolveRefSource` is the public entry.
 *
 * Relational rules (`TableMetadata`'s): the outermost `@db.json` or array
 * node with segments remaining is the column and the rest becomes
 * {@link TViewSource.jsonPath}; a flattened leaf is its parent segments
 * joined with `__` plus its `@db.column` (or segment); a top-level field is
 * its `@db.column` or name. Nested-object adapters use the document path
 * (only a top-level key is renamed) and never a JSON path.
 *
 * A path the type does not declare resolves to itself — the database
 * reports the unknown column, as before.
 * @throws for a path without storage (`@db.ignore`, a navigation relation,
 *   or inside one), and — relational — for a path inside an `@db.encrypted` field.
 */
export function resolveViewSource(
  sourceType: TAtscriptAnnotatedType,
  logicalPath: string,
  nestedObjects: boolean,
): TViewSource {
  const idx = sourceIndex(sourceType);
  const node = idx.flatMap.get(logicalPath);
  const jsonRoot = selfOrAncestor(logicalPath, idx.jsonRoots);
  const optional =
    selfOrAncestor(logicalPath, idx.optional) !== undefined ||
    (jsonRoot !== undefined && jsonRoot !== logicalPath);

  if (!node) {
    return { column: logicalPath, designType: "unknown", optional };
  }
  const unstored = selfOrAncestor(logicalPath, idx.unstored);
  if (unstored !== undefined) {
    throw new Error(
      `"${logicalPath}" has no column — "${unstored}" is @db.ignore or a navigation relation`,
    );
  }
  const designType = resolveDesignType(node);

  if (nestedObjects) {
    return { column: documentPath(idx.columnMap, logicalPath), designType, optional };
  }

  const encrypted = findAncestorInSet(logicalPath, idx.encrypted);
  if (encrypted !== undefined) {
    throw new Error(
      `"${logicalPath}" is inside the @db.encrypted field "${encrypted}" — reference "${encrypted}" itself`,
    );
  }
  if (jsonRoot !== undefined) {
    const column = relationalColumnName(
      jsonRoot,
      idx.columnMap.get(jsonRoot),
      jsonRoot.includes("."),
    );
    return jsonRoot === logicalPath
      ? { column, designType, optional }
      : {
          column,
          jsonPath: logicalPath.slice(jsonRoot.length + 1).split("."),
          designType,
          optional,
        };
  }
  if (designType === "object" && !idx.encrypted.has(logicalPath)) {
    return { column: logicalPath.replace(/\./g, "__"), designType, flattened: true, optional };
  }
  return {
    column: relationalColumnName(
      logicalPath,
      idx.columnMap.get(logicalPath),
      logicalPath.includes("."),
    ),
    designType,
    optional,
  };
}
