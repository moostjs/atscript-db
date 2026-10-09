import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { NULLS_FLAG_PREFIX } from "../mongo-sort";
import { prepareFixtures } from "./test-utils";

// NULL placement in sort (`$nulls`, since 0.1.153) against a real MongoDB:
// null and missing values go first / last whatever the direction, through
// find, findOne, findManyWithCount (plain and `$facet`), classic `$text`
// search, native `$with` loading and grouped `aggregate()` (`$sort` and the
// `first()` / `last()` row order). The flags never reach a row.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

const t = (type: unknown): any => space.getTable(type as never);
const rows = () => t(fx.NsRow);

type TRow = {
  id: number;
  grp: string;
  amount?: number | null;
  closedAt?: number | null;
  name: string;
  info?: { score?: number | null } | null;
};

// Each optional field: values, an explicit null and a missing key.
const ROWS: TRow[] = [
  { id: 1, grp: "a", amount: 10, closedAt: 5, name: "row 1", info: { score: 3 } },
  { id: 2, grp: "a", amount: null, closedAt: null, name: "row 2", info: null },
  { id: 3, grp: "b", name: "row 3" },
  { id: 4, grp: "b", amount: 30, closedAt: 1, name: "row 4", info: { score: 1 } },
  { id: 5, grp: "a", amount: 20, name: "row 5", info: {} },
  { id: 6, grp: "b", amount: null, closedAt: 3, name: "row 6", info: { score: null } },
  { id: 7, grp: "a", closedAt: 2, name: "row 7", info: { score: 2 } },
  { id: 8, grp: "b", amount: 10, closedAt: 7, name: "row 8", info: { score: 3 } },
];

type TKey = [path: string, dir: 1 | -1, nulls?: "first" | "last"];

const valueAt = (row: Record<string, unknown>, path: string): unknown => {
  let cur: unknown = row;
  for (const seg of path.split(".")) {
    cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
  }
  return cur ?? null;
};

/**
 * Reference order: per key, a placed NULL before / after every value, else
 * BSON order (NULL the smallest); the primary key last in the direction of
 * the last key (the core's tie-breaker).
 */
function expected(keys: TKey[], from: TRow[] = ROWS): number[] {
  const all: TKey[] = [...keys, ["id", keys[keys.length - 1]![1]]];
  return from
    .toSorted((x, y) => {
      for (const [path, dir, nulls] of all) {
        const a = valueAt(x, path) as number | string | null;
        const b = valueAt(y, path) as number | string | null;
        if (a === b) continue;
        if (a === null || b === null) {
          const aFirst = nulls ? nulls === "first" : dir === 1;
          return (a === null) === aFirst ? -1 : 1;
        }
        return (a < b ? -1 : 1) * dir;
      }
      return 0;
    })
    .map((r) => r.id);
}

const toControls = (keys: TKey[]) => {
  const $sort: Record<string, 1 | -1> = {};
  const $nulls: Record<string, "first" | "last"> = {};
  for (const [path, dir, nulls] of keys) {
    $sort[path] = dir;
    if (nulls) $nulls[path] = nulls;
  }
  return Object.keys($nulls).length > 0 ? { $sort, $nulls } : { $sort };
};

const ids = (list: Array<{ id: number }>) => list.map((r) => r.id);
const asc = (a: number, b: number) => a - b;

const noFlags = (list: Array<Record<string, unknown>>) => {
  for (const row of list) {
    expect(Object.keys(row).filter((k) => k.startsWith(NULLS_FLAG_PREFIX))).toEqual([]);
  }
};

