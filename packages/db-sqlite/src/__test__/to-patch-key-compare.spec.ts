import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { caught, prepareFixtures } from "./test-utils";

// A nested TO patch always patches the row the STORED foreign key names: a
// payload that also changes that key, or a nested object whose key names a
// DIFFERENT stored row, is refused — also when that other row exists.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/composite-insert-id.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const types = Object.values(fx).filter((v) => typeof v === "function");
  expect((await new SchemaSync(space).run(types as never, { force: true })).status).toBe("synced");
});

afterEach(() => {
  driver.close();
});

const t = (type: unknown) => space.getTable(type as never) as any;

async function seed() {
  await t(fx.CidPub).insertOne({ pub: "p1", label: "one" });
  await t(fx.CidPub).insertOne({ pub: "p2", label: "two" });
  const { insertedId } = await t(fx.CidPubKid).insertOne({ note: "k", parentPub: "p1" });
  return insertedId;
}

const labels = async () =>
  (await t(fx.CidPub).findMany({ filter: {}, controls: { $sort: { pub: 1 } } })).map(
    (r: { pub: string; label: string }) => [r.pub, r.label],
  );

describe("nested TO patch against the stored foreign key", () => {
  it("a changed foreign key naming another existing row is refused", async () => {
    const id = await seed();
    const error = await caught(
      t(fx.CidPubKid).updateOne({ id, parentPub: "p2", parent: { label: "x" } }),
    );
    expect(error.code).toBe("INVALID_QUERY");
    expect((await t(fx.CidPubKid).findById(id)).parentPub).toBe("p1");
    expect(await labels()).toEqual([
      ["p1", "one"],
      ["p2", "two"],
    ]);
  });

  it("a nested key naming another existing row is refused", async () => {
    const id = await seed();
    const error = await caught(
      t(fx.CidPubKid).updateOne({ id, parent: { pub: "p2", label: "x" } }),
    );
    expect(error.code).toBe("INVALID_QUERY");
    expect(await labels()).toEqual([
      ["p1", "one"],
      ["p2", "two"],
    ]);
  });

  it("echoing the stored key patches the referenced row", async () => {
    const id = await seed();
    await t(fx.CidPubKid).updateOne({ id, parentPub: "p1", parent: { pub: "p1", label: "y" } });
    expect(await labels()).toEqual([
      ["p1", "y"],
      ["p2", "two"],
    ]);
  });
});
