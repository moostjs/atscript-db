import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "../index";

import { MockAdapter, prepareFixtures } from "./test-utils";

// Views inherit their sources' read seals (since 0.1.143): a view column over
// a @db.writeOnly field is write-only on the view, and one over a
// @db.encrypted field is encrypted on the view (decrypted on read, vetoed in
// filters / sorts) — a view never exposes a value differently from the table.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-seals.as");
});

const space = () =>
  new DbSpace(() => new MockAdapter(), {
    encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
  });

const flagged = (view: { flatMap: Map<string, any> }, annotation: string) =>
  [...view.flatMap]
    .filter(([, node]) => node?.metadata?.has(annotation))
    .map(([path]) => path)
    .toSorted();

describe("view field seals", () => {
  it("a column over a @db.writeOnly field (or a leaf of a write-only object) is write-only", () => {
    const view = space().getView(fx.SlAccountView);
    expect(flagged(view, "db.writeOnly")).toEqual([
      "apiKey",
      "note",
      "pin",
      "profile.recovery",
      "recovery",
    ]);
    // What HTTP layers read off the view type — the same seal as on the table.
    expect(view.type.type.props.get("pin")!.metadata.get("db.writeOnly")).toBe(true);
    expect(view.type.type.props.get("theme")!.metadata.has("db.writeOnly")).toBe(false);
  });

  it("a column over a @db.encrypted field is encrypted on the view", () => {
    const view = space().getView(fx.SlAccountView);
    expect(flagged(view, "db.encrypted")).toEqual(["token"]);
    expect(view.getMetadata().encryptedFields.has("token")).toBe(true);
    expect(view.fieldDescriptors.find((f) => f.path === "token")?.encrypted).toBe(true);
  });

  it("vetoes filters and sorts on an inherited encrypted column, as on the table", async () => {
    const view = space().getView(fx.SlAccountView);
    await expect(view.findMany({ filter: { token: "x" }, controls: {} })).rejects.toMatchObject({
      code: "ENC_FIELD_FILTER",
    });
    await expect(
      view.findMany({ filter: {}, controls: { $sort: { token: 1 } } }),
    ).rejects.toMatchObject({ code: "ENC_FIELD_SORT" });
  });

  it("carries the seals through a view over a view", () => {
    const view = space().getView(fx.SlViewOverView);
    expect(flagged(view, "db.writeOnly")).toEqual(["pinAgain"]);
    expect(flagged(view, "db.encrypted")).toEqual(["tokenAgain"]);
  });

  it("seals an aggregate over a write-only field; COUNT(*) reads no field", () => {
    const view = space().getView(fx.SlTotals);
    expect(flagged(view, "db.writeOnly")).toEqual(["maxPin"]);
  });

  it("rejects an aggregate over an encrypted field", () => {
    const view = space().getView(fx.SlBadAgg);
    const message =
      'View "sl_bad_agg" field "maxToken": @db.agg.max over the @db.encrypted field "token" — ciphertext cannot be aggregated';
    expect(() => view.getMetadata()).toThrow(message);
    // Every later use reports it too — a failed seal is never cached.
    expect(() => view.getViewColumnMappings()).toThrow(message);
  });

  it("leaves the source table's own metadata untouched", () => {
    const s = space();
    s.getView(fx.SlAccountView).getMetadata();
    const table = s.getTable(fx.SlAccount);
    expect(table.flatMap.get("title")!.metadata.has("db.writeOnly")).toBe(false);
    expect(table.flatMap.get("secrets.apiKey")!.metadata.has("db.writeOnly")).toBe(false);
  });
});
