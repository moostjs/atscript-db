import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationSpec, build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { ValidatorError } from "@atscript/typescript/utils";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { DbError } from "../db-error";
import dbPlugin from "../plugin";
import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * Since 0.1.162: bounded `updateMany` / `deleteMany` (`{ limit, sort }`),
 * `@db.onUpdate.inc`, validated `updateMany` / `replaceMany` payloads and
 * `touchMany` stamping `@db.onUpdate.now`. Adapter contract shapes against the
 * mock adapter (no native bounded writes → the core emulation).
 */

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/bulk-writes.as");
});

/** A mock that honours `$sort` / `$limit` on reads, like a real engine. */
class OrderedMockAdapter extends MockAdapter {
  override async findMany(query: any): Promise<Array<Record<string, unknown>>> {
    let rows = await super.findMany(query);
    const sort = query.controls?.$sort as Record<string, 1 | -1> | undefined;
    if (sort) {
      rows = rows.toSorted((a, b) => {
        for (const [k, dir] of Object.entries(sort)) {
          if (a[k] === b[k]) continue;
          return (a[k] as number) < (b[k] as number) ? -dir : dir;
        }
        return 0;
      });
    }
    const limit = query.controls?.$limit as number | undefined;
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}

/** A mock that renders bounded writes natively (records the bound only). */
class LimitMockAdapter extends MockAdapter {
  override supportsWriteLimit(): boolean {
    return true;
  }
  override async deleteMany(filter: any, opts?: any): Promise<any> {
    this.record("deleteMany", filter, opts);
    return { deletedCount: opts?.limit?.limit ?? 0 };
  }
}

const tasks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    status: "old",
    priority: (i + 1) % 3,
    title: `t${i + 1}`,
    version: 0,
    rev: 0,
  }));

function makeTable(adapter = new OrderedMockAdapter(), rows = tasks(5)) {
  const table = new AtscriptDbTable(fx.BwTask, adapter);
  adapter.store.set(table.tableName, rows);
  return { table, adapter };
}

const calls = (adapter: MockAdapter, method: string) =>
  adapter.calls.filter((c) => c.method === method);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

async function invalidQuery(p: Promise<unknown>, path: string): Promise<void> {
  const err = (await rejection(p)) as DbError;
  expect(err).toBeInstanceOf(DbError);
  expect(err.code).toBe("INVALID_QUERY");
  expect(err.errors[0]!.path).toBe(path);
}

