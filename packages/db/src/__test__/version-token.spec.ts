import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect } from "vite-plus/test";

import dbPlugin from "../plugin";

/**
 * `@db.column.version.token` (since 0.1.196): the `@db.column.version` field
 * holds an opaque string the store issues — for a store that hands out its
 * own row version. Valid only on an adapter that declares
 * `supportsVersionTokens()`.
 */

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "version-token-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

function table(fields: string): string {
  return `
    @db.table 'vt_docs'
    export interface VtDoc {
      @meta.id
      id: number
      title: string
      ${fields}
    }
  `;
}

describe("compile rules", () => {
  it("a string version field with the modifier compiles", async () => {
    expect(
      await diagnosticsFor(table("@db.column.version\n@db.column.version.token\netag: string")),
    ).toEqual([]);
  });

  it("the modifier needs @db.column.version on the same field", async () => {
    expect(await diagnosticsFor(table("@db.column.version.token\netag: string"))).toEqual([
      "@db.column.version.token requires @db.column.version on the same field",
    ]);
  });

  it("the modifier needs a string field", async () => {
    expect(
      await diagnosticsFor(
        table("@db.column.version\n@db.column.version.token\nversion: number.int"),
      ),
    ).toEqual(['@db.column.version.token is not compatible with type "number" — requires string']);
  });

  it("a token field takes no @db.default*", async () => {
    expect(
      await diagnosticsFor(
        table("@db.column.version\n@db.column.version.token\n@db.default 'x'\netag: string"),
      ),
    ).toEqual([
      "@db.column.version.token cannot coexist with @db.default — a token is issued by the store",
    ]);
  });

  it("a token table takes no @db.column.version.exempt, nested fields included", async () => {
    const messages = await diagnosticsFor(
      table(`@db.column.version
      @db.column.version.token
      etag: string
      @db.column.version.exempt
      score: number
      stats: {
        @db.column.version.exempt
        hits: number
      }`),
    );
    const refusal =
      "@db.column.version.exempt cannot sit on a table whose version is a @db.column.version.token — a token is issued by the store";
    expect(messages).toEqual([refusal, refusal]);
  });

  it("the other version rules stay: optional, one per table", async () => {
    const messages = await diagnosticsFor(
      table(`@db.column.version
      @db.column.version.token
      etag?: string`),
    );
    expect(messages).toEqual([
      "@db.column.version requires a non-optional field — version columns are always populated (default 0)",
    ]);
  });
});
