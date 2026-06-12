import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

let fixtures: Record<string, any>;

// Repro coverage for the schema-sync edge cases found via as-test E.47-E.54:
// definition-drifted indexes, unique-over-duplicates error surfacing, views
// blocking column drops, and FTS5 triggers blocking column drops.
describe("SQLite: schema-sync edge cases", () => {
  let driver: BetterSqlite3Driver;

  beforeAll(async () => {
    await prepareFixtures();
    fixtures = await import("./fixtures/sync-edge-cases.as");
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
  });

  afterEach(() => {
    driver.close();
  });

  function syncFor() {
    const space = new DbSpace(() => new SqliteAdapter(driver));
    return new SchemaSync(space);
  }

  function indexColumns(indexName: string): string[] {
    return driver
      .all<{ name: string | null }>(`PRAGMA index_info("${indexName}")`)
      .map((c) => c.name)
      .filter((n): n is string => n !== null);
  }

  // Fix: name-only index diffing — a composite index that gains a member
  // keeps its name, so the diff must compare column lists, not just names
  it("rebuilds an index whose definition changed (membership grew)", async () => {
    const r1 = await syncFor().run([fixtures.UcImcV1], { force: true });
    expect(r1.status).toBe("synced");
    expect(indexColumns("atscript__plain__uc_imc_idx")).toEqual(["region"]);

    const r2 = await syncFor().run([fixtures.UcImcV2], { force: true });
    expect(r2.status).toBe("synced");
    expect(indexColumns("atscript__plain__uc_imc_idx")).toEqual(["region", "status"]);

    // Idempotent — matching definition must not churn
    const r3 = await syncFor().run([fixtures.UcImcV2]);
    expect(r3.status).toBe("up-to-date");
  });

  // Fix: index DDL failures surfaced as error entries, hash not persisted
  it("surfaces unique-over-duplicates as an error entry and retries until clean", async () => {
    await syncFor().run([fixtures.UcUodV1], { force: true });
    driver.exec(`INSERT INTO "uc_uod" ("email") VALUES ('dup@x.com'), ('dup@x.com')`);

    const errored = await syncFor().run([fixtures.UcUodV2], { force: true });
    const entry = errored.entries.find((e) => e.name === "uc_uod");
    expect(entry?.status).toBe("error");
    expect(entry?.errors?.[0]).toContain("uc_uod");

    // Hash must not be persisted — a non-force re-run still attempts (and
    // still errors) instead of reporting up-to-date
    const retry = await syncFor().run([fixtures.UcUodV2]);
    expect(retry.status).not.toBe("up-to-date");
    expect(retry.entries.find((e) => e.name === "uc_uod")?.status).toBe("error");

    // After cleanup the same sync recovers and enforces uniqueness
    driver.exec(`DELETE FROM "uc_uod" WHERE rowid NOT IN (SELECT MIN(rowid) FROM "uc_uod")`);
    const recovered = await syncFor().run([fixtures.UcUodV2], { force: true });
    expect(recovered.entries.find((e) => e.name === "uc_uod")?.status).not.toBe("error");
    expect(() => driver.exec(`INSERT INTO "uc_uod" ("email") VALUES ('dup@x.com')`)).toThrow(
      /UNIQUE/,
    );

    const settled = await syncFor().run([fixtures.UcUodV2]);
    expect(settled.status).toBe("up-to-date");
  });

  // Fix: changed views dropped before table ops — SQLite refuses DROP COLUMN
  // while a view still references the column
  it("drops a column referenced by a tracked view when the view is updated in the same sync", async () => {
    const r1 = await syncFor().run([fixtures.UcArticleV1, fixtures.UcListV1], { force: true });
    expect(r1.status).toBe("synced");
    driver.exec(`INSERT INTO "uc_articles" ("title", "summary") VALUES ('t1', 's1')`);

    const r2 = await syncFor().run([fixtures.UcArticleV2, fixtures.UcListV2], { force: true });
    expect(r2.status).toBe("synced");

    const cols = driver
      .all<{ name: string }>(`PRAGMA table_info("uc_articles")`)
      .map((c) => c.name);
    expect(cols).not.toContain("summary");

    const viewRows = driver.all<{ title: string }>(`SELECT * FROM "uc_article_list"`);
    expect(viewRows).toHaveLength(1);
    expect(viewRows[0]!.title).toBe("t1");
    expect(viewRows[0]).not.toHaveProperty("summary");
  });

  // Fix: FTS5 shadow tables/triggers torn down before their column is dropped
  it("drops a fulltext-indexed column cleanly (FTS5 artifacts removed first)", async () => {
    const r1 = await syncFor().run([fixtures.UcDocV1], { force: true });
    expect(r1.status).toBe("synced");
    driver.exec(`INSERT INTO "uc_docs" ("title", "content") VALUES ('t1', 'words')`);

    const r2 = await syncFor().run([fixtures.UcDocV2], { force: true });
    expect(r2.status).toBe("synced");

    const cols = driver.all<{ name: string }>(`PRAGMA table_info("uc_docs")`).map((c) => c.name);
    expect(cols).not.toContain("content");

    // No FTS artifacts left behind
    const leftovers = driver.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name LIKE 'uc_docs__fts__%'`,
    );
    expect(leftovers).toHaveLength(0);

    // Data preserved, table still writable (no broken triggers)
    driver.exec(`INSERT INTO "uc_docs" ("title") VALUES ('t2')`);
    const rows = driver.all(`SELECT * FROM "uc_docs"`);
    expect(rows).toHaveLength(2);
  });
});
