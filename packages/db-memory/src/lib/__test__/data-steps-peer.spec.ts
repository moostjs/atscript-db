import { syncSchema } from "@atscript/db/sync";
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

import { MemoryAdapter } from "../memory-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Review fix (0.1.165 data steps): a pod that waited for a peer holding the
// sync lock returns `synced-by-peer` once the peer applied the schema and
// every step — it does not take the lock in turn just because steps were
// passed (booting pods would otherwise serialize on it).

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/created-insert-only.as");
});

describe("[memory] syncSchema dataSteps — waiting pods", () => {
  it("a waiting pod returns synced-by-peer without taking the lock", async () => {
    const space = createTestSpace();
    const lockWrites: unknown[] = [];
    let aLocked = false;
    const { insertMany } = Object.getOwnPropertyDescriptors(MemoryAdapter.prototype);
    const spy = vi.spyOn(MemoryAdapter.prototype, "insertMany").mockImplementation(function (
      this: MemoryAdapter,
      rows: Array<Record<string, unknown>>,
    ) {
      for (const row of rows) {
        if (row.lockedBy === "pod-b") lockWrites.push(row);
        if (row.lockedBy === "pod-a") aLocked = true;
      }
      return (insertMany!.value as MemoryAdapter["insertMany"]).call(this, rows);
    });
    // pod-b starts from inside pod-a's step, so every read from then on is
    // pod-b's; the step holds until pod-b is past its quick check and polling
    // the lock (a fixed delay let a slow pod-b arrive after pod-a finished and
    // answer `up-to-date`).
    let bReads = 0;
    const countRead = (name: "findOne" | "findMany") => {
      const original = Object.getOwnPropertyDescriptor(MemoryAdapter.prototype, name)!.value;
      return vi.spyOn(MemoryAdapter.prototype, name).mockImplementation(function (
        this: MemoryAdapter,
        ...args: unknown[]
      ) {
        if (b) bReads++;
        return original.apply(this, args);
      });
    };
    const readSpies = [countRead("findOne"), countRead("findMany")];
    let b: ReturnType<typeof syncSchema> | undefined;
    const steps = [
      {
        id: "slow",
        run: async () => {
          if (b) return;
          b = syncSchema(space, [fx.CioNote], {
            dataSteps: steps,
            podId: "pod-b",
            pollIntervalMs: 10,
          });
          await vi.waitFor(() => expect(bReads).toBeGreaterThanOrEqual(8), {
            interval: 5,
            timeout: 5000,
          });
        },
      },
    ];
    const ra = await syncSchema(space, [fx.CioNote], {
      dataSteps: steps,
      podId: "pod-a",
      pollIntervalMs: 10,
    });
    expect(aLocked).toBe(true);
    const rb = await b!;
    expect(ra.dataSteps?.ran).toEqual(["slow"]);
    expect(rb.status).toBe("synced-by-peer");
    expect(rb.dataSteps).toEqual({ ran: [], pending: [] });
    spy.mockRestore();
    for (const s of readSpies) s.mockRestore();
    expect(lockWrites).toEqual([]);
  });
});
