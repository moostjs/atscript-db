import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The adapter's runtime source files (tests excluded). */
function runtimeSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__test__" ? [] : runtimeSources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

describe("db-memory runtime imports", () => {
  // `@atscript/core` is the compiler (rolldown + its native binding);
  // `@atscript/db/shared` and `/plugin` import it at runtime.
  it("never load the compiler", () => {
    const offending = runtimeSources(SRC).filter((file) =>
      /from\s+["']@atscript\/(?:core|db\/shared|db\/plugin)["']/.test(
        readFileSync(file, "utf8").replace(/import\s+type\s[^;]*;/g, ""),
      ),
    );
    expect(offending).toEqual([]);
  });
});
