import { type Validator, ValidatorError } from "@atscript/typescript/utils";
import type { FilterExpr } from "@uniqu/core";

import { DbError, DepthLimitExceededError, invalidQuery } from "../db-error";
import type { DbValidationContext } from "../db-validator-plugin";
import type {
  AtscriptDbTableLike,
  AtscriptDbWritable,
  TDbForeignKey,
  TDbRelation,
  TWriteTableResolver,
} from "../types";
import type { TableMetadata } from "../table/table-metadata";
import { insertedIdPart, keyString, pkTupleKey, sameKey } from "../shared/keys";
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
    controls: { $select?: string[] };
  }): Promise<Record<string, unknown> | null>;
}

type TWritableTable = AtscriptDbTableLike & AtscriptDbWritable;

// ── Relation resolution (shared by every phase) ─────────────────────────────

/** A TO relation's target table and the local → target foreign key. */
function resolveToRelation(
  host: TNestedWriterHost,
  relation: TDbRelation,
):
  | { targetTable: TWritableTable; fk: { localFields: string[]; targetFields: string[] } }
  | undefined {
  const targetTable = host._writeTableResolver?.(relation.targetType());
  const fk = targetTable && host._findFKForRelation(relation);
  return targetTable && fk ? { targetTable, fk } : undefined;
}

/** A FROM relation's child table and the child → parent foreign key (when declared). */
function resolveFromRelation(
  host: TNestedWriterHost,
  relation: TDbRelation,
): { targetTable: TWritableTable; remoteFK: TDbForeignKey | undefined } | undefined {
  const targetTable = host._writeTableResolver?.(relation.targetType());
  return targetTable
    ? { targetTable, remoteFK: host._findRemoteFK(targetTable, host.tableName, relation.alias) }
    : undefined;
}

/** A VIA (M:N) relation with single-field junction keys and a target primary key. */
interface TViaRelation {
  targetTable: TWritableTable;
  junctionTable: TWritableTable;
  /** Junction column referencing the parent. */
  fkToThis: string;
  /** Junction column referencing the target. */
  fkToTarget: string;
  /** The target's primary key — an entry carrying all of it names an existing target. */
  targetPK: readonly string[];
  /** `targetPK[0]` — the replace / patch paths, where it is the whole key (see {@link assertPkLinked}). */
  targetPKField: string;
  /** Parent field {@link fkToThis} references (its primary key or a unique field). */
  thisKeyField: string;
  /** Target field {@link fkToTarget} references. */
  targetKeyField: string;
}

/**
 * A VIA relation's tables and junction keys; `undefined` when a table or a
 * junction foreign key is missing. A composite junction key cannot be
 * written by a nested write → `INVALID_QUERY` (never silently skipped).
 */
function resolveViaRelation(
  host: TNestedWriterHost,
  relation: TDbRelation,
  navField: string,
): TViaRelation | undefined {
  if (!relation.viaType || !host._writeTableResolver) return undefined;
  const targetTable = host._writeTableResolver(relation.targetType());
  const junctionTable = targetTable && host._writeTableResolver(relation.viaType());
  if (!targetTable || !junctionTable) return undefined;
  const fkToThis = host._findRemoteFK(junctionTable, host.tableName);
  const fkToTarget = host._findRemoteFK(junctionTable, resolveRelationTargetTable(relation));
  const targetPK = targetTable.primaryKeys;
  if (!fkToThis || !fkToTarget || targetPK.length === 0) {
    return undefined;
  }
  if (fkToThis.fields.length !== 1 || fkToTarget.fields.length !== 1) {
    throw invalidQuery(
      navField,
      `Nested writes to "${navField}" need single-field junction foreign keys`,
    );
  }
  return {
    targetTable,
    junctionTable,
    fkToThis: fkToThis.fields[0]!,
    fkToTarget: fkToTarget.fields[0]!,
    targetPK,
    targetPKField: targetPK[0]!,
    thisKeyField: fkToThis.targetFields[0]!,
    targetKeyField: fkToTarget.targetFields[0]!,
  };
}

/** The parent's single primary-key field — nested FROM / VIA writes need one. */
function parentPKFieldOf(host: TNestedWriterHost): string | undefined {
  return host._meta.primaryKeys.length === 1 ? host._meta.primaryKeys[0] : undefined;
}

/** Whether any item carries a (non-null) value for `navField` — a phase's cheap skip. */
function hasNavValue(items: Array<Record<string, unknown>>, navField: string): boolean {
  return items.some((item) => item[navField] !== undefined && item[navField] !== null);
}

/**
 * Field `field` of a row just inserted — what a foreign key referencing it
 * gets. `row` is the row as WRITTEN (after the write guard, defaults and the
 * TO phase — never the caller's payload): a primary-key field comes from the
 * inserted id (it includes server-generated values), else from `row`; any
 * other field from `row`. Fails closed — see {@link requireKey}.
 */
function insertedLinkValue(
  row: Record<string, unknown> | undefined,
  insertedId: unknown,
  field: string,
  pkFields: readonly string[],
  navField: string,
): unknown {
  if (pkFields.includes(field)) {
    const part = insertedIdPart(insertedId, field, pkFields);
    if (part !== undefined && part !== null) return part;
  }
  return requireKey(row?.[field], navField, field);
}

/**
 * Fail closed: a foreign key a nested write must fill but cannot resolve (the
 * referenced value is neither in the written row nor reported by the insert)
 * → `FK_VIOLATION` — never a payload value, never a missing link.
 */
function requireKey(value: unknown, navField: string, field: string): unknown {
  if (value === undefined || value === null) {
    throw new DbError("FK_VIOLATION", [
      {
        path: navField,
        message: `Cannot resolve "${field}" of the row "${navField}" links to`,
      },
    ]);
  }
  return value;
}

/** Resolved link values of existing VIA targets, by entry object — see {@link resolveViaLinkValues}. */
export type TViaLinkValues = Map<object, unknown>;

/** Whether a VIA entry names an EXISTING target: it carries the target's whole primary key. */
function isExistingTarget(rec: Record<string, unknown>, targetPK: readonly string[]): boolean {
  return targetPK.every((f) => rec[f] !== undefined && rec[f] !== null);
}

