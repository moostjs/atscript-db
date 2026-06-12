import type { AtscriptDbReadable } from "../table/db-readable";
import type { AtscriptDbView } from "../table/db-view";
import type { BaseDbAdapter } from "../base-adapter";
import type { DbSpace } from "../table/db-space";
import type { TGenericLogger } from "../logger";
import type { TColumnDiff, TDbFieldMeta, TTableOptionDiff } from "../types";
import type { SyncStore } from "./sync-store";
import { SyncEntry, type TSyncEntryInit, type TSyncEntryStatus } from "./sync-entry";
import { computeColumnDiff } from "./column-diff";
import { computeForeignKeyDiff, hasForeignKeyChanges, fkKey } from "./fk-diff";
import type { TForeignKeyDiff } from "./fk-diff";
import { snapshotToExistingColumns, computeTableHash, computeViewSnapshot } from "./schema-hash";

// ── Deps ─────────────────────────────────────────────────────────────────

export interface TSyncExecutorDeps {
  store: SyncStore;
  space: DbSpace;
  logger: TGenericLogger;
  resolveTypeMapper: (adapter: BaseDbAdapter) => (f: TDbFieldMeta) => string;
  diffTableOptions: (readable: AtscriptDbReadable) => Promise<TTableOptionDiff | null>;
}

// ── View definition change check ─────────────────────────────────────────

/** Checks if a tracked view's definition changed since the last stored snapshot. */
export async function viewDefinitionChanged(
  view: AtscriptDbView,
  store: SyncStore,
): Promise<boolean> {
  const storedSnapshot = await store.readTableSnapshot(view.tableName, true);
  if (!storedSnapshot) {
    return false;
  }
  const currentHash = computeTableHash(computeViewSnapshot(view));
  return computeTableHash(storedSnapshot) !== currentHash;
}

// ── Table sync ───────────────────────────────────────────────────────────

