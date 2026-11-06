import { isConflict } from "../db-error";
import { AtscriptDbTable } from "../table/db-table";
import { AtscriptDbView } from "../table/db-view";
import type { AtscriptDbReadable } from "../table/db-readable";
import type { DbSpace } from "../table/db-space";
import type { TTableSnapshot, TViewSnapshot } from "./schema-hash";

// ── SyncStore ────────────────────────────────────────────────────────────

export class SyncStore {
  private controlTable: AtscriptDbTable | undefined;

  constructor(private readonly space: DbSpace) {}

  // ── Control table ─────────────────────────────────────────────────────

  async ensureControlTable(): Promise<void> {
    if (!this.controlTable) {
      const { AtscriptControl } = await import("./control.as");
      this.controlTable = this.space.getTable(AtscriptControl);
    }
    await this.controlTable.ensureTable();
  }

  /**
   * Runs `fn` at most once across syncs (data steps, 0.1.174), in a
   * transaction of the control table's adapter family — the space's tables on
   * the same driver join it — with an insert-only record `_id` = `value()`.
   * In a real transaction the record is inserted first: a peer's record fails
   * the insert and `fn` does not run (`"recorded"`). In a pass-through one
   * (in-memory adapter, MongoDB without a replica set) the record is checked
   * before `fn` and inserted after it; a peer that records it while `fn`
   * runs here leaves `"ran-twice"`.
   */
  async runOnce(
    _id: string,
    value: () => string,
    fn: () => Promise<void> | void,
  ): Promise<"ran" | "recorded" | "ran-twice"> {
    try {
      return await this.controlTable!.dbAdapter.withTransaction(async () => {
        if (this.inRealTransaction()) {
          // Thrown, not returned: a failed insert can abort the transaction
          // (PostgreSQL, MongoDB), which must roll back, never commit.
          if (!(await this.insertControlValue(_id, value()))) throw RECORDED_BY_PEER;
          await fn();
          return "ran";
        }
        if ((await this.presentControlIds([_id])).has(_id)) return "recorded";
        await fn();
        return (await this.insertControlValue(_id, value())) ? "ran" : "ran-twice";
      });
    } catch (error) {
      if (error === RECORDED_BY_PEER) return "recorded";
      throw error;
    }
  }

  /** Whether the current async context runs in a REAL transaction of the control table's adapter. */
  inRealTransaction(): boolean {
    return this.controlTable!.dbAdapter.isInTransaction();
  }

  /**
   * Inserts a control row, never overwriting one: `false` when another
   * writer's row with this `_id` exists (the insert hit the primary key).
   * `value` should be unique to the caller — a conflicting row that holds it
   * is this call's own write (see {@link tryInsert}).
   */
  async insertControlValue(_id: string, value: string): Promise<boolean> {
    return this.tryInsert({ _id, value });
  }

  /**
   * Inserts `row` into the control table: `true` when this call stored it,
   * `false` when another writer's row holds its `_id`.
   *
   * A `CONFLICT` is read back first: a write retried after its acknowledgement
   * was lost (a network failure between server and driver) can hit the very
   * row its first attempt stored. When the stored row carries every value of
   * `row` it is this call's write, and the insert succeeded — reading it as a
   * peer's would leave this pod waiting on its own sync lock until the TTL
   * expires.
   * Inside a real transaction there is no read-back: nothing is retried there,
   * and the failed statement aborted the transaction (PostgreSQL, MongoDB).
   */
  private async tryInsert(row: Record<string, unknown>): Promise<boolean> {
    try {
      await this.controlTable!.insertOne(row as any);
      return true;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    if (this.inRealTransaction()) return false;
    const stored = await this.readControlRow(row._id as string);
    return stored !== null && isSameRow(stored, row);
  }

  /** The control row with this `_id`, `null` when there is none. */
  private async readControlRow(_id: string): Promise<Record<string, unknown> | null> {
    const row = await this.controlTable!.findOne({ filter: { _id: { $eq: _id } }, controls: {} });
    return row as Record<string, unknown> | null;
  }

  /** Which of `ids` have a control row — one query (since 0.1.165, data steps). */
  async presentControlIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = (await this.controlTable!.findMany({
      filter: { _id: { $in: [...ids] } },
      controls: { $select: ["_id"] },
    } as never)) as Array<{ _id: string }>;
    return new Set(rows.map((r) => r._id));
  }

