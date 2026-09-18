import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { AtscriptDbView } from "../table/db-view";
import type { AtscriptDbReadable } from "../table/db-readable";
import type { BaseDbAdapter } from "../base-adapter";
import type { DbSpace } from "../table/db-space";
import type { TGenericLogger } from "../logger";
import { NoopLogger } from "../logger";
import type {
  TColumnDiff,
  TDbFieldMeta,
  TDbObjectKind,
  TExistingColumn,
  TExistingTableOption,
  TReferencingForeignKey,
  TTableOptionDiff,
} from "../types";
import {
  computeTableSnapshot,
  computeViewSnapshot,
  computeSchemaHash,
  snapshotToExistingColumns,
  snapshotToExistingTableOptions,
} from "./schema-hash";
import type { TTableSnapshot, TViewSnapshot } from "./schema-hash";
import { computeColumnDiff } from "./column-diff";
import { computeForeignKeyDiff, hasForeignKeyChanges, fkKey } from "./fk-diff";
import { computeTableOptionDiff } from "./table-option-diff";
import { topoOrder, reachable, type TDependencyEdge } from "./dependency-order";
import { SyncStore } from "./sync-store";
import { SyncEntry, type TSyncEntryInit, type TSyncSkippedWork } from "./sync-entry";
import {
  executeSyncTable,
  executeSyncView,
  executeDeferredForeignKeys,
  planViewSync,
  dropOutdatedView,
  viewPlanStatus,
  willDropRecreate,
  safeModeSkips,
  describeTypeChanges,
  describeNullableDefaults,
  type TSyncExecutorDeps,
  type TTableFacts,
  type TViewSyncPlan,
} from "./sync-executor";

export {
  SyncEntry,
  type TSyncEntryInit,
  type TSyncColors,
  type TSyncEntryStatus,
  type TSyncSkippedWork,
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
  /**
   * Safe mode — skip destructive operations (column/table drops, `'drop'`
   * recreates, destructive table-option recreates, key rebuilds, nullable /
   * default DDL). Skipped work is pending (`entry.skipped`): the table's
   * snapshot and the hash are withheld until a run without `safe` applies
   * it. Default: false.
   */
  safe?: boolean;
  /**
   * Logger for sync progress and failures (index/FK DDL errors are logged,
   * not thrown). Default: NoopLogger — pass `console` to surface them.
   */
  logger?: TGenericLogger;
  /**
   * What to do when the run finishes with errored entries (failed index/FK
   * DDL, external-view checks, pre-flight refusals, …):
   * - `"warn"` (default) — emit a one-line summary plus per-entry error lines
   *   via the configured logger, **falling back to `console` when no logger
   *   is set** (errors are never silently swallowed by the NoopLogger default);
   * - `"throw"` — same reporting, then throw after snapshots/locks are handled;
   * - `"silent"` — legacy behavior: outcome is only observable on the result.
   */
  onError?: "throw" | "warn" | "silent";
}

export interface TSyncResult {
  /**
   * - `"up-to-date"` — stored hash matches, nothing ran;
   * - `"synced"` — the run executed (inspect `entries` for per-table status);
   * - `"synced-by-peer"` — another pod synced while this one waited for the lock;
   * - `"refused"` (since 0.1.128) — pre-flight found a change that cannot be
   *   applied safely: NO DDL ran, tracking/snapshots/hash are untouched, the
   *   lock is released. `entries` is the full plan with the refused entries
   *   as `error` entries (`refused: true`).
   */
  status: "up-to-date" | "synced" | "synced-by-peer" | "refused";
  schemaHash: string;
  entries: SyncEntry[];
}

// ── Internal discovery types ──────────────────────────────────────────────

type TTrackedEntry = { name: string; isView: boolean; viewType?: "V" | "M" | "E" };

/** The inventory after `resolveAndHash`: categorised readables + schema hash. */
interface TResolvedInventory {
  tables: AtscriptDbReadable[];
  views: AtscriptDbView[];
  externalViews: AtscriptDbView[];
  hash: string;
}

/** A tracked entry that is no longer in the inventory. */
interface TRemovedFacts extends TTrackedEntry {
  /** Live inbound FKs (tables only) — probed only when ≥ 2 tables are removed. */
  inbound?: TReferencingForeignKey[];
  snapshot: TTableSnapshot | TViewSnapshot | null;
}

interface TDiscovery {
  tables: TTableFacts[];
  tableByName: ReadonlyMap<string, TTableFacts>;
  /** Keyed by the name the table has in the database right now. */
  tableByDbName: ReadonlyMap<string, TTableFacts>;
  views: AtscriptDbView[];
  externalViews: AtscriptDbView[];
  allReadables: AtscriptDbReadable[];
  hash: string;
  trackedNames: Set<string>;
  viewPlans: Map<string, TViewSyncPlan>;
  /** Parallel to `views`. */
  viewEntries: SyncEntry[];
  /** Physical object kind under each managed view's name. */
  viewObjectKinds: Map<string, TDbObjectKind | undefined>;
  externalEntries: SyncEntry[];
  removed: TRemovedFacts[];
  removedByName: ReadonlyMap<string, TRemovedFacts>;
  /** Every removed table — a live FK from inside the set never blocks a drop. */
  removedTableSet: ReadonlySet<string>;
  /**
   * Drop entries in execution order (views first, then tables children-first,
   * cycles as groups) — `plan()` reports them, `execute()` reuses them.
   */
  dropEntries: ReadonlyMap<string, SyncEntry>;
  /** Desired tables, parents first (SCC groups). */
  createOrder: string[][];
  /**
   * Removed-table groups (children first, cycles as one group) dropped right
   * before the inventory table they block — one whose execution drops its
   * physical table (`dropsTable`) while a removed table still references it —
   * keyed by that table. Each group is assigned once, to the first such table
   * in `createOrder`. Empty in safe mode (nothing is dropped).
   */
  earlyDrops: ReadonlyMap<string, string[][]>;
  /** The remaining removed-table groups, children first, dropped after the views. */
  lateDropOrder: string[][];
  /** FK parents of each table, plus the tables dropped right before it. */
  tableDependsOn: Map<string, string[]>;
  /** FK targets outside the inventory → present in the DB? (`undefined` = not checkable). */
  externalTargets: Map<string, boolean | undefined>;
}

