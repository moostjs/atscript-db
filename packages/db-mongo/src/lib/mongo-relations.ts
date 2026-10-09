import type { Collection, Document } from "mongodb";
import {
  andFilters,
  relationStaticFilter,
  tableNameOf,
  type BaseDbAdapter,
  type DbQuery,
  type FilterExpr,
  type TableMetadata,
  type TDbRelation,
  type TDbForeignKey,
  type TReadControls,
  type TTableResolver,
  type Uniquery,
  type UniqueryControls,
  type WithRelation,
} from "@atscript/db";
import { correlate } from "./lookup-join";
import { buildMongoFilter, collationOfAdapter, mongoFilterStages } from "./mongo-filter";
import { dedupeProjection } from "./projection-dedupe";
import { sortStages } from "./mongo-sort";

// ── Host interface ───────────────────────────────────────────────────────────

/**
 * The readable surface native `$with` loading needs from each table taking
 * part (`AtscriptDbReadable`): its metadata for physical join fields, the
 * query translation (renames, value formatters, relational predicates) and
 * the physical → logical row conversion.
 */
export interface TMongoRelationReadable {
  readonly tableName: string;
  readonly primaryKeys: readonly string[];
  readonly foreignKeys: ReadonlyMap<string, TDbForeignKey>;
  getMetadata(): TableMetadata;
  getAdapter(): BaseDbAdapter;
  _translateForAdapter(query: Uniquery): DbQuery;
  _rowsFromAdapter(
    rows: Array<Record<string, unknown>>,
    controls?: TReadControls,
  ): Promise<Array<Record<string, unknown>>>;
  loadRelations(rows: Array<Record<string, unknown>>, withRelations: WithRelation[]): Promise<void>;
}

export interface TMongoRelationHost {
  readonly _table: TMongoRelationReadable;
  readonly collection: Collection<any>;
  _getSessionOpts(): Record<string, unknown>;
}

/** One `$with` relation's lookup and how its rows come back. */
interface TRelationLookup {
  name: string;
  isArray: boolean;
  /** The related table's readable — converts the loaded documents and loads nested `$with`. */
  target: TMongoRelationReadable;
  /** The logical read controls the related rows were read with (`$select`). */
  readControls: TReadControls;
  nestedWith?: WithRelation[];
  stages: Document[];
}

// ── PK key helper ────────────────────────────────────────────────────────────

/** Join key of a row's primary key values (`fields` = the row's own names for them). */
function buildPKKey(fields: readonly string[], doc: Record<string, unknown>): string {
  let key = "";
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) {
      key += "\0";
    }
    const val = doc[fields[i]];
    // `${ObjectId}` is its hex string — the logical form of a `mongo.objectId` key.
    key += val == null ? "" : `${val as string | number}`;
  }
  return key;
}

function resolveReadable(
  tableResolver: TTableResolver | undefined,
  type: ReturnType<TDbRelation["targetType"]> | undefined,
): TMongoRelationReadable | undefined {
  if (!type || !tableResolver) {
    return undefined;
  }
  return tableResolver(type) as unknown as TMongoRelationReadable | undefined;
}

/** The collection a readable reads (a view's name for a `@db.view`). */
function collectionOf(readable: TMongoRelationReadable): string {
  return readable.getAdapter().resolveTableName(false);
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Native `$with` loading: one aggregation over the source collection
 * (re-selected by primary key) with a `$lookup` per relation.
 *
 * Every name is physical (since 0.1.147): join fields go through each
 * side's `physicalPath`, and the `$with` sub-query (filter — relational
 * predicates included —, `$sort`, `$select`) through the related table's
 * own translation. The relation's `@db.rel.filter` is part of the lookup
 * (target conditions ANDed into the sub-filter, junction conditions on the
 * junction rows). Loaded documents come back as logical rows (renames,
 * value formatters, decryption) before nested `$with` loads on them.
 */
