import type { Collection, Db, Document } from "mongodb";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import {
  AtscriptDbView,
  type TColumnDiff,
  type TSyncColumnResult,
  type TDbFieldMeta,
  type TExistingTableOption,
  type TViewColumnMapping,
  type AtscriptQueryNode,
  type AtscriptQueryFieldRef,
} from "@atscript/db";
import {
  INDEX_PREFIX,
  JOINED_PREFIX,
  type TMongoIndex,
  type TPlainIndex,
  type TMongoSearchIndexDefinition,
  type TSearchFieldMapping,
} from "./mongo-types";
import { hasAncestorIn, isArrayPath, joinPath } from "./path-utils";

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
): Promise<TExistingTableOption[]> {
  const cols = await host.db
    .listCollections({ name: host._table.tableName }, { nameOnly: false })
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
  if (table instanceof AtscriptDbView && !table.isExternal) {
    return ensureView(host, table as AtscriptDbView);
  }
  return host.ensureCollectionExists();
}

/** Creates a MongoDB view from the AtscriptDbView's view plan. */
async function ensureView(host: TMongoSchemaSyncHost, view: AtscriptDbView): Promise<void> {
  const exists = await host.collectionExists();
  if (exists) {
    return;
  }

  const plan = view.viewPlan;
  const columns = view.getViewColumnMappings();
  const pipeline: Document[] = [];

  // $lookup + $unwind for each join
  for (const join of plan.joins) {
    const { localField, foreignField } = resolveJoinFields(
      join.condition,
      plan.entryTable,
      join.targetTable,
    );
    pipeline.push({
      $lookup: {
        from: join.targetTable,
        localField,
        foreignField,
        as: `${JOINED_PREFIX}${join.targetTable}`,
      },
    });
    // LEFT JOIN semantics: unwind with preserveNullAndEmptyArrays
    pipeline.push({
      $unwind: {
        path: `$__joined_${join.targetTable}`,
        preserveNullAndEmptyArrays: true,
      },
    });
  }

  // $match for view filter
  if (plan.filter) {
    const matchExpr = queryNodeToMatch(plan.filter, plan.entryTable);
    pipeline.push({ $match: matchExpr });
  }

  // Check if any column has aggregate functions
  const hasAggregates = columns.some((c) => c.aggFn);

  /** Resolves a column to its MongoDB source field path. */
  const colSourceField = (col: TViewColumnMapping) =>
    col.sourceTable === plan.entryTable
      ? `$${col.sourceColumn}`
      : `$${JOINED_PREFIX}${col.sourceTable}.${col.sourceColumn}`;

  if (hasAggregates) {
    // $group stage — dimension columns into _id, aggregates as accumulators
    const group: Record<string, unknown> = { _id: {} };
    const project: Record<string, unknown> = { _id: 0 };

    for (const col of columns) {
      if (col.aggFn) {
        if (col.aggFn === "count" && col.aggField === "*") {
          group[col.viewColumn] = { $sum: 1 };
        } else {
          group[col.viewColumn] = { [`$${col.aggFn}`]: colSourceField(col) };
        }
        project[col.viewColumn] = `$${col.viewColumn}`;
      } else {
        // Dimension column — add to _id
        (group._id as Record<string, unknown>)[col.viewColumn] = colSourceField(col);
        project[col.viewColumn] = `$_id.${col.viewColumn}`;
      }
    }

    pipeline.push({ $group: group });

    // HAVING → $match (post-group filter)
    // After $group, aggregate fields are top-level and dimension fields are under _id
    if (plan.having) {
      const havingMatch = queryNodeToHaving(plan.having, columns);
      pipeline.push({ $match: havingMatch });
    }

    pipeline.push({ $project: project });
  } else {
    // Non-aggregate view — flat $project
    const project: Record<string, unknown> = { _id: 0 };
    for (const col of columns) {
      project[col.viewColumn] = colSourceField(col);
    }
    pipeline.push({ $project: project });
  }

  host._log("createView", host._table.tableName, plan.entryTable, pipeline);
  await host.db.createCollection(host._table.tableName, {
    viewOn: plan.entryTable,
    pipeline,
  });
}

// ── View helpers (pure) ──────────────────────────────────────────────────────

