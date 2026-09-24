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

const hide =
  (...hidden: string[]) =>
  (path: string) =>
    !hidden.includes(path);

describe("identification under a field-visibility predicate (since 0.1.134)", () => {
  beforeAll(async () => {
    await prepareFixtures();
  });

  it("identificationsVisibleTo drops a unique index over a hidden field; PK and preferredId stay", async () => {
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(SlugPreferredUser, new MockAdapter());
    expect(table.identificationsVisibleTo(hide("id", "email", "slug"))).toEqual([
      { fields: ["id"], source: "primaryKey" },
      { fields: ["slug"], source: "by_slug" },
    ]);
    expect(table.identificationsVisibleTo()).toBe(table.identifications);
  });

  it("a compound preferredId stays addressable when one of its fields is hidden", async () => {
    const { TenantPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(TenantPreferredUser, new MockAdapter());
    expect(table.identificationsVisibleTo(hide("tenantId"))).toEqual(table.identifications);
  });

  it("resolveIdFilter ignores a hidden unique key — as if the index did not exist", async () => {
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const table = new AtscriptDbTable(SlugPreferredUser, new MockAdapter());
    expect(table.resolveIdFilter({ email: "a@x" })).toEqual({ email: "a@x" });
    expect(table.resolveIdFilter({ email: "a@x" }, { isFieldVisible: hide("email") })).toBeNull();
    expect(table.resolveIdFilter({ slug: "s" }, { isFieldVisible: hide("slug") })).toEqual({
      slug: "s",
    });
  });

  it("deleteOne never resolves an id through a hidden unique key", async () => {
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(SlugPreferredUser, adapter);
    adapter.store.set(table.tableName, [{ id: "1", email: "a@x", slug: "s" }]);
    expect(
      await table.deleteOne({ email: "a@x" } as never, { isFieldVisible: hide("email") }),
    ).toEqual({ deletedCount: 0 });
    expect(adapter.calls.some((c) => c.method === "deleteOne")).toBe(false);
    expect(await table.deleteOne({ email: "a@x" } as never)).toEqual({ deletedCount: 1 });
  });

  it("updateOne without a PK never identifies its row through a hidden unique key", async () => {
    const { SlugPreferredUser } = await import("./fixtures/preferred-id.as");
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(SlugPreferredUser, adapter);
    await expect(
      table.updateOne({ email: "a@x" } as never, { isFieldVisible: hide("email") }),
    ).rejects.toThrow('Missing primary key field "id" in payload');
    expect(adapter.calls.some((c) => c.method === "updateOne")).toBe(false);
    // Hidden `email` skipped, visible `slug` identifies; unrestricted, `email` does.
    await table.updateOne({ email: "a@x", slug: "t" } as never, { isFieldVisible: hide("email") });
    await table.updateOne({ email: "a@x", slug: "t" } as never);
    const filters = adapter.calls.filter((c) => c.method === "updateOne").map((c) => c.args[0]);
    expect(filters).toEqual([{ slug: "t" }, { email: "a@x" }]);
  });
});
