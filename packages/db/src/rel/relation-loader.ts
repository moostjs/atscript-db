import type { FilterExpr, Uniquery, WithRelation } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import type { TGenericLogger } from "../logger";
import type { TDbForeignKey, TDbRelation, TTableResolver } from "../types";
import { andFilters, relationStaticFilter } from "../query/relation-filter";
import {
  type TGroupPage,
  compositeKey,
  findFKForRelation,
  findRemoteFK,
  resolveRelationTargetTable,
  slicePerGroup,
} from "./relation-helpers";

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
  /** `AtscriptDbReadable._findManyForRelation` — absent on a custom resolver's tables. */
  _findManyForRelation?(
    query: Uniquery,
    opts: {
      partitionBy?: readonly string[];
      pick?: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
    },
  ): Promise<Array<Record<string, unknown>>>;
  primaryKeys: readonly string[];
  relations: ReadonlyMap<string, TDbRelation>;
  foreignKeys: ReadonlyMap<string, TDbForeignKey>;
}

/** Per-relation filter + controls bundle. */
interface TRelationQuery {
  /** The `$with` sub-filter AND the target part of the relation's `@db.rel.filter`. */
  filter: FilterExpr | undefined;
  /** The relation's controls without `$skip` / `$limit` (see `page`). */
  controls: Record<string, unknown>;
  /** The relation's `$skip` / `$limit` — they page the related rows of EACH parent row. */
  page?: TGroupPage;
  /** `@db.rel.via`: the junction part of the relation's `@db.rel.filter`. */
  junctionFilter?: FilterExpr;
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

    // `@db.rel.filter` is part of the relation: its target conditions AND the
    // `$with` sub-filter; its junction conditions filter the junction rows.
    const statics = relationStaticFilter(relation, relName);
    const merged = andFilters(statics.target, withRel.filter);
    const filter = Object.keys(merged).length > 0 ? merged : undefined;

