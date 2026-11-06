import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { INNODB_WORD_CLASS } from "../innodb-word-chars";
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

  // WHY: before 0.1.174 a word was split only on the boolean operators, so
  // `the,` became the required `+the,` — InnoDB reads it as the stop word
  // `the`, which it does not index, and the search matched nothing.
  it("splits words like InnoDB: on every character but letters, digits and _", () => {
    expect(mysqlRequireEveryTerm("the, quick")).toBe("the +quick");
    expect(mysqlRequireEveryTerm("quick ox.")).toBe("+quick ox");
    expect(mysqlRequireEveryTerm("about: fox")).toBe("about +fox");
    expect(mysqlRequireEveryTerm("quick; the fox.")).toBe("+quick the +fox");
    expect(mysqlRequireEveryTerm("fox... the!? lazy,dog")).toBe("+fox the +lazy +dog");
    expect(mysqlRequireEveryTerm("O'Brien's e-mail, a/b 3.14 snake_case")).toBe(
      "O +Brien s e +mail a b 3 14 +snake_case",
    );
    expect(mysqlRequireEveryTerm("Ünïcödé, café… naïve")).toBe("+Ünïcödé +café +naïve");
    expect(mysqlRequireEveryTerm(",.;:!? %%% ---")).toBe("");
  });

  // InnoDB's word characters are MySQL's utf8mb4 ctype letters/numbers (Unicode
  // 5.0, BMP only) and `_`: combining marks and `²` / `½` / `Ⅻ` are word
  // characters; astral code points and later additions end a word.
  it("word characters follow MySQL's utf8mb4 ctype table", () => {
    // NFD: the combining diaeresis stays in the word (4 characters, required)
    expect(mysqlRequireEveryTerm("quick no\u0308t")).toBe("+quick +no\u0308t");
    expect(mysqlRequireEveryTerm("x²yz ½ Ⅻ")).toBe("+x²yz ½ Ⅻ");
    expect(mysqlRequireEveryTerm("नमस्ते")).toBe("+नमस्ते");
    // Astral letters and emoji separate words
    expect(mysqlRequireEveryTerm("\u{1D400}ox sample")).toBe("ox +sample");
    expect(mysqlRequireEveryTerm("fox\u{1F98A}den 中文")).toBe("+fox +den 中文");
    // Greek Heta (U+0370) was assigned after Unicode 5.0: a separator to MySQL
    expect(mysqlRequireEveryTerm("abc\u0370def")).toBe("+abc +def");
  });

  it("phrases keep their words; a phrase of short and stop words only is optional", () => {
    expect(mysqlRequireEveryTerm('"lazy, dog." fox')).toBe('+"lazy dog" +fox');
    expect(mysqlRequireEveryTerm('"the a" fox')).toBe('"the a" +fox');
    expect(mysqlRequireEveryTerm('"the lazy" "" " ,. "')).toBe('+"the lazy"');
  });

  it("a prefix after a word is required whatever its length", () => {
    expect(mysqlRequireEveryTerm("ni* the* quick*")).toBe("+ni* +the* +quick*");
    expect(mysqlRequireEveryTerm("ox.* e-ma*")).toBe("ox e +ma*");
    expect(mysqlRequireEveryTerm("**fox")).toBe("+fox");
  });

  it("user input never reaches the boolean syntax", () => {
    const attempts = [
      "+fox -lazy",
      'fox" -lazy "',
      '"unclosed phrase',
      "fox @3 ~den <night> >(animals)",
      'fox\ndog "a\nb"',
      "'; DROP TABLE t; --",
      "%fox% _x_",
      "fox\u0000dog\tcat",
      "fox\u{1F98A}+den\u3000-cat\u00A0~ox",
    ];
    // Only `+word`, `word`, `+word*` and `[+]"word word"` — words of InnoDB word characters
    const word = `${INNODB_WORD_CLASS}+`;
    const item = `\\+?(?:${word}\\*?|"${word}(?: ${word})*")`;
    const grammar = new RegExp(`^(?:${item}(?: ${item})*)?$`, "u");
    for (const text of attempts) expect(mysqlRequireEveryTerm(text), text).toMatch(grammar);
    expect(mysqlRequireEveryTerm('fox" -lazy "')).toBe("+fox +lazy");
    expect(mysqlRequireEveryTerm("'; DROP TABLE t; --")).toBe("+DROP +TABLE t");
  });
});
