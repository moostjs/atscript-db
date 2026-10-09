import {
  flattenAnnotatedType,
  type AtscriptQueryNode,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeObject,
  type TMetadataMap,
} from "@atscript/typescript/utils";

import type { BaseDbAdapter } from "../base-adapter";
import type { TRelationFilterHost } from "../query/relation-filter";
import type { TGenericLogger } from "../logger";
import { isJsonValueField } from "../query/buckets";
import { computedOperands } from "../query/query-tree";
import { tableNameOf } from "../rel/relation-helpers";
import { resolveDesignType, resolveDefaultFromMetadata } from "./db-readable";
import { resolveViewSource } from "./view-source";
import { DERIVED_INCOMPATIBLE, isJsonLeafType } from "../shared/derived-rules";
import { findAncestorInSet, selfOrAncestor } from "../shared/object";
import { searchMemberKind } from "../shared/search-fields";
import type {
  TDbCollation,
  TDbDefaultValue,
  TDerivedColumn,
  TDbFieldMeta,
  TDbForeignKey,
  TDbIndex,
  TDbIndexField,
  TDbRelation,
  TDbStorageType,
  TIdentification,
  TMetadataOverrides,
} from "../types";

const INDEX_PREFIX = "atscript__";

function indexKey(type: string, name: string): string {
  const cleanName = name
    .replace(/[^a-z0-9_.-]/gi, "_")
    .replace(/_+/g, "_")
    .slice(0, 127 - INDEX_PREFIX.length - type.length - 2);
  return `${INDEX_PREFIX}${type}__${cleanName}`;
}

// The dot-path set helpers live in the dependency-free `shared/object`
// (the field mappers need them too); re-exported here, where they always were.
export { findAncestorInSet, selfOrAncestor };

/**
 * Whether a `@db.column` / `@db.column.renamed` on `path` applies: always on
 * relational storage; on document storage (`nestedObjects`) for top-level
 * fields only — nested keys are stored as-is. Column maps are built with it.
 */
export function columnOverrideApplies(path: string, nestedObjects: boolean): boolean {
  return !nestedObjects || !path.includes(".");
}

/**
 * Logical field path → its physical path in document storage (nested
 * objects kept inline). A document renames the TOP-LEVEL key only — nested
 * keys are stored as-is, so a `@db.column` on a nested leaf renames nothing
 * (`address.zip` stays `address.zip`; see {@link columnOverrideApplies}) —
 * and a dotted path under a renamed top-level object renames its first
 * segment: `profile.bio` under `@db.column 'prof'` → `prof.bio`.
 */
export function documentPath(columnMap: ReadonlyMap<string, string>, path: string): string {
  const dot = path.indexOf(".");
  if (dot === -1) return columnMap.get(path) ?? path;
  const top = columnMap.get(path.slice(0, dot));
  return top === undefined ? path : top + path.slice(dot);
}

/** The `__`-separated parent prefix of a dotted path (`a.b.c` → `a__b__`), `""` for a top-level path. */
export function flattenedPrefix(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 ? `${path.slice(0, lastDot).replace(/\./g, "__")}__` : "";
}

/**
 * Relational column of a column-stored path: a top-level field is its
 * `@db.column` (`override`) or its name; a leaf of a `flattened` object is
 * its parent segments joined with `__` plus its `@db.column` or own segment
 * (`address.zip` with `@db.column 'zip_code'` → `address__zip_code`).
 */
export function relationalColumnName(
  path: string,
  override: string | undefined,
  flattened: boolean,
): string {
  if (override) return flattened ? flattenedPrefix(path) + override : override;
  return flattened ? path.replace(/\./g, "__") : path;
}

/** Returns true if `metadata` indicates a navigation relation field. */
export function isNavRelation(metadata: TMetadataMap<AtscriptMetadata>): boolean {
  return metadata.has("db.rel.to") || metadata.has("db.rel.from") || metadata.has("db.rel.via");
}

/** Returns true if the annotated type IS the `db.geoPoint` primitive (tag-based). */
export function isGeoPointType(fieldType: TAtscriptAnnotatedType): boolean {
  const tags = (fieldType.type as { tags?: ReadonlySet<string> }).tags;
  return tags?.has("geoPoint") === true;
}

/**
 * Returns true if the annotated type is acceptable for `@db.index.geo`:
 * the `db.geoPoint` primitive or a structurally identical `number[]`
 * (excluding `db.vector`, which is semantically an embedding).
 */
export function isGeoIndexableType(fieldType: TAtscriptAnnotatedType): boolean {
  if (isGeoPointType(fieldType)) {
    return true;
  }
  const tags = (fieldType.type as { tags?: ReadonlySet<string> }).tags;
  if (tags?.has("vector")) {
    return false;
  }
  if (fieldType.type.kind === "array") {
    const of = (fieldType.type as unknown as { of?: TAtscriptAnnotatedType }).of;
    return !!of && resolveDesignType(of) === "number";
  }
  return false;
}

/** A referenced type's flattened field map, memoized per metadata build. */
type TFlatOf = (type: TAtscriptAnnotatedType) => Map<string, TAtscriptAnnotatedType>;

/** Runtime mirror of the `@db.column.version.exempt` placement errors. */
function rejectVersionExempt(path: string, why: string): never {
  throw new Error(`@db.column.version.exempt on "${path}": ${why}`);
}

/** One `flattenAnnotatedType` `onField` call, in firing order. */
interface TCollectedField {
  path: string;
  type: TAtscriptAnnotatedType;
  metadata: TMetadataMap<AtscriptMetadata>;
  /** A union / tuple / intersection member fired at its prop's path. */
  member?: boolean;
}

/**
 * When `fieldType` is a union / tuple / intersection, marks the entries its
 * items already fired at the same `path` (onField is post-order) as members.
 */
function markComplexMembers(
  collected: TCollectedField[],
  path: string,
  fieldType: TAtscriptAnnotatedType,
): void {
  const kind = fieldType.type.kind;
  if (kind !== "union" && kind !== "tuple" && kind !== "intersection") return;
  const items = new Set((fieldType.type as { items: TAtscriptAnnotatedType[] }).items);
  const childPrefix = `${path}.`;
  for (let i = collected.length - 1; i >= 0; i--) {
    const entry = collected[i]!;
    if (entry.path === path) {
      if (items.has(entry.type)) entry.member = true;
    } else if (!entry.path.startsWith(childPrefix)) {
      break;
    }
  }
}

/** A built-in primitive inlined as a member (`number.int | null`), not a named alias. */
function isInlinePrimitive(type: TAtscriptAnnotatedType): boolean {
  return type.type.kind === "" && type.ref === undefined;
}

/**
 * Computed metadata for a database table or view.
 *
 * Contains all field metadata, physical mapping indexes, relation definitions,
 * and constraint information derived from Atscript annotations. Built lazily
 * on first access via {@link build}, then immutable.
 *
 * This class owns the build pipeline that was previously part of
 * `AtscriptDbReadable._flatten()`. The Readable delegates all metadata
 * access to this class.
 */
export class TableMetadata {
  // ── Adapter capability (set in constructor) ──────────────────────────────

  readonly nestedObjects: boolean;

  // ── Canonical data — populated during build() ────────────────────────────

