import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_MYSQL_TEST_URL` (an admin
// connection; the spec creates and drops its own `fulltext_match` database).
// `@db.index.fulltext.match "all"` (0.1.174): the search text is split into
// words the way InnoDB's parser splits it, so a stop word or short word next
// to punctuation (`the,` / `ox.` / `about:`) stays optional like a bare one.
// Expects the server's defaults: `innodb_ft_min_token_size` 3, the default
// stop-word list.

const DB = "fulltext_match";

const reachable = await mysqlReachable();

const ROWS = [
  { id: 1, title: "Quick brown fox", body: "The fox jumps over the lazy dog" },
  { id: 2, title: "Quick start", body: "An ox and a cart" },
  { id: 3, title: "Fox den", body: "Night animals" },
  { id: 4, title: "Trail guide", body: "Where to run this week" },
  { id: 5, title: "Field notes", body: "O'Brien's theory of e-mail" },
  // NFD `nöt` (combining diaeresis), `²` inside a word, an astral letter before `ox`
  { id: 6, title: "Umlaut sample", body: "no\u0308t x²yz \u{1D400}ox" },
];

let fx: Record<string, any>;
let space: DbSpace;

/** Matching ids, sorted. */
const ids = async (text: string): Promise<number[]> =>
  ((await space.getTable(fx.FtoMatchDoc).search(text, { filter: {}, controls: {} })) as any[])
    .map((r) => r.id as number)
    .toSorted((a, b) => a - b);

describe.skipIf(!reachable)('[mysql live] fulltext match "all" tokenization', () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/fulltext-options.as");
    const driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    const result = await new SchemaSync(space).run([fx.FtoMatchDoc], { force: true });
    expect(result.status).toBe("synced");
    await space.getTable(fx.FtoMatchDoc).insertMany(ROWS);
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  it("bare stop words and short words stay optional", async () => {
    expect(await ids("quick")).toEqual([1, 2]);
    expect(await ids("the quick")).toEqual([1, 2]);
    expect(await ids("quick ox")).toEqual([1, 2]);
    expect(await ids("the zebra")).toEqual([]);
    expect(await ids("the a of")).toEqual([]);
  });

  it("a stop word or short word next to punctuation stays optional too", async () => {
    expect(await ids("the, quick")).toEqual([1, 2]);
    expect(await ids("quick; the fox.")).toEqual([1]);
    expect(await ids("quick ox.")).toEqual([1, 2]);
    expect(await ids("about: fox")).toEqual([1, 3]);
    expect(await ids("fox (the)")).toEqual([1, 3]);
    expect(await ids("fox... the!? lazy")).toEqual([1]);
  });

  it("the words around punctuation stay required", async () => {
    expect(await ids("lazy,fox")).toEqual([1]);
    expect(await ids("fox, zebra")).toEqual([]);
    expect(await ids("e-mail")).toEqual([5]);
    // InnoDB splits on apostrophes: `O'Brien's` is `O`, `Brien`, `s`
    expect(await ids("O'Brien's theory")).toEqual([5]);
  });

  it("phrases and prefixes", async () => {
    expect(await ids('"lazy dog"')).toEqual([1]);
    expect(await ids('"lazy, dog."')).toEqual([1]);
    expect(await ids('"dog lazy"')).toEqual([]);
    // a phrase of stop words / short words only is optional
    expect(await ids('"the a" fox')).toEqual([1, 3]);
    // a prefix is required whatever its length, even a stop word's
    expect(await ids("qui*")).toEqual([1, 2]);
    expect(await ids("ni* fox")).toEqual([3]);
    expect(await ids("the* notes")).toEqual([5]);
  });

  // InnoDB reads words with MySQL's utf8mb4 ctype table: a combining mark and
  // `²` are word characters, an astral code point (above U+FFFF) is not.
  it("word characters follow the server's ctype table", async () => {
    // `nöt` is one 4-character word — required, and found
    expect(await ids("sample no\u0308t")).toEqual([6]);
    expect(await ids("quick no\u0308t")).toEqual([]);
    // `x²yz` is one word
    expect(await ids("x²yz")).toEqual([6]);
    // `𝐀ox` is the separator `𝐀` and the short word `ox`, which stays optional
    expect(await ids("sample \u{1D400}ox")).toEqual([6]);
  });

  it("the user's boolean operators are text, never syntax", async () => {
    expect(await ids("+fox -lazy")).toEqual([1]);
    expect(await ids('fox "den')).toEqual([3]);
    expect(await ids("fox @3 ~den <night> (animals)")).toEqual([3]);
    expect(await ids('*** --- "" ()')).toEqual([]);
  });
});
