import { describe, it, expect } from "vite-plus/test";
import type { AtscriptRepo, TOutput } from "@atscript/core";

import { generateModelManifest } from "../plugin/manifest";

/**
 * Unit coverage for the dbPlugin model-manifest generator: entity selection,
 * table/view split, @db.space grouping, alias dedup across files, relative
 * import specifiers, and the format gate.
 */

type TStubNode = {
  annotations: { name: string; args: { text: string }[] }[];
  countAnnotations: (name: string) => number;
};

function makeNode(annotations: { name: string; args: { text: string }[] }[]): TStubNode {
  return {
    annotations,
    countAnnotations: (name) => annotations.filter((a) => a.name === name).length,
  };
}

function makeRepo(root: string, docs: Record<string, Record<string, TStubNode>>): AtscriptRepo {
  return {
    root,
    openDocument: async (uri: string) => {
      const doc = docs[uri];
      return doc ? { exports: new Map(Object.entries(doc)) } : undefined;
    },
  } as unknown as AtscriptRepo;
}

function makeOutput(sources: string[]): TOutput[] {
  return sources.map((source) => ({
    fileName: "x.js",
    content: "",
    source,
    target: "",
  }));
}

const table = (name: string, space?: string): TStubNode =>
  makeNode([
    { name: "db.table", args: [{ text: name }] },
    ...(space ? [{ name: "db.space", args: [{ text: space }] }] : []),
  ]);
const view = (name: string): TStubNode => makeNode([{ name: "db.view", args: [{ text: name }] }]);

describe("generateModelManifest", () => {
  it("emits tables/views/models grouped by space with relative .as imports", async () => {
    const repo = makeRepo("/proj", {
      "file:///proj/src/models/user.as": {
        User: table("users"),
        Helper: makeNode([]), // not a db entity — excluded
      },
      "file:///proj/src/feeds/feed-run.as": {
        FeedRun: table("feed_runs", "analytics"),
        ActiveFeeds: view("active_feeds"),
      },
    });
    const output = makeOutput([
      "file:///proj/src/models/user.as",
      "file:///proj/src/feeds/feed-run.as",
    ]);

    await generateModelManifest({ path: "src/atscript.models.ts" }, output, "dts", repo);

    const manifest = output.find((o) => o.target === "/proj/src/atscript.models.ts");
    expect(manifest).toBeDefined();
    const content = manifest!.content;

    expect(content).toContain('import { User } from "./models/user.as"');
    expect(content).toContain('import { ActiveFeeds } from "./feeds/feed-run.as"');
    // Sources are sorted (feeds < models), exports sorted per doc.
    expect(content).toContain("export const dbTables = [FeedRun, User] as const");
    expect(content).toContain("export const dbViews = [ActiveFeeds] as const");
    expect(content).not.toContain("Helper");
    // Views without @db.space group into "default" too.
    expect(content).toContain('"default": [ActiveFeeds, User]');
    expect(content).toContain('"analytics": [FeedRun]');
  });

  it("splits views out of dbTables and derives the aggregates without repeating them", async () => {
    const repo = makeRepo("/proj", {
      "file:///proj/a.as": { T: table("t"), V: view("v") },
    });
    const output = makeOutput(["file:///proj/a.as"]);
    await generateModelManifest({ path: "manifest.ts" }, output, "dts", repo);
    const content = output.at(-1)!.content;
    expect(content).toContain("export const dbTables = [T] as const");
    expect(content).toContain("export const dbViews = [V] as const");
    // Aggregates reference the kind lists — each alias is listed exactly once.
    expect(content).toContain("export const atscriptModels = [...dbTables, ...dbViews] as const");
    // Single space → the group is a reference, not a third copy of the list.
    expect(content).toContain('"default": atscriptModels,');
  });

  it("dedupes colliding export names across files with import aliases", async () => {
    const repo = makeRepo("/proj", {
      "file:///proj/a.as": { User: table("users_a") },
      "file:///proj/b.as": { User: table("users_b") },
    });
    const output = makeOutput(["file:///proj/a.as", "file:///proj/b.as"]);
    await generateModelManifest({ path: "manifest.ts" }, output, "dts", repo);
    const content = output.at(-1)!.content;
    expect(content).toContain('import { User } from "./a.as"');
    expect(content).toContain('import { User as User_1 } from "./b.as"');
    expect(content).toContain("[User, User_1]");
    // No views → still a (typed) empty tuple, not a bare mutable array.
    expect(content).toContain("export const dbViews = [] as const");
  });

  it("does nothing for non-dts formats (narrowed special-purpose builds)", async () => {
    const repo = makeRepo("/proj", { "file:///proj/a.as": { T: table("t") } });
    const output = makeOutput(["file:///proj/a.as"]);
    const before = output.length;
    await generateModelManifest({ path: "manifest.ts" }, output, "js", repo);
    expect(output.length).toBe(before);
  });
});
