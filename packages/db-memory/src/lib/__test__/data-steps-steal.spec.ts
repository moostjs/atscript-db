import { SchemaSync, syncSchema } from "@atscript/db/sync";
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils";

// A run whose sync lock a peer took over still holds its list of unrecorded
// data steps (0.1.174). The memory adapter has no transactions: the step's
// record is checked right before it runs and inserted (insert-only) right
// after. A peer that recorded the step before is seen and the step is not run
// again; a peer that records it while it runs here is the remaining window —
// the step ran on both, and a warning says so. Either way the step is
// reported as done by the peer: neither `ran` nor `pending`.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/created-insert-only.as");
});

async function setup() {
  const space = createTestSpace();
  const peer = (new SchemaSync(space) as any).store;
  await peer.ensureControlTable();
  const warn = vi.fn();
  const logger = { error() {}, warn, log() {}, info() {}, debug() {} };
  return { space, peer, warn, logger };
}

describe("[memory] syncSchema dataSteps — a peer took the lock over", () => {
  it("a step a peer recorded before this run reached it is not run", async () => {
    const { space, peer, warn, logger } = await setup();
    const calls: string[] = [];
    const steps = [
      {
        id: "w",
        run: async () => {
          calls.push("w");
          await peer.insertControlValue("data_step:x", "{}");
        },
      },
      { id: "x", run: () => void calls.push("x") },
      { id: "y", run: () => void calls.push("y") },
    ];
    const result = await syncSchema(space, [fx.CioNote], { dataSteps: steps, logger });
    expect(calls).toEqual(["w", "y"]);
    expect(result.dataSteps).toEqual({ ran: ["w", "y"], pending: [] });
    expect(warn).toHaveBeenCalledWith(
      '[schema-sync] data step "x" was already recorded by another sync (it took the lock over) — not run again',
    );
  });

  it("a step a peer records while it runs here ran twice: reported, never recorded twice", async () => {
    const { space, peer, warn, logger } = await setup();
    const calls: string[] = [];
    const steps = [
      {
        id: "x",
        run: async () => {
          calls.push("x");
          await peer.insertControlValue("data_step:x", '{"peer":true}');
        },
      },
      { id: "y", run: () => void calls.push("y") },
    ];
    const result = await syncSchema(space, [fx.CioNote], { dataSteps: steps, logger });
    expect(calls).toEqual(["x", "y"]);
    expect(result.dataSteps).toEqual({ ran: ["y"], pending: [] });
    // The peer's record stands — this run's insert never overwrote it
    expect(await peer.readControlValue("data_step:x")).toBe('{"peer":true}');
    expect(warn).toHaveBeenCalledWith(
      '[schema-sync] data step "x" was recorded by another sync while this one ran it — it ran twice (the adapter has no transactions)',
    );
  });
});
