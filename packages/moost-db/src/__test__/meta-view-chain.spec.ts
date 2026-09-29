import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { AsDbReadableController } from "../as-db-readable.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, prepareFixtures } from "./test-utils";

// `/meta` over a view that reads another view, and over a view with
// `@db.alias` joins (since 0.1.141): fields are listed from the view's own
// columns, and a chain through the upstream view still resolves to its
// terminal field with the FK marker inherited (value help targets the dict).

let fx: Record<string, any>;

class ExposedController extends AsDbReadableController {
  public serialize() {
    return this.getSerializedType();
  }
}

function bind(type: any) {
  const db = new DbSpace(() => new MockAdapter());
  db.getTable(fx.McDict);
  db.getTable(fx.McIssue);
  const view = db.getView(type);
  return new ExposedController(makeApp(), view as any);
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/meta-view-chain.as");
  fx.McDict.metadata.set("db.http.path", "/mc-dicts");
});

describe("/meta — views over views and join aliases", () => {
  it("lists the fields of a view over a view and re-points the chain to the dictionary", async () => {
    const controller = bind(fx.McIssueChain);
    const meta = await controller.meta();
    expect(Object.keys(meta.fields).toSorted()).toEqual(["code", "id", "title"]);
    expect(meta.fields.code.filterable).toBe(true);
    const code = (controller.serialize() as any).type.props.code;
    expect(code.ref).toMatchObject({ field: "code", type: { id: "McDict" } });
    expect(code.ref.type.metadata["db.http.path"]).toBe("/mc-dicts");
    expect(code.metadata["db.rel.FK"]).toBe(true);
  });

  it("lists aliased-join fields, with the parent's FK chain resolved through the alias", async () => {
    const controller = bind(fx.McIssueParents);
    const meta = await controller.meta();
    expect(Object.keys(meta.fields).toSorted()).toEqual([
      "id",
      "parentCode",
      "parentTitle",
      "title",
    ]);
    const props = (controller.serialize() as any).type.props;
    // The alias is a type of its own: the direct hop names it, the terminal is the dict
    expect(props.parentCode.ref).toMatchObject({ field: "code", type: { id: "McDict" } });
    expect(props.parentCode.metadata["db.rel.FK"]).toBe(true);
    expect(props.parentTitle.ref).toMatchObject({ field: "title" });
  });
});
