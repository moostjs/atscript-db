import type { FilterExpr, WithRelation } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import type { TGenericLogger } from "../logger";
import type { TDbForeignKey, TDbRelation, TTableResolver } from "../types";
import { findFKForRelation, findRemoteFK, resolveRelationTargetTable } from "./relation-helpers";

// ── Types ────────────────────────────────────────────────────────────────────

/** Host interface for the relation loader — matches AtscriptDbReadable property names. */
export interface TRelationLoaderHost {
  readonly tableName: string;
  readonly _meta: {
    readonly relations: ReadonlyMap<string, TDbRelation>;
    readonly foreignKeys: ReadonlyMap<string, TDbForeignKey>;
  };
  readonly _tableResolver?: TTableResolver;
  readonly adapter: BaseDbAdapter;
  readonly logger: TGenericLogger;
}

/** Minimal interface for a resolved related table. */
interface TResolvedTable {
  findMany(query: unknown): Promise<Array<Record<string, unknown>>>;
  primaryKeys: readonly string[];
  relations: ReadonlyMap<string, TDbRelation>;
  foreignKeys: ReadonlyMap<string, TDbForeignKey>;
}

/** Per-relation filter + controls bundle. */
interface TRelationQuery {
  filter: FilterExpr | undefined;
  controls: Record<string, unknown>;
}

