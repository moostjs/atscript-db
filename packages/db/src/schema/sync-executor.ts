import type { AtscriptDbReadable } from "../table/db-readable";
import type { AtscriptDbView } from "../table/db-view";
import type { BaseDbAdapter } from "../base-adapter";
import type { DbSpace } from "../table/db-space";
import type { TGenericLogger } from "../logger";
import type {
  TColumnDiff,
  TDbFieldMeta,
  TDbObjectKind,
  TEnsureTableOptions,
  TExistingColumn,
  TReferencingForeignKey,
  TTableOptionDiff,
} from "../types";
import type { SyncStore } from "./sync-store";
import {
  SyncEntry,
  type TSyncEntryInit,
  type TSyncEntryStatus,
  type TSyncSkippedWork,
} from "./sync-entry";
import { computeColumnDiff } from "./column-diff";
import { hasForeignKeyChanges, fkKey } from "./fk-diff";
import type { TForeignKeyDiff } from "./fk-diff";
import type { TTableSnapshot } from "./schema-hash";
import { snapshotToExistingColumns, computeTableHash, computeViewSnapshot } from "./schema-hash";

// ── Deps ─────────────────────────────────────────────────────────────────

export interface TSyncExecutorDeps {
  logger: TGenericLogger;
  resolveTypeMapper: (adapter: BaseDbAdapter) => (f: TDbFieldMeta) => string;
}

/**
 * Everything the discovery phase learned about one desired table. Pre-flight
 * validates these facts and the executor applies exactly them — nothing is
 * re-introspected or re-diffed between the two.
 */
export interface TTableFacts {
  readable: AtscriptDbReadable;
  name: string;
  /** Old name when `@db.table.renamed` applies (old name is tracked). */
  pendingRename?: string;
  /** The name the table has in the database right now. */
  dbName: string;
  storedSnapshot: TTableSnapshot | null;
  /** FK diff against the stored snapshot (absent without a snapshot). */
  fkDiff?: TForeignKeyDiff;
  /**
   * Live columns (Path A). `undefined` when they could not be read before
   * the rename — the executor introspects right after renaming.
   */
  existing?: TExistingColumn[];
  /** Column diff pre-flight approved (absent for a fresh create). */
  diff?: TColumnDiff;
  /**
   * Table-option drift (live options, snapshot fallback) — diffed once here
   * for every existing table; the executor applies exactly this diff.
   */
  optionDiff?: TTableOptionDiff | null;
  /**
   * Whether executing this table drops its physical table — a primary-key
   * rebuild or a {@link willDropRecreate} drop-and-recreate. The removed
   * tables that still reference it are dropped right before it.
   */
  dropsTable: boolean;
  /** Plan entry (status/columns/FK changes), as `plan()` reports it. */
  planEntry: TSyncEntryInit;
  /**
   * Only probed when the primary-key set changes: `true`/`false`, or
   * `"unknown"` when the adapter cannot tell (base `hasRows` default under a
   * pending rename).
   */
  populated?: boolean | "unknown";
  /**
   * Live inbound FKs — probed only when the run drops the physical table
   * (`dropsTable`; the drop-and-recreate half only when a removed table
   * could block it); `undefined` when not probed or when the adapter cannot
   * introspect them.
   */
  inboundFks?: TReferencingForeignKey[];
  /** Physical object kind under `dbName` (`undefined` = absent or not introspectable). */
  objectKind?: TDbObjectKind;
}