    // @uniqu/url parseWithSegment places $sort/$limit/$skip/$select as flat
    // keys on the relation object rather than nesting under .controls.
    // Merge both shapes so relation loading works either way.
    const flatRel = withRel as Record<string, unknown>;
    const nested = (withRel.controls || {}) as Record<string, unknown>;
    const controls: Record<string, unknown> = { ...nested };
    if (flatRel.$sort && !controls.$sort) {
      controls.$sort = flatRel.$sort;
    }
    if (flatRel.$nulls && !controls.$nulls) {
      controls.$nulls = flatRel.$nulls;
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
    const { $skip, $limit, ...pageless } = controls;
    const skip = asCount($skip) || undefined;
    const limit = asCount($limit);
    const relQuery: TRelationQuery = {
      filter,
      controls: pageless,
      page: skip === undefined && limit === undefined ? undefined : { skip, limit },
      junctionFilter: statics.junction,
    };

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

interface TLoadOpts {
  relName: string;
  relation: TDbRelation;
  targetTable: TResolvedTable;
  relQuery: TRelationQuery;
}

/**
 * Loads a `@db.rel.to` relation (FK is on this table). Single-valued: the
 * relation's `$skip` / `$limit` page each row's (at most one) target row.
 */
async function loadToRelation(
  rows: Array<Record<string, unknown>>,
  opts: TLoadOpts,
  host: TRelationLoaderHost,
): Promise<void> {
  const { relName, relation, targetTable, relQuery } = opts;
  const fkEntry = findFKForRelation(relation, host._meta.foreignKeys);
  if (!fkEntry) {
    return;
  }
  const { localFields, targetFields } = fkEntry;
  const related = await readRelatedByKeys(rows, {
    localFields,
    targetFields,
    targetTable,
    relQuery,
  });
  const index = indexFirst(related, targetFields);
  for (const row of rows) {
    row[relName] = index.get(compositeKey(localFields, row)) ?? null;
  }
}

/**
 * Loads a `@db.rel.from` relation (FK is on the target table). `$sort`,
 * `$skip` and `$limit` apply to the related rows of each row.
 */
async function loadFromRelation(
  rows: Array<Record<string, unknown>>,
  opts: TLoadOpts,
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
  const related = await readRelatedByKeys(rows, {
    localFields,
    targetFields: remoteFields,
    targetTable,
    relQuery,
  });

  if (relation.isArray) {
    const groups = groupBy(related, (item) => compositeKey(remoteFields, item));
    for (const row of rows) {
      row[relName] = groups.get(compositeKey(localFields, row)) ?? [];
    }
  } else {
    const index = indexFirst(related, remoteFields);
    for (const row of rows) {
      row[relName] = index.get(compositeKey(localFields, row)) ?? null;
    }
  }
}

/**
 * Loads a `@db.rel.via` relation (M:N through a junction table). The target
 * rows are read once for all rows; `$sort` orders, and `$skip` / `$limit`
 * page, the target rows of each row.
 */
async function loadViaRelation(
  rows: Array<Record<string, unknown>>,
  opts: TLoadOpts,
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
  const fields: TViaFields = {
    junctionLocalFields: fkToThis.fields,
    junctionTargetFields: fkToTarget.fields,
    targetPKFields: fkToTarget.targetFields,
  };

  const parentFilter = matchAnyFilter(rows, localPKFields, fields.junctionLocalFields);
  const junctionRows = parentFilter
    ? await junctionTable.findMany({
        filter: andFilters(parentFilter, relQuery.junctionFilter),
        controls: { $select: [...fields.junctionLocalFields, ...fields.junctionTargetFields] },
      })
    : [];
  const targetFilter = matchAnyFilter(
    junctionRows,
    fields.junctionTargetFields,
    fields.targetPKFields,
  );
  if (!targetFilter) {
    for (const row of rows) {
      row[relName] = relation.isArray ? [] : null;
    }
    return;
  }

  // One target read for all rows; each row's targets are grouped (and paged)
  // before the targets' own `$with` relations load on the ones kept.
  const sorted = hasSort(relQuery.controls);
  let groups = new Map<string, Array<Record<string, unknown>>>();
  const pick = (targets: Array<Record<string, unknown>>) => {
    groups = groupViaTargets(targets, junctionRows, fields, sorted);
    const page = relQuery.page;
    if (!page) {
      return targets;
    }
    const start = page.skip ?? 0;
    const end = page.limit === undefined ? undefined : start + page.limit;
    const kept = new Set<Record<string, unknown>>();
    for (const [key, group] of groups) {
      const slice = group.slice(start, end);
      groups.set(key, slice);
      for (const target of slice) kept.add(target);
    }
    return targets.filter((target) => kept.has(target));
  };

  const filter = relQuery.filter ? { $and: [targetFilter, relQuery.filter] } : targetFilter;
  const controls = ensureSelectIncludesFields(relQuery.controls, fields.targetPKFields);
  await readRelated(targetTable, { filter, controls }, { pick });

  for (const row of rows) {
    const group = groups.get(compositeKey(localPKFields, row));
    row[relName] = relation.isArray ? (group ?? []) : (group?.[0] ?? null);
  }
}

interface TViaFields {
  junctionLocalFields: string[];
  junctionTargetFields: string[];
  targetPKFields: string[];
}

/**
 * Each row's targets (keyed by the junction's local key), once per junction
 * row. The junction rows only map rows to targets: with a `$sort` the targets
 * keep the order the target read returned them in, else junction order.
 */
function groupViaTargets(
  targets: Array<Record<string, unknown>>,
  junctionRows: Array<Record<string, unknown>>,
  fields: TViaFields,
  sorted: boolean,
): Map<string, Array<Record<string, unknown>>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  if (sorted) {
    const linksByTarget = groupBy(junctionRows, (jRow) =>
      compositeKey(fields.junctionTargetFields, jRow),
    );
    for (const target of targets) {
      for (const jRow of linksByTarget.get(compositeKey(fields.targetPKFields, target)) ?? []) {
        appendTo(groups, compositeKey(fields.junctionLocalFields, jRow), target);
      }
    }
  } else {
    const index = indexFirst(targets, fields.targetPKFields);
    for (const jRow of junctionRows) {
      const target = index.get(compositeKey(fields.junctionTargetFields, jRow));
      if (target) {
        appendTo(groups, compositeKey(fields.junctionLocalFields, jRow), target);
      }
    }
  }
  return groups;
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Reads the target rows whose `targetFields` match `localFields` of any of
 * `rows`, the relation's `$skip` / `$limit` applied per such row.
 */
async function readRelatedByKeys(
  rows: Array<Record<string, unknown>>,
  opts: {
    localFields: string[];
    targetFields: string[];
    targetTable: TResolvedTable;
    relQuery: TRelationQuery;
  },
): Promise<Array<Record<string, unknown>>> {
  const { localFields, targetFields, targetTable, relQuery } = opts;
  const keyFilter = matchAnyFilter(rows, localFields, targetFields);
  if (!keyFilter) {
    return [];
  }
  const filter = relQuery.filter ? { $and: [keyFilter, relQuery.filter] } : keyFilter;
  const controls = ensureSelectIncludesFields(relQuery.controls, targetFields);
  return readRelated(
    targetTable,
    { filter, controls },
    { partitionBy: targetFields, page: relQuery.page },
  );
}

/**
 * Reads related rows. With `partitionBy` and a `page`, the page applies per
 * group of rows sharing the `partitionBy` values; `pick` keeps a subset of
 * the rows before their own (nested) `$with` relations load.
 */
async function readRelated(
  table: TResolvedTable,
  query: { filter: FilterExpr; controls: Record<string, unknown> | undefined },
  opts: {
    partitionBy?: string[];
    page?: TGroupPage;
    pick?: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  },
): Promise<Array<Record<string, unknown>>> {
  const { partitionBy, page, pick } = opts;
  const partitioned = partitionBy && page;
  if (table._findManyForRelation) {
    const controls = partitioned ? { ...query.controls, ...pageControls(page) } : query.controls;
    return table._findManyForRelation(
      { filter: query.filter, controls },
      { partitionBy: partitioned ? partitionBy : undefined, pick },
    );
  }
  // A resolver without the relation-read surface: page and pick in memory.
  let rows = await table.findMany(query);
  if (partitioned) {
    rows = slicePerGroup(rows, (row) => compositeKey(partitionBy, row), page);
  }
  return pick ? pick(rows) : rows;
}

/** A `$skip` / `$limit` value as a number (`undefined` when unset or not a number). */
function asCount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** `$skip` / `$limit` controls of a page (only the ones set). */
function pageControls(page: TGroupPage): Record<string, number> {
  const controls: Record<string, number> = {};
  if (page.skip !== undefined) controls.$skip = page.skip;
  if (page.limit !== undefined) controls.$limit = page.limit;
  return controls;
}

/** Whether `controls` carry a non-empty `$sort`. */
function hasSort(controls: Record<string, unknown>): boolean {
  const sort = controls.$sort;
  return !!sort && typeof sort === "object" && Object.keys(sort).length > 0;
}

/**
 * A filter matching the rows whose `toFields` equal `fromFields` of any of
 * `rows` — `$in` for a single field, `$or` of conditions for a composite key.
 * `undefined` when no row has every `fromFields` value.
 */
function matchAnyFilter(
  rows: Array<Record<string, unknown>>,
  fromFields: string[],
  toFields: string[],
): FilterExpr | undefined {
  if (fromFields.length === 1) {
    const values = new Set<unknown>();
    for (const row of rows) {
      const v = row[fromFields[0]];
      if (v !== null && v !== undefined) {
        values.add(v);
      }
    }
    return values.size > 0 ? ({ [toFields[0]]: { $in: [...values] } } as FilterExpr) : undefined;
  }
  const seen = new Set<string>();
  const conditions: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const key = compositeKey(fromFields, row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const condition: Record<string, unknown> = {};
    let valid = true;
    for (let i = 0; i < fromFields.length; i++) {
      const v = row[fromFields[i]];
      if (v === null || v === undefined) {
        valid = false;
        break;
      }
      condition[toFields[i]] = v;
    }
    if (valid) {
      conditions.push(condition);
    }
  }
  if (conditions.length === 0) {
    return undefined;
  }
  return (conditions.length === 1 ? conditions[0] : { $or: conditions }) as FilterExpr;
}

/** The first of `items` per `fields` key. */
function indexFirst(
  items: Array<Record<string, unknown>>,
  fields: string[],
): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const key = compositeKey(fields, item);
    if (!index.has(key)) {
      index.set(key, item);
    }
  }
  return index;
}

