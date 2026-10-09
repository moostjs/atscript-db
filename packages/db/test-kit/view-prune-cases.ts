import { describe, it, expect } from "vite-plus/test";

/**
 * The shared behaviour table of view read pruning (since 0.1.153): every
 * read of a managed view returns exactly what it returns with pruning off —
 * a fixed matrix plus a seeded, randomized differential over findMany /
 * count / findManyWithCount / aggregate. Run by SQLite, MongoDB and the
 * MySQL live suite against the same fixture (`fixtures/view-prune.as`).
 *
 * `pruned` and `plain` are two spaces over ONE database: the first with view
 * join pruning on, the second with it off (the stored view read by name).
 */

type TReadable = {
  findMany(q: unknown): Promise<Array<Record<string, unknown>>>;
  findManyWithCount(q: unknown): Promise<{ data: Array<Record<string, unknown>>; count: number }>;
  count(q?: unknown): Promise<number>;
  aggregate(q: unknown): Promise<Array<Record<string, unknown>>>;
};
type TSpace = { getView(type: unknown): unknown; getTable(type: unknown): unknown };

export interface TViewPruneKit {
  fx: Record<string, any>;
  pruned: TSpace;
  plain: TSpace;
}

/** Deterministic PRNG (mulberry32). */
export function vpRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rows for every table of the fixture: NULL and dangling foreign keys, a
 * duplicated status code (that join multiplies rows), several notes per
 * order (with equal `at`, so the first-row tie-break matters).
 */
export function vpData(orders = 60, seed = 7) {
  const rnd = vpRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const regions = [
    { id: 1, name: "North", taxRate: 10 },
    { id: 2, name: "South", taxRate: 20 },
    { id: 3, name: "East", taxRate: 0 },
    { id: 4, name: "West", taxRate: 25 },
  ];
  const customers = Array.from({ length: 12 }, (_, i) => {
    const regionId = pick([undefined, 1, 2, 3, 4, 5]);
    return {
      id: i + 1,
      name: `c${i + 1}`,
      ...(regionId === undefined ? {} : { regionId }),
    };
  });
  const products: Array<Record<string, unknown>> = [];
  let pid = 1;
  for (const sku of ["a", "b", "c"]) {
    for (const market of ["EU", "US"]) {
      if (sku === "c" && market === "US") continue;
      products.push({ id: pid++, sku, market, title: `${sku}-${market}` });
    }
  }
  const statuses = [
    { id: 1, code: "new", label: "New" },
    { id: 2, code: "paid", label: "Paid" },
    { id: 3, code: "paid", label: "Settled" },
    { id: 4, code: "done", label: "Done" },
  ];
  const orderRows = Array.from({ length: orders }, (_, i) => {
    const row: Record<string, unknown> = {
      id: i + 1,
      status: pick(["new", "paid", "done", "void"]),
      // Integers (and integer tax rates): sums are exact whatever the row order
      amount: Math.floor(rnd() * 1000),
    };
    const customerId = pick([undefined, 1, 2, 3, 5, 8, 12, 13]);
    if (customerId !== undefined) row.customerId = customerId;
    const sku = pick([undefined, "a", "b", "c", "z"]);
    if (sku !== undefined) {
      row.sku = sku;
      row.market = pick(["EU", "US"]);
    }
    const ship = pick([undefined, 1, 2, 3, 4, 9]);
    if (ship !== undefined) row.shipRegionId = ship;
    return row;
  });
  const notes: Array<Record<string, unknown>> = [];
  let nid = 1;
  for (const order of orderRows) {
    const n = Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      notes.push({
        id: nid++,
        orderId: order.id,
        at: Math.floor(rnd() * 3),
        text: `n${String(order.id)}.${k}`,
      });
    }
  }
  return { regions, customers, products, statuses, notes, orders: orderRows };
}

/** Inserts {@link vpData} through `space`. */
export async function seedViewPrune(
  space: TSpace,
  fx: Record<string, any>,
  data = vpData(),
): Promise<void> {
  const ins = (type: unknown, rows: unknown[]) =>
    (space.getTable(type) as { insertMany(r: unknown[]): Promise<unknown> }).insertMany(rows);
  await ins(fx.VpRegion, data.regions);
  await ins(fx.VpCustomer, data.customers);
  await ins(fx.VpProduct, data.products);
  await ins(fx.VpStatus, data.statuses);
  await ins(fx.VpOrder, data.orders);
  if (data.notes.length) await ins(fx.VpNote, data.notes);
}

