import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";

// Since 0.1.165 `@db.rel.FK` accepts `Target.id | null` — the same optional
// foreign key as `field?: Target.id` (before: "requires a chain reference
// type …, got scalar type").

async function messagesOf(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "fk-nullable-ref-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

const TABLES = `
@db.table 'fn_people'
export interface FnPerson {
    @meta.id
    id: number
    name: string
}
`;

describe("@db.rel.FK on `ref | null`", () => {
  it("is accepted, with and without a paired @db.rel.to", async () => {
    expect(
      await messagesOf(`${TABLES}
@db.table 'fn_items'
export interface FnItem {
    @meta.id
    id: number

    @db.rel.FK
    ownerId: FnPerson.id | null

    @db.rel.to
    owner?: FnPerson
}
`),
    ).toEqual([]);
  });

  it("a union of two refs or with a non-null scalar is still refused", async () => {
    const messages = await messagesOf(`${TABLES}
@db.table 'fn_items2'
export interface FnItem2 {
    @meta.id
    id: number

    @db.rel.FK
    ownerId: FnPerson.id | string
}
`);
    expect(messages.some((m) => m.includes("@db.rel.FK requires a chain reference"))).toBe(true);
  });
});
