import { type Validator, ValidatorError } from "@atscript/typescript/utils";
import type { FilterExpr } from "@uniqu/core";

import { DbError } from "../db-error";
import type { DbValidationContext } from "../db-validator-plugin";
import type {
  AtscriptDbTableLike,
  AtscriptDbWritable,
  TDbForeignKey,
  TDbRelation,
  TWriteTableResolver,
} from "../types";
import type { TableMetadata } from "../table/table-metadata";
import { resolveRelationTargetTable } from "./relation-helpers";
import { wrapNestedError } from "../table/error-utils";

// ── Host interface ──────────────────────────────────────────────────────────

/**
 * Properties the nested writer functions need from the table instance.
 * AtscriptDbTable satisfies this structurally — pass `this` with a cast.
 */
export interface TNestedWriterHost {
  readonly tableName: string;
  readonly _meta: TableMetadata;
  readonly _writeTableResolver?: TWriteTableResolver;
  _findFKForRelation(
    relation: TDbRelation,
  ): { localFields: string[]; targetFields: string[] } | undefined;
  _findRemoteFK(
    targetTable: { foreignKeys: ReadonlyMap<string, TDbForeignKey> },
    thisTableName: string,
    alias?: string,
  ): TDbForeignKey | undefined;
  _extractRecordFilter(payload: Record<string, unknown>): FilterExpr;
  findOne(query: {
    filter: FilterExpr;
    controls: Record<string, never>;
  }): Promise<Record<string, unknown> | null>;
}

// ── Exported: validation helpers ────────────────────────────────────────────

/**
 * Checks if any payload contains navigational data that would be silently
 * dropped because maxDepth is 0.
 */
export function checkDepthOverflow(
  payloads: Array<Record<string, unknown>>,
  maxDepth: number,
  meta: TableMetadata,
): void {
  if (meta.navFields.size === 0) {
    return;
  }
  for (const payload of payloads) {
    for (const navField of meta.navFields) {
      if (payload[navField] !== undefined) {
        throw new Error(
          `Nested data in '${navField}' exceeds maxDepth (${maxDepth}). ` +
            `Increase maxDepth or strip nested data before writing.`,
        );
      }
    }
  }
}

/**
 * Validates a batch of items using the given validator and context.
 * Wraps per-item validation errors with array index paths for batch operations.
 */
export function validateBatch(
  validator: Validator<any, any>,
  items: Array<Record<string, unknown>>,
  ctx: DbValidationContext,
): void {
  for (let i = 0; i < items.length; i++) {
    try {
      validator.validate(items[i], false, ctx);
    } catch (error) {
      if (error instanceof ValidatorError && items.length > 1) {
        throw new ValidatorError(
          error.errors.map((err) => ({
            ...err,
            path: `[${i}].${err.path}`,
          })),
        );
      }
      throw error;
    }
  }
}

// ── Exported: batch nested insert ───────────────────────────────────────────

/**
 * Pre-validates FROM children (type + FK constraints) before the main insert.
 * Catches errors early before the parent record is committed.
 */
export async function preValidateNestedFrom(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "from") {
      continue;
    }

    if (!host._writeTableResolver) {
      continue;
    }
    const targetTable = host._writeTableResolver(relation.targetType());
    if (!targetTable) {
      continue;
    }

    const remoteFK = host._findRemoteFK(targetTable, host.tableName, relation.alias);

    const allChildren: Array<Record<string, unknown>> = [];
    for (const orig of originals) {
      const children = orig[navField];
      if (!Array.isArray(children)) {
        continue;
      }
      for (const child of children) {
        const childData = { ...(child as Record<string, unknown>) };
        if (remoteFK) {
          for (const field of remoteFK.fields) {
            if (!(field in childData)) {
              childData[field] = 0;
            }
          }
        }
        allChildren.push(childData);
      }
    }
    if (allChildren.length === 0) {
      continue;
    }

    await wrapNestedError(navField, () =>
      targetTable.preValidateItems(allChildren, { excludeFkTargetTable: host.tableName }),
    );
  }
}

/**
 * Batch-creates TO dependencies before the main insert.
 */