export async function executeSyncTable(
  readable: AtscriptDbReadable,
  safe: boolean,
  trackedNames: Set<string>,
  deps: TSyncExecutorDeps,
): Promise<SyncEntry> {
  const adapter = readable.dbAdapter;
  const name = readable.tableName;
  const init: TSyncEntryInit = {
    name,
    status: "in-sync",
    syncMethod: readable.syncMethod,
  };

  // Handle table rename first
  if (readable.renamedFrom && trackedNames.has(readable.renamedFrom) && adapter.renameTable) {
    await adapter.renameTable(readable.renamedFrom);
    init.renamedFrom = readable.renamedFrom;
    init.status = "alter";
  }

  // Compute FK diff from stored snapshot (used by Path A to detect FK changes)
  let fkDiff: TForeignKeyDiff | undefined;
  const fkSnapshotName = init.renamedFrom ?? name;
  const storedSnapshot = await deps.store.readTableSnapshot(fkSnapshotName);
  if (storedSnapshot) {
    fkDiff = computeForeignKeyDiff(readable.foreignKeys, storedSnapshot.foreignKeys);
  }
  const hasFkChanges = fkDiff ? hasForeignKeyChanges(fkDiff) : false;

  if (adapter.getExistingColumns && adapter.syncColumns) {
    // Path A: Live introspection (SQLite, MySQL)
    const existing = await adapter.getExistingColumns();
    if (existing.length === 0 && !init.renamedFrom) {
      await adapter.ensureTable();
      init.status = "create";
    } else if (existing.length > 0) {
      // FK changes on adapters without syncForeignKeys (SQLite) require table recreation
      if (hasFkChanges && !init.recreated && !adapter.syncForeignKeys && adapter.recreateTable) {
        await adapter.recreateTable();
        init.recreated = true;
        init.status = "alter";
      } else {
        // Drop stale/changed FKs before column ops (MySQL) to unblock ALTERs
        if (hasFkChanges && fkDiff && adapter.dropForeignKeys) {
          const keysToDrop = [
            ...fkDiff.removed.map((fk) => fkKey(fk.fields)),
            ...fkDiff.changed.map((fk) => fkKey(fk.desired.fields)),
          ];
          if (keysToDrop.length > 0) {
            await adapter.dropForeignKeys(keysToDrop);
            init.status = "alter";
          }
        }

        const typeMapper = adapter.typeMapper?.bind(adapter);
        const diff = computeColumnDiff(readable.fieldDescriptors, existing, typeMapper);
        await applyColumnDiff(adapter, readable, diff, init, safe, deps.logger);
      }
    }
  } else if (adapter.syncColumns) {
    // Path B: Snapshot-based diffing (MongoDB)
    // Reuse the storedSnapshot already read above for FK diff (same key)
    if (!storedSnapshot) {
      // First sync or no prior snapshot — just ensure table exists
      const existed = adapter.tableExists ? await adapter.tableExists() : false;
      await adapter.ensureTable();
      if (!existed) {
        init.status = "create";
      }
    } else {
      const existing = snapshotToExistingColumns(storedSnapshot);
      const diff = computeColumnDiff(
        readable.fieldDescriptors,
        existing,
        deps.resolveTypeMapper(adapter),
      );
      await applyColumnDiff(adapter, readable, diff, init, safe, deps.logger);
    }
  } else {
    // Path C: Truly schema-less, no syncColumns
    const existed = adapter.tableExists ? await adapter.tableExists() : true;
    if (!init.recreated) {
      await adapter.ensureTable();
      if (!existed) {
        init.status = "create";
      }
    }
  }

  // Detect and apply table option drift (unified across all paths)
  if (init.status !== "create" && !init.recreated && !safe) {
    const optionDiff = await deps.diffTableOptions(readable);
    if (optionDiff && optionDiff.changed.length > 0) {
      init.optionChanges = optionDiff.changed;

      const hasDestructive = optionDiff.changed.some((c) => c.destructive);
      const nonDestructive = optionDiff.changed.filter((c) => !c.destructive);

      // Apply non-destructive changes in-place (e.g., MySQL ALTER TABLE ENGINE=X)
      if (nonDestructive.length > 0 && adapter.applyTableOptions) {
        await adapter.applyTableOptions(nonDestructive);
        init.status = "alter";
      }

      // Destructive changes require recreation
      if (hasDestructive) {
        const syncMethod = readable.syncMethod;
        if (syncMethod === "recreate" && adapter.recreateTable) {
          deps.logger.warn?.(
            `[schema-sync] Destructive table option change on "${name}" — recreating with data preservation`,
          );
          await adapter.recreateTable();
          init.status = "alter";
          init.recreated = true;
        } else if (adapter.dropTable) {
          deps.logger.warn?.(
            `[schema-sync] Destructive table option change on "${name}" — dropping and recreating`,
          );
          await adapter.dropTable();
          await adapter.ensureTable();
          init.status = "alter";
          init.recreated = true;
        }
      }
    }
  }

  // Sync indexes and foreign keys. DDL here can fail on data conflicts
  // (e.g. CREATE UNIQUE INDEX over duplicate rows) — surface that as an
  // error entry instead of an unhandled throw, so the run completes and
  // the schema hash is not persisted (the next boot retries).
  try {
    await adapter.syncIndexes();

    if (adapter.syncForeignKeys) {
      await adapter.syncForeignKeys();
    }

    // Post-sync finalization (e.g., reset identity sequences after data migration)
    if (adapter.afterSyncTable) {
      await adapter.afterSyncTable();
    }
  } catch (error) {
    const msg = `Index/FK sync failed on ${name}: ${(error as Error).message}`;
    deps.logger.error?.(`[schema-sync] ${msg}`);
    init.errors = [...(init.errors ?? []), msg];
    init.status = "error";
  }

  return new SyncEntry(init);
}

// ── View sync ────────────────────────────────────────────────────────────

export interface TViewSyncPlan {
  isRenamed: boolean;
  definitionChanged: boolean;
}

/** Determines whether a view's predecessor (on rename) or stale definition must be dropped. */
export async function planViewSync(
  view: AtscriptDbView,
  trackedNames: Set<string>,
  store: SyncStore,
): Promise<TViewSyncPlan> {
  const isRenamed = !!(view.renamedFrom && trackedNames.has(view.renamedFrom));
  const definitionChanged =
    !isRenamed && trackedNames.has(view.tableName) && (await viewDefinitionChanged(view, store));
  return { isRenamed, definitionChanged };
}

/** Drops the stale view a plan identified — views don't support ALTER VIEW. */
export async function dropOutdatedView(
  view: AtscriptDbView,
  plan: TViewSyncPlan,
  space: DbSpace,
): Promise<void> {
  if (plan.isRenamed) {
    await space.dropViewByName(view.renamedFrom!);
  } else if (plan.definitionChanged) {
    await space.dropViewByName(view.tableName);
  }
}

export async function executeSyncView(
  view: AtscriptDbView,
  trackedNames: Set<string>,
  deps: TSyncExecutorDeps,
  plan?: TViewSyncPlan,
): Promise<SyncEntry> {
  // A precomputed plan means the caller already dropped the stale view
  // (SchemaSync.run() pre-drops changed views before table ops); otherwise
  // compute and drop here.
  if (!plan) {
    plan = await planViewSync(view, trackedNames, deps.store);
    await dropOutdatedView(view, plan, deps.space);
  }
  const { isRenamed, definitionChanged } = plan;

  await view.dbAdapter.ensureTable();

  const viewType = view.viewPlan.materialized ? ("M" as const) : ("V" as const);
  let status: TSyncEntryStatus;
  if (isRenamed || definitionChanged) {
    status = "alter";
  } else if (trackedNames.has(view.tableName)) {
    status = "in-sync";
  } else {
    status = "create";
  }

  return new SyncEntry({
    name: view.tableName,
    status,
    viewType,
    renamedFrom: isRenamed ? view.renamedFrom : undefined,
    recreated: definitionChanged || undefined,
  });
}

