import { describe, it, expect, vi } from "vite-plus/test";

import { augmentRowsWithActions } from "../actions/list-augmenter";
import {
  alignRowsToIds,
  findRowsByIds,
  omitKeys,
  projectRow,
  splitPaths,
} from "../actions/rows-by-id";

/** The one `findMany` call of {@link findRowsByIds}, answering `rows`. */
function source(rows: Record<string, unknown>[] = []) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { source: { findMany }, filterOf: () => findMany.mock.calls[0]![0].filter };
}

describe("findRowsByIds — the id filter", () => {
  it("single-field ids of one shape: one $in over the deduped values", async () => {
    const { source: s, filterOf } = source([{ id: 2 }, { id: 1 }]);
    const out = await findRowsByIds(s, [{ id: 1 }, { id: 2 }, { id: 1 }, { id: 3 }], undefined, []);
    expect(filterOf()).toEqual({ id: { $in: [1, 2, 3] } });
    expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 1 }, undefined]);
  });

  it("one id: a plain equality, ANDed with the scope", async () => {
    const { source: s, filterOf } = source();
    await findRowsByIds(s, [{ code: "a" }], { open: true }, ["name"]);
    expect(filterOf()).toEqual({ $and: [{ code: "a" }, { open: true }] });
  });

  it("composite, mixed-shape, null or object ids keep the $or of ids", async () => {
    const cases: Record<string, unknown>[][] = [
      [
        { a: 1, b: 2 },
        { b: 3, a: 4 },
      ],
      [{ id: 1 }, { code: "x" }],
      [{ id: 1 }, { id: null }],
      [{ id: 1 }, { id: new Date(0) }],
      [{ id: 1 }, { id: Number.NaN }],
    ];
    for (const ids of cases) {
      const { source: s, filterOf } = source();
      await findRowsByIds(s, ids, undefined, []);
      expect((filterOf() as { $or: unknown[] }).$or).toHaveLength(ids.length);
    }
  });

  it("selects the requested fields then every id field; aligns mixed shapes", async () => {
    const rows = [
      { a: 4, b: 3, name: "x" },
      { id: 7, name: "y" },
    ];
    const { source: s } = source(rows);
    const ids = [{ id: 7 }, { b: 3, a: 4 }, { a: 1, b: 1 }];
    const out = await findRowsByIds(s, ids, undefined, ["name"]);
    expect(s.findMany.mock.calls[0]![0].controls.$select).toEqual(["name", "id", "a", "b"]);
    expect(out).toEqual([rows[1], rows[0], undefined]);
    expect(alignRowsToIds(rows, ids)).toEqual(out);
  });
});

describe("row rebuild helpers", () => {
  it("omitKeys returns the row itself when it has none of the keys, else a copy in key order", () => {
    const row = { a: 1, b: 2, c: 3 };
    expect(omitKeys(row, new Set(["x"]))).toBe(row);
    const out = omitKeys(row, new Set(["b"]));
    expect(out).not.toBe(row);
    expect(Object.keys(out)).toEqual(["a", "c"]);
    expect(row).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("projectRow over pre-split paths equals the string form", () => {
    const row = { id: 1, owner: { name: "n", email: "e" }, x: 2 };
    const fields = ["id", "owner.name", "missing.path"];
    expect(projectRow(row, splitPaths(fields))).toEqual(projectRow(row, fields));
    expect(projectRow(row, fields)).toEqual({ id: 1, owner: { name: "n" } });
  });

  it("$actions augmentation replaces rows that lose an action-only column (array kept)", () => {
    const envelope = {
      info: { name: "approve", level: "row" },
      raw: {
        requiredFields: ["state"],
        disabled: (rs: Array<{ state: string }>) => rs.map((r) => r.state !== "open"),
      },
    } as never;
    const rows = [
      { id: 1, state: "open" },
      { id: 2, state: "done" },
    ];
    const first = rows[0];
    const out = augmentRowsWithActions({ envelopes: [envelope], rows, resolvedProjection: ["id"] });
    expect(out).toBe(rows);
    expect(rows[0]).not.toBe(first);
    expect(rows).toEqual([
      { id: 1, $actions: ["approve"] },
      { id: 2, $actions: [] },
    ]);
  });

  it("a non-plain row keeps its prototype (the column is deleted in place)", () => {
    class Row {
      constructor(
        public id: number,
        public state: string,
      ) {}
      get label() {
        return `#${this.id}`;
      }
    }
    const envelope = {
      info: { name: "approve", level: "row" },
      raw: { requiredFields: ["state"], disabled: (rs: Row[]) => rs.map(() => false) },
    } as never;
    const rows: Record<string, unknown>[] = [new Row(1, "open") as never];
    const first = rows[0];
    augmentRowsWithActions({ envelopes: [envelope], rows, resolvedProjection: ["id"] });
    expect(rows[0]).toBe(first);
    expect(rows[0]).toBeInstanceOf(Row);
    expect((rows[0] as unknown as Row).label).toBe("#1");
    expect("state" in rows[0]!).toBe(false);
  });
});
