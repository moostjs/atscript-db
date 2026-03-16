import type { Collection, Db, Document } from "mongodb";
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
} from "./mongo-types";

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
        fields: ReadonlyArray<{ name: string; weight?: number }>;
      }
    >;
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

  // Renames — use $rename operator
  if (diff.renamed.length > 0) {
    const renameSpec: Record<string, string> = {};
    for (const r of diff.renamed) {
      renameSpec[r.oldName] = r.field.physicalName;
      renamed.push(r.field.physicalName);
    }
    update.$rename = renameSpec;
  }

  // Adds — use $set with default values
  if (diff.added.length > 0) {
    const setSpec: Record<string, unknown> = {};
    for (const field of diff.added) {
      const defaultVal = resolveSyncDefault(field);
      if (defaultVal !== undefined) {
        setSpec[field.physicalName] = defaultVal;
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
  const unsetSpec: Record<string, ""> = {};
  for (const col of columns) {
    unsetSpec[col] = "";
  }
  await host.collection.updateMany({}, { $unset: unsetSpec }, host._getSessionOpts());
}

/** Resolves a field's default value for bulk $set during column sync. */
function resolveSyncDefault(field: TDbFieldMeta): unknown {
  if (!field.defaultValue) {
    return field.optional ? null : undefined;
  }
  if (field.defaultValue.kind === "value") {
    return field.defaultValue.value;
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
    const fields: Record<string, 1 | "text"> = {};
    const weights: Record<string, number> = {};
    let mongoType: TPlainIndex["type"];
    if (index.type === "fulltext") {
      mongoType = "text";
      for (const f of index.fields) {
        fields[f.name] = "text";
        if (f.weight) {
          weights[f.name] = f.weight;
        }
      }
    } else {
      mongoType = index.type as "plain" | "unique";
      for (const f of index.fields) {
        fields[f.name] = 1;
      }
    }
    allIndexes.set(key, { key, name: index.name, type: mongoType, fields, weights });
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
        case "text": {
          if (
            (local.type === "text" || objMatch(local.fields, remote.key)) &&
            objMatch(local.weights || {}, remote.weights || {})
          ) {
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
        host._log("createIndex (unique)", key, value.fields);
        await host.collection.createIndex(value.fields, { name: key, unique: true });
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
  left: Record<string, { type: string; analyzer?: string }> | undefined,
  right: Record<string, { type: string; analyzer?: string }> | undefined,
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
    if (left[key].type !== right[key].type || left[key].analyzer !== right[key].analyzer) {
      return false;
    }
  }
  return true;
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
