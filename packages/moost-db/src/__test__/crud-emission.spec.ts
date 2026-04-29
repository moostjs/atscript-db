import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { AsValueHelpController } from "../as-value-help.controller";
import { ONE_CONTROLS, PAGES_CONTROLS, QUERY_CONTROLS } from "../permissions/crud-controls";
import { makeApp, makeTable, makeValueHelpType } from "./actions-test-utils";

const valueHelpType = () =>
  makeValueHelpType({
    props: {
      id: { designType: "string", annotations: { "meta.id": true } },
      label: { designType: "string" },
    },
  });

describe("/meta crud — per-base-class emission", () => {
  it("AsDbReadableController emits exactly { query, pages, one }", async () => {
    class Ctrl extends AsDbReadableController {}
    const ctrl = new Ctrl(makeTable() as never, makeApp().app);
    const meta = await ctrl.meta();
    expect(Object.keys(meta.crud).toSorted()).toEqual(["one", "pages", "query"]);
    expect(meta.crud.query).toEqual([...QUERY_CONTROLS]);
    expect(meta.crud.pages).toEqual([...PAGES_CONTROLS]);
    expect(meta.crud.one).toEqual([...ONE_CONTROLS]);
  });

  it("AsDbController emits all seven keys with write keys as []", async () => {
    class Ctrl extends AsDbController {}
    const ctrl = new Ctrl(makeTable() as never, makeApp().app);
    const meta = await ctrl.meta();
    expect(Object.keys(meta.crud).toSorted()).toEqual([
      "insert",
      "one",
      "pages",
      "query",
      "remove",
      "replace",
      "update",
    ]);
    expect(meta.crud.insert).toEqual([]);
    expect(meta.crud.update).toEqual([]);
    expect(meta.crud.replace).toEqual([]);
    expect(meta.crud.remove).toEqual([]);
  });

  it("AsValueHelpController emits exactly { query, pages, one } (no writes)", async () => {
    class Ctrl extends AsValueHelpController {
      protected async query() {
        return { data: [], count: 0 };
      }
      protected async getOne() {
        return null;
      }
    }
    const ctrl = new Ctrl(valueHelpType(), "vh", makeApp().app);
    const meta = await ctrl.meta();
    expect(Object.keys(meta.crud).toSorted()).toEqual(["one", "pages", "query"]);
    expect(meta.crud.insert).toBeUndefined();
    expect(meta.crud.remove).toBeUndefined();
  });

  it("AsJsonValueHelpController inherits the readable trio", async () => {
    const ctrl = new AsJsonValueHelpController(valueHelpType(), [], makeApp().app);
    const meta = await ctrl.meta();
    expect(Object.keys(meta.crud).toSorted()).toEqual(["one", "pages", "query"]);
    expect(meta.crud.query).toEqual([...QUERY_CONTROLS]);
  });
});