const NUMBER_COLS = ["id", "amount", "regionTax", "tax"] as const;
const STRING_COLS = [
  "status",
  "customerName",
  "regionName",
  "productTitle",
  "lastNote",
  "shipRegion",
] as const;
const ALL_COLS = [...NUMBER_COLS, ...STRING_COLS, "statusLabel"];
/** A total order of the view's rows (`id` repeats where the status join multiplies). */
const TIE_BREAK = { id: 1, statusLabel: 1 } as const;

/** Order-insensitive comparison of two row sets. */
function canonical(rows: Array<Record<string, unknown>>): string[] {
  return rows
    .map((r) =>
      JSON.stringify(
        Object.keys(r)
          .toSorted()
          .map((k) => [k, r[k]]),
      ),
    )
    .toSorted();
}

function randomPredicate(rnd: () => number): Record<string, unknown> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  if (rnd() < 0.5) {
    const col = pick(NUMBER_COLS);
    const scale = { id: 60, amount: 1000, regionTax: 30, tax: 20_000 }[col];
    const v = Math.floor(rnd() * scale);
    return { [col]: { [pick(["$gt", "$lte", "$ne", "$gte"])]: v } };
  }
  const col = pick(STRING_COLS);
  switch (pick(["eq", "null", "notnull", "in"])) {
    case "eq":
      return { [col]: pick(["paid", "c1", "North", "a-EU", "n3.0", "South", "new"]) };
    case "null":
      return { [col]: null };
    case "notnull":
      return { [col]: { $ne: null } };
    default:
      return { [col]: { $in: ["paid", "done", "c2", "c3", "East", "b-US", "West"] } };
  }
}

/** One random read of `VpOrderView`: the readable method and its query. */
export function randomRead(rnd: () => number): {
  op: "findMany" | "count" | "findManyWithCount" | "aggregate";
  query: Record<string, unknown>;
} {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const preds = Array.from({ length: Math.floor(rnd() * 3) }, () => randomPredicate(rnd));
  const filter =
    preds.length === 0 ? {} : preds.length === 1 ? preds[0] : { [pick(["$and", "$or"])]: preds };
  const op = pick(["findMany", "findMany", "count", "findManyWithCount", "aggregate"] as const);
  if (op === "count") return { op, query: { filter } };
  if (op === "aggregate") {
    const by = pick(["status", "customerName", "regionName", "productTitle", "shipRegion"]);
    return {
      op,
      query: {
        filter,
        controls: {
          $groupBy: [by],
          $select: [
            by,
            { $fn: "count", $field: "*", $as: "n" },
            { $fn: "sum", $field: pick(["amount", "regionTax", "tax"]), $as: "s" },
          ],
          $sort: { [by]: 1 },
        },
      },
    };
  }
  const controls: Record<string, unknown> = {};
  if (rnd() < 0.8) {
    const n = 1 + Math.floor(rnd() * 4);
    controls.$select = Array.from(new Set(Array.from({ length: n }, () => pick(ALL_COLS))));
  }
  if (rnd() < 0.6) {
    const col = pick(ALL_COLS);
    controls.$sort = { [col]: rnd() < 0.5 ? 1 : -1, ...TIE_BREAK };
    if (rnd() < 0.7) controls.$limit = 1 + Math.floor(rnd() * 10);
    if (rnd() < 0.4) controls.$skip = Math.floor(rnd() * 20);
  }
  return { op, query: { filter, controls } };
}

async function runRead(
  view: TReadable,
  op: string,
  query: Record<string, unknown>,
): Promise<unknown> {
  switch (op) {
    case "count":
      return view.count(query);
    case "findManyWithCount": {
      const { data, count } = await view.findManyWithCount(query);
      const ordered = !!(query.controls as { $sort?: unknown } | undefined)?.$sort;
      return { data: ordered ? data : canonical(data), count };
    }
    case "aggregate":
      return canonical(await view.aggregate(query));
    default: {
      const rows = await view.findMany(query);
      const ordered = !!(query.controls as { $sort?: unknown } | undefined)?.$sort;
      return ordered ? rows : canonical(rows);
    }
  }
}

