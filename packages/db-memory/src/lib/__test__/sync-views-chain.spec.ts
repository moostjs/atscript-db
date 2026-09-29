import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { MemoryAdapter } from "../memory-adapter";
import { prepareFixtures } from "./test-utils";

// Views over views on the memory adapter (since 0.1.141): views hold no rows
// here, but schema sync orders them upstream-first, tracks their sources and
// drops dependents first — the same plan every adapter gets.

let fx: Record<string, any>;

class SpyAdapter extends MemoryAdapter {
  static drops: string[] = [];
  override async dropViewByName(name: string): Promise<void> {
    SpyAdapter.drops.push(name);
    return super.dropViewByName(name);
  }
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-chain.as");
});

describe("MemoryAdapter — views over views", () => {
  it("creates views upstream-first, records them as views and lists view sources in dependsOn", async () => {
    const db = new DbSpace(() => new SpyAdapter());
    const result = await new SchemaSync(db).run(
      [fx.VcParisPeople, fx.VcPeopleDepts, fx.VcStaff, fx.VcPeople, fx.VcDepartment, fx.VcEmployee],
      { force: true },
    );
    expect(result.status).toBe("synced");
    expect(result.entries.filter((e) => e.viewType).map((e) => e.name)).toEqual([
      "vc_people",
      "vc_people_depts",
      "vc_paris_people",
      "vc_staff",
    ]);
    const entry = (name: string) => result.entries.find((e) => e.name === name)!;
    expect(entry("vc_people_depts").dependsOn).toEqual(["vc_departments", "vc_people"]);
    expect(entry("vc_paris_people").dependsOn).toEqual(["vc_people_depts"]);
    expect(entry("vc_staff").dependsOn).toEqual(["vc_departments", "vc_employees"]);
    expect(await db.getAdapter(fx.VcParisPeople).getObjectKind!("vc_paris_people")).toBe("view");
    expect(await db.getAdapter(fx.VcParisPeople).getObjectKind!("vc_people")).toBe("view");
  });

  it("refuses a view whose source view left the inventory, and drops removed views dependents-first", async () => {
    const db = new DbSpace(() => new SpyAdapter());
    const sync = new SchemaSync(db);
    await sync.run(
      [fx.VcEmployee, fx.VcDepartment, fx.VcPeople, fx.VcPeopleDepts, fx.VcParisPeople],
      {
        force: true,
      },
    );

    const refused = await sync.run(
      [fx.VcEmployee, fx.VcDepartment, fx.VcPeopleDepts, fx.VcParisPeople],
      {
        force: true,
      },
    );
    expect(refused.status).toBe("refused");
    expect(refused.entries.find((e) => e.name === "vc_people")!.errors[0]).toContain(
      'Cannot drop view "vc_people": it is still referenced by view "vc_people_depts"',
    );

    SpyAdapter.drops = [];
    const dropped = await sync.run([fx.VcEmployee, fx.VcDepartment], { force: true });
    expect(dropped.status).toBe("synced");
    expect(SpyAdapter.drops).toEqual(["vc_paris_people", "vc_people_depts", "vc_people"]);
    expect(await db.getAdapter(fx.VcEmployee).getObjectKind!("vc_people")).toBeUndefined();
  });
});