/**
 * The link value of each EXISTING target among `entries` (see
 * {@link isExistingTarget}): the field the junction references, read from the
 * stored row by its primary key — one read, before any write. A missing stored
 * row → `FK_VIOLATION`; an entry whose own value of that field differs from
 * the stored one → `INVALID_QUERY` (the payload never decides the link).
 */
async function resolveViaLinkValues(
  via: TViaRelation,
  entries: unknown[],
  navField: string,
  into: TViaLinkValues,
): Promise<void> {
  const { targetTable, targetPK, targetKeyField } = via;
  const existing = (entries as Array<Record<string, unknown>>).filter(
    (rec) => rec !== null && typeof rec === "object" && isExistingTarget(rec, targetPK),
  );
  if (existing.length === 0) return;
  const rows = await targetTable.findMany({
    filter: orFilter(existing.map((rec) => keyFilter(rec, targetPK))),
    controls: { $select: [...new Set([...targetPK, targetKeyField])] },
  });
  const stored = new Map(rows.map((row) => [pkTupleKey(row, targetPK), row[targetKeyField]]));
  for (const rec of existing) {
    const key = pkTupleKey(rec, targetPK);
    if (!stored.has(key)) {
      throw new DbError("FK_VIOLATION", [
        { path: navField, message: `References a non-existent record in "${navField}"` },
      ]);
    }
    const value = requireKey(stored.get(key), navField, targetKeyField);
    const own = rec[targetKeyField];
    if (own !== undefined && own !== null && !sameKey(own, value)) {
      throw invalidQuery(
        `${navField}.${targetKeyField}`,
        `"${targetKeyField}" does not match the stored row the entry's key names`,
      );
    }
    into.set(rec, value);
  }
}

/** The nested TO objects of a batch for one relation, with their source indices. */
function nestedToObjects(
  items: Array<Record<string, unknown>>,
  navField: string,
): { parents: Array<Record<string, unknown>>; sourceIndices: number[] } {
  const parents: Array<Record<string, unknown>> = [];
  const sourceIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const nested = items[i]![navField];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      parents.push(nested as Record<string, unknown>);
      sourceIndices.push(i);
    }
  }
  return { parents, sourceIndices };
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
      if (items.length > 1) {
        if (error instanceof ValidatorError) {
          throw new ValidatorError(
            error.errors.map((err) => ({
              ...err,
              path: `[${i}].${err.path}`,
            })),
          );
        }
        if (error instanceof DepthLimitExceededError) {
          throw new DepthLimitExceededError(`[${i}].${error.field}`, error.declared, error.actual);
        }
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
  rows: Array<Record<string, unknown>> = originals,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "from" || !hasNavValue(originals, navField)) {
      continue;
    }
    const from = resolveFromRelation(host, relation);
    if (!from) {
      continue;
    }

    const allChildren: Array<Record<string, unknown>> = [];
    for (let i = 0; i < originals.length; i++) {
      const children = originals[i]![navField];
      if (!Array.isArray(children)) {
        continue;
      }
      for (const child of children) {
        const childData = { ...(child as Record<string, unknown>) };
        if (from.remoteFK) {
          // The written parent's value (overwritten after the insert anyway),
          // else a placeholder: a generated key is not known yet.
          const { fields, targetFields } = from.remoteFK;
          fields.forEach((field, k) => {
            childData[field] = rows[i]?.[targetFields[k]!] ?? 0;
          });
        }
        allChildren.push(childData);
      }
    }
    if (allChildren.length === 0) {
      continue;
    }

    await wrapNestedError(navField, () =>
      from.targetTable.preValidateItems(allChildren, { excludeFkTargetTable: host.tableName }),
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
    if (relation.direction !== "to" || !hasNavValue(items, navField)) {
      continue;
    }
    const to = resolveToRelation(host, relation);
    if (!to) {
      continue;
    }
    const { parents, sourceIndices } = nestedToObjects(items, navField);
    if (parents.length === 0) {
      continue;
    }

    // (Links a parent cannot resolve were refused by planNestedInsertLinks.)
    const { localFields, targetFields } = to.fk;
    const targetPK = to.targetTable.primaryKeys;

    const written: Array<Record<string, unknown>> = [];
    const result = await to.targetTable.insertMany(parents, {
      maxDepth,
      _depth: depth + 1,
      _insertedRows: written,
    });

    // Each foreign-key field gets the field it references in the row as the
    // target stored it (a composite key part, or a unique field rather than the
    // target's id) — overwriting any value the payload carried.
    for (let j = 0; j < sourceIndices.length; j++) {
      const item = items[sourceIndices[j]!]!;
      localFields.forEach((local, k) => {
        const target = targetFields[k]!;
        item[local] = insertedLinkValue(
          written[j],
          result.insertedIds[j],
          target,
          targetPK,
          navField,
        );
      });
    }
  }
}

/**
 * Batch-creates FROM dependents after the main insert.
 */
export async function batchInsertNestedFrom(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  rows: Array<Record<string, unknown>>,
  parentIds: unknown[],
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "from" || !hasNavValue(originals, navField)) {
      continue;
    }
    const from = resolveFromRelation(host, relation);
    const remoteFK = from?.remoteFK;
    if (!from || !remoteFK) {
      continue;
    }

    const allChildren: Array<Record<string, unknown>> = [];
    const parentPK = host._meta.primaryKeys;
    for (let i = 0; i < originals.length; i++) {
      const children = originals[i]![navField];
      if (!Array.isArray(children) || children.length === 0) {
        continue;
      }
      // The parent field each foreign-key field references, from the written
      // parent (see insertedLinkValue) — overwriting the child's own value.
      const keys = remoteFK.targetFields.map((target) =>
        insertedLinkValue(rows[i], parentIds[i], target, parentPK, navField),
      );
      for (const child of children) {
        const childData = { ...(child as Record<string, unknown>) };
        remoteFK.fields.forEach((field, k) => {
          childData[field] = keys[k];
        });
        allChildren.push(childData);
      }
    }
    if (allChildren.length === 0) {
      continue;
    }

    await wrapNestedError(navField, () =>
      from.targetTable.insertMany(allChildren, { maxDepth, _depth: depth + 1 }),
    );
  }
}

/**
 * Batch-creates VIA (M:N) targets and junction entries after the main insert.
 */
