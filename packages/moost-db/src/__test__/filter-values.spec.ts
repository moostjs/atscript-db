/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * Filter values checked against the column type over HTTP (since 0.1.147):
 * a value that cannot denote the column's type answers 400 with the
 * validation envelope (`errors[0].path` = the field) — the same answer on
 * every adapter, instead of an engine error or empty / wrong rows — while
 * every valid URL form keeps working.
 */

let http: THttpSend;
const PREFIX = "typefix";

beforeAll(async () => {
  await prepareFixtures();
  const { TfHttpItem } = await import("./fixtures/typefix.as");
  getMoostInfact()._cleanup();
  const items = createAdapter().getTable(TfHttpItem);
  await items.insertMany([
    {
      id: 1,
      n: 0,
      ts: 1000,
      flag: false,
      label: "a",
      price: "1.50",
      createdIso: "2026-01-01T00:00:00.000Z",
    },
    {
      id: 2,
      n: 5,
      ts: 2000,
      flag: true,
      label: "b",
      price: "12.50",
      createdIso: "2026-02-01T00:00:00.000Z",
    },
  ] as never);

  @TableController(items, PREFIX)
  class Items extends AsDbController {}

  http = await bootHttp(Items);
});

const query = (qs: string) => http("GET", `/${PREFIX}/query?${qs}`);

async function ids(qs: string) {
  const res = await query(`${qs}&$sort=id`);
  expect(res.status, qs).toBe(200);
  return (res.body as Array<{ id: number }>).map((r) => r.id);
}

describe("filter values over HTTP", () => {
  it.each([
    ["n='x'", "n", /expected a number, got "x"/],
    ["n>=abc", "n", /\(\$gte\): expected a number/],
    ["n{0,abc}", "n", /\(\$in\)/],
    ["n=true", "n", /got true/],
    ["flag=yes", "flag", /expected a boolean/],
    ["flag=2", "flag", /expected a boolean/],
    ["ts>='2026-01-01T00:00:00Z'", "ts", /epoch milliseconds/],
    ["ts>=1500.5", "ts", /expected an integer \(epoch milliseconds\), got 1500.5/],
    ["price='abc'", "price", /expected a decimal/],
  ])("%s → 400 naming the field", async (qs, path, message) => {
    const res = await query(qs);
    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].path).toBe(path);
    expect(res.body.errors[0].message).toContain(`Invalid filter value for "${path}"`);
    expect(res.body.errors[0].message).toMatch(message);
    expect(res.body.message).toBe(res.body.errors[0].message);
  });

  it("/pages answers the same 400", async () => {
    const res = await http("GET", `/${PREFIX}/pages?n='x'`);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe("n");
  });

  it("valid forms keep working", async () => {
    expect(await ids("n=5")).toEqual([2]);
    expect(await ids("n>=5")).toEqual([2]);
    expect(await ids("n{0,5}")).toEqual([1, 2]);
    expect(await ids("n=null")).toEqual([]);
    expect(await ids("n!=null")).toEqual([1, 2]);
    expect(await ids("ts>=1500")).toEqual([2]);
    expect(await ids("flag=true")).toEqual([2]);
    expect(await ids("label=b")).toEqual([2]);
    expect(await ids("price='12.50'")).toEqual([2]);
    expect(await ids("createdIso>='2026-01-15T00:00:00.000Z'")).toEqual([2]);
    // An unquoted number on a string column is a number in the URL grammar — still accepted.
    expect(await ids("label=5")).toEqual([]);
    // A quoted numeric string on a number column is accepted too.
    expect((await query("n='5'")).status).toBe(200);
  });
});
