import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it, beforeAll } from "vite-plus/test";

import { DB_FULLTEXT_LANGUAGES } from "../index";
import dbPlugin from "../plugin";
import { computeTableSnapshot } from "../schema/schema-hash";
import { DbSpace } from "../table/db-space";
import type { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

// `@db.index.fulltext.language` / `.match` (since 0.1.168): per-index text
// language and term matching, declared on the interface.

async function diagnosticsFor(
  source: string,
): Promise<Array<{ message: string; severity: number }>> {
  const rootDir = mkdtempSync(join(tmpdir(), "fulltext-options-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .map((m) => ({ message: m.message, severity: m.severity }));
}

const errors = async (source: string) =>
  (await diagnosticsFor(source)).filter((m) => m.severity === 1).map((m) => m.message);

const table = (head: string, body = "    @db.index.fulltext 'ft'\n    body: string") => `
@db.table 'fto_t'
${head}
export interface FtoT {
    @meta.id
    id: number

${body}
}
`;

const specs = () => (dbPlugin().config as any)({}).annotations.db.index.fulltext;

describe("annotation specs (completion and hover)", () => {
  it("language: the closed language list, an optional index name, a hover per adapter", () => {
    const spec = specs().language;
    expect(spec.config.nodeType).toEqual(["interface"]);
    expect(spec.config.argument[0].values).toEqual([...DB_FULLTEXT_LANGUAGES]);
    expect(spec.config.argument[0].values).toContain("russian");
    expect(spec.config.argument[1].optional).toBe(true);
    for (const word of ["PostgreSQL", "MongoDB", "SQLite", "MySQL", "default_language"]) {
      expect(spec.config.description).toContain(word);
    }
  });

  it("match: all / any, an optional index name, a hover per adapter", () => {
    const spec = specs().match;
    expect(spec.config.argument[0].values).toEqual(["all", "any"]);
    expect(spec.config.argument[1].optional).toBe(true);
    expect(spec.config.description).toContain("websearch_to_tsquery");
  });

  it("@db.index.fulltext itself is unchanged", () => {
    expect(specs().$self.config.argument.map((a: any) => a.name)).toEqual(["name", "weight"]);
  });
});

describe("diagnostics", () => {
  it("accepts a table-wide and a named option", async () => {
    expect(
      await errors(
        table(`@db.index.fulltext.language "russian"\n@db.index.fulltext.match "all", "ft"`),
      ),
    ).toEqual([]);
  });

  it("rejects a language outside the list", async () => {
    expect((await errors(table(`@db.index.fulltext.language "klingon"`))).length).toBeGreaterThan(
      0,
    );
  });

  it("rejects an unknown index name", async () => {
    expect(await errors(table(`@db.index.fulltext.match "any", "nope"`))).toEqual([
      '@db.index.fulltext.match: no @db.index.fulltext "nope" on this interface; declared: ["ft"]',
    ]);
  });

  it("rejects an interface without fulltext indexes", async () => {
    expect(await errors(table(`@db.index.fulltext.language "german"`, "    body: string"))).toEqual(
      [
        "@db.index.fulltext.language needs at least one @db.index.fulltext on a prop of this interface",
      ],
    );
  });

  it("rejects the same option twice for one index", async () => {
    const found = await errors(
      table(`@db.index.fulltext.language "german"\n@db.index.fulltext.language "french"`),
    );
    expect(found).toEqual([
      "@db.index.fulltext.language without an index name is declared twice on this interface",
    ]);
  });

  it("finds an unnamed index by its field name, nested fields included", async () => {
    expect(
      await errors(
        table(
          `@db.index.fulltext.language "dutch", "profile.bio"`,
          "    profile: {\n        @db.index.fulltext\n        bio: string\n    }",
        ),
      ),
    ).toEqual([]);
  });
});

const indexesOf = (type: any) => {
  const table = new DbSpace(() => new MockAdapter()).getTable(type) as AtscriptDbTable;
  return new Map([...table.indexes.values()].map((i) => [i.name, i]));
};

describe("index metadata", () => {
  let fx: Record<string, any>;
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/fulltext-options.as");
  });

  it("a named option wins over the table-wide one", () => {
    const idx = indexesOf(fx.FtoArticle);
    expect(idx.get("ft_body")).toMatchObject({ language: "russian" });
    expect(idx.get("ft_body")!.match).toBeUndefined();
    expect(idx.get("ft_title")).toMatchObject({ language: "russian", match: "any" });
    expect(idx.get("ft_tags")).toMatchObject({ language: "none" });
  });

  it("no option, no keys — and the table snapshot stays as before", () => {
    const idx = indexesOf(fx.FtoPlain).get("ft_body")!;
    expect("language" in idx).toBe(false);
    expect("match" in idx).toBe(false);
    const table = new DbSpace(() => new MockAdapter()).getTable(fx.FtoPlain) as AtscriptDbTable;
    expect(JSON.stringify(computeTableSnapshot(table))).not.toContain("language");
  });

  it("the language enters the table snapshot (a change re-runs schema sync)", () => {
    const table = new DbSpace(() => new MockAdapter()).getTable(fx.FtoArticle) as AtscriptDbTable;
    const snap = computeTableSnapshot(table);
    expect(snap.indexes.find((i) => i.key.endsWith("ft_body"))).toMatchObject({
      language: "russian",
    });
  });
});
