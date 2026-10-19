import { describe, it, expect, beforeAll } from "vite-plus/test";
import { computeColumnDiff, sameDefaultValue } from "../schema/column-diff";
import { SyncEntry, type TSyncEntryInit } from "../schema/sync-entry";
import type { TDbFieldMeta, TExistingColumn } from "../types";
import { detailLines, expectAlterEntriesExplained } from "../../test-kit/default-convergence-cases";
import { mergeLiveForeignKeyChanges } from "../schema/sync-executor";
import { DbSpace } from "../table/db-space";
import { MockAdapter, prepareFixtures } from "./test-utils";

function field(
  physicalName: string,
  designType: string,
  value: string,
  storage: TDbFieldMeta["storage"] = "column",
): TDbFieldMeta {
  return {
    path: physicalName,
    physicalName,
    type: {} as any,
    designType,
    optional: false,
    isPrimaryKey: false,
    ignored: false,
    storage,
    defaultValue: value.startsWith("fn:")
      ? { kind: "fn", fn: value.slice(3) as "now" }
      : { kind: "value", value },
  };
}

const t = (designType: string, storage: TDbFieldMeta["storage"] = "column") => ({
  designType,
  storage,
});

describe("sameDefaultValue — canonical, type-aware default comparison", () => {
  it.each([
    // booleans: the DDL writes 1 / 0, PG reports true / false
    [t("boolean"), "1", "true"],
    [t("boolean"), "0", "false"],
    [t("boolean"), "true", "1"],
    [t("boolean"), "FALSE", "0"],
    // numbers numerically
    [t("number"), "1", "1.0"],
    [t("number"), "-1", "-1"],
    [t("number"), "1.5", "1.50"],
    [t("integer"), "5", "5"],
    // decimals: a DECIMAL column's scale
    [t("decimal"), "0.00", "0"],
    [t("decimal"), "10.5", "10.50"],
    // JSON-stored values: parsed, keys sorted
    [t("json", "json"), '{"a": 1, "b": 2}', '{"b":2,"a":1}'],
    [t("array", "json"), "[ ]", "[]"],
    [t("object", "json"), '{"x": [1, {"z": 1, "y": 2}]}', '{"x":[1,{"y":2,"z":1}]}'],
    // identical text and function defaults
    [t("string"), "it's", "it's"],
    [t("number"), "fn:now", "fn:now"],
  ] as const)("%o: %s = %s", (f, live, desired) => {
    expect(sameDefaultValue(f, live, desired)).toBe(true);
  });

  it.each([
    ["DECIMAL(10,2)", "2.35", "2.345"],
    ["decimal(10,2)", "-2.35", "-2.345"],
    ["NUMERIC(8, 0)", "3", "2.5"],
    ["NUMERIC(10,2)", "2.345", "2.345"],
  ])("a %s column stores %s for %s", (type, live, desired) => {
    expect(sameDefaultValue(t("decimal"), live, desired, type)).toBe(true);
  });

  it.each([
    [undefined, "2.35", "2.345"],
    ["NUMERIC", "2.3", "2.345"],
    ["DECIMAL(10,2)", "2.34", "2.345"],
  ])("a %s column storing %s is not %s", (type, live, desired) => {
    expect(sameDefaultValue(t("decimal"), live, desired, type)).toBe(false);
  });

  it.each([
    [t("boolean"), "1", "false"],
    [t("boolean"), "yes", "true"],
    [t("number"), "1", "2"],
    [t("number"), "", "0"],
    [t("number"), "abc", "abc "],
    [t("json", "json"), '{"a":1}', '{"a":2}'],
    [t("json", "json"), "not json", "not json "],
    // strings stay strings: `1.0` is not `1` for a text column
    [t("string"), "1", "1.0"],
    [t("string"), "true", "1"],
    // function defaults never equal a literal
    [t("number"), "fn:now", "0"],
    [t("string"), "fn:uuid", "fn:now"],
    [t("string"), undefined, "x"],
    [t("string"), "x", undefined],
  ] as const)("%o: %s ≠ %s", (f, live, desired) => {
    expect(sameDefaultValue(f, live, desired)).toBe(false);
  });
});

const col = (name: string, dflt_value: string): TExistingColumn => ({
  name,
  type: "X",
  notnull: true,
  pk: false,
  dflt_value,
});

