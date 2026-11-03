import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// renameTable is idempotent (since 0.1.168): when the old table is gone and
// the new one exists, an earlier run already renamed it — nothing to do.

let UsersTable: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ UsersTable } = await import("./fixtures/test-table.as"));
});

function setup(present: string[]) {
  const driver = createMockDriver();
  const adapter = new PostgresAdapter(driver);
  new AtscriptDbTable(UsersTable, adapter).getMetadata();
  vi.spyOn(adapter, "getObjectKind").mockImplementation(async (name: string) =>
    present.includes(name) ? "table" : undefined,
  );
  const renames = () => driver.calls.filter((c) => c.sql.includes("RENAME TO"));
  return { adapter, renames };
}

describe("PostgresAdapter.renameTable", () => {
  it("renames when the old table exists", async () => {
    const { adapter, renames } = setup(["old_users"]);
    await adapter.renameTable("old_users");
    expect(renames()).toHaveLength(1);
  });

  it("is a no-op when only the new table exists", async () => {
    const { adapter, renames } = setup(["users"]);
    await adapter.renameTable("old_users");
    expect(renames()).toHaveLength(0);
  });
});
