import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// A `DOUBLE PRECISION` column becoming `BIGINT` (`number.timestamp` →
// `number.timestamp.created`, which carries `@db.default.now` since 0.1.155):
// a fractional value does not parse as an integer through text, so it is
// rounded.

let TsAfter: any;
let BigCount: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ TsAfter, BigCount } = await import("./fixtures/embedded-id.as"));
});

async function alter(existingType: string, type = TsAfter, path = "createdAt"): Promise<string[]> {
  const driver = createMockDriver();
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(type, adapter);
  const field = table.fieldDescriptors.find((f) => f.path === path)!;
  await adapter.syncColumns({
    added: [],
    removed: [],
    renamed: [],
    typeChanged: [{ field, existingType }],
    nullableChanged: [],
    defaultChanged: [],
    conflicts: [],
  } as any);
  return driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
}

describe("[postgres] epoch-ms column → BIGINT", () => {
  it("a fractional column is rounded", async () => {
    expect(await alter("DOUBLE PRECISION")).toEqual([
      'ALTER TABLE "ts_upgrade" ALTER COLUMN "createdAt" TYPE BIGINT USING round("createdAt")::bigint',
    ]);
    expect((await alter("NUMERIC(20,3)"))[0]).toContain('USING round("createdAt")::bigint');
  });

  it("another BIGINT field is not rounded: a fractional value still fails", async () => {
    expect(await alter("DOUBLE PRECISION", BigCount, "n")).toEqual([
      'ALTER TABLE "big_counts" ALTER COLUMN "n" TYPE BIGINT USING "n"::text::BIGINT',
    ]);
  });

  it("a text column still converts through text", async () => {
    expect(await alter("TEXT")).toEqual([
      'ALTER TABLE "ts_upgrade" ALTER COLUMN "createdAt" TYPE BIGINT USING "createdAt"::text::BIGINT',
    ]);
  });
});
