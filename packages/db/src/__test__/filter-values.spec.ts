import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbSpace } from "../table/db-space";
import type { AtscriptDbTable } from "../table/db-table";
import type { TDbFieldMeta } from "../types";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

/**
 * Filter values are checked against the field's declared type (since
 * 0.1.147): a value that cannot denote the type is `INVALID_QUERY` with the
 * field as `path`, before any adapter call — on every read, aggregate,
 * mutation filter and relational-predicate operand.
 */

/** Relational-style mock that renders relational predicates. */
class RelAdapter extends MockAdapter {
  override supportsRelationFilters(): boolean {
    return true;
  }
}

/** Document-style mock: arrays / nested objects addressable. */
class DocAdapter extends NestedMockAdapter {
  override supportsRelationFilters(): boolean {
    return true;
  }
  override canFilterField(fd: TDbFieldMeta): boolean {
    return !fd.encrypted;
  }
}

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/filter-values.as");
});

function tables(factory: () => MockAdapter = () => new RelAdapter()) {
  const adapters: MockAdapter[] = [];
  const space = new DbSpace(() => {
    const a = factory();
    adapters.push(a);
    return a;
  });
  const owners = space.getTable(fx.FvOwner) as AtscriptDbTable;
  const items = space.getTable(fx.FvItem) as AtscriptDbTable;
  owners.getMetadata();
  items.getMetadata();
  const calls = () => adapters.flatMap((a) => a.calls);
  return { owners, items, calls };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; errors: Array<{ path: string; message: string }> };
  }
  throw new Error("expected rejection");
}

async function expectRejected(
  table: AtscriptDbTable,
  filter: Record<string, unknown>,
  path: string,
  message?: RegExp,
) {
  const err = await rejection(table.findMany({ filter } as any));
  expect(err.code).toBe("INVALID_QUERY");
  expect(err.errors).toHaveLength(1);
  expect(err.errors[0]!.path).toBe(path);
  expect(err.errors[0]!.message).toContain(`Invalid filter value for "${path}"`);
  if (message) expect(err.errors[0]!.message).toMatch(message);
}

async function expectAccepted(table: AtscriptDbTable, filter: Record<string, unknown>) {
  await expect(table.findMany({ filter } as any)).resolves.toBeDefined();
}

describe("filter values — non-finite numbers", () => {
  it("rejects NaN and ±Infinity on number and decimal fields, top-level and in lists", async () => {
    const { items, calls } = tables();
    await expectRejected(items, { n: Number.NaN }, "n", /expected a number, got NaN/);
    await expectRejected(items, { n: Number.POSITIVE_INFINITY }, "n", /got Infinity/);
    await expectRejected(items, { n: { $gt: Number.NEGATIVE_INFINITY } }, "n", /\(\$gt\)/);
    await expectRejected(items, { n: { $in: [1, Number.POSITIVE_INFINITY] } }, "n", /\(\$in\)/);
    await expectRejected(items, { price: Number.NaN }, "price");
    await expectRejected(items, { qty: Number.POSITIVE_INFINITY }, "qty");
    expect(calls().filter((c) => c.method === "findMany")).toHaveLength(0);
    await expectAccepted(items, { n: 0 });
    await expectAccepted(items, { n: -0 });
    await expectAccepted(items, { n: { $in: [1, 1.5] } });
  });
});

