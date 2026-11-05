import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { caught, prepareFixtures } from "./test-utils";

// Since 0.1.170 every write applies the type's `@normalize.*` annotations
// before it validates and before it compares keys, and stores the normalized
// value: inserts, replaces and patches (plain values, nested objects, array
// patch operators), nested rows at every level, and the keys a write finds
// its rows by. The caller's payload is never changed.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/normalize-writes.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const types = [fx.NwUser, fx.NwNote, fx.NwTag, fx.NwUserTag, fx.NwCode, fx.NwContact, fx.NwPair];
  expect((await new SchemaSync(space).run(types as never, { force: true })).status).toBe("synced");
});

afterEach(() => {
  driver.close();
});

const t = (type: unknown) => space.getTable(type as never) as any;
const users = () => t(fx.NwUser);
const all = (type: unknown) => t(type).findMany({ filter: {}, controls: { $sort: { id: 1 } } });
const user = async (id = 1) => users().findById(id);

const ann = () => ({ email: "  Ann@Example.COM ", name: "  Ann  ", code: "ab" });

describe("insert", () => {
  it("stores normalized values, validated after normalizing", async () => {
    const payload = ann();
    await users().insertOne(payload);
    expect(await user()).toMatchObject({ email: "ann@example.com", name: "Ann", code: "AB" });
    // the caller's object is left as it was
    expect(payload).toEqual(ann());
  });

  it("insertMany normalizes array items and nested objects", async () => {
    await users().insertMany([
      { ...ann(), labels: [" Red ", "BLUE"], profile: { city: " Paris " } },
      { email: "bo@x.io", name: "Bo", contacts: [{ kind: " EMAIL ", value: " b@x " }] },
    ]);
    expect(await all(fx.NwUser)).toMatchObject([
      { labels: ["red", "blue"], profile: { city: "Paris" } },
      { contacts: [{ kind: "email", value: "b@x" }] },
    ]);
  });

  it("nested FROM, TO and VIA rows are normalized too", async () => {
    await users().insertOne({
      ...ann(),
      notes: [{ title: "  first  " }],
      tags: [{ name: " Urgent " }],
    });
    await t(fx.NwNote).insertOne({
      title: " second ",
      owner: { email: " Bo@X.io", name: " Bo " },
    });
    expect(await all(fx.NwNote)).toMatchObject([
      { title: "first", ownerId: 1 },
      { title: "second", ownerId: 2 },
    ]);
    expect(await user(2)).toMatchObject({ email: "bo@x.io", name: "Bo" });
    expect(await all(fx.NwTag)).toMatchObject([{ name: "urgent" }]);
  });

  it("a unique key collides after normalization", async () => {
    await users().insertOne(ann());
    const error = await caught(users().insertOne({ email: "ann@example.com", name: "Twin" }));
    expect(error.code).toBe("CONFLICT");
    expect(await all(fx.NwUser)).toHaveLength(1);
  });

  it("validateRows normalizes before it validates", async () => {
    expect(await users().validateRows([ann()])).toEqual([]);
    expect(await users().validateRows([{ email: "a b@x", name: "x" }])).toMatchObject([
      { index: 0, path: "email" },
    ]);
  });
});

describe("replace", () => {
  beforeEach(async () => {
    await users().insertOne(ann());
  });

  it("replaceOne / bulkReplace / replaceMany store normalized values", async () => {
    await users().replaceOne({ id: 1, email: " ANN@example.com", name: " A1 " });
    expect(await user()).toMatchObject({ email: "ann@example.com", name: "A1" });
    await users().bulkReplace([{ id: 1, email: "ann@example.com ", name: " A2", code: "x" }]);
    expect(await user()).toMatchObject({ name: "A2", code: "X" });
    await users().replaceMany({ id: 1 }, { email: "Ann@Example.com", name: "A3 " });
    expect(await user()).toMatchObject({ email: "ann@example.com", name: "A3" });
  });
});