/** `items` grouped by `keyOf`, each group in the order of `items`. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    appendTo(groups, keyOf(item), item);
  }
  return groups;
}

function appendTo<T>(groups: Map<string, T[]>, key: string, item: T): void {
  const group = groups.get(key);
  if (group) {
    group.push(item);
  } else {
    groups.set(key, [item]);
  }
}

/**
 * Ensure the given join fields survive the user's $select on a $with relation
 * read. Without this, the JS-side join would key off undefined and silently
 * return empty relations.
 *
 * - Array $select: append missing FK fields.
 * - Include-mode object $select (any value is 1/true, or empty object): set
 *   missing FK fields to 1.
 * - Exclude-mode object $select: leave alone — FK survives by default. If the
 *   FK is explicitly excluded, throw rather than silently override user intent.
 */
export function ensureSelectIncludesFields(
  controls: Record<string, unknown> | undefined,
  fields: string[],
): Record<string, unknown> | undefined {
  if (!controls) {
    return controls;
  }
  const sel = controls.$select;
  if (sel === undefined || sel === null) {
    return controls;
  }
  if (Array.isArray(sel)) {
    const augmented = [...sel];
    for (const f of fields) {
      if (!augmented.includes(f)) {
        augmented.push(f);
      }
    }
    return { ...controls, $select: augmented };
  }
  if (typeof sel === "object") {
    const selObj = sel as Record<string, unknown>;
    const isInclude =
      Object.keys(selObj).length === 0 || Object.values(selObj).some((v) => v === 1 || v === true);
    const augmented = { ...selObj };
    let mutated = false;
    for (const f of fields) {
      const v = augmented[f];
      if (v === 0 || v === false) {
        throw new Error(`Cannot exclude join column "${f}" from $select on $with relation`);
      }
      if (v === undefined && isInclude) {
        augmented[f] = 1;
        mutated = true;
      }
    }
    return mutated ? { ...controls, $select: augmented } : controls;
  }
  return controls;
}
