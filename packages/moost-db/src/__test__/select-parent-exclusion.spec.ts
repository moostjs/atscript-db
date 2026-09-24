import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, prepareFixtures } from "./test-utils";

/**
 * An exclusion `$select` is inverted into an inclusion list (so the preferred
 * id can be unioned in). Since 0.1.134 excluding a nested-object PARENT drops
 * its whole subtree, and excluding a leaf never keeps the parent as a whole —
 * before, `$select=-secret` still returned `secret` with every child.
 */

let PxDoc: any;
const ROW = { id: 1, label: "L", secret: { hash: "H", salt: "S" } };

beforeAll(async () => {
  await prepareFixtures();
  ({ PxDoc } = await import("./fixtures/parent-exclusion.as"));
});

describe("exclusion of a nested-object parent — nested-object adapter (memory)", () => {
  async function query(qs: string) {
    const db = createAdapter();
    const table = db.getTable(PxDoc);
    await db.getAdapter(PxDoc).ensureTable();
    await table.insertOne(ROW as never);
    const controller = new AsDbController(makeApp(), table as any);
    return (await controller.query(`?${qs}`)) as Array<Record<string, unknown>>;
  }

  it.each([
    ["$select=-secret", { id: 1, label: "L" }],
    ["$select=-secret,-label", { id: 1 }],
    ["$select=-secret.hash", { id: 1, label: "L", secret: { salt: "S" } }],
    ["$select=secret", { id: 1, secret: { hash: "H", salt: "S" } }],
    ["$select=-label", { id: 1, secret: { hash: "H", salt: "S" } }],
  ])("%s", async (qs, expected) => {
    expect(await query(qs)).toEqual([expected]);
  });
});

describe("exclusion of a nested-object parent — flattening adapter", () => {
  async function sentSelect(qs: string): Promise<string[]> {
    const adapters: MockAdapter[] = [];
    const db = new DbSpace(() => {
      const a = new MockAdapter();
      adapters.push(a);
      return a;
    });
    const controller = new AsDbController(makeApp(), db.getTable(PxDoc) as any);
    await controller.query(`?${qs}`);
    const call = adapters[0]!.calls.find((c) => c.method === "findMany")!;
    return [...(call.args[0].controls.$select.asArray as string[])].toSorted((a, b) =>
      a.localeCompare(b),
    );
  }

  it.each([
    ["$select=-secret", ["id", "label"]],
    ["$select=-secret,-label", ["id"]],
    ["$select=-secret.hash", ["id", "label", "secret__salt"]],
    ["$select=secret", ["id", "secret__hash", "secret__salt"]],
  ])("%s", async (qs, expected) => {
    expect(await sentSelect(qs)).toEqual(expected);
  });
});
