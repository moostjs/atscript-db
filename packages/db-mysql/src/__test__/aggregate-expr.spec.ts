import { beforeAll } from "vite-plus/test";

import { defineSqlAdapterMockCases } from "../../../db/test-kit/sql-adapter-mock-cases";
import { MysqlAdapter } from "../mysql-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// Aggregate arithmetic and first / last on MySQL (since 0.1.148): the shared
// SQL-adapter table against a mock driver. The live run is
// aggregate-expr.live.spec.ts.

let BucketTicket: any;

beforeAll(async () => {
  await prepareFixtures();
  BucketTicket = (await import("./fixtures/bucket-tickets.as")).BucketTicket;
});

defineSqlAdapterMockCases({
  name: "MysqlAdapter",
  createDriver: (rows) => createMockDriver({ allResult: rows }),
  createAdapter: (driver) => new MysqlAdapter(driver),
  tableType: () => BucketTicket,
  // errno 1690: DOUBLE value is out of range
  overflowError: () => Object.assign(new Error("out of range"), { errno: 1690 }),
  otherError: () => Object.assign(new Error("boom"), { code: "99999", errno: 1 }),
  sql: {
    sumProduct: "SUM((CAST(`id` AS DOUBLE) * CAST(2 AS DOUBLE))) AS `total`",
    firstWindow:
      "FIRST_VALUE(`openedAt`) OVER (PARTITION BY `status` ORDER BY `openedAt` ASC, `id` ASC)",
    lastWindow:
      "FIRST_VALUE(`openedAt`) OVER (PARTITION BY `status` ORDER BY `openedAt` DESC, `id` DESC)",
  },
});
