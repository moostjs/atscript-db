import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { planSchema, rewriteRowsStep, syncSchema } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.175 `rewriteRowsStep(type, { field?, map })` is a data step that
// rewrites stored rows when a type changes. Its id ends in a hash of the
// validation metadata of the field (or the whole type), so a changed limit
// makes it pending again, while other metadata (labels) does not.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rewrite-rows.as");
});

beforeEach(() => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
});

afterEach(() => {
  driver.close();
});

const clamp = (max: number) => (turns: string[]) => turns.slice(-max);

describe("[sqlite] rewriteRowsStep — step id", () => {
  it("changes with the field's validation metadata, not with other metadata", () => {
    const v1 = rewriteRowsStep(fx.RwChat, { field: "turns", map: clamp(5) });
    const labeled = rewriteRowsStep(fx.RwChatLabeled, { field: "turns", map: clamp(5) });
    const v2 = rewriteRowsStep(fx.RwChatV2, { field: "turns", map: clamp(3) });
    expect(v1.id).toMatch(/^rewrite:rw_chats\.turns@[0-9a-f]{8}$/);
    expect(labeled.id).toBe(v1.id);
    expect(v2.id).not.toBe(v1.id);
    // Whole-table form: the table type's validation metadata
    expect(rewriteRowsStep(fx.RwChatLabeled, { map: (r) => r }).id).toBe(
      rewriteRowsStep(fx.RwChat, { map: (r) => r }).id,
    );
    expect(rewriteRowsStep(fx.RwChatV2, { map: (r) => r }).id).not.toBe(
      rewriteRowsStep(fx.RwChat, { map: (r) => r }).id,
    );
    expect(rewriteRowsStep(fx.RwChat, { id: "clamp", field: "turns", map: clamp(5) }).id).toMatch(
      /^clamp@/,
    );
  });

  it("hashes the validation projection only: renamed nested types, labels and extra columns keep the id", () => {
    // Pinned: a recorded id must survive toolchain upgrades (serializer version, shape)
    expect(rewriteRowsStep(fx.RwChat, { field: "turns", map: clamp(5) }).id).toBe(
      "rewrite:rw_chats.turns@2a30f99e",
    );
    const a = rewriteRowsStep(fx.RwNestedA, { field: "part", map: (v) => v });
    const b = rewriteRowsStep(fx.RwNestedB, { field: "part", map: (v) => v });
    expect(b.id).toBe(a.id);
    // The whole-row form covers every column: an added column reschedules it
    expect(rewriteRowsStep(fx.RwNestedB, { map: (r) => r }).id).not.toBe(
      rewriteRowsStep(fx.RwNestedA, { map: (r) => r }).id,
    );
    // ... a label does not
    expect(rewriteRowsStep(fx.RwChat, { map: (r) => r }).id).toBe(
      rewriteRowsStep(fx.RwChatLabeled, { map: (r) => r }).id,
    );
  });

  it("refuses a primary-key field and a relation", () => {
    expect(() => rewriteRowsStep(fx.RwChat, { field: "id", map: (v) => v })).toThrow(
      /"rw_chats.id" is a primary-key field/,
    );
    expect(() => rewriteRowsStep(fx.RwNote, { field: "owner", map: (v) => v })).toThrow(
      /"rw_notes.owner" is a relation/,
    );
    expect(() => rewriteRowsStep(fx.RwNote, { field: "ownerId", map: (v) => v })).not.toThrow();
  });

  it("refuses an unknown field, a type without @db.table and a bad batchSize", () => {
    expect(() => rewriteRowsStep(fx.RwChat, { field: "nope", map: (v) => v })).toThrow(
      /"rw_chats" has no field "nope"/,
    );
    expect(() => rewriteRowsStep(fx.RwChat.type.props.get("turns"), { map: (r) => r })).toThrow(
      /@db.table/,
    );
    expect(() => rewriteRowsStep(fx.RwChat, { map: (r) => r, batchSize: 0 })).toThrow(/batchSize/);
  });

  it("a changed limit makes the step pending again; unchanged metadata stays up to date", async () => {
    const v1 = rewriteRowsStep(fx.RwChat, { field: "turns", map: clamp(5) });
    expect((await syncSchema(space, [fx.RwChat], { dataSteps: [v1] })).dataSteps?.ran).toEqual([
      v1.id,
    ]);
    const again = rewriteRowsStep(fx.RwChatLabeled, { field: "turns", map: clamp(5) });
    const second = await syncSchema(space, [fx.RwChatLabeled], { dataSteps: [again] });
    expect(second.dataSteps).toEqual({ ran: [], pending: [] });

    const v2 = rewriteRowsStep(fx.RwChatV2, { field: "turns", map: clamp(3) });
    const plan = await planSchema(space, [fx.RwChatV2], { dataSteps: [v1, v2] });
    expect(plan.pendingDataSteps).toEqual([v2.id]);
  });
});

