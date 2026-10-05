import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";

import dbPlugin from "../plugin";

/**
 * `@db.rel.FK` on a `@db.table` is a real constraint: its target must be
 * unique on its own. A column of a composite primary key is not (since 0.1.148).
 */

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "fk-composite-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

const DICT = `
  @db.table 'attr_values'
  export interface AttrValue {
    @meta.id
    attribute: string
    @meta.id
    value: string
    @meta.id
    @db.index.unique
    code: string
  }
  @db.table 'plain_dict'
  export interface Plain {
    @meta.id
    id: number
  }
`;

describe("@db.rel.FK — composite primary key target", () => {
  it("is an error on a @db.table", async () => {
    const messages = await diagnosticsFor(`${DICT}
      @db.table 'items'
      export interface Item {
        @meta.id
        id: number
        @db.rel.FK
        color: AttrValue.value
      }`);
    expect(messages).toContain(
      "@db.rel.FK target 'AttrValue.value' is one column of a composite primary key — a foreign key must reference a unique column; for value help without a constraint use @ui.valueHelp",
    );
  });

  it("is accepted when the column is also unique, or the key is a single column", async () => {
    const messages = await diagnosticsFor(`${DICT}
      @db.table 'items'
      export interface Item {
        @meta.id
        id: number
        @db.rel.FK 'a'
        byCode: AttrValue.code
        @db.rel.FK 'b'
        byId: Plain.id
      }`);
    expect(messages.filter((m) => m.includes("composite primary key"))).toEqual([]);
  });

  it("a composite foreign key covering the whole key is accepted", async () => {
    const messages = await diagnosticsFor(`${DICT}
      @db.table 'pair_dict'
      export interface Pair {
        @meta.id
        a: string
        @meta.id
        b: string
      }
      @db.table 'items'
      export interface Item {
        @meta.id
        id: number
        @db.rel.FK 'pair'
        pairA: Pair.a
        @db.rel.FK 'pair'
        pairB: Pair.b
      }`);
    expect(messages.filter((m) => m.includes("composite primary key"))).toEqual([]);
  });

  it("a partial composite foreign key is an error", async () => {
    const messages = await diagnosticsFor(`${DICT}
      @db.table 'pair_dict'
      export interface Pair {
        @meta.id
        a: string
        @meta.id
        b: string
      }
      @db.table 'items'
      export interface Item {
        @meta.id
        id: number
        @db.rel.FK 'pair'
        pairA: Pair.a
      }`);
    expect(messages.filter((m) => m.includes("composite primary key"))).toHaveLength(1);
  });

  it("a sibling chaining into a nested path does not cover the key column", async () => {
    const messages = await diagnosticsFor(`${DICT}
      @db.table 'pair_dict'
      export interface Pair {
        @meta.id
        a: { x: string }
        @meta.id
        b: string
      }
      @db.table 'items'
      export interface Item {
        @meta.id
        id: number
        @db.rel.FK 'pair'
        pairA: Pair.a.x
        @db.rel.FK 'pair'
        pairB: Pair.b
      }`);
    expect(messages.filter((m) => m.includes("composite primary key")).length).toBeGreaterThan(0);
  });

  it("keeps working as the value-help indicator on a non-table host", async () => {
    const messages = await diagnosticsFor(`${DICT}
      export interface Form {
        @db.rel.FK
        color: AttrValue.value
      }`);
    expect(messages.filter((m) => m.includes("composite primary key"))).toEqual([]);
  });
});