export async function batchInsertNestedTo(
  host: TNestedWriterHost,
  items: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "to") {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const fk = host._findFKForRelation(relation);
    if (!fk) {
      continue;
    }

    const parents: Array<Record<string, unknown>> = [];
    const sourceIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const nested = items[i][navField];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        parents.push(nested as Record<string, unknown>);
        sourceIndices.push(i);
      }
    }
    if (parents.length === 0) {
      continue;
    }

    const result = await targetTable.insertMany(parents, { maxDepth, _depth: depth + 1 });

    for (let j = 0; j < sourceIndices.length; j++) {
      if (fk.localFields.length === 1) {
        items[sourceIndices[j]][fk.localFields[0]] = result.insertedIds[j];
      }
    }
  }
}

/**
 * Batch-creates FROM dependents after the main insert.
 */
export async function batchInsertNestedFrom(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  parentIds: unknown[],
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "from") {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const remoteFK = host._findRemoteFK(targetTable, host.tableName, relation.alias);
    if (!remoteFK) {
      continue;
    }

    const allChildren: Array<Record<string, unknown>> = [];
    for (let i = 0; i < originals.length; i++) {
      const children = originals[i][navField];
      if (!Array.isArray(children)) {
        continue;
      }
      for (const child of children) {
        const childData = { ...(child as Record<string, unknown>) };
        if (remoteFK.fields.length === 1) {
          childData[remoteFK.fields[0]] = parentIds[i];
        }
        allChildren.push(childData);
      }
    }
    if (allChildren.length === 0) {
      continue;
    }

    await wrapNestedError(navField, () =>
      targetTable.insertMany(allChildren, { maxDepth, _depth: depth + 1 }),
    );
  }
}

/**
 * Batch-creates VIA (M:N) targets and junction entries after the main insert.
 */
export async function batchInsertNestedVia(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  parentIds: unknown[],
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !relation.viaType) {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const junctionTable = host._writeTableResolver!(relation.viaType());
    if (!junctionTable) {
      continue;
    }

    const targetTableName = resolveRelationTargetTable(relation);

    const fkToThis = host._findRemoteFK(junctionTable, host.tableName);
    if (!fkToThis) {
      continue;
    }
    const fkToTarget = host._findRemoteFK(junctionTable, targetTableName);
    if (!fkToTarget) {
      continue;
    }

    const targetPKField = targetTable.primaryKeys[0];
    if (!targetPKField || fkToTarget.fields.length !== 1 || fkToThis.fields.length !== 1) {
      continue;
    }

    for (let i = 0; i < originals.length; i++) {
      const targets = originals[i][navField];
      if (!Array.isArray(targets) || targets.length === 0) {
        continue;
      }

      const parentPK = parentIds[i];
      if (parentPK === undefined) {
        continue;
      }

      const newTargets: Array<Record<string, unknown>> = [];
      const existingIds: unknown[] = [];
      for (const t of targets) {
        const rec = t as Record<string, unknown>;
        const pk = rec[targetPKField];
        if (pk !== undefined && pk !== null) {
          existingIds.push(pk);
        } else {
          newTargets.push({ ...rec });
        }
      }

      const allTargetIds: unknown[] = [...existingIds];
      if (newTargets.length > 0) {
        const targetResult = await targetTable.insertMany(newTargets, {
          maxDepth,
          _depth: depth + 1,
        });
        allTargetIds.push(...targetResult.insertedIds);
      }

      if (allTargetIds.length > 0) {
        const junctionRows = allTargetIds.map((targetId) => ({
          [fkToThis.fields[0]]: parentPK,
          [fkToTarget.fields[0]]: targetId,
        }));
        await junctionTable.insertMany(junctionRows, { maxDepth: 0 });
      }
    }
  }
}

// ── Exported: batch nested replace ──────────────────────────────────────────

/**
 * Batch-replaces TO dependencies before the main replace.
 */
export async function batchReplaceNestedTo(
  host: TNestedWriterHost,
  items: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "to") {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const fk = host._findFKForRelation(relation);
    if (!fk) {
      continue;
    }

    const parents: Array<Record<string, unknown>> = [];
    const sourceIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const nested = items[i][navField];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        parents.push(nested as Record<string, unknown>);
        sourceIndices.push(i);
      }
    }
    if (parents.length === 0) {
      continue;
    }

    await targetTable.bulkReplace(parents, { maxDepth, _depth: depth + 1 });

    for (let j = 0; j < sourceIndices.length; j++) {
      if (fk.localFields.length === 1 && fk.targetFields.length === 1) {
        items[sourceIndices[j]][fk.localFields[0]] = parents[j][fk.targetFields[0]];
      }
    }
  }
}

/**
 * Batch-replaces FROM dependents after the main replace.
 */