describe("filter values — number fields", () => {
  it("rejects values that cannot denote a number", async () => {
    const { items, calls } = tables();
    await expectRejected(items, { n: "x" }, "n", /expected a number, got "x"/);
    await expectRejected(items, { n: { $gte: "abc" } }, "n", /\(\$gte\)/);
    await expectRejected(items, { n: true }, "n", /got true/);
    await expectRejected(items, { n: "" }, "n");
    await expectRejected(items, { n: { $in: [1, "x"] } }, "n", /\(\$in\).*got "x"/);
    await expectRejected(items, { n: { $nin: ["x"] } }, "n");
    await expectRejected(items, { n: { $eq: { a: 1 } } }, "n", /got an object/);
    await expectRejected(items, { qty: "1.5x" }, "qty");
    expect(calls().filter((c) => c.method === "findMany")).toHaveLength(0);
  });

  it("a timestamp names epoch milliseconds; an ISO string is rejected", async () => {
    const { items } = tables();
    await expectRejected(
      items,
      { ts: { $gte: "2026-01-01T00:00:00Z" } },
      "ts",
      /expected an integer \(epoch milliseconds\)/,
    );
    await expectAccepted(items, { ts: { $gte: 1767225600000 } });
    await expectAccepted(items, { ts: "1767225600000" });
    await expectRejected(items, { ts: 1500.5 }, "ts");
  });

  it("integer fields (number.int, timestamps) reject fractions — integer columns cannot parse them", async () => {
    const { items } = tables();
    await expectRejected(items, { qty: { $gt: 5.5 } }, "qty", /expected an integer, got 5.5/);
    await expectRejected(items, { qty: "5.5" }, "qty");
    await expectRejected(items, { qty: "1e3" }, "qty");
    await expectRejected(items, { qty: { $in: [1, 2.5] } }, "qty");
    await expectAccepted(items, { qty: { $gt: 5, $lt: "10" } });
    await expectAccepted(items, { qty: 5.0 });
    // A plain number takes any decimal literal — not hex, not Infinity.
    await expectAccepted(items, { n: { $gt: 5.5 } });
    await expectAccepted(items, { n: "1e3" });
    await expectRejected(items, { n: "0x10" }, "n");
    await expectRejected(items, { n: "Infinity" }, "n");
  });

  it("accepts numbers, numeric strings, null and the null-ish operators", async () => {
    const { items } = tables();
    for (const filter of [
      { n: 5 },
      { n: "5" },
      { n: " 5.5 " },
      { n: { $gte: "-1e3", $lt: 10 } },
      { n: { $in: [1, "2"] } },
      { n: null },
      { n: { $ne: null } },
      { n: { $exists: true } },
      { qty: 3 },
      { level: 2 },
    ]) {
      await expectAccepted(items, filter);
    }
  });
});

describe("filter values — boolean, decimal, string, literal and union fields", () => {
  it("booleans accept true / false and 0 / 1 only", async () => {
    const { items } = tables();
    await expectAccepted(items, { flag: true });
    await expectAccepted(items, { flag: { $ne: false } });
    await expectAccepted(items, { flag: 1 });
    await expectAccepted(items, { flag: { $in: [0, true] } });
    await expectRejected(items, { flag: "yes" }, "flag", /expected a boolean/);
    await expectRejected(items, { flag: "true" }, "flag");
    await expectRejected(items, { flag: 2 }, "flag");
  });

  it("decimals accept numbers and numeric strings", async () => {
    const { items } = tables();
    await expectAccepted(items, { price: "12.50" });
    await expectAccepted(items, { price: { $gt: 12.5 } });
    await expectRejected(items, { price: "12,50" }, "price", /expected a decimal/);
  });

  it("strings accept every primitive (the URL grammar reads `?code=123` as a number)", async () => {
    const { items } = tables();
    for (const filter of [
      { label: "x" },
      { label: 123 },
      { label: true },
      { email: "a@b.c" },
      { label: { $regex: "^a" } },
      { label: /^a/i },
      // Literal unions are checked by their primitive type, not membership.
      { kind: "zzz" },
    ]) {
      await expectAccepted(items, filter);
    }
    await expectRejected(items, { label: { $eq: { a: 1 } } }, "label", /got an object/);
    await expectRejected(items, { level: "x" }, "level", /expected a number/);
  });

  it("$regex needs a string field and a string pattern", async () => {
    const { items } = tables();
    await expectRejected(items, { n: { $regex: "^5" } }, "n", /needs a string or integer field/);
    await expectRejected(items, { n: /5/ }, "n", /needs a string or integer field/);
    await expectRejected(items, { label: { $regex: 5 } }, "label", /expected a regular expression/);
  });

  it("a union accepts what any member accepts", async () => {
    const { items } = tables();
    await expectAccepted(items, { mixed: 5 });
    await expectAccepted(items, { mixed: false });
    await expectRejected(items, { mixed: "x" }, "mixed", /expected a number or a boolean/);
  });
});

