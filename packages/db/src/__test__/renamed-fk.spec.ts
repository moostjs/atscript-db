import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbSpace } from "../index";
import { computeForeignKeyDiff, hasForeignKeyChanges } from "../schema/fk-diff";
import { computeTableSnapshot } from "../schema/schema-hash";
import type { TTableSnapshot } from "../schema/schema-hash";

import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

// FK metadata over `@db.column`-renamed columns (since 0.1.147): `fields` /
// `targetFields` stay logical (relation pairing), `physicalFields` /
// `physicalTargetFields` carry the columns DDL, constraint sync, the FK diff
// and the schema snapshot use.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/renamed-fk.as");
});

function readable(type: unknown, nested = false): any {
  const space = new DbSpace(() => (nested ? new NestedMockAdapter() : new MockAdapter()));
  return space.getTable(type as never);
}

function fksOf(type: unknown, nested = false) {
  return [...readable(type, nested).foreignKeys.values()].map((fk: any) => ({
    fields: fk.fields,
    physicalFields: fk.physicalFields,
    targetTable: fk.targetTable,
    targetFields: fk.targetFields,
    physicalTargetFields: fk.physicalTargetFields,
  }));
}

const snapshotOf = (r: unknown): TTableSnapshot =>
  computeTableSnapshot(r as never, (f) => f.designType.toUpperCase());

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The snapshot as 0.1.146 and earlier stored it: FK columns by LOGICAL name. */
function logicalSnapshot(r: any): TTableSnapshot {
  return {
    ...snapshotOf(r),
    foreignKeys: [...r.foreignKeys.values()]
      .map((fk: any) => ({
        fields: [...fk.fields].toSorted(byCodeUnit),
        targetTable: fk.targetTable,
        targetFields: [...fk.targetFields].toSorted(byCodeUnit),
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      }))
      .toSorted((a, b) => a.fields.join(",").localeCompare(b.fields.join(","))),
  };
}

describe("FK metadata — physical counterparts", () => {
  it("renamed local, renamed target and a composite mixing both (relational)", () => {
    expect(fksOf(fx.RkItem)).toEqual([
      {
        fields: ["teamId"],
        physicalFields: ["team_ref"],
        targetTable: "rk_teams",
        targetFields: ["id"],
        physicalTargetFields: ["id"],
      },
      {
        fields: ["tagCode"],
        physicalFields: ["tagCode"],
        targetTable: "rk_tags",
        targetFields: ["code"],
        physicalTargetFields: ["tag_code"],
      },
      {
        fields: ["boardOrg", "boardCode"],
        physicalFields: ["b_org", "boardCode"],
        targetTable: "rk_boards",
        targetFields: ["org", "code"],
        physicalTargetFields: ["board_org", "code"],
      },
    ]);
  });

  it("document storage renames the same top-level keys", () => {
    expect(fksOf(fx.RkItem, true).map((f) => [f.physicalFields, f.physicalTargetFields])).toEqual([
      [["team_ref"], ["id"]],
      [["tagCode"], ["tag_code"]],
      [
        ["b_org", "boardCode"],
        ["board_org", "code"],
      ],
    ]);
  });

  it("an FK without renames is unchanged", () => {
    expect(fksOf(fx.RkPlain)).toEqual([
      {
        fields: ["teamId"],
        physicalFields: ["teamId"],
        targetTable: "rk_teams",
        targetFields: ["id"],
        physicalTargetFields: ["id"],
      },
    ]);
  });

  it("the snapshot stores physical FK columns", () => {
    expect(snapshotOf(readable(fx.RkItem)).foreignKeys).toEqual([
      {
        fields: ["b_org", "boardCode"],
        targetTable: "rk_boards",
        targetFields: ["board_org", "code"],
        onDelete: undefined,
        onUpdate: undefined,
      },
      {
        fields: ["tagCode"],
        targetTable: "rk_tags",
        targetFields: ["tag_code"],
        onDelete: undefined,
        onUpdate: undefined,
      },
      {
        fields: ["team_ref"],
        targetTable: "rk_teams",
        targetFields: ["id"],
        onDelete: undefined,
        onUpdate: undefined,
      },
    ]);
  });
});

describe("FK diff over renamed columns", () => {
  it.each([false, true])("a second sync is a no-op (nested=%s)", (nested) => {
    const r = readable(fx.RkItem, nested);
    const diff = computeForeignKeyDiff(r.foreignKeys, snapshotOf(r).foreignKeys);
    expect(hasForeignKeyChanges(diff)).toBe(false);
  });

  it("a pre-0.1.147 snapshot (logical names) re-syncs only the renamed FKs", () => {
    const r = readable(fx.RkItem);
    const diff = computeForeignKeyDiff(r.foreignKeys, logicalSnapshot(r).foreignKeys);
    expect(diff.added.map((fk) => fk.fields)).toEqual([["teamId"], ["boardOrg", "boardCode"]]);
    expect(diff.removed.map((fk) => fk.fields)).toEqual([["boardCode", "boardOrg"], ["teamId"]]);
    // Same local column, renamed target column → a property change
    expect(diff.changed.map((c) => c.existing.fields)).toEqual([["tagCode"]]);
  });

  it("a plain FK keeps its pre-0.1.147 snapshot", () => {
    const r = readable(fx.RkPlain);
    expect(
      hasForeignKeyChanges(computeForeignKeyDiff(r.foreignKeys, logicalSnapshot(r).foreignKeys)),
    ).toBe(false);
  });
});
