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
    const steps = [{ id: "slow", run: () => new Promise<void>((r) => setTimeout(r, 150)) }];
    const a = syncSchema(space, [fx.CioNote], {
      dataSteps: steps,
      podId: "pod-a",
      pollIntervalMs: 10,
    });
    // Start pod-b once pod-a holds the lock (a fixed delay raced on a busy machine).
    await vi.waitFor(() => expect(aLocked).toBe(true), { interval: 5, timeout: 5000 });
    await new Promise((r) => setTimeout(r, 10));
    const b = syncSchema(space, [fx.CioNote], {
      dataSteps: steps,
      podId: "pod-b",
      pollIntervalMs: 10,
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.dataSteps?.ran).toEqual(["slow"]);
    expect(rb.status).toBe("synced-by-peer");
    expect(rb.dataSteps).toEqual({ ran: [], pending: [] });
    spy.mockRestore();
    expect(lockWrites).toEqual([]);
  });
});
