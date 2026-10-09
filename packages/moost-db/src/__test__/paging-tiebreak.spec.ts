/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { getMoostInfact } from "moost";

import { AsDbReadableController } from "../as-db-readable.controller";
import { TableController } from "../decorators";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * Deterministic paging (since 0.1.153): `/pages` without `$sort` reads in
 * primary-key order (ascending); with a `$sort`, rows that tie on it come
 * back in primary-key order, in the direction of the last `$sort` key.
 * `/query` without `$sort` imposes no order (the memory adapter returns
 * insertion order).
 */

let http: THttpSend;
const PREFIX = "pt-rows";
const N = 23;
// Scrambled insertion order: 1, 11, 21, 8, 18, …
const inserted = Array.from({ length: N }, (_, i) => ((i * 10) % N) + 1);

beforeAll(async () => {
  await prepareFixtures();
  const { PtHttpRow } = await import("./fixtures/paging-tiebreak.as");
  getMoostInfact()._cleanup();
  const rows = createAdapter().getTable(PtHttpRow);
  await rows.insertMany(inserted.map((id) => ({ id, grp: id % 2 })) as never);

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

/** Every page of `/pages?<qs>` of `size`, concatenated. */
async function allPages(qs: string, size: number): Promise<number[]> {
  const out: number[] = [];
  for (let page = 1; page <= Math.ceil(N / size); page++) {
    out.push(...(await ids(`pages?${qs}${qs ? "&" : ""}$page=${page}&$size=${size}`)));
  }
  return out;
}

const ascending = Array.from({ length: N }, (_, i) => i + 1);
const byGrp = (dir: 1 | -1) =>
  ascending.toSorted((a, b) => ((a % 2) - (b % 2)) * dir || (a - b) * dir);

describe("/pages ordering", () => {
  it("without $sort: primary-key order, the same on every page size", async () => {
    expect(await ids("pages?$size=100")).toEqual(ascending);
    for (const size of [1, 4, 7, N]) {
      expect(await allPages("", size)).toEqual(ascending);
    }
  });

  it("with $sort: ties in primary-key order, last key's direction", async () => {
    for (const size of [1, 5, 10]) {
      expect(await allPages("$sort=grp", size)).toEqual(byGrp(1));
      expect(await allPages("$sort=-grp", size)).toEqual(byGrp(-1));
    }
  });

  it("/query without $sort is unchanged (no order imposed)", async () => {
    expect(await ids("query")).toEqual(inserted);
    expect(await ids("query?$sort=-grp")).toEqual(byGrp(-1));
  });
});
