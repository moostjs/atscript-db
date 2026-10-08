import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";

// Compile-time diagnostics of `@db.column.searchable` / `@db.index.fulltext`
// on string and integer fields (since 0.1.150).

async function diagnosticsFor(
  source: string,
): Promise<Array<{ message: string; severity: number }>> {
  const rootDir = mkdtempSync(join(tmpdir(), "numeric-search-annotations-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .map((message) => ({ message: message.message, severity: message.severity }));
}

/** A table whose `field` lines are verbatim; `id` is an integer primary key. */
const table = (field: string, extra = "") => `
@db.table 'nsa_items'
export interface NsaItem {
    @meta.id
    id: number.int
${extra}
${field}
}
`;

const searchable = (decl: string) => table(`    @db.column.searchable\n    ${decl}`);
const fulltext = (decl: string, indexAnn = "    @db.index.plain") =>
  table(`    @db.index.fulltext 'ft'\n${indexAnn}\n    ${decl}`);

const errors = async (source: string) =>
  (await diagnosticsFor(source)).filter((m) => m.severity === 1).map((m) => m.message);

describe("@db.column.searchable — string and integer fields", () => {
  it.each([
    "title: string",
    "n: number.int",
    "n: number.int.int32",
    "n: number.int.uint8",
    "n: number.int.int64",
    "@expect.int\n    n: number",
  ])("accepts %s", async (decl) => {
    expect(await errors(searchable(decl))).toEqual([]);
  });

  it("accepts @db.default.increment on a number", async () => {
    expect(await errors(searchable("@db.default.increment\n    n: number"))).toEqual([]);
  });

  it.each([
    ["price: number", /"price" is a floating-point number — declare it number\.int/],
    ["price: number.double", /"price" is a floating-point number/],
    ["at: number.timestamp", /"at" is a timestamp — filter it by range instead/],
    ["at: number.timestamp.created", /"at" is a timestamp — filter it by range instead/],
    [
      "@db.default.now\n    at: number.int",
      /"at" is a timestamp \(@db\.default\.now\) — filter it by range instead/,
    ],
    [
      "@db.column.precision 10, 2\n    n: number.int",
      /"n" has @db\.column\.precision \(stored as a decimal\)/,
    ],
    ["price: decimal", /"price" is a decimal/],
    ["flag: boolean", /"flag" is a boolean/],
  ])("refuses %s", async (decl, message) => {
    const found = await errors(searchable(decl));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^@db\.column\.searchable needs a string or an integer field — /);
    expect(found[0]).toMatch(message);
  });
});

describe("@db.index.fulltext — string and integer fields", () => {
  it("accepts a string member", async () => {
    expect(await errors(table("    @db.index.fulltext 'ft'\n    title: string"))).toEqual([]);
  });

  it.each([
    ["price: number", /"price" is a floating-point number/],
    ["at: number.timestamp", /"at" is a timestamp/],
    ["price: decimal", /"price" is a decimal/],
    ["flag: boolean", /"flag" is a boolean/],
  ])("refuses %s", async (decl, message) => {
    const found = await errors(fulltext(decl));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^@db\.index\.fulltext needs a string or an integer field — /);
    expect(found[0]).toMatch(message);
  });

  it("accepts an index-backed integer member", async () => {
    expect(await errors(fulltext("n: number.int", "    @db.index.plain"))).toEqual([]);
    expect(await errors(fulltext("n: number.int", "    @db.index.unique"))).toEqual([]);
    expect(await errors(fulltext("n: number.int", "    @db.index.plain 'grp'"))).toEqual([]);
  });

  it("accepts the first @meta.id and _id as integer members", async () => {
    const onId = `
@db.table 'nsa_ids'
export interface NsaId {
    @meta.id
    @db.index.fulltext 'ft'
    id: number.int
}
`;
    expect(await errors(onId)).toEqual([]);
    const onUnderscoreId = `
@db.table 'nsa_underscore'
export interface NsaUnderscore {
    @db.index.fulltext 'ft'
    _id: number.int
}
`;
    expect(await errors(onUnderscoreId)).toEqual([]);
  });

  it("refuses an integer member without an index", async () => {
    const found = await errors(table("    @db.index.fulltext 'ft'\n    n: number.int"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/"n" needs an index for its exact-number match/);
  });

  it("refuses an integer that is not the first member of its composite index", async () => {
    const source = table(
      "    @db.index.fulltext 'ft'\n    @db.index.plain 'grp'\n    n: number.int",
      "    @db.index.plain 'grp'\n    first: string",
    );
    const found = await errors(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/"n" needs an index/);
  });

  it("refuses a second @meta.id as the only backing", async () => {
    const source = `
@db.table 'nsa_composite'
export interface NsaComposite {
    @meta.id
    a: number.int
    @meta.id
    @db.index.fulltext 'ft'
    b: number.int
}
`;
    const found = await errors(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/"b" needs an index/);
  });

  it("warns that a weight on an integer member is ignored", async () => {
    const all = await diagnosticsFor(
      table("    @db.index.fulltext 'ft', 5\n    @db.index.plain\n    n: number.int"),
    );
    expect(all.filter((m) => m.severity === 1)).toEqual([]);
    expect(all.filter((m) => m.severity === 2).map((m) => m.message)).toEqual([
      expect.stringMatching(/weight is ignored on an integer member/),
    ]);
  });
});
