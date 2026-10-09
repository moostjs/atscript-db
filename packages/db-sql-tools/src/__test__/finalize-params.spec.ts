import { describe, it, expect } from "vite-plus/test";

import { finalizeParams } from "../dialect";
import type { SqlDialect } from "../dialect";
import { buildInsert, buildInsertMany, InsertSqlCache } from "../sql-builder";
import { toSqlValue } from "../common";

const qi = (n: string) => `"${n.replace(/"/g, '""')}"`;
const base = {
  quoteIdentifier: qi,
  quoteTable: qi,
  unlimitedLimit: "ALL",
  toValue: toSqlValue,
  toParam: (v: unknown) => v,
  regex: () => ({ sql: "", params: [] }),
  createViewPrefix: "CREATE VIEW",
} as unknown as SqlDialect;
const pg = { ...base, paramPlaceholder: (i: number) => `$${i}` } as SqlDialect;

const fin = (sql: string) => finalizeParams(pg, { sql, params: [] }).sql;

describe("finalizeParams", () => {
  it("numbers plain placeholders in order", () => {
    expect(fin('SELECT * FROM "t" WHERE "a" = ? AND "b" IN (?, ?) LIMIT ?')).toBe(
      'SELECT * FROM "t" WHERE "a" = $1 AND "b" IN ($2, $3) LIMIT $4',
    );
  });

  it("returns the fragment untouched without a placeholder dialect or without `?`", () => {
    const frag = { sql: "SELECT ?", params: [1] };
    expect(finalizeParams(base, frag)).toBe(frag);
    const none = { sql: "SELECT 1", params: [] };
    expect(finalizeParams(pg, none)).toBe(none);
  });

  it("leaves `?` inside string literals alone ('' escapes included)", () => {
    expect(fin("SELECT 'a?b', ? , 'it''s ?', ?")).toBe("SELECT 'a?b', $1 , 'it''s ?', $2");
    expect(fin(`SELECT "x" FROM "t" WHERE "p" = '$.a?' AND "q" = ?`)).toBe(
      `SELECT "x" FROM "t" WHERE "p" = '$.a?' AND "q" = $1`,
    );
  });

  it("leaves `?` inside E'…' escape strings alone (backslash escapes)", () => {
    expect(fin("SELECT E'a\\'?', ?")).toBe("SELECT E'a\\'?', $1");
    expect(fin("SELECT E'a\\\\', ?")).toBe("SELECT E'a\\\\', $1");
    // `TYPE'…'` is no E-string: the backslash is literal.
    expect(fin("SELECT TYPE'a\\', ?")).toBe("SELECT TYPE'a\\', $1");
  });

  it("leaves `?` inside quoted identifiers alone", () => {
    expect(fin('SELECT "what?" FROM "t" WHERE "a""?b" = ?')).toBe(
      'SELECT "what?" FROM "t" WHERE "a""?b" = $1',
    );
  });

  it("leaves `?` inside comments alone", () => {
    expect(fin("SELECT ? -- why?\n, ? /* really? */ , ?")).toBe(
      "SELECT $1 -- why?\n, $2 /* really? */ , $3",
    );
    // Block comments nest (PostgreSQL).
    expect(fin("SELECT ? /* a /* b */ c? */ , ?")).toBe("SELECT $1 /* a /* b */ c? */ , $2");
  });

  it("leaves `?` inside dollar-quoted strings alone, but numbers after them", () => {
    expect(fin("SELECT $$a?b$$, ?, $tag$x ? y$tag$, ?")).toBe(
      "SELECT $$a?b$$, $1, $tag$x ? y$tag$, $2",
    );
  });

  it("keeps the jsonb operators `?|` / `?&`, and `??` is an escaped `?`", () => {
    expect(fin(`SELECT * FROM "t" WHERE "j" ?| ? AND "j" ?& ? AND "j" ?? ?`)).toBe(
      `SELECT * FROM "t" WHERE "j" ?| $1 AND "j" ?& $2 AND "j" ? $3`,
    );
    // `?||` is a placeholder followed by concatenation.
    expect(fin("SELECT ?||'%'")).toBe("SELECT $1||'%'");
    // `?&&` is a placeholder followed by the array overlap operator.
    expect(fin(`SELECT * FROM "t" WHERE ?&&"arr"`)).toBe(`SELECT * FROM "t" WHERE $1&&"arr"`);
  });

  it("is unaffected by unterminated quotes (rest of the text is skipped)", () => {
    expect(fin("SELECT ?, 'abc ?")).toBe("SELECT $1, 'abc ?");
  });

  it("matches the previous output on builder SQL (multi-row insert)", () => {
    const rows = Array.from({ length: 50 }, (_, r) => ({ a: r, b: `s${r}`, c: r % 2 === 0 }));
    const frag = buildInsertMany(base, "t", rows, ["a", "b", "c"]);
    let idx = 0;
    const legacy = frag.sql.replace(/\?/g, () => `$${++idx}`);
    expect(finalizeParams(pg, frag).sql).toBe(legacy);
    expect(idx).toBe(150);
  });
});

describe("InsertSqlCache", () => {
  it("renders exactly what buildInsert renders, reusing the text per key signature", () => {
    const cache = new InsertSqlCache(pg);
    const rows = [
      { id: 1, name: "a", tags: ["x"], on: true },
      { id: 2, name: "b", tags: null, on: false },
      { name: "c", id: 3 },
      { id: 4, name: "d", tags: undefined, on: true },
    ];
    const built = rows.map((row) => cache.build("t", row));
    rows.forEach((row, i) => expect(built[i]).toEqual(buildInsert(pg, "t", row)));
    expect(built[0]!.sql).toBe(built[1]!.sql);
    expect(built[2]!.sql).not.toBe(built[0]!.sql); // key order is part of the signature
  });

  it("starts over for another table and stays bounded", () => {
    const cache = new InsertSqlCache(base, 2);
    expect(cache.build("a", { x: 1 }).sql).toBe('INSERT INTO "a" ("x") VALUES (?)');
    expect(cache.build("b", { x: 1 }).sql).toBe('INSERT INTO "b" ("x") VALUES (?)');
    for (let i = 0; i < 10; i++) {
      const row = { [`k${i}`]: i };
      expect(cache.build("b", row)).toEqual(buildInsert(base, "b", row));
    }
    expect((cache as unknown as { _sql: Map<string, string> })._sql.size).toBeLessThanOrEqual(2);
  });
});
