import { type Validator, ValidatorError } from "@atscript/typescript/utils";
import type { FilterExpr } from "@uniqu/core";

import { DbError, DepthLimitExceededError } from "../db-error";
import type { DbValidationContext } from "../db-validator-plugin";
import type {
  AtscriptDbTableLike,
  AtscriptDbWritable,
  TDbForeignKey,
  TDbRelation,
  TWriteTableResolver,
} from "../types";
import type { TableMetadata } from "../table/table-metadata";
import { keyString, pkTupleKey, sameKey } from "../shared/keys";
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
  targetPKField: string;
}

function resolveViaRelation(
  host: TNestedWriterHost,
  relation: TDbRelation,
): TViaRelation | undefined {
  if (!relation.viaType || !host._writeTableResolver) return undefined;
  const targetTable = host._writeTableResolver(relation.targetType());
  const junctionTable = targetTable && host._writeTableResolver(relation.viaType());
  if (!targetTable || !junctionTable) return undefined;
  const fkToThis = host._findRemoteFK(junctionTable, host.tableName);
  const fkToTarget = host._findRemoteFK(junctionTable, resolveRelationTargetTable(relation));
  const targetPKField = targetTable.primaryKeys[0];
  if (
    !fkToThis ||
    !fkToTarget ||
    !targetPKField ||
    fkToThis.fields.length !== 1 ||
    fkToTarget.fields.length !== 1
  ) {
    return undefined;
  }
  return {
    targetTable,
    junctionTable,
    fkToThis: fkToThis.fields[0]!,
    fkToTarget: fkToTarget.fields[0]!,
    targetPKField,
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
    for (const orig of originals) {
      const children = orig[navField];
      if (!Array.isArray(children)) {
        continue;
      }
      for (const child of children) {
        const childData = { ...(child as Record<string, unknown>) };
        if (from.remoteFK) {
          for (const field of from.remoteFK.fields) {
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

    const result = await to.targetTable.insertMany(parents, { maxDepth, _depth: depth + 1 });

    if (to.fk.localFields.length === 1) {
      const fkField = to.fk.localFields[0]!;
      for (let j = 0; j < sourceIndices.length; j++) {
        items[sourceIndices[j]!]![fkField] = result.insertedIds[j];
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
    if (relation.direction !== "from" || !hasNavValue(originals, navField)) {
      continue;
    }
    const from = resolveFromRelation(host, relation);
    const remoteFK = from?.remoteFK;
    if (!from || !remoteFK) {
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
        if (remoteFK.fields.length === 1) {
          childData[remoteFK.fields[0]!] = parentIds[i];
        }
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
  parentIds: unknown[],
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !hasNavValue(originals, navField)) {
      continue;
    }
    const via = resolveViaRelation(host, relation);
    if (!via) {
      continue;
    }

    for (let i = 0; i < originals.length; i++) {
      const targets = originals[i]![navField];
      const parentPK = parentIds[i];
      if (!Array.isArray(targets) || targets.length === 0 || parentPK === undefined) {
        continue;
      }
      await viaLinkTargets(via, targets, parentPK, maxDepth, depth);
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

    await to.targetTable.bulkReplace(parents, { maxDepth, _depth: depth + 1 });

    if (to.fk.localFields.length === 1 && to.fk.targetFields.length === 1) {
      const fkField = to.fk.localFields[0]!;
      const targetField = to.fk.targetFields[0]!;
      for (let j = 0; j < sourceIndices.length; j++) {
        items[sourceIndices[j]!]![fkField] = parents[j]![targetField];
      }
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
): Promise<void> {
  const parentPKField = parentPKFieldOf(host);
  if (parentPKField === undefined) {
    return;
  }
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !hasNavValue(originals, navField)) {
      continue;
    }
    const via = resolveViaRelation(host, relation);
    if (!via) {
      continue;
    }
    for (const original of originals) {
      const targets = original[navField];
      const parentPK = original[parentPKField];
      if (Array.isArray(targets) && parentPK !== undefined) {
        await viaReplace(via, targets, parentPK, maxDepth, depth);
      }
    }
  }
}

// ── Exported: FROM / VIA plan ───────────────────────────────────────────────

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
 *   `CONFLICT`; a `$update` entry without the target PK → `NOT_FOUND`.
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
  const parentPKField = parentPKFieldOf(host);
  if (parentPKField === undefined) {
    return { owned };
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
    // VIA — only the patch operators are restricted to linked targets.
    const via = mode === "patch" ? resolveViaRelation(host, relation) : undefined;
    if (via) {
      await checkViaLinks(via, originals, parentPKField, navField);
    }
  }
  return { owned };
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
  if (!plan) {
    await planNestedFromVia(host, originals, "patch");
  }
  const parentPKField = parentPKFieldOf(host);
  if (parentPKField === undefined) {
    return;
  }
  for (const [navField, relation] of host._meta.relations) {
    if (relation.direction !== "via" || !hasNavValue(originals, navField)) {
      continue;
    }
    const via = resolveViaRelation(host, relation);
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
        await viaReplace(via, ops.replace, parentPK, maxDepth, depth);
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
          await viaLinkTargets(via, toInsert, parentPK, maxDepth, depth);
        }
      }

      // $insert
      if (ops.insert && ops.insert.length > 0) {
        await viaLinkTargets(via, ops.insert, parentPK, maxDepth, depth);
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
  parentPK: unknown,
  maxDepth: number,
  depth: number,
): Promise<void> {
  const { targetTable, junctionTable, fkToThis, fkToTarget, targetPKField } = via;
  const toInsert: Array<Record<string, unknown>> = [];
  const targetIds: unknown[] = [];
  for (const t of targets) {
    const rec = t as Record<string, unknown>;
    const pk = rec[targetPKField];
    if (pk !== undefined && pk !== null) {
      targetIds.push(pk);
    } else {
      toInsert.push({ ...rec });
    }
  }
  if (toInsert.length > 0) {
    const result = await targetTable.insertMany(toInsert, { maxDepth, _depth: depth + 1 });
    targetIds.push(...result.insertedIds);
  }
  if (targetIds.length > 0) {
    await junctionTable.insertMany(
      targetIds.map((targetId) => ({ [fkToThis]: parentPK, [fkToTarget]: targetId })),
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

  await viaLinkTargets(via, targets, parentPK, maxDepth, depth);
}