describe("computeColumnDiff — engine-reported defaults of a converged table", () => {
  const desired = [
    field("ratio", "number", "1.0"),
    field("active", "boolean", "true"),
    field("archived", "boolean", "false"),
    field("price", "decimal", "10.50"),
    field("balance", "decimal", "0"),
    field("note", "string", "it's"),
    field("meta", "json", '{"b":2,"a":1}', "json"),
    field("tags", "array", "[]", "json"),
    field("createdAt", "number", "fn:now"),
  ];

  it.each([
    ["MySQL", ["1", "1", "0", "10.50", "0.00", "it's", '{"b":2,"a":1}', "[]", "fn:now"]],
    ["PostgreSQL", ["1", "1", "0", "10.5", "0", "it's", '{"a": 1, "b": 2}', "[]", "fn:now"]],
    ["SQLite", ["1", "1", "0", "10.5", "0", "it's", '{"b":2,"a":1}', "[]", "fn:now"]],
  ] as const)("%s: no default change", (_engine, live) => {
    const existing = desired.map((f, i) => col(f.physicalName, live[i]!));
    expect(computeColumnDiff(desired, existing).defaultChanged).toEqual([]);
  });

  it("a real change is still reported, with the engine's and the model's text", () => {
    const diff = computeColumnDiff([field("ratio", "number", "1.5")], [col("ratio", "1")]);
    expect(diff.defaultChanged.map((d) => [d.oldDefault, d.newDefault])).toEqual([["1", "1.5"]]);
  });

  it("rounds to the scale the column gets: a DECIMAL scale change keeps the precise default", () => {
    const fee = field("fee", "decimal", "2.345");
    const live = { ...col("fee", "2.35"), type: "DECIMAL(10,2)" };
    // Unchanged type: 2.345 is stored as 2.35 — nothing to alter
    expect(computeColumnDiff([fee], [live], () => "DECIMAL(10,2)").defaultChanged).toEqual([]);
    // Scale 2 → 3: the column will hold 2.345, the live 2.35 must be re-set
    const diff = computeColumnDiff([fee], [live], () => "DECIMAL(10,3)");
    expect(diff.typeChanged.map((tc) => tc.existingType)).toEqual(["DECIMAL(10,2)"]);
    expect(diff.defaultChanged.map((d) => [d.oldDefault, d.newDefault])).toEqual([
      ["2.35", "2.345"],
    ]);
  });
});

describe("SyncEntry — an applied alter always prints what it changed", () => {
  const alters: TSyncEntryInit[] = [
    {
      name: "a",
      status: "alter",
      typeChanges: [{ column: "n", fromType: "INT", toType: "number" }],
    },
    { name: "b", status: "alter", nullableChanges: [{ column: "n", toNullable: true }] },
    {
      name: "c",
      status: "alter",
      defaultChanges: [{ column: "amount", oldDefault: "0.00", newDefault: "1" }],
    },
    { name: "d", status: "alter", fkAdded: [{ fields: ["teamId"], targetTable: "teams" }] },
    { name: "e", status: "alter", fkRemoved: [{ fields: ["teamId"], targetTable: "teams" }] },
    {
      name: "f",
      status: "alter",
      fkChanged: [
        { fields: ["teamId"], targetTable: "teams", details: "onDelete noAction → cascade" },
      ],
    },
    { name: "g", status: "alter", viewType: "V", recreated: true, definitionChanged: true },
    {
      name: "i",
      status: "alter",
      indexChanges: [{ name: "atscript__plain__by_x", action: "add" }],
    },
    {
      name: "j",
      status: "alter",
      indexChanges: [{ name: "atscript__plain__by_y", action: "drop" }],
    },
    {
      name: "k",
      status: "alter",
      indexChanges: [{ name: "atscript__unique__by_z", action: "rebuild" }],
    },
    { name: "l", status: "alter", fkRemoved: [{ fields: ["teamId"], targetTable: "" }] },
    { name: "h", status: "alter" },
  ];

  it("plan and result entries satisfy the invariant", () => {
    const entries = alters.map((init) => new SyncEntry(init));
    expectAlterEntriesExplained(entries.slice(0, -1), "plan");
    expectAlterEntriesExplained(entries.slice(0, -1), "result");
  });

  it("prints applied wording in the result", () => {
    const lines = alters.map((init) => detailLines(new SyncEntry(init), "result"));
    expect(lines.slice(0, 11)).toEqual([
      ["      ~ n: INT → number — type changed"],
      ["      ~ n — nullable"],
      ["      ~ amount — default 0.00 → 1"],
      ["      + FK(teamId) → teams — added"],
      ["      - FK(teamId) → teams — removed"],
      ["      ~ FK(teamId) → teams — onDelete noAction → cascade"],
      ["      · definition changed"],
      ["      + index atscript__plain__by_x — added"],
      ["      - index atscript__plain__by_y — dropped"],
      ["      ~ index atscript__unique__by_z — rebuilt"],
      ["      - FK(teamId) — removed"],
    ]);
    expect(detailLines(new SyncEntry(alters[7]!), "plan")).toEqual([
      "      + index atscript__plain__by_x — add",
    ]);
  });

  it("an alter entry with nothing recorded prints `— altered`, never `in sync`", () => {
    const lines = new SyncEntry({ name: "h", status: "alter" }).print("result");
    expect(lines[0]).toBe("  ~ h — altered");
  });

  it("a view whose own definition changed says so in the plan", () => {
    const lines = new SyncEntry(alters[6]!).print("plan");
    expect(lines).toContain("      · definition changed");
  });

  it("safe-mode skips keep their skipped wording in the result", () => {
    const entry = new SyncEntry({
      name: "s",
      status: "alter",
      defaultChanges: [{ column: "x", oldDefault: "a", newDefault: "b" }],
      skipped: ["nullable-defaults"],
    });
    expect(detailLines(entry, "result")).toEqual([
      "      ~ x — default a → b — skipped (safe mode)",
    ]);
  });
});

