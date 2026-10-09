import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { epochMsToUtcDatetime, MysqlAdapter, utcDatetimeToEpochMs } from "../mysql-adapter";
import { buildColumnDefinition, isMysqlTimestampColumn, mysqlTemporalFsp } from "../sql-builder";
import { createMockDriver, prepareFixtures } from "./test-utils";

/**
 * Native TIMESTAMP / DATETIME columns of epoch-ms numbers (since 0.1.151):
 * fractional seconds round-trip at the column's precision, the DDL carries
 * `CURRENT_TIMESTAMP(n)` at that precision, and nothing depends on the
 * process time zone.
 */

let fx: Record<string, any>;
beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/timestamps.as");
});

const ZONES = ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Chatham"];
const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const MS = Date.UTC(2024, 6, 15, 23, 59, 59, 987);

function setup() {
  const driver = createMockDriver();
  const adapter = new MysqlAdapter(driver);
  const table = new AtscriptDbTable(fx.TsItem, adapter);
  const fd = (path: string) => table.fieldDescriptors.find((f) => f.path === path)!;
  return { driver, adapter, table, fd };
}

describe("[mysql] TIMESTAMP / DATETIME precision", () => {
  it("resolves each field's storage and fractional precision", () => {
    const { fd } = setup();
    expect(mysqlTemporalFsp(fd("createdAt"))).toBe(0);
    expect(mysqlTemporalFsp(fd("updatedAt"))).toBe(3);
    expect(mysqlTemporalFsp(fd("seenAt"))).toBe(6);
    expect(mysqlTemporalFsp(fd("shortAt"))).toBe(2);
    // a non-temporal override wins over @db.default.now: a plain epoch-ms number
    expect(mysqlTemporalFsp(fd("epochAt"))).toBeUndefined();
    expect(isMysqlTimestampColumn(fd("epochAt"))).toBe(false);
    expect(mysqlTemporalFsp(fd("id"))).toBeUndefined();
  });

  it.each(ZONES)("writes milliseconds at the column precision under TZ=%s", (tz) => {
    process.env.TZ = tz;
    expect(epochMsToUtcDatetime(MS)).toBe("2024-07-15 23:59:59");
    expect(epochMsToUtcDatetime(MS, 3)).toBe("2024-07-15 23:59:59.987");
    expect(epochMsToUtcDatetime(MS, 6)).toBe("2024-07-15 23:59:59.987");
    expect(epochMsToUtcDatetime(MS, 2)).toBe("2024-07-15 23:59:59.98");
    expect(epochMsToUtcDatetime(MS, 1)).toBe("2024-07-15 23:59:59.9");
    expect(epochMsToUtcDatetime(Date.UTC(2024, 0, 1, 0, 0, 0, 5), 3)).toBe(
      "2024-01-01 00:00:00.005",
    );
  });

  it.each(ZONES)("reads fractional seconds back under TZ=%s", (tz) => {
    process.env.TZ = tz;
    expect(utcDatetimeToEpochMs("2024-07-15 23:59:59")).toBe(Date.UTC(2024, 6, 15, 23, 59, 59));
    expect(utcDatetimeToEpochMs("2024-07-15 23:59:59.987")).toBe(MS);
    expect(utcDatetimeToEpochMs("2024-07-15 23:59:59.987654")).toBe(MS);
    expect(utcDatetimeToEpochMs("2024-07-15 23:59:59.9")).toBe(
      Date.UTC(2024, 6, 15, 23, 59, 59, 900),
    );
  });

  it("the write path formats per field; the read path parses back to the same instant", async () => {
    const { driver, table } = setup();
    await table.insertOne({
      id: 1,
      createdAt: MS,
      updatedAt: MS,
      seenAt: MS,
      shortAt: MS,
      epochAt: MS,
    });
    const insert = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
    expect(insert.sql).toBe(
      "INSERT INTO `ts_items` (`id`, `createdAt`, `updatedAt`, `seenAt`, `shortAt`, `epochAt`) VALUES (?, ?, ?, ?, ?, ?)",
    );
    expect(insert.params).toEqual([
      1,
      "2024-07-15 23:59:59",
      "2024-07-15 23:59:59.987",
      "2024-07-15 23:59:59.987",
      "2024-07-15 23:59:59.98",
      MS,
    ]);
    for (const v of insert.params!.slice(2, 4)) {
      expect(utcDatetimeToEpochMs(v)).toBe(MS);
    }
  });

  it("DDL: CURRENT_TIMESTAMP(n) at the column precision for DEFAULT and ON UPDATE", () => {
    const { adapter, fd } = setup();
    const ctx = (adapter as any)._columnCtx("create");
    expect(buildColumnDefinition(fd("createdAt"), ctx).def).toBe(
      "`createdAt` TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
    );
    expect(buildColumnDefinition(fd("updatedAt"), ctx).def).toBe(
      "`updatedAt` TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)",
    );
    expect(buildColumnDefinition(fd("seenAt"), ctx).def).toBe("`seenAt` DATETIME(6)");
  });

  it("introspection reads CURRENT_TIMESTAMP(n) back as the now default (no drift)", async () => {
    const driver = createMockDriver({
      allResult: [
        {
          COLUMN_NAME: "updatedAt",
          COLUMN_TYPE: "timestamp(3)",
          IS_NULLABLE: "YES",
          COLUMN_DEFAULT: "CURRENT_TIMESTAMP(3)",
          SRS_ID: null,
          EXTRA: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)",
          IS_PK: 0,
        },
      ],
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.TsItem, adapter);
    const [col] = await adapter.getExistingColumns();
    expect(col).toMatchObject({ type: "TIMESTAMP(3)", dflt_value: "fn:now" });
  });
});
