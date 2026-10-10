import type {
  TAtscriptAnnotatedType,
  TAtscriptTypeObject,
  TMetadataMap,
} from "@atscript/typescript/utils";
import { flattenAnnotatedType, isAnnotatedType } from "@atscript/typescript/utils";

import { tableNameOf } from "../rel/relation-helpers";
import { pathPresence } from "../shared/union-shape";
import { resolveDesignType } from "./db-readable";
import {
  columnOverrideApplies,
  documentPath,
  findAncestorInSet,
  isNavRelation,
  isStructuredMixedUnion,
  relationalColumnName,
  selfOrAncestor,
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

/**
 * A view source as a view plan addresses it: a table, a view (managed or
 * external) or a `@db.alias` type over one of them.
 * @since 0.1.141
 */
export interface TViewSourceRef {
  /**
   * Scope name — how join conditions, filters and column mappings refer to
   * the source: the physical {@link table} name, or the alias's type name
   * for a `@db.alias` type.
   */
  name: string;
  /** Physical table or view name (`tableNameOf` of the aliased type). */
  table: string;
  /** The table / view type that declares the columns (the alias target for an alias). */
  type: TAtscriptAnnotatedType;
  /** Set when `name` is a `@db.alias` type name rather than the physical name. */
  alias?: true;
}

/** Resolves a compiled type reference (a class, a lazy `() => T`, or `{ type: () => T }`). */
function resolveTypeRef(value: unknown): TAtscriptAnnotatedType | undefined {
  if (isAnnotatedType(value)) return value;
  if (typeof value === "function") {
    const resolved = (value as () => unknown)();
    return isAnnotatedType(resolved) ? resolved : undefined;
  }
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "function"
  ) {
    return resolveTypeRef((value as { type: () => unknown }).type);
  }
  return undefined;
}

/**
 * The table / view a `@db.alias` type stands for, or `undefined` when `type`
 * is not an alias.
 * @since 0.1.141
 */
export function aliasTargetOf(
  type: TAtscriptAnnotatedType | undefined,
): TAtscriptAnnotatedType | undefined {
  const target = type?.metadata?.get("db.alias" as never);
  if (target === undefined) return undefined;
  const resolved = resolveTypeRef(target);
  if (!resolved) {
    throw new Error(`@db.alias of "${type?.id ?? ""}" does not resolve to an annotated type`);
  }
  return resolved;
}

/**
 * How a view plan addresses a source type: a plain table or view is scoped
 * by its physical name; a `@db.alias` type is scoped by its own type name
 * over the aliased table / view (`JOIN "employees" AS "Manager"`).
 * @since 0.1.141
 */
export function viewSourceOf(type: TAtscriptAnnotatedType): TViewSourceRef {
  const target = aliasTargetOf(type);
  if (!target) {
    const table = tableNameOf(type);
    return { name: table, table, type };
  }
  if (aliasTargetOf(target)) {
    throw new Error(
      `@db.alias "${type.id ?? ""}" targets "${target.id ?? ""}", which is itself a @db.alias — alias the table or view directly`,
    );
  }
  return { name: type.id ?? "", table: tableNameOf(target), type: target, alias: true };
}

/** Per-type layout index, built once per annotated type (`TableMetadata`'s build rules). */
interface TSourceIndex {
  flatMap: Map<string, TAtscriptAnnotatedType>;
  /** `@db.column` overrides by logical path (relational layout). */
  columnMap: Map<string, string>;
  /** The overrides a document applies — top-level only ({@link columnOverrideApplies}). */
  documentColumnMap: Map<string, string>;
  /** Paths without storage: `@db.ignore` fields and navigation relations. */
  unstored: Set<string>;
  /**
   * Outermost JSON-stored paths (`@db.json` objects and arrays) — arrays and
   * `@db.json` objects inside a JSON column are part of it, not separate roots.
   */
  jsonRoots: Set<string>;
  /** Outermost `@db.encrypted` paths (one opaque column each). */
  encrypted: Set<string>;
  /** Paths declared optional (the fallback of {@link pathPresence} inside an array). */
  optional: Set<string>;
  /** `@db.column.derived` paths → the JSON-leaf source path they read (since 0.1.141). */
  derived: Map<string, string>;
}

const indexCache = new WeakMap<TAtscriptAnnotatedType, TSourceIndex>();