interface TAssignOpts {
  rows: Array<Record<string, unknown>>;
  related: Array<Record<string, unknown>>;
  localField: string;
  remoteField: string;
  relName: string;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Loads related data for `$with` relations and attaches them to result rows.
 */
export async function loadRelationsImpl(
  rows: Array<Record<string, unknown>>,
  withRelations: WithRelation[],
  host: TRelationLoaderHost,
): Promise<void> {
  if (rows.length === 0 || withRelations.length === 0) {
    return;
  }

  if (host.adapter.supportsNativeRelations()) {
    return host.adapter.loadRelations(
      rows,
      withRelations,
      host._meta.relations,
      host._meta.foreignKeys,
      host._tableResolver,
    );
  }

  if (!host._tableResolver) {
    return;
  }

  const tasks: Array<Promise<void>> = [];

  for (const withRel of withRelations) {
    const relName = withRel.name;
    if (relName.includes(".")) {
      continue;
    }

    const relation = host._meta.relations.get(relName);
    if (!relation) {
      throw new Error(
        `Unknown relation "${relName}" in $with. Available relations: ${[...host._meta.relations.keys()].join(", ") || "(none)"}`,
      );
    }

    const targetType = relation.targetType();
    if (!targetType) {
      continue;
    }

    const targetTable = host._tableResolver(targetType);
    if (!targetTable) {
      host.logger.warn(`Could not resolve table for relation "${relName}" — skipping`);
      continue;
    }

    const filter =
      withRel.filter && Object.keys(withRel.filter).length > 0 ? withRel.filter : undefined;

    // @uniqu/url parseWithSegment places $sort/$limit/$skip/$select as flat
    // keys on the relation object rather than nesting under .controls.
    // Merge both shapes so relation loading works either way.
    const flatRel = withRel as Record<string, unknown>;
    const nested = (withRel.controls || {}) as Record<string, unknown>;
    const controls: Record<string, unknown> = { ...nested };
    if (flatRel.$sort && !controls.$sort) {
      controls.$sort = flatRel.$sort;
    }
    if (
      flatRel.$limit !== null &&
      flatRel.$limit !== undefined &&
      (controls.$limit === null || controls.$limit === undefined)
    ) {
      controls.$limit = flatRel.$limit;
    }
    if (
      flatRel.$skip !== null &&
      flatRel.$skip !== undefined &&
      (controls.$skip === null || controls.$skip === undefined)
    ) {
      controls.$skip = flatRel.$skip;
    }
    if (flatRel.$select && !controls.$select) {
      controls.$select = flatRel.$select;
    }
    if (flatRel.$with && !controls.$with) {
      controls.$with = flatRel.$with;
    }
    const relQuery: TRelationQuery = { filter, controls };

    if (relation.direction === "to") {
      tasks.push(loadToRelation(rows, { relName, relation, targetTable, relQuery }, host));
    } else if (relation.direction === "via") {
      tasks.push(loadViaRelation(rows, { relName, relation, targetTable, relQuery }, host));
    } else {
      tasks.push(loadFromRelation(rows, { relName, relation, targetTable, relQuery }, host));
    }
  }

  await Promise.all(tasks);
}

// ── Direction-specific loaders (module-private) ──────────────────────────────

/**
 * Loads a `@db.rel.to` relation (FK is on this table).
 */
async function loadToRelation(
  rows: Array<Record<string, unknown>>,
  opts: {
    relName: string;
    relation: TDbRelation;
    targetTable: TResolvedTable;
    relQuery: TRelationQuery;
  },
  host: TRelationLoaderHost,
): Promise<void> {
  const { relName, relation, targetTable, relQuery } = opts;
  const fkEntry = findFKForRelation(relation, host._meta.foreignKeys);
  if (!fkEntry) {
    return;
  }

  const { localFields, targetFields } = fkEntry;

  if (localFields.length === 1) {
    const localField = localFields[0];
    const targetField = targetFields[0];

    const fkValues = collectUniqueValues(rows, localField);
    if (fkValues.length === 0) {
      for (const row of rows) {
        row[relName] = null;
      }
      return;
    }

    const inFilter = { [targetField]: { $in: fkValues } };
    const targetFilter = relQuery.filter ? { $and: [inFilter, relQuery.filter] } : inFilter;

    const controls = ensureSelectIncludesFields(relQuery.controls, targetFields);
    const related = await targetTable.findMany({ filter: targetFilter, controls });

    assignSingle({ rows, related, localField, remoteField: targetField, relName });
  } else {
    const related = await queryCompositeFK(rows, {
      localFields,
      targetFields,
      targetTable,
      relQuery,
    });

    const index = new Map<string, Record<string, unknown>>();
    for (const item of related) {
      index.set(compositeKey(targetFields, item), item);
    }

    for (const row of rows) {
      row[relName] = index.get(compositeKey(localFields, row)) ?? null;
    }
  }
}

/**
 * Loads a `@db.rel.from` relation (FK is on the target table).
 */
async function loadFromRelation(
  rows: Array<Record<string, unknown>>,
  opts: {
    relName: string;
    relation: TDbRelation;
    targetTable: TResolvedTable;
    relQuery: TRelationQuery;
  },
  host: TRelationLoaderHost,
): Promise<void> {
  const { relName, relation, targetTable, relQuery } = opts;
  const remoteFK = findRemoteFK(targetTable, host.tableName, relation.alias);
  if (!remoteFK) {
    host.logger.warn(`Could not find FK on target table for relation "${relName}"`);
    return;
  }

  const localFields = remoteFK.targetFields;
  const remoteFields = remoteFK.fields;

  if (localFields.length === 1) {
    const localField = localFields[0];
    const remoteField = remoteFields[0];

    const pkValues = collectUniqueValues(rows, localField);
    if (pkValues.length === 0) {
      return;
    }

    const inFilter = { [remoteField]: { $in: pkValues } };
    const targetFilter = relQuery.filter ? { $and: [inFilter, relQuery.filter] } : inFilter;

    const controls = ensureSelectIncludesFields(relQuery.controls, remoteFields);
    const related = await targetTable.findMany({ filter: targetFilter, controls });

    if (relation.isArray) {
      assignGrouped({ rows, related, localField, remoteField, relName });
    } else {
      assignSingle({ rows, related, localField, remoteField, relName });
    }
  } else {
    const related = await queryCompositeFK(rows, {
      localFields,
      targetFields: remoteFields,
      targetTable,
      relQuery,
    });

    if (relation.isArray) {
      const groups = new Map<string, Array<Record<string, unknown>>>();
      for (const item of related) {
        const key = compositeKey(remoteFields, item);
        let group = groups.get(key);
        if (!group) {
          group = [];
          groups.set(key, group);
        }
        group.push(item);
      }
      for (const row of rows) {
        row[relName] = groups.get(compositeKey(localFields, row)) ?? [];
      }
    } else {
      const index = new Map<string, Record<string, unknown>>();
      for (const item of related) {
        const key = compositeKey(remoteFields, item);
        if (!index.has(key)) {
          index.set(key, item);
        }
      }
      for (const row of rows) {
        row[relName] = index.get(compositeKey(localFields, row)) ?? null;
      }
    }
  }
}

/**
 * Loads a `@db.rel.via` relation (M:N through a junction table).
 */
async function loadViaRelation(
  rows: Array<Record<string, unknown>>,
  opts: {
    relName: string;
    relation: TDbRelation;
    targetTable: TResolvedTable;
    relQuery: TRelationQuery;
  },
  host: TRelationLoaderHost,
): Promise<void> {
  const { relName, relation, targetTable, relQuery } = opts;

  if (!relation.viaType || !host._tableResolver) {
    return;
  }

  const junctionType = relation.viaType();
  if (!junctionType) {
    return;
  }

  const junctionTable = host._tableResolver(junctionType);
  if (!junctionTable) {
    host.logger.warn(`Could not resolve junction table for via relation "${relName}"`);
    return;
  }

  // Find FK on junction that points to THIS table
  const fkToThis = findRemoteFK(junctionTable, host.tableName);
  if (!fkToThis) {
    host.logger.warn(
      `Could not find FK on junction table pointing to "${host.tableName}" for via relation "${relName}"`,
    );
    return;
  }

  // Find FK on junction that points to TARGET table
  const targetTableName = resolveRelationTargetTable(relation);
  const fkToTarget = findRemoteFK(junctionTable, targetTableName);
  if (!fkToTarget) {
    host.logger.warn(
      `Could not find FK on junction table pointing to target "${targetTableName}" for via relation "${relName}"`,
    );
    return;
  }

  const localPKFields = fkToThis.targetFields;
  const junctionLocalFields = fkToThis.fields;
  const targetPKFields = fkToTarget.targetFields;
  const junctionTargetFields = fkToTarget.fields;

  if (localPKFields.length === 1) {
    await loadViaSingleKey(rows, {
      relName,
      relation,
      targetTable,
      relQuery,
      localPKFields,
      junctionLocalFields,
      targetPKFields,
      junctionTargetFields,
      junctionTable,
    });
  } else {
    await loadViaCompositeKey(rows, {
      relName,
      relation,
      targetTable,
      relQuery,
      localPKFields,
      junctionLocalFields,
      targetPKFields,
      junctionTargetFields,
      junctionTable,
    });
  }
}

// ── VIA sub-paths ────────────────────────────────────────────────────────────

interface TViaOpts {
  relName: string;
  relation: TDbRelation;
  targetTable: TResolvedTable;
  relQuery: TRelationQuery;
  localPKFields: string[];
  junctionLocalFields: string[];
  targetPKFields: string[];
  junctionTargetFields: string[];
  junctionTable: TResolvedTable;
}

async function loadViaSingleKey(
  rows: Array<Record<string, unknown>>,
  opts: TViaOpts,
): Promise<void> {
  const {
    relName,
    relation,
    targetTable,
    relQuery,
    localPKFields,
    junctionLocalFields,
    targetPKFields,
    junctionTargetFields,
    junctionTable,
  } = opts;
  const localField = localPKFields[0];
  const junctionLocalField = junctionLocalFields[0];
  const junctionTargetField = junctionTargetFields[0];
  const targetPKField = targetPKFields[0];

  const pkValues = collectUniqueValues(rows, localField);
  if (pkValues.length === 0) {
    for (const row of rows) {
      row[relName] = [];
    }
    return;
  }

  // Query junction table
  const junctionFilter = { [junctionLocalField]: { $in: pkValues } };
  const junctionRows = await junctionTable.findMany({
    filter: junctionFilter,
    controls: { $select: [junctionLocalField, junctionTargetField] },
  });

  if (junctionRows.length === 0) {
    for (const row of rows) {
      row[relName] = relation.isArray ? [] : null;
    }
    return;
  }

  // Collect unique target FK values from junction
  const targetFKValues = collectUniqueValues(junctionRows, junctionTargetField);

  // Query target table
  const inFilter = { [targetPKField]: { $in: targetFKValues } };
  const targetFilter = relQuery.filter ? { $and: [inFilter, relQuery.filter] } : inFilter;
  const controls = ensureSelectIncludesFields(relQuery.controls, targetPKFields);
  const targetRows = await targetTable.findMany({ filter: targetFilter, controls });

  // Index target rows by PK
  const targetIndex = new Map<string, Record<string, unknown>>();
  for (const item of targetRows) {
    targetIndex.set(String(item[targetPKField]), item);
  }

  // Group junction rows by local FK, resolve to target records
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const jRow of junctionRows) {
    const localKey = String(jRow[junctionLocalField]);
    const targetKey = String(jRow[junctionTargetField]);
    const target = targetIndex.get(targetKey);
    if (!target) {
      continue;
    }

    let group = groups.get(localKey);
    if (!group) {
      group = [];
      groups.set(localKey, group);
    }
    group.push(target);
  }