// oxlint-disable-next-line max-params -- matches BaseDbAdapter.loadRelations() signature
export async function loadRelationsImpl(
  host: TMongoRelationHost,
  rows: Array<Record<string, unknown>>,
  withRelations: WithRelation[],
  relations: ReadonlyMap<string, TDbRelation>,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
  tableResolver?: TTableResolver,
): Promise<void> {
  if (rows.length === 0 || withRelations.length === 0) {
    return;
  }

  const source = host._table;
  const primaryKeys = source.primaryKeys as string[];
  const relMeta: TRelationLookup[] = [];

  for (const withRel of withRelations) {
    if (withRel.name.includes(".")) {
      continue;
    }

    const relation = relations.get(withRel.name);
    if (!relation) {
      throw new Error(
        `Unknown relation "${withRel.name}" in $with. Available relations: ${[...relations.keys()].join(", ") || "(none)"}`,
      );
    }

    const lookup = buildRelationLookup(source, withRel, relation, foreignKeys, tableResolver);
    if (lookup) {
      relMeta.push(lookup);
    }
  }

  if (relMeta.length === 0) {
    return;
  }

  // If PKs are available in the rows, run $lookup aggregation pipeline
  const pkMatchFilter = buildPKMatchFilter(rows, primaryKeys);
  if (pkMatchFilter) {
    // The rows are logical: their keys reach the collection translated
    // (renamed key fields, ObjectId values).
    const { filter } = source._translateForAdapter({ filter: pkMatchFilter as FilterExpr });
    const sourceMeta = source.getMetadata();
    const physicalKeys = primaryKeys.map((pk) => sourceMeta.physicalPath(pk));
    const project: Document = {};
    for (const key of physicalKeys) project[key] = 1;
    for (const meta of relMeta) project[meta.name] = 1;
    const pipeline: Document[] = [{ $match: buildMongoFilter(filter) }];
    for (const meta of relMeta) {
      pipeline.push(...meta.stages);
    }
    pipeline.push({ $project: project });

    const results = await host.collection.aggregate(pipeline, host._getSessionOpts()).toArray();

    await Promise.all(relMeta.map((meta) => toLogicalRows(results, meta)));
    mergeRelationResults(rows, results, primaryKeys, physicalKeys, relMeta);
  } else {
    // PKs not in rows (e.g. $select excluded them) — set defaults
    for (const row of rows) {
      for (const meta of relMeta) {
        row[meta.name] = meta.isArray ? [] : null;
      }
    }
  }

  // Handle nested $with by delegating to target table
  await loadNestedRelations(rows, relMeta);
}

// ── Pipeline builders ────────────────────────────────────────────────────────

