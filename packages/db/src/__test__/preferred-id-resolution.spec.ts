import { beforeAll, describe, expect, it } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

describe("preferred-id resolution", () => {
  beforeAll(async () => {
    await prepareFixtures();
  });

  it("defaults to primary keys when the annotation is absent", async () => {
    const { PlainPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(PlainPreferredUser, new MockAdapter());
    expect(table.preferredId).toEqual(table.primaryKeys);
  });

  it("uses the first declared unique index when no name is supplied", async () => {
    const { EmailPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(EmailPreferredUser, new MockAdapter());
    expect(table.preferredId).toEqual(["email"]);
  });

  it("uses the named unique index when a name is supplied", async () => {
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(SlugPreferredUser, new MockAdapter());
    expect(table.preferredId).toEqual(["slug"]);
  });

  it("resolves compound unique indexes in declaration order", async () => {
    const { TenantPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(TenantPreferredUser, new MockAdapter());
    expect(table.preferredId).toEqual(["tenantId", "userId"]);
  });

  it("exposes logical names rather than physical column names", async () => {
    const { PhysicalSlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(PhysicalSlugPreferredUser, new MockAdapter());
    expect(table.preferredId).toEqual(["slug"]);
  });
});
