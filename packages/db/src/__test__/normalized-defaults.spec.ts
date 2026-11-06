import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";

import { MockAdapter, prepareFixtures } from "./test-utils";

// A `@db.default` literal carries the field's `@normalize.*` in the table's
// field descriptors: the DDL `DEFAULT` the SQL adapters emit and the value
// Mongo backfills a new field with come from there, so a row the database
// fills holds what an insert through the table would store.

let NdItem: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ NdItem } = await import("./fixtures/normalized-defaults.as"));
});

const defaultOf = (table: AtscriptDbTable, path: string) =>
  table.fieldDescriptors.find((d) => d.path === path)?.defaultValue;

describe("@db.default under @normalize.*", () => {
  it("the descriptor's default is the normalized literal", () => {
    const table = new AtscriptDbTable(NdItem, new MockAdapter());
    expect(defaultOf(table, "status")).toEqual({ kind: "value", value: "new" });
    expect(defaultOf(table, "trimmed")).toEqual({ kind: "value", value: "Spaced" });
    // a JSON literal: normalized item by item, written back as JSON
    expect(defaultOf(table, "labels")).toEqual({ kind: "value", value: '["a","b"]' });
  });

  it("a literal normalization leaves alone keeps its spelling (no schema drift)", () => {
    const table = new AtscriptDbTable(NdItem, new MockAdapter());
    expect(defaultOf(table, "settled")).toEqual({ kind: "value", value: "done" });
    expect(defaultOf(table, "plain")).toEqual({ kind: "value", value: "  Plain  " });
    expect(defaultOf(table, "count")).toEqual({ kind: "value", value: "3" });
  });

  it("the SDK fills the same values the descriptor carries", async () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(NdItem, adapter);
    await table.insertOne({ id: 1 });
    expect(adapter.store.get("nd_items")).toEqual([
      {
        id: 1,
        status: "new",
        settled: "done",
        plain: "  Plain  ",
        trimmed: "Spaced",
        labels: JSON.stringify(["a", "b"]),
        count: 3,
      },
    ]);
  });
});