describe("patch", () => {
  beforeEach(async () => {
    await users().insertOne({
      ...ann(),
      labels: ["red"],
      contacts: [{ kind: "email", value: "a@x" }],
      notes: [{ title: "n1" }],
    });
  });

  it("plain values and merge objects", async () => {
    const patch = { id: 1, name: "  Ann B ", profile: { city: " Rome " } };
    await users().updateOne(patch);
    expect(await user()).toMatchObject({ name: "Ann B", profile: { city: "Rome" } });
    expect(patch).toEqual({ id: 1, name: "  Ann B ", profile: { city: " Rome " } });
    await users().updateMany({ id: 1 }, { code: "zz" });
    expect(await user()).toMatchObject({ code: "ZZ" });
  });

  it("array operators: $insert / $remove items and the keys $update / $upsert match by", async () => {
    await users().updateOne({ id: 1, labels: { $insert: [" Green ", "BLUE"] } });
    expect((await user()).labels).toEqual(["red", "green", "blue"]);
    await users().updateOne({ id: 1, labels: { $remove: [" RED "] } });
    expect((await user()).labels).toEqual(["green", "blue"]);
    await users().updateOne({
      id: 1,
      contacts: { $update: [{ kind: " EMAIL ", value: " b@x " }] },
    });
    expect((await user()).contacts).toEqual([{ kind: "email", value: "b@x" }]);
    await users().updateOne({ id: 1, contacts: { $upsert: [{ kind: "Email", value: "c@x" }] } });
    expect((await user()).contacts).toEqual([{ kind: "email", value: "c@x" }]);
    await users().updateOne({ id: 1, labels: { $replace: [" X "] } });
    expect((await user()).labels).toEqual(["x"]);
  });

  it("nested FROM operators: $insert rows and $update patches", async () => {
    await users().updateOne({ id: 1, notes: { $insert: [{ title: " n2 " }] } });
    await users().updateOne({ id: 1, notes: { $update: [{ id: 1, title: " n1b " }] } });
    expect(await all(fx.NwNote)).toMatchObject([{ title: "n1b" }, { title: "n2" }]);
  });

  it("a nested TO patch is normalized", async () => {
    await t(fx.NwNote).updateOne({ id: 1, owner: { name: " Owner " } });
    expect(await user()).toMatchObject({ name: "Owner" });
  });

  it("a patch addressed by a unique key finds the row by its normalized value", async () => {
    const res = await users().updateOne({ email: "  ANN@example.com", name: "by key" });
    expect(res).toMatchObject({ matchedCount: 1 });
    await users().bulkUpdate([{ email: "ann@EXAMPLE.com ", code: "k" }]);
    expect(await user()).toMatchObject({ code: "K" });
    expect(await user()).toMatchObject({ name: "by key" });
    expect(users().recordFilter({ email: " ANN@Example.com " })).toEqual({
      email: "ann@example.com",
    });
  });
});

describe("primary keys", () => {
  const codes = () => t(fx.NwCode);
  const stored = () => codes().findMany({ filter: {}, controls: { $sort: { code: 1 } } });

  it("a normalized primary key: insert, patch and touchMany find the row by it", async () => {
    await codes().insertOne({ code: " A1 ", label: "x" });
    expect(await stored()).toMatchObject([{ code: "a1", version: 0 }]);
    expect(await codes().updateOne({ code: "A1 ", label: "y" })).toMatchObject({
      matchedCount: 1,
    });
    expect(await codes().touchMany([{ code: " A1", version: 1 }])).toMatchObject({
      matchedCount: 1,
    });
    expect(await stored()).toMatchObject([{ code: "a1", label: "y", version: 2 }]);
  });

  it("touchMany: two spellings of one key are one key", async () => {
    await codes().insertOne({ code: "b2", label: "x" });
    const error = await caught(
      codes().touchMany([
        { code: "b2", version: 0 },
        { code: " B2", version: 0 },
      ]),
    );
    expect(error.code).toBe("INVALID_QUERY");
  });
});

describe("a field value is judged at its own path (an object union without a discriminator)", () => {
  const contacts = () => t(fx.NwContact);

  it("insert, replace and patch store the same normalized value", async () => {
    await contacts().insertOne({ id: 1, contact: { value: "ABC" } });
    expect((await contacts().findById(1)).contact).toEqual({ value: "abc" });
    await contacts().replaceOne({ id: 1, contact: { value: "QQQ" } });
    expect((await contacts().findById(1)).contact).toEqual({ value: "qqq" });
    await contacts().updateOne({ id: 1, contact: { value: "XYZ" } });
    expect((await contacts().findById(1)).contact).toEqual({ value: "xyz" });
    // the member that does not normalize stays as given
    await contacts().updateOne({ id: 1, contact: { value: "P1", ext: "9" } });
    expect((await contacts().findById(1)).contact).toEqual({ value: "P1", ext: "9" });
  });
});

