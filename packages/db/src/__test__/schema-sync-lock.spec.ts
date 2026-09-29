import { describe, it, expect, beforeAll, afterEach, vi } from "vite-plus/test";

import { DbError, DbSpace, NoopLogger } from "../index";
import { SchemaSync } from "../sync";
import type {
  FilterExpr,
  TDbDeleteResult,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
} from "../types";

import { MockAdapter, matchesFilter, prepareFixtures } from "./test-utils";

// The schema-sync distributed lock (0.1.141): every lock write is one
// conditional statement, the heartbeat's last refresh settles before the
// release, a forced run that waited still runs, and only a CONFLICT on the
// lock insert means contention.

let UsersTable: any;

beforeAll(async () => {
  await prepareFixtures();
  UsersTable = (await import("./fixtures/test-table.as")).UsersTable;
});

afterEach(() => {
  vi.useRealTimers();
});

/** A controllable promise. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets pending microtasks / promise chains run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Mock adapter whose inserts enforce the primary key, like every real adapter. */
class PkMockAdapter extends MockAdapter {
  /** Runs before each control-table write — lets a test interleave a "peer". */
  beforeWrite?: (method: string, filter: unknown) => void | Promise<void>;

  private get _pk(): string {
    return this._table.primaryKeys[0] as string;
  }

  override async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    await this.beforeWrite?.("insertOne", data);
    if (this._rows().some((r) => r[this._pk] === data[this._pk])) {
      throw new DbError("CONFLICT", [{ path: this._pk, message: "Duplicate primary key" }]);
    }
    return super.insertOne(data);
  }

  // The table layer routes every insert (insertOne too) through `insertMany`
  override async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    const ids: unknown[] = [];
    for (const row of data) {
      ids.push((await this.insertOne(row)).insertedId);
    }
    return { insertedCount: ids.length, insertedIds: ids };
  }

  override async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
  ): Promise<TDbUpdateResult> {
    await this.beforeWrite?.("updateMany", filter);
    return super.updateMany(filter, data);
  }

  override async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    await this.beforeWrite?.("deleteMany", filter);
    return super.deleteMany(filter);
  }

  override async replaceOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
  ): Promise<TDbUpdateResult> {
    await this.beforeWrite?.("replaceOne", filter);
    const rows = this._rows();
    const idx = rows.findIndex((r) => matchesFilter(r, filter));
    if (idx >= 0) {
      rows[idx] = { ...data };
    }
    return { matchedCount: idx >= 0 ? 1 : 0, modifiedCount: idx >= 0 ? 1 : 0 };
  }
}

function setup() {
  const adapters: PkMockAdapter[] = [];
  const space = new DbSpace(() => {
    const a = new PkMockAdapter();
    adapters.push(a);
    return a;
  });
  const sync = new SchemaSync(space);
  const store = (sync as any).store;
  const control = () =>
    adapters.find((a) => (a as any)._table?.tableName === "__atscript_control")!;
  const rows = () => {
    const c = control();
    if (!c.store.has("__atscript_control")) c.store.set("__atscript_control", []);
    return c.store.get("__atscript_control")!;
  };
  const lockRow = () => rows().find((r) => r._id === "sync_lock") ?? null;
  const putLock = (lock: Record<string, unknown>) => rows().push({ _id: "sync_lock", ...lock });
  const dropLock = () => rows().splice(rows().indexOf(lockRow()!), 1);
  return { space, sync, store, control, rows, lockRow, putLock, dropLock };
}

async function setupWithControl() {
  const s = setup();
  await s.store.ensureControlTable();
  return s;
}

// ── SyncStore: conditional lock writes ────────────────────────────────────

