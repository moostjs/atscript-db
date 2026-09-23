import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures, RecordingDriver } from "./test-utils";

/**
 * Existence-only predicates on JSON-stored columns (since 0.1.132): SQLite
 * cannot compare a JSON TEXT column, but `$exists` never looks at the content
 * — it compiles to `IS [NOT] NULL` on the column itself. An explicit `null`
 * and an absent value are both stored as SQL NULL, so `$exists: false`
 * matches both; `{}` / `[]` are values.
 */

type Row = Record<string, any>;
let JsonExistsDoc: any;

describe("SQLite — $exists on @db.json / array columns", () => {
  let driver: RecordingDriver;
  let table: AtscriptDbTable<any, Row, any, any, any, any, any>;

  beforeAll(async () => {
    await prepareFixtures();
    ({ JsonExistsDoc } = await import("./fixtures/guard-fixtures.as"));
  });

  beforeEach(async () => {
    driver = new RecordingDriver(new BetterSqlite3Driver(":memory:"));
    table = new AtscriptDbTable(JsonExistsDoc, new SqliteAdapter(driver));
    await table.ensureTable();
    await table.insertOne({
      label: "object",
      metrics: { value: 1 },
      tags: ["a"],
      wrap: { blob: { v: 1 } },
    });
    await table.insertOne({ label: "empty", metrics: {}, tags: [], wrap: { blob: {} } });
    await table.insertOne({
      label: "null",
      metrics: null,
      tags: null,
      wrap: { blob: null },
    } as any);
    await table.insertOne({ label: "absent", wrap: {} });
    driver.statements.length = 0;
  });

  afterEach(() => {
    driver.close();
  });

  const labels = async (filter: Record<string, unknown>) =>
    ((await table.findMany({ filter, controls: { $sort: { id: 1 } } } as any)) as Row[]).map(
      (r) => r.label,
    );

  it("explicit null and absent are both stored as SQL NULL; {} / [] as JSON text", () => {
    const raw = driver.all<Row>(
      "SELECT label, metrics, tags, wrap__blob FROM json_exists_docs ORDER BY id",
    );
    expect(raw).toEqual([
      { label: "object", metrics: '{"value":1}', tags: '["a"]', wrap__blob: '{"v":1}' },
      { label: "empty", metrics: "{}", tags: "[]", wrap__blob: "{}" },
      { label: "null", metrics: null, tags: null, wrap__blob: null },
      { label: "absent", metrics: null, tags: null, wrap__blob: null },
    ]);
  });

  it.each(["metrics", "tags", "wrap.blob"])(
    "%s: $exists true / false → IS NOT NULL / IS NULL populations",
    async (field) => {
      expect(await labels({ [field]: { $exists: true } })).toEqual(["object", "empty"]);
      expect(await labels({ [field]: { $exists: false } })).toEqual(["null", "absent"]);
      expect(await table.count({ filter: { [field]: { $exists: true } } } as any)).toBe(2);
    },
  );

  it("generated SQL is a plain IS [NOT] NULL on the physical column", async () => {
    await labels({ metrics: { $exists: true } });
    await labels({ "wrap.blob": { $exists: false } });
    expect(driver.statements.some((sql) => /"metrics" IS NOT NULL/.test(sql))).toBe(true);
    expect(driver.statements.some((sql) => /"wrap__blob" IS NULL/.test(sql))).toBe(true);
  });

  it("composes with $and / $or / $not", async () => {
    expect(await labels({ $not: { metrics: { $exists: true } } })).toEqual(["null", "absent"]);
    expect(await labels({ $or: [{ metrics: { $exists: false } }, { label: "object" }] })).toEqual([
      "object",
      "null",
      "absent",
    ]);
    expect(
      await labels({ $and: [{ metrics: { $exists: true } }, { tags: { $exists: true } }] }),
    ).toEqual(["object", "empty"]);
  });

  it("any other predicate on the JSON column is still rejected before SQL", async () => {
    driver.statements.length = 0;
    for (const filter of [
      { metrics: { $exists: true, $ne: null } },
      { $and: [{ metrics: { $exists: true } }, { metrics: { value: 1 } }] },
      { "metrics.value": { $exists: true } },
    ]) {
      await expect(table.findMany({ filter } as any)).rejects.toMatchObject({
        code: "INVALID_QUERY",
      });
    }
    expect(driver.statements).toEqual([]);
  });

  it("deleteMany by existence removes exactly the NULL rows", async () => {
    await table.deleteMany({ metrics: { $exists: false } } as any);
    expect(await labels({})).toEqual(["object", "empty"]);
  });
});
