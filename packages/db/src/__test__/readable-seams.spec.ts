import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

/**
 * Read-only seams a permission layer builds on (since 0.1.143):
 * `readable.jsonParents` (columns stored as one JSON value) and
 * `readable.foreignKeyOf(relation)` (the FK a TO relation is backed by —
 * the same pairing relation loading and nested writes use).
 */

let RsDoc: any;
let RsComment: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ RsDoc, RsComment } = await import("./fixtures/readable-seams.as"));
});

describe("readable.jsonParents", () => {
  it("relational storage: @db.json fields and arrays are single JSON columns; nav fields never", () => {
    const table = new AtscriptDbTable(RsDoc, new MockAdapter());
    const parents = [...table.jsonParents].toSorted();
    expect(parents).toContain("settings");
    expect(parents).toContain("tags");
    // A plain nested object is flattened into its own columns.
    expect(parents).not.toContain("profile");
    for (const nav of ["org", "author", "reviewer", "comments"]) {
      expect(parents).not.toContain(nav);
    }
    // Stable, the same set every read.
    expect(table.jsonParents).toBe(table.jsonParents);
  });

  it("document storage: sub-paths stay addressable — no JSON parents", () => {
    const table = new AtscriptDbTable(RsDoc, new NestedMockAdapter());
    expect([...table.jsonParents]).toEqual([]);
  });
});

describe("readable.foreignKeyOf(relation)", () => {
  it("an un-aliased TO relation pairs with the FK targeting its table", () => {
    const table = new AtscriptDbTable(RsDoc, new MockAdapter());
    const fk = table.foreignKeyOf("org");
    expect(fk).toMatchObject({ fields: ["orgId"], targetTable: "rs_orgs", targetFields: ["id"] });
    expect(fk).toBe([...table.foreignKeys.values()].find((f) => f.fields[0] === "orgId"));
  });

  it("aliased TO relations pair by alias (two FKs to the same table)", () => {
    const table = new AtscriptDbTable(RsDoc, new MockAdapter());
    expect(table.foreignKeyOf("author")).toMatchObject({ fields: ["authorId"], alias: "author" });
    expect(table.foreignKeyOf("reviewer")).toMatchObject({
      fields: ["reviewerId"],
      alias: "reviewer",
    });
  });

  it("FROM relations, non-relations and unknown names → undefined", () => {
    const table = new AtscriptDbTable(RsDoc, new MockAdapter());
    expect(table.foreignKeyOf("comments")).toBeUndefined();
    expect(table.foreignKeyOf("orgId")).toBeUndefined();
    expect(table.foreignKeyOf("nope")).toBeUndefined();
    const comments = new AtscriptDbTable(RsComment, new MockAdapter());
    expect(comments.foreignKeyOf("doc")).toMatchObject({
      fields: ["docId"],
      targetTable: "rs_docs",
    });
  });
});