/** Builds a $match filter to re-select source rows by PK (logical names and values). */
function buildPKMatchFilter(
  rows: Array<Record<string, unknown>>,
  primaryKeys: string[],
): Document | undefined {
  if (primaryKeys.length === 1) {
    const pk = primaryKeys[0];
    const values = new Set<unknown>();
    for (const row of rows) {
      const v = row[pk];
      if (v !== null && v !== undefined) {
        values.add(v);
      }
    }
    if (values.size === 0) {
      return undefined;
    }
    return { [pk]: { $in: [...values] } };
  }
  // Composite PK — build $or filter
  const seen = new Set<string>();
  const orFilters: Document[] = [];
  for (const row of rows) {
    const key = buildPKKey(primaryKeys, row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const condition: Document = {};
    let valid = true;
    for (const pk of primaryKeys) {
      const val = row[pk];
      if (val === null || val === undefined) {
        valid = false;
        break;
      }
      condition[pk] = val;
    }
    if (valid) {
      orFilters.push(condition);
    }
  }
  if (orFilters.length === 0) {
    return undefined;
  }
  return orFilters.length === 1 ? orFilters[0] : { $or: orFilters };
}

/** Dispatches to the correct $lookup builder based on relation direction. */
function buildRelationLookup(
  source: TMongoRelationReadable,
  withRel: WithRelation,
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
  tableResolver?: TTableResolver,
): TRelationLookup | undefined {
  const target = resolveReadable(tableResolver, relation.targetType());
  if (!target) {
    return undefined;
  }
  let built: { stages: Document[]; isArray: boolean; readControls: TReadControls } | undefined;
  switch (relation.direction) {
    case "to": {
      built = buildToLookup(source, target, withRel, relation, foreignKeys);
      break;
    }
    case "from": {
      built = buildFromLookup(source, target, withRel, relation);
      break;
    }
    case "via": {
      built = buildViaLookup(source, target, withRel, relation, tableResolver);
      break;
    }
    default: {
      return undefined;
    }
  }
  return (
    built && {
      name: withRel.name,
      isArray: built.isArray,
      target,
      readControls: built.readControls,
      nestedWith: extractNestedWith(withRel),
      stages: built.stages,
    }
  );
}

/** Pairs of physical join fields: `outer` on the looking-up side, `inner` on the looked-up one. */
function joinPairs(
  outerMeta: TableMetadata,
  outerFields: readonly string[],
  innerMeta: TableMetadata,
  innerFields: readonly string[],
): Array<{ outer: string; inner: string }> {
  return outerFields.map((field, i) => ({
    outer: outerMeta.physicalPath(field),
    inner: innerMeta.physicalPath(innerFields[i]!),
  }));
}

/** $lookup for TO relations (FK is on this table → target). Always single-valued. */
function buildToLookup(
  source: TMongoRelationReadable,
  target: TMongoRelationReadable,
  withRel: WithRelation,
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
): { stages: Document[]; isArray: boolean; readControls: TReadControls } | undefined {
  const fk = findFKForRelation(relation, foreignKeys);
  return fk
    ? directLookup(source, target, withRel, relation, fk.localFields, fk.targetFields, "fk_", false)
    : undefined;
}

/** $lookup for FROM relations (FK is on target → this table). */
function buildFromLookup(
  source: TMongoRelationReadable,
  target: TMongoRelationReadable,
  withRel: WithRelation,
  relation: TDbRelation,
): { stages: Document[]; isArray: boolean; readControls: TReadControls } | undefined {
  const remoteFK = findRemoteFK(target, source.tableName, relation.alias);
  return remoteFK
    ? directLookup(
        source,
        target,
        withRel,
        relation,
        remoteFK.targetFields,
        remoteFK.fields,
        "pk_",
        relation.isArray,
      )
    : undefined;
}

/**
 * The correlated `$lookup` of a TO / FROM relation: `sourceFields` of this
 * table paired with `targetFields` of the target, unwound when single-valued.
 */
function directLookup(
  source: TMongoRelationReadable,
  target: TMongoRelationReadable,
  withRel: WithRelation,
  relation: TDbRelation,
  sourceFields: readonly string[],
  targetFields: readonly string[],
  prefix: string,
  isArray: boolean,
): { stages: Document[]; isArray: boolean; readControls: TReadControls } {
  const pairs = joinPairs(source.getMetadata(), sourceFields, target.getMetadata(), targetFields);
  const inner = buildLookupInnerPipeline(
    target,
    withRel,
    relation,
    pairs.map((p) => p.inner),
  );
  const join = correlate(prefix, pairs);
  const stages: Document[] = [
    {
      $lookup: {
        from: collectionOf(target),
        let: join.let,
        pipeline: [...join.stages, ...inner.filter, ...inner.page],
        as: withRel.name,
      },
    },
  ];
  if (!isArray) {
    stages.push({ $unwind: { path: `$${withRel.name}`, preserveNullAndEmptyArrays: true } });
  }
  return { stages, isArray, readControls: inner.readControls };
}

/** $lookup for VIA relations (M:N through junction table). Always array. */
function buildViaLookup(
  source: TMongoRelationReadable,
  target: TMongoRelationReadable,
  withRel: WithRelation,
  relation: TDbRelation,
  tableResolver?: TTableResolver,
): { stages: Document[]; isArray: boolean; readControls: TReadControls } | undefined {
  const junction = resolveReadable(tableResolver, relation.viaType?.());
  if (!junction) {
    return undefined;
  }

  const fkToThis = findRemoteFK(junction, source.tableName);
  if (!fkToThis) {
    return undefined;
  }

  const fkToTarget = findRemoteFK(junction, tableNameOf(relation.targetType()));
  if (!fkToTarget) {
    return undefined;
  }

  const sourceMeta = source.getMetadata();
  const junctionMeta = junction.getMetadata();
  const targetMeta = target.getMetadata();
  const toSource = correlate(
    "pk_",
    joinPairs(sourceMeta, fkToThis.targetFields, junctionMeta, fkToThis.fields),
  );
  const toTargetPairs = joinPairs(
    junctionMeta,
    fkToTarget.fields,
    targetMeta,
    fkToTarget.targetFields,
  );
  const toTarget = correlate("fk_", toTargetPairs);
  const inner = buildLookupInnerPipeline(
    target,
    withRel,
    relation,
    toTargetPairs.map((p) => p.inner),
  );

  // The junction part of `@db.rel.filter`, in the junction's physical names.
  const junctionFilter = relationStaticFilter(relation, withRel.name).junction;
  const junctionStages = junctionFilter
    ? filterStages(junction, junction._translateForAdapter({ filter: junctionFilter }).filter)
    : [];

  const stages: Document[] = [
    {
      $lookup: {
        from: collectionOf(junction),
        let: toSource.let,
        pipeline: [
          ...toSource.stages,
          ...junctionStages,
          {
            $lookup: {
              from: collectionOf(target),
              let: toTarget.let,
              pipeline: [...toTarget.stages, ...inner.filter],
              as: "__target",
            },
          },
          { $unwind: { path: "$__target", preserveNullAndEmptyArrays: false } },
          { $replaceRoot: { newRoot: "$__target" } },
          // Sort / page / project the related rows of ONE source row.
          ...inner.page,
        ],
        as: withRel.name,
      },
    },
  ];

  return { stages, isArray: true, readControls: inner.readControls };
}

/** Stages applying a translated filter on `readable`'s collection (none when empty). */
function filterStages(
  readable: TMongoRelationReadable,
  filter: FilterExpr | undefined,
): Document[] {
  if (!filter || Object.keys(filter).length === 0) return [];
  // With relational predicates the filter renders 'nocase' fields per field
  // (the pipeline has no collation); a predicate-free one is unchanged.
  return mongoFilterStages(filter, { collation: collationOfAdapter(readable.getAdapter()) });
}

/**
 * The `$with` sub-query on the related table: its filter AND the target part
 * of the relation's `@db.rel.filter`, plus `$sort` / `$skip` / `$limit` /
 * `$select` — translated by the TARGET readable (physical names, value
 * formatters, relational predicates resolved). `requiredFields` (physical
 * join keys) are always projected.
 */
function buildLookupInnerPipeline(
  target: TMongoRelationReadable,
  withRel: WithRelation,
  relation: TDbRelation,
  requiredFields: string[],
): { filter: Document[]; page: Document[]; readControls: TReadControls } {
  // Merge flat and nested controls (same pattern as db-readable.ts)
  const flatRel = withRel as Record<string, unknown>;
  const nested = (withRel.controls || {}) as Record<string, unknown>;
  const sort = (nested.$sort || flatRel.$sort) as Record<string, 1 | -1> | undefined;
  const nulls = (nested.$nulls || flatRel.$nulls) as UniqueryControls["$nulls"] | undefined;
  const limit = (nested.$limit ?? flatRel.$limit) as number | undefined;
  const skip = (nested.$skip ?? flatRel.$skip) as number | undefined;
  const select = (nested.$select || flatRel.$select) as UniqueryControls["$select"] | undefined;

  const statics = relationStaticFilter(relation, withRel.name);
  const controls: Record<string, unknown> = {};
  if (sort) controls.$sort = sort;
  if (nulls) controls.$nulls = nulls;
  if (select) controls.$select = select;
  const translated = target._translateForAdapter({
    filter: andFilters(statics.target, withRel.filter as FilterExpr | undefined),
    controls: controls as UniqueryControls,
  });

  // `$nulls` (resolved by the target: request entries + `@db.sort.nulls`) flags the sort
  const { stages: page, cleanup } = sortStages(translated.controls);
  if (skip) {
    page.push({ $skip: skip });
  }
  if (limit !== null && limit !== undefined) {
    page.push({ $limit: limit });
  }
  if (cleanup) page.push(cleanup);

  // Array, inclusion-map and exclusion-map forms — the same projection the
  // top-level `$select` renders (`UniquSelect.asProjection`), physical.
  const projection = translated.controls?.$select?.asProjection;
  if (projection) {
    const project: Record<string, unknown> = { ...projection };
    if (Object.values(project).some((flag) => flag === 1 || flag === true)) {
      // Inclusion: the join keys are always read; `_id` only when asked for.
      for (const f of requiredFields) project[f] = 1;
      if (!("_id" in projection) && !requiredFields.includes("_id")) project._id = 0;
    } else {
      // Exclusion: a join key is never excluded.
      for (const f of requiredFields) delete project[f];
    }
    if (Object.keys(project).length > 0) {
      page.push({ $project: dedupeProjection(project as Record<string, 0 | 1>) });
    }
  }

  return {
    filter: filterStages(target, translated.filter),
    page,
    readControls: select ? { $select: select } : {},
  };
}

// ── Relation helpers ─────────────────────────────────────────────────────────

/** Extracts nested $with from a WithRelation's controls. */
function extractNestedWith(withRel: WithRelation): WithRelation[] | undefined {
  const flatRel = withRel as Record<string, unknown>;
  const nested = (withRel.controls || {}) as Record<string, unknown>;
  const nestedWith = (nested.$with || flatRel.$with) as WithRelation[] | undefined;
  return nestedWith && nestedWith.length > 0 ? nestedWith : undefined;
}

/** Post-processes nested $with by delegating to the target table's own relation loading. */
async function loadNestedRelations(
  rows: Array<Record<string, unknown>>,
  relMeta: TRelationLookup[],
): Promise<void> {
  const tasks: Array<Promise<void>> = [];

  for (const meta of relMeta) {
    if (!meta.nestedWith || meta.nestedWith.length === 0) {
      continue;
    }

    // Collect all sub-rows from this relation across all parent rows
    const subRows: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const val = row[meta.name];
      if (meta.isArray && Array.isArray(val)) {
        for (const item of val) {
          subRows.push(item);
        }
      } else if (val && typeof val === "object") {
        subRows.push(val as Record<string, unknown>);
      }
    }

    if (subRows.length === 0) {
      continue;
    }

    // Delegate to target table's loadRelations — uses the correct adapter and collection
    tasks.push(meta.target.loadRelations(subRows, meta.nestedWith));
  }

  await Promise.all(tasks);
}

