import type { Collection, Document } from "mongodb";
import type { TDbRelation, TDbForeignKey, TTableResolver, WithRelation } from "@atscript/db";
import { buildMongoFilter } from "./mongo-filter";

// ── Host interface ───────────────────────────────────────────────────────────

export interface TMongoRelationHost {
  readonly _table: {
    readonly tableName: string;
    readonly primaryKeys: readonly string[];
  };
  readonly collection: Collection<any>;
  _getSessionOpts(): Record<string, unknown>;
}

// ── PK key helper ────────────────────────────────────────────────────────────

function buildPKKey(primaryKeys: readonly string[], doc: Record<string, unknown>): string {
  if (primaryKeys.length === 1) {
    const val = doc[primaryKeys[0]];
    return val == null ? "" : `${val as string | number}`;
  }
  let key = "";
  for (let i = 0; i < primaryKeys.length; i++) {
    if (i > 0) {
      key += "\0";
    }
    const val = doc[primaryKeys[i]];
    key += val == null ? "" : `${val as string | number}`;
  }
  return key;
}

// ── Entry point ──────────────────────────────────────────────────────────────

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

  const primaryKeys = host._table.primaryKeys as string[];

  const relMeta: Array<{
    name: string;
    isArray: boolean;
    relation: TDbRelation;
    nestedWith?: WithRelation[];
    stages: Document[];
  }> = [];

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

    const lookupResult = buildRelationLookup(host, withRel, relation, foreignKeys, tableResolver);
    if (!lookupResult) {
      continue;
    }

    relMeta.push({
      name: withRel.name,
      isArray: lookupResult.isArray,
      relation,
      nestedWith: extractNestedWith(withRel),
      stages: lookupResult.stages,
    });
  }

  if (relMeta.length === 0) {
    return;
  }

  // If PKs are available in the rows, run $lookup aggregation pipeline
  const pkMatchFilter = buildPKMatchFilter(rows, primaryKeys);
  if (pkMatchFilter) {
    const pipeline: Document[] = [{ $match: pkMatchFilter }];
    for (const meta of relMeta) {
      pipeline.push(...meta.stages);
    }

    const results = await host.collection.aggregate(pipeline, host._getSessionOpts()).toArray();

    mergeRelationResults(rows, results, primaryKeys, relMeta);
  } else {
    // PKs not in rows (e.g. $select excluded them) — set defaults
    for (const row of rows) {
      for (const meta of relMeta) {
        row[meta.name] = meta.isArray ? [] : null;
      }
    }
  }

  // Handle nested $with by delegating to target table
  await loadNestedRelations(rows, relMeta, tableResolver);
}

// ── Pipeline builders ────────────────────────────────────────────────────────

/** Builds a $match filter to re-select source rows by PK. */
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
  host: TMongoRelationHost,
  withRel: WithRelation,
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
  tableResolver?: TTableResolver,
): { stages: Document[]; isArray: boolean } | undefined {
  switch (relation.direction) {
    case "to": {
      return buildToLookup(withRel, relation, foreignKeys);
    }
    case "from": {
      return buildFromLookup(host, withRel, relation, tableResolver);
    }
    case "via": {
      return buildViaLookup(host, withRel, relation, tableResolver);
    }
    default: {
      return undefined;
    }
  }
}

/** Builds `let` variable bindings and the corresponding `$expr` match for `$lookup`. */
function buildLookupJoin(
  localFields: string[],
  remoteFields: string[],
  varPrefix: string,
): { letVars: Record<string, string>; exprMatch: Document } {
  const letVars: Record<string, string> = {};
  for (let i = 0; i < localFields.length; i++) {
    letVars[`${varPrefix}${i}`] = `$${localFields[i]}`;
  }
  if (remoteFields.length === 1) {
    return { letVars, exprMatch: { $eq: [`$${remoteFields[0]}`, `$$${varPrefix}0`] } };
  }
  const andClauses: Document[] = [];
  for (let i = 0; i < remoteFields.length; i++) {
    andClauses.push({ $eq: [`$${remoteFields[i]}`, `$$${varPrefix}${i}`] });
  }
  return { letVars, exprMatch: { $and: andClauses } };
}

