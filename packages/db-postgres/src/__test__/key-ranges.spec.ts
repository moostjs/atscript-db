import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// An integer id outside its key column's SMALLINT / INTEGER / BIGINT range
// makes `prepareId` throw, so a by-id read matches no row. Over a recording driver.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/key-ranges.as");
});

const outOfRangeError = {
  code: "INVALID_QUERY",
  message: expect.stringMatching(/Numeric value out of range/),
};

function tableOf(type: unknown) {
  const driver = createMockDriver();
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(type as never, adapter) as any;
  const prepare = (field: string, id: unknown) => adapter.prepareId(id, table.flatMap.get(field));
  /** Whether a statement read or wrote the table. */
  const touched = () => driver.calls.some((c) => c.sql.includes(`"${table.tableName}"`));
  return { table, driver, prepare, touched };
}

function outOfRange(run: () => unknown) {
  expect(run).toThrow(expect.objectContaining(outOfRangeError));
}

describe("[postgres] prepareId — the integer key column's range", () => {
  it.each([[2147483647], [-2147483648], ["2147483647"], [" -2147483648 "], ["+5"], [2147483647n]])(
    "INTEGER keeps %s",
    (id) => {
      expect(tableOf(fx.KrInt).prepare("id", id)).toBe(id);
    },
  );

  it.each([[2147483648], [-2147483649], ["2147483648"], ["3000000000"], [2147483648n]])(
    "INTEGER refuses %s",
    (id) => {
      outOfRange(() => tableOf(fx.KrInt).prepare("id", id));
    },
  );

  it("SMALLINT (`number.int.int16`)", () => {
    const { prepare } = tableOf(fx.KrSmall);
    expect(prepare("id", 32767)).toBe(32767);
    expect(prepare("id", "-32768")).toBe("-32768");
    outOfRange(() => prepare("id", 32768));
    outOfRange(() => prepare("id", "-32769"));
  });

  it("BIGINT (`@db.default.increment`): exact at the boundaries, a 20-digit id refused", () => {
    const { prepare } = tableOf(fx.KrSeq);
    expect(prepare("id", 3000000000)).toBe(3000000000);
    expect(prepare("id", "9223372036854775807")).toBe("9223372036854775807");
    expect(prepare("id", "-9223372036854775808")).toBe("-9223372036854775808");
    outOfRange(() => prepare("id", "9223372036854775808"));
    outOfRange(() => prepare("id", "-9223372036854775809"));
    outOfRange(() => prepare("id", "12345678901234567890"));
    outOfRange(() => prepare("id", 2n ** 63n));
  });

  it("a nullable unique field and a foreign key take their column's type", () => {
    const ints = tableOf(fx.KrInt);
    expect(ints.prepare("code", 7)).toBe(7);
    outOfRange(() => ints.prepare("code", 3000000000));
    const items = tableOf(fx.KrItem);
    expect(items.prepare("ownerId", "2147483647")).toBe("2147483647");
    outOfRange(() => items.prepare("ownerId", 3000000000));
  });

  it("other columns and non-integer ids are untouched", () => {
    const plain = tableOf(fx.KrPlain);
    // DOUBLE PRECISION, an `@db.pg.type` override, TEXT
    expect(plain.prepare("id", "99999999999999999999")).toBe("99999999999999999999");
    expect(plain.prepare("id", 1e300)).toBe(1e300);
    expect(plain.prepare("code", 3000000000)).toBe(3000000000);
    expect(plain.prepare("ref", "99999999999999999999")).toBe("99999999999999999999");
    const ints = tableOf(fx.KrInt);
    expect(ints.prepare("id", 1.5)).toBe(1.5);
    expect(ints.prepare("id", "abc")).toBe("abc");
  });

  it("an integer `@db.pg.type` override, in any case", () => {
    const { prepare } = tableOf(fx.KrPlain);
    expect(prepare("small", 32767)).toBe(32767);
    outOfRange(() => prepare("small", 40000));
  });

  it("a view's key is not checked: its column has the source column's type", () => {
    // `id: KrSeq.id` is an INTEGER by its own type; the source column is the BIGINT of the increment
    const view = new DbSpace(() => new PostgresAdapter(createMockDriver())).getView(
      fx.KrSeqView,
    ) as any;
    expect(view.dbAdapter.prepareId(3000000000, view.flatMap.get("id"))).toBe(3000000000);
  });
});