describe("defaults of nested rows are normalized", () => {
  it("a nested insert and a FROM $insert store and validate the default like a direct insert", async () => {
    await t(fx.NwNote).insertOne({ title: "direct" });
    await users().insertOne({ ...ann(), notes: [{ title: "nested" }] });
    await users().updateOne({ id: 1, notes: { $insert: [{ title: "patched" }] } });
    expect(await all(fx.NwNote)).toMatchObject([
      { title: "direct", status: "new" },
      { title: "nested", status: "new" },
      { title: "patched", status: "new" },
    ]);
  });
});

describe("equality lookups are normalized", () => {
  beforeEach(async () => {
    await users().insertMany([
      { ...ann(), labels: ["red"], notes: [{ title: "n1" }] },
      { email: "bo@x.io", name: "Bo", labels: ["blue"] },
    ]);
  });
  const emails = async (filter: Record<string, unknown>) =>
    (await users().findMany({ filter, controls: { $sort: { id: 1 } } })).map(
      (u: { email: string }) => u.email,
    );

  it("implicit equality, $eq, $ne, $in, $nin", async () => {
    expect(await emails({ email: "  ANN@example.COM " })).toEqual(["ann@example.com"]);
    expect(await emails({ email: { $eq: " Bo@X.io" } })).toEqual(["bo@x.io"]);
    expect(await emails({ email: { $ne: " Bo@X.io" } })).toEqual(["ann@example.com"]);
    expect(await emails({ email: { $in: ["ANN@EXAMPLE.COM", " BO@x.io "] } })).toHaveLength(2);
    expect(await emails({ email: { $nin: ["ANN@EXAMPLE.COM"] } })).toEqual(["bo@x.io"]);
    // (array fields: SQLite cannot filter JSON array columns — memory covers them)
    expect(await emails({ $or: [{ email: "BO@X.IO" }, { name: { $in: [" Ann"] } }] })).toHaveLength(
      2,
    );
    expect(await users().count({ filter: { email: " BO@X.IO" } })).toBe(1);
  });

  it("filters of writes: updateMany / deleteMany", async () => {
    expect(await users().updateMany({ email: " BO@X.IO" }, { code: "q" })).toMatchObject({
      matchedCount: 1,
    });
    expect(await users().deleteMany({ email: { $in: [" BO@X.IO"] } })).toMatchObject({
      deletedCount: 1,
    });
  });

  it("relation sub-filters and $with filters", async () => {
    expect(await emails({ notes: { $some: { title: "  n1 " } } })).toEqual(["ann@example.com"]);
    const withNotes = await users().findById(1, {
      controls: { $with: [{ name: "notes", filter: { title: " n1 " } }] },
    });
    expect(withNotes.notes).toMatchObject([{ title: "n1" }]);
    const notes = await t(fx.NwNote).findMany({
      filter: { owner: { $some: { email: " ANN@EXAMPLE.COM" } } },
      controls: {},
    });
    expect(notes).toHaveLength(1);
  });

  it("ids: findById / resolveRowFilter / deleteOne by a unique key, a normalized primary key, a composite key", async () => {
    expect((await users().findById(" ANN@Example.com ")).id).toBe(1);
    expect(await users().resolveRowFilter(" BO@X.IO")).toEqual({ email: "bo@x.io" });
    await t(fx.NwCode).insertOne({ code: "c1", label: "x" });
    expect(await t(fx.NwCode).findById(" C1 ")).toMatchObject({ code: "c1" });
    await t(fx.NwPair).insertOne({ tenant: " T ", num: 1, label: "p" });
    expect(await t(fx.NwPair).findById({ tenant: "T ", num: 1 })).toMatchObject({ label: "p" });
    expect(await t(fx.NwCode).deleteOne(" C1")).toMatchObject({ deletedCount: 1 });
  });

  it("never: $regex, ranges, $having and aggregate conditions are compared as given", async () => {
    // a regex operand is not trimmed (stored names are)
    expect(await emails({ name: { $regex: " Ann" } })).toEqual([]);
    // a range operand is not lowercased: "BO" sorts before every lowercase email
    expect(await emails({ email: { $gte: "BO" } })).toHaveLength(2);
    const grouped = await users().aggregate({
      filter: {},
      controls: {
        $groupBy: ["email"],
        $select: ["email", { $fn: "count", $field: "*", $as: "n" }],
        $having: { email: " ann@example.com" },
      },
    });
    expect(grouped).toEqual([]);
    const conditional = await users().aggregate({
      filter: {},
      controls: {
        $select: [{ $fn: "count", $field: "*", $as: "n", $where: { email: " ann@example.com" } }],
      },
    });
    expect(conditional).toEqual([{ n: 0 }]);
  });
});