/** Extracts localField/foreignField from a join condition. */
function resolveJoinFields(
  condition: AtscriptQueryNode,
  entryTable: string,
  joinTable: string,
): { localField: string; foreignField: string } {
  // Walk through $and if present (single-condition $and wrapper)
  const comp =
    "$and" in condition ? (condition as { $and: AtscriptQueryNode[] }).$and[0] : condition;
  const c = comp as { left: AtscriptQueryFieldRef; op: string; right: AtscriptQueryFieldRef };

  const leftTable = c.left.type
    ? (c.left.type()?.metadata?.get("db.table") as string) || ""
    : entryTable;
  // Determine which side is the entry table (local) and which is the join table (foreign)
  if (leftTable === joinTable) {
    return { localField: (c.right as AtscriptQueryFieldRef).field, foreignField: c.left.field };
  }
  return { localField: c.left.field, foreignField: (c.right as AtscriptQueryFieldRef).field };
}

/** Translates an AtscriptQueryNode to a MongoDB $match expression. */
function queryNodeToMatch(node: AtscriptQueryNode, entryTable: string): Document {
  if ("$and" in node) {
    const items = (node as { $and: AtscriptQueryNode[] }).$and;
    const result: Document[] = [];
    for (const item of items) {
      result.push(queryNodeToMatch(item, entryTable));
    }
    return { $and: result };
  }
  if ("$or" in node) {
    const items = (node as { $or: AtscriptQueryNode[] }).$or;
    const result: Document[] = [];
    for (const item of items) {
      result.push(queryNodeToMatch(item, entryTable));
    }
    return { $or: result };
  }
  if ("$not" in node) {
    return { $not: queryNodeToMatch((node as { $not: AtscriptQueryNode }).$not, entryTable) };
  }

  const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
  const fieldPath = resolveViewFieldPath(comp.left, entryTable);

  // Field-to-field comparison
  if (comp.right && typeof comp.right === "object" && "field" in (comp.right as object)) {
    const rightPath = resolveViewFieldPath(comp.right as AtscriptQueryFieldRef, entryTable);
    return { $expr: { [comp.op]: [`$${fieldPath}`, `$${rightPath}`] } };
  }

  // Value comparison
  if (comp.op === "$eq") {
    return { [fieldPath]: comp.right };
  }
  if (comp.op === "$ne") {
    return { [fieldPath]: { $ne: comp.right } };
  }
  return { [fieldPath]: { [comp.op]: comp.right } };
}

/** Resolves a field ref to a MongoDB dot path for view pipeline expressions. */
function resolveViewFieldPath(ref: AtscriptQueryFieldRef, entryTable: string): string {
  if (!ref.type) {
    return ref.field;
  }
  const table = (ref.type()?.metadata?.get("db.table") as string) || "";
  if (table === entryTable) {
    return ref.field;
  }
  return `${JOINED_PREFIX}${table}.${ref.field}`;
}

/**
 * Translates an AtscriptQueryNode to a MongoDB $match for use after $group (HAVING).
 * After $group, aggregate fields are top-level and dimension fields are under _id.
 */
function queryNodeToHaving(node: AtscriptQueryNode, columns: TViewColumnMapping[]): Document {
  const colMap = new Map(columns.map((c) => [c.viewColumn, c]));

  const resolveHavingField = (ref: AtscriptQueryFieldRef): string => {
    if (!ref.type) {
      const col = colMap.get(ref.field);
      // Aggregate fields are top-level after $group, dimension fields are under _id
      if (col?.aggFn) {
        return ref.field;
      }
      if (col) {
        return `_id.${ref.field}`;
      }
    }
    return ref.field;
  };

  return queryNodeToHavingInner(node, resolveHavingField);
}

