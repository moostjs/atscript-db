import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.155: `T | null` is a nullable column of T's type, a union of
// objects is flattened with `__`, a union mixing an object with another type
// is one JSONB column. The live counterpart is `union-columns.live.spec.ts`.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/union-columns.as");
});

describe("[postgres] union columns", () => {
  it("CREATE TABLE", async () => {
    const driver = createMockDriver();
    await new AtscriptDbTable(fx.UcOrder, new PostgresAdapter(driver)).ensureTable();
    expect(driver.calls.find((c) => c.sql.startsWith("CREATE TABLE"))?.sql).toBe(
      'CREATE TABLE IF NOT EXISTS "uc_orders" ("id" DOUBLE PRECISION PRIMARY KEY, "note" TEXT, "qty" INTEGER, "paid" BOOLEAN, "status" TEXT, "code" VARCHAR(10), "tags" JSONB, "addr__street" TEXT, "addr__zip" TEXT, "payment__kind" TEXT NOT NULL, "payment__card" TEXT, "payment__amount" DOUBLE PRECISION NOT NULL, "payment__iban" TEXT, "payment__bic" TEXT, "refund__kind" TEXT, "refund__card" TEXT, "refund__amount" DOUBLE PRECISION, "refund__iban" TEXT, "refund__bic" TEXT, "extra" JSONB NOT NULL, "shipping__street" TEXT, "shipping__city" TEXT)',
    );
  });

  it("a JSON string value node-postgres hands back parsed stays a string", async () => {
    // node-postgres parses JSONB: `"7"` arrives as the string 7, `[…]` as an array
    const row = { id: 1, extra: "7", tags: ["a"], payment__kind: "card", payment__amount: 1 };
    const driver = createMockDriver({ allResult: [row] });
    const table = new AtscriptDbTable(fx.UcOrder, new PostgresAdapter(driver));
    expect(await table.findMany({ filter: {} })).toEqual([
      { id: 1, extra: "7", tags: ["a"], payment: { kind: "card", amount: 1 } },
    ]);
  });

  it("a JSON field in a text column (`@db.pg.type 'TEXT'`) is parsed from its text", async () => {
    const row = { id: 1, data: '{"street":"s"}', extra: '"abc"' };
    const driver = createMockDriver({ allResult: [{ ...row, extra: "abc" }] });
    const table = new AtscriptDbTable(fx.UcTextJson, new PostgresAdapter(driver));
    expect(await table.findMany({ filter: {} })).toEqual([
      { id: 1, data: { street: "s" }, extra: "abc" },
    ]);
  });
});
