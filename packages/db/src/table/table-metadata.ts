import {
  flattenAnnotatedType,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeObject,
  type TMetadataMap,
} from "@atscript/typescript/utils";

import type { BaseDbAdapter } from "../base-adapter";
import type { TGenericLogger } from "../logger";
import { resolveDesignType, resolveDefaultFromMetadata } from "./db-readable";
import type {
  TDbCollation,
  TDbDefaultValue,
  TDbFieldMeta,
  TDbForeignKey,
  TDbIndex,
  TDbIndexField,
  TDbRelation,
  TDbStorageType,
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

/**
 * Finds the nearest ancestor of `path` that belongs to `set`.
 * Used by both the build pipeline (in `_classifyFields`) and
 * runtime reconstruction on the Readable.
 */
export function findAncestorInSet(path: string, set: ReadonlySet<string>): string | undefined {
  let pos = path.length;
  while ((pos = path.lastIndexOf(".", pos - 1)) !== -1) {
    const ancestor = path.slice(0, pos);
    if (set.has(ancestor)) {
      return ancestor;
    }
  }
  return undefined;
}

/** Returns true if `metadata` indicates a navigation relation field. */
function isNavRelation(metadata: TMetadataMap<AtscriptMetadata>): boolean {
  return metadata.has("db.rel.to") || metadata.has("db.rel.from") || metadata.has("db.rel.via");
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
  primaryKeys: string[] = [];
  originalMetaIdFields: string[] = [];
  indexes = new Map<string, TDbIndex>();
  foreignKeys = new Map<string, TDbForeignKey>();
  relations = new Map<string, TDbRelation>();
  navFields = new Set<string>();
  ignoredFields = new Set<string>();
  uniqueProps = new Set<string>();
  defaults = new Map<string, TDbDefaultValue>();
  columnMap = new Map<string, string>();
  dimensions: string[] = [];
  measures: string[] = [];

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

  // ── Build state ──────────────────────────────────────────────────────────

  private _built = false;

  // Intermediate build-time maps (not exposed after build)
  private _collateMap = new Map<string, TDbCollation>();
  private _columnFromMap = new Map<string, string>();

  constructor(nestedObjects: boolean) {
    this.nestedObjects = nestedObjects;
  }

  get isBuilt(): boolean {
    return this._built;
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

    // Phase 1: Collect field tuples. Detect nav fields eagerly so
    // Phase 2 can skip their descendants (flattenAnnotatedType fires
    // onField post-order — children before parent — so we can't filter
    // during the callback itself).
    const collected: Array<{
      path: string;
      type: TAtscriptAnnotatedType;
      metadata: TMetadataMap<AtscriptMetadata>;
    }> = [];

    this.flatMap = flattenAnnotatedType(type, {
      topLevelArrayTag: adapter.getTopLevelArrayTag?.() ?? "db.__topLevelArray",
      excludePhantomTypes: true,
      onField: (path, fieldType, metadata) => {
        if (isNavRelation(metadata)) {
          this.navFields.add(path);
        }
        collected.push({ path, type: fieldType, metadata });
      },
    });

    // Phase 2: Scan only non-nav-descendant fields into metadata maps.
    // Nav descendants remain in flatMap (validation needs them) but never
    // pollute primaryKeys, defaults, indexes, foreignKeys, etc.
    for (const entry of collected) {
      if (findAncestorInSet(entry.path, this.navFields) !== undefined) {
        continue;
      }
      this._scanGenericAnnotations(entry.path, entry.type, entry.metadata, logger);
      adapter.onFieldScanned?.(entry.path, entry.type, entry.metadata);
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
    this._buildFieldDescriptors(adapter);

    // Build leaf field indexes for unified read/write classification
    if (!this.nestedObjects) {
      this._buildLeafIndexes();
    }

    this._finalizeIndexes();

    // Release intermediate build-time maps
    this._collateMap.clear();
    this._columnFromMap.clear();
    this.jsonFields.clear();

    // Mark built BEFORE adapter.onAfterFlatten() — the adapter hook may access
    // metadata via public getters (e.g. MongoAdapter reads this._table.flatMap),
    // which call _ensureBuilt(). Without this flag, that triggers infinite recursion.
    this._built = true;

    adapter.onAfterFlatten?.();

    // Build physical field list for UniquSelect exclusion inversion
    if (this.nestedObjects && this.flatMap) {
      for (const path of this.flatMap.keys()) {
        if (path && !this.ignoredFields.has(path)) {
          this.allPhysicalFields.push(path);
        }
      }
    } else {
      for (const physical of this.pathToPhysical.values()) {
        this.allPhysicalFields.push(physical);
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

    // @db.column → column mapping
    const column = metadata.get("db.column") as string | undefined;
    if (column) {
      this.columnMap.set(fieldName, column);
    }

    // @db.column.renamed → rename mapping (intermediate, consumed by _buildFieldDescriptors)
    const columnFrom = metadata.get("db.column.renamed") as string | undefined;
    if (columnFrom) {
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
      this.relations.set(fieldName, {
        direction,
        alias,
        targetType: resolveTarget,
        isArray: isArr,
        ...(direction === "via" ? { viaType: raw as () => TAtscriptAnnotatedType } : {}),
      });
    }

    // @db.rel.FK → foreign key constraint metadata
    if (metadata.has("db.rel.FK")) {
      const raw = metadata.get("db.rel.FK");
      const alias = (raw === true ? undefined : raw) as string | undefined;
      if (fieldType.ref) {
        const refTarget = fieldType.ref.type();
        const targetTable = (refTarget?.metadata?.get("db.table") as string) || refTarget?.id || "";
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

    // @db.index.fulltext (args: name?, weight?)
    for (const index of (metadata.get("db.index.fulltext") as any[]) || []) {
      const name =
        index === true ? fieldName : typeof index === "string" ? index : index?.name || fieldName;
      const weight = index !== true && typeof index === "object" ? index?.weight : undefined;
      this._addIndexField("fulltext", name, fieldName, { weight });
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

      const isFlattened = findAncestorInSet(path, this.flattenedParents) !== undefined;
      const columnOverride = this.columnMap.get(path);
      let physicalName: string;
      if (columnOverride) {
        // For flattened fields, prepend parent prefix: 'address.zip' with override 'zip_code' → 'address__zip_code'
        physicalName = isFlattened ? this._flattenedPrefix(path) + columnOverride : columnOverride;
      } else {
        physicalName = isFlattened ? path.replace(/\./g, "__") : path;
      }

      this.pathToPhysical.set(path, physicalName);
      this.physicalToPath.set(physicalName, path);

      const fieldType = this.flatMap.get(path);
      if (fieldType) {
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

  /** Returns the `__`-separated parent prefix for a dot-separated path, or empty string for top-level paths. */
  private _flattenedPrefix(path: string): string {
    const lastDot = path.lastIndexOf(".");
    return lastDot >= 0 ? `${path.slice(0, lastDot).replace(/\./g, "__")}__` : "";
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

    // Precompute parent → child physical names for fast null-setting
    for (const parentPath of this.flattenedParents) {
      const prefix = `${parentPath}.`;
      const children: string[] = [];
      for (const [path, fd] of this.leafByLogical.entries()) {
        if (path.startsWith(prefix)) {
          children.push(fd.physicalName);
        }
      }
      if (children.length > 0) {
        this.childrenByParent.set(parentPath, children);
      }
    }
  }

  // ── Private: field descriptor building ───────────────────────────────────

  /**
   * Builds field descriptors, physical-name lookup, and value formatters.
   * Called once during build() — everything it needs
   * (flatMap, indexes, columnMap, etc.) is already populated.
   */
  private _buildFieldDescriptors(adapter: BaseDbAdapter): void {
    const descriptors: TDbFieldMeta[] = [];
    const skipFlattening = this.nestedObjects;

    // Collect all field names that participate in any index
    const indexedFields = new Set<string>();
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

      const isJson = this.jsonFields.has(path);
      const isFlattened =
        !skipFlattening && findAncestorInSet(path, this.flattenedParents) !== undefined;
      const designType = isJson ? "json" : resolveDesignType(type);

      let storage: TDbStorageType;
      if (skipFlattening) {
        storage = "column";
      } else if (isJson) {
        storage = "json";
      } else if (isFlattened) {
        storage = "flattened";
      } else {
        storage = "column";
      }

      const physicalName = skipFlattening
        ? (this.columnMap.get(path) ?? path)
        : (this.pathToPhysical.get(path) ?? this.columnMap.get(path) ?? path);

      // Compute renamedFrom (old physical name from @db.column.renamed)
      const fromLocal = this._columnFromMap.get(path);
      let renamedFrom: string | undefined;
      if (fromLocal) {
        renamedFrom = isFlattened ? this._flattenedPrefix(path) + fromLocal : fromLocal;
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
      });
    }

    // Second pass: resolve fkTargetField for FK fields.
    this._resolveFkTargetFields(descriptors);

    // Build value formatters from adapter hook
    const fmtHook = adapter.formatValue?.bind(adapter);
    if (fmtHook) {
      for (const fd of descriptors) {
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

    Object.freeze(descriptors);
    this.fieldDescriptors = descriptors;
  }

  /**
   * Resolves `fkTargetField` for FK fields in field descriptors.
   */
  private _resolveFkTargetFields(descriptors: TDbFieldMeta[]): void {
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

    // Cache flattened target types — multiple FKs may reference the same table
    const flatCache = new Map<TAtscriptAnnotatedType, Map<string, TAtscriptAnnotatedType>>();

    for (const descriptor of descriptors) {
      const target = fkFieldToTarget.get(descriptor.path);
      if (!target) {
        continue;
      }

      const targetType = target.targetTypeRef();
      if (!targetType) {
        continue;
      }

      let targetFlatMap = flatCache.get(targetType);
      if (!targetFlatMap) {
        targetFlatMap = flattenAnnotatedType(
          targetType as TAtscriptAnnotatedType<TAtscriptTypeObject>,
        );
        flatCache.set(targetType, targetFlatMap);
      }
      const targetFieldType = targetFlatMap.get(target.targetField);
      if (!targetFieldType) {
        continue;
      }

      const targetMetadata = targetFieldType.metadata;
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

  private _finalizeIndexes(): void {
    for (const index of this.indexes.values()) {
      if (index.type === "unique" && index.fields.length === 1) {
        this.uniqueProps.add(index.fields[0].name);
      }
    }

    for (const index of this.indexes.values()) {
      for (const field of index.fields) {
        field.name =
          this.pathToPhysical.get(field.name) ?? this.columnMap.get(field.name) ?? field.name;
      }
    }
  }
}