describe("filter values — structure", () => {
  it("walks $and / $or / $not", async () => {
    const { items } = tables();
    await expectRejected(items, { $or: [{ n: 1 }, { n: "x" }] }, "n");
    await expectRejected(items, { $and: [{ label: "a" }, { $not: { flag: "x" } }] }, "flag");
  });

  it("the path guard answers first (unknown / unfilterable fields)", async () => {
    const { items } = tables();
    const unknown = await rejection(items.findMany({ filter: { zzz: "x" } } as any));
    expect(unknown.errors[0]!.message).toBe('Unknown field "zzz"');
    // Arrays are JSON columns on relational adapters.
    const json = await rejection(items.findMany({ filter: { scores: "x" } } as any));
    expect(json.errors[0]!.message).toContain("cannot filter");
  });

  it("document adapters: an array field checks its element type; JSON contents stay opaque", async () => {
    const { items } = tables(() => new DocAdapter());
    await expectAccepted(items, { tags: "a" });
    await expectAccepted(items, { tags: { $in: ["a", "b"] } });
    await expectAccepted(items, { scores: 5 });
    await expectAccepted(items, { scores: [1, 2] });
    await expectRejected(items, { scores: "x" }, "scores", /expected a number/);
    await expectRejected(items, { scores: [1, "x"] }, "scores");
    await expectAccepted(items, { "blob.v": "anything" });
  });

  it("relational predicate operands are checked by the related table (path under the relation)", async () => {
    const { owners, calls } = tables();
    const err = await rejection(owners.findMany({ filter: { items: { $some: { n: "x" } } } }));
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.errors[0]!.path).toBe("items.n");
    expect(err.errors[0]!.message).toContain('Invalid filter value for "n"');
    await expect(
      owners.findMany({ filter: { items: { $none: { n: { $gte: 5 } } } } }),
    ).resolves.toBeDefined();
    expect(calls().filter((c) => c.method === "findMany")).toHaveLength(1);
  });

  it("mutation filters are checked before any write", async () => {
    const { items, calls } = tables();
    const del = await rejection(items.deleteMany({ n: "x" } as any));
    expect(del.errors[0]!.path).toBe("n");
    const upd = await rejection(items.updateMany({ flag: "x" } as any, { label: "y" } as any));
    expect(upd.errors[0]!.path).toBe("flag");
    expect(calls().filter((c) => c.method.endsWith("Many"))).toHaveLength(0);
  });

  it("count / findManyWithCount / findOne share the check", async () => {
    const { items } = tables();
    for (const op of [
      () => items.count({ filter: { n: "x" } } as any),
      () => items.findOne({ filter: { n: "x" } } as any),
      () => items.findManyWithCount({ filter: { n: "x" } } as any),
    ]) {
      const err = await rejection(op());
      expect(err.errors[0]!.path).toBe("n");
    }
  });
});

describe("filter values — aggregates", () => {
  const select = [
    "label",
    { $fn: "sum", $field: "n", $as: "total" },
    { $fn: "count", $field: "*", $as: "cnt" },
    { $fn: "max", $field: "flag", $as: "anyFlag" },
  ];

  it("checks $having against aggregate result types and $groupBy fields", async () => {
    const { items } = tables();
    const having = async ($having: Record<string, unknown>) =>
      rejection(
        items.aggregate({
          filter: {},
          controls: { $groupBy: ["label"], $select: select, $having },
        } as any),
      );
    expect((await having({ total: "x" })).errors[0]).toMatchObject({
      path: "total",
      message: expect.stringContaining("expected a number"),
    });
    expect((await having({ cnt: { $gt: "lots" } })).errors[0]!.path).toBe("cnt");
    expect((await having({ cnt: { $gt: 1.5 } })).errors[0]!.message).toContain(
      "expected an integer",
    );
    expect((await having({ anyFlag: "x" })).errors[0]!.message).toContain("expected a boolean");
  });

  it("valid $having values and the aggregate's filter pass", async () => {
    const { items } = tables();
    await expect(
      items.aggregate({
        filter: { n: { $gte: 0 } },
        controls: {
          $groupBy: ["label"],
          $select: select,
          $having: { total: { $gt: 5 }, cnt: "2", label: 7, anyFlag: true },
        },
      } as any),
    ).resolves.toBeDefined();
    const err = await rejection(
      items.aggregate({
        filter: { n: "x" },
        controls: { $groupBy: ["label"], $select: select },
      } as any),
    );
    expect(err.errors[0]!.path).toBe("n");
  });
});
