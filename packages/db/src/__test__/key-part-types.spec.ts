import { beforeAll, describe, expect, it } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

// A key part addressed by text — what a URL carries (`GET /one/7`,
// `/one?code=7`) — takes the type of its field's column (since 0.1.194):
// the value member of `T | null`, a number for number literals
// (`1 | 2 | 3`), whole numbers for an integer field. Numeric text reaches
// the adapter as the text (its `prepareId` converts it); an id that cannot
// be a value of the key matches no row without a read.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/key-types.as");
});

function tableOf(type: unknown) {
  const adapter = new MockAdapter();
  return { adapter, table: new AtscriptDbTable(type as never, adapter) };
}

/** Whether the adapter was asked to read. */
function read(adapter: MockAdapter): boolean {
  return adapter.calls.some((c) => c.method === "findOne" || c.method === "findMany");
}

describe("a key part typed `number | null` (a unique field)", () => {
  it.each([["7"], [7], ["-3"], ["1.5"]])("%j is a number", (code) => {
    const { table } = tableOf(fx.KtCode);
    expect(table.resolveIdFilter({ code })).toEqual({ code });
  });

  it.each([["abc"], [""], ["0x10"], ["Infinity"], [true]])(
    "%j matches nothing, without a read",
    async (code) => {
      const { table, adapter } = tableOf(fx.KtCode);
      expect(table.resolveIdFilter({ code })).toBeNull();
      expect(await table.findById({ code } as never)).toBeNull();
      expect(read(adapter)).toBe(false);
    },
  );

  it("a scalar id tries the primary key and the unique field", () => {
    const { table } = tableOf(fx.KtCode);
    expect(table.resolveIdFilter("7")).toEqual({ $or: [{ id: "7" }, { code: "7" }] });
    expect(table.resolveIdFilter("x")).toEqual({ id: "x" });
  });
});

describe("a key typed as number literals (`1 | 2 | 3`)", () => {
  it.each([["2"], [2], ["2.5"]])("%j is a number", (level) => {
    const { table } = tableOf(fx.KtLevel);
    expect(table.resolveIdFilter(level)).toEqual({ level });
  });

  it("text that is no number matches nothing, without a read", async () => {
    const { table, adapter } = tableOf(fx.KtLevel);
    expect(table.resolveIdFilter("two")).toBeNull();
    expect(await table.findById("two" as never)).toBeNull();
    expect(read(adapter)).toBe(false);
  });
});

describe("an integer key (`number.int`)", () => {
  it.each([["5"], [5], ["-12"]])("%j is a whole number", (n) => {
    const { table } = tableOf(fx.KtCounter);
    expect(table.resolveIdFilter(n)).toEqual({ n });
  });

  it.each([["1.5"], [1.5], ["1e3"], ["abc"]])("%j matches nothing, without a read", async (n) => {
    const { table, adapter } = tableOf(fx.KtCounter);
    expect(table.resolveIdFilter(n)).toBeNull();
    expect(await table.findById(n as never)).toBeNull();
    expect(read(adapter)).toBe(false);
  });
});

describe("an integer key part by `@expect.int` on `number | null`", () => {
  it.each([["5"], [5], ["-12"]])("%j is a whole number", (seq) => {
    const { table } = tableOf(fx.KtTicket);
    expect(table.resolveIdFilter({ seq })).toEqual({ seq });
  });

  it.each([["1.5"], [1.5], ["1e3"]])("%j matches nothing, without a read", async (seq) => {
    const { table, adapter } = tableOf(fx.KtTicket);
    expect(table.resolveIdFilter({ seq })).toBeNull();
    expect(await table.findById({ seq } as never)).toBeNull();
    expect(read(adapter)).toBe(false);
  });
});
