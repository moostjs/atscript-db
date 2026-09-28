import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { computeTableHash, computeViewSnapshot } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// SQLite defines no `viewRenderRevision()` (since 0.1.137), so a managed
// view's snapshot — and the hash sync compares — must stay byte-identical to
// 0.1.136: no view is recreated by the upgrade. The pinned hashes were
// computed by 0.1.136.

const PINNED: Record<string, string> = {
  SvCustomerList: "-2ed4d157",
  SvOrdersLeft: "589363e2",
  SvOrdersInner: "-6800fb19",
  SvOrdersLeftParis: "59845f86",
  SvCustomerGeo: "4f7ae51b",
  SvCityTotals: "-4211be85",
  AdCityStats: "-3ce5d79b",
  AdBusyCities: "-10a88104",
};

let space: DbSpace;
let types: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  types = {
    ...(await import("./fixtures/views.as")),
    ...(await import("./fixtures/agg-distinct.as")),
  };
  space = new DbSpace(() => new SqliteAdapter(new BetterSqlite3Driver(":memory:")));
});

describe("SQLite view snapshots without a render revision (since 0.1.137)", () => {
  it("carry no renderRevision key and hash exactly as in 0.1.136", () => {
    const hashes: Record<string, string> = {};
    for (const name of Object.keys(PINNED)) {
      const snap = computeViewSnapshot(space.getView(types[name]));
      expect(snap, name).not.toHaveProperty("renderRevision");
      hashes[name] = computeTableHash(snap);
    }
    expect(hashes).toEqual(PINNED);
  });
});