describe("SyncStore lock", () => {
  it("tryAcquireLock inserts a lock row and reports a live lock as contention", async () => {
    const { store, lockRow } = await setupWithControl();
    expect(await store.tryAcquireLock("pod-a", 30_000)).toBe(true);
    expect(lockRow()).toMatchObject({ lockedBy: "pod-a" });
    expect(await store.tryAcquireLock("pod-b", 30_000)).toBe(false);
    expect(lockRow()).toMatchObject({ lockedBy: "pod-a" });
  });

  // WHY: two pods can read the lock row as absent at once; the loser's insert
  // hits the `_id` primary key. That CONFLICT — and only that — is contention.
  it("tryAcquireLock treats a CONFLICT on the insert as contention", async () => {
    const { store, control, putLock } = await setupWithControl();
    control().beforeWrite = (method) => {
      if (method === "insertOne") {
        control().beforeWrite = undefined;
        putLock({ lockedBy: "peer", lockedAt: Date.now(), expiresAt: Date.now() + 30_000 });
      }
    };
    expect(await store.tryAcquireLock("pod-a", 30_000)).toBe(false);
  });

  // WHY: before 0.1.141 ANY insert error returned `false` — a broken write
  // (connection loss, validation) was misread as a peer holding the lock, and
  // a forced run then answered "synced-by-peer" without syncing.
  it("tryAcquireLock propagates insert errors that are not a CONFLICT", async () => {
    const { store, control } = await setupWithControl();
    control().beforeWrite = (method) => {
      if (method === "insertOne") throw new Error("connection reset");
    };
    await expect(store.tryAcquireLock("pod-a", 30_000)).rejects.toThrow("connection reset");
  });

  it("tryAcquireLock clears an expired lock and takes it", async () => {
    const { store, lockRow, putLock } = await setupWithControl();
    putLock({ lockedBy: "dead-pod", lockedAt: 0, expiresAt: 1 });
    expect(await store.tryAcquireLock("pod-a", 30_000)).toBe(true);
    expect(lockRow()).toMatchObject({ lockedBy: "pod-a" });
  });

  // WHY: pods A and B both see the same expired lock; A deletes it and
  // inserts its own. B's cleanup must not delete A's FRESH lock (an
  // unconditional delete-by-id did — both pods then ran DDL concurrently).
  it("tryAcquireLock's expired-lock cleanup never deletes a peer's fresh lock", async () => {
    const { store, control, lockRow, putLock } = await setupWithControl();
    putLock({ lockedBy: "dead-pod", lockedAt: 0, expiresAt: 1 });
    control().beforeWrite = (method) => {
      if (method === "deleteMany") {
        control().beforeWrite = undefined;
        // Peer A took the expired lock over between our read and our delete
        const row = lockRow()!;
        Object.assign(row, { lockedBy: "pod-a", expiresAt: Date.now() + 30_000 });
      }
    };
    expect(await store.tryAcquireLock("pod-b", 30_000)).toBe(false);
    expect(lockRow()).toMatchObject({ lockedBy: "pod-a" });
  });

  it("refreshLock extends only this pod's lock", async () => {
    const { store, lockRow, putLock } = await setupWithControl();
    putLock({ lockedBy: "pod-a", lockedAt: 5, expiresAt: Date.now() + 10 });
    expect(await store.refreshLock("pod-a", 30_000)).toBe("refreshed");
    expect(lockRow()!.expiresAt as number).toBeGreaterThan(Date.now() + 20_000);
    expect(lockRow()!.lockedAt).toBe(5);
  });

  // WHY: a check-then-replace refresh whose write landed after the release
  // (and after the next holder's insert) overwrote the NEXT holder's lock
  // with this pod's id — the row then outlived both runs.
  it("refreshLock never overwrites another pod's lock", async () => {
    const { store, lockRow, putLock } = await setupWithControl();
    const peer = { lockedBy: "pod-b", lockedAt: 1, expiresAt: Date.now() + 30_000 };
    putLock({ ...peer });
    expect(await store.refreshLock("pod-a", 30_000)).toBe("stolen");
    expect(lockRow()).toMatchObject(peer);
  });

  it("refreshLock's write is conditional — a takeover right before it is not overwritten", async () => {
    const { store, control, lockRow, putLock } = await setupWithControl();
    putLock({ lockedBy: "pod-a", lockedAt: 1, expiresAt: Date.now() + 30_000 });
    control().beforeWrite = () => {
      control().beforeWrite = undefined;
      // pod-a's lock was released and pod-b acquired, while pod-a's refresh ran
      Object.assign(lockRow()!, { lockedBy: "pod-b", expiresAt: Date.now() + 30_000 });
    };
    expect(await store.refreshLock("pod-a", 30_000)).toBe("stolen");
    expect(lockRow()).toMatchObject({ lockedBy: "pod-b" });
  });

  it("refreshLock reports a missing lock without recreating it", async () => {
    const { store, lockRow } = await setupWithControl();
    expect(await store.refreshLock("pod-a", 30_000)).toBe("missing");
    expect(lockRow()).toBeNull();
  });

  it("releaseLock deletes only this pod's lock", async () => {
    const { store, lockRow, putLock } = await setupWithControl();
    putLock({ lockedBy: "pod-b", lockedAt: 1, expiresAt: Date.now() + 30_000 });
    expect(await store.releaseLock("pod-a")).toBe(false);
    expect(lockRow()).toMatchObject({ lockedBy: "pod-b" });
    expect(await store.releaseLock("pod-b")).toBe(true);
    expect(lockRow()).toBeNull();
  });

  it("releaseLock propagates write errors", async () => {
    const { store, control, putLock } = await setupWithControl();
    putLock({ lockedBy: "pod-a", lockedAt: 1, expiresAt: Date.now() + 30_000 });
    control().beforeWrite = () => {
      throw new Error("connection reset");
    };
    await expect(store.releaseLock("pod-a")).rejects.toThrow("connection reset");
  });

  it("waitForLock resolves true once the lock is gone, false on timeout", async () => {
    const { store, control, putLock } = await setupWithControl();
    putLock({ lockedBy: "peer", lockedAt: 1, expiresAt: Date.now() + 30_000 });
    expect(await store.waitForLock(30, 5)).toBe(false);
    setTimeout(() => control().store.set("__atscript_control", []), 20);
    expect(await store.waitForLock(5_000, 5)).toBe(true);
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────

describe("SchemaSync heartbeat", () => {
  function fakeHeartbeat() {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { sync } = setup();
    const refreshes: Array<ReturnType<typeof deferred<"refreshed" | "stolen" | "missing">>> = [];
    (sync as any).store = {
      refreshLock: vi.fn(() => {
        const d = deferred<"refreshed" | "stolen" | "missing">();
        refreshes.push(d);
        return d.promise;
      }),
    };
    const hb = (sync as any).startHeartbeat("pod-a", 3000) as {
      stop: () => Promise<void>;
      getAbortReason: () => string | undefined;
    };
    return { sync, hb, refreshes };
  }

  // WHY: `stop()` used to flag + clearInterval only, so the lock was released
  // while a refresh was still in flight. On PostgreSQL the release's DELETE
  // then lost to the refresh's committed UPDATE and deleted nothing — the next
  // run found a live lock and answered "synced-by-peer" (as-test L.11).
  it("stop() resolves only after the in-flight refresh settles", async () => {
    const { hb, refreshes } = fakeHeartbeat();
    vi.advanceTimersByTime(1000);
    expect(refreshes).toHaveLength(1);

    let stopped = false;
    const stopping = hb.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);

    refreshes[0]!.resolve("refreshed");
    await stopping;
    expect(stopped).toBe(true);
  });

  it("never overlaps refreshes and starts none after stop()", async () => {
    const { hb, refreshes } = fakeHeartbeat();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000); // tick while the first refresh is in flight
    expect(refreshes).toHaveLength(1);

    refreshes[0]!.resolve("refreshed");
    await flush();
    vi.advanceTimersByTime(1000);
    expect(refreshes).toHaveLength(2);
    refreshes[1]!.resolve("refreshed");
    await hb.stop();

    vi.advanceTimersByTime(5000);
    expect(refreshes).toHaveLength(2);
  });

  it("a refresh that settles after stop() sets no abort reason", async () => {
    const { hb, refreshes } = fakeHeartbeat();
    vi.advanceTimersByTime(1000);
    const stopping = hb.stop();
    refreshes[0]!.resolve("missing");
    await stopping;
    expect(hb.getAbortReason()).toBeUndefined();
  });

  it("flags a stolen lock while running", async () => {
    const { hb, refreshes } = fakeHeartbeat();
    vi.advanceTimersByTime(1000);
    refreshes[0]!.resolve("stolen");
    await flush();
    expect(hb.getAbortReason()).toMatch(/stolen/);
    await hb.stop();
  });
});

// ── run(): acquisition, force, release ────────────────────────────────────

describe("SchemaSync.run locking", () => {
  it("releases the lock only after the heartbeat's in-flight refresh settled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { sync, store, lockRow } = setup();
    const events: string[] = [];
    const refreshGate = deferred();
    const realRefresh = store.refreshLock.bind(store);
    store.refreshLock = async (podId: string, ttl: number) => {
      events.push("refresh:start");
      await refreshGate.promise;
      const status = await realRefresh(podId, ttl);
      events.push(`refresh:end:${status}`);
      return status;
    };
    const realRelease = store.releaseLock.bind(store);
    store.releaseLock = async (podId: string) => {
      events.push("release");
      return realRelease(podId);
    };
    const realWriteHash = store.writeHash.bind(store);
    store.writeHash = async (hash: string) => {
      vi.advanceTimersByTime(1000); // a heartbeat tick fires at the end of the run
      setTimeout(() => refreshGate.resolve(), 20);
      return realWriteHash(hash);
    };

    const result = await sync.run([UsersTable], { force: true, lockTtlMs: 3000 });
    expect(result.status).toBe("synced");
    expect(events).toEqual(["refresh:start", "refresh:end:refreshed", "release"]);
    expect(lockRow()).toBeNull();
  });

  it("a failed release is logged, not thrown, and does not mask the result", async () => {
    const { sync, store } = setup();
    const warns: string[] = [];
    store.releaseLock = async () => {
      throw new Error("connection reset");
    };
    const result = await sync.run([UsersTable], {
      logger: { ...NoopLogger, warn: (...a: unknown[]) => warns.push(a.join(" ")) },
    });
    expect(result.status).toBe("synced");
    expect(warns.some((w) => w.includes("release") && w.includes("connection reset"))).toBe(true);
  });

  /** Runs once, then plants a peer lock — released after 30ms unless `held`. */
  async function withPeerLock(held = false) {
    const s = setup();
    const first = await s.sync.run([UsersTable]);
    s.putLock({ lockedBy: "peer", lockedAt: Date.now(), expiresAt: Date.now() + 30_000 });
    if (!held) {
      setTimeout(() => s.dropLock(), 30);
    }
    return { ...s, hash: first.schemaHash };
  }

  // WHY: `force: true` means "run regardless of the stored hash". The post-wait
  // hash check used to ignore it and answer "synced-by-peer" — inconsistent
  // with the post-acquire double-check, which already respected force.
  it("a forced run that had to wait acquires the lock and runs", async () => {
    const { sync, lockRow } = await withPeerLock();
    const result = await sync.run([UsersTable], { force: true, pollIntervalMs: 5 });
    expect(result.status).toBe("synced");
    expect(lockRow()).toBeNull();
  });

  it("a non-forced run that waited answers synced-by-peer when the peer stored the hash", async () => {
    const s = setup();
    const first = await s.sync.run([UsersTable]);
    // Stored hash is stale while the peer holds the lock ...
    const version = s.rows().find((r) => r._id === "schema_version")!;
    version.value = "stale";
    s.putLock({ lockedBy: "peer", lockedAt: Date.now(), expiresAt: Date.now() + 30_000 });
    // ... then the peer finishes: hash written, lock released.
    setTimeout(() => {
      version.value = first.schemaHash;
      s.dropLock();
    }, 30);
    const result = await s.sync.run([UsersTable], { pollIntervalMs: 5 });
    expect(result.status).toBe("synced-by-peer");
  });

  it("a waiter that loses the freed lock to another waiter waits again", async () => {
    const s = await withPeerLock();
    let takeovers = 0;
    const realAcquire = s.store.tryAcquireLock.bind(s.store);
    s.store.tryAcquireLock = async (podId: string, ttl: number) => {
      if (!s.lockRow() && takeovers === 0) {
        // Another waiter grabs the freed lock first and holds it briefly
        takeovers++;
        s.putLock({ lockedBy: "other", lockedAt: Date.now(), expiresAt: Date.now() + 30_000 });
        setTimeout(() => s.dropLock(), 30);
      }
      return realAcquire(podId, ttl);
    };
    const result = await s.sync.run([UsersTable], { force: true, pollIntervalMs: 5 });
    expect(takeovers).toBe(1);
    expect(result.status).toBe("synced");
  });

  it("times out when the lock stays held", async () => {
    const { sync } = await withPeerLock(true);
    await expect(
      sync.run([UsersTable], { force: true, waitTimeoutMs: 40, pollIntervalMs: 5 }),
    ).rejects.toThrow("Schema sync lock wait timed out after 40ms");
  });
});