  flatMap!: Map<string, TAtscriptAnnotatedType>;
  fieldDescriptors!: readonly TDbFieldMeta[];
  /**
   * The descriptors schema sync manages as columns of this table: the
   * non-ignored ones — on nested-object adapters without the
   * `@db.column.derived` fields, which store nothing there (their
   * `physicalName` is the source's document path). The desired side of every
   * column diff and the column list of a fresh create.
   * @since 0.1.141
   */
  columnDescriptors: readonly TDbFieldMeta[] = [];
  /**
   * The columns that hold a value of their own — non-ignored and not derived
   * (a generated column is computed, never assigned): what a table recreation
   * copies and a full replace assigns.
   * @since 0.1.141
   */
  storedDescriptors: readonly TDbFieldMeta[] = [];
  primaryKeys: string[] = [];
  preferredId: string[] = [];
  originalMetaIdFields: string[] = [];
  indexes = new Map<string, TDbIndex>();
  foreignKeys = new Map<string, TDbForeignKey>();
  relations = new Map<string, TDbRelation>();
  navFields = new Set<string>();
  ignoredFields = new Set<string>();
  uniqueProps = new Set<string>();
  /** Adapter-contributed multi-field unique keys (logical paths) — see `TMetadataOverrides.addUniqueKeys`. */
  uniqueKeys: string[][] = [];
  defaults = new Map<string, TDbDefaultValue>();
  /** Logical path → `@db.column` override (top-level keys only on document storage). */
  columnMap = new Map<string, string>();
  dimensions: string[] = [];
  measures: string[] = [];
  /** Logical field name annotated with `@db.column.version`, if any. */
  versionField?: string;
  /** Paths annotated with `@db.column.version.exempt`, as declared (since 0.1.150). */
  private _versionExemptDeclared = new Set<string>();
  /**
   * Version-exempt paths (since 0.1.150): the declared ones plus every object
   * whose direct children are all exempt (upward closure). A path is exempt
   * when it, or an ancestor, is in this set — see {@link isVersionExemptPath}.
   * Empty when the table declares no `@db.column.version`.
   */
  versionExemptPaths: ReadonlySet<string> = new Set();
  /** path → sibling-ref path for `@db.amount.currency.ref` / `@db.unit.ref`. */
  quantityRefByField = new Map<string, string>();
  /** Logical paths annotated with `@db.encrypted` — stored as one opaque ciphertext column. */
  encryptedFields = new Set<string>();
  /**
   * `@db.column.derived` fields (top-level logical name → what they read),
   * since 0.1.141. A generated column on relational adapters; on nested-object
   * adapters nothing is stored — {@link physicalPath} maps the name to the
   * source's document path and reads fill the field from it.
   */
  derivedFields = new Map<string, TDerivedColumn>();

  // ── Hot-path lookup indexes — derived during build() ─────────────────────

  pathToPhysical = new Map<string, string>();
  physicalToPath = new Map<string, string>();
  flattenedParents = new Set<string>();
  jsonFields = new Set<string>();
  selectExpansion = new Map<string, string[]>();
  booleanFields = new Set<string>();
  decimalFields = new Set<string>();
  allPhysicalFields: string[] = [];
  /** Precomputed parent path → child physical column names for fast null-setting. */
  childrenByParent = new Map<string, string[]>();
  /** Precomputed parent path → optional child logical paths (replace-strategy null-fill in the patch decomposer). */
  optionalLeavesByLogicalParent = new Map<string, string[]>();
  requiresMappings = false;
  /** True when the only mappings needed are simple `@db.column` renames (no nesting/JSON). */
  onlyColumnRenames = false;
  toStorageFormatters?: Map<string, (value: unknown) => unknown>;
  fromStorageFormatters?: Map<string, (value: unknown) => unknown>;

  // ── Unified leaf field indexes — derived from fieldDescriptors ──────────

  /** Leaf field descriptors indexed by physical column name (read path). */
  leafByPhysical = new Map<string, TDbFieldMeta>();
  /** Leaf field descriptors indexed by logical path (write/patch/filter paths). */
  leafByLogical = new Map<string, TDbFieldMeta>();

  // ── Query-guard indexes — derived from fieldDescriptors for EVERY adapter ──

  /**
   * Non-ignored field descriptors keyed by logical path, excluding navigation
   * relations and their descendants. Unlike `leafByLogical` (relational
   * adapters only) this is built for every adapter, so the core path guard
   * (`guardPaths`) can answer "does this path have physical storage here?"
   * on nested-object adapters too.
   */
  descriptorByPath = new Map<string, TDbFieldMeta>();
  /**
   * Logical paths stored as a single JSON column (`storage === 'json'`,
   * non-ignored descriptors). Retained after build — unlike the build-time
   * `jsonFields` set — so the path guard can classify JSON descendants on
   * relational adapters. Empty on nested-object adapters (they keep native
   * dotted paths as descriptors).
   */
  jsonParents: ReadonlySet<string> = new Set<string>();
  /**
   * Logical paths holding a JSON value (`isJsonValueField`: JSON-stored, `json`
   * or `array` design type; non-ignored, nav-free descriptors) — a timestamp
   * beneath one is never a calendar-bucket source (`jsonValueAncestor`).
   */
  jsonValueParents: ReadonlySet<string> = new Set<string>();
  /** Every field descriptor's `physicalName` — reserved names a bucket alias may not take. */
  physicalNames: ReadonlySet<string> = new Set<string>();

  /**
   * Resolves / guards relational filter predicates (`{ nav: { $some: … } }`)
   * against the related tables — installed by the owning readable when the
   * table has navigation fields and a table resolver (a `DbSpace`). The field
   * mappers and the path guard reach the related tables through it.
   * @since 0.1.147
   */
  relationFilters?: TRelationFilterHost;

  // ── Build state ──────────────────────────────────────────────────────────

  private _built = false;
  private _identifications?: readonly TIdentification[];
  private _alwaysAddressable?: ReadonlySet<string>;

  // Intermediate build-time maps (not exposed after build)
  private _collateMap = new Map<string, TDbCollation>();
  private _columnFromMap = new Map<string, string>();

  constructor(nestedObjects: boolean) {
    this.nestedObjects = nestedObjects;
  }

  get isBuilt(): boolean {
    return this._built;
  }

  /**
   * {@link documentPath} over this table's `columnMap`. A `@db.column.derived`
   * field has no stored path of its own: it maps to its source leaf.
   */
  documentPath(path: string): string {
    return documentPath(this.columnMap, this.derivedFields.get(path)?.sourcePath ?? path);
  }

  /**
   * Physical name of a logical path: the document path on nested-object
   * adapters, else the relational column (`pathToPhysical`, then the
   * `@db.column` override).
   */
  physicalPath(logical: string): string {
    if (this.nestedObjects) return this.documentPath(logical);
    return this.pathToPhysical.get(logical) ?? this.columnMap.get(logical) ?? logical;
  }

  /**
   * Drops the `@db.column.derived` keys of a write payload in place (a
   * derived field is always top-level): the column is computed from the row
   * and never written, so a row read back can be written back as-is.
   * @since 0.1.141
   */
  stripDerived(data: Record<string, unknown>): void {
    for (const field of this.derivedFields.keys()) {
      delete data[field];
    }
  }

  // ── Build pipeline ───────────────────────────────────────────────────────

