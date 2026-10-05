import { describe, it, expect } from "vite-plus/test";
import { AtscriptDbTable, DbError, type BaseDbAdapter } from "@atscript/db";

/**
 * The server-free behaviour of a SQL adapter's aggregate arithmetic and
 * `first` / `last` (since 0.1.148), one table for PostgreSQL and MySQL: the
 * rendered SQL through the adapter, the capability flags, and the engine's
 * double overflow mapped to `INVALID_QUERY`. The live run is
 * `aggregate-expr.live.spec.ts`.
 */
export interface TSqlAdapterMockDialect<D extends { calls: Array<{ sql: string }> }> {
  /** Suite name, e.g. `PostgresAdapter`. */
  name: string;
  /** A mock driver answering every `all()` with `rows` (and counting calls). */
  createDriver(rows: unknown[]): D;
  createAdapter(driver: D): BaseDbAdapter;
  /** A table type with `id`, `status` and a timestamp field `openedAt`. */
  tableType(): unknown;
  /** The error the engine raises on a double overflow. */
  overflowError(): Error;
  /** The error the engine raises for anything else (must pass through unchanged). */
  otherError(): Error;
  /** Expected SQL fragments. */
  sql: {
    /** `sum(id * 2)` as `total`. */
    sumProduct: string;
    /** `first(openedAt)` and `last(openedAt)` windows, ordered by `openedAt` and the key. */
    firstWindow: string;
    lastWindow: string;
  };
}

const grouped = (select: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    filter: {},
    controls: { $groupBy: ["status"], $select: ["status", ...select], ...extra },
  }) as any;

export function defineSqlAdapterMockCases<D extends { calls: Array<{ sql: string }> }>(
  dialect: TSqlAdapterMockDialect<D>,
): void {
  function bind(driver = dialect.createDriver([{ status: "open", total: 4 }])) {
    const adapter = dialect.createAdapter(driver);
    return { adapter, driver, table: new AtscriptDbTable(dialect.tableType() as any, adapter) };
  }

  describe(`${dialect.name} aggregate expressions`, () => {
    it("advertises arithmetic and first / last", () => {
      const { adapter } = bind();
      expect(adapter.supportsAggregateExpressions()).toBe(true);
      expect(adapter.aggregateFns().has("first")).toBe(true);
      expect(adapter.aggregateFns().has("last")).toBe(true);
    });

    it("renders a row-level expression as SUM over a double-cast product", async () => {
      const { table, driver } = bind();
      await table.aggregate(
        grouped([{ $fn: "sum", $expr: { $op: "*", $args: ["id", 2] }, $as: "total" }]),
      );
      expect(driver.calls[0].sql).toContain(dialect.sql.sumProduct);
    });

    it("renders first / last as a FIRST_VALUE derived table ordered by $rowOrder and the key", async () => {
      const { table, driver } = bind();
      await table.aggregate(
        grouped(
          [
            { $fn: "first", $field: "openedAt", $as: "oldest" },
            { $fn: "last", $field: "openedAt", $as: "newest" },
          ],
          { $rowOrder: { openedAt: 1 } },
        ),
      );
      const sql = driver.calls[0].sql;
      expect(sql).toContain(dialect.sql.firstWindow);
      expect(sql).toContain(dialect.sql.lastWindow);
      expect(sql).toContain("__as_rows");
      // the derived columns are aggregated, never grouped
      expect(sql).toMatch(/GROUP BY [^ ]+$/);
    });

    it("maps a double overflow to INVALID_QUERY on the row and the $count query", async () => {
      const driver = dialect.createDriver([]) as any;
      driver.all = async () => {
        throw dialect.overflowError();
      };
      driver.get = async () => {
        throw dialect.overflowError();
      };
      const { table } = bind(driver);
      const select = [
        { $fn: "sum", $expr: { $op: "*", $args: ["id", 9007199254740991] }, $as: "total" },
      ];
      for (const query of [
        grouped(select),
        grouped(select, { $count: true, $having: { total: { $gt: 0 } } }),
      ]) {
        const err = await table.aggregate(query).catch((e) => e);
        expect(err).toBeInstanceOf(DbError);
        expect(err.code).toBe("INVALID_QUERY");
        expect(err.errors).toEqual([{ path: "$select", message: "Arithmetic overflow" }]);
      }
    });

    it("an overflow in a query WITHOUT arithmetic is INVALID_QUERY 'Numeric value out of range' (not 'Arithmetic overflow')", async () => {
      const driver = dialect.createDriver([]) as any;
      driver.all = async () => {
        throw dialect.overflowError();
      };
      driver.get = async () => {
        throw dialect.overflowError();
      };
      const { table } = bind(driver);
      const select = [{ $fn: "sum", $field: "id", $as: "total" }];
      for (const query of [
        grouped(select),
        grouped(select, { $count: true, $having: { total: { $gt: 0 } } }),
      ]) {
        const err = await table.aggregate(query).catch((e) => e);
        expect(err).toBeInstanceOf(DbError);
        expect(err.code).toBe("INVALID_QUERY");
        expect(err.errors).toEqual([{ path: "", message: "Numeric value out of range" }]);
      }
    });

    it("leaves other driver errors untouched", async () => {
      const other = dialect.otherError();
      const driver = dialect.createDriver([]) as any;
      driver.all = async () => {
        throw other;
      };
      const { table } = bind(driver);
      await expect(
        table.aggregate(grouped([{ $fn: "count", $field: "*", $as: "n" }])),
      ).rejects.toBe(other);
    });
  });
}
