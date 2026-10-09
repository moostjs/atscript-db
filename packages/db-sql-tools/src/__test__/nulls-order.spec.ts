import { describe, it, expect } from "vite-plus/test";
import { UniquSelect, type DbControls } from "@atscript/db";

import { buildAggregateSelect } from "../agg";
import { nullsOrderSql, nullsPlacementOf, orderKeySql, type SqlDialect } from "../dialect";
import { buildPartitionedSelect, buildSelect, orderByList } from "../sql-builder";

/**
 * NULL placement in ORDER BY (`$nulls`, since 0.1.153): the plain key when the
 * engine's native placement already matches, `NULLS FIRST|LAST` where the
 * engine has the syntax, a leading `(expr IS NULL)` key elsewhere (MySQL).
 */

const base: SqlDialect = {
  quoteIdentifier: (n) => `"${n}"`,
  quoteTable: (n) => `"${n}"`,
  unlimitedLimit: "-1",
  toValue: (v) => v as never,
  toParam: (v) => v as never,
  regex: (col, v) => ({ sql: `${col} LIKE ?`, params: [String(v)] }),
  createViewPrefix: "CREATE VIEW",
};
const sqlite: SqlDialect = { ...base, nullsPlacementSyntax: true };
const mysql: SqlDialect = {
  ...base,
  quoteIdentifier: (n) => `\`${n}\``,
  quoteTable: (n) => `\`${n}\``,
};
const pg: SqlDialect = { ...base, nullsSortLargest: true, nullsPlacementSyntax: true };

const where = { sql: "1=1", params: [] };

describe("nullsOrderSql", () => {
  it("no placement: the plain key on every dialect", () => {
    for (const d of [sqlite, pg]) {
      expect(nullsOrderSql(d, '"x"', false)).toBe('"x" ASC');
      expect(nullsOrderSql(d, '"x"', true)).toBe('"x" DESC');
    }
    expect(nullsOrderSql(mysql, "`x`", true)).toBe("`x` DESC");
  });

  it("sqlite (NULL smallest, has the syntax)", () => {
    expect(nullsOrderSql(sqlite, '"x"', false, "first")).toBe('"x" ASC');
    expect(nullsOrderSql(sqlite, '"x"', false, "last")).toBe('"x" ASC NULLS LAST');
    expect(nullsOrderSql(sqlite, '"x"', true, "first")).toBe('"x" DESC NULLS FIRST');
    expect(nullsOrderSql(sqlite, '"x"', true, "last")).toBe('"x" DESC');
  });

  it("postgres (NULL largest, has the syntax)", () => {
    expect(nullsOrderSql(pg, '"x"', false, "first")).toBe('"x" ASC NULLS FIRST');
    expect(nullsOrderSql(pg, '"x"', false, "last")).toBe('"x" ASC');
    expect(nullsOrderSql(pg, '"x"', true, "first")).toBe('"x" DESC');
    expect(nullsOrderSql(pg, '"x"', true, "last")).toBe('"x" DESC NULLS LAST');
  });

  it("mysql (NULL smallest, no syntax): a leading IS NULL key", () => {
    expect(nullsOrderSql(mysql, "`x`", false, "first")).toBe("`x` ASC");
    expect(nullsOrderSql(mysql, "`x`", false, "last")).toBe("(`x` IS NULL) ASC, `x` ASC");
    expect(nullsOrderSql(mysql, "`x`", true, "first")).toBe("(`x` IS NULL) DESC, `x` DESC");
    expect(nullsOrderSql(mysql, "`x`", true, "last")).toBe("`x` DESC");
  });

  it("a nullsSortLargest dialect without the flag still renders NULLS FIRST / LAST", () => {
    const legacy: SqlDialect = { ...base, nullsSortLargest: true };
    expect(nullsOrderSql(legacy, '"x"', false, "first")).toBe('"x" ASC NULLS FIRST');
  });
});

describe("orderKeySql", () => {
  it("without a placement keeps NULL as the smallest value", () => {
    expect(orderKeySql(sqlite, '"x"', false)).toBe('"x" ASC');
    expect(orderKeySql(sqlite, '"x"', true)).toBe('"x" DESC');
    expect(orderKeySql(mysql, "`x`", false)).toBe("`x` ASC");
    expect(orderKeySql(mysql, "`x`", true)).toBe("`x` DESC");
    expect(orderKeySql(pg, '"x"', false)).toBe('"x" ASC NULLS FIRST');
    expect(orderKeySql(pg, '"x"', true)).toBe('"x" DESC NULLS LAST');
  });

  it("honors a placement", () => {
    expect(orderKeySql(pg, '"x"', false, "last")).toBe('"x" ASC');
    expect(orderKeySql(sqlite, '"x"', false, "last")).toBe('"x" ASC NULLS LAST');
    expect(orderKeySql(mysql, "`x`", true, "first")).toBe("(`x` IS NULL) DESC, `x` DESC");
  });
});