// ── Column diff application (shared by Path A and Path B) ────────────────

async function applyColumnDiff(
  adapter: BaseDbAdapter,
  readable: AtscriptDbReadable,
  diff: TColumnDiff,
  init: TSyncEntryInit,
  safe: boolean,
  logger: TGenericLogger,
): Promise<void> {
  const name = readable.tableName;

  // Handle rename conflicts
  if (diff.conflicts.length > 0) {
    const errors: string[] = diff.conflicts.map(
      (c) =>
        `Column rename conflict on ${name}: cannot rename "${c.oldName}" → "${c.field.physicalName}" because "${c.conflictsWith}" already exists.`,
    );
    for (const msg of errors) {
      logger.error?.(`[schema-sync] ${msg}`);
    }
    init.errors = [...(init.errors ?? []), ...errors];
    init.status = "error";
  }

  // Handle type changes
  // Adapters with supportsColumnModify (e.g. MySQL) can ALTER in-place;
  // others require @db.sync.method "recreate"/"drop" or error out.
  let needsSyncColumns = false;
  if (diff.typeChanged.length > 0 && init.status !== "error") {
    const syncMethod = readable.syncMethod;
    if (syncMethod === "drop" && adapter.dropTable) {
      await adapter.dropTable();
      await adapter.ensureTable();
      init.recreated = true;
      init.status = "alter";
    } else if (syncMethod === "recreate" && adapter.recreateTable) {
      await adapter.recreateTable();
      init.recreated = true;
      init.status = "alter";
    } else if (adapter.supportsColumnModify && adapter.syncColumns) {
      // Adapter can handle type changes in-place (e.g. MySQL MODIFY COLUMN)
      // Defer to the single syncColumns call below
      needsSyncColumns = true;
      init.status = "alter";
    } else {
      const errors: string[] = [];
      for (const change of diff.typeChanged) {
        const msg =
          `Type change on ${name}.${change.field.physicalName} ` +
          `(${change.existingType} → ${change.field.designType}). ` +
          `Add @db.sync.method "recreate" or "drop", or migrate manually.`;
        logger.error?.(`[schema-sync] ${msg}`);
        errors.push(msg);
      }
      init.errors = errors;
      init.status = "error";
    }
  }

  // Handle nullable/default changes via table recreation (skip if already recreated or errored)
  // These require recreating the table for adapters that enforce constraints (e.g., SQLite)
  // For schema-less adapters (MongoDB), no DB action is needed — snapshot update handles it
  // Adapters with supportsColumnModify defer these to the single syncColumns call below
  // Skip in safe mode — recreation could drop columns that should be preserved
  if (
    !safe &&
    !init.recreated &&
    init.status !== "error" &&
    (diff.nullableChanged.length > 0 || diff.defaultChanged.length > 0)
  ) {
    if (adapter.supportsColumnModify && adapter.syncColumns) {
      needsSyncColumns = true;
      init.status = "alter";
    } else if (adapter.recreateTable) {
      await adapter.recreateTable();
      init.recreated = true;
      init.status = "alter";
    } else {
      // Schema-less adapter — just mark as alter; snapshot will be updated
      init.status = "alter";
    }
  } else if (diff.nullableChanged.length > 0 || diff.defaultChanged.length > 0) {
    init.status = "alter";
  }

  // Handle renames, adds, type changes, and nullable changes via syncColumns
  // For supportsColumnModify adapters, this single call handles everything
  if (
    !init.recreated &&
    init.status !== "error" &&
    (diff.added.length > 0 || diff.renamed.length > 0 || needsSyncColumns) &&
    adapter.syncColumns
  ) {
    const syncResult = await adapter.syncColumns(diff);
    init.columnsAdded = syncResult.added;
    init.columnsRenamed = syncResult.renamed;
    if (syncResult.added.length > 0 || (syncResult.renamed?.length ?? 0) > 0 || needsSyncColumns) {
      init.status = "alter";
    }
  }

  // Drop stale columns (unless safe mode, table was recreated, or errored)
  if (
    !safe &&
    !init.recreated &&
    init.status !== "error" &&
    diff.removed.length > 0 &&
    adapter.dropColumns
  ) {
    const colNames = diff.removed.map((c) => c.name);
    if (adapter.dropIndexesForColumns) {
      await adapter.dropIndexesForColumns(colNames);
    }
    await adapter.dropColumns(colNames);
    init.columnsDropped = colNames;
    init.status = "alter";
  }
}