export async function batchReplaceNestedFrom(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "from") {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const remoteFK = host._findRemoteFK(targetTable, host.tableName, relation.alias);
    if (!remoteFK) {
      continue;
    }

    const childPKs = [...targetTable.primaryKeys];
    for (const original of originals) {
      const children = original[navField];
      if (!Array.isArray(children)) {
        continue;
      }
      const parentPK =
        host._meta.primaryKeys.length === 1 ? original[host._meta.primaryKeys[0]] : undefined;
      if (parentPK === undefined || remoteFK.fields.length !== 1) {
        continue;
      }
      await fromReplace(
        targetTable,
        children,
        parentPK,
        remoteFK.fields[0],
        childPKs,
        navField,
        maxDepth,
        depth,
      );
    }
  }
}

/**
 * Handles VIA (M:N) relations during replace.
 */
export async function batchReplaceNestedVia(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !relation.viaType) {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const junctionTable = host._writeTableResolver!(relation.viaType());
    if (!junctionTable) {
      continue;
    }

    const targetTableName = resolveRelationTargetTable(relation);

    const fkToThis = host._findRemoteFK(junctionTable, host.tableName);
    if (!fkToThis) {
      continue;
    }
    const fkToTarget = host._findRemoteFK(junctionTable, targetTableName);
    if (!fkToTarget) {
      continue;
    }

    const targetPKField = targetTable.primaryKeys[0];
    if (!targetPKField || fkToTarget.fields.length !== 1 || fkToThis.fields.length !== 1) {
      continue;
    }

    for (const original of originals) {
      const targets = original[navField];
      if (!Array.isArray(targets)) {
        continue;
      }

      const parentPK =
        host._meta.primaryKeys.length === 1 ? original[host._meta.primaryKeys[0]] : undefined;
      if (parentPK === undefined) {
        continue;
      }

      await viaReplace(
        targetTable,
        junctionTable,
        targets,
        parentPK,
        targetPKField,
        fkToThis.fields[0],
        fkToTarget.fields[0],
        maxDepth,
        depth,
      );
    }
  }
}

// ── Exported: batch nested patch ────────────────────────────────────────────

/**
 * Batch-patches TO dependencies before the main patch.
 * Reads FK values from DB if not present in the payload.
 */
export async function batchPatchNestedTo(
  host: TNestedWriterHost,
  items: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "to") {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const fk = host._findFKForRelation(relation);
    if (!fk) {
      continue;
    }

    const patches: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const nested = item[navField];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
        continue;
      }

      const patch = { ...(nested as Record<string, unknown>) };

      let fkValue = fk.localFields.length === 1 ? item[fk.localFields[0]] : undefined;
      if (fkValue === undefined) {
        const pkFilter = host._extractRecordFilter(item);
        const current = await host.findOne({
          filter: pkFilter,
          controls: {} as Record<string, never>,
        });
        if (!current) {
          throw new DbError("NOT_FOUND", [
            {
              path: navField,
              message: `Cannot patch relation '${navField}' — source record not found`,
            },
          ]);
        }
        fkValue = fk.localFields.length === 1 ? current[fk.localFields[0]] : undefined;
      }

      if (fkValue === null || fkValue === undefined) {
        throw new DbError("FK_VIOLATION", [
          {
            path: fk.localFields[0],
            message: `Cannot patch relation '${navField}' — foreign key '${fk.localFields[0]}' is null`,
          },
        ]);
      }

      if (fk.targetFields.length === 1) {
        patch[fk.targetFields[0]] = fkValue;
      }

      patches.push(patch);
    }
    if (patches.length === 0) {
      continue;
    }

    await targetTable.bulkUpdate(patches, { maxDepth, _depth: depth + 1 });
  }
}

/**
 * Batch-patches FROM (1:N) dependencies after the main patch.
 * Supports patch operators: $replace, $insert, $remove, $update, $upsert.
 */
