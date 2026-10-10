import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

// Live DDL against a real server is slow under the parallel workspace run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override the server with
// `ATSCRIPT_PG_TEST_URL` (or `POSTGRES_TEST_URI`; an admin connection — the
// spec creates and drops its own `r15_misc_fw25_paging` database).
//
// Since 0.1.153: a read whose `$sort` does not order rows totally gets the
// primary key appended (direction of the last `$sort` key), so offset pages
// never overlap or skip tied rows.

const DB = "r15_misc_fw25_paging";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);

describe.skipIf(!reachable)("[postgres live] deterministic paging tie-breaker", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/paging-tiebreak.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver));
    const result = await syncSchema(space, [fx.PtRow, fx.PtPair]);
    expect(result.status).toBe("synced");
    await seed();
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
  });

  defineCases();
});

// ── shared cases (kept identical across the adapter specs) ─────────────────

const N = 40;

/** Rows 1..N inserted in a scrambled order; `grp` ties a third of them, `label` ties all. */
function ptRows(): Array<{ id: number; grp: number; label: string; code: string }> {
  return Array.from({ length: N }, (_, i) => {
    const id = ((i * 17) % N) + 1;
    return { id, grp: id % 3, label: "same", code: `c${id}` };
  });
}

/** Pairs (a 1..4, b 1..5) inserted in a scrambled order, all in one `grp`. */
function ptPairs(): Array<{ a: number; b: number; grp: number }> {
  return Array.from({ length: 20 }, (_, i) => {
    const k = (i * 7) % 20;
    return { a: Math.floor(k / 5) + 1, b: (k % 5) + 1, grp: 0 };
  });
}

async function seed(): Promise<void> {
  await t(fx.PtRow).insertMany(ptRows());
  await t(fx.PtPair).insertMany(ptPairs());
}

type TKey<R> = [keyof R, 1 | -1];

/** The rows in the order `keys` define (numbers compared numerically). */
function ordered<R extends Record<string, unknown>>(rows: R[], keys: Array<TKey<R>>): R[] {
  return rows.toSorted((x, y) => {
    for (const [k, dir] of keys) {
      const a = x[k] as number | string;
      const b = y[k] as number | string;
      if (a !== b) return (a < b ? -1 : 1) * dir;
    }
    return 0;
  });
}

const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id);
const pairKeys = (rows: Array<Record<string, unknown>>) => rows.map((r) => [r.a, r.b].join(":"));

async function readIds(controls: Record<string, unknown>) {
  return ids(await t(fx.PtRow).findMany({ filter: {}, controls }));
}

/** Pages through with `$skip` / `$limit` windows of `size`; returns the concatenation. */
async function pageThrough(
  table: any,
  sort: Record<string, 1 | -1>,
  size: number,
  withCount: boolean,
  total: number,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let skip = 0; ; skip += size) {
    const query = { filter: {}, controls: { $sort: sort, $skip: skip, $limit: size } };
    const rows = withCount
      ? await table.findManyWithCount(query).then((r: { data: unknown[]; count: number }) => {
          expect(r.count).toBe(total);
          return r.data;
        })
      : await table.findMany(query);
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

function defineCases(): void {
  it("ties on the $sort key come back in primary-key order (numeric, ascending)", async () => {
    expect(await readIds({ $sort: { grp: 1 } })).toEqual(
      ids(
        ordered(ptRows(), [
          ["grp", 1],
          ["id", 1],
        ]),
      ),
    );
  });

  it("the tie-breaker follows the direction of the LAST $sort key", async () => {
    expect(await readIds({ $sort: { grp: -1 } })).toEqual(
      ids(
        ordered(ptRows(), [
          ["grp", -1],
          ["id", -1],
        ]),
      ),
    );
    expect(await readIds({ $sort: { grp: 1, label: -1 } })).toEqual(
      ids(
        ordered(ptRows(), [
          ["grp", 1],
          ["id", -1],
        ]),
      ),
    );
    expect(await readIds({ $sort: { label: 1, grp: -1 } })).toEqual(
      ids(
        ordered(ptRows(), [
          ["grp", -1],
          ["id", -1],
        ]),
      ),
    );
  });

  it("a $sort that names the primary key keeps its own direction", async () => {
    expect(await readIds({ $sort: { grp: -1, id: 1 } })).toEqual(
      ids(
        ordered(ptRows(), [
          ["grp", -1],
          ["id", 1],
        ]),
      ),
    );
  });

  it("a unique non-nullable key already orders totally", async () => {
    expect(await readIds({ $sort: { code: -1 } })).toEqual(ids(ordered(ptRows(), [["code", -1]])));
  });

  it("offset windows of any size cover every row exactly once", async () => {
    const sorts: Array<[Record<string, 1 | -1>, Array<TKey<ReturnType<typeof ptRows>[number]>>]> = [
      [
        { grp: 1 },
        [
          ["grp", 1],
          ["id", 1],
        ],
      ],
      [{ label: 1 }, [["id", 1]]],
      [
        { grp: -1, label: 1 },
        [
          ["grp", -1],
          ["id", 1],
        ],
      ],
    ];
    for (const [sort, keys] of sorts) {
      const expected = ids(ordered(ptRows(), keys));
      for (const size of [1, 3, 7, 16, N]) {
        for (const withCount of [false, true]) {
          const got = ids(await pageThrough(t(fx.PtRow), sort, size, withCount, N));
          expect(got).toEqual(expected);
          expect(new Set(got).size).toBe(N);
        }
      }
    }
  });

  it("composite primary key: every key field, in declaration order", async () => {
    const pairs = t(fx.PtPair);
    const read = async (sort: Record<string, 1 | -1>) =>
      pairKeys(await pairs.findMany({ filter: {}, controls: { $sort: sort } }));
    expect(await read({ grp: 1 })).toEqual(
      pairKeys(
        ordered(ptPairs(), [
          ["a", 1],
          ["b", 1],
        ]),
      ),
    );
    expect(await read({ grp: -1 })).toEqual(
      pairKeys(
        ordered(ptPairs(), [
          ["a", -1],
          ["b", -1],
        ]),
      ),
    );
    expect(await read({ b: 1, grp: -1 })).toEqual(
      pairKeys(
        ordered(ptPairs(), [
          ["b", 1],
          ["a", -1],
        ]),
      ),
    );
    const expected = pairKeys(
      ordered(ptPairs(), [
        ["a", -1],
        ["b", -1],
      ]),
    );
    for (const size of [1, 3, 6]) {
      expect(pairKeys(await pageThrough(pairs, { grp: -1 }, size, true, 20))).toEqual(expected);
    }
  });
}
