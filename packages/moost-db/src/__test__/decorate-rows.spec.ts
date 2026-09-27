import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import type { TDbDecorateContext } from "../as-db-readable.controller";
import { DbRowActions } from "../actions/db-actions.decorator";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, createMockReadable, prepareFixtures } from "./test-utils";

/**
 * `decorateRows` (since 0.1.136) — the post-read hook. Runs once per
 * response on /query, /pages, /geo and /one, after `$actions`, with the
 * top-level rows only; never for $count, $groupBy, nested $with rows or a 404.
 */

interface TCall {
  rows: Record<string, unknown>[];
  ctx: TDbDecorateContext;
  /** Row keys as the hook saw them (before its own mutation). */
  keys: string[][];
}

/** Records every call and stamps `$badge` after an async hop (proves the hook is awaited). */
class DecoratingController extends AsDbController {
  calls: TCall[] = [];

  protected override async decorateRows(
    rows: Record<string, unknown>[],
    ctx: TDbDecorateContext,
  ): Promise<void> {
    const keys = rows.map((r) => Object.keys(r));
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.calls.push({ rows, ctx, keys });
    for (const row of rows) row.$badge = `#${String(row.id)}`;
  }
}

let HiddenAccount: any;
let HiddenOwner: any;

const OWNERS = [
  { id: 10, name: "Olga" },
  { id: 11, name: "Oscar" },
];
// String ids: the mock adapter compares strictly and URL ids arrive as strings.
const ACCOUNTS = [
  { id: "1", name: "Alpha", password: "p", points: 5, profile__bio: "a", ownerId: 10 },
  { id: "2", name: "Beta", password: "p", points: 0, profile__bio: "b", ownerId: 11 },
];

/**
 * Binds `Ctrl` over a real table (core MockAdapter), seeding owners and
 * accounts. Every adapter instance shares one store — relation loading may
 * read through a different instance than the one that served the table.
 */
function bind<C extends AsDbController>(Ctrl: new (...args: any[]) => C) {
  const store = new Map<string, Array<Record<string, unknown>>>();
  const db = new DbSpace(() => {
    const a = new MockAdapter();
    a.store = store;
    a.aggregateResult = [{ name: "Alpha", n: 1 }];
    return a;
  });
  const owners = db.getTable(HiddenOwner);
  const table = db.getTable(HiddenAccount);
  store.set(owners.tableName, structuredClone(OWNERS));
  store.set(table.tableName, structuredClone(ACCOUNTS));
  const controller = new Ctrl(makeApp(), table as any);
  return { controller };
}

/** A fresh geo hit per call — the hook mutates the rows it gets. */
const geoHit = (): Record<string, unknown>[] => [{ id: "a", name: "A", $distance: 42 }];

beforeAll(async () => {
  await prepareFixtures();
  ({ HiddenAccount, HiddenOwner } = await import("./fixtures/hidden-fields.as"));
});