export async function batchPatchNestedFrom(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "from") {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const remoteFK = host._findRemoteFK(targetTable, host.tableName, relation.alias);
    if (!remoteFK) {
      continue;
    }

    const childPKs = [...targetTable.primaryKeys];

    for (const original of originals) {
      const navValue = original[navField];
      if (navValue === undefined || navValue === null) {
        continue;
      }

      const parentPK =
        host._meta.primaryKeys.length === 1 ? original[host._meta.primaryKeys[0]] : undefined;
      if (parentPK === undefined || remoteFK.fields.length !== 1) {
        continue;
      }
      const fkField = remoteFK.fields[0];

      const ops = extractNavPatchOps(navValue);

      // $replace
      if (ops.replace) {
        await fromReplace(
          targetTable,
          ops.replace,
          parentPK,
          fkField,
          childPKs,
          navField,
          maxDepth,
          depth,
        );
      }

      // $remove
      if (ops.remove && ops.remove.length > 0) {
        const removeFilters = ops.remove.map((child) => {
          const rec = child as Record<string, unknown>;
          const f: Record<string, unknown> = {};
          for (const pk of childPKs) {
            f[pk] = rec[pk];
          }
          f[fkField] = parentPK;
          return f;
        });
        if (removeFilters.length === 1) {
          await targetTable.deleteMany(removeFilters[0]);
        } else {
          await targetTable.deleteMany({ $or: removeFilters });
        }
      }

      // $update
      if (ops.update && ops.update.length > 0) {
        const items = ops.update.map((child) => {
          const rec = { ...(child as Record<string, unknown>) };
          rec[fkField] = parentPK;
          return rec;
        });
        await wrapNestedError(navField, () =>
          targetTable.bulkUpdate(items, { maxDepth, _depth: depth + 1 }),
        );
      }

      // $upsert
      if (ops.upsert) {
        const toUpdate: Array<Record<string, unknown>> = [];
        const toInsert: Array<Record<string, unknown>> = [];
        for (const child of ops.upsert) {
          const rec = { ...(child as Record<string, unknown>) };
          rec[fkField] = parentPK;
          const hasPK = childPKs.length > 0 && childPKs.every((pk) => rec[pk] !== undefined);
          if (hasPK) {
            toUpdate.push(rec);
          } else {
            toInsert.push(rec);
          }
        }
        if (toUpdate.length > 0) {
          await wrapNestedError(navField, () =>
            targetTable.bulkUpdate(toUpdate, { maxDepth, _depth: depth + 1 }),
          );
        }
        if (toInsert.length > 0) {
          await wrapNestedError(navField, () =>
            targetTable.insertMany(toInsert, { maxDepth, _depth: depth + 1 }),
          );
        }
      }

      // $insert
      if (ops.insert && ops.insert.length > 0) {
        const items: Record<string, unknown>[] = [];
        for (let i = 0; i < ops.insert.length; i++) {
          const rec = { ...(ops.insert[i] as Record<string, unknown>) };
          rec[fkField] = parentPK;
          items.push(rec);
        }
        await wrapNestedError(navField, () =>
          targetTable.insertMany(items, { maxDepth, _depth: depth + 1 }),
        );
      }
    }
  }
}

/**
 * Batch-patches VIA (M:N) dependencies after the main patch.
 * Supports patch operators: $replace, $insert, $remove, $update, $upsert.
 */
