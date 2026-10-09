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

/** {@link canonical} for row sets; a scalar result (an aggregate `$count`) as is. */
function canonicalOrValue(result: unknown): unknown {
  return Array.isArray(result) ? canonical(result) : result;
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
      return canonicalOrValue(await view.aggregate(query));
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

// ── Adversarial shapes (`fixtures/view-prune-adv.as`) ──────────────────────

/** Rows for `view-prune-adv.as`: case variants of unique codes, NULL / dangling keys, boss chains. */
export function vaData(seed = 11) {
  const rnd = vpRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const codes = [
    { id: 1, code: "paid", label: "Paid" },
    { id: 2, code: "new", label: "New" },
    { id: 3, code: "Done", label: "Done" },
  ];
  const binCodes = [
    { id: 1, code: "a", label: "lower" },
    { id: 2, code: "A", label: "upper" },
    { id: 3, code: "b", label: "b" },
  ];
  const tiers = [
    { id: 1, kind: "gold", premium: true, title: "Gold+" },
    { id: 2, kind: "gold", premium: false, title: "Gold" },
    { id: 3, kind: "silver", premium: false, title: "Silver" },
    { id: 4, kind: "silver", premium: true, title: "Silver+" },
    { id: 5, kind: "bronze", premium: false, title: "Bronze" },
  ];
  const owners = Array.from({ length: 8 }, (_, i) => {
    const row: Record<string, unknown> = { id: i + 1, name: `o${i + 1}` };
    const tier = pick([undefined, "gold", "silver", "bronze", "tin"]);
    if (tier !== undefined) row.tierKind = tier;
    const boss = pick([undefined, 1, 2, 3, 5, 8, 99]);
    if (boss !== undefined) row.bossId = boss;
    const level = pick([undefined, 1, 2, 3]);
    if (level !== undefined) row.meta = { level };
    return row;
  });
  const events: Array<Record<string, unknown>> = [];
  for (const owner of owners) {
    const n = Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      events.push({
        id: events.length + 1,
        ownerId: owner.id,
        at: Math.floor(rnd() * 3),
        text: `e${String(owner.id)}.${k}`,
      });
    }
  }
  const items = Array.from({ length: 50 }, (_, i) => {
    const row: Record<string, unknown> = { id: i + 1, qty: 1 + Math.floor(rnd() * 9) };
    const code = pick([undefined, "paid", "PAID", "New", "done", "zzz", "a", "A", "b", "B"]);
    if (code !== undefined) row.code = code;
    const owner = pick([undefined, 1, 2, 3, 4, 5, 6, 7, 8, 42]);
    if (owner !== undefined) row.ownerId = owner;
    return row;
  });
  return { codes, binCodes, tiers, owners, events, items };
}

/** Inserts {@link vaData} through `space`. */
export async function seedViewPruneAdv(space: TSpace, fx: Record<string, any>): Promise<void> {
  const data = vaData();
  const ins = (type: unknown, rows: unknown[]) =>
    (space.getTable(type) as { insertMany(r: unknown[]): Promise<unknown> }).insertMany(rows);
  await ins(fx.VaCode, data.codes);
  await ins(fx.VaBinCode, data.binCodes);
  await ins(fx.VaTier, data.tiers);
  await ins(fx.VaOwner, data.owners);
  await ins(fx.VaEvent, data.events);
  await ins(fx.VaItem, data.items);
}

const BY_ID = { id: 1 } as const;

