import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.169 a nested insert fills each foreign key from the WRITTEN row —
// the row after the write guard and the TO phase (primary-key parts from the
// inserted id) — never from the caller's payload, and refuses a key it cannot
// resolve instead of leaving the link unset. Replace / patch link FROM / VIA
// children by the parent's primary key only, and refuse any other key shape.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/composite-insert-id.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const types = Object.values(fx).filter((v) => typeof v === "function");
  expect((await new SchemaSync(space).run(types as never, { force: true })).status).toBe("synced");
});

afterEach(() => {
  driver.close();
});

const all = (type: unknown) => {
  const table = space.getTable(type as never) as any;
  return table.findMany({ filter: {}, controls: { $sort: { [table.primaryKeys[0]]: 1 } } });
};
const t = (type: unknown) => space.getTable(type as never) as any;
const rejects = async (p: Promise<unknown>, code: string) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect((error as { code?: string } | undefined)?.code).toBe(code);
};

describe("nested inserts link by the written row, after the guard", () => {
  it("FROM: a guard rewriting a composite key part — children follow the stored key", async () => {
    await t(fx.CidPair).insertOne(
      { left: 1, right: "a", label: "A", links: [{ note: "child" }] },
      { guard: (ctx: any) => void (ctx.rows[0].left = 99) },
    );
    expect(await all(fx.CidLink)).toMatchObject([{ note: "child", pairLeft: 99, pairRight: "a" }]);
  });

  it("FROM: a guard rewriting a single string key — children follow the stored key", async () => {
    await t(fx.CidSParent).insertOne({ id: "victim", label: "V" });
    await t(fx.CidSParent).insertOne(
      { id: "victim", label: "mine", kids: [{ note: "k" }] },
      { guard: (ctx: any) => void (ctx.rows[0].id = "server-1") },
    );
    expect(await all(fx.CidSKid)).toMatchObject([{ note: "k", spId: "server-1" }]);
  });

  it("FROM + VIA: a guard rewriting the referenced unique field — links follow the stored value", async () => {
    await t(fx.CidCoded).insertOne({ code: "victim", label: "V" });
    await t(fx.CidCoded).insertOne(
      { code: "victim", label: "mine", links: [{ note: "c" }], tags: [{ name: "t" }] },
      { guard: (ctx: any) => void (ctx.rows[0].code = "server") },
    );
    expect(await all(fx.CidLink)).toMatchObject([{ note: "c", codedCode: "server" }]);
    expect(await all(fx.CidCodedTag)).toMatchObject([{ codedCode: "server", tagName: "t" }]);
  });
});

describe("nested inserts fail closed on a key they cannot resolve", () => {
  it("TO: a unique field the target defaults (uuid) is linked, not left unset", async () => {
    await t(fx.CidPubKid).insertOne({ note: "n", parent: { label: "P" } });
    const [parent] = await all(fx.CidPub);
    expect((await all(fx.CidPubKid))[0].parentPub).toBe(parent.pub);
  });

  it("TO: the payload's own foreign key never survives — the new parent's key wins", async () => {
    await t(fx.CidPub).insertOne({ pub: "victim", label: "V" });
    await t(fx.CidPubKid).insertOne({ note: "n", parentPub: "victim", parent: { label: "P" } });
    const parents = await all(fx.CidPub);
    expect((await all(fx.CidPubKid))[0].parentPub).toBe(parents[1].pub);
  });

  it("FROM: a parent whose referenced unique field is defaulted links its children", async () => {
    await t(fx.CidPub).insertOne({ label: "P", kids: [{ note: "k" }] });
    const [parent] = await all(fx.CidPub);
    expect((await all(fx.CidPubKid))[0].parentPub).toBe(parent.pub);
  });

  it("FROM: an absent referenced field throws before anything is written", async () => {
    await rejects(
      t(fx.CidSlugged).insertOne({ label: "x", kids: [{ note: "k" }] }),
      "FK_VIOLATION",
    );
    expect(await all(fx.CidSlugged)).toEqual([]);
    expect(await all(fx.CidSlugKid)).toEqual([]);
  });

  it("VIA: an absent referenced parent field throws before anything is written", async () => {
    await rejects(
      t(fx.CidSlugged).insertOne({ label: "x", tags: [{ name: "t" }] }),
      "FK_VIOLATION",
    );
    expect(await all(fx.CidSlugged)).toEqual([]);
    expect(await all(fx.CidTag)).toEqual([]);
  });

  it("TO: a target without the referenced field throws before anything is written", async () => {
    await rejects(
      t(fx.CidSlugKid).insertOne({ note: "n", slugged: { label: "x" } }),
      "FK_VIOLATION",
    );
    expect(await all(fx.CidSlugged)).toEqual([]);
    expect(await all(fx.CidSlugKid)).toEqual([]);
  });
});

