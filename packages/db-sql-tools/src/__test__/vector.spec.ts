import { describe, it, expect } from "vite-plus/test";
import { UniquSelect } from "@atscript/db";

import type { SqlDialect } from "../dialect";
import { buildVectorSearchCount, buildVectorSearchSelect, vectorDistanceSource } from "../vector";
import { toSqlValue } from "../common";

const dialect: SqlDialect = {
  quoteIdentifier: (n) => `"${n}"`,
  quoteTable: (n) => `"${n}"`,
  unlimitedLimit: "-1",
  toValue: toSqlValue,
  toParam: (v) => v,
  regex: () => ({ sql: "", params: [] }),
  createViewPrefix: "CREATE VIEW",
};

const numbered: SqlDialect = { ...dialect, paramPlaceholder: (i) => `$${i}` };

const DIST = { sql: `dist("embedding", ?)`, params: ["[1,0]"] };
const WHERE = { sql: `"status" = ?`, params: ["on"] };

// since 0.1.143 — one vector search SELECT shape for every SQL adapter.
describe("vector search SQL builders", () => {
  it("ranks a table source, capped and paged", () => {
    const source = vectorDistanceSource(dialect, "docs", WHERE, DIST);
    const { sql, params } = buildVectorSearchSelect(dialect, source, {
      limit: 5,
      skip: 10,
      maxDistance: 0.4,
    });
    expect(sql).toBe(
      `SELECT * FROM (SELECT "t".*, dist("embedding", ?) AS "_distance" FROM "docs" AS "t" WHERE "status" = ?) AS "_v" ` +
        `WHERE "_distance" <= ? ORDER BY "_distance" ASC LIMIT ? OFFSET ?`,
    );
    expect(params).toEqual(["[1,0]", "on", 0.4, 5, 10]);
  });

  it("projects $select on the outer query and always keeps _distance", () => {
    const source = vectorDistanceSource(dialect, "docs", WHERE, DIST);
    const select = new UniquSelect(["id", "title"]);
    const { sql } = buildVectorSearchSelect(dialect, source, { select, limit: 20 });
    expect(sql).toMatch(/^SELECT "_v"\."id", "_v"\."title", "_v"\."_distance" FROM \(/);
    expect(sql).not.toContain("OFFSET");
  });

  it("ANDs a residual filter over the source after the distance cap", () => {
    const source = { sql: "SELECT * FROM src", params: [1] };
    const residual = { sql: `_v."kind" = ?`, params: ["a"] };
    const { sql, params } = buildVectorSearchSelect(dialect, source, {
      limit: 3,
      maxDistance: 1,
      residual,
    });
    expect(sql).toContain(`WHERE "_distance" <= ? AND (_v."kind" = ?) ORDER BY`);
    expect(params).toEqual([1, 1, "a", 3]);
  });

  it("counts the capped source (distance only) and numbers placeholders per dialect", () => {
    const source = vectorDistanceSource(numbered, "docs", WHERE, DIST, false);
    const { sql, params } = buildVectorSearchCount(numbered, source, { maxDistance: 0.5 });
    expect(sql).toBe(
      `SELECT COUNT(*) AS cnt FROM (SELECT dist("embedding", $1) AS "_distance" FROM "docs" AS "t" WHERE "status" = $2) AS "_v" WHERE "_distance" <= $3`,
    );
    expect(params).toEqual(["[1,0]", "on", 0.5]);
  });
});
