import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbSpace, resolveDesignType } from "../index";
import { planJsonColumnMigration } from "../schema/json-column-copy";
import { columnUnionBase, soleUnionMember } from "../shared/union-shape";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

// Union layout rules (since 0.1.155): `T | null` resolves to T (nullable),
// a union of objects is a flattened parent whose member-only leaves are
// nullable, a union mixing an object with another type is one JSON column.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/union-columns.as");
});

const relational = (type: unknown) => new DbSpace(() => new MockAdapter()).getTable(type as never);

function layout(type: unknown) {
  const table = relational(type);
  return Object.fromEntries(
    table.fieldDescriptors
      .filter((fd) => !fd.ignored)
      .map((fd) => [
        fd.path,
        `${fd.physicalName} ${fd.designType} ${fd.storage}${fd.optional ? " null" : ""}`,
      ]),
  );
}

describe("union layout on relational storage", () => {
  it("resolveDesignType leaves null members out", () => {
    const props = fx.UcOrder.type.props;
    expect(resolveDesignType(props.get("note"))).toBe("string");
    expect(resolveDesignType(props.get("qty"))).toBe("number");
    expect(resolveDesignType(props.get("addr"))).toBe("object");
    expect(resolveDesignType(props.get("refund"))).toBe("object");
    expect(resolveDesignType(props.get("extra"))).toBe("union");
  });

  it("lays out nullable unions, unions of objects and mixed unions", () => {
    expect(layout(fx.UcOrder)).toEqual({
      id: "id number column",
      note: "note string column null",
      qty: "qty number column null",
      paid: "paid boolean column null",
      status: "status string column null",
      code: "code string column null",
      tags: "tags json json null",
      "addr.street": "addr__street string flattened null",
      "addr.zip": "addr__zip string flattened null",
      "payment.kind": "payment__kind string flattened",
      "payment.card": "payment__card string flattened null",
      "payment.amount": "payment__amount number flattened",
      "payment.iban": "payment__iban string flattened null",
      "payment.bic": "payment__bic string flattened null",
      "refund.kind": "refund__kind string flattened null",
      "refund.card": "refund__card string flattened null",
      "refund.amount": "refund__amount number flattened null",
      "refund.iban": "refund__iban string flattened null",
      "refund.bic": "refund__bic string flattened null",
      extra: "extra json json",
      "shipping.street": "shipping__street string flattened null",
      "shipping.city": "shipping__city string flattened null",
    });
  });

  it("describes a `T | null` column by T (its tags and annotations)", () => {
    const qty = relational(fx.UcOrder).fieldDescriptors.find((fd) => fd.path === "qty")!;
    expect([...((qty.type.type as { tags: Set<string> }).tags ?? [])]).toContain("int");
    const code = relational(fx.UcOrder).fieldDescriptors.find((fd) => fd.path === "code")!;
    expect(code.type.metadata.get("expect.maxLength")).toEqual({ length: 10 });
  });

  it("columnUnionBase: the value member of T | null, not through a field reference", async () => {
    const pd = await import("./fixtures/primitive-defaults.as");
    const props = (pd.PdEvent as any).type.props;
    const nullable = props.get("nullable");
    expect(columnUnionBase(nullable)).toBe(soleUnionMember(nullable));
    expect(columnUnionBase(nullable)?.metadata.has("db.default.now")).toBe(true);
    // `sourceClosedAt: PdSource.closedAt` shares that field's union
    expect(soleUnionMember(props.get("sourceClosedAt"))).toBeDefined();
    expect(columnUnionBase(props.get("sourceClosedAt"))).toBeUndefined();
    expect(columnUnionBase(props.get("mixed"))).toBeUndefined();
    expect(columnUnionBase(props.get("createdAt"))).toBeUndefined();
  });

  it("same-name leaves of several members", () => {
    expect(layout(fx.UcShape)).toEqual({
      id: "id number column",
      "conf.x": "conf__x union flattened",
      "deep.x": "deep__x json json",
      "outer.inner.kind": "outer__inner__kind string flattened null",
      "outer.inner.card": "outer__inner__card string flattened null",
      "outer.inner.amount": "outer__inner__amount number flattened null",
      "outer.inner.iban": "outer__inner__iban string flattened null",
      "outer.inner.bic": "outer__inner__bic string flattened null",
    });
  });

  it("nullability and presence per logical path", () => {
    const meta = relational(fx.UcOrder).getMetadata();
    expect(meta.presence("payment.amount")).toBe("required");
    expect(meta.presence("refund.amount")).toBe("nullable");
    expect(meta.presence("payment.card")).toBe("partial");
    expect(meta.presence("shipping.city")).toBe("nullable");
    expect(meta.isNullable("payment.kind")).toBe(false);
    expect(meta.isNullable("note")).toBe(true);
  });

  it("document storage keeps the field's own optionality in descriptors", () => {
    const table = new DbSpace(() => new NestedMockAdapter()).getTable(fx.UcOrder as never);
    const note = table.fieldDescriptors.find((fd) => fd.path === "note")!;
    expect([note.designType, note.optional]).toEqual(["string", false]);
    expect(table.getMetadata().isNullable("note")).toBe(true);
  });

  it("plans the copy out of an old union column, or refuses without adapter support", () => {
    const table = relational(fx.UcOrder);
    const diff = {
      added: [],
      removed: [{ name: "refund", type: "TEXT", nullable: false, pk: false }],
      renamed: [],
      typeChanged: [],
      nullableChanged: [],
      defaultChanged: [],
      conflicts: [],
    } as any;
    const refused = planJsonColumnMigration(table, diff);
    expect(refused.copies).toEqual([]);
    expect(refused.errors[0]).toMatch(
      /Column "refund" of uc_orders holds "refund" as JSON text .* the adapter cannot copy JSON values .* @db\.json/,
    );
    (table.dbAdapter as any).copyFromJsonColumn = async () => {};
    const planned = planJsonColumnMigration(table, diff);
    expect(planned.errors).toEqual([]);
    expect(
      planned.copies[0]!.targets.map((t) => `${t.column}:${t.path.join(".")}:${t.kind}`),
    ).toEqual([
      "refund__kind:kind:text",
      "refund__card:card:text",
      "refund__amount:amount:text",
      "refund__iban:iban:text",
      "refund__bic:bic:text",
    ]);
  });
});
