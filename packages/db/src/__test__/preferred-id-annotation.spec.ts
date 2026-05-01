import { beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";

import dbPlugin from "../plugin";
import { prepareFixtures } from "./test-utils";

describe("@db.table.preferredId.uniqueIndex annotation", () => {
  beforeAll(async () => {
    await prepareFixtures();
  });

  it("stamps the no-argument form as true metadata", async () => {
    const { EmailPreferredUser } = await import("./fixtures/preferred-id.as");
    expect(EmailPreferredUser.metadata.get("db.table.preferredId.uniqueIndex")).toBe(true);
  });

  it("stamps the named form as the requested unique-index name", async () => {
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    expect(SlugPreferredUser.metadata.get("db.table.preferredId.uniqueIndex")).toBe("by_slug");
  });

  it("rejects @db.view interfaces", async () => {
    const messages = await diagnosticsFor(`
      @db.view 'v'
      @db.table.preferredId.uniqueIndex
      export interface BadView {
        id: string
      }
    `);
    expect(messages).toContain(
      "@db.table.preferredId.uniqueIndex is not supported on @db.view interfaces (views have no unique-index declarations).",
    );
  });

  it("rejects interfaces without @db.table", async () => {
    const messages = await diagnosticsFor(`
      @db.table.preferredId.uniqueIndex
      export interface MissingTable {
        @db.index.unique
        email: string
      }
    `);
    expect(messages).toContain(
      "@db.table.preferredId.uniqueIndex requires @db.table on the same interface",
    );
  });

  it("rejects interfaces without unique indexes", async () => {
    const messages = await diagnosticsFor(`
      @db.table
      @db.table.preferredId.uniqueIndex
      export interface NoUnique {
        @meta.id
        id: string
      }
    `);
    expect(messages).toContain(
      "@db.table.preferredId.uniqueIndex requires at least one @db.index.unique on a prop of this interface.",
    );
  });

  it("rejects unique-index names that do not match a declared group", async () => {
    const messages = await diagnosticsFor(`
      @db.table
      @db.table.preferredId.uniqueIndex 'by_slug'
      export interface WrongName {
        @meta.id
        id: string

        @db.index.unique 'by_email'
        email: string
      }
    `);
    expect(messages).toContain(
      '@db.table.preferredId.uniqueIndex("by_slug") does not match any declared @db.index.unique on this interface; declared groups: ["by_email"].',
    );
  });
});

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "preferred-id-diagnostics-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()].flat().map((message) => message.message);
}
