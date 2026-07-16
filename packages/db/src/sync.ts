import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { DbSpace } from "./table/db-space";
import { SchemaSync } from "./schema/schema-sync";
import type { TSyncOptions, TSyncPlan, TSyncResult } from "./schema/schema-sync";

/**
 * Synchronizes database schema with distributed locking.
 * Safe to call from multiple concurrent processes/pods.
 *
 * ```typescript
 * import { syncSchema } from '@atscript/db/sync'
 *
 * const db = new DbSpace(() => new SqliteAdapter(driver))
 * await syncSchema(db, [UsersType, PostsType, CommentsType])
 * ```
 *
 * The function:
 * 1. Creates an `__atscript_control` table for lock coordination
 * 2. Computes a schema hash — skips entirely if nothing changed
 * 3. Acquires a distributed lock so only one process syncs
 * 4. Creates tables, adds new columns, syncs indexes
 * 5. Stores the new hash and releases the lock
 *
 * @param space - The DbSpace containing the adapter factory.
 * @param types - Atscript annotated types to synchronize.
 * @param opts - Lock TTL, wait timeout, force mode, etc.
 */
export async function syncSchema(
  space: DbSpace,
  types: TAtscriptAnnotatedType[],
  opts?: TSyncOptions,
): Promise<TSyncResult> {
  const sync = new SchemaSync(space);
  return sync.run(types, opts);
}

/**
 * Computes a dry-run plan showing what {@link syncSchema} would do, without
 * executing any DDL. Wraps {@link SchemaSync.plan}.
 *
 * The plan carries structured per-entry diffs (columns to add/rename/drop,
 * type/nullable/default changes, FK changes) plus a human-readable renderer:
 *
 * ```typescript
 * import { planSchema } from '@atscript/db/sync'
 *
 * const plan = await planSchema(db, [UsersType, PostsType])
 * if (plan.status === 'changes-needed') {
 *   for (const entry of plan.entries) {
 *     console.log(entry.print('plan').join('\n'))
 *   }
 * }
 * ```
 *
 * Note: reading the stored baseline still requires a live DB connection (the
 * snapshot lives in the `__atscript_control` table).
 */
export async function planSchema(
  space: DbSpace,
  types: TAtscriptAnnotatedType[],
  opts?: Pick<TSyncOptions, "force" | "safe">,
): Promise<TSyncPlan> {
  const sync = new SchemaSync(space);
  return sync.plan(types, opts);
}

export { SchemaSync, SyncEntry, readStoredSnapshot } from "./schema/schema-sync";
export type {
  TSyncOptions,
  TSyncResult,
  TSyncPlan,
  TSyncColors,
  TSyncEntryStatus,
} from "./schema/schema-sync";
export { computeColumnDiff } from "./schema/column-diff";
export { computeTableOptionDiff } from "./schema/table-option-diff";
export {
  computeTableSnapshot,
  computeViewSnapshot,
  computeSchemaHash,
  computeTableHash,
  snapshotToExistingColumns,
  snapshotToExistingTableOptions,
} from "./schema/schema-hash";
export type {
  TTableSnapshot,
  TViewSnapshot,
  TFieldSnapshot,
  TForeignKeySnapshot,
} from "./schema/schema-hash";
export { computeForeignKeyDiff, hasForeignKeyChanges, fkKey } from "./schema/fk-diff";
export type { TForeignKeyDiff } from "./schema/fk-diff";
