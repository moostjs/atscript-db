import { describe, it, expect } from "vite-plus/test";

import { DbSpace, isDbEntityType } from "../index";
import { resolveRelationTargetTable } from "../rel";
import { planSchema } from "../sync";

import { MockAdapter, prepareFixtures } from "./test-utils";

// Since 0.1.141 the entity annotations (`@db.table`, `@db.schema`,
// `@db.depth.limit`, `@db.view.*`, …) stay on the declaring interface: a
// `@db.alias`, a plain `export type X = Table` and a field typed with a table
// no longer carry them, so none of those is a second DB entity of the same
// table at runtime.

const ENTITY_KEYS = ["db.table", "db.schema", "db.depth.limit"] as const;

// Loaded at collection time: the same-file relation case below decides
// whether it runs from the compiled shape.
await prepareFixtures();
const ae: Record<string, any> = await import("./fixtures/alias-entity.as");

const space = () => new DbSpace(() => new MockAdapter());

describe("entity annotations do not travel across references", () => {
  it("keeps them on the table itself", () => {
    expect(ae.AeCustomer.metadata.get("db.table")).toBe("ae_customers");
    expect(ae.AeCustomer.metadata.get("db.schema")).toBe("sales");
    expect(ae.AeCustomer.metadata.get("db.depth.limit")).toBe(1);
  });

  it("a @db.alias and a plain type alias of the table carry none", () => {
    for (const key of ENTITY_KEYS) {
      expect(ae.AeParent.metadata.has(key), `AeParent ${key}`).toBe(false);
      expect(ae.AeBuyer.metadata.has(key), `AeBuyer ${key}`).toBe(false);
    }
    expect(ae.AeParent.metadata.has("db.alias")).toBe(true);
    expect(ae.AeBuyer.metadata.size).toBe(0);
  });

  it("nav props, FK chain refs and table-typed fields carry none", () => {
    const props = [
      ae.AeOrder.type.props.get("customer"),
      ae.AeOrder.type.props.get("customerId"),
      ae.AeCustomer.type.props.get("orders"),
      ae.AeOrderNote.type.props.get("customer"),
      ae.AeOrderNote.type.props.get("others"),
    ];
    for (const prop of props) {
      expect(prop).toBeDefined();
      for (const key of ENTITY_KEYS) {
        expect(prop.metadata.has(key), `${prop.id ?? "prop"} ${key}`).toBe(false);
      }
    }
  });

  it("isDbEntityType: tables and views only — never an alias or a table-typed reference", () => {
    expect(isDbEntityType(ae.AeCustomer)).toBe(true);
    expect(isDbEntityType(ae.AeOrder)).toBe(true);
    expect(isDbEntityType(ae.AeParent)).toBe(false);
    expect(isDbEntityType(ae.AeBuyer)).toBe(false);
    expect(isDbEntityType(ae.AeOrderNote)).toBe(false);
    expect(isDbEntityType(ae.AeOrder.type.props.get("customer"))).toBe(false);
    expect(isDbEntityType(undefined)).toBe(false);
    expect(isDbEntityType({ metadata: new Map([["db.table", "x"]]) })).toBe(false);
  });
});

describe("relations resolve their target through the prop's ref, not the prop's metadata", () => {
  // A nav prop typed with a table declared in the SAME file compiles to an
  // eager `refTo(AeCustomer)`, which @atscript/typescript 0.1.94 records
  // without a `ref` (only chain refs and imported / lazy refs get one). The
  // relation target used to be found through the `db.table` that leaked onto
  // the prop; without the leak it needs the `ref` — the runtime records one
  // for eager refs from the version noted in the upgrading guide, and the
  // pure same-file case below runs on its own once it does.
  const sameFileRefs = !!ae.AeOrder.type.props.get("customer").ref;

  async function assertRelationsWork(s: DbSpace) {
    const orders = s.getTable(ae.AeOrder);
    const customers = s.getTable(ae.AeCustomer);
    expect(resolveRelationTargetTable(orders.relations.get("customer")!)).toBe("ae_customers");
    expect(resolveRelationTargetTable(customers.relations.get("orders")!)).toBe("ae_orders");
    await customers.insertOne({ id: 7, name: "Ada" });
    await orders.insertOne({ id: 1, customerId: 7, amount: 5 });
    const rows = (await orders.findMany({
      filter: {},
      controls: { $with: [{ name: "customer", filter: {}, controls: {} }] },
    })) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].customer).toEqual({ id: 7, name: "Ada" });
  }

  it("names and loads @db.rel.to / @db.rel.from targets through the prop's ref", async () => {
    // What the runtime records for a lazy / imported ref, and for an eager
    // one from the fixed runtime on — applied here when it is missing.
    const customer = ae.AeOrder.type.props.get("customer");
    const orders = ae.AeCustomer.type.props.get("orders");
    customer.ref ??= { type: () => ae.AeCustomer, field: "" };
    orders.type.of.ref ??= { type: () => ae.AeOrder, field: "" };
    await assertRelationsWork(space());
  });

  it.skipIf(!sameFileRefs)(
    "same-file nav props resolve on their own once the runtime records their ref",
    async () => {
      await assertRelationsWork(space());
    },
  );
});

describe("schema sync over a module namespace", () => {
  it("plans the tables only — a @db.alias in the list is ignored", async () => {
    const plan = await planSchema(space(), [ae.AeCustomer, ae.AeOrder, ae.AeParent]);
    expect(plan.entries.map((e) => e.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "ae_customers",
      "ae_orders",
    ]);
  });

  it("isDbEntityType filters a namespace down to its tables and views", async () => {
    const models = Object.values(ae).filter(isDbEntityType);
    expect(models.map((m) => m.id ?? "").toSorted((a, b) => a.localeCompare(b))).toEqual([
      "AeCustomer",
      "AeOrder",
    ]);
    const plan = await planSchema(space(), models);
    expect(plan.entries.map((e) => e.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "ae_customers",
      "ae_orders",
    ]);
  });
});