export async function batchInsertNestedVia(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  rows: Array<Record<string, unknown>>,
  parentIds: unknown[],
  maxDepth: number,
  depth: number,
  viaLinks?: TViaLinkValues,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !hasNavValue(originals, navField)) {
      continue;
    }
    const via = resolveViaRelation(host, relation, navField);
    if (!via) {
      continue;
    }

    for (let i = 0; i < originals.length; i++) {
      const targets = originals[i]![navField];
      if (!Array.isArray(targets) || targets.length === 0) {
        continue;
      }
      const parentKey = insertedLinkValue(
        rows[i],
        parentIds[i],
        via.thisKeyField,
        host._meta.primaryKeys,
        navField,
      );
      await viaLinkTargets(via, targets, parentKey, maxDepth, depth, navField, viaLinks);
    }
  }
}

/**
 * Before ANY write of an insert (the TO phase included), every link of its
 * nested data must be resolvable, else nothing is written:
 * - TO: a referenced target field that is not the target's primary key must be
 *   in the nested object or filled by the SDK at insert
 *   (`fillsDefaultOnInsert` — never a database-side default) → else `FK_VIOLATION`;
 * - FROM / VIA: a referenced parent field that is not its primary key
 *   (generated keys come with the inserted id) must be in the row `rows[i]`
 *   (after the write guard) or be filled by this row's TO phase → else `FK_VIOLATION`;
 * - VIA entries naming an existing target: their link values are read here
 *   ({@link resolveViaLinkValues}) and returned for {@link batchInsertNestedVia}.
 */
export async function planNestedInsertLinks(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  rows: Array<Record<string, unknown>>,
): Promise<TViaLinkValues> {
  const pk = host._meta.primaryKeys;
  const viaLinks: TViaLinkValues = new Map();
  // Per row: the local fields its TO phase fills (a nested TO object present).
  const toFilled: Array<Set<string> | undefined> = [];
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "to") continue;
    const localFields = host._findFKForRelation(relation)?.localFields;
    if (!localFields?.length) continue;
    for (const i of nestedToObjects(rows, navField).sourceIndices) {
      const filled = (toFilled[i] ??= new Set());
      for (const field of localFields) filled.add(field);
    }
  }
  for (const [navField, relation] of host._meta.relations) {
    if (!hasNavValue(rows, navField) && !hasNavValue(originals, navField)) {
      continue;
    }
    if (relation.direction === "to") {
      const to = resolveToRelation(host, relation);
      if (!to) continue;
      const { targetTable } = to;
      const { parents } = nestedToObjects(rows, navField);
      for (const target of to.fk.targetFields) {
        if (
          targetTable.primaryKeys.includes(target) ||
          targetTable.fillsDefaultOnInsert?.(target)
        ) {
          continue;
        }
        for (const nested of parents) {
          requireKey(nested[target], navField, target);
        }
      }
      continue;
    }
    let referenced: readonly string[] | undefined;
    let via: TViaRelation | undefined;
    if (relation.direction === "from") {
      referenced = resolveFromRelation(host, relation)?.remoteFK?.targetFields;
    } else {
      via = resolveViaRelation(host, relation, navField);
      referenced = via ? [via.thisKeyField] : undefined;
    }
    if (!referenced) continue;
    const entries: unknown[] = [];
    for (let i = 0; i < originals.length; i++) {
      const nested = originals[i]![navField];
      if (!Array.isArray(nested) || nested.length === 0) continue;
      for (const field of referenced) {
        if (pk.includes(field) || toFilled[i]?.has(field)) continue;
        requireKey(rows[i]?.[field], navField, field);
      }
      entries.push(...nested);
    }
    if (via) await resolveViaLinkValues(via, entries, navField, viaLinks);
  }
  return viaLinks;
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
  const work: Array<{
    navField: string;
    to: NonNullable<ReturnType<typeof resolveToRelation>>;
    parents: Array<Record<string, unknown>>;
    sourceIndices: number[];
  }> = [];
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "to" || !hasNavValue(items, navField)) {
      continue;
    }
    const to = resolveToRelation(host, relation);
    if (!to) {
      continue;
    }
    const { parents, sourceIndices } = nestedToObjects(items, navField);
    if (parents.length === 0) {
      continue;
    }
    // Every referenced field must be in the replaced object (a replace would
    // otherwise reset or regenerate it): refused before any write.
    for (const parent of parents) {
      for (const target of to.fk.targetFields) {
        if (parent[target] === undefined || parent[target] === null) {
          throw invalidQuery(
            `${navField}.${target}`,
            `A replaced "${navField}" must carry "${target}" — the foreign key links by it`,
          );
        }
      }
    }
    work.push({ navField, to, parents, sourceIndices });
  }

  for (const { to, parents, sourceIndices } of work) {
    await to.targetTable.bulkReplace(parents, { maxDepth, _depth: depth + 1 });

    // Every foreign-key field (each part of a composite one) gets the field it
    // references in the replaced parent.
    const { localFields, targetFields } = to.fk;
    for (let j = 0; j < sourceIndices.length; j++) {
      const item = items[sourceIndices[j]!]!;
      localFields.forEach((local, k) => {
        item[local] = parents[j]![targetFields[k]!];
      });
    }
  }
}

/**
 * Batch-replaces FROM dependents after the main replace. `plan` is the
 * {@link planNestedFromVia} result for `originals` (`mode: "replace"`);
 * omitted, the plan is made here first.
 */
export async function batchReplaceNestedFrom(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
  plan?: TNestedFromViaPlan,
): Promise<void> {
  plan ??= await planNestedFromVia(host, originals, "replace");
  const parentPKField = parentPKFieldOf(host);
  if (parentPKField === undefined) {
    return;
  }
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "from" || !hasNavValue(originals, navField)) {
      continue;
    }
    const target = fromWriteTarget(host, relation, navField, plan, maxDepth, depth);
    if (!target) {
      continue;
    }
    const replacing = originals.filter(
      (original) => Array.isArray(original[navField]) && original[parentPKField] !== undefined,
    );
    const current = await currentChildrenOf(
      target,
      replacing.map((original) => original[parentPKField]),
      replacing.flatMap((original) => original[navField] as unknown[]),
    );
    for (const original of replacing) {
      const parentPK = original[parentPKField];
      await fromReplace(
        target,
        original[navField] as unknown[],
        parentPK,
        current?.get(keyString(parentPK)),
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
  plan?: TNestedFromViaPlan,
): Promise<void> {
  const parentPKField = parentPKFieldOf(host);
  if (parentPKField === undefined) {
    return;
  }
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !hasNavValue(originals, navField)) {
      continue;
    }
    const via = resolveViaRelation(host, relation, navField);
    if (!via) {
      continue;
    }
    for (const original of originals) {
      const targets = original[navField];
      const parentPK = original[parentPKField];
      if (Array.isArray(targets) && parentPK !== undefined) {
        await viaReplace(via, targets, parentPK, maxDepth, depth, navField, plan?.viaLinks);
      }
    }
  }
}