describe("[sqlite] rewriteRowsStep — rewriting", () => {
  it("rewrites in primary-key batches and writes only the changed rows", async () => {
    await syncSchema(space, [fx.RwChat]);
    const old = space.getTable(fx.RwChat) as any;
    await old.insertMany(
      [1, 2, 3, 4, 5, 6, 7].map((id) => ({
        id,
        title: `t${id}`,
        turns: id % 3 === 0 ? ["a", "b", "c", "d", "e"] : ["a"],
      })),
    );

    const table = space.getTable(fx.RwChatV2) as any;
    const findMany = vi.spyOn(table, "findMany");
    const bulkUpdate = vi.spyOn(table, "bulkUpdate");
    const step = rewriteRowsStep(fx.RwChatV2, { field: "turns", map: clamp(3), batchSize: 2 });
    const result = await syncSchema(space, [fx.RwChatV2], { dataSteps: [step] });

    expect(result.dataSteps?.ran).toEqual([step.id]);
    expect(result.dataSteps?.notes).toEqual({ [step.id]: "rewrote 2 of 7 rows" });
    // 7 rows in batches of 2: four reads, by key
    expect(findMany).toHaveBeenCalledTimes(4);
    expect(findMany.mock.calls[0]![0]).toEqual({
      filter: {},
      controls: { $sort: { id: 1 }, $limit: 2 },
    });
    expect(findMany.mock.calls[1]![0]).toMatchObject({ filter: { id: { $gt: 2 } } });
    // Only rows 3 and 6 changed
    expect(bulkUpdate.mock.calls.map(([patches]) => patches)).toEqual([
      [{ id: 3, turns: ["c", "d", "e"] }],
      [{ id: 6, turns: ["c", "d", "e"] }],
    ]);
    const rows = await table.findMany({ controls: { $sort: { id: 1 } } });
    expect(rows.map((r: any) => r.turns.length)).toEqual([1, 1, 3, 1, 1, 3, 1]);
    expect(rows.every((r: any) => r.title === `t${r.id}`)).toBe(true);
  });

  it("whole-row form: changed top-level fields only, the key never", async () => {
    await syncSchema(space, [fx.RwChat]);
    const table = space.getTable(fx.RwChat) as any;
    await table.insertMany([
      { id: 1, title: "  padded ", turns: [] },
      { id: 2, title: "clean", turns: [] },
    ]);
    const bulkUpdate = vi.spyOn(table, "bulkUpdate");
    const step = rewriteRowsStep(fx.RwChat, {
      map: (row: any) => ({ ...row, id: 99, title: row.title.trim() }),
    });
    await syncSchema(space, [fx.RwChat], { dataSteps: [step] });
    expect(bulkUpdate.mock.calls.map(([patches]) => patches)).toEqual([
      [{ id: 1, title: "padded" }],
    ]);
    expect((await table.findById(1)).title).toBe("padded");
    expect(await table.findById(99)).toBeNull();
  });

  it("pages a composite primary key", async () => {
    await syncSchema(space, [fx.RwPair]);
    const table = space.getTable(fx.RwPair) as any;
    const keys = [
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 2],
    ];
    await table.insertMany(keys.map(([a, b]) => ({ a, b, v: "x" })));
    const seen: string[] = [];
    const step = rewriteRowsStep(fx.RwPair, {
      field: "v",
      batchSize: 2,
      map: (v, row: any) => {
        seen.push(`${row.a}.${row.b}`);
        return `${v}${row.a}${row.b}`;
      },
    });
    const result = await syncSchema(space, [fx.RwPair], { dataSteps: [step] });
    expect(seen).toEqual(["1.1", "1.2", "1.3", "2.1", "2.2"]);
    expect(result.dataSteps?.notes?.[step.id]).toBe("rewrote 5 of 5 rows");
    expect((await table.findMany({})).map((r: any) => r.v).toSorted()).toEqual([
      "x11",
      "x12",
      "x13",
      "x21",
      "x22",
    ]);
  });

  it("a row the map breaks fails the step: nothing is written, the step stays pending", async () => {
    await syncSchema(space, [fx.RwChat]);
    const table = space.getTable(fx.RwChat) as any;
    await table.insertMany([
      { id: 1, title: "a", turns: ["1"] },
      { id: 2, title: "b", turns: ["1"] },
    ]);
    const step = rewriteRowsStep(fx.RwChatV2, {
      field: "turns",
      batchSize: 1,
      map: (turns, row: any) => (row.id === 2 ? ["1", "2", "3", "4"] : [...turns, "x"]),
    });
    await expect(syncSchema(space, [fx.RwChatV2], { dataSteps: [step] })).rejects.toThrow();
    expect((await table.findById(1)).turns).toEqual(["1"]);
    expect(
      (await planSchema(space, [fx.RwChatV2], { dataSteps: [step] })).pendingDataSteps,
    ).toEqual([step.id]);
  });
});
