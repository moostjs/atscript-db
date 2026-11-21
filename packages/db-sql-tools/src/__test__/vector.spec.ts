import { describe, it, expect } from "vite-plus/test";
import { UniquSelect } from "@atscript/db";

import type { SqlDialect } from "../dialect";
import {
  addVectorScore,
  buildVectorSearchCount,
  buildVectorSearchSelect,
  vectorDistanceSource,
  vectorMaxDistance,
  vectorScoreFromDistance,
  type TVectorMetric,
} from "../vector";
import { toSqlValue, sqlStringLiteral } from "../common";

const dialect: SqlDialect = {
  quoteIdentifier: (n) => `"${n}"`,
  quoteTable: (n) => `"${n}"`,
  unlimitedLimit: "-1",
  stringLiteral: sqlStringLiteral,
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
      `SELECT * FROM (SELECT * FROM (SELECT "t".*, dist("embedding", ?) AS "_distance" FROM "docs" AS "t" WHERE "status" = ?) AS "_d" WHERE "_distance" IS NOT NULL) AS "_v" ` +
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
      `SELECT COUNT(*) AS cnt FROM (SELECT * FROM (SELECT dist("embedding", $1) AS "_distance" FROM "docs" AS "t" WHERE "status" = $2) AS "_d" WHERE "_distance" IS NOT NULL) AS "_v" WHERE "_distance" <= $3`,
    );
    expect(params).toEqual(["[1,0]", "on", 0.5]);
  });

  // since 0.1.183 — a row without a stored vector has no distance (PostgreSQL /
  // MySQL compute NULL for it): the plain-table source never yields it, so it
  // is never returned nor counted, threshold or not.
  it("a plain-table source leaves out rows without a distance", () => {
    for (const withRows of [true, false]) {
      const source = vectorDistanceSource(dialect, "docs", WHERE, DIST, withRows);
      expect(source.sql).toMatch(/\) AS "_d" WHERE "_distance" IS NOT NULL$/);
      expect(source.params).toEqual(["[1,0]", "on"]);
    }
  });
});

// since 0.1.183 — `$score` is the Atlas `vectorSearchScore` scale on every SQL
// adapter, and the threshold cap is its exact inverse, so "a row is returned
// iff its `$score` reaches the threshold" holds on every database (up to
// floating-point rounding).
describe("vector $score ⇄ distance", () => {
  const METRICS: TVectorMetric[] = ["cosine", "euclidean", "dotProduct"];

  it("scores each metric with the Atlas formula", () => {
    // cosine distance d = 1 − cos: (1 + cos) / 2
    expect(vectorScoreFromDistance("cosine", 0)).toBe(1);
    expect(vectorScoreFromDistance("cosine", 1)).toBe(0.5);
    expect(vectorScoreFromDistance("cosine", 2)).toBe(0);
    // euclidean: 1 / (1 + d)
    expect(vectorScoreFromDistance("euclidean", 0)).toBe(1);
    expect(vectorScoreFromDistance("euclidean", 1)).toBe(0.5);
    expect(vectorScoreFromDistance("euclidean", 3)).toBe(0.25);
    // dotProduct, d = −dot: (1 + dot) / 2
    expect(vectorScoreFromDistance("dotProduct", -1)).toBe(1);
    expect(vectorScoreFromDistance("dotProduct", 0)).toBe(0.5);
    expect(vectorScoreFromDistance("dotProduct", 1)).toBe(0);
    // vectors that are not normalized: outside 0–1
    expect(vectorScoreFromDistance("dotProduct", -3)).toBe(2);
  });

  it("the cap is the inverse of the score: score(cap(s)) = s", () => {
    for (const metric of METRICS) {
      for (const s of [0.05, 0.25, 0.5, 0.7, 0.9, 0.99, 1]) {
        const cap = vectorMaxDistance(metric, s)!;
        expect(vectorScoreFromDistance(metric, cap)).toBeCloseTo(s, 12);
      }
    }
  });

  it("keeps a row iff its score reaches the threshold", () => {
    for (const metric of METRICS) {
      const s = 0.6;
      const cap = vectorMaxDistance(metric, s)!;
      // just inside the cap: kept and scored at or above s; just outside: neither
      expect(vectorScoreFromDistance(metric, cap - 1e-9)).toBeGreaterThanOrEqual(s);
      expect(vectorScoreFromDistance(metric, cap + 1e-9)).toBeLessThan(s);
    }
  });

  it("caps each metric as documented", () => {
    expect(vectorMaxDistance("cosine", 0.9)).toBeCloseTo(0.2, 12);
    expect(vectorMaxDistance("euclidean", 0.5)).toBe(1);
    expect(vectorMaxDistance("euclidean", 0.25)).toBe(3);
    // dot >= 2s − 1  ⇔  −dot <= 1 − 2s
    expect(vectorMaxDistance("dotProduct", 0.75)).toBe(-0.5);
    expect(vectorMaxDistance("dotProduct", 0)).toBe(1);
  });

  it("euclidean edges: s <= 0 caps nothing, s = 1 keeps exact matches, s > 1 keeps none", () => {
    expect(vectorMaxDistance("euclidean", 0)).toBeUndefined();
    expect(vectorMaxDistance("euclidean", -0.5)).toBeUndefined();
    expect(vectorMaxDistance("euclidean", 1)).toBe(0);
    expect(vectorMaxDistance("euclidean", 2)).toBeLessThan(0);
    // cosine is bounded: s <= 0 already reaches the whole 0–2 range
    expect(vectorMaxDistance("cosine", 0)).toBe(2);
    expect(vectorMaxDistance("cosine", 1)).toBe(0);
    expect(vectorMaxDistance("cosine", 1.5)).toBeLessThan(0);
  });

  it("addVectorScore keeps _distance and reads a numeric string", () => {
    expect(addVectorScore({ id: 1, _distance: 1 }, "euclidean")).toEqual({
      id: 1,
      _distance: 1,
      $score: 0.5,
    });
    expect(addVectorScore({ _distance: "0.5" }, "cosine").$score).toBe(0.75);
  });
});
