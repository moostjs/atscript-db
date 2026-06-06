import { beforeAll, describe, expect, it } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import type { TDbIndex } from "../types";
import { MockAdapter, prepareFixtures } from "./test-utils";

// `_finalizeIndexes()` resolves each index field's optionality + design type
// from the model. Adapters consume these to make a unique index "present-only"
// on optional fields (so multiple value-less rows are tolerated, matching SQL's
// NULLS DISTINCT). This pins that engine-agnostic contract at the core layer.

describe("index field optionality + design type", () => {
  beforeAll(prepareFixtures);

  async function indexesByName(): Promise<Map<string, TDbIndex>> {
    const { IndexOptionalityCreds } = await import("./fixtures/index-optionality.as");
    const table = new AtscriptDbTable(IndexOptionalityCreds, new MockAdapter());
    return new Map([...table.indexes.values()].map((idx) => [idx.name, idx]));
  }

  it("marks an optional unique field's index field as optional", async () => {
    const email = (await indexesByName()).get("email_idx")!;
    expect(email.fields).toEqual([
      { name: "email", sort: "asc", optional: true, designType: "string" },
    ]);
  });

  it("marks a required unique field's index field as not optional", async () => {
    const username = (await indexesByName()).get("username_idx")!;
    expect(username.fields[0]).toMatchObject({ optional: false, designType: "string" });
  });

  it("carries the design type for a non-string optional field", async () => {
    const extid = (await indexesByName()).get("extid_idx")!;
    expect(extid.fields[0]).toMatchObject({ optional: true, designType: "number" });
  });
});
