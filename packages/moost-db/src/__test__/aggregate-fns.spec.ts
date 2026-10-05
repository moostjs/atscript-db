import { describe, it, expect, beforeAll } from "vite-plus/test";
import { ALL_AGGREGATE_FNS, DbSpace } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp, errorsOf, prepareFixtures, transformed } from "./test-utils";

/**
 * countDistinct over HTTP and the adapter's `aggregateFns()` capability
 * (since 0.1.136): `/meta.aggregateFns` lists what the adapter renders, the
 * URL `countDistinct(field)` reaches the table, `countDistinct(*)` is the
 * normalizer's 400, and a function the adapter lacks is the core's
 * `AGG_FN_NOT_SUPPORTED` (HTTP 400).
 */

class DistinctAdapter extends MockAdapter {
  override aggregateFns() {
    return ALL_AGGREGATE_FNS;
  }
}

let BucketTicket: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ BucketTicket } = await import("./fixtures/bucket-tickets.as"));
});

function bind(adapter: MockAdapter) {
  const table = new DbSpace(() => adapter).getTable(BucketTicket);
  return new AsDbController(createMockApp(), table as any);
}

describe("countDistinct over HTTP", () => {
  it("/meta advertises the adapter's aggregate functions in canonical order", async () => {
    expect((await bind(new DistinctAdapter()).meta()).aggregateFns).toEqual([
      "sum",
      "count",
      "avg",
      "min",
      "max",
      "countDistinct",
      "first",
      "last",
    ]);
    expect((await bind(new MockAdapter()).meta()).aggregateFns).toEqual([
      "sum",
      "count",
      "avg",
      "min",
      "max",
    ]);
  });

  it("$select=countDistinct(field) reaches the adapter (a dimension of a strict table)", async () => {
    const adapter = new DistinctAdapter();
    adapter.aggregateResult = [{ status: "open", owners: 2 }];
    const result = await bind(adapter).query(
      "/query?$groupBy=status&$select=status,countDistinct(openedAt):owners&$sort=-owners",
    );
    expect(result).not.toBeInstanceOf(HttpError);
    const call = adapter.calls.find((c) => c.method === "aggregate")!;
    expect(call.args[0].controls.$select.aggregates).toEqual([
      { $fn: "countDistinct", $field: "openedAt", $as: "owners" },
    ]);
  });

  it("countDistinct(*) → 400 before the table is reached", async () => {
    const adapter = new DistinctAdapter();
    const result = await bind(adapter).query(
      "/query?$groupBy=status&$select=status,countDistinct(*)",
    );
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(400);
    expect(errorsOf(result)).toEqual([
      {
        path: "$select",
        message: 'Aggregate "countDistinct" needs a field — only count accepts *',
      },
    ]);
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });

  it("an adapter without countDistinct answers AGG_FN_NOT_SUPPORTED as HTTP 400", async () => {
    const adapter = new MockAdapter();
    const res = await transformed(
      bind(adapter).query("/query?$groupBy=status&$select=status,countDistinct(points)"),
    );
    expect(res.body.statusCode).toBe(400);
    expect(errorsOf(res)).toEqual([
      {
        path: "$select",
        message: 'Aggregate function "countDistinct" is not supported by this adapter',
      },
    ]);
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });
});
