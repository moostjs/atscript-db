import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationSpec, build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

import { Validator, type TValidatorPlugin } from "@atscript/typescript/utils";

import { createDbValidatorPlugin, type DbValidationContext } from "../db-validator-plugin";
import dbPlugin from "../plugin";
import { AtscriptDbTable } from "../table/db-table";
import type { TDbWriteGuardContext } from "../types";

import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

let PdEvent: any;
let PdUpdated: any;
let PdUpdatedVersioned: any;
let PdEdited: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ PdEvent, PdUpdated, PdUpdatedVersioned, PdEdited } =
    await import("./fixtures/primitive-defaults.as"));
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

  it("no default for union / tuple / array members or a field ref", () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    for (const path of ["mixed", "pair", "stamps", "sourceCreatedAt", "sourceClosedAt"]) {
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
    for (const key of ["createdAt", "createdOpt", "aliased", "nullable", "updatedAt"]) {
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

  it("required below a tuple / union also for a caller that asks only about absent values", () => {
    // A form's server-managed check (atscript-ui) consults the plugin only for
    // a missing value, so the plugin never sees the union / tuple holding it.
    const dbPlugin = createDbValidatorPlugin();
    const insert: DbValidationContext = { mode: "insert" };
    const absentOnly: TValidatorPlugin = (ctx, def, value) =>
      value === undefined
        ? dbPlugin(Object.create(ctx, { context: { value: insert } }), def, value)
        : undefined;
    const validator = new Validator(PdEvent, { plugins: [absentOnly] });
    const base = { ...required, audit: {} };
    expect(validator.validate(base, true)).toBe(true);
    expect(validator.validate({ ...base, steps: [{}, { note: "n" }] }, true)).toBe(false);
    expect(validator.errors[0]!.path).toBe("steps.0.at");
    expect(validator.validate({ ...base, events: [{ kind: "open" }] }, true)).toBe(false);
    expect(validator.errors[0]!.path).toMatch(/^events\.0/);
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
  });

  it("string.required keeps @meta.required on a plain field (atscript 0.1.104)", async () => {
    const table = new AtscriptDbTable(PdEvent, new MockAdapter());
    await expect(table.insertOne({ ...required, name: " ", audit: {} } as any)).rejects.toThrow(
      /name/,
    );
  });
});

/** The last adapter call of `method` (or, with a predicate, the last matching one). */
function lastCall(adapter: MockAdapter, match: string | ((method: string) => boolean)) {
  const test = typeof match === "string" ? (m: string) => m === match : match;
  return adapter.calls.findLast((c) => test(c.method))!;
}

const mode = (m: DbValidationContext["mode"]): DbValidationContext => ({ mode: m });

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "on-update-now-diagnostics-"));
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

