import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbSpace } from "../index";
import { computeTableSnapshot, snapshotToExistingColumns } from "../sync";

import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

// A navigation property (`@db.rel.to` / `.from` / `.via`) and its subfields
// are never columns of the table that declares it — on relational storage
// (the subtree is flattened away) and on document storage (the descriptors
// keep the nested shape, so they must be `ignored`). A document adapter's
// snapshot still lists the subfields, as releases before 0.1.141 did, so the
// upgrade changes no stored hash (schema-hash-pins.spec.ts); reading a stored
// snapshot as existing columns leaves them out.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/test-relations.as");
});

const navPaths = (paths: string[]) =>
  paths.filter((p) => p === "author" || p === "comments" || /^(author|comments)\./.test(p));

describe("nav properties are not columns", () => {
  it("document storage: nav subfields are ignored descriptors, out of columnDescriptors / storedDescriptors", () => {
    const space = new DbSpace(() => new NestedMockAdapter());
    const table = space.getTable(fx.Post);
    const under = table.fieldDescriptors.filter((fd) => navPaths([fd.path]).length > 0);
    expect(under.map((fd) => fd.path)).toEqual(
      expect.arrayContaining(["author", "author.id", "author.name", "comments", "comments.id"]),
    );
    expect(under.every((fd) => fd.ignored)).toBe(true);
    expect(navPaths(table.columnDescriptors.map((fd) => fd.path))).toEqual([]);
    expect(navPaths(table.storedDescriptors.map((fd) => fd.path))).toEqual([]);
    expect(navPaths(table.ignoredFields.has("author.name") ? ["author.name"] : [])).toEqual([
      "author.name",
    ]);
    // Hash compatibility: the snapshot keeps the subfields (never the nav field itself)
    const snapshot = computeTableSnapshot(table);
    expect(navPaths(snapshot.fields.map((f) => f.physicalName))).toEqual(
      expect.arrayContaining(["author.id", "author.name", "comments.id"]),
    );
    expect(snapshot.fields.map((f) => f.physicalName)).not.toContain("author");
    expect(snapshot.fields.map((f) => f.physicalName)).not.toContain("comments");
  });

  it("relational storage is unchanged: no nav descriptor reaches the columns or the snapshot", () => {
    const space = new DbSpace(() => new MockAdapter());
    const table = space.getTable(fx.Post);
    expect(navPaths(table.columnDescriptors.map((fd) => fd.path))).toEqual([]);
    expect(navPaths(computeTableSnapshot(table).fields.map((f) => f.physicalName))).toEqual([]);
    expect(table.columnDescriptors.map((fd) => fd.physicalName)).toEqual([
      "id",
      "title",
      "status",
      "createdAt",
      "authorId",
    ]);
  });

  it("snapshotToExistingColumns(snapshot, readable) drops the nav subfields a snapshot lists", () => {
    const space = new DbSpace(() => new NestedMockAdapter());
    const table = space.getTable(fx.Post);
    const snapshot = computeTableSnapshot(table);
    expect(snapshotToExistingColumns(snapshot).map((c) => c.name)).toEqual(
      expect.arrayContaining(["author.name", "comments.id"]),
    );
    expect(snapshotToExistingColumns(snapshot, table).map((c) => c.name)).toEqual(
      table.columnDescriptors.map((fd) => fd.physicalName).toSorted(),
    );
  });
});