export async function batchPatchNestedVia(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !relation.viaType) {
      continue;
    }

    const targetTable = host._writeTableResolver!(relation.targetType());
    if (!targetTable) {
      continue;
    }
    const junctionTable = host._writeTableResolver!(relation.viaType());
    if (!junctionTable) {
      continue;
    }

    const targetTableName = resolveRelationTargetTable(relation);

    const fkToThis = host._findRemoteFK(junctionTable, host.tableName);
    if (!fkToThis) {
      continue;
    }
    const fkToTarget = host._findRemoteFK(junctionTable, targetTableName);
    if (!fkToTarget) {
      continue;
    }

    const targetPKField = targetTable.primaryKeys[0];
    if (!targetPKField || fkToTarget.fields.length !== 1 || fkToThis.fields.length !== 1) {
      continue;
    }

    for (const original of originals) {
      const navValue = original[navField];
      if (navValue === undefined || navValue === null) {
        continue;
      }

      const parentPK =
        host._meta.primaryKeys.length === 1 ? original[host._meta.primaryKeys[0]] : undefined;
      if (parentPK === undefined) {
        continue;
      }

      const ops = extractNavPatchOps(navValue);

      // $replace
      if (ops.replace) {
        await viaReplace(
          targetTable,
          junctionTable,
          ops.replace,
          parentPK,
          targetPKField,
          fkToThis.fields[0],
          fkToTarget.fields[0],
          maxDepth,
          depth,
        );
      }

      // $remove
      if (ops.remove && ops.remove.length > 0) {
        const targetPKs = ops.remove
          .map((t) => (t as Record<string, unknown>)[targetPKField])
          .filter((pk) => pk !== undefined && pk !== null);
        if (targetPKs.length === 1) {
          await junctionTable.deleteMany({
            [fkToThis.fields[0]]: parentPK,
            [fkToTarget.fields[0]]: targetPKs[0],
          });
        } else if (targetPKs.length > 1) {
          await junctionTable.deleteMany({
            [fkToThis.fields[0]]: parentPK,
            [fkToTarget.fields[0]]: { $in: targetPKs },
          });
        }
      }

      // $update
      if (ops.update && ops.update.length > 0) {
        await targetTable.bulkUpdate(
          ops.update.map((t) => ({ ...(t as Record<string, unknown>) })),
          { maxDepth, _depth: depth + 1 },
        );
      }

      // $upsert
      if (ops.upsert && ops.upsert.length > 0) {
        const toUpdate: Array<Record<string, unknown>> = [];
        const toInsert: Array<Record<string, unknown>> = [];
        const existingPKs: unknown[] = [];
        for (const target of ops.upsert) {
          const rec = { ...(target as Record<string, unknown>) };
          const pk = rec[targetPKField];
          if (pk !== undefined && pk !== null) {
            toUpdate.push(rec);
            existingPKs.push(pk);
          } else {
            toInsert.push(rec);
          }
        }

        // Batch update existing targets
        if (toUpdate.length > 0) {
          await targetTable.bulkUpdate(toUpdate, { maxDepth, _depth: depth + 1 });
        }

        // Batch check which junctions already exist, insert missing ones
        if (existingPKs.length > 0) {
          const existingJunctions = await junctionTable.findMany({
            filter: {
              [fkToThis.fields[0]]: parentPK,
              [fkToTarget.fields[0]]:
                existingPKs.length === 1 ? existingPKs[0] : { $in: existingPKs },
            },
            controls: { $select: [fkToTarget.fields[0]] },
          });
          const existingSet = new Set(
            existingJunctions.map((j) => String(j[fkToTarget.fields[0]])),
          );
          const missingPKs = existingPKs.filter((pk) => !existingSet.has(String(pk)));
          if (missingPKs.length > 0) {
            const junctionRows = missingPKs.map((pk) => ({
              [fkToThis.fields[0]]: parentPK,
              [fkToTarget.fields[0]]: pk,
            }));
            await junctionTable.insertMany(junctionRows, { maxDepth: 0 });
          }
        }

        // Batch insert new targets + create junctions
        if (toInsert.length > 0) {
          const insertResult = await targetTable.insertMany(toInsert, {
            maxDepth,
            _depth: depth + 1,
          });
          const junctionRows = insertResult.insertedIds.map((newId) => ({
            [fkToThis.fields[0]]: parentPK,
            [fkToTarget.fields[0]]: newId,
          }));
          await junctionTable.insertMany(junctionRows, { maxDepth: 0 });
        }
      }

      // $insert
      if (ops.insert && ops.insert.length > 0) {
        const toInsert: Array<Record<string, unknown>> = [];
        const existingIds: unknown[] = [];
        for (const target of ops.insert) {
          const rec = { ...(target as Record<string, unknown>) };
          const pk = rec[targetPKField];
          if (pk !== undefined && pk !== null) {
            existingIds.push(pk);
          } else {
            toInsert.push(rec);
          }
        }
        const allIds = [...existingIds];
        if (toInsert.length > 0) {
          const insertResult = await targetTable.insertMany(toInsert, {
            maxDepth,
            _depth: depth + 1,
          });
          allIds.push(...insertResult.insertedIds);
        }
        if (allIds.length > 0) {
          const junctionRows = allIds.map((targetId) => ({
            [fkToThis.fields[0]]: parentPK,
            [fkToTarget.fields[0]]: targetId,
          }));
          await junctionTable.insertMany(junctionRows, { maxDepth: 0 });
        }
      }
    }
  }
}

// ── Module-private helpers ──────────────────────────────────────────────────

/**
 * Extracts patch operations from a nav field value.
 * Plain array → $replace. Object with $insert, $remove, etc. → individual ops.
 */
