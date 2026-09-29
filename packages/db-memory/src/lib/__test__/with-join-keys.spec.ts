import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

let NiUser: any;
let NiTag: any;
let NiProject: any;
let NiNote: any;
let NiProjectTag: any;

// Since 0.1.143: a `$with` relation loads even when `$select` leaves out the
// key it joins on — the key is read for the join and stripped from the rows.
describe("MemoryAdapter — $with joins through keys $select omits", () => {
  let space: DbSpace;
  let projects: any;

  beforeAll(async () => {
    await prepareFixtures();
    ({ NiUser, NiTag, NiProject, NiNote, NiProjectTag } =
      await import("./fixtures/nested-integrity.as"));
  });

  beforeEach(async () => {
    space = createTestSpace();
    await bootstrapStoredTables(space, [NiUser, NiTag, NiProject, NiNote, NiProjectTag]);
    await space.getTable(NiUser).insertOne({ id: 1, name: "u1" });
    projects = space.getTable(NiProject);
    await projects.insertOne({ id: 1, title: "p1", ownerId: 1 });
    await space.getTable(NiNote).insertOne({ id: 1, body: "n1", projectId: 1 });
    await space.getTable(NiTag).insertOne({ id: 1, name: "t1" });
    await space.getTable(NiProjectTag).insertOne({ projectId: 1, tagId: 1 });
  });

  it("TO: the foreign key is joined on, then stripped", async () => {
    const [row] = await projects.findMany({
      filter: {},
      controls: { $select: ["title"], $with: [{ name: "owner" }] },
    });
    expect(row).toMatchObject({ title: "p1", owner: { id: 1, name: "u1" } });
    expect(row).not.toHaveProperty("ownerId");
  });

  it("FROM / VIA: the parent key is joined on, then stripped", async () => {
    const row = await projects.findOne({
      filter: { id: 1 },
      controls: { $select: ["title"], $with: [{ name: "notes" }, { name: "tags" }] },
    });
    expect(row).toMatchObject({
      title: "p1",
      notes: [{ id: 1, body: "n1" }],
      tags: [{ id: 1, name: "t1" }],
    });
  });

  it("an exclusion projection of the key still joins", async () => {
    const [row] = await projects.findMany({
      filter: {},
      controls: { $select: { ownerId: 0 }, $with: [{ name: "owner" }] },
    });
    expect(row.owner).toMatchObject({ id: 1 });
    expect(row).not.toHaveProperty("ownerId");
  });

  it("a selected key stays; no $with reads exactly the projection", async () => {
    const [row] = await projects.findMany({
      filter: {},
      controls: { $select: ["title", "ownerId"], $with: [{ name: "owner" }] },
    });
    expect(row).toMatchObject({ title: "p1", ownerId: 1, owner: { id: 1 } });
    const [plain] = await projects.findMany({ filter: {}, controls: { $select: ["title"] } });
    expect(plain).not.toHaveProperty("ownerId");
  });
});
