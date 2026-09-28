import type { Collection, CreateIndexesOptions, Db } from "mongodb";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import {
  isAtscriptDbView,
  createFailureCollector,
  type AtscriptDbView,
  type TColumnDiff,
  type TSyncColumnResult,
  type TDbFieldMeta,
  type TDbObjectKind,
  type TExistingTableOption,
} from "@atscript/db";
import {
  INDEX_PREFIX,
  isPlainIndex,
  type TMongoIndex,
  type TPlainIndex,
  type TMongoSearchIndexDefinition,
  type TSearchFieldMapping,
} from "./mongo-types";
import { hasAncestorIn, isArrayPath, joinPath } from "./path-utils";
import { buildViewPipeline } from "./mongo-view-pipeline";

// ── Host interface ───────────────────────────────────────────────────────────

export interface TMongoSchemaSyncHost {
  readonly db: Db;
  readonly collection: Collection<any>;
  readonly _table: {
    readonly tableName: string;
    readonly indexes: ReadonlyMap<
      string,
      {
        key: string;
        name: string;
        type: string;
        fields: ReadonlyArray<{
          name: string;
          weight?: number;
          optional?: boolean;
          designType?: string;
        }>;
      }
    >;
    readonly flatMap: ReadonlyMap<string, TAtscriptAnnotatedType>;
    readonly isExternal?: boolean;
    getMetadata(): { documentPath(path: string): string };
  };
  readonly _mongoIndexes: ReadonlyMap<string, TMongoIndex>;
  readonly _cappedOptions?: { size: number; max?: number };
  _getSessionOpts(): Record<string, unknown>;
  _log(...args: unknown[]): void;
  resolveTableName(includeSchema?: boolean): string;
  collectionExists(): Promise<boolean>;
  ensureCollectionExists(): Promise<void>;
  clearCollectionCache(): void;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DESTRUCTIVE_OPTION_KEYS: ReadonlySet<string> = new Set([
  "capped",
  "capped.size",
  "capped.max",
]);

// ── Private types ────────────────────────────────────────────────────────────

interface TRemoteMongoIndex {
  v: number;
  key: { _fts: "text"; _ftsx: 1 } | Record<string, number>;
  name: string;
  weights?: Record<string, number>;
  default_language?: string;
  textIndexVersion: number;
  /** Surfaced from listIndexes() so reconciliation can detect option drift. */
  unique?: boolean;
  /** Surfaced from listIndexes() so a plain→present-only change is migrated. */
  partialFilterExpression?: Record<string, unknown>;
}

interface TRemoteMongoSearchIndex {
  id: string;
  name: string;
  type: "search" | "vectorSearch";
  status: string;
  queryable: boolean;
  latestDefinition: TMongoSearchIndexDefinition;
}

// ── Table existence ──────────────────────────────────────────────────────────

export async function tableExistsImpl(host: TMongoSchemaSyncHost): Promise<boolean> {
  return host.collectionExists();
}

// ── Table options ────────────────────────────────────────────────────────────

export function getDesiredTableOptionsImpl(cappedOptions?: {
  size: number;
  max?: number;
}): TExistingTableOption[] {
  if (!cappedOptions) {
    return [];
  }
  const opts: TExistingTableOption[] = [
    { key: "capped", value: "true" },
    { key: "capped.size", value: String(cappedOptions.size) },
  ];
  if (cappedOptions.max !== undefined) {
    opts.push({ key: "capped.max", value: String(cappedOptions.max) });
  }
  return opts;
}

export async function getExistingTableOptionsImpl(
  host: TMongoSchemaSyncHost,
  tableName?: string,
): Promise<TExistingTableOption[]> {
  const cols = await host.db
    .listCollections({ name: tableName ?? host._table.tableName }, { nameOnly: false })
    .toArray();
  if (cols.length === 0) {
    return [];
  }
  const collOpts = cols[0].options;
  if (!collOpts?.capped) {
    return [];
  }
  const opts: TExistingTableOption[] = [{ key: "capped", value: "true" }];
  if (collOpts.size !== undefined) {
    opts.push({ key: "capped.size", value: String(collOpts.size) });
  }
  if (collOpts.max !== undefined) {
    opts.push({ key: "capped.max", value: String(collOpts.max) });
  }
  return opts;
}

// ── Table / view creation ────────────────────────────────────────────────────

export async function ensureTableImpl(host: TMongoSchemaSyncHost, table: any): Promise<void> {
  // Structural check (never `instanceof`): a bundle may carry two copies of
  // @atscript/db, and a false `instanceof` would create a plain collection here.
  if (isAtscriptDbView(table) && !table.isExternal) {
    return ensureView(host, table as AtscriptDbView);
  }
  return host.ensureCollectionExists();
}

/** Whether the collection has at least one document (exact — `findOne`, not the estimated count). */
export async function hasRowsImpl(
  host: TMongoSchemaSyncHost,
  tableName?: string,
): Promise<boolean> {
  const doc = await host.db
    .collection(tableName ?? host.resolveTableName(false))
    .findOne({}, { projection: { _id: 1 }, ...host._getSessionOpts() });
  return doc !== null;
}

/** Kind of the object stored under `name` (`listCollections` reports views as `"view"`). */
export async function getObjectKindImpl(
  host: TMongoSchemaSyncHost,
  name: string,
): Promise<TDbObjectKind | undefined> {
  const cols = await host.db.listCollections({ name }, { nameOnly: true }).toArray();
  const type = (cols[0] as { type?: string } | undefined)?.type;
  if (type === undefined) {
    return undefined;
  }
  return type === "view" ? "view" : "table";
}

/** Creates a MongoDB view from the AtscriptDbView's view plan (pipeline: {@link buildViewPipeline}). */
async function ensureView(host: TMongoSchemaSyncHost, view: AtscriptDbView): Promise<void> {
  const exists = await host.collectionExists();
  if (exists) {
    return;
  }

  const plan = view.viewPlan;
  const pipeline = buildViewPipeline(view);

  host._log("createView", host._table.tableName, plan.entryTable, pipeline);
  await host.db.createCollection(host._table.tableName, {
    viewOn: plan.entryTable,
    pipeline,
  });
}

// ── Drop / rename / recreate ─────────────────────────────────────────────────

export async function dropTableImpl(host: TMongoSchemaSyncHost): Promise<void> {
  host._log("drop", host._table.tableName);
  await host.collection.drop();
  host.clearCollectionCache();
}

export async function dropViewByNameImpl(
  host: TMongoSchemaSyncHost,
  viewName: string,
): Promise<void> {
  host._log("dropView", viewName);
  try {
    await host.db.collection(viewName).drop();
  } catch {
    // View may not exist — ignore
  }
}

export async function dropTableByNameImpl(
  host: TMongoSchemaSyncHost,
  tableName: string,
): Promise<void> {
  host._log("dropByName", tableName);
  try {
    await host.db.collection(tableName).drop();
  } catch {
    // Collection may not exist — ignore
  }
}

export async function recreateTableImpl(host: TMongoSchemaSyncHost): Promise<void> {
  const tableName = host._table.tableName;
  host._log("recreateTable", tableName);
  const tempName = `${tableName}__tmp_${Date.now()}`;

  // 1. Server-side copy to temp collection (data stays in MongoDB)
  const source = host.db.collection(tableName);
  const count = await source.countDocuments();
  if (count > 0) {
    await source.aggregate([{ $out: tempName }]).toArray();
  }

  // 2. Drop the original collection
  await host.collection.drop();
  host.clearCollectionCache();

  // 3. Recreate with current options (e.g. new capped size/max)
  await host.ensureCollectionExists();

  // 4. Copy data back from temp into the recreated collection
  if (count > 0) {
    const temp = host.db.collection(tempName);
    await temp.aggregate([{ $merge: { into: tableName } }]).toArray();
    await temp.drop();
  }
}

export async function renameTableImpl(host: TMongoSchemaSyncHost, oldName: string): Promise<void> {
  const newName = host.resolveTableName(false);
  host._log("renameTable", oldName, "→", newName);
  await host.db.renameCollection(oldName, newName);
  host.clearCollectionCache();
}

// ── Column sync ──────────────────────────────────────────────────────────────

export async function syncColumnsImpl(
  host: TMongoSchemaSyncHost,
  diff: TColumnDiff,
): Promise<TSyncColumnResult> {
  const renamed: string[] = [];
  const added: string[] = [];

  // Renames — use $rename operator. $rename does not support array-positional
  // operators; fields crossing an array boundary need a separate aggregation-
  // pipeline update. Fall back to a flat $rename for non-array paths and skip
  // (with a log) anything that would cross an array — Mongo would reject it.
  const renameSpec: Record<string, string> = {};
  for (const r of diff.renamed) {
    if (pathCrossesArray(host, r.field.path)) {
      host._log(
        "syncColumns: skipping $rename for array-element field",
        r.oldName,
        "→",
        r.field.physicalName,
        "(Mongo $rename cannot traverse arrays)",
      );
      continue;
    }
    renameSpec[r.oldName] = r.field.physicalName;
    renamed.push(r.field.physicalName);
  }
  if (renamed.length > 0) {
    await host.collection.updateMany({}, { $rename: renameSpec }, host._getSessionOpts());
  }

  // Adds — see defaultBackfill.
  for (const field of diff.added) {
    const value = resolveSyncDefault(field);
    if (value !== undefined) {
      await defaultBackfill(host, field.path, value);
    }
    added.push(field.physicalName);
  }

  return { added, renamed };
}

/**
 * Backfills an added field's `@db.default` literal where the field is
 * missing — a stored value is never overwritten. Optional fields without a
 * default get no backfill (absent = "optional" in Mongo). A path crossing an
 * array narrows the innermost `$[]` to an `arrayFilters` element missing the
 * sub-path; outer arrays keep `$[]`, so empty arrays are a no-op (a bare
 * dotted path into an empty array is rejected with code 28).
 */
async function defaultBackfill(
  host: TMongoSchemaSyncHost,
  logicalPath: string,
  value: unknown,
): Promise<void> {
  const segments = positionalSegments(host, logicalPath);
  const inner = segments.lastIndexOf("$[]");
  const opts = host._getSessionOpts();
  if (inner === -1) {
    const path = segments.join(".");
    await host.collection.updateMany(
      { [path]: { $exists: false } },
      { $set: { [path]: value } },
      opts,
    );
    return;
  }
  segments[inner] = "$[backfill]";
  const rest = segments.slice(inner + 1).join(".");
  await host.collection.updateMany(
    {},
    { $set: { [segments.join(".")]: value } },
    { ...opts, arrayFilters: [{ [`backfill.${rest}`]: { $exists: false } }] },
  );
}

export async function dropColumnsImpl(
  host: TMongoSchemaSyncHost,
  columns: string[],
): Promise<void> {
  if (columns.length === 0) {
    return;
  }
  // When an embedded object (or array-of-objects) is removed wholesale, flatMap
  // tracks both the container path and its descendant leaves, so all of them
  // arrive here (e.g. `groupContact` plus `groupContact.email`). Mongo rejects an
  // update that touches a path and its descendant together ("would create a
  // conflict", code 40), so keep only the shallowest dropped paths — unsetting a
  // parent already removes its whole subtree. Array-leaf drops whose parent array
  // stays are untouched (the parent isn't in the set), so $[] handling still applies.
  const dropped = new Set(columns);
  const minimal = columns.filter((col) => !hasAncestorIn(col, dropped));
  const unsetSpec: Record<string, ""> = {};
  for (const col of minimal) {
    // The dropped leaf is gone from flatMap, but its array ancestors usually
    // remain (we're dropping a sub-field, not the parent array). The stored
    // path is probed as-is and never renamed — an old logical path under a
    // renamed parent must unset nothing, not the live renamed data.
    unsetSpec[positionalSegments(host, col, col).join(".")] = "";
  }
  await host.collection.updateMany({}, { $unset: unsetSpec }, host._getSessionOpts());
}

/**
 * The segments of a field's physical document path with `$[]` after every
 * segment whose logical prefix is an array in the flatMap — Mongo's
 * all-positional operator walks every element. `physicalPath` defaults to
 * the logical path's document path (same segment count).
 */
function positionalSegments(
  host: TMongoSchemaSyncHost,
  logicalPath: string,
  physicalPath = host._table.getMetadata().documentPath(logicalPath),
): string[] {
  const logical = logicalPath.split(".");
  const physical = physicalPath.split(".");
  const out: string[] = [];
  let prefix = "";
  for (let i = 0; i < logical.length; i++) {
    out.push(physical[i]!);
    prefix = joinPath(prefix, logical[i]!);
    if (i < logical.length - 1 && isArrayPath(host._table.flatMap, prefix)) {
      out.push("$[]");
    }
  }
  return out;
}

/** Returns true if any non-leaf segment of the path is typed as an array. */
function pathCrossesArray(host: TMongoSchemaSyncHost, logicalPath: string): boolean {
  const segments = logicalPath.split(".");
  if (segments.length < 2) {
    return false;
  }
  let prefix = "";
  for (let i = 0; i < segments.length - 1; i++) {
    prefix = joinPath(prefix, segments[i]!);
    if (isArrayPath(host._table.flatMap, prefix)) {
      return true;
    }
  }
  return false;
}

/** Resolves a field's default value for bulk $set during column sync. */
function resolveSyncDefault(field: TDbFieldMeta): unknown {
  if (!field.defaultValue) {
    // No @db.default.* — leave existing docs alone. For optional fields this
    // matches Mongo's "missing = absent" semantics; for required fields the
    // missing value will be caught by validation on next write rather than
    // silently backfilled with null.
    return undefined;
  }
  if (field.defaultValue.kind === "value") {
    // `@db.default '<literal>'` is always declared as a string in the .as
    // syntax; the adapter is responsible for coercing it to the column's
    // runtime type before writing. Mirrors the insert-path coercion in
    // db-table.ts so backfilled values match what new inserts would produce.
    return field.designType === "string"
      ? field.defaultValue.value
      : JSON.parse(field.defaultValue.value);
  }
  // Function defaults (increment, uuid, now) can't be bulk-applied retroactively
  return undefined;
}

// ── Index sync ───────────────────────────────────────────────────────────────

export async function syncIndexesImpl(host: TMongoSchemaSyncHost): Promise<void> {
  await host.ensureCollectionExists();

  // Merge generic indexes with MongoDB-specific indexes
  const allIndexes = new Map<string, TMongoIndex>();

  // Convert generic table indexes to MongoDB format
  for (const [key, index] of host._table.indexes.entries()) {
    const fields: Record<string, 1 | "text" | "2dsphere"> = {};
    const weights: Record<string, number> = {};
    let mongoType: TPlainIndex["type"];
    if (index.type === "fulltext") {
      mongoType = "text";
      for (const f of index.fields) {
        fields[f.name] = "text";
        // Default every field's weight to 1 (MongoDB's implicit default). This
        // keeps re-sync idempotent: listIndexes() reports unweighted fields as
        // weight 1, so omitting them here would make objMatch() churn the index
        // on every sync.
        weights[f.name] = f.weight ?? 1;
      }
    } else if (index.type === "geo") {
      // @db.index.geo → 2dsphere over the GeoJSON-stored field.
      mongoType = "2dsphere";
      for (const f of index.fields) {
        fields[f.name] = "2dsphere";
      }
    } else {
      mongoType = index.type as "plain" | "unique";
      for (const f of index.fields) {
        fields[f.name] = 1;
      }
    }
    // A unique index on optional field(s) becomes a *partial* unique index so
    // many value-less rows coexist (matching SQL's NULLS DISTINCT default);
    // present values stay unique. Plain unique indexes (all fields required)
    // and non-unique indexes get no filter.
    const partialFilterExpression =
      index.type === "unique" ? buildPresentOnlyFilter(index.fields) : undefined;
    allIndexes.set(key, {
      key,
      name: index.name,
      type: mongoType,
      fields,
      weights,
      ...(partialFilterExpression ? { partialFilterExpression } : {}),
    });
  }

  // Add MongoDB-specific indexes (search, vector, text from adapter scanning)
  for (const [key, index] of host._mongoIndexes.entries()) {
    if (index.type === "text") {
      // Merge adapter-scanned text indexes into any existing generic fulltext
      const existing = allIndexes.get(key);
      if (existing && existing.type === "text") {
        Object.assign(existing.fields, index.fields);
        Object.assign(existing.weights, index.weights);
      } else {
        allIndexes.set(key, index);
      }
    } else {
      allIndexes.set(key, index);
    }
  }

  // ── Sync regular indexes ─────────────────────────────────────────
  const existingIndexes = (await host.collection.listIndexes().toArray()) as TRemoteMongoIndex[];

  const indexesToCreate = new Map(allIndexes);

  // Per-index error isolation: a failing createIndex/dropIndex (e.g. a unique
  // index over duplicate data) must not abort the remaining index maintenance
  // for this collection.
  const { attempt, throwIfAny } = createFailureCollector("index sync");

  for (const remote of existingIndexes) {
    if (!remote.name.startsWith(INDEX_PREFIX)) {
      continue;
    }
    if (indexesToCreate.has(remote.name)) {
      const local = indexesToCreate.get(remote.name)!;
      if (isPlainIndex(local)) {
        const fieldsMatch = local.type === "text" || objMatch(local.fields, remote.key);
        const weightsMatch = objMatch(local.weights || {}, remote.weights || {});
        // A matching key is NOT sufficient for plain/unique indexes: a change
        // to the unique flag or the present-only partial filter (same fields,
        // different options) must drop + recreate. Without this, an existing
        // plain unique index would never migrate to a partial unique index —
        // listIndexes() reports the same { field: 1 } key, so the old index
        // would be silently kept and the new options never applied.
        const optionsMatch =
          local.type === "text" ||
          ((local.type === "unique") === (remote.unique === true) &&
            partialFilterEqual(local.partialFilterExpression, remote.partialFilterExpression));
        if (fieldsMatch && weightsMatch && optionsMatch) {
          indexesToCreate.delete(remote.name);
        } else {
          host._log("dropIndex", remote.name);
          await attempt(`drop index "${remote.name}"`, () =>
            host.collection.dropIndex(remote.name),
          );
        }
      }
    } else {
      host._log("dropIndex", remote.name);
      await attempt(`drop index "${remote.name}"`, () => host.collection.dropIndex(remote.name));
    }
  }

  // ── Create / update regular indexes ─────────────────────────────
  for (const [key, value] of allIndexes.entries()) {
    if (!isPlainIndex(value) || !indexesToCreate.has(key)) {
      continue;
    }
    let label: string;
    let indexOptions: CreateIndexesOptions;
    switch (value.type) {
      case "plain": {
        host._log("createIndex", key, value.fields);
        label = `create index "${key}"`;
        indexOptions = { name: key };
        break;
      }
      case "unique": {
        host._log("createIndex (unique)", key, value.fields, value.partialFilterExpression);
        label = `create unique index "${key}"`;
        indexOptions = {
          name: key,
          unique: true,
          ...(value.partialFilterExpression
            ? { partialFilterExpression: value.partialFilterExpression }
            : {}),
        };
        break;
      }
      case "text": {
        host._log("createIndex (text)", key, value.fields);
        label = `create text index "${key}"`;
        indexOptions = { weights: value.weights, name: key };
        break;
      }
      case "2dsphere": {
        host._log("createIndex (2dsphere)", key, value.fields);
        label = `create 2dsphere index "${key}"`;
        indexOptions = { name: key };
        break;
      }
    }
    await attempt(label, () => host.collection.createIndex(value.fields, indexOptions));
  }

  // ── Sync search indexes (Atlas-only, gracefully skipped on standalone) ──
  try {
    const toUpdate = new Set<string>();
    const existingSearchIndexes = (await host.collection
      .listSearchIndexes()
      .toArray()) as TRemoteMongoSearchIndex[];

    for (const remote of existingSearchIndexes) {
      if (!remote.name.startsWith(INDEX_PREFIX)) {
        continue;
      }
      if (indexesToCreate.has(remote.name)) {
        const local = indexesToCreate.get(remote.name)!;
        const right = remote.latestDefinition;
        switch (local.type) {
          case "dynamic_text":
          case "search_text": {
            const left = local.definition;
            if (
              left.analyzer === right.analyzer &&
              fieldsMatch(left.mappings!.fields || {}, right.mappings!.fields || {})
            ) {
              indexesToCreate.delete(remote.name);
            } else {
              toUpdate.add(remote.name);
            }
            break;
          }
          case "vector": {
            if (vectorFieldsMatch(local.definition.fields || [], right.fields || [])) {
              indexesToCreate.delete(remote.name);
            } else {
              toUpdate.add(remote.name);
            }
            break;
          }
          default:
        }
      } else {
        if (remote.status !== "DELETING") {
          host._log("dropSearchIndex", remote.name);
          await host.collection.dropSearchIndex(remote.name);
        }
      }
    }

    for (const [key, value] of indexesToCreate.entries()) {
      switch (value.type) {
        case "dynamic_text":
        case "search_text":
        case "vector": {
          if (toUpdate.has(key)) {
            host._log("updateSearchIndex", key, value.definition);
            await host.collection.updateSearchIndex(key, value.definition);
          } else {
            host._log("createSearchIndex", key, value.type);
            await host.collection.createSearchIndex({
              name: key,
              type: value.type === "vector" ? "vectorSearch" : "search",
              definition: value.definition,
            });
          }
          break;
        }
        default:
      }
    }
  } catch {
    // listSearchIndexes / createSearchIndex / updateSearchIndex are
    // Atlas-only — silently skip on standalone or in-memory MongoDB.
  }

  throwIfAny();
}

// ── Index comparison helpers ─────────────────────────────────────────────────

/**
 * Maps an engine-agnostic design type to the MongoDB BSON `$type` alias(es)
 * meaning "a present value of this type". Using `$type` (rather than a bare
 * `sparse: true` or `$exists: true`) excludes BOTH absent and explicit-null
 * values, so a row whose optional field was written as `null` — e.g. by a
 * replace-strategy patch — is still tolerated by the unique constraint.
 */
function bsonPresentTypes(designType?: string): string | string[] {
  switch (designType) {
    case "string":
      return "string";
    case "objectId":
      // mongo.objectId is declared as a string primitive, but a value may be
      // persisted as a 24-hex string (the typed contract) OR a native BSON
      // ObjectId. Match both so neither representation escapes the constraint.
      return ["objectId", "string"];
    case "number":
    case "decimal":
      // The "number" alias matches int, long, double, and decimal.
      return "number";
    case "boolean":
      return "bool";
    default:
      // Unknown / union / object / array: match any present non-null BSON type.
      return [
        "double",
        "string",
        "object",
        "array",
        "binData",
        "objectId",
        "bool",
        "date",
        "regex",
        "int",
        "timestamp",
        "long",
        "decimal",
      ];
  }
}

/**
 * Builds a `partialFilterExpression` restricting a unique index to rows where
 * every OPTIONAL field is present. Returns undefined when no field is optional
 * (a plain unique index — no nulls possible — needs no filter).
 *
 * Filtering on the optional fields (not the required ones) matches SQL's NULLS
 * DISTINCT: a composite unique row is exempt as soon as any nullable column is
 * null, so many value-less rows coexist while fully populated rows stay unique.
 */
function buildPresentOnlyFilter(
  indexFields: ReadonlyArray<{ name: string; optional?: boolean; designType?: string }>,
): Record<string, unknown> | undefined {
  const optional = indexFields.filter((f) => f.optional);
  if (optional.length === 0) {
    return undefined;
  }
  // Sort clauses by field name so a pure field-order change in the model does
  // not alter the stored filter and trigger a needless drop+recreate on sync.
  const clauses = optional
    .map((f) => ({ name: f.name, clause: { [f.name]: { $type: bsonPresentTypes(f.designType) } } }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((c) => c.clause);
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

/**
 * Deep structural equality for `partialFilterExpression` objects, used to detect
 * when a unique index's present-only filter has changed. Object keys compare
 * order-insensitively; arrays (`$and`, `$type` lists) are order-sensitive,
 * matching this module's deterministic emission. A missing filter (undefined)
 * and an explicit `null` both mean "no filter" and compare equal.
 */
function partialFilterEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a == null || b == null) {
    return a == null && b == null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => partialFilterEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) {
      return false;
    }
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        partialFilterEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function objMatch(
  o1: Record<string, number | string>,
  o2: Record<string, number | string>,
): boolean {
  const keys1 = Object.keys(o1);
  const keys2 = Object.keys(o2);
  if (keys1.length !== keys2.length) {
    return false;
  }
  for (const key of keys1) {
    if (o1[key] !== o2[key]) {
      return false;
    }
  }
  return true;
}

function fieldsMatch(
  left: Record<string, TSearchFieldMapping | TSearchFieldMapping[]> | undefined,
  right: Record<string, TSearchFieldMapping | TSearchFieldMapping[]> | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!(key in right)) {
      return false;
    }
    if (!fieldMappingEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

/** Order-independent structural compare of a field's Atlas type mapping(s). */
function fieldMappingEqual(
  a: TSearchFieldMapping | TSearchFieldMapping[],
  b: TSearchFieldMapping | TSearchFieldMapping[],
): boolean {
  const am = mappingsByType(a);
  const bm = mappingsByType(b);
  if (am.size !== bm.size) {
    return false;
  }
  for (const [type, av] of am) {
    const bv = bm.get(type);
    if (
      !bv ||
      av.analyzer !== bv.analyzer ||
      av.tokenization !== bv.tokenization ||
      av.minGrams !== bv.minGrams ||
      av.maxGrams !== bv.maxGrams ||
      av.foldDiacritics !== bv.foldDiacritics
    ) {
      return false;
    }
    // Recurse into `document` / `embeddedDocuments` container nodes so drift on a
    // nested leaf (or a changed container shape) is detected. `fieldsMatch`
    // treats both-absent as equal and absent-vs-present as drift.
    if (!fieldsMatch(av.fields, bv.fields)) {
      return false;
    }
  }
  return true;
}

function mappingsByType(
  m: TSearchFieldMapping | TSearchFieldMapping[],
): Map<string, TSearchFieldMapping> {
  const map = new Map<string, TSearchFieldMapping>();
  for (const x of Array.isArray(m) ? m : [m]) {
    map.set(x.type, x);
  }
  return map;
}

function vectorFieldsMatch(
  left: Required<TMongoSearchIndexDefinition>["fields"],
  right: Required<TMongoSearchIndexDefinition>["fields"],
): boolean {
  if (left.length !== (right || []).length) {
    return false;
  }
  const rightMap = new Map<string, (typeof right)[number]>();
  for (const f of right || []) {
    rightMap.set(f.path, f);
  }
  for (const l of left) {
    const r = rightMap.get(l.path);
    if (!r) {
      return false;
    }
    if (
      l.type !== r.type ||
      l.path !== r.path ||
      l.similarity !== r.similarity ||
      l.numDimensions !== r.numDimensions
    ) {
      return false;
    }
  }
  return true;
}