function queryNodeToHavingInner(
  node: AtscriptQueryNode,
  resolveField: (ref: AtscriptQueryFieldRef) => string,
): Document {
  if ("$and" in node) {
    return {
      $and: (node as { $and: AtscriptQueryNode[] }).$and.map((n) =>
        queryNodeToHavingInner(n, resolveField),
      ),
    };
  }
  if ("$or" in node) {
    return {
      $or: (node as { $or: AtscriptQueryNode[] }).$or.map((n) =>
        queryNodeToHavingInner(n, resolveField),
      ),
    };
  }
  if ("$not" in node) {
    return {
      $not: queryNodeToHavingInner((node as { $not: AtscriptQueryNode }).$not, resolveField),
    };
  }

  const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
  const fieldPath = resolveField(comp.left);

  if (comp.right && typeof comp.right === "object" && "field" in (comp.right as object)) {
    const rightPath = resolveField(comp.right as AtscriptQueryFieldRef);
    return { $expr: { [comp.op]: [`$${fieldPath}`, `$${rightPath}`] } };
  }

  if (comp.op === "$eq") {
    return { [fieldPath]: comp.right };
  }
  if (comp.op === "$ne") {
    return { [fieldPath]: { $ne: comp.right } };
  }
  return { [fieldPath]: { [comp.op]: comp.right } };
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
  const update: Record<string, Record<string, unknown>> = {};

  // Renames — use $rename operator. $rename does not support array-positional
  // operators; fields crossing an array boundary need a separate aggregation-
  // pipeline update. Fall back to a flat $rename for non-array paths and skip
  // (with a log) anything that would cross an array — Mongo would reject it.
  if (diff.renamed.length > 0) {
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
    if (Object.keys(renameSpec).length > 0) {
      update.$rename = renameSpec;
    }
  }

  // Adds — use $set with default values. Optional fields with no @db.default.*
  // get no backfill (the field stays absent on existing docs, which is exactly
  // what "optional" means in Mongo). For fields crossing an array boundary,
  // rewrite the path to use $[] so the $set walks every existing element and
  // is a no-op on empty arrays (Mongo would otherwise reject with code 28).
  if (diff.added.length > 0) {
    const setSpec: Record<string, unknown> = {};
    for (const field of diff.added) {
      const defaultVal = resolveSyncDefault(field);
      if (defaultVal !== undefined) {
        setSpec[arraySafePath(host, field.physicalName, field.path)] = defaultVal;
      }
      added.push(field.physicalName);
    }
    if (Object.keys(setSpec).length > 0) {
      update.$set = setSpec;
    }
  }

  if (Object.keys(update).length > 0) {
    await host.collection.updateMany({}, update, host._getSessionOpts());
  }

  return { added, renamed };
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
    // remain (we're dropping a sub-field, not the parent array). Passing the
    // column name as both args lets arraySafePath probe those ancestors and
    // emit $[] where needed.
    unsetSpec[arraySafePath(host, col, col)] = "";
  }
  await host.collection.updateMany({}, { $unset: unsetSpec }, host._getSessionOpts());
}

/**
 * Rewrites a dotted physical path to use Mongo's all-positional $[] operator
 * at every segment that's typed as an array in the table's flatMap. Returns
 * the input unchanged when no segment crosses an array boundary.
 *
 * `logicalPath` drives the array-boundary walk (flatMap is keyed by logical
 * path); the leaf of `physicalPath` is preserved so any `@db.column` rename
 * on the leaf still applies.
 */
function arraySafePath(
  host: TMongoSchemaSyncHost,
  physicalPath: string,
  logicalPath: string,
): string {
  const logicalSegments = logicalPath.split(".");
  if (logicalSegments.length < 2) {
    return physicalPath;
  }
  const physicalSegments = physicalPath.split(".");
  const physicalLeaf = physicalSegments[physicalSegments.length - 1]!;
  const out: string[] = [];
  let prefix = "";
  for (let i = 0; i < logicalSegments.length; i++) {
    const isLeaf = i === logicalSegments.length - 1;
    out.push(isLeaf ? physicalLeaf : logicalSegments[i]!);
    prefix = joinPath(prefix, logicalSegments[i]!);
    if (!isLeaf && isArrayPath(host._table.flatMap, prefix)) {
      out.push("$[]");
    }
  }
  return out.join(".");
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

  for (const remote of existingIndexes) {
    if (!remote.name.startsWith(INDEX_PREFIX)) {
      continue;
    }
    if (indexesToCreate.has(remote.name)) {
      const local = indexesToCreate.get(remote.name)!;
      switch (local.type) {
        case "plain":
        case "unique":
        case "text":
        case "2dsphere": {
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
            await host.collection.dropIndex(remote.name);
          }
          break;
        }
        default:
      }
    } else {
      host._log("dropIndex", remote.name);
      await host.collection.dropIndex(remote.name);
    }
  }

  // ── Create / update regular indexes ─────────────────────────────
  for (const [key, value] of allIndexes.entries()) {
    switch (value.type) {
      case "plain": {
        if (!indexesToCreate.has(key)) {
          continue;
        }
        host._log("createIndex", key, value.fields);
        await host.collection.createIndex(value.fields, { name: key });
        break;
      }
      case "unique": {
        if (!indexesToCreate.has(key)) {
          continue;
        }
        host._log("createIndex (unique)", key, value.fields, value.partialFilterExpression);
        await host.collection.createIndex(value.fields, {
          name: key,
          unique: true,
          ...(value.partialFilterExpression
            ? { partialFilterExpression: value.partialFilterExpression }
            : {}),
        });
        break;
      }
      case "text": {
        if (!indexesToCreate.has(key)) {
          continue;
        }
        host._log("createIndex (text)", key, value.fields);
        await host.collection.createIndex(value.fields, { weights: value.weights, name: key });
        break;
      }
      case "2dsphere": {
        if (!indexesToCreate.has(key)) {
          continue;
        }
        host._log("createIndex (2dsphere)", key, value.fields);
        await host.collection.createIndex(value.fields, { name: key });
        break;
      }
      default:
    }
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