describe("MongoDB: NULL placement in sort ($nulls)", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/sort-nulls.as");
    const { MongoMemoryServer } = await import("mongodb-memory-server-core");
    const { MongoClient: MC } = await import("mongodb");
    server = await MongoMemoryServer.create();
    client = new MC(server.getUri());
    await client.connect();
    db = client.db("nulls_sort");
    space = new DbSpace(() => new MongoAdapter(db, client));
    const synced = await new SchemaSync(space).run([fx.NsRow, fx.NsItem], { force: true });
    expect(synced.status).toBe("synced");
    await rows().insertMany(ROWS);
    await t(fx.NsItem).insertMany([
      { id: 1, rowId: 1, rank: 2 },
      { id: 2, rowId: 1, rank: null },
      { id: 3, rowId: 1 },
      { id: 4, rowId: 1, rank: 1 },
      { id: 5, rowId: 2, rank: null },
      { id: 6, rowId: 2, rank: 5 },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the adapter advertises NULL placement", () => {
    expect(rows().getAdapter().supportsNullsPlacement()).toBe(true);
  });

  it("the seed stores explicit nulls and missing keys (renamed column `amt`)", async () => {
    const raw = await db.collection("ns_rows").find({}).toArray();
    const byId = new Map(raw.map((d) => [d.id as number, d]));
    expect(byId.get(2)!.amt).toBeNull();
    expect("amt" in byId.get(3)!).toBe(false);
  });

  describe("findMany", () => {
    const find = async (controls: Record<string, unknown>) => {
      const list = await rows().findMany({ filter: {}, controls } as never);
      noFlags(list);
      return ids(list);
    };

    for (const field of ["amount", "info.score"]) {
      for (const dir of [1, -1] as const) {
        for (const nulls of ["first", "last"] as const) {
          it(`${field} ${dir === 1 ? "asc" : "desc"} nulls ${nulls}`, async () => {
            const keys: TKey[] = [[field, dir, nulls]];
            const got = await find(toControls(keys));
            expect(got).toEqual(expected(keys));
            // null and missing are one block, at the requested end
            const nullIds = ROWS.filter((r) => valueAt(r, field) === null).map((r) => r.id);
            const block =
              nulls === "first" ? got.slice(0, nullIds.length) : got.slice(-nullIds.length);
            expect(block.toSorted(asc)).toEqual(nullIds.toSorted(asc));
          });
        }
      }
    }

    it("without $nulls the native order is unchanged (null / missing smallest)", async () => {
      expect(await find({ $sort: { amount: 1 } })).toEqual(expected([["amount", 1]]));
      expect(await find({ $sort: { amount: -1 } })).toEqual(expected([["amount", -1]]));
    });

    it("multi-key mixed: placed and unplaced keys, both directions", async () => {
      const cases: TKey[][] = [
        [
          ["grp", 1],
          ["amount", -1, "first"],
        ],
        [
          ["amount", 1, "last"],
          ["closedAt", -1, "first"],
        ],
        [
          ["info.score", -1, "last"],
          ["amount", 1],
          ["closedAt", 1, "first"],
        ],
      ];
      for (const keys of cases) {
        expect(await find(toControls(keys))).toEqual(expected(keys));
      }
    });

    it("@db.sort.nulls 'last' applies when the request names none; $nulls overrides it", async () => {
      expect(await find({ $sort: { closedAt: 1 } })).toEqual(expected([["closedAt", 1, "last"]]));
      expect(await find({ $sort: { closedAt: -1 } })).toEqual(expected([["closedAt", -1, "last"]]));
      expect(await find({ $sort: { closedAt: 1 }, $nulls: { closedAt: "first" } })).toEqual(
        expected([["closedAt", 1, "first"]]),
      );
    });

    it("$skip / $limit page across the null boundary", async () => {
      const keys: TKey[] = [["amount", 1, "first"]];
      const all = expected(keys);
      const pages: number[] = [];
      for (let skip = 0; skip < ROWS.length; skip += 3) {
        pages.push(...(await find({ ...toControls(keys), $skip: skip, $limit: 3 })));
      }
      expect(pages).toEqual(all);
      expect(await find({ ...toControls([["amount", -1, "last"]]), $skip: 3, $limit: 3 })).toEqual(
        expected([["amount", -1, "last"]]).slice(3, 6),
      );
    });

    it("$select (inclusion and exclusion) keeps the row shape of the plain read", async () => {
      // Same rows as the unplaced find (keys and values), only the order differs.
      const shape = async (keys: TKey[], $select: unknown) => {
        const read = (controls: Record<string, unknown>) =>
          rows().findMany({ filter: {}, controls: { ...controls, $select } } as never) as Promise<
            Array<Record<string, unknown>>
          >;
        const placed = await read(toControls(keys));
        const plain = await read({ $sort: { id: 1 } });
        expect(ids(placed as never)).toEqual(expected(keys));
        noFlags(placed);
        const byId = new Map(plain.map((r) => [r.id, r]));
        for (const row of placed) expect(row).toEqual(byId.get(row.id));
        return placed;
      };
      const inc = await shape([["amount", 1, "last"]], ["id", "amount"]);
      for (const row of inc) expect("grp" in row).toBe(false);
      const exc = await shape([["amount", -1, "first"]], { name: 0, info: 0 });
      for (const row of exc) {
        expect("name" in row).toBe(false);
        expect("grp" in row).toBe(true);
      }
    });

    it("the adapter's raw rows carry no flag (physical keys)", async () => {
      const adapter = rows().getAdapter() as MongoAdapter;
      const raw = await adapter.findMany({
        filter: {},
        controls: { $sort: { amt: 1, id: 1 }, $nulls: { amt: "last" } },
      } as never);
      expect(raw.map((r) => r.id)).toEqual(expected([["amount", 1, "last"]]));
      noFlags(raw);
    });

    it("a filter composes with the placed order", async () => {
      const list = await rows().findMany({
        filter: { grp: "a" },
        controls: toControls([["amount", -1, "first"]]),
      } as never);
      expect(ids(list)).toEqual(
        expected(
          [["amount", -1, "first"]],
          ROWS.filter((r) => r.grp === "a"),
        ),
      );
    });
  });

  describe("the plain find path stays when nothing is placed", () => {
    const spies = () => {
      const collection = (rows().getAdapter() as MongoAdapter).collection;
      return {
        find: vi.spyOn(collection, "find"),
        findOne: vi.spyOn(collection, "findOne"),
        aggregate: vi.spyOn(collection, "aggregate"),
      };
    };

    it("an entry on a required field is dropped → find().sort()", async () => {
      const s = spies();
      const list = await rows().findMany({
        filter: {},
        controls: { $sort: { name: -1 }, $nulls: { name: "first" } },
      } as never);
      expect(ids(list)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      expect(s.find).toHaveBeenCalledTimes(1);
      expect(s.aggregate).not.toHaveBeenCalled();
    });

    it("an entry on a key that is not sorted by is ignored → find().sort()", async () => {
      const s = spies();
      await rows().findMany({
        filter: {},
        controls: { $sort: { grp: 1 }, $nulls: { amount: "last" } },
      } as never);
      expect(s.find).toHaveBeenCalledTimes(1);
      expect(s.aggregate).not.toHaveBeenCalled();
    });

    it("a placed key runs as a pipeline with allowDiskUse", async () => {
      const s = spies();
      await rows().findMany({
        filter: {},
        controls: { $sort: { amount: 1 }, $nulls: { amount: "last" } },
      } as never);
      expect(s.find).not.toHaveBeenCalled();
      expect(s.aggregate).toHaveBeenCalledTimes(1);
      const [pipeline, opts] = s.aggregate.mock.calls[0]!;
      expect((pipeline as object[]).map((st) => Object.keys(st)[0])).toEqual([
        "$match",
        "$addFields",
        "$sort",
        "$project",
      ]);
      expect((pipeline as any[])[2].$sort).toEqual({ [`${NULLS_FLAG_PREFIX}0`]: 1, amt: 1, id: 1 });
      expect(opts).toMatchObject({ allowDiskUse: true });
    });

    it("findOne: placed → first row of the placed order; unplaced → collection.findOne", async () => {
      const s = spies();
      const first = await rows().findOne({
        filter: {},
        controls: { $sort: { amount: -1 }, $nulls: { amount: "first" } },
      } as never);
      expect(first.id).toBe(expected([["amount", -1, "first"]])[0]);
      noFlags([first]);
      expect(s.aggregate).toHaveBeenCalledTimes(1);
      const plain = await rows().findOne({
        filter: {},
        controls: { $sort: { amount: -1 } },
      } as never);
      expect(plain.id).toBe(expected([["amount", -1]])[0]);
      expect(s.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe("findManyWithCount", () => {
    it("plain filter: placed page + total", async () => {
      const keys: TKey[] = [["amount", 1, "first"]];
      const { data, count } = await rows().findManyWithCount({
        filter: {},
        controls: { ...toControls(keys), $skip: 2, $limit: 4 },
      } as never);
      expect(count).toBe(ROWS.length);
      expect(ids(data)).toEqual(expected(keys).slice(2, 6));
      noFlags(data);
    });

    it("relational filter ($facet path): placed page + total", async () => {
      const keys: TKey[] = [["closedAt", -1, "first"]];
      const withItems = ROWS.filter((r) => r.id === 1 || r.id === 2);
      const { data, count } = await rows().findManyWithCount({
        filter: { items: { $some: { id: { $gte: 1 } } } },
        controls: { ...toControls(keys), $limit: 5 },
      } as never);
      expect(count).toBe(2);
      expect(ids(data)).toEqual(expected(keys, withItems));
      noFlags(data);
    });
  });

  describe("classic $text search with an explicit $sort", () => {
    it("search honours $nulls (and the @db.sort.nulls default)", async () => {
      const keys: TKey[] = [["amount", -1, "last"]];
      const list = await rows().search("row", { filter: {}, controls: toControls(keys) } as never);
      expect(ids(list)).toEqual(expected(keys));
      noFlags(list);
      const byDefault = await rows().search("row", {
        filter: {},
        controls: { $sort: { closedAt: 1 } },
      } as never);
      expect(ids(byDefault)).toEqual(expected([["closedAt", 1, "last"]]));
    });

    it("searchWithCount honours $nulls inside the $facet", async () => {
      const keys: TKey[] = [["info.score", 1, "last"]];
      const { data, count } = await rows().searchWithCount("row", {
        filter: {},
        controls: { ...toControls(keys), $skip: 1, $limit: 5 },
      } as never);
      expect(count).toBe(ROWS.length);
      expect(ids(data)).toEqual(expected(keys).slice(1, 6));
      noFlags(data);
    });
  });

  describe("$with relation loading", () => {
    const itemIds = async (controls: Record<string, unknown>) => {
      const [row] = await rows().findMany({
        filter: { id: 1 },
        controls: { $with: [{ name: "items", controls }] },
      } as never);
      noFlags(row.items);
      return ids(row.items);
    };

    it("orders the related rows with their $nulls (renamed `item_rank`)", async () => {
      // rank: 4 → 1, 1 → 2, 2 → null, 3 → missing
      expect(await itemIds({ $sort: { rank: 1 }, $nulls: { rank: "last" } })).toEqual([4, 1, 2, 3]);
      expect(await itemIds({ $sort: { rank: -1 }, $nulls: { rank: "first" } })).toEqual([
        3, 2, 1, 4,
      ]);
      expect(await itemIds({ $sort: { rank: 1 } })).toEqual([2, 3, 4, 1]);
    });

    it("$limit cuts after the placed order", async () => {
      expect(
        await itemIds({ $sort: { rank: 1 }, $nulls: { rank: "first" }, $skip: 1, $limit: 2 }),
      ).toEqual([3, 4]);
    });
  });

  describe("grouped aggregate()", () => {
    const agg = (controls: Record<string, unknown>) =>
      rows().aggregate({ filter: {}, controls } as never) as Promise<
        Array<Record<string, unknown>>
      >;

    it("$sort on a group key: null group first / last", async () => {
      const base = {
        $groupBy: ["amount"],
        $select: ["amount", { $fn: "count", $field: "*", $as: "n" }],
      };
      const last = await agg({ ...base, $sort: { amount: 1 }, $nulls: { amount: "last" } });
      expect(last.map((r) => r.amount)).toEqual([10, 20, 30, null]);
      expect(last[3]!.n).toBe(4);
      noFlags(last);
      const first = await agg({ ...base, $sort: { amount: -1 }, $nulls: { amount: "first" } });
      expect(first.map((r) => r.amount)).toEqual([null, 30, 20, 10]);
      const native = await agg({ ...base, $sort: { amount: -1 } });
      expect(native.map((r) => r.amount)).toEqual([30, 20, 10, null]);
    });

    it("$sort on a computed alias", async () => {
      // max(closedAt) per amount: 10 → 7, null → 3, 30 → 1, 20 → null
      const base = {
        $groupBy: ["amount"],
        $select: ["amount", { $fn: "max", $field: "closedAt", $as: "mx" }],
      };
      const first = await agg({ ...base, $sort: { mx: 1 }, $nulls: { mx: "first" } });
      expect(first.map((r) => r.mx)).toEqual([null, 1, 3, 7]);
      const last = await agg({ ...base, $sort: { mx: 1 }, $nulls: { mx: "last" } });
      expect(last.map((r) => r.mx)).toEqual([1, 3, 7, null]);
      noFlags(last);
    });

    it("first() / last() follow the placed $rowOrder at both ends", async () => {
      const read = async (rowOrder: Record<string, 1 | -1>, nulls?: Record<string, string>) => {
        const out = await agg({
          $groupBy: ["grp"],
          $select: [
            "grp",
            { $fn: "first", $field: "name", $as: "f" },
            { $fn: "last", $field: "name", $as: "l" },
          ],
          $rowOrder: rowOrder,
          ...(nulls ? { $nulls: nulls } : {}),
          $sort: { grp: 1 },
        });
        noFlags(out);
        return out.map((r) => [r.grp, r.f, r.l]);
      };
      // a: 1 (10), 2 (null), 5 (20), 7 (missing); b: 3 (missing), 4 (30), 6 (null), 8 (10); PK asc last
      expect(await read({ amount: 1 }, { amount: "last" })).toEqual([
        ["a", "row 1", "row 7"],
        ["b", "row 8", "row 6"],
      ]);
      expect(await read({ amount: -1 }, { amount: "first" })).toEqual([
        ["a", "row 2", "row 1"],
        ["b", "row 3", "row 8"],
      ]);
      // native: NULL the smallest
      expect(await read({ amount: -1 })).toEqual([
        ["a", "row 5", "row 7"],
        ["b", "row 4", "row 6"],
      ]);
      // @db.sort.nulls 'last' on closedAt — a: 1 (5), 2 (null), 5 (missing), 7 (2)
      expect((await read({ closedAt: 1 }))[0]).toEqual(["a", "row 7", "row 5"]);
      expect((await read({ closedAt: 1 }, { closedAt: "first" }))[0]).toEqual([
        "a",
        "row 2",
        "row 1",
      ]);
    });
  });
});