  // Assign to rows
  for (const row of rows) {
    const key = String(row[localField]);
    row[relName] = relation.isArray ? (groups.get(key) ?? []) : (groups.get(key)?.[0] ?? null);
  }
}

async function loadViaCompositeKey(
  rows: Array<Record<string, unknown>>,
  opts: TViaOpts,
): Promise<void> {
  const {
    relName,
    relation,
    targetTable,
    relQuery,
    localPKFields,
    junctionLocalFields,
    targetPKFields,
    junctionTargetFields,
    junctionTable,
  } = opts;

  // Build OR filter for junction
  const orFilters: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const condition: Record<string, unknown> = {};
    let valid = true;
    for (let i = 0; i < localPKFields.length; i++) {
      const val = row[localPKFields[i]];
      if (val === null || val === undefined) {
        valid = false;
        break;
      }
      condition[junctionLocalFields[i]] = val;
    }
    if (valid) {
      orFilters.push(condition);
    }
  }

  if (orFilters.length === 0) {
    for (const row of rows) {
      row[relName] = relation.isArray ? [] : null;
    }
    return;
  }

  const junctionFilter = orFilters.length === 1 ? orFilters[0] : { $or: orFilters };
  const junctionRows = await junctionTable.findMany({
    filter: junctionFilter,
    controls: { $select: [...junctionLocalFields, ...junctionTargetFields] },
  });

  if (junctionRows.length === 0) {
    for (const row of rows) {
      row[relName] = relation.isArray ? [] : null;
    }
    return;
  }

  // Query targets
  const targetOrFilters: Array<Record<string, unknown>> = [];
  const seenTargets = new Set<string>();
  for (const jRow of junctionRows) {
    const key = compositeKey(junctionTargetFields, jRow);
    if (seenTargets.has(key)) {
      continue;
    }
    seenTargets.add(key);
    const condition: Record<string, unknown> = {};
    for (let i = 0; i < junctionTargetFields.length; i++) {
      condition[targetPKFields[i]] = jRow[junctionTargetFields[i]];
    }
    targetOrFilters.push(condition);
  }

  const targetBaseFilter =
    targetOrFilters.length === 1 ? targetOrFilters[0] : { $or: targetOrFilters };
  const finalFilter = relQuery.filter
    ? { $and: [targetBaseFilter, relQuery.filter] }
    : targetBaseFilter;
  const targetRows = await targetTable.findMany({
    filter: finalFilter,
    controls: relQuery.controls,
  });

  // Index targets
  const targetIndex = new Map<string, Record<string, unknown>>();
  for (const item of targetRows) {
    targetIndex.set(compositeKey(targetPKFields, item), item);
  }

  // Group and assign
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const jRow of junctionRows) {
    const localKey = compositeKey(junctionLocalFields, jRow);
    const targetKey = compositeKey(junctionTargetFields, jRow);
    const target = targetIndex.get(targetKey);
    if (!target) {
      continue;
    }

    let group = groups.get(localKey);
    if (!group) {
      group = [];
      groups.set(localKey, group);
    }
    group.push(target);
  }

  for (const row of rows) {
    const key = compositeKey(localPKFields, row);
    row[relName] = relation.isArray ? (groups.get(key) ?? []) : (groups.get(key)?.[0] ?? null);
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * If controls include an array-style $select, ensure the given join fields
 * are present so that FK matching works after the query returns.
 */
function ensureSelectIncludesFields(
  controls: Record<string, unknown> | undefined,
  fields: string[],
): Record<string, unknown> | undefined {
  if (!controls) {
    return controls;
  }
  const sel = controls.$select;
  if (!Array.isArray(sel)) {
    return controls;
  }
  const augmented = [...sel];
  for (const f of fields) {
    if (!augmented.includes(f)) {
      augmented.push(f);
    }
  }
  return { ...controls, $select: augmented };
}

function compositeKey(fields: string[], obj: Record<string, unknown>): string {
  let key = "";
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) {
      key += "\0\0";
    }
    const v: unknown = obj[fields[i]];
    key += v === null || v === undefined ? "\0" : String(v as string | number | boolean); // null or undefined becomes empty string, distinct from literal '\0' value.
  }
  return key;
}