function sourceIndex(type: TAtscriptAnnotatedType): TSourceIndex {
  let idx = indexCache.get(type);
  if (idx) return idx;
  idx = {
    flatMap: new Map(),
    columnMap: new Map(),
    documentColumnMap: new Map(),
    unstored: new Set(),
    jsonRoots: new Set(),
    encrypted: new Set(),
    optional: new Set(),
    derived: new Map(),
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
      if (column) {
        idx.columnMap.set(path, column);
        if (columnOverrideApplies(path, true)) idx.documentColumnMap.set(path, column);
      }
      if (metadata.has("db.ignore") || navFields.has(path)) idx.unstored.add(path);
      if (metadata.has("db.column.derived") && fieldType.ref?.field) {
        idx.derived.set(path, fieldType.ref.field);
      }
      if (metadata.has("db.encrypted")) {
        storage.push([path, false]);
      } else if (
        metadata.has("db.json") ||
        resolveDesignType(fieldType) === "array" ||
        isStructuredMixedUnion(fieldType)
      ) {
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

/**
 * The read seals a view column inherits from the source path it reads
 * (since 0.1.143): `writeOnly` when the path or any ancestor object is
 * `@db.writeOnly` (a leaf of a sealed object is sealed too); `encrypted` when
 * the path itself is `@db.encrypted` (it reads the ciphertext column).
 * Reads the source's live field metadata, so a source VIEW whose own fields
 * inherited a seal (see `inheritViewFieldSeals`) passes it on.
 * @since 0.1.143
 */
export function sourceFieldSeals(
  sourceType: TAtscriptAnnotatedType,
  logicalPath: string,
): { writeOnly: boolean; encrypted: boolean } {
  const { flatMap } = sourceIndex(sourceType);
  // Top-level props are read off the type itself: a seal stamped after the
  // (cached) index was built is on the prop, not on a flat-union copy.
  const props = sourceType.type.kind === "object" ? sourceType.type.props : undefined;
  const seals = { writeOnly: false, encrypted: false };
  let prefix = "";
  for (const segment of logicalPath.split(".")) {
    const node = prefix ? flatMap.get(`${prefix}.${segment}`) : props?.get(segment);
    prefix = prefix ? `${prefix}.${segment}` : segment;
    const metadata = node?.metadata;
    if (!metadata) break;
    if (metadata.has("db.writeOnly")) seals.writeOnly = true;
    if (prefix === logicalPath && metadata.has("db.encrypted")) seals.encrypted = true;
  }
  return seals;
}

/**
 * The annotations of one LOGICAL path of a source table (`undefined` for a
 * path the type does not declare).
 * @since 0.1.153
 */
export function sourceFieldMetadata(
  sourceType: TAtscriptAnnotatedType,
  logicalPath: string,
): TMetadataMap<AtscriptMetadata> | undefined {
  return sourceIndex(sourceType).flatMap.get(logicalPath)?.metadata as
    | TMetadataMap<AtscriptMetadata>
    | undefined;
}

/**
 * Resolves a LOGICAL path of a source table (a view field's chain ref, an
 * aggregate's field, a predicate operand) to where it is physically stored.
 * Internal — `AtscriptDbView.resolveRefSource` is the public entry.
 *
 * Relational rules (`TableMetadata`'s): the outermost `@db.json`, array or
 * structured mixed union (`isStructuredMixedUnion`) node with segments remaining is the column and the rest becomes
 * {@link TViewSource.jsonPath}; a flattened leaf is its parent segments
 * joined with `__` plus its `@db.column` (or segment); a top-level field is
 * its `@db.column` or name. Nested-object adapters use the document path
 * (only a top-level key is renamed) and never a JSON path.
 *
 * A `@db.column.derived` path (since 0.1.141) resolves to its generated
 * column on relational adapters and to its JSON-leaf source path on
 * nested-object adapters — always optional (the extraction yields NULL for a
 * missing or off-type leaf).
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
  const derivedSource = idx.derived.get(logicalPath);
  if (node && derivedSource !== undefined) {
    if (nestedObjects) {
      return { ...resolveViewSource(sourceType, derivedSource, true), optional: true };
    }
    return {
      column: relationalColumnName(logicalPath, idx.columnMap.get(logicalPath), false),
      designType: resolveDesignType(node),
      optional: true,
    };
  }
  const jsonRoot = selfOrAncestor(logicalPath, idx.jsonRoots);
  const presence = pathPresence(sourceType, logicalPath);
  const optional =
    (presence === undefined
      ? selfOrAncestor(logicalPath, idx.optional) !== undefined
      : presence !== "required") ||
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
    return { column: documentPath(idx.documentColumnMap, logicalPath), designType, optional };
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