  /**
   * Runs the full metadata compilation pipeline. Called once by
   * `AtscriptDbReadable._ensureBuilt()` on first metadata access.
   *
   * Pipeline steps:
   * 1. `adapter.onBeforeFlatten(type)` — adapter hook
   * 2. `flattenAnnotatedType()` — collect field tuples, detect nav fields eagerly
   * 3. Replay non-nav-descendant tuples through annotation scanning + adapter.onFieldScanned
   * 4. Classify fields and build path maps (skipped for nested-objects adapters)
   * 5. `adapter.getMetadataOverrides()` → `_applyOverrides()` (PK/unique/inject adjustments)
   * 6. Build field descriptors (TDbFieldMeta[])
   * 7. Build leaf field indexes (skipped for nested-objects adapters)
   * 8. Finalize indexes (resolve field names to physical)
   * 9. `adapter.onAfterFlatten()` — adapter hook (read-only bookkeeping)
   * 10. Build allPhysicalFields list
   */
  build(
    type: TAtscriptAnnotatedType<TAtscriptTypeObject>,
    adapter: BaseDbAdapter,
    logger: TGenericLogger,
  ): void {
    if (this._built) {
      return;
    }

    adapter.onBeforeFlatten?.(type);

    // Phase 1: Collect field tuples. flattenAnnotatedType fires onField
    // post-order — children before parent — so nav fields (whose descendants
    // Phase 2 skips) and union / tuple members are known only afterwards.
    const collected: TCollectedField[] = [];

    this.flatMap = flattenAnnotatedType(type, {
      topLevelArrayTag: adapter.getTopLevelArrayTag?.() ?? "db.__topLevelArray",
      excludePhantomTypes: true,
      onField: (path, fieldType, metadata) => {
        markComplexMembers(collected, path, fieldType);
        collected.push({ path, type: fieldType, metadata });
      },
    });
    for (const entry of collected) {
      if (!entry.member && isNavRelation(entry.metadata)) {
        this.navFields.add(entry.path);
      }
    }
    this._dropMemberMetadata(collected);

    // Phase 2: Scan only non-nav-descendant fields into metadata maps.
    // Nav descendants remain in flatMap (validation needs them) but never
    // pollute primaryKeys, defaults, indexes, foreignKeys, etc. They are the
    // target's fields, never columns of this table: `ignored`, like the nav
    // field itself, so a document adapter's descriptors (which keep the
    // nested shape) leave them out of `columnDescriptors`, the snapshot and
    // the plan — relational storage drops the subtree anyway.
    for (const entry of collected) {
      if (findAncestorInSet(entry.path, this.navFields) !== undefined) {
        this.ignoredFields.add(entry.path);
        continue;
      }
      // A union / tuple member shares its prop's path but is no column of its
      // own: only the prop's annotations describe the column.
      if (entry.member) {
        continue;
      }
      this._scanGenericAnnotations(entry.path, entry.type, entry.metadata, logger);
      // @db.column.derived — a scalar computed from a JSON leaf of the same row
      if (entry.metadata.has("db.column.derived")) {
        this.derivedFields.set(
          entry.path,
          this._validateDerivedField(entry.path, entry.type, entry.metadata, type),
        );
      }
      adapter.onFieldScanned?.(entry.path, entry.type, entry.metadata);
    }

    // Drop encrypted entries nested under another encrypted field — the
    // ancestor's single ciphertext column already covers them.
    for (const path of this.encryptedFields) {
      if (findAncestorInSet(path, this.encryptedFields) !== undefined) {
        this.encryptedFields.delete(path);
      }
    }

    // Classify fields and build path maps (before finalizing indexes)
    if (!this.nestedObjects) {
      this._classifyFields();
    }

    // Apply adapter-provided metadata overrides (PK adjustments, synthetic fields, etc.)
    // before building field descriptors — so isPrimaryKey on descriptors is accurate.
    const overrides = adapter.getMetadataOverrides?.(this);
    if (overrides) {
      this._applyOverrides(overrides);
    }

    // Build field descriptors unconditionally — schema sync needs them
    // even for adapters that support nested objects (e.g. MongoDB).
    // _buildFieldDescriptors() already handles skipFlattening internally.
    this._buildFieldDescriptors(adapter, type);

    // Path-guard indexes are adapter-independent: every adapter has descriptors.
    this._buildGuardIndexes();

    // Build leaf field indexes for unified read/write classification
    if (!this.nestedObjects) {
      this._buildLeafIndexes();
    }

    // Build identifications BEFORE _finalizeIndexes mutates index field names
    // from logical → physical, so the captured field lists stay logical.
    this._buildIdentifications();
    this._resolvePreferredId(type);
    this._alwaysAddressable = new Set([
      ...this.primaryKeys,
      ...this.preferredId,
      ...this.originalMetaIdFields,
    ]);
    this._finalizeIndexes();

    this._finalizeVersionExempt();

    // Release intermediate build-time maps
    this._collateMap.clear();
    this._columnFromMap.clear();
    this.jsonFields.clear();

    // Mark built BEFORE adapter.onAfterFlatten() — the adapter hook may access
    // metadata via public getters (e.g. MongoAdapter reads this._table.flatMap),
    // which call _ensureBuilt(). Without this flag, that triggers infinite recursion.
    this._built = true;

    adapter.onAfterFlatten?.();

    // Build physical field list for UniquSelect exclusion inversion.
    // Skip nav-relation fields and their descendants — they aren't selectable
    // columns on this table, so they must not appear in an inverted SELECT list.
    if (this.nestedObjects) {
      // `columnDescriptors` is nav-free (nav fields and their descendants are
      // `ignored`). A derived field is not stored on a document adapter — its
      // source path is already listed, and it is filled from it after the read.
      for (const fd of this.columnDescriptors) {
        this.allPhysicalFields.push(fd.physicalName);
      }
    } else {
      for (const [path, physical] of this.pathToPhysical) {
        if (this.navFields.has(path)) continue;
        if (findAncestorInSet(path, this.navFields) !== undefined) continue;
        this.allPhysicalFields.push(physical);
      }
    }
  }

  // ── Private: union / tuple member metadata ──────────────────────────────

  /**
   * `flattenAnnotatedType` merges the metadata of every union / tuple member
   * into the synthetic flat entry of the prop's path, so a member's
   * annotations would reach the column (DDL type, size, default). Since
   * atscript 0.1.103 a built-in primitive member carries its built-in
   * annotations (`number.timestamp.created | null` → `@db.default.now`,
   * `string.char` → `@expect.maxLength 1`). Rebuild such an entry from the
   * prop's own annotations plus the non-`db.*` annotations of named members
   * (aliases, interfaces), so the column is described as before 0.1.103.
   */
  private _dropMemberMetadata(collected: readonly TCollectedField[]): void {
    const byPath = new Map<string, TCollectedField[]>();
    for (const entry of collected) {
      const list = byPath.get(entry.path);
      if (list) list.push(entry);
      else byPath.set(entry.path, [entry]);
    }
    for (const [path, entries] of byPath) {
      if (!entries.some((e) => e.member)) continue;
      const flat = this.flatMap.get(path) as
        | (TAtscriptAnnotatedType & { __flat_union?: boolean })
        | undefined;
      if (!flat?.__flat_union) continue;
      // The synthetic entry's map is its own (no member shares it): refill in place.
      const target = flat.metadata as Map<string, unknown>;
      target.clear();
      for (const entry of entries) {
        if (entry.member && isInlinePrimitive(entry.type)) continue;
        for (const [key, value] of entry.metadata) {
          if (!entry.member || !key.startsWith("db.")) target.set(key, value);
        }
      }
    }
  }

  // ── Private: apply metadata overrides ───────────────────────────────────

  /**
   * Applies adapter-provided metadata overrides atomically.
   * Processing order: injectFields → removePrimaryKeys → addPrimaryKeys → addUniqueFields.
   */
  private _applyOverrides(overrides: TMetadataOverrides): void {
    if (overrides.injectFields) {
      for (const { path, type } of overrides.injectFields) {
        this.flatMap.set(path, type);
      }
    }

    if (overrides.removePrimaryKeys) {
      for (const field of overrides.removePrimaryKeys) {
        const idx = this.primaryKeys.indexOf(field);
        if (idx >= 0) {
          this.primaryKeys.splice(idx, 1);
        }
      }
    }

    if (overrides.addPrimaryKeys) {
      for (const field of overrides.addPrimaryKeys) {
        if (!this.primaryKeys.includes(field)) {
          this.primaryKeys.push(field);
        }
      }
    }

    if (overrides.addUniqueFields) {
      for (const field of overrides.addUniqueFields) {
        this.uniqueProps.add(field);
      }
    }

    if (overrides.addUniqueKeys) {
      this.uniqueKeys.push(...overrides.addUniqueKeys.map((key) => [...key]));
    }
  }

  // ── Private: annotation scanning ─────────────────────────────────────────