/** Per-table execution options computed by the discovery phase. */
export interface TTableExecOptions {
  /**
   * Members of the foreign-key cycle this table belongs to. Inline FKs to
   * them are omitted from CREATE TABLE and `syncForeignKeys` is skipped here —
   * {@link executeDeferredForeignKeys} runs it once every member exists.
   */
  deferForeignKeysTo?: ReadonlySet<string>;
  /** Tables this one's DDL waits for (informational → `entry.dependsOn`). */
  dependsOn?: string[];
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
  facts: TTableFacts,
  safe: boolean,
  deps: TSyncExecutorDeps,
  exec: TTableExecOptions,
): Promise<SyncEntry> {
  const { readable, name, storedSnapshot, fkDiff } = facts;
  const adapter = readable.dbAdapter;
  const init: TSyncEntryInit = {
    name,
    status: "in-sync",
    syncMethod: readable.syncMethod,
    dependsOn: exec.dependsOn,
  };
  const ensureOpts: TEnsureTableOptions | undefined = exec.deferForeignKeysTo
    ? { deferForeignKeysTo: exec.deferForeignKeysTo }
    : undefined;

  // Handle table rename first
  if (facts.pendingRename && adapter.renameTable) {
    await adapter.renameTable(facts.pendingRename);
    init.renamedFrom = facts.pendingRename;
    init.status = "alter";
  }

  const hasFkChanges = fkDiff ? hasForeignKeyChanges(fkDiff) : false;

  if (adapter.getExistingColumns && adapter.syncColumns) {
    // Path A: Live introspection (SQLite, MySQL, PostgreSQL). Discovery read
    // the columns under the table's current name; when it could not (pending
    // rename the adapter cannot introspect by name), read them now.
    const existing = facts.existing ?? (await adapter.getExistingColumns());
    if (existing.length === 0 && !init.renamedFrom) {
      await adapter.ensureTable(ensureOpts);
      init.status = "create";
    } else if (existing.length > 0) {
      const diff =
        facts.diff ??
        computeColumnDiff(readable.fieldDescriptors, existing, adapter.typeMapper?.bind(adapter));
      // FK changes on adapters without syncForeignKeys (SQLite) require table recreation
      if (hasFkChanges && !adapter.syncForeignKeys && adapter.recreateTable) {
        await adapter.recreateTable();
        init.recreated = true;
        init.status = "alter";
        if (diff.primaryKeyChanged) {
          // The recreated table already carries the new key.
          init.pkChange = { ...diff.primaryKeyChanged, rebuild: true };
        }
      } else {
        // Drop stale/changed FKs before column ops (MySQL/PG) to unblock
        // ALTERs. Parents run before children (topological order), so a
        // parent's key change is never blocked by a child later in the run.
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
        await applyColumnDiff(adapter, readable, diff, init, safe, deps.logger, ensureOpts);
      }
    }
  } else if (adapter.syncColumns) {
    // Path B: Snapshot-based diffing (MongoDB)
    if (!storedSnapshot) {
      // First sync or no prior snapshot — just ensure table exists
      const existed = adapter.tableExists ? await adapter.tableExists() : false;
      await adapter.ensureTable(ensureOpts);
      if (!existed) {
        init.status = "create";
      }
    } else {
      const diff =
        facts.diff ??
        computeColumnDiff(
          readable.fieldDescriptors,
          snapshotToExistingColumns(storedSnapshot),
          deps.resolveTypeMapper(adapter),
        );
      await applyColumnDiff(adapter, readable, diff, init, safe, deps.logger, ensureOpts);
    }
  } else {
    // Path C: Truly schema-less, no syncColumns
    const existed = adapter.tableExists ? await adapter.tableExists() : true;
    if (!init.recreated) {
      await adapter.ensureTable(ensureOpts);
      if (!existed) {
        init.status = "create";
      }
    }
  }

  // Apply the table option drift discovery diffed (unified across all paths)
  const optionDiff = facts.optionDiff;
  if (
    init.status !== "create" &&
    !init.recreated &&
    init.status !== "error" &&
    optionDiff &&
    optionDiff.changed.length > 0
  ) {
    const hasDestructive = optionDiff.changed.some((c) => c.destructive);
    if (safe) {
      // Safe mode never recreates: a destructive change stays pending (the
      // table's snapshot and the hash are withheld); non-destructive changes
      // are not applied either and are not reported.
      if (hasDestructive) {
        init.optionChanges = optionDiff.changed;
        init.status = "alter";
        markSkipped(init, "table-options");
        deps.logger.warn?.(
          `[schema-sync] Destructive table option change on "${name}" — recreate skipped (safe mode)`,
        );
      }
    } else {
      init.optionChanges = optionDiff.changed;
      const nonDestructive = optionDiff.changed.filter((c) => !c.destructive);

      // Apply non-destructive changes in-place (e.g., MySQL ALTER TABLE ENGINE=X)
      if (nonDestructive.length > 0 && adapter.applyTableOptions) {
        await adapter.applyTableOptions(nonDestructive);
        init.status = "alter";
      }

      // Destructive changes require recreation
      if (hasDestructive) {
        if (willDropRecreate(readable, undefined, optionDiff)) {
          deps.logger.warn?.(
            `[schema-sync] Destructive table option change on "${name}" — dropping and recreating`,
          );
          await dropAndRecreate(adapter, init, name, deps.logger, ensureOpts);
        } else if (readable.syncMethod === "recreate" && adapter.recreateTable) {
          deps.logger.warn?.(
            `[schema-sync] Destructive table option change on "${name}" — recreating with data preservation`,
          );
          await adapter.recreateTable();
          init.status = "alter";
          init.recreated = true;
        }
      }
    }
  }

  if (init.status === "error") {
    return new SyncEntry(init);
  }

  // Sync indexes and foreign keys. DDL here can fail on data conflicts
  // (e.g. CREATE UNIQUE INDEX over duplicate rows) — surface that as an
  // error entry instead of an unhandled throw, so the run completes and
  // the schema hash is not persisted (the next boot retries).
  try {
    await adapter.syncIndexes();

    // Cycle members add their FKs in the deferred pass, once every member exists.
    if (adapter.syncForeignKeys && !exec.deferForeignKeysTo) {
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

/**
 * Deferred foreign-key pass for the members of a foreign-key cycle: runs
 * `syncForeignKeys()` (which adds every FK missing from the live table) now
 * that all members exist. A failure turns the table's entry into an error
 * entry — the run continues and the hash is withheld.
 */
export async function executeDeferredForeignKeys(
  readable: AtscriptDbReadable,
  entry: SyncEntry,
  deps: TSyncExecutorDeps,
): Promise<SyncEntry> {
  const adapter = readable.dbAdapter;
  if (!adapter.syncForeignKeys || entry.status === "error") {
    return entry;
  }
  try {
    await adapter.syncForeignKeys();
    return entry;
  } catch (error) {
    const msg = `FK sync failed on ${readable.tableName}: ${(error as Error).message}`;
    deps.logger.error?.(`[schema-sync] ${msg}`);
    return new SyncEntry({ ...entry.toInit(), status: "error", errors: [...entry.errors, msg] });
  }
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

/** Status a managed view's entry gets for a given plan. */
export function viewPlanStatus(
  view: AtscriptDbView,
  plan: TViewSyncPlan,
  trackedNames: Set<string>,
): TSyncEntryStatus {
  if (plan.isRenamed || plan.definitionChanged) {
    return "alter";
  }
  return trackedNames.has(view.tableName) ? "in-sync" : "create";
}

/**
 * Creates (or recreates) a managed view. The stale/renamed predecessor was
 * dropped by `SchemaSync.execute()` before the table ops; `planned` is the
 * entry discovery computed for it and is returned as the run entry.
 */
export async function executeSyncView(
  view: AtscriptDbView,
  planned: SyncEntry,
): Promise<SyncEntry> {
  await view.dbAdapter.ensureTable();
  return planned;
}

// ── Column diff application (shared by Path A and Path B) ────────────────

/** The plan-shaped summary of a diff's type changes (`entry.typeChanges`). */
export function describeTypeChanges(
  diff: TColumnDiff,
): Array<{ column: string; fromType: string; toType: string }> {
  return diff.typeChanged.map((tc) => ({
    column: tc.field.physicalName,
    fromType: tc.existingType,
    toType: tc.field.designType,
  }));
}

/**
 * Whether the run drops and recreates this table's physical table — the two
 * `dropAndRecreate` sites: a `@db.sync.method "drop"` type change (`diff`),
 * or a destructive table-option change (`optionDiff`) on a table that does
 * not resolve it with `@db.sync.method "recreate"` (PostgreSQL / MySQL
 * `recreateTable` handle inbound FKs themselves, so `'recreate'` is not a
 * trigger). Both need `dropTable`. One predicate for discovery (which
 * schedules the removed tables that block the drop right before it — both
 * halves are covered since 0.1.128) and for the executor, whose two sites
 * each pass the half they decide and perform the drop — or, in safe mode,
 * record it as skipped — so they cannot drift.
 */
export function willDropRecreate(
  readable: AtscriptDbReadable,
  diff: TColumnDiff | undefined,
  optionDiff: TTableOptionDiff | null | undefined,
): boolean {
  const adapter = readable.dbAdapter;
  if (!adapter.dropTable) {
    return false;
  }
  if (readable.syncMethod === "drop" && (diff?.typeChanged.length ?? 0) > 0) {
    return true;
  }
  return (
    (optionDiff?.changed.some((c) => c.destructive) ?? false) &&
    !(readable.syncMethod === "recreate" && !!adapter.recreateTable)
  );
}

/** Records work safe mode skipped on the entry (see `SyncEntry.skipped`). */
function markSkipped(init: TSyncEntryInit, kind: TSyncSkippedWork): void {
  init.skipped = [...(init.skipped ?? []), kind];
}

/** Whether nullable/default changes need DDL on this adapter (schema-less ones only update the snapshot). */
function needsDdlForNullableDefaults(adapter: BaseDbAdapter): boolean {
  return (!!adapter.supportsColumnModify && !!adapter.syncColumns) || !!adapter.recreateTable;
}

/**
 * The work `run({ safe: true })` skips on this table, in the order the
 * executor records it — the plan's safe branch reports exactly what the run
 * reports. A recreate that runs even in safe mode (an FK change on an adapter
 * without `syncForeignKeys`, a `'recreate'` type change) carries every other
 * change with it, so nothing is skipped then; an errored plan entry issues no
 * DDL either way.
 */
export function safeModeSkips(facts: TTableFacts): TSyncSkippedWork[] {
  const { readable, diff, optionDiff, fkDiff } = facts;
  const adapter = readable.dbAdapter;
  const out: TSyncSkippedWork[] = [];
  if (facts.planEntry.status === "error") {
    return out;
  }
  if (fkDiff && hasForeignKeyChanges(fkDiff) && !adapter.syncForeignKeys && adapter.recreateTable) {
    return out;
  }
  let recreated = false;
  if (diff && diff.typeChanged.length > 0) {
    if (willDropRecreate(readable, diff, undefined)) {
      out.push("recreate");
    } else if (readable.syncMethod === "recreate" && adapter.recreateTable) {
      recreated = true;
    }
  }
  if (recreated) {
    return out;
  }
  if (
    diff &&
    (diff.nullableChanged.length > 0 || diff.defaultChanged.length > 0) &&
    needsDdlForNullableDefaults(adapter)
  ) {
    out.push("nullable-defaults");
  }
  if (diff?.primaryKeyChanged) {
    out.push("pk-rebuild");
  }
  if (optionDiff?.changed.some((c) => c.destructive)) {
    out.push("table-options");
  }
  return out;
}

/** The plan-shaped nullable / default change summaries of a diff. */
export function describeNullableDefaults(
  diff: TColumnDiff,
): Pick<TSyncEntryInit, "nullableChanges" | "defaultChanges"> {
  return {
    nullableChanges: diff.nullableChanged.map((nc) => ({
      column: nc.field.physicalName,
      toNullable: nc.field.optional,
    })),
    defaultChanges: diff.defaultChanged.map((dc) => ({
      column: dc.field.physicalName,
      oldDefault: dc.oldDefault,
      newDefault: dc.newDefault,
    })),
  };
}

/**
 * `dropTable()` + `ensureTable()` for `@db.sync.method "drop"` and destructive
 * option changes. Sync-owned drops never CASCADE: when something outside the
 * sync inventory (a user view, an unmanaged FK) still depends on the table the
 * engine refuses, and that becomes an error entry for this table — not a
 * thrown run.
 */
async function dropAndRecreate(
  adapter: BaseDbAdapter,
  init: TSyncEntryInit,
  name: string,
  logger: TGenericLogger,
  ensureOpts: TEnsureTableOptions | undefined,
): Promise<void> {
  try {
    await adapter.dropTable!();
    await adapter.ensureTable(ensureOpts);
    init.recreated = true;
    init.status = "alter";
  } catch (error) {
    const msg = `Drop of "${name}" failed: ${(error as Error).message}`;
    logger.error?.(`[schema-sync] ${msg}`);
    init.errors = [...(init.errors ?? []), msg];
    init.status = "error";
  }
}

async function applyColumnDiff(
  adapter: BaseDbAdapter,
  readable: AtscriptDbReadable,
  diff: TColumnDiff,
  init: TSyncEntryInit,
  safe: boolean,
  logger: TGenericLogger,
  ensureOpts: TEnsureTableOptions | undefined,
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
    if (willDropRecreate(readable, diff, undefined)) {
      if (safe) {
        // Safe mode never drops: the change stays pending, reported like a
        // skipped key rebuild. `SchemaSync.execute()` withholds the table's
        // snapshot and the hash so the next run without `safe` recreates.
        init.typeChanges = describeTypeChanges(diff);
        markSkipped(init, "recreate");
        init.status = "alter";
        const cols = init.typeChanges
          .map((tc) => `${tc.column}: ${tc.fromType} → ${tc.toType}`)
          .join(", ");
        logger.warn?.(
          `[schema-sync] Type change on "${name}" (${cols}) — drop-and-recreate skipped (safe mode)`,
        );
      } else {
        await dropAndRecreate(adapter, init, name, logger, ensureOpts);
      }
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
  if (diff.nullableChanged.length > 0 || diff.defaultChanged.length > 0) {
    if (!safe && !init.recreated && init.status !== "error") {
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
    } else if (init.status !== "error") {
      // An error entry stays an error (its DDL failed or was refused, so the
      // change is pending and the snapshot and hash are withheld); a
      // recreated table already carries the change and keeps `alter`.
      if (safe && !init.recreated && needsDdlForNullableDefaults(adapter)) {
        // Safe mode issued no DDL: the change stays pending (snapshot and
        // hash withheld), reported exactly as `plan()` reports it. A
        // schema-less adapter only updates the snapshot — nothing is pending.
        Object.assign(init, describeNullableDefaults(diff));
        markSkipped(init, "nullable-defaults");
        logger.warn?.(`[schema-sync] Nullable/default change on "${name}" — skipped (safe mode)`);
      }
      init.status = "alter";
    }
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

  // Primary-key field-set change — after renames/adds (the new key columns
  // exist), before drops (an old key column removed in the same sync is still
  // there for the swap). Pre-flight already refused populated tables, so the
  // table is empty here, and `SchemaSync.execute()` already dropped the live
  // inbound FKs of retargeting children. A table recreated above already
  // carries the new key.
  if (diff.primaryKeyChanged && init.status !== "error") {
    const { from, to } = diff.primaryKeyChanged;
    const label = `(${from.join(", ")} → ${to.join(", ")})`;
    if (init.recreated) {
      // A recreate above (type change / FK change / option change) already
      // built the table with the new key.
      init.pkChange = { from, to, rebuild: true };
    } else if (safe) {
      logger.warn?.(
        `[schema-sync] Primary key of "${name}" changed ${label} — rebuild skipped (safe mode)`,
      );
      init.pkChange = { from, to, rebuild: false };
      markSkipped(init, "pk-rebuild");
      init.status = "alter";
    } else if (adapter.rebuildPrimaryKey || adapter.recreateTable) {
      if (adapter.rebuildPrimaryKey) {
        await adapter.rebuildPrimaryKey({ from, to });
      } else {
        await adapter.recreateTable!();
        init.recreated = true;
      }
      init.pkChange = { from, to, rebuild: true };
      init.status = "alter";
    } else {
      const msg = `Primary key of "${name}" changed ${label} but the adapter cannot rebuild primary keys. Migrate manually and re-run.`;
      logger.error?.(`[schema-sync] ${msg}`);
      init.errors = [...(init.errors ?? []), msg];
      init.status = "error";
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
