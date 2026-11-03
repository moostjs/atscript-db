import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema, type TDataStep } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.168 a data step with `phase: "beforeConstraints"` runs after the
// tables and their new columns exist, before the indexes and foreign keys are
// synced — so it can fix the rows a new unique index or FK would reject.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/data-step-phase.as");
});

beforeEach(() => {
  driver = new BetterSqlite3Driver(":memory:");
});

afterEach(() => {
  driver.close();
});

const newSpace = () => new DbSpace(() => new SqliteAdapter(driver));

/** v1 schema with two rows sharing a code and one dangling owner id. */
async function seedV1(): Promise<void> {
  const space = newSpace();
  await syncSchema(space, [fx.DspOwner, fx.DspItemV1]);
  await (space.getTable(fx.DspOwner) as any).insertOne({ id: 1, name: "o" });
  await (space.getTable(fx.DspItemV1) as any).insertMany([
    { id: 1, code: "a", ownerId: 1 },
    { id: 2, code: "a", ownerId: 1 },
    { id: 3, code: "b", ownerId: 99 },
  ]);
}

const items = (space: DbSpace) => space.getTable(fx.DspItemV2) as any;

/** Merges the duplicate codes and clears the dangling owner, writing the new column. */
const fixRows: TDataStep = {
  id: "merge-codes",
  phase: "beforeConstraints",
  run: async (space) => {
    await items(space).deleteOne(2);
    await items(space).updateOne({ id: 1, note: "merged" });
    await items(space).updateOne({ id: 3, ownerId: null });
  },
};

describe("[sqlite] data step phase", () => {
  it("a beforeConstraints step fixes the rows before the new unique index and FK land", async () => {
    await seedV1();
    const space = newSpace();
    const result = await syncSchema(space, [fx.DspOwner, fx.DspItemV2], { dataSteps: [fixRows] });
    expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
    expect(result.status).toBe("synced");
    expect(result.dataSteps).toEqual({ ran: ["merge-codes"], pending: [] });
    expect((await items(space).findById(1)).note).toBe("merged");
    // The unique index and the FK now hold.
    await expect(items(space).insertOne({ id: 4, code: "a" })).rejects.toThrow();
    await expect(items(space).insertOne({ id: 5, code: "c", ownerId: 42 })).rejects.toThrow();
    const indexes = driver.all<{ name: string }>(`PRAGMA index_list("dsp_items")`);
    expect(indexes.map((i) => i.name)).toContain("atscript__unique__dsp_code_idx");
  });

  it("the same step with the default phase runs too late: the unique index fails first", async () => {
    await seedV1();
    const space = newSpace();
    const result = await syncSchema(space, [fx.DspOwner, fx.DspItemV2], {
      dataSteps: [{ ...fixRows, phase: undefined }],
    });
    expect(result.entries.some((e) => e.status === "error")).toBe(true);
    expect(result.dataSteps).toEqual({ ran: [], pending: ["merge-codes"] });
  });

  it("runs beforeConstraints steps before the after steps, each once", async () => {
    await seedV1();
    const calls: string[] = [];
    const steps: TDataStep[] = [
      { id: "late", run: () => void calls.push("late") },
      { ...fixRows, run: async (s) => (calls.push("early"), fixRows.run(s)) },
    ];
    const first = await syncSchema(newSpace(), [fx.DspOwner, fx.DspItemV2], { dataSteps: steps });
    expect(first.dataSteps).toEqual({ ran: ["merge-codes", "late"], pending: [] });
    expect(calls).toEqual(["early", "late"]);
    const second = await syncSchema(newSpace(), [fx.DspOwner, fx.DspItemV2], { dataSteps: steps });
    expect(second.status).toBe("up-to-date");
    expect(calls).toEqual(["early", "late"]);
  });

  it("a throwing beforeConstraints step stops the run before the constraints; the next sync retries", async () => {
    await seedV1();
    const failing: TDataStep = {
      id: "merge-codes",
      phase: "beforeConstraints",
      run: () => {
        throw new Error("not yet");
      },
    };
    await expect(
      syncSchema(newSpace(), [fx.DspOwner, fx.DspItemV2], { dataSteps: [failing] }),
    ).rejects.toThrow("not yet");
    const indexes = driver.all<{ name: string }>(`PRAGMA index_list("dsp_items")`);
    expect(indexes.map((i) => i.name)).not.toContain("atscript__unique__dsp_code_idx");

    const space = newSpace();
    const retry = await syncSchema(space, [fx.DspOwner, fx.DspItemV2], { dataSteps: [fixRows] });
    expect(retry.status).toBe("synced");
    expect(retry.dataSteps).toEqual({ ran: ["merge-codes"], pending: [] });
    await expect(items(space).insertOne({ id: 4, code: "a" })).rejects.toThrow();
  });

  it("rejects an unknown phase", async () => {
    await expect(
      syncSchema(newSpace(), [fx.DspOwner], {
        dataSteps: [{ id: "x", phase: "first" as never, run: () => undefined }],
      }),
    ).rejects.toThrow('unknown phase "first"');
  });
});