describe("syncIndexesWithDiff — reported changes and dry run", () => {
  let fx: Record<string, any>;
  class Probe extends MockAdapter {
    run(opts: any) {
      return this.syncIndexesWithDiff(opts);
    }
  }

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/test-table.as");
  });

  function probe() {
    const adapter = new Probe();
    new DbSpace(() => adapter).getTable(fx.UsersTable).getMetadata();
    const keys = [...adapter["_table"].indexes.values()].map((i: { key: string }) => i.key);
    return { adapter, keys };
  }

  it("reports add / rebuild / drop, and issues no DDL in a dry run", async () => {
    const { adapter, keys } = probe();
    const unique = keys.find((k) => k.includes("email_idx"))!;
    const ddl: string[] = [];
    const opts = (dryRun: boolean) => ({
      dryRun,
      listExisting: async () => [
        { name: unique, columns: ["wrong"] },
        { name: "atscript__plain__stale", columns: ["x"] },
        { name: "not_managed", columns: ["y"] },
      ],
      createIndex: async (index: { key: string }) => void ddl.push(`create ${index.key}`),
      dropIndex: async (name: string) => void ddl.push(`drop ${name}`),
      shouldSkipType: (type: string) => type === "fulltext",
    });
    const planned = await adapter.run(opts(true));
    expect(ddl).toEqual([]);
    const applied = await adapter.run(opts(false));
    expect(applied).toEqual(planned);
    expect(planned).toContainEqual({ name: unique, action: "rebuild" });
    expect(planned).toContainEqual({ name: "atscript__plain__stale", action: "drop" });
    expect(planned.filter((c: { action: string }) => c.action === "add").length).toBeGreaterThan(0);
    expect(planned.map((c: { name: string }) => c.name)).not.toContain("not_managed");
  });

  it("an index the adapter skips (skipIndex) or manages itself (isUnmanaged) is no work", async () => {
    const { adapter, keys } = probe();
    const changes = await adapter.run({
      dryRun: true,
      listExisting: async () => [
        ...keys.map((name) => ({ name })),
        { name: "atscript__vec_embedding" },
      ],
      createIndex: async () => {},
      dropIndex: async () => {},
      skipIndex: (index: { key: string }) => (index.key.includes("name_idx") ? "skip" : undefined),
      isUnmanaged: (name: string) => name.startsWith("atscript__vec_"),
    });
    // name_idx is live but skipped → not desired → dropped; nothing else changes
    expect(changes).toEqual([{ name: keys.find((k) => k.includes("name_idx")), action: "drop" }]);
  });
});

describe("mergeLiveForeignKeyChanges", () => {
  it("adds only the live changes the snapshot diff did not name", () => {
    const init: TSyncEntryInit = {
      name: "t",
      status: "alter",
      fkChanged: [{ fields: ["a"], targetTable: "x", details: "onDelete" }],
    };
    expect(
      mergeLiveForeignKeyChanges(init, [
        { fields: ["a"], targetTable: "x", action: "add" },
        { fields: ["c", "b"], targetTable: "y", action: "add" },
        { fields: ["d"], targetTable: "", action: "drop" },
      ]),
    ).toBe(true);
    expect(init.fkAdded).toEqual([{ fields: ["c", "b"], targetTable: "y" }]);
    expect(init.fkRemoved).toEqual([{ fields: ["d"], targetTable: "" }]);
    expect(
      mergeLiveForeignKeyChanges(init, [{ fields: ["b", "c"], targetTable: "y", action: "add" }]),
    ).toBe(false);
    expect(mergeLiveForeignKeyChanges(init, undefined)).toBe(false);
  });
});