/** $lookup for TO relations (FK is on this table → target). Always single-valued. */
function buildToLookup(
  withRel: WithRelation,
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
): { stages: Document[]; isArray: boolean } | undefined {
  const fk = findFKForRelation(relation, foreignKeys);
  if (!fk) {
    return undefined;
  }

  const innerPipeline = buildLookupInnerPipeline(withRel, fk.targetFields);
  const { letVars, exprMatch } = buildLookupJoin(fk.localFields, fk.targetFields, "fk_");

  const stages: Document[] = [
    {
      $lookup: {
        from: fk.targetTable,
        let: letVars,
        pipeline: [{ $match: { $expr: exprMatch } }, ...innerPipeline],
        as: withRel.name,
      },
    },
    {
      $unwind: { path: `$${withRel.name}`, preserveNullAndEmptyArrays: true },
    },
  ];

  return { stages, isArray: false };
}

/** $lookup for FROM relations (FK is on target → this table). */
function buildFromLookup(
  host: TMongoRelationHost,
  withRel: WithRelation,
  relation: TDbRelation,
  tableResolver?: TTableResolver,
): { stages: Document[]; isArray: boolean } | undefined {
  const targetType = relation.targetType();
  if (!targetType || !tableResolver) {
    return undefined;
  }

  const targetMeta = tableResolver(targetType);
  if (!targetMeta) {
    return undefined;
  }

  const remoteFK = findRemoteFK(targetMeta, host._table.tableName, relation.alias);
  if (!remoteFK) {
    return undefined;
  }

  const targetTableName = resolveRelTargetTableName(relation);
  const innerPipeline = buildLookupInnerPipeline(withRel, remoteFK.fields);
  const { letVars, exprMatch } = buildLookupJoin(remoteFK.targetFields, remoteFK.fields, "pk_");

  const stages: Document[] = [
    {
      $lookup: {
        from: targetTableName,
        let: letVars,
        pipeline: [{ $match: { $expr: exprMatch } }, ...innerPipeline],
        as: withRel.name,
      },
    },
  ];

  if (!relation.isArray) {
    stages.push({ $unwind: { path: `$${withRel.name}`, preserveNullAndEmptyArrays: true } });
  }

  return { stages, isArray: relation.isArray };
}

/** $lookup for VIA relations (M:N through junction table). Always array. */
function buildViaLookup(
  host: TMongoRelationHost,
  withRel: WithRelation,
  relation: TDbRelation,
  tableResolver?: TTableResolver,
): { stages: Document[]; isArray: boolean } | undefined {
  if (!relation.viaType || !tableResolver) {
    return undefined;
  }

  const junctionType = relation.viaType();
  if (!junctionType) {
    return undefined;
  }

  const junctionMeta = tableResolver(junctionType);
  if (!junctionMeta) {
    return undefined;
  }

  const junctionTableName =
    (junctionType.metadata?.get("db.table") as string) || junctionType.id || "";
  const targetTableName = resolveRelTargetTableName(relation);

  const fkToThis = findRemoteFK(junctionMeta, host._table.tableName);
  if (!fkToThis) {
    return undefined;
  }

  const fkToTarget = findRemoteFK(junctionMeta, targetTableName);
  if (!fkToTarget) {
    return undefined;
  }

  const innerPipeline = buildLookupInnerPipeline(withRel, fkToTarget.targetFields);
  const { letVars, exprMatch } = buildLookupJoin(fkToThis.targetFields, fkToThis.fields, "pk_");

  const stages: Document[] = [
    {
      $lookup: {
        from: junctionTableName,
        let: letVars,
        pipeline: [
          { $match: { $expr: exprMatch } },
          {
            $lookup: {
              from: targetTableName,
              localField: fkToTarget.fields[0],
              foreignField: fkToTarget.targetFields[0],
              pipeline: innerPipeline,
              as: "__target",
            },
          },
          { $unwind: { path: "$__target", preserveNullAndEmptyArrays: false } },
          { $replaceRoot: { newRoot: "$__target" } },
        ],
        as: withRel.name,
      },
    },
  ];

  return { stages, isArray: true };
}

