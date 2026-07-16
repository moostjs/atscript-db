import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { prepareFixtures } from "@atscript/typescript/test-utils";

import dbPlugin from "../plugin";

/**
 * End-to-end manifest generation through the real compiler: `prepareFixtures`
 * runs `build()` + `generate()` which invokes the plugin's `buildEnd` — the
 * same pipeline `asc -f dts` uses in consumer projects.
 */

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures-manifest");
const manifestPath = path.join(fixturesDir, "models.gen.ts");

beforeAll(async () => {
  await prepareFixtures({
    rootDir: fixturesDir,
    plugins: [dbPlugin({ manifest: "models.gen.ts" })],
  });
});

describe("dbPlugin manifest (compiler E2E)", () => {
  it("emits the manifest module next to the fixtures", () => {
    const content = readFileSync(manifestPath, "utf8");
    expect(content).toContain('import { MfEvent } from "./events.as"');
    expect(content).toContain("export const dbTables = [MfEvent, MfUser] as const");
    expect(content).toContain("export const dbViews = [MfActiveUser] as const");
    expect(content).toContain('"analytics": [MfEvent]');
    expect(content).toContain('"default": [MfActiveUser, MfUser]');
  });

  it("the generated module is importable and carries live model tokens", async () => {
    const manifest = await import("./fixtures-manifest/models.gen");
    expect(manifest.atscriptModels).toHaveLength(3);
    expect(manifest.modelsBySpace.analytics[0].metadata.get("db.space")).toBe("analytics");
    expect(manifest.dbTables.map((m) => (m as { id?: string }).id ?? "")).toContain("MfUser");
  });
});
