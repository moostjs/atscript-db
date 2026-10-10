import { describe, expect, it } from "vite-plus/test";

import { buildKeyViolationCount } from "../sql-builder";
import type { SqlDialect } from "../dialect";

const plain = { quoteIdentifier: (s: string) => `"${s}"` } as unknown as SqlDialect;

// Schema sync's check before rebuilding a populated primary key (since 0.1.155).

describe("buildKeyViolationCount", () => {
  it("counts NULL rows plus every row of a duplicate group, in one query", () => {
    expect(buildKeyViolationCount(plain, '"orders"', ["id", "code"])).toBe(
      'SELECT (SELECT COUNT(*) FROM "orders" WHERE "id" IS NULL OR "code" IS NULL) + ' +
        '(SELECT COALESCE(SUM("n"), 0) FROM (SELECT COUNT(*) AS "n" FROM "orders" ' +
        'WHERE "id" IS NOT NULL AND "code" IS NOT NULL GROUP BY "id", "code" HAVING COUNT(*) > 1) "d") AS "violations"',
    );
  });
});
