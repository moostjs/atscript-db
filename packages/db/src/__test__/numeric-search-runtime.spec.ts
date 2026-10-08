import { describe, it, expect, beforeAll } from "vite-plus/test";

import { defineAnnotatedType as $ } from "@atscript/typescript/utils";

import { INTEGER_REGEX_OP, searchTermInteger, splitFulltextFields } from "../index";
import { rewriteIntegerRegex } from "../query/integer-regex";
import { computeTableSnapshot } from "../schema/schema-hash";
import { DbSpace } from "../table/db-space";
import type { AtscriptDbTable } from "../table/db-table";
import { searchMemberKind } from "../shared/search-fields";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/numeric-search.as");
});

class RelAdapter extends MockAdapter {
  override supportsRelationFilters(): boolean {
    return true;
  }
}

function tableOf(type: any, adapter: MockAdapter = new RelAdapter()) {
  const table = new DbSpace(() => adapter).getTable(type) as AtscriptDbTable;
  table.getMetadata();
  return { table, adapter };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; errors: Array<{ path: string; message: string }> };
  }
  throw new Error("expected rejection");
}

describe("searchTermInteger", () => {
  it.each([
    ["2946", 2946],
    [" 2946 ", 2946],
    ["0", 0],
    ["-12", -12],
    ["9007199254740991", 9007199254740991],
  ])("%j → %j", (term, expected) => {
    expect(searchTermInteger(term)).toBe(expected);
  });

  it.each([
    "02946",
    "+5",
    "-0",
    "1.0",
    "1e3",
    "9007199254740992",
    "12 34",
    "",
    "  ",
    "abc",
    "invoice 2946",
    "١٢٣",
  ])("%j → undefined", (term) => {
    expect(searchTermInteger(term)).toBeUndefined();
  });
});

describe("searchMemberKind (runtime mirror)", () => {
  it("classifies the fixture fields", () => {
    const { table } = tableOf(fx.NsrFallback);
    const flat = table.getMetadata().flatMap;
    expect(searchMemberKind(flat.get("title"))).toBe("text");
    expect(searchMemberKind(flat.get("refNo"))).toBe("integer");
    expect(searchMemberKind(flat.get("tag"))).toBe("integer"); // number + @expect.int
    expect(searchMemberKind(flat.get("amount"))).toEqual({
      problem: expect.stringMatching(/floating-point number/),
    });
  });
});

describe("fulltext integer members — metadata", () => {
  it("flags integer members and keeps them in the index fields", () => {
    const { table } = tableOf(fx.NsrNative);
    const index = [...table.indexes.values()].find((i) => i.type === "fulltext")!;
    expect(index.fields.map((f) => [f.name, f.integer === true])).toEqual([
      ["title", false],
      ["refNo", true],
      ["altRefNo", true],
    ]);
    const { text, integer } = splitFulltextFields(index);
    expect(text.map((f) => f.name)).toEqual(["title"]);
    expect(integer.map((f) => f.name)).toEqual(["refNo", "altRefNo"]);
  });

  it("flags an integer-only index on the primary key", () => {
    const { table } = tableOf(fx.NsrCode);
    const index = [...table.indexes.values()].find((i) => i.type === "fulltext")!;
    expect(index.fields.map((f) => f.integer)).toEqual([true]);
  });
});

describe("schema snapshot", () => {
  it("carries `integer` only on integer members", () => {
    const { table } = tableOf(fx.NsrNative);
    const snapshot = computeTableSnapshot(table);
    const ft = (snapshot as any).indexes.find((i: any) => i.type === "fulltext");
    expect(ft.fields).toEqual([
      { name: "title", sort: "asc" },
      { name: "refNo", sort: "asc", integer: true },
      { name: "altRefNo", sort: "asc", integer: true },
    ]);
    const plain = (snapshot as any).indexes.find((i: any) => i.type === "plain");
    expect(plain.fields[0]).not.toHaveProperty("integer");
  });
});

describe("base syncIndexesWithDiff — integer-only fulltext", () => {
  class Probe extends MockAdapter {
    run(opts: any) {
      return this.syncIndexesWithDiff(opts);
    }
  }

  it("never creates the integer-only index and drops a stale physical one", async () => {
    const adapter = new Probe();
    tableOf(fx.NsrCode, adapter);
    const ftKey = [...adapter["_table"].indexes.values()].find((i) => i.type === "fulltext")!.key;
    const created: string[] = [];
    const dropped: string[] = [];
    await adapter.run({
      listExisting: async () => [{ name: ftKey }],
      createIndex: async (index: { key: string }) => void created.push(index.key),
      dropIndex: async (name: string) => void dropped.push(name),
    });
    expect(created).toEqual([]);
    expect(dropped).toContain(ftKey);
  });

  it("still creates a fulltext index that has a text member", async () => {
    const adapter = new Probe();
    tableOf(fx.NsrNative, adapter);
    const created: string[] = [];
    await adapter.run({
      listExisting: async () => [],
      createIndex: async (index: { type: string }) => void created.push(index.type),
      dropIndex: async () => {},
    });
    expect(created).toContain("fulltext");
  });
});