describe("[postgres] by-id reads — an out-of-range integer key matches no row", () => {
  it.each([[3000000000], ["3000000000"], ["-2147483649"]])(
    "INTEGER %j: null, no statement",
    async (id) => {
      const { table, touched } = tableOf(fx.KrInt);
      expect(table.resolveIdFilter(id)).toBeNull();
      expect(await table.findById(id)).toBeNull();
      expect(touched()).toBe(false);
    },
  );

  it("the boundary value is read", async () => {
    const { table, driver } = tableOf(fx.KrInt);
    expect(await table.findById("2147483647")).toBeNull();
    const select = driver.calls.find((c) => c.sql.includes('"kr_ints"'));
    expect(select?.params).toContain("2147483647");
  });

  it("composite keys: either part out of range is no read", async () => {
    const { table, touched } = tableOf(fx.KrItem);
    expect(await table.findById({ ownerId: 1, n: "40000" })).toBeNull();
    expect(await table.findById({ ownerId: "3000000000", n: 1 })).toBeNull();
    expect(touched()).toBe(false);
    await table.findById({ ownerId: 1, n: 7 });
    expect(touched()).toBe(true);
  });

  it("an insert or update keyed out of range is INVALID_QUERY, a delete deletes nothing — no statement", async () => {
    const { table, touched } = tableOf(fx.KrInt);
    await expect(table.insertOne({ id: 3000000000, code: null, label: "x" })).rejects.toMatchObject(
      outOfRangeError,
    );
    await expect(table.updateOne({ id: 3000000000, label: "x" })).rejects.toMatchObject(
      outOfRangeError,
    );
    expect(await table.deleteOne(3000000000)).toEqual({ deletedCount: 0 });
    expect(touched()).toBe(false);
  });
});

// A filter value outside its integer column's range passes the core guard;
// PostgreSQL's 22003 on it maps to INVALID_QUERY, as in `aggregate()`.
describe("[postgres] 22003 on a read or a mutation filter", () => {
  function failingWith(code: string) {
    const fail = () => {
      throw Object.assign(new Error("pg error"), { code });
    };
    const driver = createMockDriver({ allResult: fail, getResult: fail, runResponder: fail });
    const adapter = new PostgresAdapter(driver);
    return { adapter, table: new AtscriptDbTable(fx.KrInt as never, adapter) as any };
  }
  const filter = { id: 3000000000 };

  it.each<[string, (table: any, adapter: PostgresAdapter) => Promise<unknown>]>([
    ["findMany", (t) => t.findMany({ filter })],
    ["findOne", (t) => t.findOne({ filter })],
    ["count", (t) => t.count({ filter })],
    ["findManyWithCount", (t) => t.findManyWithCount({ filter })],
    // the `$with` loader's page
    [
      "findManyPerPartition",
      (_, a) => a.findManyPerPartition({ filter, controls: { $limit: 2 } }, ["code"]),
    ],
    ["search", (t) => t.search("cat", { filter })],
    ["searchWithCount", (t) => t.searchWithCount("cat", { filter })],
    ["updateMany", (t) => t.updateMany(filter, { label: "x" })],
    ["deleteMany", (t) => t.deleteMany(filter)],
  ])("%s", async (_, run) => {
    const { table, adapter } = failingWith("22003");
    await expect(run(table, adapter)).rejects.toMatchObject(outOfRangeError);
  });

  it("other driver errors pass as they are", async () => {
    const { table } = failingWith("42P01");
    await expect(table.findMany({ filter })).rejects.toMatchObject({
      code: "42P01",
      message: "pg error",
    });
  });
});