  /**
   * Scans `@db.*` and `@meta.id` annotations on a field during flattening.
   */
  private _scanGenericAnnotations(
    fieldName: string,
    fieldType: TAtscriptAnnotatedType,
    metadata: TMetadataMap<AtscriptMetadata>,
    logger: TGenericLogger,
  ): void {
    // @meta.id → primary key
    if (metadata.has("meta.id")) {
      this.primaryKeys.push(fieldName);
      this.originalMetaIdFields.push(fieldName);
    }

    // @db.column → column mapping (a nested one is ignored on document storage)
    const renamable = columnOverrideApplies(fieldName, this.nestedObjects);
    const column = metadata.get("db.column") as string | undefined;
    if (column && renamable) {
      this.columnMap.set(fieldName, column);
    }

    // @db.column.renamed → rename mapping (intermediate, consumed by _buildFieldDescriptors)
    const columnFrom = metadata.get("db.column.renamed") as string | undefined;
    if (columnFrom && renamable) {
      this._columnFromMap.set(fieldName, columnFrom);
    }

    // @db.default or @db.default.increment/uuid/now
    const resolvedDefault = resolveDefaultFromMetadata(metadata);
    if (resolvedDefault) {
      this.defaults.set(fieldName, resolvedDefault);
    }

    // @db.ignore
    if (metadata.has("db.ignore")) {
      this.ignoredFields.add(fieldName);
    }

    // @db.rel.to / @db.rel.from / @db.rel.via → navigational field, not a stored column
    if (isNavRelation(metadata)) {
      this.navFields.add(fieldName);
      this.ignoredFields.add(fieldName);

      const direction = metadata.has("db.rel.to")
        ? ("to" as const)
        : metadata.has("db.rel.from")
          ? ("from" as const)
          : ("via" as const);
      const raw =
        direction === "via" ? metadata.get("db.rel.via") : metadata.get(`db.rel.${direction}`);
      const alias = (raw === true || typeof raw === "function" ? undefined : raw) as
        | string
        | undefined;
      const isArr = fieldType.type.kind === "array";
      const elementType = isArr
        ? (fieldType.type as unknown as { of: TAtscriptAnnotatedType }).of
        : fieldType;
      const resolveTarget = () => elementType?.ref?.type() ?? elementType;
      const relFilter = metadata.get("db.rel.filter") as AtscriptQueryNode | undefined;
      this.relations.set(fieldName, {
        direction,
        alias,
        targetType: resolveTarget,
        isArray: isArr,
        ...(direction === "via" ? { viaType: raw as () => TAtscriptAnnotatedType } : {}),
        ...(metadata.has("db.rel.filterable") ? { filterable: true } : {}),
        ...(relFilter ? { filter: relFilter } : {}),
      });
    }

    // @db.rel.FK → foreign key constraint metadata
    if (metadata.has("db.rel.FK")) {
      const raw = metadata.get("db.rel.FK");
      const alias = (raw === true ? undefined : raw) as string | undefined;
      if (fieldType.ref) {
        const targetTable = tableNameOf(fieldType.ref.type());
        const targetField = fieldType.ref.field;
        const key = alias || `__auto_${fieldName}`;
        const existing = this.foreignKeys.get(key);
        if (existing) {
          existing.fields.push(fieldName);
          existing.targetFields.push(targetField);
        } else {
          this.foreignKeys.set(key, {
            fields: [fieldName],
            targetTable,
            targetFields: [targetField],
            targetTypeRef: fieldType.ref.type,
            alias,
          });
        }
      }
    }

    // @db.rel.onDelete / @db.rel.onUpdate → referential actions on FK
    const onDelete = metadata.get("db.rel.onDelete") as string | undefined;
    const onUpdate = metadata.get("db.rel.onUpdate") as string | undefined;
    if (onDelete || onUpdate) {
      for (const fk of this.foreignKeys.values()) {
        if (fk.fields.includes(fieldName)) {
          if (onDelete) {
            fk.onDelete = onDelete as TDbForeignKey["onDelete"];
          }
          if (onUpdate) {
            fk.onUpdate = onUpdate as TDbForeignKey["onUpdate"];
          }
          break;
        }
      }
    }

    // @db.index.plain
    for (const index of (metadata.get("db.index.plain") as any[]) || []) {
      const name = index === true ? fieldName : index?.name || fieldName;
      const sort = (index === true ? undefined : index?.sort) || "asc";
      this._addIndexField("plain", name, fieldName, { sort: sort as "asc" | "desc" });
    }

    // @db.index.unique (single arg → raw string or { name })
    for (const index of (metadata.get("db.index.unique") as any[]) || []) {
      const name =
        index === true ? fieldName : typeof index === "string" ? index : index?.name || fieldName;
      this._addIndexField("unique", name, fieldName);
    }

    // @db.column.searchable / @db.index.fulltext — string or integer members only
    if (
      metadata.has("db.writeOnly") &&
      (metadata.has("db.index.fulltext") || metadata.has("db.column.searchable"))
    ) {
      const which = metadata.has("db.index.fulltext")
        ? "@db.index.fulltext"
        : "@db.column.searchable";
      throw new Error(
        `@db.writeOnly cannot coexist with ${which} on "${fieldName}" — search results would reveal the sealed value`,
      );
    }
    const searchKind = searchMemberKind(fieldType);
    if (typeof searchKind === "object") {
      if (metadata.has("db.index.fulltext")) {
        throw new Error(
          `@db.index.fulltext on "${fieldName}" ${searchKind.problem} — a fulltext member must be a string or an integer`,
        );
      }
      if (metadata.has("db.column.searchable")) {
        throw new Error(
          `@db.column.searchable on "${fieldName}" ${searchKind.problem} — a searchable column must be a string or an integer`,
        );
      }
    }

    // @db.index.fulltext (args: name?, weight?)
    for (const index of (metadata.get("db.index.fulltext") as any[]) || []) {
      const name =
        index === true ? fieldName : typeof index === "string" ? index : index?.name || fieldName;
      const weight = index !== true && typeof index === "object" ? index?.weight : undefined;
      this._addIndexField("fulltext", name, fieldName, { weight });
    }

    // @db.index.geo (arg: name?) — geospatial index on a db.geoPoint field
    if (metadata.has("db.index.geo")) {
      const raw = metadata.get("db.index.geo");
      const name = typeof raw === "string" && raw ? raw : fieldName;
      this._validateGeoIndexField(fieldName, fieldType, metadata);
      this._addIndexField("geo", name, fieldName);
    }

    // @db.encrypted — encrypted-at-rest field (single opaque text column)
    if (metadata.has("db.encrypted")) {
      this._validateEncryptedField(fieldName, metadata);
      this.encryptedFields.add(fieldName);
    }

    // @db.column.collate → collation (intermediate, consumed by _buildFieldDescriptors)
    const collate = metadata.get("db.column.collate") as TDbCollation | undefined;
    if (collate) {
      this._collateMap.set(fieldName, collate);
    }

    const hasExplicitIndex =
      metadata.has("db.index.plain") ||
      metadata.has("db.index.unique") ||
      metadata.has("db.index.fulltext");

    // @db.json → mark as JSON storage
    if (metadata.has("db.json")) {
      this.jsonFields.add(fieldName);

      if (hasExplicitIndex) {
        logger.warn(
          `@db.index on a @db.json field "${fieldName}" — most databases cannot index into JSON columns`,
        );
      }
    }

    // @db.column.dimension → mark as dimension + auto-index for GROUP BY performance
    if (metadata.has("db.column.dimension")) {
      this.dimensions.push(fieldName);

      if (!hasExplicitIndex) {
        this._addIndexField("plain", fieldName, fieldName);
      }
    }

    // @db.column.measure → mark as measure (aggregatable in aggregate queries)
    if (metadata.has("db.column.measure")) {
      this.measures.push(fieldName);
    }

    // @db.column.version.exempt → declared; validated in _finalizeVersionExempt
    if (metadata.has("db.column.version.exempt")) {
      this._versionExemptDeclared.add(fieldName);
    }

    // @db.column.version → version column for OCC (at most one per table)
    if (metadata.has("db.column.version")) {
      if (this.versionField !== undefined) {
        logger.warn(
          `@db.column.version declared on multiple fields ("${this.versionField}" and "${fieldName}") — only one is allowed; using "${this.versionField}"`,
        );
      } else {
        this.versionField = fieldName;
        // Implicit `default 0`: schema sync emits NOT NULL DEFAULT 0 so
        // existing rows backfill at ALTER TABLE time and new inserts get a
        // usable starting value (§4.6 of VERSION_PROPOSAL.md). An explicit
        // `@db.default` on the same field wins via the guard below.
        if (!this.defaults.has(fieldName)) {
          this.defaults.set(fieldName, { kind: "value", value: "0" });
        }
      }
    }
  }

