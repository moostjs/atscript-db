import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { SqliteAdapter } from "../sqlite-adapter";
import { prepareFixtures } from "./test-utils";

// Generated (`@db.default.uuid`) keys returned by insertOne / insertMany are
// the stored ids, so a later insert can use them as foreign keys — on the
// single-statement insert path (since 0.1.151: one row, no transaction) and
// the batch path, with the statement and INSERT-text caches warm, mixing rows
// whose key order differs (an explicit id first vs a generated id appended).

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/uuid-fk-chain.as");
});

describe("[sqlite] generated uuid keys feed foreign keys", () => {
  let driver: BetterSqlite3Driver;
  let space: DbSpace;
  let tenants: any;
  let departments: any;
  let members: any;

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    space = new DbSpace(() => new SqliteAdapter(driver));
    tenants = space.getTable(fx.UfTenant);
    departments = space.getTable(fx.UfDepartment);
    members = space.getTable(fx.UfMember);
    for (const t of [tenants, departments, members]) await t.ensureTable();
  });

  afterEach(() => driver.close());

  const stored = async (table: any, id: string) =>
    (await table.findOne({ filter: { id }, controls: {} }))?.id;

  it("insertOne ids are the stored ids and work as FKs (twice — warm caches, after a reset)", async () => {
    for (let round = 0; round < 2; round++) {
      const a = (await tenants.insertOne({ name: "Acme" })).insertedId as string;
      const b = (await tenants.insertOne({ name: "Globex" })).insertedId as string;
      await tenants.insertOne({ id: "_global", name: "_global" });
      expect(a).not.toBe(b);
      expect(await stored(tenants, a)).toBe(a);
      expect(await stored(tenants, b)).toBe(b);

      const dA = (await departments.insertOne({ tenantId: a, name: "Eng" })).insertedId as string;
      const dB = (await departments.insertOne({ tenantId: b, name: "Ops" })).insertedId as string;
      expect(await stored(departments, dA)).toBe(dA);

      const m1 = await members.insertOne({ tenantId: a, departmentId: dA, name: "alice" });
      const m2 = await members.insertOne({ tenantId: b, departmentId: dB, name: "bob" });
      await members.insertOne({ tenantId: "_global", name: "root" });
      expect(await stored(members, m1.insertedId)).toBe(m1.insertedId);
      expect(await stored(members, m2.insertedId)).toBe(m2.insertedId);

      // A dangling FK still fails — the constraint is enforced.
      await expect(
        members.insertOne({ tenantId: "missing", departmentId: dA, name: "x" }),
      ).rejects.toMatchObject({ code: "FK_VIOLATION" });

      // Reset like an e2e harness does: children first.
      await members.deleteMany({});
      await departments.deleteMany({});
      await tenants.deleteMany({});
    }
  });

  it("insertMany ids are the stored ids, in order, and work as FKs", async () => {
    const { insertedIds } = await tenants.insertMany([
      { name: "t1" },
      { id: "fixed", name: "t2" },
      { name: "t3" },
    ]);
    expect(insertedIds[1]).toBe("fixed");
    for (const id of insertedIds) expect(await stored(tenants, id)).toBe(id);
    const depts = await departments.insertMany(
      insertedIds.map((tenantId: string, i: number) => ({ tenantId, name: `d${i}` })),
    );
    const rows = await members.insertMany(
      insertedIds.map((tenantId: string, i: number) => ({
        tenantId,
        departmentId: depts.insertedIds[i],
        name: `m${i}`,
      })),
    );
    expect(rows.insertedCount).toBe(3);
    // A single-row batch takes the single-statement path.
    const one = await members.insertMany([{ tenantId: insertedIds[0], name: "solo" }]);
    expect(await stored(members, one.insertedIds[0])).toBe(one.insertedIds[0]);
  });
});
