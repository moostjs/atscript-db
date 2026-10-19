import { it, expect, beforeEach } from "vite-plus/test";
import { DbError } from "@atscript/db";

/**
 * The shared cases of locking reads and transaction isolation against a live
 * server (since 0.1.162), run by the PostgreSQL and MySQL live suites over
 * the `IgItem` / `IgNote` / `IgCode` tables of `fixtures/insert-ignore.as` of
 * each adapter. Each `withTransaction` holds its own pooled connection, so two
 * concurrent ones are two sessions. Isolation-level cases that differ by
 * engine stay in the adapter's spec.
 */
export interface TReadLockKit {
  items: () => any;
  notes: () => any;
  codes: () => any;
  /** The non-default levels a skipLocked `findById` is checked under (besides the default). */
  skipLockedIsolations: readonly string[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise plus its resolver. */
export function signal(): { wait: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const wait = new Promise<void>((r) => (fire = r));
  return { wait, fire };
}

/** Registers the reset of the three tables (rows 1..3 of `items`) and the shared cases. */
export function defineReadLockCases(kit: TReadLockKit): void {
  const { items, codes, notes } = kit;
  const adapter = (): any => items().getAdapter();

  beforeEach(async () => {
    await codes().deleteMany({});
    await notes().deleteMany({});
    await items().deleteMany({});
    await items().insertMany([
      { id: 1, sku: "a", qty: 1 },
      { id: 2, sku: "b", qty: 1 },
      { id: 3, sku: "c", qty: 1 },
    ]);
  });

  /** T1 locks row 1 (`mode`), runs `during` while holding it, then commits. */
  async function holdingRow1<T>(mode: "update" | "share", during: () => Promise<T>): Promise<T> {
    const locked = signal();
    const release = signal();
    const t1 = adapter().withTransaction(async () => {
      await items().findById(1, { lock: mode });
      locked.fire();
      await release.wait;
      await items().updateOne({ id: 1, qty: 10 });
    });
    await locked.wait;
    try {
      return await during();
    } finally {
      release.fire();
      await t1;
    }
  }

  it("FOR UPDATE blocks a second locker until the first commits, which then reads the committed row", async () => {
    let t2Row: any;
    let t2Done = false;
    const locked = signal();
    const release = signal();
    const t1 = adapter().withTransaction(async () => {
      await items().findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" });
      locked.fire();
      await release.wait;
      await items().updateOne({ id: 1, qty: 10 });
    });
    await locked.wait;
    const t2 = adapter()
      .withTransaction(() => items().findById(1, { lock: "update" }))
      .then((row: any) => {
        t2Row = row;
        t2Done = true;
      });
    await sleep(400);
    expect(t2Done).toBe(false); // blocked on T1's lock
    release.fire();
    await t1;
    await t2;
    expect(t2Row.qty).toBe(10); // a locking read is a current read
  });

  it("NOWAIT on a locked row fails at once with a retryable LOCK_TIMEOUT", async () => {
    const error = await holdingRow1("update", () =>
      adapter()
        .withTransaction(() =>
          items().findOne({ filter: { id: 1 }, controls: {} }, { lock: "update", wait: "nowait" }),
        )
        .catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: "LOCK_TIMEOUT", retryable: true });
  });

  it("SKIP LOCKED leaves the locked row out", async () => {
    const ids = await holdingRow1("update", () =>
      adapter().withTransaction(async () =>
        (
          (await items().findMany(
            { filter: {}, controls: { $sort: { id: 1 } } },
            { lock: "update", wait: "skipLocked" },
          )) as any[]
        ).map((r) => r.id),
      ),
    );
    expect(ids).toEqual([2, 3]);
  });

  it("FOR SHARE locks coexist; an exclusive NOWAIT against a share lock fails", async () => {
    const shared = await holdingRow1("share", () =>
      adapter().withTransaction(() => items().findById(1, { lock: "share", wait: "nowait" })),
    );
    expect(shared).toMatchObject({ id: 1 });
    const error = await holdingRow1("share", () =>
      adapter()
        .withTransaction(() => items().findById(1, { lock: "update", wait: "nowait" }))
        .catch((e: unknown) => e),
    );
    expect(error).toMatchObject({ code: "LOCK_TIMEOUT" });
  });

  it("a nested withTransaction cannot raise the isolation level", async () => {
    const error = await adapter()
      .withTransaction(
        () => adapter().withTransaction(async () => {}, { isolation: "serializable" }),
        { isolation: "read committed" },
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_QUERY" });
  });

  it("a paged, sorted locking read with $with locks the page rows (and the $skip-ped ones), not past $limit nor the relation", async () => {
    await notes().insertMany([
      { id: 1, itemId: 1, text: "n1" },
      { id: 2, itemId: 1, text: "n2" },
      { id: 3, itemId: 2, text: "n3" },
    ]);
    const locked = signal();
    const release = signal();
    let page: any[] = [];
    const t1 = adapter().withTransaction(async () => {
      page = (await notes().findMany(
        {
          filter: {},
          controls: { $sort: { id: -1 }, $skip: 1, $limit: 1, $with: [{ name: "item" }] },
        },
        { lock: "update" },
      )) as any[];
      locked.fire();
      await release.wait;
    });
    await locked.wait;
    try {
      expect(page.map((r) => [r.id, r.item?.id])).toEqual([[2, 1]]);
      const tryLock = (table: any, id: number) =>
        adapter()
          .withTransaction(() => table.findById(id, { lock: "update", wait: "nowait" }))
          .then(
            () => "free",
            (e: any) => e.code,
          );
      expect(await tryLock(notes(), 2)).toBe("LOCK_TIMEOUT"); // the page row
      // rows passed over by $skip are locked too (native: the engine locks each row it reads)
      expect(await tryLock(notes(), 3)).toBe("LOCK_TIMEOUT");
      expect(await tryLock(notes(), 1)).toBe("free"); // past $limit
      expect(await tryLock(items(), 1)).toBe("free"); // the $with relation is read unlocked
    } finally {
      release.fire();
      await t1;
    }
  });

  it("a skipLocked findById never falls through to another row when the primary-key row is held", async () => {
    await codes().insertMany([
      { id: 1, code: 2, label: "one" },
      { id: 2, code: 1, label: "two" },
    ]);
    const locked = signal();
    const release = signal();
    const t1 = adapter().withTransaction(async () => {
      await codes().findById(1, { lock: "update" }); // the row whose PRIMARY KEY is 1
      locked.fire();
      await release.wait;
    });
    await locked.wait;
    try {
      for (const isolation of [null, ...kit.skipLockedIsolations] as any[]) {
        // id 1 resolves to the PK row (held → null), never to row 2 whose unique `code` is 1
        const row = await adapter().withTransaction(
          () => codes().findById(1, { lock: "update", wait: "skipLocked" }),
          isolation ? { isolation } : undefined,
        );
        expect(row, String(isolation)).toBeNull();
      }
      // a free primary-key row is still found and locked
      const free = await adapter().withTransaction(() =>
        codes().findById(2, { lock: "update", wait: "skipLocked" }),
      );
      expect(free).toMatchObject({ id: 2, label: "two" });
      // a missing primary key still falls through to the unique key (row 1 holds code 2 → held → null;
      // code 3 does not exist anywhere)
      const missing = await adapter().withTransaction(() =>
        codes().findById(3, { lock: "update", wait: "skipLocked" }),
      );
      expect(missing).toBeNull();
    } finally {
      release.fire();
      await t1;
    }
    // unlocked: id 3 has no PK row, so the unique key resolves it
    await codes().insertOne({ id: 5, code: 3, label: "five" });
    const viaCode = await adapter().withTransaction(() =>
      codes().findById(3, { lock: "update", wait: "skipLocked" }),
    );
    expect(viaCode).toMatchObject({ id: 5 });
  });

  it("a locking read and bounded updateMany / deleteMany share one transaction", async () => {
    await adapter().withTransaction(async () => {
      const locked = (await items().findMany(
        { filter: {}, controls: { $sort: { id: 1 }, $limit: 2 } },
        { lock: "update" },
      )) as any[];
      expect(locked.map((r) => r.id)).toEqual([1, 2]);
      const updated = await items().updateMany({}, { qty: 7 }, { limit: 2, sort: { id: -1 } });
      expect(updated).toMatchObject({ matchedCount: 2, modifiedCount: 2 });
      expect(await items().deleteMany({}, { limit: 1 })).toEqual({ deletedCount: 1 });
    });
    const rows = (await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows.map((r) => [r.id, r.qty])).toEqual([
      [2, 7],
      [3, 7],
    ]);
  });

  it("a bounded updateMany waits for a row another transaction holds, then writes the committed row", async () => {
    let done = false;
    const result = await holdingRow1("update", async () => {
      const t2 = adapter()
        .withTransaction(() => items().updateMany({}, { qty: 5 }, { limit: 1 }))
        .then((r: unknown) => {
          done = true;
          return r;
        });
      await sleep(400);
      expect(done).toBe(false); // blocked on row 1
      return { t2 };
    });
    expect(await result.t2).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    const rows = (await items().findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows.map((r) => r.qty)).toEqual([5, 1, 1]); // T1 wrote 10 first, then T2's 5
  });

  it("a bounded deleteMany whose picked rows a concurrent transaction deletes takes the next match, never 0 while rows remain", async () => {
    const locked = signal();
    const release = signal();
    const t1 = adapter().withTransaction(async () => {
      await items().findMany({ filter: { id: { $in: [1, 2] } }, controls: {} }, { lock: "update" });
      locked.fire();
      await release.wait;
      await items().deleteMany({ id: { $in: [1, 2] } });
    });
    await locked.wait;
    let done = false;
    const t2 = items()
      .deleteMany({}, { limit: 2 })
      .then((r: any) => {
        done = true;
        return r;
      });
    await sleep(400);
    expect(done).toBe(false); // waits on T1's rows 1 and 2
    release.fire();
    await t1;
    expect(await t2).toEqual({ deletedCount: 1 }); // row 3 — not 0 with a match left
    expect(await items().count({ filter: {}, controls: {} })).toBe(0);
  });
}
