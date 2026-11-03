import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter, mysqlRequireEveryTerm } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// `@db.index.fulltext.language` / `.match` on MySQL (since 0.1.168): FULLTEXT
// has no per-index language — ignored with a warning at sync; `match "all"`
// searches IN BOOLEAN MODE with every word required.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fulltext-options.as");
});

function setup() {
  const driver = createMockDriver({ get: [["COUNT(*)", { cnt: 0 }]], allResult: [] } as any);
  const warn = vi.fn();
  const logger = { error: vi.fn(), warn, log: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const space = new DbSpace(() => new MysqlAdapter(driver), { logger: logger as any });
  const table = space.getTable(fx.FtoDoc) as any;
  return { driver, table, warn };
}

describe("MysqlAdapter — @db.index.fulltext.language", () => {
  it("is ignored with a warning at sync", async () => {
    const { table, warn } = setup();
    await table.syncIndexes();
    expect(warn).toHaveBeenCalledWith(
      '[mysql] fulltext index "ft_body": @db.index.fulltext.language "russian" is ignored — MySQL FULLTEXT has no per-index language',
    );
  });
});

describe("MysqlAdapter — @db.index.fulltext.match", () => {
  it('"all": boolean mode, every word required', async () => {
    const { driver, table } = setup();
    await table.search('red "big cat" dog*', {});
    const call = driver.calls.find((c) => c.sql.includes("AGAINST") && !c.sql.includes("COUNT"))!;
    expect(call.sql).toContain("MATCH(`body`) AGAINST(? IN BOOLEAN MODE)");
    expect(call.params?.[0]).toBe('+red +"big cat" +dog*');
  });

  it("short words and InnoDB default stop words stay optional", () => {
    expect(mysqlRequireEveryTerm("the cat is on a mat")).toBe("the +cat is on a +mat");
    expect(mysqlRequireEveryTerm("Where WILL dogs go")).toBe("Where WILL +dogs go");
  });

  it("the user's own boolean operators are text", () => {
    expect(mysqlRequireEveryTerm("-foo +bar (baz) e-mail ~xyz* @222 <qux>")).toBe(
      "+foo +bar +baz e +mail +xyz* +222 +qux",
    );
    expect(mysqlRequireEveryTerm('"say "hello"" ')).toBe('+"say" +hello');
    expect(mysqlRequireEveryTerm("*** ---")).toBe("");
  });
});