/** Reads of `VaItemView` aimed at the collector: nested logic, `$exists`, field operands, exclusions. */
const ADV_READS: Array<{ op: string; query: Record<string, unknown> }> = [
  { op: "count", query: { filter: {} } },
  { op: "count", query: { filter: { $not: { ownerName: null } } } },
  {
    op: "count",
    query: { filter: { $not: { $or: [{ codeLabel: "Paid" }, { tierTitle: null }] } } },
  },
  { op: "count", query: { filter: { bossName: { $exists: true } } } },
  { op: "count", query: { filter: { $or: [{ qty: { $gt: 5 } }, { lastEvent: null }] } } },
  { op: "count", query: { filter: { ownerLevel: { $gte: 2 } } } },
  {
    op: "count",
    query: { filter: { $and: [{ qty: { $gt: 2 } }, { $not: { weight: { $lt: 6 } } }] } },
  },
  {
    op: "findMany",
    query: { filter: {}, controls: { $select: ["id"], $sort: { bossName: -1, id: 1 } } },
  },
  {
    op: "findMany",
    query: { filter: {}, controls: { $select: ["id", "weight"], $sort: { weight: 1, id: 1 } } },
  },
  { op: "findMany", query: { filter: {}, controls: { $select: { codeLabel: 0 }, $sort: BY_ID } } },
  {
    op: "findMany",
    query: {
      filter: {},
      controls: { $select: { tierTitle: 0, lastEvent: 0, bossName: 0 }, $sort: BY_ID },
    },
  },
  {
    op: "findMany",
    query: {
      filter: { tierTitle: { $in: ["Gold+", "Silver+"] } },
      controls: { $select: ["id", "lastEvent"], $sort: BY_ID },
    },
  },
  {
    op: "findManyWithCount",
    query: {
      filter: {
        $and: [{ qty: { $lte: 7 } }, { $or: [{ ownerName: "o1" }, { codeLabel: { $ne: null } }] }],
      },
      controls: { $select: ["id"], $sort: BY_ID, $limit: 5, $skip: 2 },
    },
  },
  {
    op: "aggregate",
    query: {
      filter: {},
      controls: {
        $groupBy: ["tierTitle"],
        $select: ["tierTitle", { $fn: "sum", $field: "qty", $as: "s" }],
        $having: { s: { $gt: 3 } },
      },
    },
  },
  {
    op: "aggregate",
    query: {
      filter: { codeLabel: { $ne: null } },
      controls: {
        $groupBy: ["ownerLevel"],
        $select: ["ownerLevel", { $fn: "count", $field: "*", $as: "n" }],
      },
    },
  },
  {
    op: "aggregate",
    query: {
      filter: {},
      controls: {
        $groupBy: ["bossName"],
        $select: ["bossName", { $fn: "max", $field: "weight", $as: "w" }],
        $count: true,
      },
    },
  },
];

export function defineViewPruneAdvCases(
  label: string,
  kit: () => TViewPruneKit,
  opts: { binView?: boolean } = {},
): void {
  const same = async (type: string, op: string, query: Record<string, unknown>) => {
    const { fx, pruned, plain } = kit();
    const on = pruned.getView(fx[type]) as TReadable;
    const off = plain.getView(fx[type]) as TReadable;
    const [a, b] = await Promise.all([runRead(on, op, query), runRead(off, op, query)]);
    expect(a, `${type} ${op} ${JSON.stringify(query)}`).toEqual(b);
  };

  describe(`${label}: view read pruning — adversarial shapes`, () => {
    it("collector edge cases over collations, a boolean key pin, alias chains", async () => {
      for (const { op, query } of ADV_READS) await same("VaItemView", op, query);
    });

    it("an inner join reading a left join keeps both", async () => {
      await same("VaInnerChainView", "count", { filter: {} });
      await same("VaInnerChainView", "findMany", {
        filter: {},
        controls: { $select: ["id"], $sort: BY_ID },
      });
    });

    it.runIf(opts.binView !== false)(
      "a binary-unique target under a nocase comparison",
      async () => {
        await same("VaBinView", "count", { filter: {} });
        await same("VaBinView", "findMany", {
          filter: {},
          controls: { $select: ["id"], $sort: BY_ID },
        });
      },
    );
  });
}

// ── Sort interplay (`VpOrderIdView`): tie-breaker + NULL placement ─────────