// ── Exported: FROM / VIA plan ───────────────────────────────────────────────

/**
 * Replace / patch write a FROM / VIA relation's children by the parent's
 * primary key (ownership checks, current-children reads, junction rows). A
 * relation linked by anything else — a unique field, a composite key (also a
 * composite VIA target) — cannot be written that way: `INVALID_QUERY` before
 * any write, never a primary key written into another field, never a silent skip.
 */
function assertPkLinked(host: TNestedWriterHost, relation: TDbRelation, navField: string): void {
  const pkField = parentPKFieldOf(host);
  const byParentPk = (field: string | undefined) => pkField !== undefined && field === pkField;
  let linked = true;
  if (relation.direction === "from") {
    const remoteFK = resolveFromRelation(host, relation)?.remoteFK;
    linked = !remoteFK || (remoteFK.fields.length === 1 && byParentPk(remoteFK.targetFields[0]));
  } else {
    const via = resolveViaRelation(host, relation, navField);
    linked =
      !via ||
      (byParentPk(via.thisKeyField) &&
        via.targetPK.length === 1 &&
        via.targetKeyField === via.targetPKField);
  }
  if (!linked) {
    throw invalidQuery(
      navField,
      `Replace / patch write "${navField}" only through a single-field foreign key to the primary key`,
    );
  }
}

/**
 * The FROM / VIA nested writes of a batch, validated by
 * {@link planNestedFromVia} before the main write (since 0.1.143).
 */
export interface TNestedFromViaPlan {
  /**
   * Per FROM nav field: the {@link pkTupleKey}s of the keyed children that
   * exist under the parent naming them. Their writes must match (a child
   * re-parented meanwhile → `CONFLICT`, rolled back).
   */
  readonly owned: ReadonlyMap<string, ReadonlySet<string>>;
  /** Link values of the existing VIA targets the writes link (read by the plan). */
  readonly viaLinks: TViaLinkValues;
}

/**
 * Validates the FROM and VIA nested writes of a batch BEFORE the main write
 * (since 0.1.143), so a rejected nested operation never leaves the main
 * write applied — even on adapters whose transaction is a pass-through. One
 * read per relation for the whole batch; the entries are evaluated in memory
 * in apply order (`$replace` → `$update` → `$upsert`). `mode: "patch"`
 * checks the operators, `mode: "replace"` the plain arrays of a PUT:
 * - FROM: a keyed child that exists under another parent (or none) → `CONFLICT`;
 *   a `$update` entry without the child PK → `NOT_FOUND`;
 * - VIA: a keyed `$update` / `$upsert` target not linked to the parent →
 *   `CONFLICT`; a `$update` entry without the target PK → `NOT_FOUND`; an
 *   existing target a write links (PUT arrays, `$replace`, `$insert`) must be
 *   stored → else `FK_VIOLATION` (since 0.1.169).
 *
 * The apply phases write the planned FROM children through filters
 * constrained to their parent (`{ pk, fk: parentPK }`), so a child
 * re-parented between the plan and the write is never touched.
 */
export async function planNestedFromVia(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  mode: "patch" | "replace",
): Promise<TNestedFromViaPlan> {
  const owned = new Map<string, ReadonlySet<string>>();
  const viaLinks: TViaLinkValues = new Map();
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "to" && hasNavValue(originals, navField)) {
      assertPkLinked(host, relation, navField);
    }
  }
  const parentPKField = parentPKFieldOf(host);
  if (parentPKField === undefined) {
    return { owned, viaLinks };
  }
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction === "to" || !hasNavValue(originals, navField)) {
      continue;
    }
    if (relation.direction === "from") {
      const from = resolveFromRelation(host, relation);
      if (!from?.remoteFK || from.remoteFK.fields.length !== 1) {
        continue;
      }
      owned.set(
        navField,
        await checkFromOwnership(
          from.targetTable,
          from.remoteFK.fields[0]!,
          originals,
          parentPKField,
          navField,
          mode,
        ),
      );
      continue;
    }
    const via = resolveViaRelation(host, relation, navField);
    if (!via) continue;
    // VIA — only the patch operators are restricted to linked targets.
    if (mode === "patch") {
      await checkViaLinks(via, originals, parentPKField, navField);
    }
    // The existing targets the writes link: stored, read once before any write.
    const linking: unknown[] = [];
    for (const original of originals) {
      const ops = extractNavPatchOps(original[navField]);
      linking.push(...(ops.replace ?? []), ...(mode === "patch" ? (ops.insert ?? []) : []));
    }
    await resolveViaLinkValues(via, linking, navField, viaLinks);
  }
  return { owned, viaLinks };
}

// ── Exported: batch nested patch ────────────────────────────────────────────

/** One TO relation's nested patches, planned before the main patch — see {@link planPatchNestedTo}. */
export interface TNestedToPatchPlan {
  navField: string;
  targetTable: AtscriptDbTableLike & AtscriptDbWritable;
  /** `index` = position of the source item in the batch. */
  entries: Array<{ index: number; patch: Record<string, unknown> }>;
}

/**
 * Plans the TO relation patches of a batch BEFORE the main patch (since
 * 0.1.143). A nested TO object always patches the row the STORED foreign key
 * references. `targets[i]` is item `i`'s stored row (at least its foreign-key
 * columns; `null` = missing) as the table pinned it inside the transaction;
 * omitted, each item's row is read here. Rejected with `INVALID_QUERY`
 * (nothing written): a payload that changes that foreign key AND carries a
 * nested object for the same relation, and a nested object whose own key
 * names a different row. An item whose source row does not exist is skipped
 * (the main patch matches nothing for it). A stored `null` foreign key (or a
 * composite one) → `FK_VIOLATION`.
 */
