import { DbSpace, UniquSelect, type AtscriptDbView, type DbQuery } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { Collection } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";

import {
  defineViewPruneCases,
  defineViewPruneSortCases,
  seedViewPrune,
} from "../../../../db/test-kit/view-prune-cases";
import { MongoAdapter } from "../mongo-adapter";
import { NULLS_FLAG_PREFIX } from "../mongo-sort";
import { mongoViewRead, stagesReadAny } from "../mongo-view-read";
import { prepareFixtures } from "./test-utils";

// View read pruning against a real MongoDB (mongodb-memory-server), since
// 0.1.153: a read that needs only some of a managed view's left joins runs
// the view's pipeline without their `$lookup` + `$unwind` on the entry
// collection — and returns exactly what the stored view returns.

let server: any;
let client: MongoClient;
let db: Db;
let pruned: DbSpace;
let plain: DbSpace;
let fx: Record<string, any>;
const logs: Array<{ label: string; pipeline: unknown }> = [];

class LoggingAdapter extends MongoAdapter {
  protected override _log(...args: unknown[]): void {
    logs.push({ label: String(args[0]), pipeline: args[1] });
  }
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-prune.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("view_prune");
  pruned = new DbSpace(() => new LoggingAdapter(db, client));
  plain = new DbSpace(() => new MongoAdapter(db, client, { viewJoinPruning: false }));
  const result = await new SchemaSync(pruned).run(
    [
      fx.VpRegion,
      fx.VpCustomer,
      fx.VpProduct,
      fx.VpStatus,
      fx.VpNote,
      fx.VpOrder,
      fx.VpOrderView,
      fx.VpEuView,
      fx.VpPartialView,
      fx.VpOrderIdView,
    ],
    { force: true },
  );
  expect(result.status).toBe("synced");
  await seedViewPrune(pruned, fx);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

const view = () => pruned.getView(fx.VpOrderView as never) as AtscriptDbView;
const lookups = (pipeline: unknown) =>
  (pipeline as Array<Record<string, any>>)
    .filter((stage) => stage.$lookup)
    .map((stage) => stage.$lookup.from as string);

/** The pipeline logged by one read. */
async function pipelineOf(fn: () => Promise<unknown>): Promise<{ label: string; pipeline: any }> {
  logs.length = 0;
  await fn();
  return logs.at(-1)!;
}

describe("MongoDB view read pruning — pipelines", () => {
  it("count runs on the entry collection with the non-unique lookup only", async () => {
    const { label, pipeline } = await pipelineOf(() => view().count());
    expect(label).toBe("aggregate (count) (pruned view)");
    expect(lookups(pipeline)).toEqual(["vp_statuses"]);
  });

  it("a selected joined column keeps its lookup chain", async () => {
    const { pipeline } = await pipelineOf(() =>
      view().findMany({ filter: {}, controls: { $select: ["id", "regionName"] } } as never),
    );
    expect(lookups(pipeline)).toEqual(["vp_customers", "vp_regions", "vp_statuses"]);
  });

  it("a read of every column reads the stored view", async () => {
    const { label } = await pipelineOf(() =>
      view().findMany({ filter: {}, controls: {} } as never),
    );
    expect(label).toBe("findMany");
  });

  it("aggregates run pruned", async () => {
    const { label, pipeline } = await pipelineOf(() =>
      view().aggregate({
        filter: {},
        controls: {
          $groupBy: ["status"],
          $select: ["status", { $fn: "count", $field: "*", $as: "n" }],
        },
      }),
    );
    expect(label).toBe("aggregate (pruned view)");
    expect(lookups(pipeline)).toEqual(["vp_statuses"]);
  });

  it("stages naming a dropped column fall back to the stored view", () => {
    const query = {
      filter: {},
      controls: { $select: new UniquSelect(["id"]) },
    } as unknown as DbQuery;
    const read = mongoViewRead(view(), query, "rows")!;
    expect(read.dropped).toContain("customerName");
    expect(stagesReadAny([{ $match: { customerName: "c1" } }], read.dropped)).toBe(true);
    expect(stagesReadAny([{ $project: { x: "$customerName" } }], read.dropped)).toBe(true);
    expect(stagesReadAny([{ $replaceRoot: { newRoot: "$$ROOT" } }], read.dropped)).toBe(true);
    expect(stagesReadAny([{ $match: { id: 1 } }, { $sort: { amount: 1 } }], read.dropped)).toBe(
      false,
    );
  });
});

describe("MongoDB view read pruning × NULL placement × tie-breaker", () => {
  const idView = () => pruned.getView(fx.VpOrderIdView as never) as AtscriptDbView;

  it("a placed sort on a joined key keeps that lookup only; flags sort, then drop after the page", async () => {
    const spy = vi.spyOn(Collection.prototype, "aggregate");
    try {
      const { label, pipeline } = await pipelineOf(() =>
        idView().findMany({
          filter: {},
          controls: {
            $select: ["id"],
            $sort: { customerName: -1 },
            $nulls: { customerName: "first" },
            $skip: 2,
            $limit: 5,
          },
        } as never),
      );
      expect(label).toBe("aggregate (findMany) (pruned view)");
      expect(lookups(pipeline)).toEqual(["vp_customers"]);
      const tail = (pipeline as Array<Record<string, any>>)
        .slice(-6)
        .map((st) => Object.keys(st)[0]);
      expect(tail).toEqual(["$addFields", "$sort", "$skip", "$limit", "$project", "$project"]);
      const sort = (pipeline as Array<Record<string, any>>).find((st) => st.$sort)!.$sort;
      // flag, key, then the primary-key tie-breaker in the last key's direction
      expect(sort).toEqual({ [`${NULLS_FLAG_PREFIX}0`]: -1, customerName: -1, id: -1 });
      expect(spy.mock.calls.at(-1)![1]).toMatchObject({ allowDiskUse: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("the @db.sort.nulls default flags the pruned read too", async () => {
    const { label, pipeline } = await pipelineOf(() =>
      idView().findMany({
        filter: {},
        controls: { $select: ["id"], $sort: { shipRegion: 1 } },
      } as never),
    );
    expect(label).toBe("aggregate (findMany) (pruned view)");
    expect(lookups(pipeline)).toEqual(["vp_regions"]);
    expect((pipeline as Array<Record<string, any>>).some((st) => st.$addFields)).toBe(true);
  });

  it("the null flags never trip the dropped-column scan", () => {
    const query = {
      filter: {},
      controls: {
        $select: new UniquSelect(["id"]),
        $sort: { amount: 1, id: 1 },
        $nulls: { amount: "last" },
      },
    } as unknown as DbQuery;
    const read = mongoViewRead(idView(), query, "rows")!;
    expect(read.dropped).toEqual(
      expect.arrayContaining(["customerName", "regionName", "shipRegion"]),
    );
    const flag = `${NULLS_FLAG_PREFIX}0`;
    const stages = [
      { $addFields: { [flag]: { $lte: ["$amount", null] } } },
      { $sort: { [flag]: 1, amount: 1, id: 1 } },
      { $project: { [flag]: 0 } },
    ];
    expect(stagesReadAny(stages, read.dropped)).toBe(false);
  });
});

defineViewPruneCases("MongoDB", () => ({ fx, pruned, plain }));
defineViewPruneSortCases("MongoDB", () => ({ fx, pruned, plain }));