/** Collects unique non-null values for a field across rows. */
function collectUniqueValues(rows: Array<Record<string, unknown>>, field: string): unknown[] {
  const set = new Set<unknown>();
  for (const row of rows) {
    const v = row[field];
    if (v !== null && v !== undefined) {
      set.add(v);
    }
  }
  return [...set];
}

/** Assigns related items grouped by FK value (one-to-many). */
function assignGrouped(opts: TAssignOpts): void {
  const { rows, related, localField, remoteField, relName } = opts;
  const groups = new Map<unknown, Array<Record<string, unknown>>>();
  for (const item of related) {
    const key = item[remoteField];
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(item);
  }
  for (const row of rows) {
    row[relName] = groups.get(row[localField]) ?? [];
  }
}

/** Assigns related items by FK value (many-to-one / one-to-one). */
function assignSingle(opts: TAssignOpts): void {
  const { rows, related, localField, remoteField, relName } = opts;
  const index = new Map<unknown, Record<string, unknown>>();
  for (const item of related) {
    const key = item[remoteField];
    if (!index.has(key)) {
      index.set(key, item);
    }
  }
  for (const row of rows) {
    row[relName] = index.get(row[localField]) ?? null;
  }
}

/** Batch query for composite FK. */
function queryCompositeFK(
  rows: Array<Record<string, unknown>>,
  opts: {
    localFields: string[];
    targetFields: string[];
    targetTable: TResolvedTable;
    relQuery: TRelationQuery;
  },
): Promise<Array<Record<string, unknown>>> {
  const { localFields, targetFields, targetTable, relQuery } = opts;
  const seen = new Set<string>();
  const orFilters: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const key = compositeKey(localFields, row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const condition: Record<string, unknown> = {};
    let valid = true;
    for (let i = 0; i < localFields.length; i++) {
      const val = row[localFields[i]];
      if (val === null || val === undefined) {
        valid = false;
        break;
      }
      condition[targetFields[i]] = val;
    }
    if (valid) {
      orFilters.push(condition);
    }
  }

  if (orFilters.length === 0) {
    return Promise.resolve([]);
  }

  const baseFilter = orFilters.length === 1 ? orFilters[0] : { $or: orFilters };
  const targetFilter = relQuery.filter ? { $and: [baseFilter, relQuery.filter] } : baseFilter;

  return targetTable.findMany({ filter: targetFilter, controls: relQuery.controls });
}
