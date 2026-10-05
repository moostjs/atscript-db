import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, errorsOf, prepareFixtures } from "./test-utils";

/**
 * `/meta.fields[*].groupable` (since 0.1.148): present exactly when
 * `$groupBy` on the field passes the gate — physically filterable (adapter,
 * not write-only, not encrypted) and, on a table declaring dimensions /
 * measures, a dimension. The flag and the gate are one rule.
 */

const KEYS = { k1: randomBytes(32) };

let CapRow: any;
let CapTarget: any;
let CapManual: any;
let BucketTicket: any;

function bind(type: any, hasField?: (path: string) => boolean) {
  const db = new DbSpace(() => new MockAdapter(), {
    encryption: { defaultKeyId: "k1", keys: KEYS },
  });
  db.getTable(CapTarget);
  const table = db.getTable(type);
  class Ctrl extends AsDbController {
    protected override hasField(path: string): boolean {
      return (hasField?.(path) ?? true) && super.hasField(path);
    }
  }
  return new Ctrl(makeApp(), table as any);
}

async function groupAccepted(controller: AsDbController, path: string): Promise<HttpError | true> {
  const res = await controller.query(`?$groupBy=${path}&$select=${path},count()`);
  return res instanceof HttpError ? res : true;
}

beforeAll(async () => {
  await prepareFixtures();
  ({ CapRow, CapTarget, CapManual } = await import("./fixtures/capabilities.as"));
  ({ BucketTicket } = await import("./fixtures/bucket-tickets.as"));
});

describe("/meta.fields[*].groupable", () => {
  it("is present on plain fields, absent on write-only, encrypted and JSON-stored leaves (SQL)", async () => {
    const meta = await bind(CapRow).meta();
    expect(meta.fields.title.groupable).toBe(true);
    expect(meta.fields.rank.groupable).toBe(true);
    expect(meta.fields.apiSecret?.groupable).toBeUndefined();
    expect(meta.fields.prefs?.groupable).toBeUndefined();
    for (const [path, f] of Object.entries(meta.fields)) {
      if (path.startsWith("secret")) expect(f.groupable, path).toBeUndefined();
    }
  });

  it("every listed field: groupable ⇔ $groupBy accepted", async () => {
    const controller = bind(CapRow);
    const meta = await controller.meta();
    for (const [path, f] of Object.entries(meta.fields)) {
      const verdict = await groupAccepted(controller, path);
      expect(verdict === true, `"${path}"`).toBe(f.groupable === true);
    }
  });

  it("is physical: a manual-filter policy does not hide it", async () => {
    const meta = await bind(CapManual).meta();
    expect(meta.fields.other).toMatchObject({ filterable: false, groupable: true });
  });

  it("a strict table advertises dimensions only; $groupBy on another field is a 400 'not a dimension'", async () => {
    const controller = bind(BucketTicket);
    const meta = await controller.meta();
    expect(meta.fields.status.groupable).toBe(true);
    expect(meta.fields.openedAt.groupable).toBe(true);
    expect(meta.fields.points.groupable).toBeUndefined();
    expect(meta.fields.reviewedAt.groupable).toBeUndefined();
    expect(await groupAccepted(controller, "status")).toBe(true);
    const err = (await groupAccepted(controller, "points")) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(errorsOf(err)[0].path).toBe("points");
    expect(errorsOf(err)[0].message).toMatch(/not a dimension/);
  });

  it("a field hasField hides answers $groupBy with Unknown field (a permission overlay prunes /meta)", async () => {
    const controller = bind(CapRow, (p) => p !== "title");
    const err = (await groupAccepted(controller, "title")) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(errorsOf(err)[0].message).toBe('Unknown field "title"');
  });
});
