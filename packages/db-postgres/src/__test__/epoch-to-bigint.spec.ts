import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// A `DOUBLE PRECISION` column becoming `BIGINT` (`number.timestamp` →
// `number.timestamp.created`, which carries `@db.default.now` since 0.1.155):
// a fractional value does not parse as an integer through text, so it is
// rounded.

let TsAfter: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ TsAfter } = await import("./fixtures/embedded-id.as"));
});

async function alter(existingType: string): Promise<string[]> {
  const driver = createMockDriver();
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(TsAfter, adapter);
  const field = table.fieldDescriptors.find((f) => f.path === "createdAt")!;
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

  it("a text column still converts through text", async () => {
    expect(await alter("TEXT")).toEqual([
      'ALTER TABLE "ts_upgrade" ALTER COLUMN "createdAt" TYPE BIGINT USING "createdAt"::text::BIGINT',
    ]);
  });
});
