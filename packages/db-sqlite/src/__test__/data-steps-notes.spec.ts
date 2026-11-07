import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { planSchema, SchemaSync, syncSchema } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.175 a data step may return `{ note }` — stored with its record
// (the record inserted first is updated in the step's transaction) and
// reported in `dataSteps.notes` — and may set `onError: "warn"`: a failure is
// logged and listed in `dataSteps.failed`, rolled back, not recorded, and the
// next step runs. SQLite runs each step in a real transaction.

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
const run = () => undefined;
const silent = { error: vi.fn(), warn() {}, log() {}, info() {}, debug() {} };

/** The stored record of a step, parsed. */
async function record(id: string): Promise<Record<string, unknown> | null> {
  const store = (new SchemaSync(space) as any).store;
  await store.ensureControlTable();
  const value = await store.readControlValue(`data_step:${id}`);
  return value === null ? null : JSON.parse(value);
}

describe("[sqlite] data step notes", () => {
  it("stores a step's note with its record and reports it", async () => {
    const real = vi.spyOn(
      Object.getPrototypeOf((new SchemaSync(space) as any).store),
      "inRealTransaction",
    );
    const result = await syncSchema(space, [fx.CioNote], {
      dataSteps: [
        { id: "raise", run: () => ({ note: "raised 2 users" }) },
        { id: "quiet", run: () => undefined },
      ],
    });
    expect(await real.mock.results[0]!.value).toBe(true);
    real.mockRestore();
    expect(result.dataSteps).toEqual({
      ran: ["raise", "quiet"],
      pending: [],
      notes: { raise: "raised 2 users" },
    });
    expect(await record("raise")).toMatchObject({ note: "raised 2 users" });
    expect(await record("quiet")).not.toHaveProperty("note");
  });

  it("truncates a long note with a marker", async () => {
    const result = await syncSchema(space, [fx.CioNote], {
      dataSteps: [{ id: "long", run: () => ({ note: "x".repeat(5000) }) }],
    });
    const note = result.dataSteps!.notes!.long;
    expect(note).toHaveLength(4096);
    expect(note.endsWith("… [truncated]")).toBe(true);
    expect((await record("long"))?.note).toBe(note);
  });
});

describe("[sqlite] data step onError", () => {
  it('a failing "warn" step is rolled back and not recorded; later steps run; the next sync retries it', async () => {
    let attempts = 0;
    const steps = [
      {
        id: "flaky",
        onError: "warn" as const,
        run: async () => {
          attempts++;
          await notes().insertOne({ id: 7, title: "flaky" });
          if (attempts === 1) throw new Error("boom");
          return { note: "second try" };
        },
      },
      { id: "next", run: async () => void (await notes().insertOne({ id: 8, title: "next" })) },
    ];
    silent.error.mockClear();
    const first = await syncSchema(space, [fx.CioNote], { dataSteps: steps, logger: silent });
    expect(first.status).toBe("synced");
    expect(first.dataSteps?.ran).toEqual(["next"]);
    expect(first.dataSteps?.pending).toEqual(["flaky"]);
    expect(first.dataSteps?.failed).toHaveLength(1);
    expect(first.dataSteps?.failed?.[0]?.id).toBe("flaky");
    expect(first.dataSteps?.failed?.[0]?.error).toBeInstanceOf(Error);
    expect((first.dataSteps!.failed![0]!.error as Error).message).toBe("boom");
    expect(silent.error).toHaveBeenCalledWith(
      '[schema-sync] data step "flaky" failed (onError: "warn") — not recorded, the next sync runs it again:',
      "boom",
    );
    expect(await notes().findById(7)).toBeNull();
    expect(await notes().findById(8)).not.toBeNull();
    expect(await record("flaky")).toBeNull();
    expect((await planSchema(space, [fx.CioNote], { dataSteps: steps })).pendingDataSteps).toEqual([
      "flaky",
    ]);

    // The schema is up to date: only the failed step runs again
    const second = await syncSchema(space, [fx.CioNote], { dataSteps: steps, logger: silent });
    expect(second.status).toBe("synced");
    expect(second.dataSteps).toEqual({
      ran: ["flaky"],
      pending: [],
      notes: { flaky: "second try" },
    });
    expect(await notes().findById(7)).not.toBeNull();
    expect(attempts).toBe(2);
  });

  it('a failing "warn" step alone still reports "synced" when the schema is up to date', async () => {
    await syncSchema(space, [fx.CioNote]);
    const result = await syncSchema(space, [fx.CioNote], {
      logger: silent,
      dataSteps: [
        {
          id: "bad",
          onError: "warn",
          run: () => {
            throw new Error("nope");
          },
        },
      ],
    });
    expect(result.status).toBe("synced");
    expect(result.dataSteps?.ran).toEqual([]);
    expect(result.dataSteps?.pending).toEqual(["bad"]);
  });

  it('refuses "warn" on a beforeConstraints step, and an unknown onError', async () => {
    await expect(
      syncSchema(space, [fx.CioNote], {
        dataSteps: [{ id: "early", phase: "beforeConstraints", onError: "warn", run }],
      }),
    ).rejects.toThrow(/cannot use onError "warn" with phase "beforeConstraints"/);
    await expect(
      syncSchema(space, [fx.CioNote], {
        dataSteps: [{ id: "odd", onError: "log" as never, run }],
      }),
    ).rejects.toThrow(/unknown onError "log"/);
  });

  it('a failing "throw" step still stops the run', async () => {
    const calls: string[] = [];
    await expect(
      syncSchema(space, [fx.CioNote], {
        dataSteps: [
          {
            id: "fatal",
            onError: "throw",
            run: () => {
              throw new Error("stop");
            },
          },
          { id: "after", run: () => void calls.push("after") },
        ],
      }),
    ).rejects.toThrow("stop");
    expect(calls).toEqual([]);
  });
});
