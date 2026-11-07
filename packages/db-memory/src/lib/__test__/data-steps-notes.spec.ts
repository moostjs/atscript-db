import { SchemaSync, planSchema, syncSchema } from "@atscript/db/sync";
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.175 (data step notes and `onError: "warn"`), in a pass-through
// transaction: the in-memory adapter has none, so the record is written after
// the step — with its note — and a failed step is simply not recorded. Its
// writes are not rolled back (no transactions): the next sync runs it again.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/created-insert-only.as");
});

const silent = { error: vi.fn(), warn() {}, log() {}, info() {}, debug() {} };

async function record(space: any, id: string): Promise<Record<string, unknown> | null> {
  const store = (new SchemaSync(space) as any).store;
  await store.ensureControlTable();
  const value = await store.readControlValue(`data_step:${id}`);
  return value === null ? null : JSON.parse(value);
}

describe("[memory] data step notes and onError", () => {
  it("stores a note (truncated past 4096 characters) in the record written after the step", async () => {
    const space = createTestSpace();
    const real = vi.spyOn(
      Object.getPrototypeOf((new SchemaSync(space) as any).store),
      "inRealTransaction",
    );
    const result = await syncSchema(space, [fx.CioNote], {
      dataSteps: [
        { id: "short", run: () => ({ note: "3 rows" }) },
        { id: "long", run: async () => ({ note: "y".repeat(9000) }) },
      ],
    });
    expect(await real.mock.results[0]!.value).toBe(false);
    real.mockRestore();
    expect(result.dataSteps?.ran).toEqual(["short", "long"]);
    expect(result.dataSteps?.notes?.short).toBe("3 rows");
    expect(result.dataSteps?.notes?.long).toHaveLength(4096);
    expect(result.dataSteps?.notes?.long.endsWith("… [truncated]")).toBe(true);
    expect(await record(space, "short")).toMatchObject({ note: "3 rows" });
    expect((await record(space, "long"))?.note).toBe(result.dataSteps?.notes?.long);
  });

  it('a failing "warn" step is not recorded, later steps run, the next sync retries it', async () => {
    const space = createTestSpace();
    let attempts = 0;
    const calls: string[] = [];
    const steps = [
      {
        id: "flaky",
        onError: "warn" as const,
        run: () => {
          calls.push("flaky");
          if (++attempts === 1) throw new Error("boom");
        },
      },
      { id: "next", run: () => void calls.push("next") },
    ];
    const first = await syncSchema(space, [fx.CioNote], { dataSteps: steps, logger: silent });
    expect(first.dataSteps?.ran).toEqual(["next"]);
    expect(first.dataSteps?.pending).toEqual(["flaky"]);
    expect(first.dataSteps?.failed?.map((f) => f.id)).toEqual(["flaky"]);
    expect(await record(space, "flaky")).toBeNull();
    expect((await planSchema(space, [fx.CioNote], { dataSteps: steps })).pendingDataSteps).toEqual([
      "flaky",
    ]);

    const second = await syncSchema(space, [fx.CioNote], { dataSteps: steps, logger: silent });
    expect(second.dataSteps).toEqual({ ran: ["flaky"], pending: [] });
    expect(calls).toEqual(["flaky", "next", "flaky"]);
  });
});
