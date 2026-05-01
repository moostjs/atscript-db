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

describe("findById — preferred-id wins over PK for scalar lookup", () => {
  beforeAll(async () => {
    await prepareFixtures();
  });

  it("explicit single-field preferredId restricts scalar resolution to that field (PK + other unique indexes are NOT tried)", async () => {
    // Table: SlugPreferredUser — PK `id`, preferredId `slug` (via @db.table.preferredId.uniqueIndex 'by_slug').
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(SlugPreferredUser, adapter);
    await table.insertOne({ id: "id-1", slug: "alpha", email: "a@x.test" });
    await table.insertOne({ id: "alpha", slug: "beta", email: "b@x.test" });

    // Scalar `"alpha"` matches the second row by `id` (PK) AND the first
    // row by `slug` (preferredId). With the new resolver, preferredId wins
    // — first row.
    const found = await table.findById("alpha" as never);
    expect(found).not.toBeNull();
    expect((found as { slug: string }).slug).toBe("alpha");
    expect((found as { id: string }).id).toBe("id-1");
  });

  it("named-form (object id) keeps full permissive resolution regardless of preferredId — caller is explicit about which field", async () => {
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(SlugPreferredUser, adapter);
    await table.insertOne({ id: "id-7", slug: "seven", email: "s@x.test" });

    // Object form addresses the row by PK explicitly — must work even when
    // preferredId is `slug`. Scalar-priority does NOT apply to object ids.
    const found = await table.findById({ id: "id-7" } as never);
    expect(found).not.toBeNull();
    expect((found as { slug: string }).slug).toBe("seven");
  });

  it("compound preferredId is non-applicable for scalar id (fall through to permissive resolution)", async () => {
    // Table: TenantPreferredUser — preferredId is compound `[tenantId, userId]`.
    // A scalar id can't fill a compound shape; the function falls through
    // to single-field PK / unique-index lookup.
    const { TenantPreferredUser } = await import("./fixtures/preferred-id.as");
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(TenantPreferredUser, adapter);
    await table.insertOne({ id: "id-9", tenantId: "acme", userId: "u1" });

    const found = await table.findById("id-9" as never);
    expect(found).not.toBeNull();
    expect((found as { tenantId: string }).tenantId).toBe("acme");
  });
});