  async readControlValue(_id: string): Promise<string | null> {
    return ((await this.readControlRow(_id))?.value as string | null) ?? null;
  }

  async writeControlValue(_id: string, value: string): Promise<void> {
    const existing = await this.readControlValue(_id);
    if (existing !== null) {
      await this.controlTable!.replaceOne({ _id, value } as any);
    } else {
      await this.controlTable!.insertOne({ _id, value } as any);
    }
  }

  // ── Schema hash ───────────────────────────────────────────────────────

  async readHash(): Promise<string | null> {
    return this.readControlValue("schema_version");
  }

  async writeHash(hash: string): Promise<void> {
    await this.writeControlValue("schema_version", hash);
  }

  // ── Table snapshot storage ────────────────────────────────────────────

  async readTableSnapshot(tableName: string): Promise<TTableSnapshot | null>;
  async readTableSnapshot(tableName: string, asView: true): Promise<TViewSnapshot | null>;
  async readTableSnapshot(
    tableName: string,
    _asView?: boolean,
  ): Promise<TTableSnapshot | TViewSnapshot | null> {
    const value = await this.readControlValue(`table_snapshot:${tableName}`);
    return value ? JSON.parse(value) : null;
  }

  async writeTableSnapshot(
    tableName: string,
    snapshot: TTableSnapshot | TViewSnapshot,
  ): Promise<void> {
    await this.writeControlValue(`table_snapshot:${tableName}`, JSON.stringify(snapshot));
  }

  async deleteTableSnapshot(tableName: string): Promise<void> {
    try {
      await this.controlTable!.deleteOne(`table_snapshot:${tableName}` as any);
    } catch {
      /* best effort */
    }
  }

  // ── Table tracking ────────────────────────────────────────────────────

  async readTrackedList(): Promise<
    Array<{ name: string; isView: boolean; viewType?: "V" | "M" | "E" }>
  > {
    const value = await this.readControlValue("synced_tables");
    if (!value) {
      return [];
    }
    const parsed = JSON.parse(value);
    // Backwards-compatible: old format was string[], then { name, isView }[]
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
      return (parsed as string[]).map((name) => ({ name, isView: false }));
    }
    // Entries without viewType default to 'V' for views
    const entries = parsed as Array<{ name: string; isView: boolean; viewType?: "V" | "M" | "E" }>;
    for (const e of entries) {
      e.viewType ??= e.isView ? "V" : undefined;
    }
    return entries;
  }

  /**
   * Writes the tracked list: the current readables plus `retained` — entries
   * from the previous list that were scheduled for removal but NOT dropped
   * (safe mode, blocked or failed drop). Tracking must keep describing what
   * sync believes exists, so a later run that actually executes still drops
   * them instead of orphaning them behind a matching hash.
   */
  async writeTrackedList(
    readables: AtscriptDbReadable[],
    retained: Array<{ name: string; isView: boolean; viewType?: "V" | "M" | "E" }> = [],
  ): Promise<void> {
    const entries = readables.map((r) => {
      const isView = r.isView;
      let viewType: "V" | "M" | "E" | undefined;
      if (isView) {
        const view = r as AtscriptDbView;
        viewType = view.isExternal ? "E" : view.viewPlan.materialized ? "M" : "V";
      }
      return { name: r.tableName, isView, viewType };
    });
    const current = new Set(entries.map((e) => e.name));
    for (const e of retained) {
      if (!current.has(e.name)) {
        entries.push({ name: e.name, isView: e.isView, viewType: e.viewType });
        current.add(e.name);
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    await this.writeControlValue("synced_tables", JSON.stringify(entries));
  }

  // ── Distributed lock ──────────────────────────────────────────────────
  //
  // Every lock write is ONE conditional statement (compare-and-set on the
  // row), never a read followed by an unconditional write: a peer can act
  // between the two, and a stale write would then delete or overwrite ITS
  // lock. Mutual exclusion itself rests on the `_id` primary key — the
  // insert that loses the race fails with a `CONFLICT`.

  private async readLock(): Promise<Record<string, unknown> | null> {
    return this.readControlRow(LOCK_ID);
  }

  /**
   * Deletes the lock row only while it is still expired — a peer that took
   * the expired lock over in the meantime keeps its fresh one.
   */
  private async deleteExpiredLock(now: number): Promise<void> {
    await this.controlTable!.deleteMany(lockFilter({ expiresAt: { $lt: now } }));
  }

  /**
   * One acquisition attempt: `true` when this pod now holds the lock, `false`
   * when a live lock (or a peer's concurrent insert) holds it. Any other error
   * propagates — a failing insert is not contention. A conflicting row is this
   * attempt's own only with its `lockedAt` too (see {@link tryInsert}): an
   * earlier run's lock under the same `podId` is not.
   */
  async tryAcquireLock(podId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = await this.readLock();
    if (existing) {
      if (!isExpired(existing, now)) {
        return false;
      }
      await this.deleteExpiredLock(now);
    }

    return this.tryInsert({ _id: LOCK_ID, lockedBy: podId, lockedAt: now, expiresAt: now + ttlMs });
  }

  /** Extends this pod's lock; never touches a lock another pod holds. */
  async refreshLock(podId: string, ttlMs: number): Promise<"refreshed" | "stolen" | "missing"> {
    const { matchedCount } = await this.controlTable!.updateMany(
      lockFilter({ lockedBy: { $eq: podId } }),
      { expiresAt: Date.now() + ttlMs } as any,
    );
    if (matchedCount > 0) {
      return "refreshed";
    }
    return (await this.readLock()) ? "stolen" : "missing";
  }

  /**
   * Deletes this pod's lock. Resolves `false` when there was none to delete
   * (it expired and a peer took it over, or it was removed); errors propagate.
   */
  async releaseLock(podId: string): Promise<boolean> {
    const { deletedCount } = await this.controlTable!.deleteMany(
      lockFilter({ lockedBy: { $eq: podId } }),
    );
    return deletedCount > 0;
  }

  /**
   * Polls until the lock is free (or expired — then it is cleared). Resolves
   * `true` then, `false` once `timeoutMs` has passed with the lock still held.
   * Acquiring it is the caller's next step.
   */
  async waitForLock(timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const lock = await this.readLock();
      if (!lock) {
        return true;
      }

      const now = Date.now();
      if (isExpired(lock, now)) {
        await this.deleteExpiredLock(now);
        return true;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
      });
    }

    return false;
  }
}

