import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { ALL_AGGREGATE_FNS, DbError, DbSpace } from "../index";
import type { AggregateFn } from "../index";
import dbPlugin from "../plugin";
import type { DbQuery } from "../types";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

/**
 * NULL placement in sorts (since 0.1.153): the core resolves `$nulls` and the
 * fields' `@db.sort.nulls` defaults into the PHYSICAL `controls.$nulls` the
 * adapter receives — only for `$sort` keys that can be NULL — and refuses an
 * explicit request on an adapter without `supportsNullsPlacement()`.
 */

let fx: typeof import("./fixtures/sort-nulls.as");

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/sort-nulls.as");
});

class NullsAdapter extends MockAdapter {
  override supportsNullsPlacement(): boolean {
    return true;
  }
  override aggregateFns(): ReadonlySet<AggregateFn> {
    return ALL_AGGREGATE_FNS;
  }
}

class NestedNullsAdapter extends NestedMockAdapter {
  override supportsNullsPlacement(): boolean {
    return true;
  }
}

function setup(kind: "nulls" | "nested" | "plain" = "nulls") {
  let last: MockAdapter | undefined;
  const space = new DbSpace(
    () =>
      (last =
        kind === "nulls"
          ? new NullsAdapter()
          : kind === "nested"
            ? new NestedNullsAdapter()
            : new MockAdapter()),
  );
  return { space, adapter: () => last! };
}

/** The controls the adapter received on its last call of `method`. */
function sent(adapter: MockAdapter, method = "findMany"): DbQuery["controls"] {
  const call = adapter.calls.findLast((c) => c.method === method);
  return (call!.args[0] as DbQuery).controls;
}

async function read(controls: Record<string, unknown>, kind: "nulls" | "nested" = "nulls") {
  const { space, adapter } = setup(kind);
  await space.getTable(fx.SnItem).findMany({ filter: {}, controls } as any);
  return sent(adapter());
}

describe("$nulls on plain reads", () => {
  it("forwards an explicit placement for a nullable $sort key", async () => {
    const controls = await read({ $sort: { amount: -1 }, $nulls: { amount: "last" } });
    expect(controls.$nulls).toEqual({ amount: "last" });
    // the PK tie-breaker is appended after, with no placement
    expect(controls.$sort).toEqual({ amount: -1, id: -1 });
  });

  it("drops entries for fields that cannot be NULL (plain ORDER BY keeps its index)", async () => {
    const controls = await read({
      $sort: { name: 1, id: 1 },
      $nulls: { name: "last", id: "first" },
    });
    expect(controls.$nulls).toBeUndefined();
    expect("$nulls" in controls).toBe(false);
  });

  it("ignores entries for keys that are not ordered by", async () => {
    const controls = await read({ $sort: { name: 1 }, $nulls: { amount: "first" } });
    expect(controls.$nulls).toBeUndefined();
  });

  it("applies the @db.sort.nulls default when the request names none", async () => {
    expect((await read({ $sort: { closedAt: 1 } })).$nulls).toEqual({ closedAt: "last" });
    // an explicit entry overrides it
    expect((await read({ $sort: { closedAt: 1 }, $nulls: { closedAt: "first" } })).$nulls).toEqual({
      closedAt: "first",
    });
  });

  it("translates keys to physical names, like $sort", async () => {
    const controls = await read({ $sort: { renamed: -1, amount: 1 }, $nulls: { amount: "first" } });
    expect(controls.$sort).toEqual({ renamed_col: -1, amount: 1, id: 1 });
    expect(controls.$nulls).toEqual({ renamed_col: "first", amount: "first" });
  });

  it("treats a required leaf under an optional parent as nullable, and the reverse as not", async () => {
    expect(
      (await read({ $sort: { "info.tag": 1 }, $nulls: { "info.tag": "last" } })).$nulls,
    ).toEqual({ info__tag: "last" });
    expect(
      (await read({ $sort: { "extra.code": 1 }, $nulls: { "extra.code": "last" } })).$nulls,
    ).toBeUndefined();
    expect(
      (await read({ $sort: { "extra.note": 1 }, $nulls: { "extra.note": "last" } })).$nulls,
    ).toEqual({ extra__note: "last" });
  });

  it("keeps dot paths on a nested-object adapter", async () => {
    const controls = await read(
      { $sort: { "info.tag": 1 }, $nulls: { "info.tag": "first" } },
      "nested",
    );
    expect(controls.$nulls).toEqual({ "info.tag": "first" });
  });

  it("applies to findOne and findManyWithCount", async () => {
    const { space, adapter } = setup();
    const table = space.getTable(fx.SnItem);
    const q = { filter: {}, controls: { $sort: { amount: 1 }, $nulls: { amount: "last" } } } as any;
    await table.findOne(q);
    expect(sent(adapter(), "findOne").$nulls).toEqual({ amount: "last" });
    // the base adapter's findManyWithCount reads through findMany
    await table.findManyWithCount(q);
    expect(sent(adapter()).$nulls).toEqual({ amount: "last" });
  });

  it("never drops entries on a view (a view column can be NULL through a join)", async () => {
    const { space, adapter } = setup();
    await space.getView(fx.SnItemView).findMany({
      filter: {},
      controls: { $sort: { name: 1 }, $nulls: { name: "last" } },
    } as any);
    expect(sent(adapter()).$nulls).toEqual({ name: "last" });
  });

  it("rejects a malformed $nulls", async () => {
    await expect(read({ $sort: { amount: 1 }, $nulls: { amount: "middle" } })).rejects.toThrow(
      DbError,
    );
    await expect(read({ $sort: { amount: 1 }, $nulls: ["amount"] })).rejects.toThrow(
      /\$nulls must be an object/,
    );
  });

  it("gates $nulls keys like $sort keys (unknown field)", async () => {
    await expect(read({ $sort: { amount: 1 }, $nulls: { bogus: "last" } })).rejects.toThrow(
      DbError,
    );
  });
});

