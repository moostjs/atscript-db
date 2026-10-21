import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { planSchema, syncSchema } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.165 `syncSchema(space, types, { dataSteps })` runs one-time data
// steps after the schema DDL, under the sync lock: each in its own
// transaction, recorded in `__atscript_control` once it commits, never run
// again. `planSchema` lists the pending ones.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/created-insert-only.as");
});

beforeEach(() => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
});

afterEach(() => {
  driver.close();
});

const notes = () => space.getTable(fx.CioNote) as any;

describe("[sqlite] syncSchema dataSteps", () => {
  it("runs each step once, after the DDL, in order", async () => {
    const calls: string[] = [];
    const steps = [
      {
        id: "seed-notes",
        run: async (s: DbSpace) => {
          calls.push("seed-notes");
          await (s.getTable(fx.CioNote) as any).insertOne({ id: 1, title: "a" });
        },
      },
      {
        id: "retitle",
        run: async () => {
          calls.push("retitle");
          await notes().updateOne({ id: 1, title: "b" });
        },
      },
    ];
    const first = await syncSchema(space, [fx.CioNote], { dataSteps: steps });
    expect(first.status).toBe("synced");
    expect(first.dataSteps).toEqual({ ran: ["seed-notes", "retitle"], pending: [] });
    expect((await notes().findById(1)).title).toBe("b");

    const second = await syncSchema(space, [fx.CioNote], { dataSteps: steps });
    expect(second.status).toBe("up-to-date");
    expect(calls).toEqual(["seed-notes", "retitle"]);
  });

  it("a step added later runs on the next sync even when the schema is unchanged", async () => {
    await syncSchema(space, [fx.CioNote]);
    const plan = await planSchema(space, [fx.CioNote], {
      dataSteps: [{ id: "late", run: () => undefined }],
    });
    expect(plan.status).toBe("changes-needed");
    expect(plan.pendingDataSteps).toEqual(["late"]);
    let ran = 0;
    const result = await syncSchema(space, [fx.CioNote], {
      dataSteps: [{ id: "late", run: () => void ran++ }],
    });
    expect(result.status).toBe("synced");
    expect(result.dataSteps?.ran).toEqual(["late"]);
    expect(ran).toBe(1);
  });

  it("a failing step rolls back, is not recorded, and runs again next time", async () => {
    let attempts = 0;
    const step = {
      id: "flaky",
      run: async () => {
        attempts++;
        await notes().insertOne({ id: 7, title: "x" });
        if (attempts === 1) throw new Error("boom");
      },
    };
    await expect(syncSchema(space, [fx.CioNote], { dataSteps: [step] })).rejects.toThrow("boom");
    expect(await notes().findById(7)).toBeNull();
    const result = await syncSchema(space, [fx.CioNote], { dataSteps: [step] });
    expect(result.dataSteps?.ran).toEqual(["flaky"]);
    expect(await notes().findById(7)).not.toBeNull();
  });

  it("refuses duplicate step ids", async () => {
    const run = () => undefined;
    await expect(
      syncSchema(space, [fx.CioNote], {
        dataSteps: [
          { id: "a", run },
          { id: "a", run },
        ],
      }),
    ).rejects.toThrow(/duplicate/i);
  });
});
