import { beforeAll } from "vite-plus/test";

import { defineSqlAdapterMockCases } from "../../../db/test-kit/sql-adapter-mock-cases";
import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// Aggregate arithmetic and first / last on PostgreSQL (since 0.1.148): the
// shared SQL-adapter table against a mock driver. The live run is
// aggregate-expr.live.spec.ts.

let BucketTicket: any;

beforeAll(async () => {
  await prepareFixtures();
  BucketTicket = (await import("./fixtures/bucket-tickets.as")).BucketTicket;
});

defineSqlAdapterMockCases({
  name: "PostgresAdapter",
  createDriver: (rows) => createMockDriver({ allResult: rows }),
  createAdapter: (driver) => new PostgresAdapter(driver),
  tableType: () => BucketTicket,
  // SQLSTATE 22003: numeric_value_out_of_range
  overflowError: () => Object.assign(new Error("out of range"), { code: "22003" }),
  otherError: () => Object.assign(new Error("boom"), { code: "99999" }),
  sql: {
    sumProduct: 'SUM((CAST("id" AS DOUBLE PRECISION) * CAST(2 AS DOUBLE PRECISION))) AS "total"',
    firstWindow:
      'FIRST_VALUE("openedAt") OVER (PARTITION BY "status" ORDER BY "openedAt" ASC NULLS FIRST, "id" ASC NULLS FIRST)',
    lastWindow:
      'FIRST_VALUE("openedAt") OVER (PARTITION BY "status" ORDER BY "openedAt" DESC NULLS LAST, "id" DESC NULLS LAST)',
  },
});
