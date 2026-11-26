/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace, type TDbFieldMeta } from "@atscript/db";
import { MemoryAdapter } from "@atscript/db-memory";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * An adapter's `filterOps(fd)` (since 0.1.196) in `/meta` and the request
 * gate: `/meta.fields[P].filterOps` lists the operators the field accepts —
 * on a filterable field too — `filterable` is false when no comparison
 * remains, and the gate refuses an entry with an unlisted operator, as the
 * core guard does. Without a list nothing changes.
 */

type TLists = Record<string, readonly string[] | undefined>;

/** An in-memory adapter whose `filterOps` answers `lists[<table>.<path>]`. */
class ListedMemoryAdapter extends MemoryAdapter {
  constructor(private readonly lists: TLists) {
    super();
  }

  override filterOps(fd: TDbFieldMeta) {
    return this.lists[`${this._table.tableName}.${fd.path}`] as any;
  }
}

const LISTS: TLists = {
  "fo_products.id": ["$eq", "$in"],
  "fo_products.supplierId": ["$eq", "$in"],
  "fo_products.name": ["$eq", "$in"],
  "fo_products.sku": ["$exists"],
  "fo_products.rating": [],
  "fo_products.secret": ["$eq"],
  "fo_suppliers.id": ["$eq", "$in"],
  "fo_suppliers.name": ["$eq"],
};

let send: THttpSend;
let SEQ = 0;
let prefix = "";

beforeAll(async () => {
  await prepareFixtures();
  const { FoProduct, FoSupplier } = await import("./fixtures/filter-ops.as");
  getMoostInfact()._cleanup();
  const space = new DbSpace(() => new ListedMemoryAdapter(LISTS));
  const products = space.getTable(FoProduct);
  const suppliers = space.getTable(FoSupplier);
  await suppliers.insertOne({ id: 1, name: "Acme" });
  await products.insertOne({ id: 1, name: "Bolt", sku: "B-1", rating: 4, supplierId: 1 });
  await products.insertOne({
    id: 2,
    name: "Nut",
    sku: "N-1",
    rating: 2,
    note: "brass",
    supplierId: 1,
  });
  prefix = `fo${++SEQ}`;

  @TableController(products, prefix)
  @Inherit()
  class Products extends AsDbController {}

  send = await bootHttp(Products);
});

describe("/meta serves the adapter's operator lists", () => {
  it("per field: filterOps on a filterable field, filterable false when no comparison remains", async () => {
    const { fields } = (await send("GET", `/${prefix}/meta`)).body;
    expect(fields.name).toMatchObject({ filterable: true, filterOps: ["$eq", "$in"] });
    expect(fields.sku).toMatchObject({ filterable: false, filterOps: ["$exists"] });
    // an empty list refuses every filter: nothing to offer
    expect(fields.rating.filterable).toBe(false);
    expect(fields.rating).not.toHaveProperty("filterOps");
    // a write-only field stays sealed whatever the list says
    expect(fields.secret.filterable).toBe(false);
    expect(fields.secret).not.toHaveProperty("filterOps");
    // no list: unchanged
    expect(fields.note.filterable).toBe(true);
    expect(fields.note).not.toHaveProperty("filterOps");
  });
});

describe("the $search fallback reads only fields whose list holds $regex", () => {
  it("skips a searchable field without it: $search answers, /meta.searchable follows", async () => {
    expect((await send("GET", `/${prefix}/meta`)).body.searchable).toBe(true);
    // `name` (listed without $regex) is not searched — before, every $search was a 400
    const byName = await send("GET", `/${prefix}/query?$search=Bolt`);
    expect(byName.status).toBe(200);
    expect(byName.body).toEqual([]);
    const byNote = await send("GET", `/${prefix}/query?$search=brass`);
    expect(byNote.body.map((row: any) => row.id)).toEqual([2]);
  });
});

describe("the gate refuses an unlisted operator, as the core guard does", () => {
  it("accepts listed operators", async () => {
    expect((await send("GET", `/${prefix}/query?name=Bolt`)).body).toHaveLength(1);
    expect((await send("GET", `/${prefix}/query?name{Bolt,Nut}`)).body).toHaveLength(2);
    expect((await send("GET", `/${prefix}/query?$exists=sku`)).body).toHaveLength(2);
  });

  it("refuses an operator the list leaves out, naming the accepted ones", async () => {
    const res = await send("GET", `/${prefix}/query?name!=Bolt`);
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([
      {
        path: "name",
        message:
          'Filtering on field "name" is not permitted — the adapter does not accept $ne on this field (accepted operators: $eq, $in).',
        code: "FIELD_NOT_PERMITTED",
        params: { field: "name", op: "filter" },
      },
    ]);
  });

  it("an empty list refuses every filter, $exists included", async () => {
    for (const qs of ["rating=4", "rating>3", "$exists=rating"]) {
      const res = await send("GET", `/${prefix}/query?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatchObject({ path: "rating", code: "FIELD_NOT_PERMITTED" });
      expect(res.body.errors[0].message).toContain("the adapter does not accept $");
    }
  });

  it("a relational predicate's operand meets the related table's list", async () => {
    const ok = await send("GET", `/${prefix}/query?supplier=$some(name=Acme)`);
    expect(ok.body).toHaveLength(2);
    const res = await send("GET", `/${prefix}/query?supplier=$some(name!=Acme)`);
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({
      path: "supplier.name",
      code: "FIELD_NOT_PERMITTED",
      message:
        'Filtering on field "supplier.name" is not permitted — the adapter does not accept $ne on this field (accepted operators: $eq).',
    });
  });
});