type TPlacement = "first" | "last";
const ID_VIEW_COLS = ["id", "status", "amount", "customerName", "regionName", "shipRegion"];
const ID_VIEW_NULLABLE = new Set(["customerName", "regionName", "shipRegion"]);

/**
 * Sorted reads of `VpOrderIdView` (a view with `@meta.id` and a
 * `@db.sort.nulls 'last'` default on `shipRegion`): the core appends the
 * `id` tie-breaker and resolves `$nulls` BEFORE the adapter plans the pruned
 * read, so the needed columns include both — pruned and stored reads return
 * the same rows in the same order (a total order: compared as arrays).
 */
export const SORT_READS: Array<{ op: string; query: Record<string, any> }> = [
  // the tie-breaker key is not selected
  {
    op: "findMany",
    query: { filter: {}, controls: { $select: ["amount"], $sort: { amount: 1 } } },
  },
  {
    op: "findMany",
    query: {
      filter: {},
      controls: { $select: ["id", "amount"], $sort: { amount: -1 }, $skip: 3, $limit: 15 },
    },
  },
  // the `@db.sort.nulls` default on a joined, unselected sort key
  {
    op: "findMany",
    query: { filter: {}, controls: { $select: ["id"], $sort: { shipRegion: 1 } } },
  },
  {
    op: "findMany",
    query: {
      filter: {},
      controls: {
        $select: ["id", "customerName"],
        $sort: { customerName: -1 },
        $nulls: { customerName: "first" },
        $limit: 12,
      },
    },
  },
  // a chained join (region through customer) only as a placed sort key
  {
    op: "findMany",
    query: {
      filter: { amount: { $gt: 100 } },
      controls: {
        $select: ["id"],
        $sort: { regionName: 1, amount: -1 },
        $nulls: { regionName: "last" },
        $skip: 5,
        $limit: 20,
      },
    },
  },
  {
    op: "findOne",
    query: {
      filter: {},
      controls: { $select: ["id"], $sort: { shipRegion: -1 }, $nulls: { shipRegion: "first" } },
    },
  },
  {
    op: "findManyWithCount",
    query: {
      filter: { amount: { $gt: 100 } },
      controls: {
        $select: ["id", "status"],
        $sort: { shipRegion: -1 },
        $nulls: { shipRegion: "first" },
        $limit: 7,
      },
    },
  },
  {
    op: "aggregate",
    query: {
      filter: {},
      controls: {
        $groupBy: ["regionName"],
        $select: ["regionName", { $fn: "count", $field: "*", $as: "n" }],
        $sort: { regionName: 1 },
        $nulls: { regionName: "last" },
      },
    },
  },
  {
    op: "aggregate",
    query: {
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: [
          "status",
          { $fn: "first", $field: "id", $as: "firstId" },
          { $fn: "last", $field: "id", $as: "lastId" },
        ],
        $rowOrder: { customerName: 1 },
        $nulls: { customerName: "last" },
        $sort: { status: 1 },
      },
    },
  },
];

/** A random sorted read of `VpOrderIdView` with random `$nulls` placements. */
export function randomSortRead(rnd: () => number): { op: string; query: Record<string, any> } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const $select = Array.from(
    new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(ID_VIEW_COLS))),
  );
  const $sort: Record<string, 1 | -1> = {};
  const $nulls: Record<string, TPlacement> = {};
  for (let i = 0, n = 1 + Math.floor(rnd() * 2); i < n; i++) {
    const col = pick(ID_VIEW_COLS);
    $sort[col] = rnd() < 0.5 ? 1 : -1;
    if (ID_VIEW_NULLABLE.has(col) && rnd() < 0.7) $nulls[col] = pick(["first", "last"] as const);
  }
  const controls: Record<string, unknown> = { $select, $sort };
  if (Object.keys($nulls).length > 0) controls.$nulls = $nulls;
  if (rnd() < 0.7) controls.$limit = 1 + Math.floor(rnd() * 15);
  if (rnd() < 0.4) controls.$skip = Math.floor(rnd() * 30);
  const filters = [
    { amount: { $gt: Math.floor(rnd() * 1000) } },
    { customerName: null },
    { regionName: { $ne: null } },
    { status: "paid" },
  ];
  const filter = rnd() < 0.3 ? pick(filters) : {};
  return { op: rnd() < 0.8 ? "findMany" : "findManyWithCount", query: { filter, controls } };
}