export async function planPatchNestedTo(
  host: TNestedWriterHost,
  items: Array<Record<string, unknown>>,
  targets?: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Promise<TNestedToPatchPlan[]> {
  const plans: TNestedToPatchPlan[] = [];
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "to" || !hasNavValue(items, navField)) {
      continue;
    }
    const to = resolveToRelation(host, relation);
    if (!to) {
      continue;
    }
    const { parents, sourceIndices } = nestedToObjects(items, navField);
    if (parents.length === 0) {
      continue;
    }
    const fkField = to.fk.localFields[0]!;
    if (to.fk.localFields.length !== 1) {
      throw new DbError("FK_VIOLATION", [
        {
          path: fkField,
          message: `Cannot patch relation '${navField}' — foreign key '${fkField}' is null`,
        },
      ]);
    }
    const targetField = to.fk.targetFields.length === 1 ? to.fk.targetFields[0] : undefined;

    const entries: TNestedToPatchPlan["entries"] = [];
    for (let j = 0; j < parents.length; j++) {
      const index = sourceIndices[j]!;
      const item = items[index]!;
      const current = targets
        ? targets[index]
        : await host.findOne({
            filter: host._extractRecordFilter(item),
            controls: { $select: [fkField] },
          });
      if (!current) {
        continue;
      }
      const stored = current[fkField];

      const payloadFk = item[fkField];
      if (payloadFk !== undefined && !sameKey(payloadFk, stored)) {
        throw new DbError("INVALID_QUERY", [
          {
            path: fkField,
            message:
              `Cannot change '${fkField}' and patch relation '${navField}' in one payload — ` +
              `the nested patch targets the currently referenced record`,
          },
        ]);
      }

      if (stored === null || stored === undefined) {
        throw new DbError("FK_VIOLATION", [
          {
            path: fkField,
            message: `Cannot patch relation '${navField}' — foreign key '${fkField}' is null`,
          },
        ]);
      }

      const patch = { ...parents[j] };
      if (targetField !== undefined) {
        const nestedKey = patch[targetField];
        if (nestedKey !== undefined && !sameKey(nestedKey, stored)) {
          throw new DbError("INVALID_QUERY", [
            {
              path: `${navField}.${targetField}`,
              message:
                `Cannot patch relation '${navField}' — '${targetField}' does not match the ` +
                `currently referenced record`,
            },
          ]);
        }
        patch[targetField] = stored;
      }
      entries.push({ index, patch });
    }
    if (entries.length > 0) {
      plans.push({ navField, targetTable: to.targetTable, entries });
    }
  }
  return plans;
}

/**
 * Applies the TO patches {@link planPatchNestedTo} planned — after the main
 * patch, only for the items it matched (`matched[i]`; all when omitted).
 */
export async function applyPatchNestedTo(
  plans: ReadonlyArray<TNestedToPatchPlan>,
  maxDepth: number,
  depth: number,
  matched?: ReadonlyArray<boolean>,
): Promise<void> {
  for (const plan of plans) {
    const patches = plan.entries.filter((e) => !matched || matched[e.index]).map((e) => e.patch);
    if (patches.length === 0) {
      continue;
    }
    await plan.targetTable.bulkUpdate(patches, { maxDepth, _depth: depth + 1 });
  }
}

/**
 * Batch-patches TO dependencies: {@link planPatchNestedTo} +
 * {@link applyPatchNestedTo} in one step (the table itself plans before and
 * applies after its main patch).
 */
export async function batchPatchNestedTo(
  host: TNestedWriterHost,
  items: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
): Promise<void> {
  await applyPatchNestedTo(await planPatchNestedTo(host, items), maxDepth, depth);
}

/**
 * Batch-patches FROM (1:N) dependencies after the main patch.
 * Supports patch operators: $replace, $insert, $remove, $update, $upsert.
 * `plan` is the {@link planNestedFromVia} result for `originals`
 * (`mode: "patch"`); omitted, the plan is made here first.
 */