describe("$nulls on an adapter without support", () => {
  it("refuses an explicit placement with INVALID_QUERY", async () => {
    const { space } = setup("plain");
    const err = await space
      .getTable(fx.SnItem)
      .findMany({
        filter: {},
        controls: { $sort: { amount: 1 }, $nulls: { amount: "last" } },
      } as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("INVALID_QUERY");
    expect((err as DbError).errors[0]!.path).toBe("$nulls");
  });

  it("drops @db.sort.nulls defaults and an entry on a non-nullable field", async () => {
    const { space, adapter } = setup("plain");
    const table = space.getTable(fx.SnItem);
    await table.findMany({ filter: {}, controls: { $sort: { closedAt: 1 } } } as any);
    expect(sent(adapter()).$nulls).toBeUndefined();
    await table.findMany({
      filter: {},
      controls: { $sort: { name: 1 }, $nulls: { name: "first" } },
    } as any);
    expect(sent(adapter()).$nulls).toBeUndefined();
  });

  it("reports the capability", () => {
    const { space } = setup("plain");
    expect(space.getTable(fx.SnItem).supportsNullsPlacement()).toBe(false);
    expect(setup().space.getTable(fx.SnItem).supportsNullsPlacement()).toBe(true);
  });
});

describe("$nulls on grouped reads", () => {
  it("forwards entries for group keys and computed aliases", async () => {
    const { space, adapter } = setup();
    await space.getTable(fx.SnItem).aggregate({
      filter: {},
      controls: {
        $groupBy: ["renamed", "name"],
        $select: ["renamed", "name", { $fn: "sum", $field: "amount", $as: "total" }],
        $sort: { total: -1, renamed: 1, name: 1 },
        $nulls: { total: "last", name: "first" },
      },
    } as any);
    const controls = sent(adapter(), "aggregate");
    // alias: explicit only; renamed: @db.sort.nulls default; name: required → dropped
    expect(controls.$nulls).toEqual({ total: "last", renamed_col: "first" });
  });

  it("puts the $rowOrder placement on the representative-row keys", async () => {
    const { space, adapter } = setup();
    await space.getTable(fx.SnItem).aggregate({
      filter: {},
      controls: {
        $groupBy: ["name"],
        $select: ["name", { $fn: "first", $field: "amount", $as: "firstAmount" }],
        $rowOrder: { amount: -1, closedAt: 1, name: 1 },
        $nulls: { amount: "last", name: "first" },
      },
    } as any);
    const rowOrder = sent(adapter(), "aggregate").$select!.rowOrder;
    expect(rowOrder).toEqual([
      { column: "amount", desc: true, nulls: "last" },
      { column: "closedAt", desc: false, nulls: "last" },
      { column: "name", desc: false },
      { column: "id", desc: false },
    ]);
  });
});

async function diagnostics(source: string) {
  const rootDir = mkdtempSync(join(tmpdir(), "sort-nulls-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()]
    .flat()
    .map((m) => ({ message: m.message, severity: m.severity as number }));
}
const table = (field: string) => `
@db.table 'sn_t'
export interface SnT {
    @meta.id
    id: number
${field}
}
`;

describe("@db.sort.nulls annotation", () => {
  it("is part of the db plugin with completion values and a description", () => {
    const spec = (dbPlugin().config as any)({}).annotations.db.sort.nulls;
    expect(spec.config.argument.values).toEqual(["first", "last"]);
    expect(spec.config.description).toContain("NULL placement");
  });

  it("accepts an optional scalar field", async () => {
    expect(await diagnostics(table("    @db.sort.nulls 'last'\n    closedAt?: number"))).toEqual(
      [],
    );
  });

  it("warns on a required table field", async () => {
    const d = await diagnostics(table("    @db.sort.nulls 'first'\n    name: string"));
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe(2);
    expect(d[0]!.message).toMatch(/required field has no effect/);
  });

  it("rejects an object, an array and a @db.json field", async () => {
    for (const field of [
      "    @db.sort.nulls 'first'\n    tags?: string[]",
      "    @db.sort.nulls 'first'\n    info?: { a: string }",
      "    @db.json\n    @db.sort.nulls 'first'\n    blob?: { a: string }",
    ]) {
      const d = await diagnostics(table(field));
      expect(d.some((m) => m.severity === 1 && /sort/.test(m.message))).toBe(true);
    }
  });

  it("rejects a value other than first / last", async () => {
    const d = await diagnostics(table("    @db.sort.nulls 'middle'\n    closedAt?: number"));
    expect(d.some((m) => m.severity === 1)).toBe(true);
  });
});