describe("$regex on integer fields — value guard", () => {
  it("accepts $regex and a bare RegExp on integers (number.int, @expect.int)", async () => {
    const { table } = tableOf(fx.NsrFallback);
    await table.findMany({ filter: { refNo: { $regex: "^29" } } } as any);
    await table.findMany({ filter: { refNo: /^29/ } } as any);
    await table.findMany({ filter: { tag: { $regex: "7" } } } as any);
  });

  it("refuses $regex on a float with the new wording", async () => {
    const { table } = tableOf(fx.NsrFallback);
    const err = await rejection(table.findMany({ filter: { amount: { $regex: "5" } } } as any));
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.errors[0]!.message).toMatch(/needs a string or integer field/);
  });

  it("refuses the internal operator from a caller", async () => {
    const { table } = tableOf(fx.NsrFallback);
    const err = await rejection(
      table.findMany({ filter: { refNo: { [INTEGER_REGEX_OP]: "5" } } } as any),
    );
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.errors[0]!.message).toMatch(/is internal — use \$regex/);
  });

  it("hands the adapter the internal operator under the physical key", async () => {
    const { table, adapter } = tableOf(fx.NsrFallback);
    await table.findMany({ filter: { refNo: { $regex: "^29" }, title: { $regex: "x" } } } as any);
    const sent = adapter.calls.find((c) => c.method === "findMany")!.args[0].filter;
    expect(sent).toEqual({ refNo: { [INTEGER_REGEX_OP]: "^29" }, title: { $regex: "x" } });
  });

  it("also rewrites on a document adapter", async () => {
    const { table, adapter } = tableOf(fx.NsrFallback, new NestedMockAdapter());
    await table.findMany({ filter: { refNo: /9/ } } as any);
    const sent = adapter.calls.find((c) => c.method === "findMany")!.args[0].filter;
    expect(sent).toEqual({ refNo: { [INTEGER_REGEX_OP]: /9/ } });
  });
});

describe("rewriteIntegerRegex", () => {
  const meta = () => tableOf(fx.NsrFallback).table.getMetadata();

  it("walks $and / $or / $not and keeps other operators", () => {
    const out = rewriteIntegerRegex(
      {
        $and: [
          { refNo: { $regex: "1", $ne: 5 } },
          { $or: [{ tag: /2/ }, { $not: { refNo: { $regex: "3" } } }] },
        ],
      } as any,
      meta(),
    );
    expect(out).toEqual({
      $and: [
        { refNo: { [INTEGER_REGEX_OP]: "1", $ne: 5 } },
        {
          $or: [
            { tag: { [INTEGER_REGEX_OP]: /2/ } },
            { $not: { refNo: { [INTEGER_REGEX_OP]: "3" } } },
          ],
        },
      ],
    });
  });

  it("leaves string fields and returns the same object when nothing changes", () => {
    const filter = { title: { $regex: "x" }, refNo: 5, $or: [{ title: /a/ }] } as any;
    expect(rewriteIntegerRegex(filter, meta())).toBe(filter);
  });

  it("does not mutate its input", () => {
    const filter = { refNo: { $regex: "1" } } as any;
    rewriteIntegerRegex(filter, meta());
    expect(filter).toEqual({ refNo: { $regex: "1" } });
  });
});

describe("metadata build refuses unsupported members (pre-compiled types)", () => {
  /** A hand-built model standing in for stale JS built before the plugin refused these. */
  function model(extra: (t: any) => any) {
    class Stale {
      static __is_atscript_annotated_type = true;
      static type: any = {};
      static metadata = new Map();
      static id = "Stale";
    }
    const base = $("object", Stale as any).prop(
      "id",
      $().designType("number").tags("int", "number").annotate("meta.id", true).$type,
    );
    extra(base);
    base.annotate("db.table", "stale_items");
    return Stale;
  }

  const build = (type: any) => new DbSpace(() => new RelAdapter()).getTable(type).getMetadata();

  it("throws for a float fulltext member", () => {
    const type = model((t) =>
      t.prop(
        "price",
        $().designType("number").tags("number").annotate("db.index.fulltext", { name: "ft" }, true)
          .$type,
      ),
    );
    expect(() => build(type)).toThrow(/@db\.index\.fulltext on "price" is a floating-point number/);
  });

  it("throws for a timestamp searchable column", () => {
    const type = model((t) =>
      t.prop(
        "at",
        $().designType("number").tags("number", "timestamp").annotate("db.column.searchable", true)
          .$type,
      ),
    );
    expect(() => build(type)).toThrow(/@db\.column\.searchable on "at" is a timestamp/);
  });

  it("throws for an unindexed integer fulltext member", () => {
    const type = model((t) =>
      t.prop(
        "n",
        $()
          .designType("number")
          .tags("int", "number")
          .annotate("db.index.fulltext", { name: "ft" }, true).$type,
      ),
    );
    expect(() => build(type)).toThrow(/"n" needs an index for its exact-number match/);
  });
});
