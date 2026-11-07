import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { createAdapter } from "../index";
import { prepareFixtures } from "./test-utils";

// A prebuilt SQLite file served read-only: built (schema sync + rows) with
// atscript-db, then opened by a second space over a `readonly` driver and
// searched without any sync.

let fx: Record<string, any>;
let dir: string;
let file: string;

const options = { ftsPrefix: [2, 3] } as const;
const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id);

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/readonly-pack.as");
  dir = mkdtempSync(join(tmpdir(), "asdb-readonly-"));
  file = join(dir, "pack.db");

  // build step: an ordinary writable space
  const build = createAdapter(file, options);
  await syncSchema(build, [fx.PackArticle]);
  await build.getTable(fx.PackArticle).insertMany([
    { id: 1, title: "Running shoes", body: "Light shoes for long runs" },
    { id: 2, title: "Quokka island", body: "A small marsupial" },
  ]);
  await build.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("[sqlite] a prebuilt read-only file", () => {
  it("is searched through a space over a readonly driver, without sync", async () => {
    const driver = new BetterSqlite3Driver(file, { readonly: true, fileMustExist: true });
    const pack = new DbSpace(() => new SqliteAdapter(driver, options), {
      onClose: () => driver.close(),
    });
    const articles = pack.getTable(fx.PackArticle) as any;

    expect(ids(await articles.search("run", {}))).toEqual([1]); // english stemmer
    expect(ids(await articles.search("quo*", {}))).toEqual([2]); // prefix index
    expect(await articles.count({ filter: { id: 2 } })).toBe(1);
    expect((await articles.findById(2))?.title).toBe("Quokka island");

    // writes are refused by SQLite
    await expect(articles.insertOne({ id: 3, title: "x", body: "y" })).rejects.toThrow(/readonly/i);
    await pack.close();
  });
});