describe("bounded updateMany / deleteMany — options", () => {
  it("rejects a limit that is not a positive integer", async () => {
    const { table } = makeTable();
    for (const limit of [0, -1, 1.5, Number.NaN, "3"]) {
      await invalidQuery(table.deleteMany({}, { limit: limit as any }), "limit");
      await invalidQuery(table.updateMany({}, { note: "x" }, { limit: limit as any }), "limit");
    }
  });

  it("rejects sort without limit, a bad direction and an unknown sort field", async () => {
    const { table } = makeTable();
    await invalidQuery(table.deleteMany({}, { sort: { id: -1 } }), "sort");
    await invalidQuery(table.deleteMany({}, { limit: 1, sort: { id: 2 as any } }), "sort.id");
    await expect(
      table.deleteMany({}, { limit: 1, sort: { nope: 1 } as any }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it("rejects a bounded write on a table without a primary key", async () => {
    const adapter = new MockAdapter();
    const logs = new AtscriptDbTable(fx.BwLog, adapter);
    await invalidQuery(logs.deleteMany({}, { limit: 1 }), "limit");
    await expect(logs.deleteMany({})).resolves.toEqual({ deletedCount: 0 });
  });
});

describe("bounded writes — core emulation (no native support)", () => {
  it("deleteMany reads the first keys in primary-key order, then deletes filter AND keys", async () => {
    const { table, adapter } = makeTable();
    const result = await table.deleteMany({ status: "old" }, { limit: 2 });
    expect(result).toEqual({ deletedCount: 2 });
    const [read] = calls(adapter, "findMany");
    expect(read!.args[0].filter).toEqual({ status: "old" });
    expect(read!.args[0].controls.$sort).toEqual({ id: 1 });
    expect(read!.args[0].controls.$limit).toBe(2);
    expect([...read!.args[0].controls.$select.asArray]).toEqual(["id"]);
    expect(calls(adapter, "deleteMany")[0]!.args[0]).toEqual({
      $and: [{ status: "old" }, { id: { $in: [1, 2] } }],
    });
    expect(adapter.store.get(table.tableName)!.map((r) => r.id)).toEqual([3, 4, 5]);
  });

  it("appends the primary key as a tie-breaker in the last sort key's direction", async () => {
    const { table, adapter } = makeTable();
    await table.deleteMany({}, { limit: 2, sort: { priority: -1 } });
    expect(calls(adapter, "findMany")[0]!.args[0].controls.$sort).toEqual({
      priority: -1,
      id: -1,
    });
    // priority 2 rows: 5 and 2 (id desc)
    expect(adapter.store.get(table.tableName)!.map((r) => r.id)).toEqual([1, 3, 4]);
  });

  it("nothing matches → no write, a zero count", async () => {
    const { table, adapter } = makeTable();
    expect(await table.deleteMany({ status: "none" }, { limit: 3 })).toEqual({ deletedCount: 0 });
    expect(await table.updateMany({ status: "none" }, { note: "x" }, { limit: 3 })).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    expect(calls(adapter, "deleteMany")).toHaveLength(0);
    expect(calls(adapter, "updateMany")).toHaveLength(0);
  });

  it("updateMany patches filter AND keys, with the counter and version semantics unchanged", async () => {
    const { table, adapter } = makeTable();
    await table.updateMany({ status: "old" }, { note: "n" }, { limit: 3 });
    const [call] = calls(adapter, "updateMany");
    expect(call!.args[0]).toEqual({ $and: [{ status: "old" }, { id: { $in: [1, 2, 3] } }] });
    expect(call!.args[1]).toEqual({ note: "n", updatedAt: expect.any(Number) });
    expect(call!.args[2]).toEqual({ inc: { rev: 1 } });
    expect(call!.args[3]).toBeUndefined();

    // An exempt-only bounded patch keeps the version — and still moves the counter.
    await table.updateMany({}, { score: 1 }, { limit: 1 });
    const last = calls(adapter, "updateMany").at(-1)!;
    expect(last.args[2]).toEqual({ inc: { rev: 1 } });
    expect(last.args[3]).toEqual({ keepVersion: true });
  });

  it("an empty bounded patch reports at most `limit` matches", async () => {
    const { table } = makeTable();
    expect(await table.updateMany({}, {}, { limit: 2 })).toEqual({
      matchedCount: 2,
      modifiedCount: 0,
    });
  });
});

describe("bounded writes — native adapters", () => {
  it("deleteMany hands the adapter the translated filter and the physical bound", async () => {
    const adapter = new LimitMockAdapter();
    const { table } = makeTable(adapter as any);
    await table.deleteMany({ status: "old" }, { limit: 4, sort: { priority: 1 } });
    expect(calls(adapter, "findMany")).toHaveLength(0);
    expect(calls(adapter, "deleteMany")[0]!.args).toEqual([
      { status: "old" },
      { limit: { limit: 4, sort: { priority: 1, id: 1 } } },
    ]);
  });

  it("updateMany passes the bound in TDbUpdateOptions next to keepVersion", async () => {
    const adapter = new LimitMockAdapter();
    const { table } = makeTable(adapter as any);
    await table.updateMany({}, { score: 2 }, { limit: 5 });
    const [call] = calls(adapter, "updateMany");
    expect(call!.args[3]).toEqual({ keepVersion: true, limit: { limit: 5, sort: { id: 1 } } });
  });
});

describe("updateMany / replaceMany validate their payload", () => {
  it("updateMany: patch-mode validation (null on a non-nullable field, @expect, @meta.required)", async () => {
    const { table, adapter } = makeTable();
    for (const data of [{ title: null }, { priority: -1 }, { title: "" }, { status: 5 }]) {
      const err = await rejection(table.updateMany({}, data as any));
      expect(err, JSON.stringify(data)).toBeInstanceOf(ValidatorError);
    }
    expect(calls(adapter, "updateMany")).toHaveLength(0);
    // Field ops and an optional field cleared with null pass.
    await table.updateMany({}, { priority: { $inc: 1 }, note: null } as any);
    expect(calls(adapter, "updateMany")).toHaveLength(1);
  });

  it("updateMany / replaceMany reject a navigation field (own fields only) and unknown keys", async () => {
    const owners = new AtscriptDbTable(fx.BwOwner, new MockAdapter());
    await invalidQuery(owners.updateMany({}, { items: [] } as any), "items");
    await invalidQuery(owners.replaceMany({}, { name: "n", items: [] } as any), "items");
    await expect(owners.updateMany({}, { nope: 1 } as any)).rejects.toBeInstanceOf(ValidatorError);
  });

  it("replaceMany: replace-mode validation without the primary key", async () => {
    const { table, adapter } = makeTable();
    const err = await rejection(table.replaceMany({ id: 1 }, { status: "s", priority: 1 } as any));
    expect(err).toBeInstanceOf(ValidatorError);
    expect((err as ValidatorError).errors.map((e) => e.path)).toContain("title");
    await expect(
      table.replaceMany({ id: 1 }, { status: "s", priority: 1, title: null } as any),
    ).rejects.toBeInstanceOf(ValidatorError);
    expect(calls(adapter, "replaceMany")).toHaveLength(0);

    // No PK, no version, no counter, no stamp needed — and a supplied counter is dropped.
    await table.replaceMany({ id: 1 }, { status: "s", priority: 1, title: "r", rev: 9 } as any);
    const [call] = calls(adapter, "replaceMany");
    expect(call!.args[1]).toEqual({
      status: "s",
      priority: 1,
      title: "r",
      updatedAt: expect.any(Number),
    });
  });

  it("replaceMany rejects a direct version write", async () => {
    const { table } = makeTable();
    await expect(
      table.replaceMany({ id: 1 }, { status: "s", priority: 1, title: "r", version: 3 } as any),
    ).rejects.toBeInstanceOf(DbError);
  });
});

describe("@db.onUpdate.inc", () => {
  it("metadata: an implicit 0 default, a physical column list for adapters", () => {
    const { table } = makeTable();
    expect(table.fieldDescriptors.find((d) => d.path === "rev")!.defaultValue).toEqual({
      kind: "value",
      value: "0",
    });
    expect(table.onUpdateIncPhysical).toEqual(["rev"]);
  });

  it("insert: 0 unless supplied; the validator does not require it", async () => {
    const { table, adapter } = makeTable(undefined, []);
    await table.insertMany([
      { id: 1, status: "s", priority: 0, title: "a" },
      { id: 2, status: "s", priority: 0, title: "b", rev: 7 },
    ] as any);
    const [call] = calls(adapter, "insertMany");
    expect(call!.args[0].map((r: any) => r.rev)).toEqual([0, 7]);
  });

  it("patch: `$inc: 1` in the same statement, the caller's value dropped, exemption untouched", async () => {
    const { table, adapter } = makeTable();
    await table.updateOne({ id: 1, title: "x", rev: 50 } as any);
    let call = calls(adapter, "updateOne").at(-1)!;
    expect(call.args[1]).toEqual({ title: "x", updatedAt: expect.any(Number) });
    expect(call.args[2]).toEqual({ inc: { rev: 1 } });
    expect(call.args[4]).toBeUndefined();

    // exempt-only patch: version kept, counter moves
    await table.updateOne({ id: 1, score: 3 } as any);
    call = calls(adapter, "updateOne").at(-1)!;
    expect(call.args[2]).toEqual({ inc: { rev: 1 } });
    expect(call.args[4]).toEqual({ keepVersion: true });

    // an empty patch (only the counter supplied) writes nothing
    const before = adapter.calls.length;
    await table.updateOne({ id: 1, rev: 4 } as any);
    expect(calls(adapter, "updateOne")).toHaveLength(2);
    expect(adapter.calls.slice(before).map((c) => c.method)).toEqual(["count"]);
  });

  it("a versioned touch (empty patch + $cas) moves the counter and the update time", async () => {
    const { table, adapter } = makeTable();
    await table.updateOne({ id: 1, $cas: { version: 0 } } as any);
    const call = calls(adapter, "updateOne").at(-1)!;
    expect(call.args[1]).toEqual({ updatedAt: expect.any(Number) });
    expect(call.args[2]).toEqual({ inc: { rev: 1 } });
    expect(call.args[3]).toBe(0);
  });

  it("replace: the counter leaves the payload — the adapter increments it", async () => {
    const { table, adapter } = makeTable();
    await table.replaceOne({ id: 1, status: "s", priority: 0, title: "r", rev: 40 } as any);
    const call = calls(adapter, "replaceOne").at(-1)!;
    expect("rev" in call.args[1]).toBe(false);
  });

  it("touchMany bumps the version, stamps @db.onUpdate.now and increments the counter", async () => {
    const { table, adapter } = makeTable();
    const t0 = Date.now();
    await table.touchMany([{ id: 1, version: 0 }] as any);
    const [call] = calls(adapter, "updateMany");
    expect(call!.args[1].updatedAt).toBeGreaterThanOrEqual(t0);
    expect(call!.args[2]).toEqual({ inc: { rev: 1 } });
  });
});

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "on-update-inc-diagnostics-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

const tableSource = (body: string) =>
  `@db.table 't'\nexport interface T {\n  @meta.id\n  id: number\n${body}\n}`;

describe("@db.onUpdate.inc annotation", () => {
  it("is a documented annotation spec (editor completion and hover)", async () => {
    const config = (await dbPlugin().config?.({} as any)) as any;
    const spec = config.annotations.db.onUpdate.inc;
    expect(spec).toBeInstanceOf(AnnotationSpec);
    expect(spec.config.description).toContain("change counter");
  });

  it("accepts a non-optional integer field, directly or through an alias / @expect.int", async () => {
    expect(await diagnosticsFor(tableSource("  @db.onUpdate.inc\n  rev: number.int"))).toEqual([]);
    expect(
      await diagnosticsFor(tableSource("  @db.onUpdate.inc\n  @expect.int\n  rev: number")),
    ).toEqual([]);
    expect(
      await diagnosticsFor(
        `@expect.int\ntype Rev = number\n${tableSource("  @db.onUpdate.inc\n  rev: Rev")}`,
      ),
    ).toEqual([]);
  });

  it("rejects non-integers, optional fields, nested fields and conflicting annotations", async () => {
    const one = async (body: string) => diagnosticsFor(tableSource(body));
    expect(await one("  @db.onUpdate.inc\n  rev: string")).toContainEqual(
      '@db.onUpdate.inc is not compatible with type "string" — requires number',
    );
    expect(await one("  @db.onUpdate.inc\n  rev: number")).toContainEqual(
      expect.stringContaining("requires an integer field"),
    );
    expect(await one("  @db.onUpdate.inc\n  rev?: number.int")).toContainEqual(
      expect.stringContaining("requires a non-optional field"),
    );
    expect(await one("  audit: {\n    @db.onUpdate.inc\n    rev: number.int\n  }")).toContainEqual(
      expect.stringContaining("top-level field"),
    );
    for (const [ann, needle] of [
      ["@db.column.version", "cannot coexist with @db.column.version"],
      ["@db.onUpdate.now", "cannot coexist with @db.onUpdate.now"],
      ["@db.default '1'", "cannot coexist with @db.default"],
    ]) {
      expect(await one(`  @db.onUpdate.inc\n  ${ann}\n  rev: number.int`)).toContainEqual(
        expect.stringContaining(needle!),
      );
    }
    expect(
      await diagnosticsFor(
        "@db.table 't'\nexport interface T {\n  @meta.id\n  @db.onUpdate.inc\n  id: number.int\n}",
      ),
    ).toContainEqual(expect.stringContaining("cannot coexist with @meta.id"));
    expect(await one("  @db.encrypted\n  @db.onUpdate.inc\n  rev: number.int")).toContainEqual(
      expect.stringContaining("@db.encrypted cannot coexist with @db.onUpdate.inc"),
    );
  });
});
