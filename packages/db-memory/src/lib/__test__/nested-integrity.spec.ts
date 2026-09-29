import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// Populated after fixtures compile.
let NiUser: any;
let NiTag: any;
let NiProject: any;
let NiNote: any;
let NiProjectTag: any;

/**
 * The memory adapter has no transactions (`withTransaction` is a pass-through),
 * so nothing rolls back: a rejected nested operation (since 0.1.143) must be
 * refused BEFORE the main write — the parent row, its version and every
 * related row stay exactly as they were.
 */
describe("MemoryAdapter — rejected nested writes leave no partial write", () => {
  let space: DbSpace;
  let projects: any;

  const table = (t: unknown): any => space.getTable(t as never);
  const all = (t: unknown) => table(t).findMany({ filter: {}, controls: {} });
  const one = (t: unknown, id: number) =>
    table(t).findOne({ filter: { id }, controls: {} }) as Promise<any>;

  beforeAll(async () => {
    await prepareFixtures();
    ({ NiUser, NiTag, NiProject, NiNote, NiProjectTag } =
      await import("./fixtures/nested-integrity.as"));
  });

  beforeEach(async () => {
    space = createTestSpace();
    const tables = [NiUser, NiTag, NiProject, NiNote, NiProjectTag];
    await bootstrapStoredTables(space, tables);
    await space.getTable(NiUser).insertMany([
      { id: 1, name: "u1" },
      { id: 2, name: "u2" },
    ]);
    projects = space.getTable(NiProject);
    await projects.insertMany([
      { id: 1, title: "p1", ownerId: 1 },
      { id: 2, title: "p2", ownerId: 2 },
    ]);
    await space.getTable(NiNote).insertMany([
      { id: 1, body: "n1", projectId: 1 },
      { id: 2, body: "n2", projectId: 2 },
      { id: 3, body: "orphan" },
    ]);
    await space.getTable(NiTag).insertMany([
      { id: 1, name: "t1" },
      { id: 2, name: "t2" },
    ]);
    await space.getTable(NiProjectTag).insertOne({ projectId: 1, tagId: 1 });
  });

  /** Everything the tests could have touched, for a before/after comparison. */
  const snapshot = async () => ({
    users: await all(NiUser),
    projects: await all(NiProject),
    notes: await all(NiNote),
    tags: await all(NiTag),
    links: await all(NiProjectTag),
  });

  async function expectRejectedUntouched(
    write: () => Promise<unknown>,
    expected: Record<string, unknown>,
  ) {
    const before = await snapshot();
    await expect(write()).rejects.toMatchObject(expected);
    expect(await snapshot()).toEqual(before);
  }

  it("PATCH + FROM $update of another parent's child", async () => {
    await expectRejectedUntouched(
      () =>
        projects.updateOne({
          id: 1,
          title: "changed",
          owner: { name: "changed" },
          notes: { $update: [{ id: 2, body: "stolen" }] },
        }),
      { code: "CONFLICT" },
    );
  });

  it("PATCH + FROM $update of an orphan child", async () => {
    await expectRejectedUntouched(
      () => projects.updateOne({ id: 1, title: "changed", notes: { $update: [{ id: 3 }] } }),
      { code: "CONFLICT" },
    );
  });

  it("PATCH + FROM $update entry without a primary key", async () => {
    await expectRejectedUntouched(
      () => projects.updateOne({ id: 1, title: "changed", notes: { $update: [{ body: "x" }] } }),
      { code: "NOT_FOUND" },
    );
  });

  it("PATCH + FROM $upsert of another parent's child", async () => {
    await expectRejectedUntouched(
      () =>
        projects.updateOne({
          id: 1,
          title: "changed",
          notes: { $upsert: [{ id: 2, body: "stolen" }] },
        }),
      { code: "CONFLICT" },
    );
  });

  it("PATCH + FROM $replace naming another parent's child (own child not deleted)", async () => {
    await expectRejectedUntouched(
      () =>
        projects.updateOne({
          id: 1,
          title: "changed",
          notes: { $replace: [{ id: 2, body: "stolen" }] },
        }),
      { code: "CONFLICT" },
    );
  });

  it("PUT with a FROM array naming another parent's child (TO row not written either)", async () => {
    await expectRejectedUntouched(
      () =>
        projects.replaceOne({
          id: 1,
          title: "changed",
          owner: { id: 1, name: "overwritten" },
          notes: [{ id: 2, body: "stolen" }],
        }),
      { code: "CONFLICT" },
    );
  });

  it("PATCH + VIA $update of an unlinked target", async () => {
    await expectRejectedUntouched(
      () =>
        projects.updateOne({
          id: 1,
          title: "changed",
          tags: { $update: [{ id: 2, name: "pwned" }] },
        }),
      { code: "CONFLICT" },
    );
  });

  it("PATCH + VIA $upsert of an unlinked target", async () => {
    await expectRejectedUntouched(
      () =>
        projects.updateOne({
          id: 1,
          title: "changed",
          tags: { $upsert: [{ id: 2, name: "pwned" }] },
        }),
      { code: "CONFLICT" },
    );
  });

  it("PATCH changing the FK while patching the TO relation", async () => {
    await expectRejectedUntouched(
      () => projects.updateOne({ id: 1, title: "changed", ownerId: 2, owner: { name: "pwned" } }),
      { code: "INVALID_QUERY" },
    );
  });

  it("PATCH with a nested TO key naming another row", async () => {
    await expectRejectedUntouched(
      () => projects.updateOne({ id: 1, title: "changed", owner: { id: 2, name: "pwned" } }),
      { code: "INVALID_QUERY" },
    );
  });

  it("a valid nested patch still applies (control)", async () => {
    await projects.updateOne({
      id: 1,
      title: "changed",
      owner: { name: "renamed" },
      notes: { $update: [{ id: 1, body: "edited" }] },
      tags: { $update: [{ id: 1, name: "t1b" }] },
    });
    expect(await one(NiProject, 1)).toMatchObject({ title: "changed" });
    expect(await one(NiUser, 1)).toMatchObject({ name: "renamed" });
    expect(await one(NiNote, 1)).toMatchObject({ body: "edited", projectId: 1 });
    expect(await one(NiTag, 1)).toMatchObject({ name: "t1b" });
  });
});
