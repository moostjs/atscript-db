/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { getMoostInfact } from "moost";

import { AsDbReadableController } from "../as-db-readable.controller";
import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { TableController } from "../decorators";
import { makeValueHelpType } from "./actions-test-utils";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * NULL placement in sorts (since 0.1.153): the URL suffix `:first` / `:last`
 * on a `$sort` key becomes the `$nulls` control, the fields'
 * `@db.sort.nulls` apply when the request names none, `$nulls` keys go
 * through the sortable gate, and `/meta` advertises the capability.
 */

let http: THttpSend;
const PREFIX = "sn-rows";

const ROWS = [
  { id: 1, amount: 30, closedAt: 3 },
  { id: 2, amount: null, closedAt: null },
  { id: 3, amount: 10, closedAt: 1 },
  { id: 4 },
  { id: 5, amount: 20, closedAt: 2 },
];

beforeAll(async () => {
  await prepareFixtures();
  const { SnHttpRow } = await import("./fixtures/sort-nulls.as");
  getMoostInfact()._cleanup();
  const rows = createAdapter().getTable(SnHttpRow);
  await rows.insertMany(ROWS as never);

  @TableController(rows, PREFIX)
  class Rows extends AsDbReadableController {}

  http = await bootHttp(Rows);
});

async function ids(path: string): Promise<number[]> {
  const res = await http("GET", `/${PREFIX}/${path}`);
  expect(res.status, path).toBe(200);
  const rows = (Array.isArray(res.body) ? res.body : res.body.data) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

describe("URL NULL placement", () => {
  it("$sort=-amount:last / amount:first on /query", async () => {
    // ties (the two NULLs) follow the primary key in the last key's direction
    expect(await ids("query?$sort=-amount")).toEqual([1, 5, 3, 4, 2]);
    expect(await ids("query?$sort=-amount:last")).toEqual([1, 5, 3, 4, 2]);
    expect(await ids("query?$sort=-amount:first")).toEqual([4, 2, 1, 5, 3]);
    expect(await ids("query?$sort=amount:last")).toEqual([3, 5, 1, 2, 4]);
    // $order is the same control
    expect(await ids("query?$order=amount:last")).toEqual([3, 5, 1, 2, 4]);
  });

  it("pages across the NULL boundary on /pages", async () => {
    const pages: number[] = [];
    for (let page = 1; page <= 3; page++) {
      pages.push(...(await ids(`pages?$sort=amount:last&$page=${page}&$size=2`)));
    }
    expect(pages).toEqual([3, 5, 1, 2, 4]);
  });

  it("applies @db.sort.nulls when the request names no placement", async () => {
    expect(await ids("query?$sort=closedAt")).toEqual([3, 5, 1, 2, 4]);
    expect(await ids("query?$sort=closedAt:first")).toEqual([2, 4, 3, 5, 1]);
  });

  it("rejects a placement on a non-sortable field, an unknown one and a malformed suffix", async () => {
    for (const qs of ["$sort=note:last", "$sort=bogus:first", "$sort=amount:middle"]) {
      const res = await http("GET", `/${PREFIX}/query?${qs}`);
      expect(res.status, qs).toBe(400);
    }
  });

  it("/meta advertises the capability, the control and the field default", async () => {
    const res = await http("GET", `/${PREFIX}/meta`);
    expect(res.status).toBe(200);
    expect(res.body.nullsPlacement).toBe(true);
    expect(res.body.crud.query).toContain("nulls");
    expect(res.body.crud.pages).toContain("nulls");
    expect(res.body.type.type.props.closedAt.metadata["db.sort.nulls"]).toBe("last");
    expect(res.body.type.type.props.amount.metadata["db.sort.nulls"]).toBeUndefined();
  });
});

describe("value-help /pages ordering and NULL placement", () => {
  type Doc = { id: number; label?: string | null };
  const docs: Doc[] = [
    { id: 3, label: "c" },
    { id: 1, label: null },
    { id: 2, label: "a" },
  ];
  const help = () =>
    new AsJsonValueHelpController<any, Doc>(
      makeValueHelpType({
        props: {
          id: { designType: "number", annotations: { "meta.id": true } },
          label: { designType: "string" },
        },
      }),
      docs,
      { getLogger: vi.fn().mockReturnValue({ warn: vi.fn(), info: vi.fn() }) } as any,
    );
  const pageIds = async (qs: string) =>
    ((await help().runPages(qs)) as { data: Doc[] }).data.map((d) => d.id);

  it("orders /pages by the primary key when no $sort is given", async () => {
    expect(await pageIds("?$size=10")).toEqual([1, 2, 3]);
    expect(await pageIds("?$size=2&$page=2")).toEqual([3]);
  });

  it("keeps an explicit $sort and honours its :first / :last", async () => {
    expect(await pageIds("?$sort=-label&$size=10")).toEqual([3, 2, 1]);
    expect(await pageIds("?$sort=-label:first&$size=10")).toEqual([1, 3, 2]);
  });

  it("/query is unchanged (source order)", async () => {
    const rows = (await help().runQuery("?")) as Doc[];
    expect(rows.map((d) => d.id)).toEqual([3, 1, 2]);
  });
});