describe("nested links by a referenced field that is not the primary key", () => {
  it("VIA: an existing target named by its primary key links by the referenced field", async () => {
    await t(fx.CidTag).insertOne({ name: "pad" });
    const { insertedId } = await t(fx.CidTag).insertOne({ name: "existing" });
    await t(fx.CidCoded).insertOne({ code: "c", label: "C", tags: [{ id: insertedId }] });
    expect(await all(fx.CidCodedTag)).toMatchObject([{ codedCode: "c", tagName: "existing" }]);
    expect(await all(fx.CidTag)).toHaveLength(2);
  });

  it("VIA: a composite-key target with only part of its key is a NEW target", async () => {
    await t(fx.CidCoded).insertOne({ code: "c", label: "C", vts: [{ a: 1, code: "x" }] });
    expect(await all(fx.CidVTarget)).toMatchObject([{ a: 1, code: "x" }]);
    expect(await all(fx.CidCodedVt)).toMatchObject([{ codedCode: "c", vtCode: "x" }]);
  });

  it("replace with FROM children linked by a unique field is refused, nothing written", async () => {
    const { insertedId } = await t(fx.CidCoded).insertOne({ code: "c", label: "C" });
    await rejects(
      t(fx.CidCoded).replaceOne({ id: insertedId, code: "c", label: "C2", links: [{ note: "n" }] }),
      "INVALID_QUERY",
    );
    expect((await all(fx.CidCoded))[0].label).toBe("C");
    expect(await all(fx.CidLink)).toEqual([]);
  });

  it("replace / patch of a composite-key parent with FROM children is refused, not skipped", async () => {
    await t(fx.CidPair).insertOne({ left: 1, right: "a", label: "A" });
    await rejects(
      t(fx.CidPair).replaceOne({ left: 1, right: "a", label: "B", links: [{ note: "n" }] }),
      "INVALID_QUERY",
    );
    await rejects(
      t(fx.CidPair).updateOne({ left: 1, right: "a", links: { $insert: [{ note: "n" }] } }),
      "INVALID_QUERY",
    );
    expect((await all(fx.CidPair))[0].label).toBe("A");
    expect(await all(fx.CidLink)).toEqual([]);
  });
});

describe("round 3: existing VIA targets, unique-addressed patches, checks before any write", () => {
  it("VIA: an existing target whose own referenced value differs from the stored one is refused", async () => {
    const one = await t(fx.CidTag).insertOne({ name: "one" });
    await t(fx.CidTag).insertOne({ name: "two" });
    await rejects(
      t(fx.CidCoded).insertOne({
        code: "c",
        label: "C",
        tags: [{ id: one.insertedId, name: "two" }],
      }),
      "INVALID_QUERY",
    );
    expect(await all(fx.CidCoded)).toEqual([]);
    expect(await all(fx.CidCodedTag)).toEqual([]);
  });

  it("VIA: a missing existing target is refused before anything is written", async () => {
    await rejects(
      t(fx.CidCoded).insertOne({
        code: "c",
        label: "C",
        links: [{ note: "l" }],
        tags: [{ id: 999 }],
      }),
      "FK_VIOLATION",
    );
    await rejects(
      t(fx.CidUser).insertOne({ email: "e", label: "U", tags: [{ id: 999 }] }),
      "FK_VIOLATION",
    );
    expect(await all(fx.CidCoded)).toEqual([]);
    expect(await all(fx.CidLink)).toEqual([]);
    expect(await all(fx.CidUser)).toEqual([]);
  });

  it("patch addressed by a unique field writes its FROM / VIA children under the stored id", async () => {
    const { insertedId } = await t(fx.CidUser).insertOne({ email: "e", label: "L" });
    await t(fx.CidUser).updateOne({
      email: "e",
      label: "L2",
      kids: { $insert: [{ note: "k" }] },
      tags: { $insert: [{ name: "t" }] },
    });
    expect(await all(fx.CidUserKid)).toMatchObject([{ note: "k", uId: insertedId }]);
    expect(await all(fx.CidUserTag)).toMatchObject([{ uId: insertedId }]);
  });

  it("a FROM key check fails before the TO phase writes anything", async () => {
    await rejects(
      t(fx.CidSlugged).insertOne({
        label: "x",
        owner: { id: "o1", label: "O" },
        kids: [{ note: "k" }],
      }),
      "FK_VIOLATION",
    );
    expect(await all(fx.CidSParent)).toEqual([]);
  });

  it("a referenced field the TO phase fills counts as resolvable", async () => {
    await t(fx.CidSlugged).insertOne({
      label: "x",
      slugOwner: { slug: "s1" },
      kids: [{ note: "k" }],
    });
    expect(await all(fx.CidSlugKid)).toMatchObject([{ note: "k", sluggedSlug: "s1" }]);
  });

  it("TO: a referenced field only the database generates is refused before anything is written", async () => {
    await rejects(t(fx.CidNoKid).insertOne({ note: "n", noRow: { label: "N" } }), "FK_VIOLATION");
    expect(await all(fx.CidNo)).toEqual([]);
  });

  it("replace with a TO object lacking the referenced field is refused before anything is written", async () => {
    const parent = await t(fx.CidPub).insertOne({ pub: "p1", label: "P" });
    const kid = await t(fx.CidPubKid).insertOne({ note: "n", parentPub: "p1" });
    await rejects(
      t(fx.CidPubKid).replaceOne({
        id: kid.insertedId,
        note: "n2",
        parentPub: "p1",
        parent: { id: parent.insertedId, label: "P2" },
      }),
      "INVALID_QUERY",
    );
    expect(await all(fx.CidPub)).toMatchObject([{ pub: "p1", label: "P" }]);
    expect(await all(fx.CidPubKid)).toMatchObject([{ note: "n" }]);
  });
});
