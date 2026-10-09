import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import type { TDbFieldMeta, TDbWriteGuardContext } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

// Since atscript 0.1.103 a built-in primitive extension keeps its built-in
// annotations as a union / tuple member or array element
// (`number.timestamp.created | null` → `@db.default.now`, `string.char` →
// `@expect.maxLength 1`). A member is not the column: only the prop's own
// annotations (and, as before, a named alias member's non-db ones) apply.

let UnionMembers: any;
let UnionAliasMembers: any;
let UnionAliasProps: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ UnionMembers, UnionAliasMembers, UnionAliasProps } =
    await import("./fixtures/union-members.as"));
});

function field(table: AtscriptDbTable, path: string): TDbFieldMeta {
  const fd = table.fieldDescriptors.find((d) => d.path === path);
  if (!fd) throw new Error(`no field ${path}`);
  return fd;
}

const row = { pair: [1, "a"], emails: ["a@b.co"], n: null, code: "abc", created: 1 };

describe("union / tuple member annotations", () => {
  it("a member's @db.default.now is no column default", () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    for (const path of ["x", "y", "pair"]) {
      const fd = field(table, path);
      expect(fd.defaultValue, path).toBeUndefined();
      expect(fd.type.metadata.has("db.default.now"), path).toBe(false);
    }
  });

  it("an inline primitive member's built-in annotations stay off the column", () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    // `string.char | string` — `@expect.maxLength 1` would size the column
    expect([...field(table, "code").type.metadata.keys()]).toEqual([]);
    expect([...field(table, "n").type.metadata.keys()]).toEqual([]);
    expect([...field(table, "x").type.metadata.keys()]).toEqual([]);
  });

  it("the prop's own annotations and a named alias member's still apply", () => {
    const table = new AtscriptDbTable(UnionAliasMembers, new MockAdapter());
    expect(field(table, "short").type.metadata.get("expect.maxLength")).toEqual({ length: 10 });
    expect(field(table, "stamped").defaultValue).toEqual({ kind: "fn", fn: "now" });
    expect(field(table, "tsPair").defaultValue).toBeUndefined();
  });

  it("an omitted field is not filled from a member default", async () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    let seen: Array<Record<string, unknown>> = [];
    await table.insertOne({ id: 1, x: 5, ...row } as any, {
      guard: (ctx: TDbWriteGuardContext<any>) => {
        seen = ctx.rows;
      },
    });
    expect(seen[0]).not.toHaveProperty("y");
  });

  it("a member default does not make the field optional on insert", async () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    await expect(table.insertOne({ id: 1, ...row } as any)).rejects.toThrow(/x/);
    await expect(
      table.insertOne({ id: 2, x: 5, ...row, pair: [undefined, "a"] } as any),
    ).rejects.toThrow(/pair\.0/);
    // a default on the prop itself still does
    const aliased = new AtscriptDbTable(UnionAliasMembers, new MockAdapter());
    await expect(aliased.insertOne({ id: 1, short: "a" } as any)).resolves.toBeDefined();
  });

  it("validates array elements and tuple items against their primitive (atscript 0.1.103)", async () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    await expect(
      table.insertOne({ id: 1, x: 5, ...row, emails: ["not-an-email"] } as any),
    ).rejects.toThrow(/emails\.0/);
    await expect(table.insertOne({ id: 2, x: 5, ...row, pair: [1.5, "a"] } as any)).rejects.toThrow(
      /pair\.0/,
    );
    await expect(table.insertOne({ id: 3, x: 5, ...row, n: 1.5 } as any)).rejects.toThrow(/n/);
  });

  it("a union alias prop and members inside nested objects get no member default", async () => {
    const table = new AtscriptDbTable(UnionAliasProps, new MockAdapter());
    for (const path of ["maybe", "stamped.at", "group.at"]) {
      expect(field(table, path).defaultValue, path).toBeUndefined();
    }
    expect(field(table, "maybeDef").defaultValue).toEqual({ kind: "fn", fn: "now" });
    const payload = { id: 1, stamped: null, group: { at: null } };
    await expect(table.insertOne(payload as any)).rejects.toThrow(/maybe/);
    await expect(table.insertOne({ ...payload, maybe: null } as any)).resolves.toBeDefined();
  });
});