/** Builds inner pipeline stages for relation controls ($sort, $limit, $skip, $select, filter). */
function buildLookupInnerPipeline(withRel: WithRelation, requiredFields: string[]): Document[] {
  const pipeline: Document[] = [];

  // Merge flat and nested controls (same pattern as db-readable.ts)
  const flatRel = withRel as Record<string, unknown>;
  const nested = (withRel.controls || {}) as Record<string, unknown>;
  const filter = withRel.filter;
  const sort = (nested.$sort || flatRel.$sort) as Record<string, 1 | -1> | undefined;
  const limit = (nested.$limit ?? flatRel.$limit) as number | undefined;
  const skip = (nested.$skip ?? flatRel.$skip) as number | undefined;
  const select = (nested.$select || flatRel.$select) as string[] | undefined;

  // Additional filter on the relation
  if (filter && Object.keys(filter).length > 0) {
    pipeline.push({ $match: buildMongoFilter(filter) });
  }

  if (sort) {
    pipeline.push({ $sort: sort });
  }
  if (skip) {
    pipeline.push({ $skip: skip });
  }
  if (limit !== null && limit !== undefined) {
    pipeline.push({ $limit: limit });
  }

  if (select) {
    const projection: Record<string, 1 | 0> = {};
    for (const f of select) {
      projection[f] = 1;
    }
    // Ensure required FK/PK fields are in projection
    for (const f of requiredFields) {
      projection[f] = 1;
    }
    // Suppress _id if not explicitly selected
    if (!select.includes("_id") && !requiredFields.includes("_id")) {
      projection["_id"] = 0;
    }
    pipeline.push({ $project: projection });
  }

  return pipeline;
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
  relMeta: Array<{
    name: string;
    isArray: boolean;
    relation: TDbRelation;
    nestedWith?: WithRelation[];
  }>,
  tableResolver?: TTableResolver,
): Promise<void> {
  if (!tableResolver) {
    return;
  }

  const tasks: Array<Promise<void>> = [];

  for (const meta of relMeta) {
    if (!meta.nestedWith || meta.nestedWith.length === 0) {
      continue;
    }

    const targetType = meta.relation.targetType();
    if (!targetType) {
      continue;
    }

    const targetTable = tableResolver(targetType);
    if (!targetTable) {
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
    tasks.push(targetTable.loadRelations(subRows, meta.nestedWith));
  }

  await Promise.all(tasks);
}

/** Merges aggregation results back onto the original rows by PK. */
function mergeRelationResults(
  rows: Array<Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
  primaryKeys: string[],
  relMeta: Array<{ name: string; isArray: boolean }>,
): void {
  const resultIndex = new Map<string, Record<string, unknown>>();
  for (const doc of results) {
    resultIndex.set(buildPKKey(primaryKeys, doc), doc);
  }

  for (const row of rows) {
    const enriched = resultIndex.get(buildPKKey(primaryKeys, row));

    for (const meta of relMeta) {
      if (enriched) {
        const value = enriched[meta.name];
        if (!meta.isArray && Array.isArray(value)) {
          row[meta.name] = value[0] ?? null;
        } else {
          row[meta.name] = value ?? (meta.isArray ? [] : null);
        }
      } else {
        row[meta.name] = meta.isArray ? [] : null;
      }
    }
  }
}

// ── FK resolution (pure) ─────────────────────────────────────────────────────

/** Finds FK entry for a TO relation from this table's foreignKeys map. */
function findFKForRelation(
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
): { localFields: string[]; targetFields: string[]; targetTable: string } | undefined {
  const targetTableName = resolveRelTargetTableName(relation);
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

/** Resolves the target table/collection name from a relation's target type. */
function resolveRelTargetTableName(relation: TDbRelation): string {
  const targetType = relation.targetType();
  return (targetType?.metadata?.get("db.table") as string) || targetType?.id || "";
}