  // ── Private: version-exempt fields ───────────────────────────────────────

  /**
   * Validates the `@db.column.version.exempt` placements (E1–E5, the runtime
   * mirror of the compile-time check, so pre-compiled models fail fast) and
   * computes {@link versionExemptPaths} with its upward closure. Runs after
   * `_applyOverrides` (the primary keys are final) and before `jsonFields` is
   * released. A table without a version column ignores the annotation.
   */
  private _finalizeVersionExempt(): void {
    if (this._versionExemptDeclared.size === 0) return;
    for (const path of this._versionExemptDeclared) {
      if (path === this.versionField)
        rejectVersionExempt(path, "cannot mark the version column itself");
      if (this.primaryKeys.includes(path)) {
        rejectVersionExempt(path, "a primary key identifies the row and is never patched");
      }
      if (this.navFields.has(path)) {
        rejectVersionExempt(path, "a navigation field has no column here");
      }
      let pos = path.length;
      while ((pos = path.lastIndexOf(".", pos - 1)) !== -1) {
        const ancestor = path.slice(0, pos);
        const node = this.flatMap.get(ancestor);
        if (node?.metadata.has("db.json")) {
          rejectVersionExempt(
            path,
            `mark the @db.json field "${ancestor}" itself — a JSON column is written as one value`,
          );
        }
        if (node?.type.kind === "array") {
          rejectVersionExempt(
            path,
            `mark the array field "${ancestor}" itself — array elements are not separate columns`,
          );
        }
      }
    }
    if (this.versionField === undefined) return;

    const exempt = new Set(this._versionExemptDeclared);
    // Upward closure: an object whose direct children are all exempt is exempt.
    const objects = [...this.flatMap.keys()]
      .filter((p) => {
        const node = this.flatMap.get(p)!;
        return node.type.kind === "object" && !node.metadata.has("db.json");
      })
      .toSorted((a, b) => b.split(".").length - a.split(".").length);
    for (const obj of objects) {
      if (exempt.has(obj)) continue;
      const prefix = `${obj}.`;
      let children = 0;
      let all = true;
      for (const key of this.flatMap.keys()) {
        if (!key.startsWith(prefix) || key.indexOf(".", prefix.length) !== -1) continue;
        if (this.navFields.has(key) || this.ignoredFields.has(key)) continue;
        children++;
        if (!exempt.has(key)) {
          all = false;
          break;
        }
      }
      if (children > 0 && all) exempt.add(obj);
    }
    this.versionExemptPaths = exempt;
  }

  /** Whether `path` — or an ancestor of it — is version-exempt (since 0.1.150). */
  isVersionExemptPath(path: string): boolean {
    return selfOrAncestor(path, this.versionExemptPaths) !== undefined;
  }

  // ── Private: encrypted / geo build-time constraints ──────────────────────

  /**
   * Build-time diagnostics for `@db.encrypted` (§6 of the field-encryption
   * spec). Mirrors the compile-time AnnotationSpec validation so models built
   * from pre-compiled types still fail fast.
   */
  private _validateEncryptedField(
    fieldName: string,
    metadata: TMetadataMap<AtscriptMetadata>,
  ): void {
    const reject = (what: string, why: string) => {
      throw new Error(`@db.encrypted on "${fieldName}" cannot coexist with ${what} — ${why}`);
    };
    if (metadata.has("meta.id")) {
      reject("@meta.id", "the primary key must be addressable");
    }
    if (metadata.has("db.rel.FK")) {
      reject("@db.rel.FK", "joins are impossible over ciphertext");
    }
    if (
      metadata.has("db.index.plain") ||
      metadata.has("db.index.unique") ||
      metadata.has("db.index.fulltext") ||
      metadata.has("db.index.geo")
    ) {
      reject("@db.index.*", "indexes over ciphertext are meaningless");
    }
    if (metadata.has("db.search.vector") || metadata.has("db.search.filter")) {
      reject("@db.search.*", "search over ciphertext is impossible");
    }
    if (metadata.has("db.mongo.search.text") || metadata.has("db.mongo.search.autocomplete")) {
      reject("@db.mongo.search.*", "Atlas Search over ciphertext is impossible");
    }
    if (metadata.has("db.column.version")) {
      reject("@db.column.version", "the OCC filter needs cleartext equality");
    }
    if (metadata.has("db.default.increment") || metadata.has("db.default.now")) {
      reject(
        "@db.default.increment / @db.default.now",
        "engine-side defaults bypass the encryption transform",
      );
    }
    if (metadata.get("db.patch.strategy") === "merge") {
      reject(
        '@db.patch.strategy "merge"',
        "ciphertext is opaque — partial merges would silently drop omitted keys",
      );
    }
  }

