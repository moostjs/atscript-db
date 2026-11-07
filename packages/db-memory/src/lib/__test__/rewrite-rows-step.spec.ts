import { SchemaSync, planSchema, rewriteRowsStep, syncSchema } from "@atscript/db/sync";
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.175. The in-memory adapter has no transactions, so the step runs in
// pass-through mode: the rows it wrote before a failure stay written, the step
// is not recorded, and the next sync runs it again over the half-rewritten
// rows — which is why `map` must be idempotent.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rewrite-rows.as");
});

const silent = { error() {}, warn() {}, log() {}, info() {}, debug() {} };
const clamp = (turns: string[]) => turns.slice(-2);

async function seed(space: any, count: number) {
  await syncSchema(space, [fx.RwChat]);
  const table = space.getTable(fx.RwChat) as any;
  // Every row holds the 3 turns the type allows; the step clamps them to 2
  await table.insertMany(
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      title: `t${i + 1}`,
      turns: ["a", "b", "c"],
    })),
  );
  return table;
}

async function record(space: any, id: string): Promise<Record<string, unknown> | null> {
  const store = (new SchemaSync(space) as any).store;
  await store.ensureControlTable();
  const value = await store.readControlValue(`data_step:${id}`);
  return value === null ? null : JSON.parse(value);
}

describe("[memory] rewriteRowsStep in pass-through mode", () => {
  it("rewrites in key order, writes only changed rows, records the note after the step", async () => {
    const space = createTestSpace();
    const table = await seed(space, 5);
    // Rows 2 and 4 are already short
    await table.bulkUpdate([
      { id: 2, turns: ["x"] },
      { id: 4, turns: ["y"] },
    ]);
    const real = vi.spyOn(
      Object.getPrototypeOf((new SchemaSync(space) as any).store),
      "inRealTransaction",
    );
    const bulkUpdate = vi.spyOn(table, "bulkUpdate");
    const step = rewriteRowsStep(fx.RwChat, { field: "turns", map: clamp, batchSize: 2 });
    const result = await syncSchema(space, [fx.RwChat], { dataSteps: [step] });
    expect(await real.mock.results[0]!.value).toBe(false); // no transaction
    real.mockRestore();

    expect(result.dataSteps?.ran).toEqual([step.id]);
    expect(result.dataSteps?.notes).toEqual({ [step.id]: "rewrote 3 of 5 rows" });
    expect(bulkUpdate.mock.calls.map(([patches]) => patches)).toEqual([
      [{ id: 1, turns: ["b", "c"] }],
      [{ id: 3, turns: ["b", "c"] }],
      [{ id: 5, turns: ["b", "c"] }],
    ]);
    const rows = await table.findMany({ controls: { $sort: { id: 1 } } });
    expect(rows.map((r: any) => r.turns)).toEqual([
      ["b", "c"],
      ["x"],
      ["b", "c"],
      ["y"],
      ["b", "c"],
    ]);
    expect(await record(space, step.id)).toMatchObject({ note: "rewrote 3 of 5 rows" });
    // Recorded: the next sync has nothing to do
    expect((await planSchema(space, [fx.RwChat], { dataSteps: [step] })).pendingDataSteps).toEqual(
      [],
    );
  });

  it("a failure keeps the earlier batches written, records nothing, and an idempotent rerun finishes", async () => {
    const space = createTestSpace();
    const table = await seed(space, 4);
    let failOnce = true;
    const map = (turns: string[], row: any) => {
      if (row.id === 3 && failOnce) {
        failOnce = false;
        throw new Error("boom");
      }
      return clamp(turns); // idempotent: clamping twice is clamping once
    };
    const step = rewriteRowsStep(fx.RwChat, { field: "turns", map, batchSize: 2 });

    await expect(
      syncSchema(space, [fx.RwChat], { dataSteps: [step], logger: silent }),
    ).rejects.toThrow("boom");
    // No rollback without transactions: batch one (rows 1, 2) stays rewritten
    const partial = await table.findMany({ controls: { $sort: { id: 1 } } });
    expect(partial.map((r: any) => r.turns.length)).toEqual([2, 2, 3, 3]);
    expect(await record(space, step.id)).toBeNull();
    expect((await planSchema(space, [fx.RwChat], { dataSteps: [step] })).pendingDataSteps).toEqual([
      step.id,
    ]);

    const second = await syncSchema(space, [fx.RwChat], { dataSteps: [step] });
    expect(second.dataSteps?.ran).toEqual([step.id]);
    // The rerun sees rows 1 and 2 as already done (unchanged), rewrites 3 and 4
    expect(second.dataSteps?.notes?.[step.id]).toBe("rewrote 2 of 4 rows");
    const rows = await table.findMany({ controls: { $sort: { id: 1 } } });
    expect(rows.map((r: any) => r.turns)).toEqual([
      ["b", "c"],
      ["b", "c"],
      ["b", "c"],
      ["b", "c"],
    ]);
  });
});
