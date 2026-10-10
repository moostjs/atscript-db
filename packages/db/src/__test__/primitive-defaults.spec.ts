import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import type { TDbWriteGuardContext } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

let PdEvent: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ PdEvent } = await import("./fixtures/primitive-defaults.as"));
});

const now = { kind: "fn", fn: "now" };

function defaultOf(table: AtscriptDbTable, path: string) {
  const fd = table.fieldDescriptors.find((d) => d.path === path);
  if (!fd) throw new Error(`no field ${path}`);
  return fd.defaultValue;
}

const required = {
  id: 1,
  updatedAt: 1,
  mixed: "a",
  pair: [1, "a"],
  stamps: [],
  sourceCreatedAt: 1,
  sourceClosedAt: null,
  name: "n",
  history: [],
  payload: {},
  steps: [{ at: 1 }, { note: "n" }],
  events: [],
};

/** An adapter whose engine applies `now` itself (a DDL DEFAULT). */
class NativeNowAdapter extends MockAdapter {
  override nativeDefaultFns() {
    return new Set(["now" as const]);
  }
}

describe("number.timestamp.created", () => {
  it("is a @db.default.now column: direct, optional, alias, T | null, nested", () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    for (const path of [
      "createdAt",
      "createdOpt",
      "aliased",
      "nullable",
      "audit.at",
      "maybeAudit.at",
    ]) {
      expect(defaultOf(table, path), path).toEqual(now);
    }
  });

  it("an explicit @db.default on the field wins", () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    expect(defaultOf(table, "overridden")).toEqual({ kind: "value", value: "5" });
  });

  it("no default for union / tuple / array members, a field ref, or number.timestamp.updated", () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    for (const path of [
      "mixed",
      "pair",
      "stamps",
      "sourceCreatedAt",
      "sourceClosedAt",
      "updatedAt",
    ]) {
      expect(defaultOf(table, path), path).toBeUndefined();
    }
  });

  it("is optional on insert and filled, inside present embedded objects only", async () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    let seen: Array<Record<string, unknown>> = [];
    const guard = (ctx: TDbWriteGuardContext<any>) => {
      seen = ctx.rows;
    };
    await table.insertOne({ ...required, audit: {}, maybeAudit: null } as any, { guard });
    const row = seen[0]!;
    for (const key of ["createdAt", "createdOpt", "aliased", "nullable"]) {
      expect(typeof row[key], key).toBe("number");
    }
    expect(row.overridden).toBe(5);
    expect(row.audit).toEqual({ at: expect.any(Number), by: "system" });
    expect(row.maybeAudit).toBeNull();

    await table.insertOne({ ...required, id: 2, audit: {} } as any, { guard });
    expect(seen[0]).not.toHaveProperty("maybeAudit");

    await table.insertOne({ ...required, id: 3, audit: { at: 7 }, maybeAudit: {} } as any, {
      guard,
    });
    expect(seen[0]!.audit).toEqual({ at: 7, by: "system" });
    expect(seen[0]!.maybeAudit).toEqual({ at: expect.any(Number) });
  });

  it("is filled in every array item and inside a JSON value, even when the engine applies now", async () => {
    for (const adapter of [new MockAdapter(), new NativeNowAdapter()]) {
      const table = new AtscriptDbTable(PdEvent, adapter);
      let seen: Array<Record<string, unknown>> = [];
      await table.insertOne(
        { ...required, audit: {}, history: [{ note: "a" }, { note: "b", at: 3 }] } as any,
        {
          guard: (ctx: TDbWriteGuardContext<any>) => {
            seen = ctx.rows;
          },
        },
      );
      const row = seen[0]!;
      expect(row.history).toEqual([
        { note: "a", at: expect.any(Number) },
        { note: "b", at: 3 },
      ]);
      expect(row.payload).toEqual({ at: expect.any(Number) });
      expect(row.steps).toEqual([{ at: 1 }, { note: "n" }]);
      // a column of its own: left to the engine when it applies now
      if (adapter instanceof NativeNowAdapter) {
        expect(row).not.toHaveProperty("createdAt");
        expect(row.audit).toEqual({ by: "system" });
      } else {
        expect(typeof row.createdAt).toBe("number");
      }
    }
  });

  it("below a tuple or a union of several types: not filled, so required", async () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    await expect(
      table.insertOne({ ...required, audit: {}, steps: [{}, { note: "n" }] } as any),
    ).rejects.toThrow(/steps\.0\.at/);
    await expect(
      table.insertOne({ ...required, audit: {}, events: [{ kind: "open" }] } as any),
    ).rejects.toThrow(/events\.0/);
    let seen: Array<Record<string, unknown>> = [];
    await table.insertOne(
      {
        ...required,
        audit: {},
        events: [
          { kind: "open", at: 2 },
          { kind: "note", text: "t" },
        ],
      } as any,
      {
        guard: (ctx: TDbWriteGuardContext<any>) => {
          seen = ctx.rows;
        },
      },
    );
    expect(seen[0]!.events).toEqual([
      { kind: "open", at: 2 },
      { kind: "note", text: "t" },
    ]);
  });

  it("other fields stay required", async () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    const { sourceCreatedAt: _, ...noRef } = required;
    await expect(table.insertOne({ ...noRef, audit: {} } as any)).rejects.toThrow(
      /sourceCreatedAt/,
    );
    const { sourceClosedAt: _c, ...noClosedRef } = required;
    await expect(table.insertOne({ ...noClosedRef, audit: {} } as any)).rejects.toThrow(
      /sourceClosedAt/,
    );
    const { updatedAt: __, ...noUpdated } = required;
    await expect(table.insertOne({ ...noUpdated, audit: {} } as any)).rejects.toThrow(/updatedAt/);
  });

  it("string.required keeps @meta.required on a plain field (atscript 0.1.104)", async () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    await expect(table.insertOne({ ...required, name: " ", audit: {} } as any)).rejects.toThrow(
      /name/,
    );
  });
});