/**
 * One step of the ordering walk `plan()` and `run()` share: entries are
 * reported in exactly this order, and `run()` executes in it.
 */
type TOrderedStep =
  /** A removed-table group — early (right before the table it blocks) or late. */
  | { kind: "drop"; group: string[] }
  | { kind: "table"; name: string; cycle?: Set<string> }
  /** Every table exists now — cycle members add their deferred FKs. */
  | { kind: "deferred-fks" }
  | { kind: "view"; index: number }
  | { kind: "external"; index: number }
  | { kind: "drop-view"; name: string };

/** Run state `dropRemovedGroup` shares between early and late drops. */
interface TDropGroupContext {
  d: TDiscovery;
  /** Removed entries that were NOT dropped — they stay tracked (I2). */
  retained: TTrackedEntry[];
  droppedNames: Set<string>;
}

/** Keeps a removed-table group tracked (safe mode, blocked or failed drop). */
function retain(group: string[], ctx: Pick<TDropGroupContext, "d" | "retained">): void {
  ctx.retained.push(...group.map((name) => ctx.d.removedByName.get(name)!));
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

function pkLabel(change: { from: string[]; to: string[] }): string {
  return `(${change.from.join(", ")} → ${change.to.join(", ")})`;
}

function sortedUnique(names: Iterable<string>): string[] {
  return [...new Set(names)].toSorted();
}

/** Adds `msg` to the refusal list of `name`. */
function addRefusal(refusals: Map<string, string[]>, name: string, msg: string): void {
  const list = refusals.get(name);
  if (list) {
    list.push(msg);
  } else {
    refusals.set(name, [msg]);
  }
}

/** The entry with the refusal texts folded in as a refused `error` entry. */
function withRefusals(init: TSyncEntryInit, msgs: string[] | undefined): SyncEntry {
  if (!msgs || msgs.length === 0) {
    return new SyncEntry(init);
  }
  return new SyncEntry({
    ...init,
    status: "error",
    errors: [...(init.errors ?? []), ...msgs],
    refused: true,
  });
}

/** Human label of each kind of skipped work, for the safe-mode warning. */
const SKIPPED_LABELS: Record<TSyncSkippedWork, string> = {
  "pk-rebuild": "primary-key rebuild",
  recreate: "drop-and-recreate",
  "table-options": "table-option recreate",
  "nullable-defaults": "nullable/default change",
};

/**
 * The removed tables whose drop must precede `t`'s own drop/rebuild: those
 * with a live FK to `t` (its probed inbound FKs; when the adapter cannot
 * probe them, the removed tables' stored snapshots — the same fallback as
 * the drop graph), closed over the removed-table graph (child → parent) so
 * a referencer's own removed children come first.
 */
function removedBlockers(
  t: TTableFacts,
  removedTables: TRemovedFacts[],
  removedTableSet: ReadonlySet<string>,
  dropEdges: TDependencyEdge[],
): Set<string> {
  const direct: string[] = [];
  if (t.inboundFks) {
    for (const fk of t.inboundFks) {
      if (removedTableSet.has(fk.table)) {
        direct.push(fk.table);
      }
    }
  } else {
    for (const r of removedTables) {
      if (
        r.snapshot &&
        "foreignKeys" in r.snapshot &&
        r.snapshot.foreignKeys.some((fk) => fk.targetTable === t.dbName)
      ) {
        direct.push(r.name);
      }
    }
  }
  return reachable(direct, dropEdges);
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
  private async resolveAndHash(
    types: readonly TAtscriptAnnotatedType[],
  ): Promise<TResolvedInventory> {
    const tables: AtscriptDbReadable[] = [];
    const views: AtscriptDbView[] = [];
    const externalViews: AtscriptDbView[] = [];
    for (const type of types) {
      const readable = this.space.get(type);
      if (readable.isView) {
        const view = readable as AtscriptDbView;
        if (view.isExternal) {
          externalViews.push(view);
        } else {
          views.push(view);
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
   * Detects tables/views present in the previous sync but absent from the
   * current schema (external views excluded — sync owns no DDL for them).
   */
  private detectRemoved(
    currentReadables: AtscriptDbReadable[],
    previous: TTrackedEntry[],
  ): TTrackedEntry[] {
    const currentSet = new Set(currentReadables.map((t) => t.tableName));
    // Build set of old names that are being renamed (not dropped)
    const renameFromSet = new Set(currentReadables.map((r) => r.renamedFrom).filter(Boolean));
    return previous.filter(
      (entry) =>
        !currentSet.has(entry.name) && !renameFromSet.has(entry.name) && entry.viewType !== "E",
    );
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
   * Runs schema synchronization with distributed locking, in three phases:
   *
   * 1. **Discover** (read-only, under the lock): introspect every table once,
   *    diff columns/FKs, read tracking, build the dependency graph.
   * 2. **Pre-flight** (pure): every change that no order of DDL can apply
   *    safely becomes a refusal. One refusal → `status: "refused"`, no DDL,
   *    nothing persisted, lock released.
   * 3. **Execute** in dependency order: stale/removed views → inbound FKs of
   *    key-changing tables → tables (parents first; a removed table that
   *    blocks a table's drop-and-recreate or key rebuild is dropped right
   *    before it) → deferred FKs of cycles → managed views → external-view
   *    checks → remaining removed tables (children first) →
   *    snapshots/tracking/hash.
   */
  async run(types: readonly TAtscriptAnnotatedType[], opts?: TSyncOptions): Promise<TSyncResult> {
    this.logger = opts?.logger ?? this.logger;
    const podId = opts?.podId ?? crypto.randomUUID();
    const lockTtlMs = opts?.lockTtlMs ?? 30_000;
    const waitTimeoutMs = opts?.waitTimeoutMs ?? 60_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 500;
    const force = opts?.force ?? false;
    const safe = opts?.safe ?? false;
    const onError = opts?.onError ?? "warn";

    const resolved = await this.resolveAndHash(types);
    const { hash } = resolved;

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

      // Phase 1 — discover (no DDL on managed tables/views)
      const d = await this.discover(resolved, safe);
      this.assertLockHeld(heartbeat.getAbortReason);

      // Phase 2 — pre-flight
      const refusals = this.preflight(d, safe);
      if (refusals.size > 0) {
        const result: TSyncResult = {
          status: "refused",
          schemaHash: hash,
          entries: this.buildPlanEntries(d, safe, refusals),
        };
        this.reportOutcome(result, onError);
        return result;
      }

      // Phase 3 — execute
      const result = await this.execute(d, safe, heartbeat.getAbortReason);
      this.reportOutcome(result, onError);
      return result;
    } finally {
      heartbeat.stop();
      await this.store.releaseLock(podId);
    }
  }

  // ── Phase 1: discovery ─────────────────────────────────────────────────

  private async discover(resolved: TResolvedInventory, safe: boolean): Promise<TDiscovery> {
    const { tables, views, externalViews, hash } = resolved;
    const allReadables = [...tables, ...views, ...externalViews];
    const previouslyTracked = await this.store.readTrackedList();
    const trackedNames = new Set(previouslyTracked.map((e) => e.name));
    const removedTracked = this.detectRemoved(allReadables, previouslyTracked);
    // A drop-and-recreate's inbound FKs matter only when a removed table
    // could block it (safe mode drops nothing early); a key rebuild's are
    // always probed (pre-flight checks retargeting).
    const probeRecreateInbound = !safe && removedTracked.some((r) => !r.isView);

    // Every read below is pure introspection — each phase runs in parallel,
    // results keep inventory order.
    const tableFacts = await Promise.all(
      tables.map((r) => this.discoverTable(r, trackedNames, probeRecreateInbound)),
    );
    const tableNames = new Set(tableFacts.map((t) => t.name));
    const tableByName = new Map(tableFacts.map((t) => [t.name, t]));
    const tableByDbName = new Map(tableFacts.map((t) => [t.dbName, t]));

    // Managed views — plan + object kind under the name they will have
    const viewFacts = await Promise.all(
      views.map(async (view) => ({
        plan: await planViewSync(view, trackedNames, this.store),
        kind: await view.dbAdapter.getObjectKind?.(view.tableName),
      })),
    );
    const viewPlans = new Map<string, TViewSyncPlan>();
    const viewEntries: SyncEntry[] = [];
    const viewObjectKinds = new Map<string, TDbObjectKind | undefined>();
    for (const [i, view] of views.entries()) {
      const { plan, kind } = viewFacts[i];
      viewPlans.set(view.tableName, plan);
      viewObjectKinds.set(view.tableName, kind);
      viewEntries.push(
        new SyncEntry({
          name: view.tableName,
          status: viewPlanStatus(view, plan, trackedNames),
          viewType: view.viewPlan.materialized ? "M" : "V",
          renamedFrom: plan.isRenamed ? view.renamedFrom : undefined,
          recreated: plan.definitionChanged || undefined,
          dependsOn: sortedUnique(
            [view.viewPlan.entryTable, ...view.viewPlan.joins.map((j) => j.targetTable)].filter(
              (n) => tableNames.has(n),
            ),
          ),
        }),
      );
    }

    // External views — advisory check only
    const externalEntries = await Promise.all(externalViews.map((v) => this.checkExternalView(v)));

    // Removed entries — live inbound FKs only when there is an order to
    // compute (≥ 2 removed tables); the stored snapshot is the fallback.
    // (`execute()` re-probes each table right before dropping it anyway.)
    const probeInbound = !safe && removedTracked.filter((r) => !r.isView).length >= 2;
    const removed: TRemovedFacts[] = await Promise.all(
      removedTracked.map(async (entry) => ({
        ...entry,
        snapshot: await this.store.readTableSnapshot(entry.name),
        inbound:
          probeInbound && !entry.isView
            ? await this.space.getReferencingForeignKeys(entry.name)
            : undefined,
      })),
    );
    const removedByName = new Map(removed.map((r) => [r.name, r]));

    // FK targets outside the inventory — do they exist in the database?
    const externalTargetAdapters = new Map<string, BaseDbAdapter>();
    for (const t of tableFacts) {
      for (const fk of t.readable.foreignKeys.values()) {
        if (fk.targetTable !== t.name && !tableNames.has(fk.targetTable)) {
          externalTargetAdapters.set(fk.targetTable, t.readable.dbAdapter);
        }
      }
    }
    const externalTargets = new Map(
      await Promise.all(
        [...externalTargetAdapters].map(
          async ([target, adapter]) => [target, await this.objectPresent(adapter, target)] as const,
        ),
      ),
    );

    // Dependency graph — desired tables (child → parent)
    const createEdges: TDependencyEdge[] = [];
    const tableDependsOn = new Map<string, string[]>();
    for (const t of tableFacts) {
      const parents = new Set<string>();
      for (const fk of t.readable.foreignKeys.values()) {
        if (fk.targetTable !== t.name && tableNames.has(fk.targetTable)) {
          createEdges.push([t.name, fk.targetTable]);
          parents.add(fk.targetTable);
        }
      }
      tableDependsOn.set(t.name, sortedUnique(parents));
    }
    const createOrder = topoOrder(tableNames, createEdges);

    // Dependency graph — removed tables (child → parent), dropped children first
    const removedTables = removed.filter((r) => !r.isView);
    const removedTableSet = new Set(removedTables.map((r) => r.name));
    const dropEdges: TDependencyEdge[] = [];
    for (const r of removedTables) {
      if (r.inbound) {
        for (const fk of r.inbound) {
          if (fk.table !== r.name && removedTableSet.has(fk.table)) {
            dropEdges.push([fk.table, r.name]);
          }
        }
      } else if (r.snapshot && "foreignKeys" in r.snapshot) {
        for (const fk of r.snapshot.foreignKeys) {
          if (fk.targetTable !== r.name && removedTableSet.has(fk.targetTable)) {
            dropEdges.push([r.name, fk.targetTable]);
          }
        }
      }
    }
    const dropOrder = topoOrder(removedTableSet, dropEdges).toReversed();

    // A table the run drops never blocks an operation it depends on: the
    // removed tables that reference a table whose execution drops its
    // physical table (`dropsTable`) — directly, or through other removed
    // tables — are dropped right before it. Safe mode drops nothing, so
    // nothing moves.
    const earlyDrops = new Map<string, string[][]>();
    const earlyGroups = new Set<string[]>();
    if (!safe) {
      for (const name of createOrder.flat()) {
        const t = tableByName.get(name)!;
        if (!t.dropsTable) {
          continue;
        }
        const blockers = removedBlockers(t, removedTables, removedTableSet, dropEdges);
        const groups = dropOrder.filter(
          (group) => !earlyGroups.has(group) && group.some((n) => blockers.has(n)),
        );
        if (groups.length === 0) {
          continue;
        }
        for (const group of groups) {
          earlyGroups.add(group);
        }
        earlyDrops.set(name, groups);
        tableDependsOn.set(name, sortedUnique([...tableDependsOn.get(name)!, ...groups.flat()]));
      }
    }
    const lateDropOrder = dropOrder.filter((group) => !earlyGroups.has(group));

    // Drop entries: views first, then tables children-first (cycles as groups)
    const dropEntries = new Map<string, SyncEntry>();
    for (const r of removed) {
      if (r.isView) {
        dropEntries.set(
          r.name,
          new SyncEntry({ name: r.name, viewType: r.viewType, status: "drop" }),
        );
      }
    }
    for (const group of dropOrder) {
      for (const name of group) {
        dropEntries.set(
          name,
          new SyncEntry({
            name,
            status: "drop",
            dependsOn: sortedUnique(
              dropEdges.filter(([, to]) => to === name).map(([from]) => from),
            ),
            dropGroup: group.length > 1 ? group : undefined,
          }),
        );
      }
    }

    return {
      tables: tableFacts,
      tableByName,
      tableByDbName,
      views,
      externalViews,
      allReadables,
      hash,
      trackedNames,
      viewPlans,
      viewEntries,
      viewObjectKinds,
      externalEntries,
      removed,
      removedByName,
      removedTableSet,
      dropEntries,
      createOrder,
      earlyDrops,
      lateDropOrder,
      tableDependsOn,
      externalTargets,
    };
  }

  /** Whether an object named `name` exists, or `undefined` when the adapter cannot tell. */
  private async objectPresent(adapter: BaseDbAdapter, name: string): Promise<boolean | undefined> {
    return adapter.getObjectKind ? (await adapter.getObjectKind(name)) !== undefined : undefined;
  }

  /**
   * Introspects one desired table and computes its plan entry.
   * `probeRecreateInbound` — whether a drop-and-recreate's live inbound FKs
   * are worth probing (a removed table exists that could block it).
   */
  private async discoverTable(
    readable: AtscriptDbReadable,
    trackedNames: Set<string>,
    probeRecreateInbound: boolean,
  ): Promise<TTableFacts> {
    const adapter = readable.dbAdapter;
    const name = readable.tableName;
    const init: TSyncEntryInit = {
      name,
      status: "in-sync",
      syncMethod: readable.syncMethod,
    };

    // Detect pending rename
    const renamedFrom = readable.renamedFrom;
    const pendingRename = renamedFrom && trackedNames.has(renamedFrom) ? renamedFrom : undefined;
    if (pendingRename) {
      init.renamedFrom = pendingRename;
      init.status = "alter";
    }
    const dbName = pendingRename ?? name;

    // Read stored snapshot once — used by Path B column diff and FK diff
    const storedSnapshot = await this.store.readTableSnapshot(dbName);
    const facts: TTableFacts = {
      readable,
      name,
      pendingRename,
      dbName,
      storedSnapshot,
      fkDiff: storedSnapshot
        ? computeForeignKeyDiff(readable.foreignKeys, storedSnapshot.foreignKeys)
        : undefined,
      dropsTable: false,
      planEntry: init,
    };

    if (adapter.getExistingColumns) {
      // Path A: Live introspection (SQLite, MySQL, PostgreSQL)
      const liveColumns: TExistingColumn[] | undefined = pendingRename
        ? adapter.getExistingColumnsForTable
          ? await adapter.getExistingColumnsForTable(pendingRename)
          : undefined
        : await adapter.getExistingColumns();
      // Tracked under the old name but not visible there — leave it to the
      // executor to introspect after the rename rather than cache "empty".
      facts.existing = pendingRename && liveColumns?.length === 0 ? undefined : liveColumns;
      if (facts.existing && facts.existing.length === 0) {
        init.status = "create";
        init.columnsToAdd = readable.fieldDescriptors.filter((f) => !f.ignored);
      } else if (facts.existing && facts.existing.length > 0) {
        const typeMapper = adapter.typeMapper?.bind(adapter);
        facts.diff = computeColumnDiff(readable.fieldDescriptors, facts.existing, typeMapper);
        this.populatePlanFromDiff(
          facts.diff,
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
        facts.diff = computeColumnDiff(
          readable.fieldDescriptors,
          existing,
          this.resolveTypeMapper(adapter),
        );
        this.populatePlanFromDiff(
          facts.diff,
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

    // Detect table option drift (e.g. MySQL engine/charset, MongoDB capped) —
    // diffed once, under the table's current name (the old name of a pending
    // rename, as the columns above); the executor applies this diff.
    if (init.status !== "create") {
      facts.optionDiff = await this.diffTableOptions(readable, pendingRename);
      const optionDiff = facts.optionDiff;
      // An error entry issues no DDL (the executor skips its option block and
      // returns before FK sync), so the plan reports no option or FK work on
      // it either — the facts stay for pre-flight.
      if (init.status !== "error" && optionDiff && optionDiff.changed.length > 0) {
        init.status = "alter";
        init.optionChanges = optionDiff.changed;
        if (optionDiff.changed.some((c) => c.destructive)) {
          init.recreated = true;
        }
      }
    }

    // Detect FK changes
    if (
      init.status !== "create" &&
      init.status !== "error" &&
      facts.fkDiff &&
      hasForeignKeyChanges(facts.fkDiff)
    ) {
      const fkDiff = facts.fkDiff;
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

    // Primary-key change — the facts pre-flight needs (probed only when it
    // matters). `hasRows` answers for the OLD name of a pending rename; the
    // base default cannot, and says so with `undefined`.
    if (facts.diff?.primaryKeyChanged) {
      facts.populated = (await adapter.hasRows(pendingRename ? dbName : undefined)) ?? "unknown";
    }
    // Live inbound FKs — whenever the run drops the physical table (key
    // rebuild or drop-and-recreate): pre-flight checks retargeting, and the
    // removed tables among the referencers are dropped first.
    facts.dropsTable =
      !!facts.diff?.primaryKeyChanged || willDropRecreate(readable, facts.diff, facts.optionDiff);
    if (facts.diff?.primaryKeyChanged || (probeRecreateInbound && facts.dropsTable)) {
      facts.inboundFks = await adapter.getReferencingForeignKeys?.(dbName);
    }

    // Object kind under the table's current name (view where a table is
    // declared?). Probed even when no columns came back: PostgreSQL's
    // information_schema.columns omits materialized views, so an empty
    // column list does not prove that nothing sits under the name.
    if (adapter.getObjectKind) {
      facts.objectKind = await adapter.getObjectKind(dbName);
    }

    return facts;
  }

  // ── Phase 2: pre-flight ────────────────────────────────────────────────

  /**
   * Pure validation over the discovery facts. Every refusal is a change that
   * no order of DDL can apply safely; the messages are user-facing.
   */
  private preflight(d: TDiscovery, safe: boolean): Map<string, string[]> {
    const refusals = new Map<string, string[]>();

    for (const t of d.tables) {
      // A view sits where a table is declared
      if (t.objectKind === "view" || t.objectKind === "materialized") {
        addRefusal(
          refusals,
          t.name,
          `A view "${t.dbName}" exists where table "${t.name}" is declared — drop or rename it`,
        );
      }

      const pk = t.diff?.primaryKeyChanged;
      if (pk) {
        const label = pkLabel(pk);
        // Populated table — refused in both modes
        if (t.populated === true) {
          addRefusal(
            refusals,
            t.name,
            `Primary key of "${t.name}" changed ${label} but the table has rows; schema sync cannot rebuild a populated primary key. Migrate manually (or empty the table) and re-run.`,
          );
        } else if (t.populated === "unknown") {
          addRefusal(
            refusals,
            t.name,
            `Primary key of "${t.name}" changed ${label} but the adapter cannot tell whether the table has rows under its old name "${t.dbName}" — implement hasRows(tableName) on the adapter, or rename the table in a separate run first.`,
          );
        }
        // Safe mode skips the rebuild itself, so the rebuild-time rules do not apply
        if (!safe) {
          // Every live inbound FK must be retargeted to the new key in this
          // run — except one from a removed table, dropped right before the
          // rebuild (`earlyDrops`).
          for (const fk of t.inboundFks ?? []) {
            const removed = d.removedByName.get(fk.table);
            if (removed && !removed.isView) {
              continue;
            }
            const child = d.tableByDbName.get(fk.table);
            if (child?.pendingRename) {
              // The child's adapter resolves its NEW name, so its old
              // constraint could not be dropped before the swap.
              addRefusal(
                refusals,
                t.name,
                `Primary key of "${t.name}" changed ${label} but the referencing table "${child.name}" is renamed in the same run (from "${child.pendingRename}") — rename it in a separate run first, then retarget the foreign key and re-run.`,
              );
              continue;
            }
            const retargeted =
              child !== undefined &&
              [...child.readable.foreignKeys.values()].some(
                (desired) =>
                  desired.targetTable === t.name &&
                  fkKey(desired.fields) === fkKey(fk.fields) &&
                  fkKey(desired.targetFields) === fkKey(pk.to),
              );
            if (!retargeted) {
              addRefusal(
                refusals,
                t.name,
                `Primary key of "${t.name}" changed ${label} but "${fk.table}.${fk.fields.join(",")}" still references the old key — retarget the foreign key (or migrate manually) and re-run.`,
              );
            }
          }
          // An auto-increment column must stay in the key
          for (const f of t.readable.fieldDescriptors) {
            if (
              !f.ignored &&
              !f.isPrimaryKey &&
              f.defaultValue?.kind === "fn" &&
              f.defaultValue.fn === "increment"
            ) {
              addRefusal(
                refusals,
                t.name,
                `"${t.name}.${f.physicalName}" is auto-increment but no longer part of the primary key; auto-increment columns must be primary-key columns.`,
              );
            }
          }
        }
      }

      // FK to a target that is neither in the inventory nor in the database
      for (const fk of t.readable.foreignKeys.values()) {
        if (fk.targetTable === t.name || d.tableByName.has(fk.targetTable)) {
          continue;
        }
        if (d.externalTargets.get(fk.targetTable) === false) {
          addRefusal(
            refusals,
            t.name,
            `FK ${t.name}.${fk.fields.join(",")} references "${fk.targetTable}" which is neither in the sync inventory nor present in the database`,
          );
        }
      }
    }

    // A physical table sits where a managed view is declared
    for (const view of d.views) {
      if (d.viewObjectKinds.get(view.tableName) === "table") {
        addRefusal(
          refusals,
          view.tableName,
          `A physical table "${view.tableName}" exists where managed view "${view.tableName}" is declared — drop or rename it`,
        );
      }
    }

    // A removed table still referenced by the inventory (no drops in safe mode)
    if (!safe) {
      for (const r of d.removed) {
        if (r.isView) {
          continue;
        }
        const referencers: string[] = [];
        for (const t of d.tables) {
          for (const fk of t.readable.foreignKeys.values()) {
            if (fk.targetTable === r.name) {
              referencers.push(`${t.name}.${fk.fields.join(",")} (@db.rel.FK)`);
            }
          }
        }
        for (const view of d.views) {
          const plan = view.viewPlan;
          if (plan.entryTable === r.name || plan.joins.some((j) => j.targetTable === r.name)) {
            referencers.push(`view "${view.tableName}"`);
          }
        }
        if (referencers.length > 0) {
          addRefusal(
            refusals,
            r.name,
            `Cannot drop "${r.name}": it is still referenced by ${referencers.join(", ")}. Add "${r.name}" to the sync inventory or remove the reference.`,
          );
        }
      }
    }

    return refusals;
  }

  // ── Ordering walk (shared by plan and execute) ─────────────────────────

  /**
   * The one ordering walk `plan()` and `run()` share: tables parents-first,
   * each preceded by the removed tables that block its drop/rebuild; the
   * deferred FK pass; managed views; external-view checks; removed views;
   * the remaining removed tables children-first.
   */
  private *orderedSteps(d: TDiscovery): Generator<TOrderedStep> {
    for (const group of d.createOrder) {
      const cycle = group.length > 1 ? new Set(group) : undefined;
      for (const name of group) {
        for (const early of d.earlyDrops.get(name) ?? []) {
          yield { kind: "drop", group: early };
        }
        yield { kind: "table", name, cycle };
      }
    }
    yield { kind: "deferred-fks" };
    for (const [index] of d.views.entries()) {
      yield { kind: "view", index };
    }
    for (const [index] of d.externalEntries.entries()) {
      yield { kind: "external", index };
    }
    for (const r of d.removed) {
      if (r.isView) {
        yield { kind: "drop-view", name: r.name };
      }
    }
    for (const group of d.lateDropOrder) {
      yield { kind: "drop", group };
    }
  }

  /** The plan entries in execution order, refusals folded in as `error` entries. */
  private buildPlanEntries(
    d: TDiscovery,
    safe: boolean,
    refusals: Map<string, string[]>,
  ): SyncEntry[] {
    const refused = (e: SyncEntry): SyncEntry =>
      refusals.has(e.name) ? withRefusals(e.toInit(), refusals.get(e.name)) : e;
    const entries: SyncEntry[] = [];

    for (const step of this.orderedSteps(d)) {
      switch (step.kind) {
        case "drop": {
          if (!safe) {
            entries.push(...step.group.map((name) => refused(d.dropEntries.get(name)!)));
          }
          break;
        }
        case "table": {
          const t = d.tableByName.get(step.name)!;
          let init: TSyncEntryInit = { ...t.planEntry, dependsOn: d.tableDependsOn.get(step.name) };
          // Safe mode skips work — reported exactly as `run({ safe })` reports it
          const skipped = safe ? safeModeSkips(t) : [];
          const pk = t.diff?.primaryKeyChanged;
          if (pk) {
            init.pkChange = { from: pk.from, to: pk.to, rebuild: !skipped.includes("pk-rebuild") };
          }
          if (safe) {
            // Hide destructive operations in safe mode — except the skipped
            // ones, which are pending and shown as skipped
            init = {
              ...init,
              columnsToDrop: [],
              typeChanges: skipped.includes("recreate") ? init.typeChanges : [],
              skipped: skipped.length > 0 ? skipped : undefined,
              recreated: false,
            };
          }
          entries.push(withRefusals(init, refusals.get(step.name)));
          break;
        }
        case "deferred-fks": {
          break;
        }
        case "view": {
          entries.push(refused(d.viewEntries[step.index]));
          break;
        }
        case "external": {
          entries.push(d.externalEntries[step.index]);
          break;
        }
        case "drop-view": {
          if (!safe) {
            entries.push(refused(d.dropEntries.get(step.name)!));
          }
          break;
        }
      }
    }
    return entries;
  }

  // ── Phase 3: execute ───────────────────────────────────────────────────

  private async execute(
    d: TDiscovery,
    safe: boolean,
    getAbortReason: () => string | undefined,
  ): Promise<TSyncResult> {
    const { hash, allReadables } = d;
    const deps = this.buildExecutorDeps();
    const entries: SyncEntry[] = [];
    /** Removed entries that were NOT dropped — they stay tracked (I2). */
    const retained: TTrackedEntry[] = [];
    const droppedNames = new Set<string>();

    // 1. Drop tracked views whose definition changed (or that are being
    //    renamed) and removed views BEFORE table ops — their old definitions
    //    may reference columns the table sync is about to drop (SQLite and
    //    Postgres refuse DROP COLUMN while a view depends on the column).
    //    Removed-view outcomes are reported at their place in the walk.
    for (const view of d.views) {
      await dropOutdatedView(view, d.viewPlans.get(view.tableName)!, this.space);
    }
    const droppedViewEntries = new Map<string, SyncEntry>();
    for (const r of d.removed) {
      if (!r.isView) {
        continue;
      }
      if (safe) {
        retained.push(r);
        continue;
      }
      try {
        await this.space.dropViewByName(r.name);
        droppedViewEntries.set(r.name, d.dropEntries.get(r.name)!);
        droppedNames.add(r.name);
      } catch (error) {
        const msg = `Drop of view "${r.name}" failed: ${(error as Error).message}`;
        this.logger.error?.(`[schema-sync] ${msg}`);
        droppedViewEntries.set(
          r.name,
          new SyncEntry({ name: r.name, viewType: r.viewType, status: "error", errors: [msg] }),
        );
        retained.push(r);
      }
    }

    // 2. Live inbound FKs of key-changing tables: MySQL/PostgreSQL refuse to
    //    drop a key a constraint depends on. Pre-flight guaranteed every
    //    referencing child is in the inventory (under its live name) and
    //    retargets to the new key, and children run after parents — so their
    //    own `syncForeignKeys` re-adds the constraint.
    if (!safe) {
      for (const t of d.tables) {
        if (!t.diff?.primaryKeyChanged) {
          continue;
        }
        const keysByChild = new Map<string, string[]>();
        for (const fk of t.inboundFks ?? []) {
          keysByChild.set(fk.table, [...(keysByChild.get(fk.table) ?? []), fkKey(fk.fields)]);
        }
        for (const [childName, fkKeys] of keysByChild) {
          await d.tableByDbName.get(childName)?.readable.dbAdapter.dropForeignKeys?.(fkKeys);
        }
      }
    }

    // 3. The ordering walk shared with `plan()`: tables parents-first, each
    //    preceded by the removed tables that block its drop/rebuild (cycle
    //    members defer their FKs to the pass that follows the tables), then
    //    managed views (stale ones were dropped in step 1), the advisory
    //    external-view check, removed views, and the remaining removed
    //    tables children-first. Removed tables in safe mode are retained.
    const deferred: Array<{ readable: AtscriptDbReadable; index: number }> = [];
    const drops: TDropGroupContext = { d, retained, droppedNames };
    for (const step of this.orderedSteps(d)) {
      this.assertLockHeld(getAbortReason);
      switch (step.kind) {
        case "drop": {
          if (safe) {
            retain(step.group, drops);
          } else {
            entries.push(...(await this.dropRemovedGroup(step.group, drops)));
          }
          break;
        }
        case "table": {
          const t = d.tableByName.get(step.name)!;
          const entry = await executeSyncTable(t, safe, deps, {
            deferForeignKeysTo: step.cycle,
            dependsOn: d.tableDependsOn.get(step.name),
          });
          if (step.cycle) {
            deferred.push({ readable: t.readable, index: entries.length });
          }
          entries.push(entry);
          break;
        }
        case "deferred-fks": {
          for (const { readable, index } of deferred) {
            this.assertLockHeld(getAbortReason);
            entries[index] = await executeDeferredForeignKeys(readable, entries[index], deps);
          }
          break;
        }
        case "view": {
          entries.push(await executeSyncView(d.views[step.index], d.viewEntries[step.index]));
          break;
        }
        case "external": {
          entries.push(d.externalEntries[step.index]);
          break;
        }
        case "drop-view": {
          const entry = droppedViewEntries.get(step.name);
          if (entry) {
            entries.push(entry);
          }
          break;
        }
      }
    }
    if (safe && retained.length > 0) {
      this.logger.warn?.(
        `[schema-sync] Safe mode: ${retained.map((r) => `"${r.name}"`).join(", ")} no longer in the schema — kept (still tracked; dropped by the next run that executes)`,
      );
    }

    // 4. Store per-table snapshots — but never for a pending entry (desired
    //    work whose DDL was not issued): an error (the DB does not match the
    //    desired schema, and recording the desired snapshot would make the
    //    next run believe the failed DDL succeeded) or work safe mode skipped
    //    (same situation — and on snapshot-based adapters the desired
    //    snapshot would hide the pending change from every later run).
    //    External views are advisory (sync owns no DDL for them) and never
    //    pending, so a missing one does not block persistence or wedge re-runs.
    this.assertLockHeld(getAbortReason);
    for (const e of entries) {
      if (e.status !== "error" && e.skipped.length > 0) {
        const work = e.skipped.map((k) => SKIPPED_LABELS[k]).join(", ");
        this.logger.warn?.(
          `[schema-sync] Safe mode: "${e.name}" — ${work} skipped, snapshot and hash withheld; the next run without safe applies it`,
        );
      }
    }
    const pendingNames = new Set(entries.filter((e) => e.pending).map((e) => e.name));
    for (const readable of allReadables) {
      if (pendingNames.has(readable.tableName)) {
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

    // Clean up snapshots for dropped tables/views (retained ones keep theirs)
    for (const name of droppedNames) {
      await this.store.deleteTableSnapshot(name);
    }

    // Clean up old-name snapshots after renames
    for (const readable of allReadables) {
      if (readable.renamedFrom) {
        await this.store.deleteTableSnapshot(readable.renamedFrom);
      }
    }

    // Tracking = what sync believes exists: current readables + undropped removals
    await this.store.writeTrackedList(allReadables, retained);

    // Persist the schema hash only when nothing is pending — an error entry
    // or skipped work means the DB does not match the desired schema, and a
    // stored hash would make the next boot skip the retry as "up-to-date".
    // (Skipped DROPs differ: everything desired exists, the leftovers stay
    // tracked, and a safe boot must not re-plan forever.)
    if (pendingNames.size === 0) {
      await this.store.writeHash(hash);
    }

    return { status: "synced", schemaHash: hash, entries };
  }

  /**
   * Drops one removed-table group (a table, or a foreign-key cycle as one
   * operation) and returns its entries. A live inbound FK from outside the
   * removed set blocks the group — error entries, kept tracked — instead of
   * leaving a dangling constraint or cascading. The probe runs at execution
   * time, so an inventory child whose FK to the group was dropped earlier in
   * this run does not block it. Called from the walk for early groups (right
   * before the table they block) and late groups (after the views) alike.
   */
  private async dropRemovedGroup(group: string[], ctx: TDropGroupContext): Promise<SyncEntry[]> {
    const { d, droppedNames } = ctx;
    const dropGroup = group.length > 1 ? group : undefined;
    const failed = (message: (name: string) => string): SyncEntry[] => {
      retain(group, ctx);
      return group.map((name) => {
        const msg = message(name);
        this.logger.error?.(`[schema-sync] ${msg}`);
        return new SyncEntry({ name, status: "error", errors: [msg], dropGroup });
      });
    };

    const inbounds = await Promise.all(
      group.map((name) => this.space.getReferencingForeignKeys(name)),
    );
    const blockers: string[] = [];
    for (const [i, name] of group.entries()) {
      for (const fk of inbounds[i] ?? []) {
        if (!d.removedTableSet.has(fk.table)) {
          blockers.push(`${fk.table}.${fk.fields.join(",")} → ${name}`);
        }
      }
    }
    if (blockers.length > 0) {
      return failed(
        (name) =>
          `Cannot drop "${name}": it is still referenced by ${blockers.join(", ")}. Drop the referencing constraint (or add the table back) and re-run.`,
      );
    }
    try {
      if (group.length === 1) {
        await this.space.dropTableByName(group[0]);
      } else {
        await this.space.dropTablesByName(group);
      }
    } catch (error) {
      return failed((name) => `Drop of "${name}" failed: ${(error as Error).message}`);
    }
    for (const name of group) {
      droppedNames.add(name);
    }
    return group.map((name) => d.dropEntries.get(name)!);
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
      (e) =>
        `[schema-sync] "${e.name}" ${e.refused ? "refused" : "failed"}: ${e.errors.join("; ") || e.status}`,
    );
    for (const line of lines) {
      out.error(line);
    }
    if (onError === "throw") {
      const verb = result.status === "refused" ? "refused" : "failed";
      throw new Error(
        `[schema-sync] ${errored.length} entr${errored.length === 1 ? "y" : "ies"} ${verb}:\n${lines.join("\n")}`,
      );
    }
  }

  /**
   * Computes a dry-run plan showing what `run()` would do, without executing
   * any DDL. Entries come back in execution order; pre-flight refusals appear
   * as `error` entries (`refused: true`) exactly as `run()` would report them.
   */
  async plan(
    types: readonly TAtscriptAnnotatedType[],
    opts?: Pick<TSyncOptions, "force" | "safe">,
  ): Promise<TSyncPlan> {
    const force = opts?.force ?? false;
    const safe = opts?.safe ?? false;
    const resolved = await this.resolveAndHash(types);
    const { hash } = resolved;

    await this.store.ensureControlTable();

    const d = await this.discover(resolved, safe);
    const refusals = this.preflight(d, safe);

    const entries = this.buildPlanEntries(d, safe, refusals);

    // Quick check — skip if hash matches
    if (!force) {
      const storedHash = await this.store.readHash();
      if (storedHash === hash) {
        return { status: "up-to-date", schemaHash: hash, entries };
      }
    }

    return { status: "changes-needed", schemaHash: hash, entries };
  }

  /** Fallback typeMapper for snapshot-based Path B: compares designType directly, skips unions. */
  private resolveTypeMapper(adapter: BaseDbAdapter): (f: TDbFieldMeta) => string {
    return (
      adapter.typeMapper?.bind(adapter) ??
      ((f: TDbFieldMeta) => (f.designType === "union" ? "union" : f.designType))
    );
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
    init.typeChanges = describeTypeChanges(diff);
    Object.assign(init, describeNullableDefaults(diff));
    init.columnsToDrop = diff.removed.map((c) => c.name);
    const hasChanges =
      diff.added.length > 0 ||
      diff.renamed.length > 0 ||
      diff.typeChanged.length > 0 ||
      diff.nullableChanged.length > 0 ||
      diff.defaultChanged.length > 0 ||
      diff.removed.length > 0 ||
      diff.primaryKeyChanged !== undefined;
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
   * Returns null if the adapter has no table options. `tableName` is the name
   * the table has in the database right now — the OLD name of a pending
   * `@db.table.renamed` (the adapter's bound name is the new one, which does
   * not exist yet); omitted for a table that is not being renamed.
   */
  private async diffTableOptions(
    readable: AtscriptDbReadable,
    tableName?: string,
  ): Promise<TTableOptionDiff | null> {
    const adapter = readable.dbAdapter;
    const desired = adapter.getDesiredTableOptions?.();
    if (!desired || desired.length === 0) {
      return null;
    }

    let existing: TExistingTableOption[];

    if (adapter.getExistingTableOptions) {
      // Primary: live introspection from DB
      existing = await adapter.getExistingTableOptions(tableName);
    } else {
      // Fallback: stored snapshot (tracked under the current name)
      const snapshot = await this.store.readTableSnapshot(tableName ?? readable.tableName);
      existing = snapshot ? snapshotToExistingTableOptions(snapshot as TTableSnapshot) : [];
    }

    if (existing.length === 0) {
      return null;
    }

    const destructiveKeys = adapter.destructiveOptionKeys?.();
    return computeTableOptionDiff(desired, existing, destructiveKeys);
  }

  // ── Executor deps ──────────────────────────────────────────────────

  private buildExecutorDeps(): TSyncExecutorDeps {
    return {
      logger: this.logger,
      resolveTypeMapper: this.resolveTypeMapper.bind(this),
    };
  }
}