function extractNavPatchOps(navValue: unknown): {
  replace?: unknown[];
  insert?: unknown[];
  remove?: unknown[];
  update?: unknown[];
  upsert?: unknown[];
} {
  if (Array.isArray(navValue)) {
    return { replace: navValue };
  }

  if (typeof navValue !== "object" || navValue === null) {
    return {};
  }

  const obj = navValue as Record<string, unknown>;
  return {
    replace: obj.$replace !== undefined ? (obj.$replace as unknown[]) : undefined,
    insert: obj.$insert !== undefined ? (obj.$insert as unknown[]) : undefined,
    remove: obj.$remove !== undefined ? (obj.$remove as unknown[]) : undefined,
    update: obj.$update !== undefined ? (obj.$update as unknown[]) : undefined,
    upsert: obj.$upsert !== undefined ? (obj.$upsert as unknown[]) : undefined,
  };
}

/**
 * FROM $replace helper: delete orphans, replace existing, insert new.
 */
async function fromReplace(
  targetTable: AtscriptDbTableLike & AtscriptDbWritable,
  children: unknown[],
  parentPK: unknown,
  fkField: string,
  childPKs: string[],
  navField: string,
  maxDepth: number,
  depth: number,
): Promise<void> {
  const toReplace: Array<Record<string, unknown>> = [];
  const toInsert: Array<Record<string, unknown>> = [];
  const newPKSet = new Set<string>();
  for (const child of children) {
    const childData = { ...(child as Record<string, unknown>) };
    childData[fkField] = parentPK;
    const hasPK = childPKs.length > 0 && childPKs.every((pk) => childData[pk] !== undefined);
    if (hasPK) {
      newPKSet.add(childPKs.map((pk) => String(childData[pk])).join("\0"));
      toReplace.push(childData);
    } else {
      toInsert.push(childData);
    }
  }

  const existing = await targetTable.findMany({
    filter: { [fkField]: parentPK },
    controls: childPKs.length > 0 ? { $select: [...childPKs] } : {},
  });

  const orphanFilters: Array<Record<string, unknown>> = [];
  for (const row of existing) {
    const pkKey = childPKs.map((pk) => String(row[pk])).join("\0");
    if (!newPKSet.has(pkKey)) {
      const f: Record<string, unknown> = {};
      for (const pk of childPKs) {
        f[pk] = row[pk];
      }
      orphanFilters.push(f);
    }
  }
  if (orphanFilters.length === 1) {
    await targetTable.deleteMany(orphanFilters[0]);
  } else if (orphanFilters.length > 1) {
    await targetTable.deleteMany({ $or: orphanFilters });
  }

  if (toReplace.length > 0) {
    await wrapNestedError(navField, () =>
      targetTable.bulkReplace(toReplace, { maxDepth, _depth: depth + 1 }),
    );
  }
  if (toInsert.length > 0) {
    await wrapNestedError(navField, () =>
      targetTable.insertMany(toInsert, { maxDepth, _depth: depth + 1 }),
    );
  }
}

/**
 * VIA $replace helper: clear junctions, replace/insert targets, rebuild junctions.
 */
async function viaReplace(
  targetTable: AtscriptDbTableLike & AtscriptDbWritable,
  junctionTable: AtscriptDbTableLike & AtscriptDbWritable,
  targets: unknown[],
  parentPK: unknown,
  targetPKField: string,
  fkToThisField: string,
  fkToTargetField: string,
  maxDepth: number,
  depth: number,
): Promise<void> {
  await junctionTable.deleteMany({ [fkToThisField]: parentPK });

  const toReplace: Array<Record<string, unknown>> = [];
  const toInsert: Array<Record<string, unknown>> = [];
  const existingIds: unknown[] = [];
  for (const t of targets) {
    const rec = t as Record<string, unknown>;
    const pk = rec[targetPKField];
    if (pk !== undefined && pk !== null) {
      const keys = Object.keys(rec).filter((k) => k !== targetPKField);
      if (keys.length > 0) {
        toReplace.push({ ...rec });
      }
      existingIds.push(pk);
    } else {
      toInsert.push({ ...rec });
    }
  }

  if (toReplace.length > 0) {
    await targetTable.bulkReplace(toReplace, { maxDepth, _depth: depth + 1 });
  }

  const allTargetIds: unknown[] = [...existingIds];
  if (toInsert.length > 0) {
    const insertResult = await targetTable.insertMany(toInsert, { maxDepth, _depth: depth + 1 });
    allTargetIds.push(...insertResult.insertedIds);
  }

  if (allTargetIds.length > 0) {
    const junctionRows = allTargetIds.map((targetId) => ({
      [fkToThisField]: parentPK,
      [fkToTargetField]: targetId,
    }));
    await junctionTable.insertMany(junctionRows, { maxDepth: 0 });
  }
}