/**
 * Replaces one relation's loaded documents on every aggregation result with
 * the related table's LOGICAL rows (one conversion call for all of them).
 */
async function toLogicalRows(
  results: Array<Record<string, unknown>>,
  meta: TRelationLookup,
): Promise<void> {
  const physical: Array<Record<string, unknown>> = [];
  const spans: Array<[doc: Record<string, unknown>, start: number, length: number]> = [];
  for (const doc of results) {
    const value = doc[meta.name];
    const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
    spans.push([doc, physical.length, list.length]);
    physical.push(...(list as Array<Record<string, unknown>>));
  }
  const logical =
    physical.length > 0 ? await meta.target._rowsFromAdapter(physical, meta.readControls) : [];
  for (const [doc, start, length] of spans) {
    doc[meta.name] = meta.isArray
      ? logical.slice(start, start + length)
      : length > 0
        ? logical[start]
        : null;
  }
}

/**
 * Merges aggregation results back onto the original rows by PK — the
 * results carry the PHYSICAL key fields (`physicalKeys`), the rows the
 * logical ones (`primaryKeys`).
 */
function mergeRelationResults(
  rows: Array<Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
  primaryKeys: string[],
  physicalKeys: string[],
  relMeta: TRelationLookup[],
): void {
  const resultIndex = new Map<string, Record<string, unknown>>();
  for (const doc of results) {
    resultIndex.set(buildPKKey(physicalKeys, doc), doc);
  }

  for (const row of rows) {
    const enriched = resultIndex.get(buildPKKey(primaryKeys, row));

    for (const meta of relMeta) {
      const value = enriched?.[meta.name];
      row[meta.name] = value ?? (meta.isArray ? [] : null);
    }
  }
}

// ── FK resolution (pure) ─────────────────────────────────────────────────────

/** Finds FK entry for a TO relation from this table's foreignKeys map. */
function findFKForRelation(
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
): { localFields: string[]; targetFields: string[]; targetTable: string } | undefined {
  const targetTableName = tableNameOf(relation.targetType());
  for (const fk of foreignKeys.values()) {
    if (relation.alias) {
      if (fk.alias === relation.alias) {
        return {
          localFields: fk.fields,
          targetFields: fk.targetFields,
          targetTable: fk.targetTable,
        };
      }
    } else if (fk.targetTable === targetTableName) {
      return { localFields: fk.fields, targetFields: fk.targetFields, targetTable: fk.targetTable };
    }
  }
  return undefined;
}

/** Finds a FK on a remote table that points back to the given table name. */
function findRemoteFK(
  target: { foreignKeys: ReadonlyMap<string, TDbForeignKey> },
  thisTableName: string,
  alias?: string,
): TDbForeignKey | undefined {
  for (const fk of target.foreignKeys.values()) {
    if (alias && fk.alias === alias && fk.targetTable === thisTableName) {
      return fk;
    }
    if (!alias && fk.targetTable === thisTableName) {
      return fk;
    }
  }
  return undefined;
}
