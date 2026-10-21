import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";

// Since 0.1.165 the internal `atscript__fulltext__<name>` keys are aliases of
// the declared names — a declared name with the reserved `atscript__` prefix
// could shadow one, so it is refused.

async function messagesOf(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "fulltext-reserved-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

describe("@db.index.fulltext reserved names", () => {
  it("refuses a name starting with atscript__", async () => {
    const messages = await messagesOf(`
@db.table 'fr_docs'
export interface FrDoc {
    @meta.id
    id: number

    @db.index.fulltext 'atscript__fulltext__body'
    body: string
}
`);
    expect(messages).toContain(
      `@db.index.fulltext name "atscript__fulltext__body" is reserved — names starting with "atscript__" are internal index keys`,
    );
  });

  it("accepts an ordinary name", async () => {
    expect(
      await messagesOf(`
@db.table 'fr_docs2'
export interface FrDoc2 {
    @meta.id
    id: number

    @db.index.fulltext 'body_ft'
    body: string
}
`),
    ).toEqual([]);
  });
});
