import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { AtscriptDbView } from "../table/db-view";
import type { AtscriptDbReadable } from "../table/db-readable";
import type { BaseDbAdapter } from "../base-adapter";
import type { DbSpace } from "../table/db-space";
import type { TGenericLogger } from "../logger";
import { NoopLogger } from "../logger";
import type { TColumnDiff, TDbFieldMeta, TExistingTableOption, TTableOptionDiff } from "../types";
import {
  computeTableSnapshot,
  computeViewSnapshot,
  computeSchemaHash,
  snapshotToExistingColumns,
  snapshotToExistingTableOptions,
} from "./schema-hash";
import type { TTableSnapshot } from "./schema-hash";
import { computeColumnDiff } from "./column-diff";
import { computeForeignKeyDiff, hasForeignKeyChanges } from "./fk-diff";
import { computeTableOptionDiff } from "./table-option-diff";
import { SyncStore } from "./sync-store";
import { SyncEntry, type TSyncEntryInit, type TSyncEntryStatus } from "./sync-entry";
import {
  executeSyncTable,
  executeSyncView,
  planViewSync,
  dropOutdatedView,
  viewDefinitionChanged,
  type TSyncExecutorDeps,
  type TViewSyncPlan,
} from "./sync-executor";

export {
  SyncEntry,
  type TSyncEntryInit,
  type TSyncColors,
  type TSyncEntryStatus,
} from "./sync-entry";
export { readStoredSnapshot } from "./sync-store";

// ── Public types ──────────────────────────────────────────────────────────

export interface TSyncPlan {
  status: "up-to-date" | "changes-needed";
  schemaHash: string;
  entries: SyncEntry[];
}

export interface TSyncOptions {
  /** Pod/instance identifier for distributed locking. Default: random UUID. */
  podId?: string;
  /** Lock TTL in milliseconds. Default: 30000 (30s). */
  lockTtlMs?: number;
  /** How long to wait for another pod's lock before giving up. Default: 60000 (60s). */
  waitTimeoutMs?: number;
  /** Poll interval when waiting for lock. Default: 500ms. */
  pollIntervalMs?: number;
  /** Force sync even if hash matches. Default: false. */
  force?: boolean;
  /** Safe mode — skip destructive operations (column drops, table drops). Default: false. */
  safe?: boolean;
  /**
   * Logger for sync progress and failures (index/FK DDL errors are logged,
   * not thrown). Default: NoopLogger — pass `console` to surface them.
   */
  logger?: TGenericLogger;
  /**
   * What to do when the run finishes with errored entries (failed index/FK
   * DDL, external-view checks, …):
   * - `"warn"` (default) — emit a one-line summary plus per-entry error lines
   *   via the configured logger, **falling back to `console` when no logger
   *   is set** (errors are never silently swallowed by the NoopLogger default);
   * - `"throw"` — same reporting, then throw after snapshots/locks are handled;
   * - `"silent"` — legacy behavior: outcome is only observable on the result.
   */
  onError?: "throw" | "warn" | "silent";
}