export function defineViewPruneCases(label: string, kit: () => TViewPruneKit): void {
  const views = (type: string) => {
    const { fx, pruned, plain } = kit();
    return {
      on: pruned.getView(fx[type]) as TReadable,
      off: plain.getView(fx[type]) as TReadable,
    };
  };
  const same = async (type: string, op: string, query: Record<string, unknown>) => {
    const { on, off } = views(type);
    const [a, b] = await Promise.all([runRead(on, op, query), runRead(off, op, query)]);
    expect(a).toEqual(b);
    return a;
  };

  describe(`${label}: view read pruning — results equal the stored view`, () => {
    it("count without a filter", async () => {
      expect(await same("VpOrderView", "count", { filter: {} })).toBeGreaterThan(0);
    });

    it("count filtered on an entry column and on a joined column", async () => {
      await same("VpOrderView", "count", { filter: { amount: { $gt: 200 } } });
      await same("VpOrderView", "count", { filter: { customerName: { $ne: null } } });
      await same("VpOrderView", "count", { filter: { regionName: "North" } });
    });

    it("a page of entry columns", async () => {
      await same("VpOrderView", "findMany", {
        filter: {},
        controls: { $select: ["id", "amount"], $sort: TIE_BREAK, $skip: 5, $limit: 10 },
      });
    });

    it("every column (no $select)", async () => {
      await same("VpOrderView", "findMany", { filter: {}, controls: { $sort: TIE_BREAK } });
    });

    it("a computed column over a chained join", async () => {
      await same("VpOrderView", "findMany", {
        filter: { tax: { $gt: 0 } },
        controls: { $select: ["id", "tax"], $sort: { tax: -1, ...TIE_BREAK } },
      });
    });

    it("the first-row join", async () => {
      await same("VpOrderView", "findMany", {
        filter: {},
        controls: { $select: ["id", "lastNote"], $sort: TIE_BREAK },
      });
    });

    it("the composite-unique join and the aliased join", async () => {
      await same("VpOrderView", "findMany", {
        filter: { productTitle: { $ne: null } },
        controls: { $select: ["id", "productTitle", "shipRegion"], $sort: TIE_BREAK },
      });
    });

    it("page + count", async () => {
      await same("VpOrderView", "findManyWithCount", {
        filter: { amount: { $lte: 600 } },
        controls: { $select: ["id", "customerName"], $sort: TIE_BREAK, $limit: 7 },
      });
    });

    it("aggregates", async () => {
      await same("VpOrderView", "aggregate", {
        filter: {},
        controls: {
          $groupBy: ["status"],
          $select: ["status", { $fn: "count", $field: "*", $as: "n" }],
        },
      });
      await same("VpOrderView", "aggregate", {
        filter: { amount: { $gt: 100 } },
        controls: {
          $groupBy: ["regionName"],
          $select: ["regionName", { $fn: "sum", $field: "tax", $as: "t" }],
          $count: true,
        },
      });
    });

    it("an inner join, a view filter on a left join, a literal-pinned key", async () => {
      for (const query of [
        { filter: {} },
        { filter: {}, controls: { $select: ["id"], $sort: { id: 1 } } },
        { filter: {}, controls: { $select: ["id", "euTitle"], $sort: { id: 1 } } },
      ]) {
        await same("VpEuView", query.controls ? "findMany" : "count", query);
      }
    });

    it("a join pinning part of a unique key", async () => {
      await same("VpPartialView", "count", { filter: {} });
      await same("VpPartialView", "findMany", {
        filter: {},
        controls: { $select: ["id"], $sort: { id: 1 } },
      });
    });

    it("randomized differential (seeded)", async () => {
      const rnd = vpRandom(29);
      for (let i = 0; i < 150; i++) {
        const { op, query } = randomRead(rnd);
        try {
          await same("VpOrderView", op, query);
        } catch (error) {
          throw new Error(`read #${i} ${op} ${JSON.stringify(query)}: ${String(error)}`, {
            cause: error,
          });
        }
      }
    }, 120_000);
  });
}