describe("nullsPlacementOf", () => {
  it("reads own entries only", () => {
    expect(nullsPlacementOf(undefined, "a")).toBeUndefined();
    expect(nullsPlacementOf({ a: "last" } as never, "a")).toBe("last");
    expect(nullsPlacementOf({ a: "last" } as never, "toString")).toBeUndefined();
  });
});

describe("$sort with $nulls", () => {
  const controls = {
    $sort: { amount: -1, name: 1, id: 1 },
    $nulls: { amount: "last", name: "last" },
  } as unknown as DbControls;

  it("orderByList: entries per key, a key without one plain, a prefix", () => {
    expect(orderByList(mysql, controls.$sort, controls.$nulls)).toBe(
      "`amount` DESC, (`name` IS NULL) ASC, `name` ASC, `id` ASC",
    );
    expect(orderByList(sqlite, controls.$sort, controls.$nulls, "t.")).toBe(
      't."amount" DESC, t."name" ASC NULLS LAST, t."id" ASC',
    );
  });

  it("buildSelect renders the placement; without $nulls the SQL is unchanged", () => {
    expect(buildSelect(pg, "t", where, controls).sql).toBe(
      'SELECT * FROM "t" WHERE 1=1 ORDER BY "amount" DESC NULLS LAST, "name" ASC, "id" ASC',
    );
    const plain = { $sort: controls.$sort } as DbControls;
    expect(buildSelect(pg, "t", where, plain).sql).toBe(
      'SELECT * FROM "t" WHERE 1=1 ORDER BY "amount" DESC, "name" ASC, "id" ASC',
    );
  });

  it("buildPartitionedSelect: the window ORDER BY places NULL", () => {
    const sql = buildPartitionedSelect(sqlite, "t", where, controls, ["owner"]).sql;
    expect(sql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "owner" ORDER BY "amount" DESC, "name" ASC NULLS LAST, "id" ASC)',
    );
  });
});

function agg(extra: Partial<DbControls>, computed?: ConstructorParameters<typeof UniquSelect>[3]) {
  return {
    $groupBy: ["category"],
    $select: new UniquSelect(
      [
        "category",
        { $fn: "sum", $field: "amount", $as: "total" },
        { $fn: "first", $field: "amount", $as: "lo" },
        { $fn: "last", $field: "amount", $as: "hi" },
      ] as never,
      undefined,
      undefined,
      computed ?? { rowOrder: [{ column: "amount", desc: false, nulls: "last" }] },
    ),
    ...extra,
  } as DbControls;
}

describe("grouped $sort and first / last row order", () => {
  it("grouped ORDER BY: an entry places NULL, a key without one stays NULL-smallest", () => {
    const c = agg({
      $sort: { category: 1, total: -1 },
      $nulls: { category: "last" },
    } as never);
    expect(buildAggregateSelect(pg, "t", where, c).sql).toMatch(
      /ORDER BY "category" ASC, "total" DESC NULLS LAST$/,
    );
    expect(buildAggregateSelect(mysql, "t", where, c).sql).toMatch(
      /ORDER BY \(`category` IS NULL\) ASC, `category` ASC, `total` DESC$/,
    );
    const alias = agg({ $sort: { total: -1 }, $nulls: { total: "first" } } as never);
    expect(buildAggregateSelect(sqlite, "t", where, alias).sql).toMatch(
      /ORDER BY "total" DESC NULLS FIRST$/,
    );
  });

  it("mysql: the IS NULL key tests a computed alias's own expression", () => {
    // an alias may be named like a table column, which MySQL prefers inside an expression
    const c = agg({
      $sort: { total: -1, lo: 1 },
      $nulls: { total: "first", lo: "last" },
    } as never);
    expect(buildAggregateSelect(mysql, "t", where, c).sql).toMatch(
      /ORDER BY \(SUM\(`amount`\) IS NULL\) DESC, `total` DESC, \(MIN\(`__as_fl0`\) IS NULL\) ASC, `lo` ASC$/,
    );
  });

  it("row order: `last` reverses direction and NULL placement", () => {
    const sql = buildAggregateSelect(sqlite, "t", where, agg({})).sql;
    // first: amount ASC NULLS LAST; last: the reverse — amount DESC NULLS FIRST
    expect(sql).toContain(
      'FIRST_VALUE("amount") OVER (PARTITION BY "category" ORDER BY "amount" ASC NULLS LAST) AS "__as_fl0"',
    );
    expect(sql).toContain(
      'FIRST_VALUE("amount") OVER (PARTITION BY "category" ORDER BY "amount" DESC NULLS FIRST) AS "__as_fl1"',
    );
    const my = buildAggregateSelect(mysql, "t", where, agg({})).sql;
    expect(my).toContain("ORDER BY (`amount` IS NULL) ASC, `amount` ASC) AS `__as_fl0`");
    expect(my).toContain("ORDER BY (`amount` IS NULL) DESC, `amount` DESC) AS `__as_fl1`");
    const p = buildAggregateSelect(pg, "t", where, agg({})).sql;
    expect(p).toContain('ORDER BY "amount" ASC) AS "__as_fl0"');
    expect(p).toContain('ORDER BY "amount" DESC) AS "__as_fl1"');
  });
});
