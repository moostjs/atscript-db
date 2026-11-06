import { it, expect, beforeEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

/**
 * The shared case of safe mode keeping a removed table whose foreign key
 * references a column that changes type (since 0.1.173), run by the MySQL
 * and PostgreSQL live suites over `fixtures/retained-retype.as` of each
 * adapter. The change waits for the run that drops the table — the order a
 * run without safe applies — instead of running into the kept constraint,
 * which both engines refuse once the key types no longer match.
 */
export interface TRetainedRetypeKit {
  fx: () => Record<string, any>;
  /** A fresh space over the suite's (recreated) database. */
  space: () => DbSpace;
  /** The live column type as the engine reports it. */
  columnType: (table: string, column: string) => Promise<string | undefined>;
  /** The live foreign keys of `table`. */
  foreignKeys: (table: string) => Promise<unknown[]>;
  /** `SELECT <columns> FROM <table>` with the engine's identifier quoting. */
  select: (table: string, columns: string[]) => Promise<unknown[]>;
}

/** What a plan entry and its run entry must agree on. */
const shape = (e: { status: string; typeChanges: unknown; skipped: unknown }) => ({
  status: e.status,
  typeChanges: e.typeChanges,
  skipped: e.skipped,
});

/** Registers the v1 sync + seed rows and the shared case. */
export function defineRetainedRetypeCases(kit: TRetainedRetypeKit): void {
  const { fx, columnType, foreignKeys, select } = kit;

  beforeEach(async () => {
    const space = kit.space();
    const v1 = await new SchemaSync(space).run([fx().RrParent, fx().RrChild], { force: true });
    expect(v1.status).toBe("synced");
    await space.getTable(fx().RrParent).insertOne({ id: 1, code: "7" } as never);
    await space.getTable(fx().RrChild).insertOne({ id: 1, parentCode: "7" } as never);
  });

  it("waits — pending, plan = run, nothing modified; the next run without safe drops the table, then retypes", async () => {
    const sync = new SchemaSync(kit.space());
    const typeBefore = await columnType("rr_parents", "code");

    const plan = await sync.plan([fx().RrParentV2], { safe: true });
    const planned = plan.entries.find((e) => e.name === "rr_parents")!;
    expect(planned.typeChanges).toEqual([
      expect.objectContaining({ column: "code", toType: "number", waitsFor: ["rr_children"] }),
    ]);
    expect(planned.skipped).toEqual(["retype"]);

    const safe = await sync.run([fx().RrParentV2], { safe: true });
    expect(safe.status).not.toBe("failed");
    const entry = safe.entries.find((e) => e.name === "rr_parents")!;
    // the safe plan is what the safe run did
    expect(shape(entry)).toEqual(shape(planned));
    expect(entry.pending).toBe(true);
    // the column is not modified; the kept table keeps its rows and constraint
    expect(await columnType("rr_parents", "code")).toBe(typeBefore);
    expect(await select("rr_children", ["id", "parentCode"])).toEqual([{ id: 1, parentCode: "7" }]);
    expect(await foreignKeys("rr_children")).toHaveLength(1);

    // pending → the hash was withheld: the next run without safe applies it
    const next = await sync.run([fx().RrParentV2]);
    expect(next.status).toBe("synced");
    expect(next.entries.map((e) => [e.name, e.status])).toEqual([
      ["rr_children", "drop"],
      ["rr_parents", "alter"],
    ]);
    expect(await columnType("rr_parents", "code")).not.toBe(typeBefore);
    expect(await select("rr_parents", ["id", "code"])).toEqual([{ id: 1, code: 7 }]);
  });
}
