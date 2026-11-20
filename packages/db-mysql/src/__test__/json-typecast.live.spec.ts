import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";

import { Mysql2Driver } from "../mysql2-driver";
import {
  mysqlReachable,
  mysqlFields,
  recreateMysqlDatabase,
  dropMysqlDatabase,
} from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated (see live-server.ts; creates and drops its own database). The
// driver's typeCast reads JSON as the exact UTF-8 text without mysql2's
// "interpreted as BINARY" warning (since 0.1.177) — on a table column, which
// the server reports with charset 63 (binary), and on view columns and JSON
// expressions, which it reports with the connection's character set (utf8mb4
// by default; measured on MySQL 8.4 for every view below, the plain one
// included): the old `string("utf8")` read then asked for the encoding the
// column already reports, and mysql2 warned once per JSON cell per row.
// Assumes MySQL 8+: MariaDB stores JSON as LONGTEXT (no JSON column type), so
// the column-type expectations below do not hold there.
// The parser-level counterpart (no server) is in mysql2-driver-strict.spec.ts.

const DB = "json_typecast";
const reachable = await mysqlReachable();

/** The stored document as MySQL prints JSON (`": "` / `", "` separators), its non-ASCII text as is. */
const DOC = '{"name": "Zoë – 東京"}';

interface TViewCase {
  name: string;
  /** The view's `doc` column, over `jt_items.payload`. */
  expr: string;
  /** What `doc` reads for row 1 (payload `DOC`) and row 2 (payload SQL NULL). */
  rows: [string, string | null];
}

const VIEWS: TViewCase[] = [
  { name: "jt_plain", expr: "`payload`", rows: [DOC, null] },
  {
    name: "jt_case",
    expr: "CASE WHEN JSON_TYPE(`payload`) = 'NULL' THEN NULL ELSE `payload` END",
    rows: [DOC, null],
  },
  { name: "jt_if", expr: "IF(`id` > 0, `payload`, NULL)", rows: [DOC, null] },
  { name: "jt_coalesce", expr: "COALESCE(`payload`, JSON_ARRAY())", rows: [DOC, "[]"] },
  { name: "jt_extract", expr: "JSON_EXTRACT(`payload`, '$')", rows: [DOC, null] },
  {
    name: "jt_object",
    expr: "JSON_OBJECT('doc', `payload`)",
    rows: [`{"doc": ${DOC}}`, '{"doc": null}'],
  },
];

describe.skipIf(!reachable)("[mysql live] JSON typeCast without mysql2's BINARY warning", () => {
  let driver: Mysql2Driver;

  /** `doc` of every row of `source`, read through the driver, and whether mysql2 warned meanwhile. */
  const readDocs = async (source: string, column = "doc") => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rows = await driver.all<{ id: number; doc: string | null }>(
        `SELECT \`id\`, ${column} AS \`doc\` FROM \`${source}\` ORDER BY \`id\``,
      );
      return { docs: rows.map((r) => r.doc), warned: warn.mock.calls.length > 0 };
    } finally {
      warn.mockRestore();
    }
  };

  beforeAll(async () => {
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    await driver.exec("CREATE TABLE `jt_items` (`id` INT PRIMARY KEY, `payload` JSON NULL)");
    await driver.run("INSERT INTO `jt_items` (`id`, `payload`) VALUES (?, ?), (?, ?)", [
      1,
      '{"name":"Zoë – 東京"}',
      2,
      null,
    ]);
    for (const view of VIEWS) {
      await driver.exec(
        `CREATE VIEW \`${view.name}\` AS SELECT \`id\`, ${view.expr} AS \`doc\` FROM \`jt_items\``,
      );
    }
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  it("a table column reads the exact text (and NULL)", async () => {
    expect(await readDocs("jt_items", "`payload`")).toEqual({ docs: [DOC, null], warned: false });
  });

  it.each(VIEWS)("view $name ($expr) reads the exact text", async ({ name, rows }) => {
    expect(await readDocs(name)).toEqual({ docs: rows, warned: false });
  });

  it("every candidate is a JSON column, and at least one reports a non-binary charset — the case that warned", async () => {
    const reported: Array<{ view: string; columnType: number; characterSet: number }> = [];
    for (const view of VIEWS) {
      const [field] = await mysqlFields(
        DB,
        `SELECT \`doc\` FROM \`${view.name}\` WHERE \`id\` = 1`,
      );
      const { columnType, characterSet } = field as unknown as {
        columnType: number;
        characterSet: number;
      };
      reported.push({ view: view.name, columnType, characterSet });
    }

    // 245 = MYSQL_TYPE_JSON: the typeCast's JSON branch reads every candidate
    expect(reported.map((r) => [r.view, r.columnType])).toEqual(VIEWS.map((v) => [v.name, 245]));
    // mysql2 warned when the encoding asked for ("utf8") equals the reported
    // one; a server that reports binary (63) for every candidate never warned
    expect(
      reported.filter((r) => r.characterSet !== 63).map((r) => r.view),
      "no JSON column reports a non-binary charset: the spec no longer covers the case that warned",
    ).not.toEqual([]);
  });
});