export interface TSyncResult {
  status: "up-to-date" | "synced" | "synced-by-peer";
  schemaHash: string;
  entries: SyncEntry[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Builds a human-readable description of what changed in an FK constraint. */
function buildFkChangeDetails(
  desired: { targetTable: string; targetFields: string[]; onDelete?: string; onUpdate?: string },
  existing: { targetTable: string; targetFields: string[]; onDelete?: string; onUpdate?: string },
): string {
  const parts: string[] = [];
  if (existing.targetTable !== desired.targetTable) {
    parts.push(`retarget ${existing.targetTable} → ${desired.targetTable}`);
  }
  if (
    [...existing.targetFields].toSorted().join(",") !==
    [...desired.targetFields].toSorted().join(",")
  ) {
    parts.push(`fields ${existing.targetFields.join(",")} → ${desired.targetFields.join(",")}`);
  }
  if ((existing.onDelete ?? undefined) !== (desired.onDelete ?? undefined)) {
    parts.push(`onDelete ${existing.onDelete ?? "noAction"} → ${desired.onDelete ?? "noAction"}`);
  }
  if ((existing.onUpdate ?? undefined) !== (desired.onUpdate ?? undefined)) {
    parts.push(`onUpdate ${existing.onUpdate ?? "noAction"} → ${desired.onUpdate ?? "noAction"}`);
  }
  return parts.join(", ");
}

// ── SchemaSync ────────────────────────────────────────────────────────────

export class SchemaSync {
  private readonly store: SyncStore;
  private logger: TGenericLogger;

  constructor(
    private readonly space: DbSpace,
    logger?: TGenericLogger,
  ) {
    this.logger = logger || NoopLogger;
    this.store = new SyncStore(space);
  }

  /**
   * Resolves types into categorized readables and computes the schema hash.
   * Passes each adapter's typeMapper for precise type tracking in snapshots.
   */
  private async resolveAndHash(types: TAtscriptAnnotatedType[]): Promise<{
    tables: AtscriptDbReadable[];
    views: AtscriptDbReadable[];
    externalViews: AtscriptDbView[];
    hash: string;
  }> {
    const tables: AtscriptDbReadable[] = [];
    const views: AtscriptDbReadable[] = [];
    const externalViews: AtscriptDbView[] = [];
    for (const type of types) {
      const readable = this.space.get(type);
      if (readable.isView) {
        const view = readable as AtscriptDbView;
        if (view.isExternal) {
          externalViews.push(view);
        } else {
          views.push(readable);
        }
      } else {
        tables.push(readable);
      }
    }
    const allReadables = [...tables, ...views, ...externalViews];

    const snapshots = [];
    for (const r of allReadables) {
      if (r.isView) {
        snapshots.push(computeViewSnapshot(r as AtscriptDbView));
        continue;
      }
      // Access fieldDescriptors FIRST to trigger lazy metadata build — adapter
      // hooks (onAfterFlatten) populate state that both prepareTypeMapper()
      // (e.g. which fields are vectors) and getDesiredTableOptions() depend on.
      void r.fieldDescriptors;
      // Let the adapter resolve typeMapper-affecting state (e.g. vector
      // support detection) before hashing — the hash must be deterministic
      // across runs or sync re-runs forever.
      await r.dbAdapter.prepareTypeMapper?.();
      const tm = r.dbAdapter.typeMapper?.bind(r.dbAdapter);
      const opts = r.dbAdapter.getDesiredTableOptions?.();
      snapshots.push(computeTableSnapshot(r, tm, opts));
    }
    const hash = computeSchemaHash(snapshots);

    return { tables, views, externalViews, hash };
  }

  /**
   * Checks an external view: verifies it exists in the DB and columns match.
   * Returns a SyncEntry with status 'in-sync' or 'error'.
   */
  private async checkExternalView(view: AtscriptDbView): Promise<SyncEntry> {
    const adapter = view.dbAdapter;
    const name = view.tableName;
    if (adapter.getExistingColumns) {
      // Path A: Live introspection (SQLite)
      const existing = await adapter.getExistingColumns();
      if (existing.length === 0) {
        return new SyncEntry({
          name,
          viewType: "E",
          status: "error",
          errors: [`External view "${name}" not found in the database`],
        });
      }
      // Check that declared fields exist in the view
      const existingNames = new Set(existing.map((c) => c.name));
      const missing = view.fieldDescriptors
        .filter((f) => !f.ignored && !existingNames.has(f.physicalName))
        .map((f) => f.physicalName);
      if (missing.length > 0) {
        return new SyncEntry({
          name,
          viewType: "E",
          status: "error",
          errors: [`External view "${name}" is missing columns: ${missing.join(", ")}`],
        });
      }
    } else if (adapter.tableExists) {
      // Path B: Existence check only (MongoDB — no column introspection)
      const exists = await adapter.tableExists();
      if (!exists) {
        return new SyncEntry({
          name,
          viewType: "E",
          status: "error",
          errors: [`External view "${name}" not found in the database`],
        });
      }
    }
    return new SyncEntry({ name, viewType: "E", status: "in-sync" });
  }

  /**
   * Detects tables/views present in the previous sync but absent from the current schema.
   * Returns SyncEntry instances with status 'drop'.
   */
  private async detectRemoved(
    currentReadables: AtscriptDbReadable[],
    previous?: Array<{ name: string; isView: boolean; viewType?: "V" | "M" | "E" }>,
  ): Promise<SyncEntry[]> {
    previous ??= await this.store.readTrackedList();
    const currentSet = new Set(currentReadables.map((t) => t.tableName));
    // Build set of old names that are being renamed (not dropped)
    const renameFromSet = new Set(currentReadables.map((r) => r.renamedFrom).filter(Boolean));
    const removed: SyncEntry[] = [];
    for (const entry of previous) {
      if (!currentSet.has(entry.name) && !renameFromSet.has(entry.name)) {
        removed.push(
          new SyncEntry({
            name: entry.name,
            viewType: entry.viewType,
            status: "drop",
          }),
        );
      }
    }
    return removed;
  }

  /**
   * Starts a periodic heartbeat that extends the lock's TTL while sync runs.
   * Returns a handle with `stop()` to cancel and `getAbortReason()` to check
   * whether the lock was stolen or unexpectedly removed.
   */
  private startHeartbeat(
    podId: string,
    ttlMs: number,
  ): {
    stop: () => void;
    getAbortReason: () => string | undefined;
  } {
    let abortReason: string | undefined;
    let stopped = false;
    const intervalMs = Math.max(Math.floor(ttlMs / 3), 1000);

    const timer = setInterval(async () => {
      if (stopped) {
        return;
      }
      try {
        const status = await this.store.refreshLock(podId, ttlMs);
        if (stopped) {
          return;
        }
        if (status === "stolen") {
          abortReason = "Schema sync lock was stolen by another pod";
          this.logger.warn(
            "[schema-sync] Lock stolen by another pod — aborting after current operation",
          );
        } else if (status === "missing") {
          abortReason = "Schema sync lock was unexpectedly removed";
          this.logger.warn("[schema-sync] Lock row missing — aborting after current operation");
        }
      } catch (error) {
        if (stopped) {
          return;
        }
        this.logger.warn(
          "[schema-sync] Failed to refresh lock heartbeat (will retry):",
          error instanceof Error ? error.message : error,
        );
      }
    }, intervalMs);

    // Don't keep the Node.js process alive just for the heartbeat
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
      getAbortReason: () => abortReason,
    };
  }

  /** Throws if the heartbeat detected a stolen/missing lock. */
  private assertLockHeld(getAbortReason: () => string | undefined): void {
    const reason = getAbortReason();
    if (reason) {
      throw new Error(reason);
    }
  }

  /**
   * Runs schema synchronization with distributed locking.
   */
  async run(types: TAtscriptAnnotatedType[], opts?: TSyncOptions): Promise<TSyncResult> {
    this.logger = opts?.logger ?? this.logger;
    const podId = opts?.podId ?? crypto.randomUUID();
    const lockTtlMs = opts?.lockTtlMs ?? 30_000;
    const waitTimeoutMs = opts?.waitTimeoutMs ?? 60_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 500;
    const force = opts?.force ?? false;
    const safe = opts?.safe ?? false;

    const { tables, views, externalViews, hash } = await this.resolveAndHash(types);

    await this.store.ensureControlTable();

    // Quick check — skip if hash matches
    if (!force) {
      const storedHash = await this.store.readHash();
      if (storedHash === hash) {
        return { status: "up-to-date", schemaHash: hash, entries: [] };
      }
    }

    // Acquire lock
    const acquired = await this.store.tryAcquireLock(podId, lockTtlMs);
    if (!acquired) {
      await this.store.waitForLock(waitTimeoutMs, pollIntervalMs);

      const storedHash = await this.store.readHash();
      if (storedHash === hash) {
        return { status: "synced-by-peer", schemaHash: hash, entries: [] };
      }

      const retryAcquired = await this.store.tryAcquireLock(podId, lockTtlMs);
      if (!retryAcquired) {
        throw new Error("Failed to acquire schema sync lock after waiting");
      }
    }

    // Start heartbeat — extends lock TTL every ttl/3 while sync is in progress
    const heartbeat = this.startHeartbeat(podId, lockTtlMs);

    try {
      // Double-check hash
      if (!force) {
        const storedHash = await this.store.readHash();
        if (storedHash === hash) {
          return { status: "synced-by-peer", schemaHash: hash, entries: [] };
        }
      }

      // Sync tables
      const allReadables = [...tables, ...views, ...externalViews];
      const previouslyTracked = await this.store.readTrackedList();
      const trackedNames = new Set(previouslyTracked.map((e) => e.name));

      const deps = this.buildExecutorDeps();

      // Drop tracked views whose definition changed (or that are being renamed)
      // BEFORE table ops — their old definitions may reference columns the table
      // sync is about to drop (SQLite and Postgres refuse DROP COLUMN while a
      // view depends on the column). The view phase below recreates them,
      // reusing these plans instead of recomputing.
      const viewPlans = new Map<string, TViewSyncPlan>();
      for (const readable of views) {
        const view = readable as AtscriptDbView;
        const plan = await planViewSync(view, trackedNames, this.store);
        viewPlans.set(view.tableName, plan);
        await dropOutdatedView(view, plan, this.space);
      }

      const entries: SyncEntry[] = [];
      for (const readable of tables) {
        this.assertLockHeld(heartbeat.getAbortReason);
        entries.push(await executeSyncTable(readable, safe, trackedNames, deps));
      }

      // Sync managed views
      this.assertLockHeld(heartbeat.getAbortReason);
      const removed = await this.detectRemoved(allReadables, previouslyTracked);

      for (const readable of views) {
        this.assertLockHeld(heartbeat.getAbortReason);
        entries.push(
          await executeSyncView(
            readable as AtscriptDbView,
            trackedNames,
            deps,
            viewPlans.get(readable.tableName),
          ),
        );
      }

      // Check external views
      const externalEntries = await Promise.all(
        externalViews.map((v) => this.checkExternalView(v)),
      );
      entries.push(...externalEntries);

      // Drop removed tables/views (unless safe mode) — never drop external views
      this.assertLockHeld(heartbeat.getAbortReason);
      if (!safe) {
        for (const entry of removed) {
          if (entry.viewType === "E") {
            continue;
          }
          if (entry.viewType) {
            await this.space.dropViewByName(entry.name);
          } else {
            await this.space.dropTableByName(entry.name);
          }
        }
        entries.push(...removed.filter((e) => e.viewType !== "E"));
      }

      // Store per-table snapshots — but never for errored entries: their DB
      // state does not match the desired schema, and recording the desired
      // snapshot would make the next run believe the failed DDL succeeded.
      this.assertLockHeld(heartbeat.getAbortReason);
      // External views (viewType "E") are exempt: their check is advisory
      // (sync owns no DDL for them), so a missing external view must not
      // block hash persistence or wedge re-runs.
      const erroredNames = new Set(
        entries.filter((e) => e.status === "error" && e.viewType !== "E").map((e) => e.name),
      );
      for (const readable of allReadables) {
        if (erroredNames.has(readable.tableName)) {
          continue;
        }
        const adapter = readable.dbAdapter;
        const tm = adapter.typeMapper?.bind(adapter);
        const opts = adapter.getDesiredTableOptions?.();
        const snapshot = readable.isView
          ? computeViewSnapshot(readable as AtscriptDbView)
          : computeTableSnapshot(readable, tm, opts);
        await this.store.writeTableSnapshot(readable.tableName, snapshot);
      }

      // Clean up snapshots for dropped tables/views
      if (!safe) {
        for (const entry of removed) {
          if (entry.viewType === "E") {
            continue;
          }
          await this.store.deleteTableSnapshot(entry.name);
        }
      }

      // Clean up old-name snapshots after renames
      for (const readable of allReadables) {
        if (readable.renamedFrom) {
          await this.store.deleteTableSnapshot(readable.renamedFrom);
        }
      }

      await this.store.writeTrackedList(allReadables);

      // Persist the schema hash only when every entry succeeded — an error
      // entry means the DB does not match the desired schema, and a stored
      // hash would make the next boot skip the retry as "up-to-date".
      if (erroredNames.size === 0) {
        await this.store.writeHash(hash);
      }

      const result: TSyncResult = { status: "synced", schemaHash: hash, entries };
      this.reportOutcome(result, opts?.onError ?? "warn");
      return result;
    } finally {
      heartbeat.stop();
      await this.store.releaseLock(podId);
    }
  }

  /**
   * Surfaces the run outcome per the `onError` policy. Reporting must never be
   * silently lost to the NoopLogger default — when no real logger is
   * configured, warnings/errors go to `console` (a production consumer lost
   * months of failed-index errors to the silent default).
   */
  private reportOutcome(result: TSyncResult, onError: "throw" | "warn" | "silent"): void {
    if (onError === "silent" || result.entries.length === 0) {
      return;
    }
    const out: TGenericLogger = this.logger === NoopLogger ? console : this.logger;

    const counts = new Map<string, number>();
    for (const entry of result.entries) {
      counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
    out.log(`[schema-sync] ${result.status}: ${summary}`);

    const errored = result.entries.filter((e) => e.hasErrors);
    if (errored.length === 0) {
      return;
    }
    const lines = errored.map(
      (e) => `[schema-sync] "${e.name}" failed: ${e.errors.join("; ") || e.status}`,
    );
    for (const line of lines) {
      out.error(line);
    }
    if (onError === "throw") {
      throw new Error(
        `[schema-sync] ${errored.length} entr${errored.length === 1 ? "y" : "ies"} failed:\n${lines.join("\n")}`,
      );
    }
  }

  /**
   * Computes a dry-run plan showing what `run()` would do, without executing any DDL.
   */
  async plan(
    types: TAtscriptAnnotatedType[],
    opts?: Pick<TSyncOptions, "force" | "safe">,
  ): Promise<TSyncPlan> {
    const force = opts?.force ?? false;
    const safe = opts?.safe ?? false;
    const { tables, views, externalViews, hash } = await this.resolveAndHash(types);
    const allReadables = [...tables, ...views, ...externalViews];

    await this.store.ensureControlTable();

    // Introspect tables
    const previouslyTracked = await this.store.readTrackedList();
    const trackedNames = new Set(previouslyTracked.map((e) => e.name));
    let planEntries = await Promise.all(tables.map((r) => this.planTable(r, trackedNames)));

    // Add managed views to plan
    const viewEntries: SyncEntry[] = await Promise.all(
      views.map((v) => this.planView(v as AtscriptDbView, trackedNames)),
    );

    // Check external views
    const externalEntries = await Promise.all(externalViews.map((v) => this.checkExternalView(v)));

    // Quick check — skip if hash matches
    if (!force) {
      const storedHash = await this.store.readHash();
      if (storedHash === hash) {
        return {
          status: "up-to-date",
          schemaHash: hash,
          entries: [...planEntries, ...viewEntries, ...externalEntries],
        };
      }
    }

    let removed = await this.detectRemoved(allReadables, previouslyTracked);

    if (safe) {
      // Hide destructive operations in safe mode
      planEntries = planEntries.map(
        (e) =>
          new SyncEntry({
            name: e.name,
            viewType: e.viewType,
            status: e.status,
            syncMethod: e.syncMethod,
            columnsToAdd: e.columnsToAdd,
            columnsToRename: e.columnsToRename,
            nullableChanges: e.nullableChanges,
            defaultChanges: e.defaultChanges,
            optionChanges: e.optionChanges,
            fkAdded: e.fkAdded,
            fkRemoved: e.fkRemoved,
            fkChanged: e.fkChanged,
            columnsAdded: e.columnsAdded,
            columnsRenamed: e.columnsRenamed,
            columnsDropped: e.columnsDropped,
            errors: e.errors,
            renamedFrom: e.renamedFrom,
            columnsToDrop: [],
            typeChanges: [],
            recreated: false,
          }),
      );
      removed = [];
    }

    // Never include external view drops
    removed = removed.filter((e) => e.viewType !== "E");

    return {
      status: "changes-needed",
      schemaHash: hash,
      entries: [...planEntries, ...viewEntries, ...externalEntries, ...removed],
    };
  }

  /** Fallback typeMapper for snapshot-based Path B: compares designType directly, skips unions. */
  private resolveTypeMapper(adapter: BaseDbAdapter): (f: TDbFieldMeta) => string {
    return (
      adapter.typeMapper?.bind(adapter) ??
      ((f: TDbFieldMeta) => (f.designType === "union" ? "union" : f.designType))
    );
  }

  // ── Plan table ──────────────────────────────────────────────────────

  private async planTable(
    readable: AtscriptDbReadable,
    trackedNames: Set<string>,
  ): Promise<SyncEntry> {
    const adapter = readable.dbAdapter;
    const name = readable.tableName;
    const init: TSyncEntryInit = {
      name,
      status: "in-sync",
      syncMethod: readable.syncMethod,
    };

    // Detect pending rename
    const renamedFrom = readable.renamedFrom;
    const pendingRename = renamedFrom && trackedNames.has(renamedFrom);
    if (pendingRename) {
      init.renamedFrom = renamedFrom;
      init.status = "alter";
    }

    // Read stored snapshot once — used by Path B column diff and FK diff
    const fkSnapshotName = pendingRename ? renamedFrom : name;
    const storedSnapshot = await this.store.readTableSnapshot(fkSnapshotName);

    if (adapter.getExistingColumns) {
      // Path A: Live introspection (SQLite)
      const existing =
        pendingRename && adapter.getExistingColumnsForTable
          ? await adapter.getExistingColumnsForTable(renamedFrom)
          : await adapter.getExistingColumns();
      if (existing.length === 0 && !pendingRename) {
        init.status = "create";
        init.columnsToAdd = readable.fieldDescriptors.filter((f) => !f.ignored);
      } else if (existing.length > 0) {
        const typeMapper = adapter.typeMapper?.bind(adapter);
        const diff = computeColumnDiff(readable.fieldDescriptors, existing, typeMapper);
        this.populatePlanFromDiff(
          diff,
          init,
          name,
          readable.syncMethod,
          adapter.supportsColumnModify,
        );
      }
    } else if (adapter.syncColumns) {
      // Path B: Snapshot-based diffing (MongoDB) — reuses storedSnapshot from above
      if (!storedSnapshot) {
        if (!pendingRename) {
          const exists = adapter.tableExists ? await adapter.tableExists() : false;
          if (!exists) {
            init.status = "create";
            init.columnsToAdd = readable.fieldDescriptors.filter((f) => !f.ignored);
          }
        }
      } else {
        const existing = snapshotToExistingColumns(storedSnapshot);
        const diff = computeColumnDiff(
          readable.fieldDescriptors,
          existing,
          this.resolveTypeMapper(adapter),
        );
        this.populatePlanFromDiff(
          diff,
          init,
          name,
          readable.syncMethod,
          adapter.supportsColumnModify,
        );
      }
    } else if (adapter.tableExists) {
      // Path C: Schema-less, no syncColumns
      const exists = await adapter.tableExists();
      if (!exists) {
        init.status = "create";
      }
    } else {
      init.status = "create";
    }

    // Detect table option drift (e.g. MySQL engine/charset, MongoDB capped)
    if (init.status !== "create") {
      const optionDiff = await this.diffTableOptions(readable);
      if (optionDiff && optionDiff.changed.length > 0) {
        init.status = "alter";
        init.optionChanges = optionDiff.changed;
        if (optionDiff.changed.some((c) => c.destructive)) {
          init.recreated = true;
        }
      }
    }

    // Detect FK changes (reuses storedSnapshot from above)
    if (init.status !== "create" && storedSnapshot) {
      const fkDiff = computeForeignKeyDiff(readable.foreignKeys, storedSnapshot.foreignKeys);
      if (hasForeignKeyChanges(fkDiff)) {
        init.status = "alter";
        init.fkAdded = fkDiff.added.map((fk) => ({
          fields: fk.fields,
          targetTable: fk.targetTable,
        }));
        init.fkRemoved = fkDiff.removed.map((fk) => ({
          fields: fk.fields,
          targetTable: fk.targetTable,
        }));
        init.fkChanged = fkDiff.changed.map((fk) => ({
          fields: fk.desired.fields,
          targetTable: fk.desired.targetTable,
          details: buildFkChangeDetails(fk.desired, fk.existing),
        }));
      }
    }

    return new SyncEntry(init);
  }

  /**
   * Populates plan init from a column diff (shared by Path A and Path B).
   */
  private populatePlanFromDiff(
    diff: TColumnDiff,
    init: TSyncEntryInit,
    name: string,
    syncMethod?: "drop" | "recreate",
    adapterSupportsModify?: boolean,
  ): void {
    init.columnsToAdd = diff.added;
    init.columnsToRename = diff.renamed.map((r) => ({ from: r.oldName, to: r.field.physicalName }));
    init.typeChanges = diff.typeChanged.map((tc) => ({
      column: tc.field.physicalName,
      fromType: tc.existingType,
      toType: tc.field.designType,
    }));
    init.nullableChanges = diff.nullableChanged.map((nc) => ({
      column: nc.field.physicalName,
      toNullable: nc.field.optional,
    }));
    init.defaultChanges = diff.defaultChanged.map((dc) => ({
      column: dc.field.physicalName,
      oldDefault: dc.oldDefault,
      newDefault: dc.newDefault,
    }));
    init.columnsToDrop = diff.removed.map((c) => c.name);
    const hasChanges =
      diff.added.length > 0 ||
      diff.renamed.length > 0 ||
      diff.typeChanged.length > 0 ||
      diff.nullableChanged.length > 0 ||
      diff.defaultChanged.length > 0 ||
      diff.removed.length > 0;
    if (hasChanges) {
      init.status = "alter";
    }
    // Rename conflicts → error
    if (diff.conflicts.length > 0) {
      init.status = "error";
      init.errors = [
        ...(init.errors ?? []),
        ...diff.conflicts.map(
          (c) =>
            `Column rename conflict on ${name}: cannot rename "${c.oldName}" → "${c.field.physicalName}" because "${c.conflictsWith}" already exists.`,
        ),
      ];
    }
    // Type changes without a sync method → error (sync will fail)
    // Exception: adapters that support in-place column modification (e.g. MySQL MODIFY COLUMN)
    if (diff.typeChanged.length > 0 && !syncMethod && !adapterSupportsModify) {
      init.status = "error";
      init.errors = [
        ...(init.errors ?? []),
        ...diff.typeChanged.map(
          (tc) =>
            `Type change on ${name}.${tc.field.physicalName} ` +
            `(${tc.existingType} → ${tc.field.designType}). ` +
            `Add @db.sync.method "recreate" or "drop", or migrate manually.`,
        ),
      ];
    }
  }

  /**
   * Computes table option diff using DB-first introspection with snapshot fallback.
   * Returns null if the adapter has no table options.
   */
  private async diffTableOptions(readable: AtscriptDbReadable): Promise<TTableOptionDiff | null> {
    const adapter = readable.dbAdapter;
    const desired = adapter.getDesiredTableOptions?.();
    if (!desired || desired.length === 0) {
      return null;
    }

    let existing: TExistingTableOption[];

    if (adapter.getExistingTableOptions) {
      // Primary: live introspection from DB
      existing = await adapter.getExistingTableOptions();
    } else {
      // Fallback: stored snapshot
      const snapshot = await this.store.readTableSnapshot(readable.tableName);
      existing = snapshot ? snapshotToExistingTableOptions(snapshot as TTableSnapshot) : [];
    }

    if (existing.length === 0) {
      return null;
    }

    const destructiveKeys = adapter.destructiveOptionKeys?.();
    return computeTableOptionDiff(desired, existing, destructiveKeys);
  }

  // ── Plan view ───────────────────────────────────────────────────────

  private async planView(view: AtscriptDbView, trackedNames: Set<string>): Promise<SyncEntry> {
    const viewType = view.viewPlan.materialized ? ("M" as const) : ("V" as const);
    const renamedFrom = view.renamedFrom;
    const isRenamed = renamedFrom && trackedNames.has(renamedFrom);
    let status: TSyncEntryStatus;

    if (isRenamed) {
      status = "alter";
    } else if (trackedNames.has(view.tableName)) {
      status = (await viewDefinitionChanged(view, this.store)) ? "alter" : "in-sync";
    } else {
      status = "create";
    }

    return new SyncEntry({
      name: view.tableName,
      status,
      viewType,
      renamedFrom: isRenamed ? renamedFrom : undefined,
      recreated: status === "alter" && !isRenamed ? true : undefined,
    });
  }

  // ── Executor deps ──────────────────────────────────────────────────

  private buildExecutorDeps(): TSyncExecutorDeps {
    return {
      store: this.store,
      space: this.space,
      logger: this.logger,
      resolveTypeMapper: this.resolveTypeMapper.bind(this),
      diffTableOptions: this.diffTableOptions.bind(this),
    };
  }
}