describe("number.timestamp.updated", () => {
  const base = { id: 1, audit: {}, history: [] };
  let adapter: NestedMockAdapter;
  let table: AtscriptDbTable;
  const last = (method: string) => lastCall(adapter, method);
  const inserted = () => {
    const call = lastCall(adapter, (m) => m.startsWith("insert"));
    return call.method === "insertMany" ? call.args[0][0] : call.args[0];
  };

  beforeAll(() => {
    adapter = new NestedMockAdapter();
    table = new AtscriptDbTable(PdUpdated, adapter);
  });

  it("is @db.default.now + @db.onUpdate.now: direct, optional, alias, T | null, nested", () => {
    const stamped = ["updatedAt", "updatedOpt", "aliased", "nullable", "audit.at", "maybeAudit.at"];
    for (const path of stamped) {
      expect(defaultOf(table, path), path).toEqual(now);
    }
    expect([...table.getMetadata().onUpdateNow].toSorted()).toEqual(
      [...stamped, "editedAt", "history.at"].toSorted(),
    );
    // a bare @db.onUpdate.now has no insert default
    expect(defaultOf(table, "editedAt")).toBeUndefined();
    // a member of another union and a field ref get neither
    for (const path of ["mixed", "sourceUpdatedAt"]) {
      expect(defaultOf(table, path), path).toBeUndefined();
      expect(table.getMetadata().onUpdateNow.has(path), path).toBe(false);
    }
  });

  it("insert: filled when omitted, an explicit value wins", async () => {
    const before = Date.now();
    await table.insertOne({ ...base, history: [{ key: "a" }] } as any);
    const row = inserted();
    for (const key of ["updatedAt", "updatedOpt", "aliased", "nullable"]) {
      expect(row[key], key).toBeGreaterThanOrEqual(before);
    }
    expect(row.audit.at).toBeGreaterThanOrEqual(before);
    expect(row.history[0].at).toBeGreaterThanOrEqual(before);
    expect(row).not.toHaveProperty("editedAt");
    await table.insertOne({ ...base, id: 2, updatedAt: 5, audit: { at: 6 } } as any);
    expect(inserted()).toMatchObject({ updatedAt: 5, audit: { at: 6 } });
  });

  it("patch: sets the top-level fields, overriding a supplied value", async () => {
    const before = Date.now();
    await table.updateOne({ id: 1, name: "n", updatedAt: 5, nullable: null } as any);
    const data = last("updateOne").args[1];
    expect(data.name).toBe("n");
    for (const key of ["updatedAt", "updatedOpt", "aliased", "nullable", "editedAt"]) {
      expect(data[key], key).toBeGreaterThanOrEqual(before);
    }
    // nested ones only inside an object the patch carries
    expect(Object.keys(data).filter((k) => k.includes("."))).toEqual([]);
  });

  it("patch: nested fields are set inside carried objects and array items", async () => {
    const before = Date.now();
    await table.updateOne({ id: 1, audit: { note: "x", at: 1 }, maybeAudit: null } as any);
    const data = last("updateOne").args[1];
    expect(data["audit.at"] ?? data.audit?.at).toBeGreaterThanOrEqual(before);
    expect(data.maybeAudit).toBeNull();

    await table.updateOne({
      id: 1,
      history: { $insert: [{ key: "b" }], $update: [{ key: "a" }], $remove: [{ key: "c" }] },
    } as any);
    // resolved against the stored row: the updated and the added item are stamped
    expect(last("updateOne").args[1].history).toEqual([
      { key: "a", at: expect.any(Number) },
      { key: "b", at: expect.any(Number) },
    ]);
    expect(last("updateOne").args[1].history[0].at).toBeGreaterThanOrEqual(before);
  });

  it("patch: a payload with nothing to write stays a no-op", async () => {
    const calls = adapter.calls.length;
    const result = await table.updateOne({ id: 1, updatedAt: 5 } as any);
    expect(result).toEqual({ matchedCount: expect.any(Number), modifiedCount: 0 });
    expect(adapter.calls.slice(calls).map((c) => c.method)).toEqual(["count"]);
  });

  it("bulkUpdate / updateMany: every row gets the same time", async () => {
    const before = Date.now();
    await table.bulkUpdate([
      { id: 1, name: "a" },
      { id: 2, name: "b", updatedAt: 1 },
    ] as any);
    const [a, b] = adapter.calls.filter((c) => c.method === "updateOne").slice(-2);
    expect(a!.args[1].updatedAt).toBeGreaterThanOrEqual(before);
    expect(b!.args[1].updatedAt).toBe(a!.args[1].updatedAt);

    await table.updateMany({ name: "a" } as any, { name: "c", updatedAt: 1 } as any);
    const many = last("updateMany").args[1];
    expect(many.updatedAt).toBeGreaterThanOrEqual(before);
    expect(many.editedAt).toBe(many.updatedAt);

    const calls = adapter.calls.length;
    await table.updateMany({ name: "a" } as any, { updatedAt: 1 } as any);
    expect(adapter.calls.slice(calls).map((c) => c.method)).toEqual(["count"]);
  });

  it("replace: sets every field the payload carries, overriding a supplied value", async () => {
    const before = Date.now();
    await table.replaceOne({
      ...base,
      updatedAt: 1,
      aliased: 1,
      nullable: null,
      audit: { at: 1 },
      maybeAudit: { at: 1 },
      history: [{ key: "a", at: 1 }],
    } as any);
    const row = last("replaceOne").args[1];
    for (const key of ["updatedAt", "updatedOpt", "aliased", "nullable", "editedAt"]) {
      expect(row[key], key).toBeGreaterThanOrEqual(before);
    }
    expect(row.audit.at).toBe(row.updatedAt);
    expect(row.maybeAudit.at).toBe(row.updatedAt);
    expect(row.history[0].at).toBe(row.updatedAt);

    await table.replaceMany({ id: 1 } as any, { ...base, updatedAt: 1 } as any);
    expect(last("replaceMany").args[1].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("a bare @db.onUpdate.now field: required on insert, optional on replace", () => {
    const validator = new Validator(PdEdited, { plugins: [createDbValidatorPlugin()] });
    expect(validator.validate({ id: 1 }, true, mode("replace"))).toBe(true);
    expect(validator.validate({ id: 1 }, true, mode("insert"))).toBe(false);
    expect(validator.errors[0]!.path).toBe("editedAt");
  });

  it("one time per write call: every row and every now default of it", async () => {
    // a clock that moves on every read
    let tick = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ++tick);
    try {
      const mock = new NestedMockAdapter();
      const events = new AtscriptDbTable(PdEvent, mock);
      const { updatedAt: _, ...noUpdated } = required;
      const rows = [
        { ...noUpdated, audit: {} },
        { ...noUpdated, id: 2, audit: {} },
      ];
      await events.insertMany(rows as any);
      const [a, b] = lastCall(mock, "insertMany").args[0];
      for (const row of [a, b]) {
        for (const key of ["createdAt", "aliased", "nullable", "updatedAt"]) {
          expect(row[key], key).toBe(a.createdAt);
        }
        expect(row.audit.at).toBe(a.createdAt);
      }

      await events.replaceOne({ ...noUpdated, audit: {} } as any);
      const replaced = lastCall(mock, "replaceOne").args[1];
      expect(replaced.createdAt).toBe(replaced.updatedAt);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not change version exemption", async () => {
    const versioned = new NestedMockAdapter();
    const vt = new AtscriptDbTable(PdUpdatedVersioned, versioned);
    await vt.updateOne({ id: 1, views: 3 } as any);
    let call = lastCall(versioned, "updateOne");
    expect(call.args[1].updatedAt).toEqual(expect.any(Number));
    expect(call.args[4]).toEqual({ keepVersion: true });

    await vt.updateOne({ id: 1, title: "t" } as any);
    call = lastCall(versioned, "updateOne");
    expect(call.args[1].updatedAt).toEqual(expect.any(Number));
    expect(call.args[4]).toBeUndefined();
  });
});

describe("@db.onUpdate.now annotation", () => {
  it("is a documented annotation spec (editor completion and hover)", async () => {
    const config = (await dbPlugin().config?.({} as any)) as any;
    const spec = config.annotations.db.onUpdate.now;
    expect(spec).toBeInstanceOf(AnnotationSpec);
    expect(spec.config.description).toContain("on every update");
  });

  it("accepts number fields, rejects other types and @db.encrypted", async () => {
    expect(await diagnosticsFor(tableSource("  @db.onUpdate.now\n  at: number.timestamp"))).toEqual(
      [],
    );
    expect(await diagnosticsFor(tableSource("  @db.onUpdate.now\n  at: string"))).toEqual([
      '@db.onUpdate.now is not compatible with type "string" — requires number',
    ]);
    expect(
      await diagnosticsFor(tableSource("  @db.encrypted\n  @db.onUpdate.now\n  at?: number")),
    ).toContainEqual(expect.stringContaining("@db.encrypted cannot coexist with @db.onUpdate.now"));
    expect(
      await diagnosticsFor(
        tableSource("  @db.onUpdate.now\n  @db.column.version\n  v: number.int"),
      ),
    ).toContainEqual(expect.stringContaining("cannot coexist with @db.column.version"));
    expect(
      await diagnosticsFor(
        "@db.table 't'\nexport interface T {\n  @meta.id\n  @db.onUpdate.now\n  id: number\n}",
      ),
    ).toContainEqual(expect.stringContaining("cannot coexist with @meta.id"));
  });
});