const LOCK_ID = "sync_lock";

/** Thrown inside {@link SyncStore.runOnce}'s transaction when a peer recorded first — rolls it back. */
const RECORDED_BY_PEER = Symbol("recorded-by-peer");

/** The lock row's filter, narrowed by `conditions` (the compare-and-set part). */
function lockFilter(conditions?: Record<string, unknown>): any {
  return { _id: { $eq: LOCK_ID }, ...conditions };
}

/**
 * Whether the stored control row holds every value of `row` — numbers compared
 * as numbers (a driver may read a `BIGINT` column back as a string).
 */
function isSameRow(stored: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(row).every(([key, value]) =>
    typeof value === "number" ? Number(stored[key]) === value : stored[key] === value,
  );
}

/** A lock row without an expiry never expires (it blocks until the wait times out). */
function isExpired(lock: Record<string, unknown>, now: number): boolean {
  const expiresAt = Number(lock.expiresAt);
  return expiresAt > 0 && expiresAt < now;
}

// ── Public snapshot reader ───────────────────────────────────────────────

/**
 * Reads a stored table snapshot from the control table.
 * Use this for introspection/test utilities without coupling to control table internals.
 */
export async function readStoredSnapshot(
  space: DbSpace,
  tableName: string,
): Promise<TTableSnapshot | null>;
export async function readStoredSnapshot(
  space: DbSpace,
  tableName: string,
  asView: true,
): Promise<TViewSnapshot | null>;
export async function readStoredSnapshot(
  space: DbSpace,
  tableName: string,
  _asView?: boolean,
): Promise<TTableSnapshot | TViewSnapshot | null> {
  const { AtscriptControl } = await import("./control.as");
  const table = space.getTable(AtscriptControl);
  await table.ensureTable();
  const row = await table.findOne({
    filter: { _id: { $eq: `table_snapshot:${tableName}` } },
    controls: {},
  });
  const value = ((row as Record<string, unknown> | null)?.value as string | null) ?? null;
  return value ? JSON.parse(value) : null;
}