async function runOrderedRead(
  view: TReadable & { findOne(q: unknown): Promise<unknown> },
  op: string,
  query: Record<string, unknown>,
): Promise<unknown> {
  if (op === "findOne") return view.findOne(query);
  if (op === "aggregate") return view.aggregate(query);
  if (op === "findManyWithCount") return view.findManyWithCount(query);
  return view.findMany(query);
}

/** Whether `rows` place NULL of `col` as asked (a block at the start / end). */
function placesNulls(
  rows: Array<Record<string, unknown>>,
  col: string,
  nulls: TPlacement,
): boolean {
  const flags = rows.map((r) => r[col] === null || r[col] === undefined);
  const firstValue = flags.indexOf(false);
  const lastNull = flags.lastIndexOf(true);
  if (firstValue === -1 || lastNull === -1) return true;
  return nulls === "first" ? lastNull < firstValue : flags.indexOf(true) > flags.lastIndexOf(false);
}

export function defineViewPruneSortCases(label: string, kit: () => TViewPruneKit): void {
  const same = async (op: string, query: Record<string, unknown>) => {
    const { fx, pruned, plain } = kit();
    const on = pruned.getView(fx.VpOrderIdView) as Parameters<typeof runOrderedRead>[0];
    const off = plain.getView(fx.VpOrderIdView) as Parameters<typeof runOrderedRead>[0];
    const [a, b] = await Promise.all([
      runOrderedRead(on, op, query),
      runOrderedRead(off, op, query),
    ]);
    expect(a, `${op} ${JSON.stringify(query)}`).toEqual(b);
    return a;
  };

  describe(`${label}: view read pruning × tie-breaker × NULL placement`, () => {
    it("pruned reads keep the order of the stored view", async () => {
      for (const { op, query } of SORT_READS) await same(op, query);
    });

    it("the placement holds on the pruned read", async () => {
      const rows = (await same("findMany", {
        filter: {},
        controls: { $select: ["id", "shipRegion"], $sort: { shipRegion: 1 } },
      })) as Array<Record<string, unknown>>;
      expect(rows.some((r) => r.shipRegion === null || r.shipRegion === undefined)).toBe(true);
      // the `@db.sort.nulls 'last'` default, ascending (NULL is natively first there)
      expect(placesNulls(rows, "shipRegion", "last")).toBe(true);
      const firsts = (await same("findMany", {
        filter: {},
        controls: {
          $select: ["id", "customerName"],
          $sort: { customerName: 1 },
          $nulls: { customerName: "last" },
        },
      })) as Array<Record<string, unknown>>;
      expect(placesNulls(firsts, "customerName", "last")).toBe(true);
      // ties broken by id, in the last key's direction
      const tied = firsts.filter((r) => r.customerName === firsts[0]!.customerName);
      expect(tied.map((r) => r.id)).toEqual(
        tied.map((r) => r.id).toSorted((x, y) => (x as number) - (y as number)),
      );
    });

    it("an ungrouped aggregate without $groupBy", async () => {
      const [row] = (await same("aggregate", {
        filter: {},
        controls: { $select: [{ $fn: "count", $field: "*", $as: "n" }] },
      })) as Array<Record<string, unknown>>;
      expect(Number(row!.n)).toBeGreaterThan(0);
    });

    it("randomized differential with $nulls (seeded)", async () => {
      const rnd = vpRandom(53);
      for (let i = 0; i < 120; i++) {
        const { op, query } = randomSortRead(rnd);
        await same(op, query);
      }
    }, 120_000);
  });
}
