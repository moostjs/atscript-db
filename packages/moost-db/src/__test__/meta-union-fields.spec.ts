import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, prepareFixtures } from "./test-utils";

/**
 * Union fields in `/meta` (since 0.1.155): a union of objects (`payment`)
 * and a nullable one (`refund`) are object parents like a nested object —
 * their leaves are listed, the parent is not, and `$select=payment` reads
 * the whole object; `qty: number.int | null` is a number; `extra` (an object
 * or a string) is one JSON field.
 */

let UcOrder: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ UcOrder } = await import("./fixtures/union-columns.as"));
});

const LEAVES = [
  "extra",
  "id",
  "payment.amount",
  "payment.bic",
  "payment.card",
  "payment.iban",
  "payment.kind",
  "qty",
  "refund.amount",
  "refund.bic",
  "refund.card",
  "refund.iban",
  "refund.kind",
];

// A nested-object adapter addresses paths inside a JSON value natively (as
// inside `@db.json`): `extra`'s object member's leaves are listed there.
const EXTRA_LEAVES = ["extra.amount", "extra.card", "extra.kind"];

describe.each([
  ["flattening adapter", () => new DbSpace(() => new MockAdapter()).getTable(UcOrder), []],
  ["nested-object adapter (memory)", () => createAdapter().getTable(UcOrder), EXTRA_LEAVES],
])("/meta union fields — %s", (_name, tableOf, extra) => {
  it("lists the leaves of object unions, not the unions themselves", async () => {
    const meta = await new AsDbController(makeApp(), tableOf() as any).meta();
    expect(Object.keys(meta.fields).toSorted()).toEqual([...LEAVES, ...extra].toSorted());
    expect(meta.fields.qty.sortable).toBe(true);
    expect(meta.fields["refund.card"].filterable).toBe(true);
  });
});

describe("/meta union fields — $select of a union of objects", () => {
  it("expands to the flattened columns", async () => {
    const adapters: MockAdapter[] = [];
    const db = new DbSpace(() => {
      const a = new MockAdapter();
      adapters.push(a);
      return a;
    });
    await new AsDbController(makeApp(), db.getTable(UcOrder) as any).query("?$select=refund");
    const call = adapters[0]!.calls.find((c) => c.method === "findMany")!;
    expect([...(call.args[0].controls.$select.asArray as string[])].toSorted()).toEqual([
      "id",
      "refund__amount",
      "refund__bic",
      "refund__card",
      "refund__iban",
      "refund__kind",
    ]);
  });
});
