import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import dbPlugin from "@atscript/db/plugin";
import { describe, it, expect } from "vite-plus/test";

import MongoPlugin from "../../plugin/index";
import { annotations } from "../../plugin/annotations";
import { syncIndexesImpl } from "../mongo-schema-sync";

// Atlas Search analyzers: the built-in names are completion hints, not a
// closed list. An analyzer Atlas does not know fails the schema sync — it is
// no longer swallowed with the rest of the search-index block.

async function errorsFor(annotation: string, field = "title: string"): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "mongo-analyzers-"));
  writeFileSync(
    join(rootDir, "fixture.as"),
    `
@db.table 'ma_t'
${annotation.startsWith("@db.mongo.search.text") ? "" : annotation}
export interface MaT {
    @meta.id
    id: number

    ${annotation.startsWith("@db.mongo.search.text") ? annotation : ""}
    ${field}
}
`,
  );
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin(), MongoPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .filter((m) => m.severity === 1)
    .map((m) => m.message);
}

function makeHost(collection: Record<string, unknown>) {
  return {
    ensureCollectionExists: async () => {},
    _log: () => {},
    _table: { indexes: new Map() },
    _mongoIndexes: new Map([
      [
        "atscript__dynamic_text___",
        {
          key: "atscript__dynamic_text___",
          name: "_",
          type: "dynamic_text",
          definition: { mappings: { dynamic: true }, analyzer: "lucene.klingon" },
        },
      ],
    ]),
    collection: {
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async () => {},
      dropIndex: async () => {},
      ...collection,
    },
  } as any;
}

describe("Atlas Search analyzers", () => {
  it.each([
    `@db.mongo.search.dynamic "lucene.danish"`,
    `@db.mongo.search.static "lucene.keyword", 0, "byTitle"`,
    `@db.mongo.search.text "lucene.ukrainian"`,
  ])("accepts %s (outside the old list)", async (annotation) => {
    expect(await errorsFor(annotation)).toEqual([]);
  });

  it("offers the built-in analyzers as completion, without closing the list", () => {
    const arg = (annotations.search as any).dynamic.config.argument[0];
    expect(arg.values).toBeUndefined();
    expect(arg.valueScope().map((c: { value: string }) => c.value)).toEqual(
      expect.arrayContaining([
        "lucene.standard",
        "lucene.keyword",
        "lucene.english",
        "lucene.danish",
      ]),
    );
  });

  it("a search index Atlas refuses fails the sync", async () => {
    const host = makeHost({
      listSearchIndexes: () => ({ toArray: async () => [] }),
      createSearchIndex: async () => {
        throw new Error("analyzer lucene.klingon is not defined");
      },
    });
    await expect(syncIndexesImpl(host)).rejects.toThrow(
      /index sync failed .*atscript__dynamic_text___.*lucene\.klingon/,
    );
  });

  it("no Atlas Search (standalone server): the search indexes are skipped", async () => {
    let created = false;
    const host = makeHost({
      listSearchIndexes: () => {
        throw new Error("$listSearchIndexes is only supported on Atlas");
      },
      createSearchIndex: async () => {
        created = true;
      },
    });
    await expect(syncIndexesImpl(host)).resolves.toBeDefined();
    expect(created).toBe(false);
  });
});