export async function batchPatchNestedFrom(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
  plan?: TNestedFromViaPlan,
): Promise<void> {
  plan ??= await planNestedFromVia(host, originals, "patch");
  const parentPKField = parentPKFieldOf(host);
  if (parentPKField === undefined) {
    return;
  }
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "from" || !hasNavValue(originals, navField)) {
      continue;
    }
    const target = fromWriteTarget(host, relation, navField, plan, maxDepth, depth);
    if (!target) {
      continue;
    }
    const { targetTable, fkField, childPKs } = target;

    const patching: Array<{ parentPK: unknown; ops: ReturnType<typeof extractNavPatchOps> }> = [];
    for (const original of originals) {
      const navValue = original[navField];
      const parentPK = original[parentPKField];
      if (navValue === undefined || navValue === null || parentPK === undefined) {
        continue;
      }
      patching.push({ parentPK, ops: extractNavPatchOps(navValue) });
    }
    // One read for all `$replace` parents — unless a parent comes twice: its
    // earlier item's `$insert` / `$upsert` would change its children first.
    const parentKeys = new Set(patching.map(({ parentPK }) => keyString(parentPK)));
    const current =
      parentKeys.size < patching.length
        ? undefined
        : await currentChildrenOf(
            target,
            patching.filter(({ ops }) => ops.replace).map(({ parentPK }) => parentPK),
            patching.flatMap(({ ops }) => [
              ...(ops.replace ?? []),
              ...(ops.update ?? []),
              ...(ops.upsert ?? []),
              ...(ops.insert ?? []),
            ]),
          );

    for (const { parentPK, ops } of patching) {
      // $replace
      if (ops.replace) {
        await fromReplace(target, ops.replace, parentPK, current?.get(keyString(parentPK)));
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
        await targetTable.deleteMany(orFilter(removeFilters));
      }

      // $update
      if (ops.update && ops.update.length > 0) {
        await fromUpdate(target, withField(ops.update, fkField, parentPK));
      }

      // $upsert
      if (ops.upsert) {
        const toUpdate: Array<Record<string, unknown>> = [];
        const toInsert: Array<Record<string, unknown>> = [];
        for (const child of ops.upsert) {
          const rec = { ...(child as Record<string, unknown>), [fkField]: parentPK };
          (isKeyed(rec, childPKs) ? toUpdate : toInsert).push(rec);
        }
        if (toUpdate.length > 0) {
          await fromUpdate(target, toUpdate);
        }
        if (toInsert.length > 0) {
          await wrapNestedError(navField, () =>
            targetTable.insertMany(toInsert, { maxDepth, _depth: depth + 1 }),
          );
        }
      }

      // $insert
      if (ops.insert && ops.insert.length > 0) {
        const items = withField(ops.insert, fkField, parentPK);
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
 * `plan` marks `originals` as already validated by {@link planNestedFromVia}
 * (`mode: "patch"`); omitted, they are validated here first.
 */
export async function batchPatchNestedVia(
  host: TNestedWriterHost,
  originals: Array<Record<string, unknown>>,
  maxDepth: number,
  depth: number,
  plan?: TNestedFromViaPlan,
): Promise<void> {
  plan ??= await planNestedFromVia(host, originals, "patch");
  const parentPKField = parentPKFieldOf(host);
  if (parentPKField === undefined) {
    return;
  }
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !hasNavValue(originals, navField)) {
      continue;
    }
    const via = resolveViaRelation(host, relation, navField);
    if (!via) {
      continue;
    }
    const { targetTable, junctionTable, fkToThis, fkToTarget, targetPKField } = via;

    for (const original of originals) {
      const navValue = original[navField];
      const parentPK = original[parentPKField];
      if (navValue === undefined || navValue === null || parentPK === undefined) {
        continue;
      }
      const ops = extractNavPatchOps(navValue);

      // $replace
      if (ops.replace) {
        await viaReplace(via, ops.replace, parentPK, maxDepth, depth, navField, plan.viaLinks);
      }

      // $remove
      if (ops.remove && ops.remove.length > 0) {
        const targetPKs = ops.remove
          .map((t) => (t as Record<string, unknown>)[targetPKField])
          .filter((pk) => pk !== undefined && pk !== null);
        if (targetPKs.length > 0) {
          await junctionTable.deleteMany({
            [fkToThis]: parentPK,
            [fkToTarget]: targetPKs.length === 1 ? targetPKs[0] : { $in: targetPKs },
          });
        }
      }

      // $update — targets linked to this parent (checked by the plan)
      if (ops.update && ops.update.length > 0) {
        const toUpdate = ops.update.map((t) => ({ ...(t as Record<string, unknown>) }));
        await targetTable.bulkUpdate(toUpdate, { maxDepth, _depth: depth + 1 });
      }

      // $upsert
      if (ops.upsert && ops.upsert.length > 0) {
        const toUpdate: Array<Record<string, unknown>> = [];
        const toInsert: Array<Record<string, unknown>> = [];
        for (const target of ops.upsert) {
          const rec = { ...(target as Record<string, unknown>) };
          const pk = rec[targetPKField];
          (pk !== undefined && pk !== null ? toUpdate : toInsert).push(rec);
        }

        // Keyed entries update targets already linked to this parent (since
        // 0.1.143 an unlinked one is rejected by the plan — link it with `$insert`).
        if (toUpdate.length > 0) {
          await targetTable.bulkUpdate(toUpdate, { maxDepth, _depth: depth + 1 });
        }

        // Batch insert new targets + create junctions
        if (toInsert.length > 0) {
          await viaLinkTargets(via, toInsert, parentPK, maxDepth, depth, navField, plan.viaLinks);
        }
      }

      // $insert
      if (ops.insert && ops.insert.length > 0) {
        await viaLinkTargets(via, ops.insert, parentPK, maxDepth, depth, navField, plan.viaLinks);
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

/** `filters` as one filter — a lone filter as-is, several `$or`-ed. */
function orFilter(filters: Array<Record<string, unknown>>): FilterExpr {
  return filters.length === 1 ? filters[0]! : ({ $or: filters } as FilterExpr);
}

/** Copies of `entries` with `field` set to `value` (a child's foreign key to its parent). */
function withField(
  entries: unknown[],
  field: string,
  value: unknown,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of entries) out.push({ ...(entry as Record<string, unknown>), [field]: value });
  return out;
}

/** Identity of a junction link (parent key, target key). */
function linkKey(parentPK: unknown, targetPK: unknown): string {
  return `${keyString(parentPK)}\0${keyString(targetPK)}`;
}

/** Whether `rec` carries every primary-key field (a table without one keys nothing). */
function isKeyed(rec: Record<string, unknown>, pkFields: readonly string[]): boolean {
  return pkFields.length > 0 && pkFields.every((pk) => rec[pk] !== undefined);
}

/** The primary-key equality filter of a keyed entry. */
function keyFilter(
  rec: Record<string, unknown>,
  pkFields: readonly string[],
): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  for (const pk of pkFields) f[pk] = rec[pk];
  return f;
}

/**
 * Nested `$update` entries are identified by the related table's primary key
 * only (since 0.1.143) — a unique key could name a row outside the relation.
 */
function requireKeys(
  entries: unknown[],
  pkFields: readonly string[],
  navField: string,
  op: string,
): void {
  for (let i = 0; i < entries.length; i++) {
    const rec = entries[i] as Record<string, unknown>;
    const missing = pkFields.find((pk) => rec[pk] === undefined || rec[pk] === null);
    if (missing !== undefined) {
      throw new DbError("NOT_FOUND", [
        {
          path: `${navField}.${op}[${i}].${missing}`,
          message: `Missing primary key field "${missing}" in '${navField}' ${op} entry`,
        },
      ]);
    }
  }
}

/**
 * FROM half of {@link planNestedFromVia}: ONE read of every keyed child the
 * batch names; a child that exists under a different parent (or none) →
 * `CONFLICT`. Keys that match no row pass (the usual "nothing matched"
 * semantics apply). Returns the keys of the children found under their parent.
 */
async function checkFromOwnership(
  targetTable: TWritableTable,
  fkField: string,
  originals: Array<Record<string, unknown>>,
  parentPKField: string,
  navField: string,
  mode: "patch" | "replace",
): Promise<Set<string>> {
  const childPKs = targetTable.primaryKeys;
  const claims: Array<{ parentPK: unknown; child: Record<string, unknown>; op: string }> = [];
  const claim = (entries: unknown[], parentPK: unknown, op: string) => {
    for (const entry of entries) {
      const child = entry as Record<string, unknown>;
      if (isKeyed(child, childPKs)) claims.push({ parentPK, child, op });
    }
  };
  for (const original of originals) {
    const parentPK = original[parentPKField];
    const navValue = original[navField];
    if (parentPK === undefined || navValue === undefined || navValue === null) {
      continue;
    }
    if (mode === "replace") {
      if (Array.isArray(navValue)) claim(navValue, parentPK, "replace");
      continue;
    }
    const ops = extractNavPatchOps(navValue);
    if (ops.replace) claim(ops.replace, parentPK, "replace");
    if (ops.update && ops.update.length > 0) {
      requireKeys(ops.update, childPKs, navField, "$update");
      claim(ops.update, parentPK, "$update");
    }
    if (ops.upsert) claim(ops.upsert, parentPK, "$upsert");
  }

  const owned = new Set<string>();
  if (claims.length === 0) return owned;
  const rows = await targetTable.findMany({
    filter: orFilter(claims.map((c) => keyFilter(c.child, childPKs))),
    controls: { $select: [...childPKs, fkField] },
  });
  const parentOf = new Map<string, unknown>();
  for (const row of rows) parentOf.set(pkTupleKey(row, childPKs), row[fkField]);
  for (const { parentPK, child, op } of claims) {
    const key = pkTupleKey(child, childPKs);
    if (!parentOf.has(key)) continue;
    if (!sameKey(parentOf.get(key), parentPK)) {
      const label = childPKs.map((pk) => keyString(child[pk])).join(", ");
      throw new DbError("CONFLICT", [
        {
          path: navField,
          message: `Cannot ${op} '${navField}' — record [${label}] is not a child of this record`,
        },
      ]);
    }
    owned.add(key);
  }
  return owned;
}

/**
 * VIA half of {@link planNestedFromVia}: ONE junction read for every keyed
 * `$update` / `$upsert` target of the batch; a target not currently linked
 * to its parent → `CONFLICT` (since 0.1.143) — whether or not the target
 * exists. Linking an existing target is `$insert`'s job.
 */
async function checkViaLinks(
  via: TViaRelation,
  originals: Array<Record<string, unknown>>,
  parentPKField: string,
  navField: string,
): Promise<void> {
  const { junctionTable, fkToThis, fkToTarget, targetPKField } = via;
  const claims: Array<{ parentPK: unknown; targetPK: unknown; op: string }> = [];
  for (const original of originals) {
    const parentPK = original[parentPKField];
    const navValue = original[navField];
    if (parentPK === undefined || navValue === undefined || navValue === null) {
      continue;
    }
    const ops = extractNavPatchOps(navValue);
    if (ops.update && ops.update.length > 0) {
      requireKeys(ops.update, [targetPKField], navField, "$update");
      for (const t of ops.update) {
        claims.push({
          parentPK,
          targetPK: (t as Record<string, unknown>)[targetPKField],
          op: "$update",
        });
      }
    }
    for (const t of ops.upsert ?? []) {
      const targetPK = (t as Record<string, unknown>)[targetPKField];
      if (targetPK !== undefined && targetPK !== null) {
        claims.push({ parentPK, targetPK, op: "$upsert" });
      }
    }
  }
  if (claims.length === 0) return;

  const links = await junctionTable.findMany({
    filter: orFilter(claims.map((c) => ({ [fkToThis]: c.parentPK, [fkToTarget]: c.targetPK }))),
    controls: { $select: [fkToThis, fkToTarget] },
  });
  const linked = new Set(links.map((j) => linkKey(j[fkToThis], j[fkToTarget])));
  const unlinked = claims.find((c) => !linked.has(linkKey(c.parentPK, c.targetPK)));
  if (unlinked) {
    throw new DbError("CONFLICT", [
      {
        path: navField,
        message:
          `Cannot ${unlinked.op} '${navField}' — record [${keyString(unlinked.targetPK)}] is not ` +
          `linked to this record (link it with $insert first)`,
      },
    ]);
  }
}

/** Everything a FROM apply phase needs for one relation. */
interface TFromWriteTarget {
  targetTable: TWritableTable;
  navField: string;
  /** Child column referencing the parent. */
  fkField: string;
  childPKs: readonly string[];
  /** Planned-owned child keys — their writes must match. */
  owned: ReadonlySet<string>;
  maxDepth: number;
  depth: number;
}

function fromWriteTarget(
  host: TNestedWriterHost,
  relation: TDbRelation,
  navField: string,
  plan: TNestedFromViaPlan,
  maxDepth: number,
  depth: number,
): TFromWriteTarget | undefined {
  const from = resolveFromRelation(host, relation);
  if (!from?.remoteFK || from.remoteFK.fields.length !== 1) return undefined;
  return {
    targetTable: from.targetTable,
    navField,
    fkField: from.remoteFK.fields[0]!,
    childPKs: from.targetTable.primaryKeys,
    owned: plan.owned.get(navField) ?? new Set(),
    maxDepth,
    depth,
  };
}

/**
 * Write options that pin each child to its parent: the child table ANDs
 * `{ fk: <item's fk> }` into every row filter (the foreign key is never
 * SET — a child is never re-parented), and a planned-owned child that no
 * longer matches → `CONFLICT` (rolled back).
 */
function ownedWriteOpts(target: TFromWriteTarget, items: Array<Record<string, unknown>>) {
  return {
    maxDepth: target.maxDepth,
    _depth: target.depth + 1,
    _ownedBy: {
      field: target.fkField,
      strict: items.map((item) => target.owned.has(pkTupleKey(item, target.childPKs))),
    },
  };
}

/** FROM `$update` / keyed `$upsert`: patch the parent's own children. */
async function fromUpdate(
  target: TFromWriteTarget,
  items: Array<Record<string, unknown>>,
): Promise<void> {
  await wrapNestedError(target.navField, () =>
    target.targetTable.bulkUpdate(items, ownedWriteOpts(target, items)),
  );
}

/**
 * FROM $replace helper: delete the parent's orphans, replace its keyed
 * children, insert the rest.
 */
async function fromReplace(
  target: TFromWriteTarget,
  children: unknown[],
  parentPK: unknown,
  current?: Array<Record<string, unknown>>,
): Promise<void> {
  const { targetTable, navField, fkField, childPKs, maxDepth, depth } = target;
  const toReplace: Array<Record<string, unknown>> = [];
  const toInsert: Array<Record<string, unknown>> = [];
  const keep = new Set<string>();
  for (const child of children) {
    const childData = { ...(child as Record<string, unknown>), [fkField]: parentPK };
    if (isKeyed(childData, childPKs)) {
      keep.add(pkTupleKey(childData, childPKs));
      toReplace.push(childData);
    } else {
      toInsert.push(childData);
    }
  }

  const existing =
    current ??
    (await targetTable.findMany({
      filter: { [fkField]: parentPK },
      controls: childPKs.length > 0 ? { $select: [...childPKs] } : {},
    }));
  const orphanFilters: Array<Record<string, unknown>> = [];
  for (const row of existing) {
    if (!keep.has(pkTupleKey(row, childPKs))) {
      orphanFilters.push({ ...keyFilter(row, childPKs), [fkField]: parentPK });
    }
  }
  if (orphanFilters.length > 0) {
    await targetTable.deleteMany(orFilter(orphanFilters));
  }

  if (toReplace.length > 0) {
    await wrapNestedError(navField, () =>
      targetTable.bulkReplace(toReplace, ownedWriteOpts(target, toReplace)),
    );
  }
  if (toInsert.length > 0) {
    await wrapNestedError(navField, () =>
      targetTable.insertMany(toInsert, { maxDepth, _depth: depth + 1 }),
    );
  }
}

/**
 * The current (keyed) children of several parents in ONE read — what
 * {@link fromReplace} reads per parent, grouped by parent key (since 0.1.151).
 * The writes stay per parent and in order; only this read is shared, which is
 * safe because each parent's writes are pinned to its own children (the
 * foreign key is filtered on and never SET) and no child entry of the batch
 * (`entries`) carries nested navigation data (no nested write of a child can
 * reach another parent's children); a row removed meanwhile by a delete cascade is a no-op orphan
 * delete or the same `CONFLICT` either way. Done only where grouping cannot
 * differ from the store's own matching: two or more DISTINCT integer parent
 * keys (no collation can merge two of them) and a child table with a primary
 * key; a fetched row that maps to no parent key (a representation the
 * grouping does not know) also falls back. `undefined` → read per parent.
 */
async function currentChildrenOf(
  target: TFromWriteTarget,
  parentPKs: unknown[],
  entries: unknown[],
): Promise<Map<string, Array<Record<string, unknown>>> | undefined> {
  const { targetTable, fkField, childPKs } = target;
  if (parentPKs.length < 2 || childPKs.length === 0) return undefined;
  // A child entry carrying nested navigation data could, through its own
  // nested writes (a self-referencing tree), add children to a parent later
  // in the batch.
  const childNav = targetTable.getMetadata().navFields;
  if (childNav.size > 0) {
    for (const entry of entries) {
      for (const navField of childNav) {
        const value = (entry as Record<string, unknown> | null)?.[navField];
        if (value !== undefined && value !== null) return undefined;
      }
    }
  }
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const pk of parentPKs) {
    if (!(typeof pk === "number" && Number.isInteger(pk)) && typeof pk !== "bigint") {
      return undefined;
    }
    const key = keyString(pk);
    if (groups.has(key)) return undefined; // the same parent twice: its writes change its children
    groups.set(key, []);
  }
  const rows = await targetTable.findMany({
    filter: { [fkField]: { $in: parentPKs } },
    controls: { $select: [...new Set([...childPKs, fkField])] },
  });
  for (const row of rows) {
    const value = row[fkField];
    const group = value === null || value === undefined ? undefined : groups.get(keyString(value));
    if (!group) return undefined;
    group.push(row);
  }
  return groups;
}

/**
 * Links `targets` to the parent: keyed entries by their key, unkeyed ones
 * inserted first — then one junction insert.
 */
async function viaLinkTargets(
  via: TViaRelation,
  targets: unknown[],
  parentKey: unknown,
  maxDepth: number,
  depth: number,
  navField: string,
  resolved?: TViaLinkValues,
): Promise<void> {
  const { targetTable, junctionTable, fkToThis, fkToTarget, targetPK, targetKeyField } = via;
  const toInsert: Array<Record<string, unknown>> = [];
  const existing: Array<Record<string, unknown>> = [];
  for (const t of targets) {
    const rec = t as Record<string, unknown>;
    (isExistingTarget(rec, targetPK) ? existing : toInsert).push(rec);
  }
  // Existing targets link by their STORED value — resolved before the write
  // (planNestedInsertLinks / planNestedFromVia); read here only if it was not.
  const links = resolved ?? new Map();
  const unresolved = existing.filter((rec) => !links.has(rec));
  if (unresolved.length > 0) await resolveViaLinkValues(via, unresolved, navField, links);
  const linkValues = existing.map((rec) => links.get(rec));
  if (toInsert.length > 0) {
    const written: Array<Record<string, unknown>> = [];
    const result = await targetTable.insertMany(
      toInsert.map((rec) => ({ ...rec })),
      { maxDepth, _depth: depth + 1, _insertedRows: written },
    );
    toInsert.forEach((_, k) =>
      linkValues.push(
        insertedLinkValue(written[k], result.insertedIds[k], targetKeyField, targetPK, navField),
      ),
    );
  }
  if (linkValues.length > 0) {
    await junctionTable.insertMany(
      linkValues.map((value) => ({ [fkToThis]: parentKey, [fkToTarget]: value })),
      { maxDepth: 0 },
    );
  }
}

/**
 * VIA $replace helper: clear junctions, replace/insert targets, rebuild junctions.
 */
async function viaReplace(
  via: TViaRelation,
  targets: unknown[],
  parentPK: unknown,
  maxDepth: number,
  depth: number,
  navField: string,
  resolved?: TViaLinkValues,
): Promise<void> {
  const { targetTable, junctionTable, fkToThis, targetPKField } = via;
  await junctionTable.deleteMany({ [fkToThis]: parentPK });

  const toReplace: Array<Record<string, unknown>> = [];
  for (const t of targets) {
    const rec = t as Record<string, unknown>;
    const pk = rec[targetPKField];
    if (pk !== undefined && pk !== null && Object.keys(rec).some((k) => k !== targetPKField)) {
      toReplace.push({ ...rec });
    }
  }
  if (toReplace.length > 0) {
    await targetTable.bulkReplace(toReplace, { maxDepth, _depth: depth + 1 });
  }

  await viaLinkTargets(via, targets, parentPK, maxDepth, depth, navField, resolved);
}
