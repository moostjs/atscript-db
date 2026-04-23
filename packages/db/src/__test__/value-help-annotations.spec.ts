import { describe, it, expect, beforeAll } from "vite-plus/test";

import { prepareFixtures } from "./test-utils";

describe("value-help annotations (F1 relaxed, @db.column.*, @db.table.*)", () => {
  beforeAll(async () => {
    await prepareFixtures();
  });

  it("@db.rel.FK compiles on a non-@db.table interface whose target is plain+@meta.id", async () => {
    const { InviteForm } = (await import("./fixtures/value-help/invite-form.as")) as any;
    const props = InviteForm.type.props;
    const roleId = props.get("roleId");
    const status = props.get("status");

    expect(roleId.metadata.has("db.rel.FK")).toBe(true);
    expect(status.metadata.has("db.rel.FK")).toBe(true);
  });

  it("@db.rel.FK continues to validate on @db.table host (relaxation is additive)", async () => {
    const { Role } = (await import("./fixtures/value-help/roles-table.as")) as any;
    expect(Role.metadata.get("db.table")).toBeTruthy();
    const id = Role.type.props.get("id");
    expect(id.metadata.has("meta.id")).toBe(true);
  });

  it("@db.column.filterable / @db.column.sortable compile on @db.table fields", async () => {
    const { GatedUser } = (await import("./fixtures/value-help/manual-gate.as")) as any;
    const email = GatedUser.type.props.get("email");
    expect(email.metadata.has("db.column.filterable")).toBe(true);
    expect(email.metadata.has("db.column.sortable")).toBe(true);

    const name = GatedUser.type.props.get("name");
    expect(name.metadata.has("db.column.filterable")).toBe(false);
    expect(name.metadata.has("db.column.sortable")).toBe(false);
  });

  it("@db.table.filterable / @db.table.sortable 'manual' are stamped on the interface metadata", async () => {
    const { GatedUser } = (await import("./fixtures/value-help/manual-gate.as")) as any;
    expect(GatedUser.metadata.get("db.table.filterable")).toBe("manual");
    expect(GatedUser.metadata.get("db.table.sortable")).toBe("manual");
  });
});