describe("[sqlite] a throwing beforeConstraints step leaves a resumable state", () => {
  async function seed(): Promise<void> {
    const space = newSpace();
    await syncSchema(space, [fx.DsrItemV1, fx.DsrViewV1]);
    await (space.getTable(fx.DsrItemV1) as any).insertMany([
      { id: 1, code: "x", kind: "a" },
      { id: 2, code: "x", kind: "b" },
    ]);
  }
  const v2 = () => [fx.DsrItemV2, fx.DsrViewV2];
  const dedupe: TDataStep = {
    id: "dsr-dedupe",
    phase: "beforeConstraints",
    run: async (space) => {
      await (space.getTable(fx.DsrItemV2) as any).deleteOne(2);
    },
  };
  const failing: TDataStep = { ...dedupe, run: () => Promise.reject(new Error("not yet")) };
  const names = (type: string) =>
    driver
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = ?`, [type])
      .map((r) => r.name);

  it("after a rename: the step's error surfaces, the rename is recorded, a resync finishes", async () => {
    await seed();
    await expect(syncSchema(newSpace(), v2(), { dataSteps: [failing] })).rejects.toThrow("not yet");
    expect(names("table")).toContain("dsr_new");
    expect(names("table")).not.toContain("dsr_old");

    const space = newSpace();
    const retry = await syncSchema(space, v2(), { dataSteps: [dedupe] });
    expect(retry.entries.filter((e) => e.status === "error")).toEqual([]);
    expect(retry.status).toBe("synced");
    expect(retry.dataSteps).toEqual({ ran: ["dsr-dedupe"], pending: [] });
    await expect(
      (space.getTable(fx.DsrItemV2) as any).insertOne({ id: 3, code: "x", kind: "a" }),
    ).rejects.toThrow();
    expect((await syncSchema(newSpace(), v2(), { dataSteps: [dedupe] })).status).toBe("up-to-date");
  });

  it("renameTable is a no-op when the old table is gone and the new one exists", async () => {
    const space = newSpace();
    await syncSchema(space, [fx.DsrItemV2]);
    await (space.getAdapter(fx.DsrItemV2) as any).renameTable("dsr_old");
    expect(names("table")).toContain("dsr_new");
  });

  it("after a view change: the view is not left stale, a resync restores it", async () => {
    await seed();
    await expect(syncSchema(newSpace(), v2(), { dataSteps: [failing] })).rejects.toThrow("not yet");
    const space = newSpace();
    await syncSchema(space, v2(), { dataSteps: [dedupe] });
    expect(names("view")).toContain("dsr_view");
    const rows = driver.all<{ id: number }>(`SELECT id FROM "dsr_view"`);
    expect(rows.map((r) => r.id)).toEqual([]); // kind = 'b' and row 2 was removed
    await (space.getTable(fx.DsrItemV2) as any).insertOne({ id: 4, code: "y", kind: "b" });
    expect(driver.all<{ id: number }>(`SELECT id FROM "dsr_view"`).map((r) => r.id)).toEqual([4]);
  });
});
