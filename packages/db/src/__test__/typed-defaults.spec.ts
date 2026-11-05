import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import dbPlugin from "../plugin";
import { computeTableHash, computeTableSnapshot } from "../schema/schema-hash";
import { AtscriptDbTable } from "../table/db-table";
import type { TDbWriteGuardContext } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

// `@db.default` takes a literal of the field's type — `0`, `-1.5`, `true`,
// `"active"` — next to the string form non-string fields parse as JSON.

async function errorsFor(field: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "typed-defaults-"));
  writeFileSync(
    join(rootDir, "fixture.as"),
    `
@db.table 'td_t'
export interface TdT {
    @meta.id
    id: number

${field}
}
`,
  );
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .filter((m) => m.severity === 1)
    .map((m) => m.message);
}

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/typed-defaults.as");
});

describe("@db.default literal kinds — compile time", () => {
  it.each([
    ["@db.default 0\n    n: number"],
    ["@db.default -1.5\n    n: number"],
    ["@db.default 3\n    n: number.int"],
    ["@db.default true\n    b: boolean"],
    ["@db.default false\n    b?: boolean"],
    ['@db.default "active"\n    s: string'],
    ['@db.default "0"\n    n: number'],
    ['@db.default "[]"\n    tags: string[]'],
    ["@db.default 1\n    n: number | null"],
    ["@db.default 2.5\n    d: decimal"],
  ])("accepts %s", async (field) => {
    expect(await errorsFor(field)).toEqual([]);
  });

  it.each([
    ["@db.default true\n    n: number", "a boolean does not fit the field's type (number)"],
    ["@db.default 5\n    s: string", "a number does not fit the field's type (string)"],
    ["@db.default 1\n    b: boolean", "a number does not fit the field's type (boolean)"],
  ])("rejects %s", async (field, message) => {
    const errors = await errorsFor(field);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
  });
});

describe("@db.default literal kinds — runtime", () => {
  it("the field descriptor holds the same text form as the string spelling", () => {
    const table = new AtscriptDbTable(fx.TypedDefaults, new MockAdapter());
    const defaults = Object.fromEntries(
      table.fieldDescriptors.filter((f) => f.defaultValue).map((f) => [f.path, f.defaultValue]),
    );
    expect(defaults).toEqual({
      attempts: { kind: "value", value: "0" },
      delta: { kind: "value", value: "-1.5" },
      enabled: { kind: "value", value: "true" },
      archived: { kind: "value", value: "false" },
      status: { kind: "value", value: "active" },
      tier: { kind: "value", value: "a" },
      price: { kind: "value", value: "10.50" },
      legacyCount: { kind: "value", value: "0" },
      legacyFlag: { kind: "value", value: "true" },
    });
  });

  it("switching a default from the string form to a literal does not change the schema hash", () => {
    const typed = new AtscriptDbTable(fx.TypedDefaults, new MockAdapter());
    const strings = new AtscriptDbTable(fx.TypedDefaultsAsStrings, new MockAdapter());
    expect(computeTableHash(computeTableSnapshot(typed))).toBe(
      computeTableHash(computeTableSnapshot(strings)),
    );
  });

  it("an insert without the fields fills them with typed values", async () => {
    const table = new AtscriptDbTable(fx.TypedDefaults, new MockAdapter());
    let seen: Record<string, unknown> = {};
    await table.insertOne({ id: 1 } as any, {
      guard: (ctx: TDbWriteGuardContext<any>) => {
        seen = ctx.rows[0]!;
      },
    });
    expect(seen).toEqual({
      id: 1,
      attempts: 0,
      delta: -1.5,
      enabled: true,
      archived: false,
      status: "active",
      tier: "a",
      price: "10.50",
      legacyCount: 0,
      legacyFlag: true,
    });
  });

  it("a decimal default is filled as the decimal string, in either spelling", async () => {
    for (const type of [fx.TypedDefaults, fx.TypedDefaultsAsStrings]) {
      const table = new AtscriptDbTable(type, new MockAdapter());
      let seen: Record<string, unknown> = {};
      await table.insertOne({ id: 1 } as any, {
        guard: (ctx: TDbWriteGuardContext<any>) => {
          seen = ctx.rows[0]!;
        },
      });
      expect(seen.price).toBe("10.50");
    }
  });
});
