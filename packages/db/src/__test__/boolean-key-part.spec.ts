import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

// A boolean part of a composite primary key addressed by text — what a URL
// carries (`GET /one?id=a&active=true`): exactly `true` / `false` name the
// boolean, and the filter compares a boolean (since 0.1.192).

let BkDraft: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ BkDraft } = await import("./fixtures/boolean-key.as"));
});

describe("a boolean part of a composite primary key", () => {
  let adapter: MockAdapter;
  let table: AtscriptDbTable;

  beforeEach(() => {
    adapter = new MockAdapter();
    table = new AtscriptDbTable(BkDraft, adapter);
    adapter.store.set(table.tableName, [
      { id: "a", active: true, title: "live" },
      { id: "a", active: false, title: "draft" },
    ]);
  });

  it.each([
    ["true", "live"],
    ["false", "draft"],
    [true, "live"],
    [false, "draft"],
  ])("findById with active %j finds the %s row", async (active, title) => {
    expect(await table.findById({ id: "a", active } as never)).toMatchObject({ title });
  });

  it("the filter carries a boolean", () => {
    expect(table.resolveIdFilter({ id: "a", active: "true" })).toEqual({ id: "a", active: true });
    expect(table.resolveIdFilter({ id: "a", active: "false" })).toEqual({ id: "a", active: false });
  });

  it.each(["yes", "1", "", "TRUE"])(
    "findById with active %j matches nothing, without a read",
    async (active) => {
      expect(table.resolveIdFilter({ id: "a", active })).toBeNull();
      expect(await table.findById({ id: "a", active } as never)).toBeNull();
      expect(adapter.calls.some((c) => c.method === "findOne" || c.method === "findMany")).toBe(
        false,
      );
    },
  );
});
