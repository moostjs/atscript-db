import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbSpace } from "../index";
import { SchemaSync, type TDataStep } from "../sync";
import type { TDbObjectKind } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

// `result.dataSteps.pending` (0.1.174) lists the passed steps that are not
// recorded after the run — the ones a later sync still runs — and agrees with
// `plan().pendingDataSteps`. Before 0.1.174 it listed every step this call did
// not run, so steps an earlier sync recorded showed up as pending again.

let UsersTable: any;
/** A managed view over a source that is neither in the inventory nor in the database. */
let VcOverLegacy: any;

beforeAll(async () => {
  await prepareFixtures();
  UsersTable = (await import("./fixtures/test-table.as")).UsersTable;
  VcOverLegacy = (await import("./fixtures/view-chain.as")).VcOverLegacy;
});

/**
 * Mock adapter whose table DDL fails while `ddlFails` is set, over a database
 * that holds no object sync did not create (pre-flight refuses a view over one).
 */
class FlakyDdlAdapter extends MockAdapter {
  static ddlFails = false;
  async getObjectKind(): Promise<TDbObjectKind | undefined> {
    return undefined;
  }
  override async ensureTable(): Promise<void> {
    if (FlakyDdlAdapter.ddlFails && this._table.tableName !== "__atscript_control") {
      throw new Error("DDL failed");
    }
  }
}

function setup() {
  FlakyDdlAdapter.ddlFails = false;
  const space = new DbSpace(() => new FlakyDdlAdapter());
  return new SchemaSync(space);
}

/** Steps `ids`, each logging its id to `calls`; the ids in `failing` throw. */
function stepsOf(ids: string[], calls: string[], failing = new Set<string>()): TDataStep[] {
  return ids.map((id) => ({
    id,
    run: () => {
      if (failing.has(id)) throw new Error(`${id} failed`);
      calls.push(id);
    },
  }));
}

describe("SchemaSync dataSteps report", () => {
  it("an up-to-date run reports nothing pending", async () => {
    const sync = setup();
    const calls: string[] = [];
    const steps = stepsOf(["a", "b"], calls);
    const first = await sync.run([UsersTable], { dataSteps: steps });
    expect(first.dataSteps).toEqual({ ran: ["a", "b"], pending: [] });

    const again = await sync.run([UsersTable], { dataSteps: steps });
    expect(again.status).toBe("up-to-date");
    expect(again.dataSteps).toEqual({ ran: [], pending: [] });
    expect((await sync.plan([UsersTable], { dataSteps: steps })).pendingDataSteps).toEqual([]);
    expect(calls).toEqual(["a", "b"]);
  });

  it("a resumed run does not report the steps an earlier run recorded", async () => {
    const sync = setup();
    const calls: string[] = [];
    await expect(
      sync.run([UsersTable], { dataSteps: stepsOf(["a", "b", "c"], calls, new Set(["b"])) }),
    ).rejects.toThrow("b failed");
    expect(calls).toEqual(["a"]);

    const steps = stepsOf(["a", "b", "c"], calls);
    expect((await sync.plan([UsersTable], { dataSteps: steps })).pendingDataSteps).toEqual([
      "b",
      "c",
    ]);
    const resumed = await sync.run([UsersTable], { dataSteps: steps });
    expect(resumed.status).toBe("synced");
    expect(resumed.dataSteps).toEqual({ ran: ["b", "c"], pending: [] });
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("a failing step and the steps after it stay pending", async () => {
    const sync = setup();
    const calls: string[] = [];
    await sync.run([UsersTable], { dataSteps: stepsOf(["a"], calls) });

    // The schema is up to date: the run executes only the unrecorded steps
    await expect(
      sync.run([UsersTable], { dataSteps: stepsOf(["a", "b", "c"], calls, new Set(["b"])) }),
    ).rejects.toThrow("b failed");
    const plan = await sync.plan([UsersTable], { dataSteps: stepsOf(["a", "b", "c"], calls) });
    expect(plan.status).toBe("changes-needed");
    expect(plan.pendingDataSteps).toEqual(["b", "c"]);
    expect(calls).toEqual(["a"]);
  });

  it("a refused run leaves exactly the unrecorded steps pending", async () => {
    const sync = setup();
    const calls: string[] = [];
    await sync.run([UsersTable], { dataSteps: stepsOf(["a"], calls) });

    const refused = await sync.run([UsersTable, VcOverLegacy], {
      onError: "silent",
      dataSteps: stepsOf(["a", "b"], calls),
    });
    expect(refused.status).toBe("refused");
    expect(refused.entries.find((e) => e.name === "vc_over_legacy")?.refused).toBe(true);
    expect(refused.dataSteps).toEqual({ ran: [], pending: ["b"] });
    expect(calls).toEqual(["a"]);
  });

  it("a run with an errored entry leaves exactly the unrecorded steps pending", async () => {
    const sync = setup();
    const calls: string[] = [];
    await sync.run([UsersTable], { dataSteps: stepsOf(["a"], calls) });

    FlakyDdlAdapter.ddlFails = true;
    const failed = await sync.run([UsersTable], {
      force: true,
      onError: "silent",
      dataSteps: stepsOf(["a", "b"], calls),
    });
    expect(failed.status).toBe("failed");
    expect(failed.dataSteps).toEqual({ ran: [], pending: ["b"] });
    expect(calls).toEqual(["a"]);
  });
});
