import { beforeAll, describe, expect, it } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

describe("TableMetadata.getIdentifications()", () => {
  beforeAll(async () => {
    await prepareFixtures();
  });

  it("returns the primary key as the sole identifier when no unique indexes are declared", async () => {
    const { PlainPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(PlainPreferredUser, new MockAdapter());
    expect(table.identifications).toEqual([{ fields: ["id"], source: "primaryKey" }]);
  });

  it("lists primary key first, then each unique index in declaration order", async () => {
    const { EmailPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(EmailPreferredUser, new MockAdapter());
    expect(table.identifications).toEqual([
      { fields: ["id"], source: "primaryKey" },
      { fields: ["email"], source: "email" },
      { fields: ["slug"], source: "slug" },
    ]);
  });

  it("preserves named unique-index sources", async () => {
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(SlugPreferredUser, new MockAdapter());
    expect(table.identifications).toEqual([
      { fields: ["id"], source: "primaryKey" },
      { fields: ["email"], source: "by_email" },
      { fields: ["slug"], source: "by_slug" },
    ]);
  });

  it("groups compound unique indexes into a single identifier with logical field names", async () => {
    const { TenantPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(TenantPreferredUser, new MockAdapter());
    expect(table.identifications).toEqual([
      { fields: ["id"], source: "primaryKey" },
      { fields: ["tenantId", "userId"], source: "by_tenant_user" },
    ]);
  });

  it("uses logical field names even when @db.column renames the physical column", async () => {
    const { PhysicalSlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(PhysicalSlugPreferredUser, new MockAdapter());
    expect(table.identifications).toEqual([
      { fields: ["id"], source: "primaryKey" },
      { fields: ["slug"], source: "slug" },
    ]);
  });
});