describe("decorateRows — endpoints", () => {
  it("/query: called once with all rows; mutations reach the response", async () => {
    const { controller } = bind(DecoratingController);
    const rows = (await controller.query("?$select=name")) as Record<string, unknown>[];
    expect(controller.calls).toHaveLength(1);
    const [call] = controller.calls;
    expect(call!.ctx.endpoint).toBe("query");
    expect(call!.rows).toHaveLength(2);
    expect(call!.ctx.projection).toEqual(expect.arrayContaining(["name", "id"]));
    expect(call!.ctx.controls.$select).toBeDefined();
    expect(rows.map((r) => r.$badge)).toEqual(["#1", "#2"]);
  });

  it("/pages: called once; the envelope is kept", async () => {
    const { controller } = bind(DecoratingController);
    const res = (await controller.pages("?$page=1&$size=10")) as {
      data: Record<string, unknown>[];
      count: number;
    };
    expect(controller.calls.map((c) => c.ctx.endpoint)).toEqual(["pages"]);
    expect(res.count).toBe(2);
    expect(res.data.map((r) => r.$badge)).toEqual(["#1", "#2"]);
  });

  it("/one/:id and /one?… report endpoint 'one' with a single-row array", async () => {
    const { controller } = bind(DecoratingController);
    const byId = (await controller.getOne("2", "")) as Record<string, unknown>;
    const composite = (await controller.getOneComposite({ id: "1" }, "?id=1")) as Record<
      string,
      unknown
    >;
    expect(byId.$badge).toBe("#2");
    expect(composite.$badge).toBe("#1");
    expect(controller.calls.map((c) => [c.ctx.endpoint, c.rows.length])).toEqual([
      ["one", 1],
      ["one", 1],
    ]);
  });

  it("is skipped on a /one 404", async () => {
    const { controller } = bind(DecoratingController);
    const res = await controller.getOne("999", "");
    expect(res).toBeInstanceOf(HttpError);
    expect(controller.calls).toHaveLength(0);
  });

  it("/geo (plain and paginated) reports endpoint 'geo'", async () => {
    const table = createMockReadable({
      isGeoSearchable: vi.fn().mockReturnValue(true),
      geoSearch: vi.fn(async () => geoHit()),
      geoSearchWithCount: vi.fn(async () => ({ data: geoHit(), count: 1 })),
    });
    const controller = new DecoratingController(makeApp(), table);
    const plain = (await controller.geo("?$center=1,2")) as Record<string, unknown>[];
    const paged = (await controller.geo("?$center=1,2&$page=1&$size=5")) as {
      data: Record<string, unknown>[];
    };
    expect(plain[0]).toMatchObject({ $distance: 42, $badge: "#a" });
    expect(paged.data[0]).toMatchObject({ $distance: 42, $badge: "#a" });
    expect(controller.calls.map((c) => c.ctx.endpoint)).toEqual(["geo", "geo"]);
  });
});

describe("decorateRows — ordering and scope", () => {
  it("runs after $actions augmentation; action-only columns are already stripped", async () => {
    @DbRowActions({
      reward: {
        label: "Reward",
        processor: "backend",
        value: "/x/reward",
        requiredFields: ["points"],
        disabled: (rows: Array<{ points: number }>) => rows.map((r) => r.points === 0),
      },
    })
    class Ctrl extends DecoratingController {}
    const { controller } = bind(Ctrl);
    const rows = (await controller.query("?$select=name&$actions=true")) as Record<
      string,
      unknown
    >[];
    const [call] = controller.calls;
    expect(call!.keys[0]).toContain("$actions");
    expect(call!.keys[0]).not.toContain("points");
    expect(call!.ctx.projection).not.toEqual(expect.arrayContaining(["points"]));
    expect(rows.map((r) => r.$actions)).toEqual([["reward"], []]);
    expect(rows[0]!.$badge).toBe("#1");
  });

  it("nested $with rows are not passed on their own", async () => {
    const { controller } = bind(DecoratingController);
    const rows = (await controller.query("?$with=owner")) as Record<string, unknown>[];
    expect(controller.calls).toHaveLength(1);
    expect(controller.calls[0]!.rows).toHaveLength(2);
    expect(rows[0]!.owner).toMatchObject({ id: 10, name: "Olga" });
    expect(rows[0]!.owner).not.toHaveProperty("$badge");
  });

  it("is not called for $count or $groupBy", async () => {
    const { controller } = bind(DecoratingController);
    expect(await controller.query("?$count=true")).toBe(2);
    const agg = await controller.query("?$select=name,count(*):n&$groupBy=name");
    expect(agg).toEqual([{ name: "Alpha", n: 1 }]);
    expect(controller.calls).toHaveLength(0);
  });

  it("without an override rows are returned untouched", async () => {
    const { controller } = bind(AsDbController);
    const rows = (await controller.query("")) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]!).some((k) => k.startsWith("$"))).toBe(false);
  });
});
