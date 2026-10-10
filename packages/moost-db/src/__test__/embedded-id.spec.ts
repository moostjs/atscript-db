import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { AsDbController } from "../as-db.controller";
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, prepareFixtures } from "./test-utils";

// An embedded object's `@meta.id` is not part of the host's key: `/meta`
// advertises the host's own `@meta.id` only and `/one/:id` takes that alone.

let EmbOrder: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ EmbOrder } = await import("./fixtures/embedded-id.as"));
});

function bind() {
  const db = new DbSpace(() => new MockAdapter());
  const table = db.getTable(EmbOrder);
  return { controller: new AsDbController(makeApp(), table as any), table };
}

describe("embedded @meta.id over HTTP", () => {
  it("/meta lists the host key only", async () => {
    const meta = await bind().controller.meta();
    expect(meta.primaryKeys).toEqual(["id"]);
    expect(meta.preferredId).toEqual(["id"]);
  });

  it("/one/:id resolves the host key alone", async () => {
    const { controller, table } = bind();
    const findOne = vi.spyOn(table, "findOne").mockResolvedValue({ id: 1 } as any);
    expect(await controller.getOne("1", "/one/1?")).toEqual({ id: 1 });
    expect(findOne.mock.calls[0]![0]).toMatchObject({ filter: { id: "1" } });
  });
});
