import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";
import { dbSearchAnnotations } from "../plugin/annotations/search";

// `@db.search.vector` dimensions: any positive integer (the size of the
// embedding model's output); the common sizes are completion hints only.

async function errorsFor(dimensions: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "vector-dimensions-"));
  writeFileSync(
    join(rootDir, "fixture.as"),
    `
@db.table 'vd_t'
export interface VdT {
    @meta.id
    id: number

    @db.search.vector ${dimensions}
    emb: db.vector
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

const dimensionsArg = () => (dbSearchAnnotations.search as any).vector.$self.config.argument[0];

describe("@db.search.vector dimensions", () => {
  it.each(["8", "100", "1000", "1280", "1536", `1536, "cosine"`])(
    "accepts %s (any embedding size)",
    async (dimensions) => {
      expect(await errorsFor(dimensions)).toEqual([]);
    },
  );

  it.each(["0", "1.5", "-1"])("rejects %s (not a positive integer)", async (dimensions) => {
    expect(await errorsFor(dimensions)).toEqual([
      `@db.search.vector dimensions must be a positive integer, got '${dimensions}'`,
    ]);
  });

  it("offers the common sizes as completion candidates, without closing the list", () => {
    const arg = dimensionsArg();
    expect(arg.values).toBeUndefined();
    expect(arg.valueScope().map((c: { value: string }) => c.value)).toEqual(
      expect.arrayContaining(["256", "768", "1536", "3072", "16384"]),
    );
  });
});
