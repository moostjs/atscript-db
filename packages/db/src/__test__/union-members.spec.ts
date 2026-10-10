import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import type { TDbFieldMeta, TDbWriteGuardContext } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

// Since atscript 0.1.103 a built-in primitive extension keeps its built-in
// annotations as a union / tuple member or array element
// (`number.timestamp.created | null` → `@db.default.now`, `string.char` →
// `@expect.maxLength 1`). A member is not the column: only the prop's own
// annotations (and, as before, a named alias member's non-db ones) apply —
// plus the db ones of the one non-null member of `T | null`, which is the
// column's type.

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
  it("a tuple item's @db.default.now is no column default", () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    const fd = field(table, "pair");
    expect(fd.defaultValue).toBeUndefined();
    expect(fd.type.metadata.has("db.default.now")).toBe(false);
  });

  it("T | null gets the db annotations of T: @db.default.now", () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    for (const path of ["x", "y", "created"]) {
      expect(field(table, path).defaultValue, path).toEqual({ kind: "fn", fn: "now" });
    }
  });

  it("an inline primitive member's built-in annotations stay off the column", () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    // `string.char | string` — `@expect.maxLength 1` would size the column
    expect([...field(table, "code").type.metadata.keys()]).toEqual([]);
    expect([...field(table, "n").type.metadata.keys()]).toEqual([]);
    // `T | null`: only T's db annotations, not its `@expect.int`
    expect([...field(table, "x").type.metadata.keys()]).toEqual(["db.default.now"]);
  });

  it("the prop's own annotations and a named alias member's still apply", () => {
    const table = new AtscriptDbTable(UnionAliasMembers, new MockAdapter());
    expect(field(table, "short").type.metadata.get("expect.maxLength")).toEqual({ length: 10 });
    expect(field(table, "stamped").defaultValue).toEqual({ kind: "fn", fn: "now" });
    expect(field(table, "tsPair").defaultValue).toBeUndefined();
  });

  it("an omitted T | null field is filled from T's default", async () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    let seen: Array<Record<string, unknown>> = [];
    await table.insertOne({ id: 1, x: 5, ...row } as any, {
      guard: (ctx: TDbWriteGuardContext<any>) => {
        seen = ctx.rows;
      },
    });
    expect(typeof seen[0]!.y).toBe("number");
    expect(seen[0]!.x).toBe(5);
  });

  it("a member default does not make the field optional on insert, T | null's does", async () => {
    const table = new AtscriptDbTable(UnionMembers, new MockAdapter());
    let seen: Array<Record<string, unknown>> = [];
    await table.insertOne({ id: 1, ...row } as any, {
      guard: (ctx: TDbWriteGuardContext<any>) => {
        seen = ctx.rows;
      },
    });
    expect(typeof seen[0]!.x).toBe("number");
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

  it("a union alias prop and T | null inside nested objects get T's default", async () => {
    const table = new AtscriptDbTable(UnionAliasProps, new MockAdapter());
    for (const path of ["maybe", "maybeDef", "stamped.at", "group.at"]) {
      expect(field(table, path).defaultValue, path).toEqual({ kind: "fn", fn: "now" });
    }
    let seen: Array<Record<string, unknown>> = [];
    const guard = (ctx: TDbWriteGuardContext<any>) => {
      seen = ctx.rows;
    };
    await table.insertOne({ id: 1, stamped: null, group: {} } as any, { guard });
    // filled inside a present object; a null embedded object stays null
    expect(seen[0]).toMatchObject({ stamped: null, group: { at: expect.any(Number) } });
    expect(typeof seen[0]!.maybe).toBe("number");
    await table.insertOne(
      { id: 2, maybe: null, stamped: { label: "a" }, group: { at: null } } as any,
      {
        guard,
      },
    );
    // an explicit null is kept
    expect(seen[0]).toMatchObject({ maybe: null, stamped: { label: "a", at: expect.any(Number) } });
    expect(seen[0]!.group).toEqual({ at: null });
  });
});