  /**
   * Build-time diagnostics for `@db.column.derived` (rules D1–D8 of the
   * derived-column design) — the runtime mirror of the compile-time check, so
   * pre-compiled models fail fast — and the resolution of what the field
   * reads: the source leaf's JSON column + path (relational layout, via the
   * views' `resolveViewSource`) and its declared type.
   */
  private _validateDerivedField(
    fieldName: string,
    fieldType: TAtscriptAnnotatedType,
    metadata: TMetadataMap<AtscriptMetadata>,
    rootType: TAtscriptAnnotatedType<TAtscriptTypeObject>,
  ): TDerivedColumn {
    const reject = (why: string): never => {
      throw new Error(`@db.column.derived on "${fieldName}": ${why}`);
    };
    if (fieldName.includes(".")) {
      reject("only a top-level field of a table can be derived");
    }
    for (const [name, why] of DERIVED_INCOMPATIBLE) {
      if (metadata.has(name as never)) {
        reject(`cannot coexist with @${name} — ${why}`);
      }
    }
    const ref = fieldType.ref;
    if (!ref?.field) {
      reject(
        "requires a chain reference into a @db.json field of the same table (e.g. `customerId: Order.payload.customer.id`)",
      );
    }
    const target = ref!.type();
    if (target !== rootType) {
      reject(
        `must reference the enclosing table "${rootType.id ?? ""}", not "${target?.id ?? ""}" — a derived column reads its own row`,
      );
    }
    const sourcePath = ref!.field;
    const segments = sourcePath.split(".");
    let jsonRoot: string | undefined;
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join(".");
      const node = this.flatMap.get(prefix);
      if (!node) {
        reject(`path "${sourcePath}" does not exist on the table`);
      }
      if (node!.metadata.has("db.encrypted")) {
        reject(
          `path "${sourcePath}" reads inside the @db.encrypted field "${prefix}" — ciphertext cannot be extracted`,
        );
      }
      if (resolveDesignType(node!) === "array") {
        reject(
          `path "${sourcePath}" crosses the array "${prefix}" — a derived column reads one scalar leaf`,
        );
      }
      if (jsonRoot === undefined && node!.metadata.has("db.json")) {
        jsonRoot = prefix;
      }
    }
    if (jsonRoot === undefined || jsonRoot === sourcePath) {
      reject(
        `path "${sourcePath}" does not read inside a @db.json field — a flattened or scalar column needs no derived column`,
      );
    }
    const leafType = resolveDesignType(this.flatMap.get(sourcePath)!);
    if (!isJsonLeafType(leafType)) {
      return reject(
        `path "${sourcePath}" must end at a string, number or boolean leaf (got "${leafType}")`,
      );
    }
    // The relational layout of the source — the one JSON extraction views
    // use (it throws for a path without storage: @db.ignore, a navigation
    // relation). The walk above guarantees a JSON root strictly above the
    // leaf, so the source always carries a JSON path.
    const source = resolveViewSource(rootType, sourcePath, false);
    return {
      sourcePath,
      sourceColumn: source.column,
      jsonPath: source.jsonPath!,
      type: leafType,
    };
  }

  /** Build-time diagnostics for `@db.index.geo` (§3 of the geo-index spec). */
  private _validateGeoIndexField(
    fieldName: string,
    fieldType: TAtscriptAnnotatedType,
    metadata: TMetadataMap<AtscriptMetadata>,
  ): void {
    const reject = (why: string) => {
      throw new Error(`@db.index.geo on "${fieldName}": ${why}`);
    };
    if (!isGeoIndexableType(fieldType)) {
      reject("the field type must resolve to db.geoPoint (a [lng, lat] number tuple)");
    }
    if (fieldName.includes(".")) {
      reject("geo indexes are only supported on top-level fields in v1");
    }
    if (metadata.has("db.encrypted")) {
      reject("@db.index.geo is mutually exclusive with @db.encrypted");
    }
    if (metadata.has("db.json")) {
      reject("@db.index.geo is mutually exclusive with @db.json");
    }
    if (metadata.has("meta.id")) {
      reject("geo fields cannot be part of the primary key");
    }
    if (metadata.has("db.index.unique")) {
      reject("geo fields cannot be part of a unique index");
    }
    if (metadata.has("db.rel.FK")) {
      reject("geo fields cannot be foreign keys");
    }
  }

  // ── Private: index helpers ───────────────────────────────────────────────

  private _addIndexField(
    type: TDbIndex["type"],
    name: string,
    field: string,
    opts?: { sort?: "asc" | "desc"; weight?: number },
  ): void {
    const key = indexKey(type, name);
    const index = this.indexes.get(key);
    const indexField: TDbIndexField = { name: field, sort: opts?.sort ?? "asc" };
    if (opts?.weight !== undefined) {
      indexField.weight = opts.weight;
    }
    if (index) {
      index.fields.push(indexField);
    } else {
      this.indexes.set(key, {
        key,
        name,
        type,
        fields: [indexField],
      });
    }
  }

  // ── Private: field classification ────────────────────────────────────────

  /**
   * Classifies each field as column, flattened, json, or parent-object.
   * Builds the bidirectional pathToPhysical / physicalToPath maps.
   */
  private _classifyFields(): void {
    for (const [path, type] of this.flatMap.entries()) {
      if (!path) {
        continue;
      }

      // Encrypted fields are always ONE opaque text column — never flattened
      // into child columns, never JSON-stored. Their descendants are skipped
      // entirely (the ciphertext envelope covers the whole subtree).
      if (this.encryptedFields.has(path) || findAncestorInSet(path, this.encryptedFields)) {
        continue;
      }

      const designType = resolveDesignType(type);
      const isJson = this.jsonFields.has(path);
      const isArray = designType === "array";
      const isObject = designType === "object";

      if (isArray) {
        this.jsonFields.add(path);
      } else if (isObject && isJson) {
        // Already in jsonFields from @db.json detection
      } else if (isObject && !isJson) {
        this.flattenedParents.add(path);
      }
    }

    // Propagate @db.ignore from parent objects to their children
    for (const ignoredField of this.ignoredFields) {
      if (this.flattenedParents.has(ignoredField)) {
        const prefix = `${ignoredField}.`;
        for (const path of this.flatMap.keys()) {
          if (path.startsWith(prefix)) {
            this.ignoredFields.add(path);
          }
        }
      }
    }

    // J4: @db.column on a flattened parent is invalid
    for (const parentPath of this.flattenedParents) {
      if (this.columnMap.has(parentPath)) {
        throw new Error(
          `@db.column cannot rename a flattened object field "${parentPath}" — ` +
            `apply @db.column to individual nested fields, or use @db.json to store as a single column`,
        );
      }
    }

    // Build physical name maps for all non-parent fields
    for (const [path] of this.flatMap.entries()) {
      if (!path) {
        continue;
      }
      if (this.flattenedParents.has(path)) {
        continue;
      }
      if (findAncestorInSet(path, this.jsonFields) !== undefined) {
        continue;
      }
      if (findAncestorInSet(path, this.encryptedFields) !== undefined) {
        continue;
      }

      const isFlattened = findAncestorInSet(path, this.flattenedParents) !== undefined;
      const physicalName = relationalColumnName(path, this.columnMap.get(path), isFlattened);

      this.pathToPhysical.set(path, physicalName);
      this.physicalToPath.set(physicalName, path);

      const fieldType = this.flatMap.get(path);
      if (fieldType && !this.encryptedFields.has(path)) {
        const dt = resolveDesignType(fieldType);
        if (dt === "boolean") {
          this.booleanFields.add(physicalName);
        } else if (dt === "decimal") {
          this.decimalFields.add(physicalName);
        }
      }
    }

    // Build select expansion map
    for (const parentPath of this.flattenedParents) {
      const prefix = `${parentPath}.`;
      const leaves: string[] = [];
      for (const [path, physical] of this.pathToPhysical) {
        if (path.startsWith(prefix)) {
          leaves.push(physical);
        }
      }
      if (leaves.length > 0) {
        this.selectExpansion.set(parentPath, leaves);
      }
    }

    this.onlyColumnRenames =
      this.columnMap.size > 0 && this.flattenedParents.size === 0 && this.jsonFields.size === 0;
    this.requiresMappings =
      this.flattenedParents.size > 0 || this.jsonFields.size > 0 || this.onlyColumnRenames;
  }

  // ── Query-guard helpers ──────────────────────────────────────────────────

  /** Nearest `@db.encrypted` ancestor of `path` (exclusive), or `undefined`. */

  /**
   * Indexes non-ignored descriptors by logical path and retains the JSON-parent
   * sets (plus every descriptor's physical name). Navigation relations and their descendants are skipped even when the
   * adapter keeps them as descriptors (nested-object adapters do) — they are
   * loaded with `$with`, never addressed as columns of this table.
   */
  private _buildGuardIndexes(): void {
    const jsonParents = new Set<string>();
    const jsonValueParents = new Set<string>();
    const physicalNames = new Set<string>();
    for (const fd of this.fieldDescriptors) {
      physicalNames.add(fd.physicalName);
      if (fd.ignored) {
        continue;
      }
      // Nav props and their descendants are never columns of this table (nav
      // descriptors are `ignored` on both adapter families, but the guard
      // index is nav-free by construction, not by that invariant).
      if (this.navFields.has(fd.path) || findAncestorInSet(fd.path, this.navFields) !== undefined) {
        continue;
      }
      this.descriptorByPath.set(fd.path, fd);
      if (fd.storage === "json") {
        jsonParents.add(fd.path);
      }
      if (isJsonValueField(fd)) {
        jsonValueParents.add(fd.path);
      }
    }
    this.jsonParents = jsonParents;
    this.jsonValueParents = jsonValueParents;
    this.physicalNames = physicalNames;
  }

  // ── Private: leaf field indexes ──────────────────────────────────────────

  /**
   * Indexes `fieldDescriptors` into two lookup maps for unified
   * read/write field classification in the RelationalFieldMapper.
   */
  private _buildLeafIndexes(): void {
    for (const fd of this.fieldDescriptors) {
      if (fd.ignored) {
        continue;
      }
      this.leafByPhysical.set(fd.physicalName, fd);
      this.leafByLogical.set(fd.path, fd);
    }

    // Precompute parent → child physical names + optional logical paths for fast null-setting
    for (const parentPath of this.flattenedParents) {
      const prefix = `${parentPath}.`;
      const children: string[] = [];
      const optionalLeaves: string[] = [];
      for (const [path, fd] of this.leafByLogical.entries()) {
        if (path.startsWith(prefix)) {
          children.push(fd.physicalName);
          if (fd.optional) optionalLeaves.push(path);
        }
      }
      if (children.length > 0) {
        this.childrenByParent.set(parentPath, children);
      }
      if (optionalLeaves.length > 0) {
        this.optionalLeavesByLogicalParent.set(parentPath, optionalLeaves);
      }
    }
  }

  // ── Private: field descriptor building ───────────────────────────────────

  /**
   * Builds field descriptors, physical-name lookup, and value formatters.
   * Called once during build() — everything it needs
   * (flatMap, indexes, columnMap, etc.) is already populated.
   */
  private _buildFieldDescriptors(
    adapter: BaseDbAdapter,
    rootType: TAtscriptAnnotatedType<TAtscriptTypeObject>,
  ): void {
    const descriptors: TDbFieldMeta[] = [];
    const skipFlattening = this.nestedObjects;

    // Collect all field names that participate in any index. Primary keys and
    // unique fields are index-backed on every supported adapter (Mongo `_id`,
    // SQL PK/unique constraints) even when no explicit `@db.index*` declares
    // them — so seed them in too, otherwise `isIndexed` is factually wrong for
    // those fields and consumers (e.g. the `/meta` sortable hint) mis-report a
    // PK/unique column as non-sortable.
    const indexedFields = new Set<string>([
      ...this.primaryKeys,
      ...this.uniqueProps,
      ...this.uniqueKeys.flat(),
    ]);
    for (const index of this.indexes.values()) {
      for (const f of index.fields) {
        indexedFields.add(f.name);
      }
    }

    for (const [path, type] of this.flatMap.entries()) {
      if (!path) {
        continue;
      }

      if (!skipFlattening && this.flattenedParents.has(path)) {
        continue;
      }

      if (!skipFlattening && findAncestorInSet(path, this.jsonFields) !== undefined) {
        continue;
      }

      const isEncrypted = this.encryptedFields.has(path);
      const underEncrypted = findAncestorInSet(path, this.encryptedFields) !== undefined;
      // Descendants of an encrypted field have no storage of their own — the
      // ancestor's ciphertext column covers the subtree. Relational adapters
      // skip them entirely; document adapters keep them (declared-type shape
      // for /meta and validation) but inherit the encrypted veto.
      if (!skipFlattening && underEncrypted) {
        continue;
      }

      const isJson = this.jsonFields.has(path);
      const isFlattened =
        !skipFlattening && findAncestorInSet(path, this.flattenedParents) !== undefined;
      // Encrypted values are stored as an opaque ASCII envelope — always text.
      const designType = isEncrypted ? "string" : isJson ? "json" : resolveDesignType(type);

      let storage: TDbStorageType;
      if (skipFlattening) {
        storage = "column";
      } else if (isEncrypted) {
        storage = isFlattened ? "flattened" : "column";
      } else if (isJson) {
        storage = "json";
      } else if (isFlattened) {
        storage = "flattened";
      } else {
        storage = "column";
      }

      const physicalName = this.physicalPath(path);

      // Compute renamedFrom (old physical name from @db.column.renamed)
      const fromLocal = this._columnFromMap.get(path);
      let renamedFrom: string | undefined;
      if (fromLocal) {
        renamedFrom = isFlattened ? flattenedPrefix(path) + fromLocal : fromLocal;
      }

      const currencyCode = type.metadata.get("db.amount.currency") as string | undefined;
      const currencyRefField = type.metadata.get("db.amount.currency.ref") as string | undefined;
      const unitCode = type.metadata.get("db.unit") as string | undefined;
      const unitRefField = type.metadata.get("db.unit.ref") as string | undefined;
      const quantityRef = currencyRefField ?? unitRefField;
      if (quantityRef) {
        this.quantityRefByField.set(path, quantityRef);
      }

      descriptors.push({
        path,
        type,
        physicalName,
        designType,
        optional: type.optional === true,
        isPrimaryKey: this.primaryKeys.includes(path),
        ignored: this.ignoredFields.has(path),
        defaultValue: this.defaults.get(path),
        storage,
        flattenedFrom: isFlattened ? path : undefined,
        renamedFrom,
        collate: this._collateMap.get(path),
        isIndexed: indexedFields.has(path) || undefined,
        currencyCode,
        currencyRefField,
        unitCode,
        unitRefField,
        encrypted: isEncrypted || underEncrypted || undefined,
        isGeoPoint: isGeoPointType(type) || undefined,
        derived: this.derivedFields.get(path),
        computed: computedMeta(rootType, path),
      });
    }

    // Second pass: resolve fkTargetField / physical FK columns — one
    // flattening per referenced type (several FKs may reference it).
    const flatCache = new Map<TAtscriptAnnotatedType, Map<string, TAtscriptAnnotatedType>>();
    const flatOf = (type: TAtscriptAnnotatedType): Map<string, TAtscriptAnnotatedType> => {
      let flat = flatCache.get(type);
      if (!flat) {
        flat = flattenAnnotatedType(type as TAtscriptAnnotatedType<TAtscriptTypeObject>);
        flatCache.set(type, flat);
      }
      return flat;
    };
    this._resolveFkTargetFields(descriptors, flatOf);
    this._resolveFkPhysicalFields(flatOf);

    Object.freeze(descriptors);
    this.fieldDescriptors = descriptors;
    this.columnDescriptors = Object.freeze(
      descriptors.filter((fd) => !fd.ignored && !(skipFlattening && fd.derived)),
    );
    this.storedDescriptors = Object.freeze(descriptors.filter((fd) => !fd.ignored && !fd.derived));

    // Build value formatters from adapter hook — per column (a derived field
    // on a document adapter shares its physical path with the source leaf,
    // which has its own — nested: none — formatting rules)
    const fmtHook = adapter.formatValue?.bind(adapter);
    if (fmtHook) {
      for (const fd of this.columnDescriptors) {
        const fmt = fmtHook(fd);
        if (fmt) {
          if (typeof fmt === "function") {
            // Bare function = toStorage only (backward compat)
            if (!this.toStorageFormatters) {
              this.toStorageFormatters = new Map();
            }
            this.toStorageFormatters.set(fd.physicalName, fmt);
          } else {
            if (fmt.toStorage) {
              if (!this.toStorageFormatters) {
                this.toStorageFormatters = new Map();
              }
              this.toStorageFormatters.set(fd.physicalName, fmt.toStorage);
            }
            if (fmt.fromStorage) {
              if (!this.fromStorageFormatters) {
                this.fromStorageFormatters = new Map();
              }
              this.fromStorageFormatters.set(fd.physicalName, fmt.fromStorage);
            }
          }
        }
      }
    }
  }

  /**
   * Fills `physicalFields` / `physicalTargetFields` on every FK: the local
   * side from this table's path maps, the target side from the referenced
   * type's own `@db.column` renames (same storage rules as this table — a
   * dotted target path is a flattened column on relational storage, a
   * renamed top-level key on document storage).
   */
  private _resolveFkPhysicalFields(flatOf: TFlatOf): void {
    const targetPhysical = (fk: TDbForeignKey, field: string): string => {
      const targetType = fk.targetTypeRef?.();
      if (!targetType) {
        return field;
      }
      const flat = flatOf(targetType);
      const columnOf = (path: string) =>
        flat.get(path)?.metadata?.get("db.column") as string | undefined;
      if (this.nestedObjects) {
        const dot = field.indexOf(".");
        const top = dot === -1 ? field : field.slice(0, dot);
        const renamed = columnOf(top);
        return renamed === undefined ? field : renamed + field.slice(top.length);
      }
      return relationalColumnName(field, columnOf(field), field.includes("."));
    };
    for (const fk of this.foreignKeys.values()) {
      fk.physicalFields = fk.fields.map((f) => this.physicalPath(f));
      fk.physicalTargetFields = fk.targetFields.map((f) => targetPhysical(fk, f));
      const targetSchema = fk.targetTypeRef?.()?.metadata?.get("db.schema") as string | undefined;
      if (targetSchema) {
        fk.targetSchema = targetSchema;
      }
    }
  }

  /**
   * Resolves `fkTargetField` for FK fields in field descriptors.
   */
  private _resolveFkTargetFields(descriptors: TDbFieldMeta[], flatOf: TFlatOf): void {
    if (this.foreignKeys.size === 0) {
      return;
    }

    // Build mapping: local field path → { targetTypeRef, targetFieldName }
    const fkFieldToTarget = new Map<
      string,
      { targetTypeRef: () => TAtscriptAnnotatedType; targetField: string }
    >();
    for (const fk of this.foreignKeys.values()) {
      if (!fk.targetTypeRef) {
        continue;
      }
      for (let i = 0; i < fk.fields.length; i++) {
        fkFieldToTarget.set(fk.fields[i], {
          targetTypeRef: fk.targetTypeRef,
          targetField: fk.targetFields[i],
        });
      }
    }

    if (fkFieldToTarget.size === 0) {
      return;
    }

    for (const descriptor of descriptors) {
      const target = fkFieldToTarget.get(descriptor.path);
      if (!target) {
        continue;
      }

      const targetType = target.targetTypeRef();
      if (!targetType) {
        continue;
      }

      const targetFieldType = flatOf(targetType).get(target.targetField);
      if (!targetFieldType) {
        continue;
      }

      const targetMetadata = targetFieldType.metadata;
      if (targetMetadata?.has("db.encrypted")) {
        throw new Error(
          `FK field "${descriptor.path}" references encrypted field "${target.targetField}" — joins are impossible over ciphertext`,
        );
      }
      descriptor.fkTargetField = {
        path: target.targetField,
        type: targetFieldType,
        physicalName: target.targetField,
        designType: resolveDesignType(targetFieldType),
        optional: false,
        isPrimaryKey: targetMetadata?.has("meta.id") ?? false,
        ignored: false,
        storage: "column",
        defaultValue: targetMetadata ? resolveDefaultFromMetadata(targetMetadata) : undefined,
        collate: targetMetadata?.get("db.column.collate") as TDbCollation | undefined,
      };
    }
  }

  // ── Private: index finalization ──────────────────────────────────────────

  /**
   * Flags the integer members of fulltext indexes (matched by exact number,
   * never part of the physical text index) and enforces that each is
   * index-backed — the equality branch must not scan. Runs while index field
   * names are still logical.
   */
  private _resolveIntegerFulltextMembers(): void {
    for (const index of this.indexes.values()) {
      if (index.type !== "fulltext") continue;
      for (const field of index.fields) {
        const ftype = this.flatMap.get(field.name);
        if (!ftype || searchMemberKind(ftype) !== "integer") continue;
        const where = `@db.index.fulltext on the integer field "${field.name}"`;
        if (findAncestorInSet(field.name, this.jsonFields) !== undefined) {
          throw new Error(`${where} inside a JSON value is not supported`);
        }
        const backed =
          field.name === "_id" ||
          this.originalMetaIdFields[0] === field.name ||
          this.uniqueProps.has(field.name) ||
          [...this.indexes.values()].some(
            (other) =>
              (other.type === "plain" || other.type === "unique") &&
              other.fields[0]?.name === field.name,
          );
        if (!backed) {
          throw new Error(
            `${where} needs an index for its exact-number match — make it the primary key (first @meta.id) or the first field of a @db.index.plain / @db.index.unique`,
          );
        }
        field.integer = true;
      }
    }
  }

  private _finalizeIndexes(): void {
    for (const index of this.indexes.values()) {
      if (index.type === "unique" && index.fields.length === 1) {
        this.uniqueProps.add(index.fields[0].name);
      }
    }
    // After uniqueProps is populated, so the unique-prop backing check is live.
    this._resolveIntegerFulltextMembers();

    for (const index of this.indexes.values()) {
      for (const field of index.fields) {
        // Resolve optionality + design type from the logical path (flatMap is
        // keyed by logical path) BEFORE rewriting the name to physical. Adapters
        // use these to make a unique index present-only on optional fields.
        const ftype = this.flatMap.get(field.name);
        if (ftype) {
          field.optional = ftype.optional === true;
          // Carry an `objectId` design type distinct from its string base so a
          // present-only filter can match both representations (24-hex string or
          // native BSON ObjectId). The tag is a no-op for non-Mongo adapters.
          const tags = (ftype.type as { tags?: ReadonlySet<string> }).tags;
          field.designType = tags?.has("objectId") ? "objectId" : resolveDesignType(ftype);
        }
        field.name = this.physicalPath(field.name);
      }
    }
  }

  /**
   * Captures legitimate row-identifier shapes from the metadata: primary key
   * (when present) followed by every unique index. Must run BEFORE
   * `_finalizeIndexes` rewrites `index.fields[i].name` from logical to
   * physical, so the field lists stay logical.
   *
   * Sources:
   * - `this.primaryKeys` — composite-aware PK (one identification covering
   *   the PK columns).
   * - `this.indexes` — user-declared `@db.index.unique` (single or compound).
   * - `this.uniqueProps` — single-field uniques contributed by adapter
   *   overrides (`addUniqueFields`); these aren't reflected in
   *   `this.indexes` but still legitimate addressing identifications.
   *   Deduped against any single-field unique index already captured.
   * - `this.uniqueKeys` — multi-field uniques contributed by adapter
   *   overrides (`addUniqueKeys`).
   */
  private _buildIdentifications(): void {
    const out: TIdentification[] = [];
    const seenSingleFields = new Set<string>();
    if (this.primaryKeys.length > 0) {
      out.push({ fields: [...this.primaryKeys], source: "primaryKey" });
    }
    for (const index of this.indexes.values()) {
      if (index.type === "unique") {
        const fields = index.fields.map((field) => field.name);
        out.push({ fields, source: index.name });
        if (fields.length === 1) seenSingleFields.add(fields[0]!);
      }
    }
    // Adapter-contributed single-field uniques (e.g. MongoDB demotes `@meta.id`
    // on a non-`_id` field to a unique index named `__pk` whose record lives
    // only in the adapter's local index map, not on `this.indexes`).
    for (const field of this.uniqueProps) {
      if (seenSingleFields.has(field)) continue;
      if (this.primaryKeys.length === 1 && this.primaryKeys[0] === field) continue;
      out.push({ fields: [field], source: `unique:${field}` });
    }
    for (const key of this.uniqueKeys) {
      out.push({ fields: [...key], source: `unique:${key.join("+")}` });
    }
    this._identifications = out;
  }

  /** Legitimate row-identifier shapes — primary key first, then each unique index. */
  public getIdentifications(): readonly TIdentification[] {
    return this._identifications ?? [];
  }

  /**
   * Fields that always count as visible for row identification (since
   * 0.1.134): primary key, `preferredId` and `@meta.id` fields — see
   * `AtscriptDbReadable.identificationsVisibleTo`.
   */
  public getAlwaysAddressable(): ReadonlySet<string> {
    return this._alwaysAddressable ?? new Set();
  }

  private _resolvePreferredId(type: TAtscriptAnnotatedType<TAtscriptTypeObject>): void {
    const preferred = type.metadata.get("db.table.preferredId.uniqueIndex");
    if (preferred === undefined) {
      this.preferredId = [...this.primaryKeys];
      return;
    }

    const requestedName = typeof preferred === "string" ? preferred : undefined;
    const selected = this.getIdentifications().find(
      (id) =>
        id.source !== "primaryKey" && (requestedName === undefined || id.source === requestedName),
    );

    this.preferredId = selected ? [...selected.fields] : [...this.primaryKeys];
  }
}

/** `TDbFieldMeta.computed` of a top-level `@db.compute` view field (since 0.1.147). */
function computedMeta(
  rootType: TAtscriptAnnotatedType<TAtscriptTypeObject>,
  path: string,
): { operands: readonly string[]; via: readonly string[] } | undefined {
  if (path.includes(".")) return undefined;
  const computed = computedOperands(rootType, path);
  return computed
    ? { operands: Object.freeze(computed.operands), via: Object.freeze(computed.via) }
    : undefined;
}
