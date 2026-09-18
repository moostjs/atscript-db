import { beforeAll, describe, expect, it } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { buildDbValidator } from "../validator";
import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * `@db.column.version` is server-managed (since 0.1.128 it sits on the shared
 * validator plugin's skip list next to `@db.default*` / `@db.rel.FK`). The
 * shared `buildDbValidator` — used by the server tables AND `@atscript/db-client`
 * — therefore accepts a missing version on insert/replace at any depth; the
 * former server-only `replace` callback in `_buildValidator` is gone, so the
 * two builders cannot drift.
 */

let VersionedUser: any;
let VersionedPost: any;
let PlainWidget: any;

beforeAll(async () => {
  await prepareFixtures();
  const mod = await import("./fixtures/version-tables.as");
  VersionedUser = mod.VersionedUser;
  VersionedPost = mod.VersionedPost;
  PlainWidget = mod.PlainWidget;
});

const ctx = (mode: "insert" | "replace" | "patch") => ({ mode, navFields: new Set<string>() });

describe("shared buildDbValidator", () => {
  it("insert: accepts a payload without the version column", () => {
    const v = buildDbValidator(VersionedUser, "insert");
    expect(v.validate({ name: "Ada" }, true, ctx("insert"))).toBe(true);
  });

  it("replace: accepts a payload without the version column but keeps the PK required", () => {
    const v = buildDbValidator(VersionedUser, "replace");
    expect(v.validate({ id: 1, name: "Ada" }, true, ctx("replace"))).toBe(true);
    expect(v.validate({ name: "Ada" }, true, ctx("replace"))).toBe(false);
  });

  it("patch: accepts a numeric version (the wire shape the HTTP layer lifts to $cas)", () => {
    const v = buildDbValidator(VersionedUser, "patch");
    expect(v.validate({ id: 1, version: 3 }, true, ctx("patch"))).toBe(true);
  });

  it("still rejects a wrongly-typed version on insert", () => {
    const v = buildDbValidator(VersionedUser, "insert");
    expect(v.validate({ name: "Ada", version: "3" }, true, ctx("insert"))).toBe(false);
  });

  // WHY (review #20): the old server-only callback matched `path === versionField`
  // at the root only; the skip list works at any depth, so nested inserts of
  // versioned targets no longer need a meaningless version either.
  it("nested versioned nav target: version optional at depth", () => {
    const v = buildDbValidator(VersionedPost, "insert");
    expect(
      v.validate({ title: "t", author: { name: "Ada" } }, true, {
        mode: "insert",
        navFields: new Set(["author"]),
      }),
    ).toBe(true);
  });

  it("does not affect non-versioned tables", () => {
    const v = buildDbValidator(PlainWidget, "insert");
    expect(v.validate({ name: "w" }, true, ctx("insert"))).toBe(true);
    expect(v.validate({}, true, ctx("insert"))).toBe(false);
  });
});

describe("AtscriptDbTable.getValidator — same behaviour as the shared builder", () => {
  it("table 'insert' / 'bulkReplace' validators accept a missing version", () => {
    const table = new AtscriptDbTable(VersionedUser, new MockAdapter());
    expect(table.getValidator("insert").validate({ name: "Ada" }, true, ctx("insert"))).toBe(true);
    expect(
      table.getValidator("bulkReplace").validate({ id: 1, name: "Ada" }, true, ctx("replace")),
    ).toBe(true);
    expect(table.getValidator("bulkReplace").validate({ name: "Ada" }, true, ctx("replace"))).toBe(
      false,
    );
  });

  it("insertOne without version passes validation end-to-end", async () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(VersionedUser, adapter);
    await expect(table.insertOne({ name: "Ada" } as any)).resolves.toEqual({ insertedId: 1 });
  });
});
