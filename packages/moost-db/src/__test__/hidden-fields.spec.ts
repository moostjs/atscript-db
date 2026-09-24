import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { BucketUnit } from "@atscript/db";
import { BUCKET_UNITS } from "@uniqu/core";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, errorsOf, prepareFixtures } from "./test-utils";

/**
 * `hasField` is THE visibility hook (since 0.1.133): every gated path
 * consults it before any capability check, and a hidden field answers exactly
 * like a nonexistent one — a filter or sort on it must never act as a value
 * oracle (before 0.1.133 listed leaves skipped it).
 */

class BucketAdapter extends MockAdapter {
  override calendarBucketUnits(): ReadonlySet<BucketUnit> {
    return new Set(BUCKET_UNITS);
  }
}

/** Hides every path under the listed heads, like a projection-scoped viewer. */
const HIDDEN = new Set(["password", "lockedAt", "pin", "profile", "owner"]);

class ScopedController extends AsDbController {
  protected override hasField(path: string): boolean {
    return super.hasField(path) && !HIDDEN.has(path.split(".")[0]!);
  }
}

let HiddenAccount: any;
let HiddenOwner: any;

function bind() {
  const adapters: MockAdapter[] = [];
  const db = new DbSpace(() => {
    const a = new BucketAdapter();
    adapters.push(a);
    return a;
  });
  db.getTable(HiddenOwner);
  const table = db.getTable(HiddenAccount);
  const controller = new ScopedController(makeApp(), table as any);
  return { controller, adapter: adapters[adapters.length - 1]! };
}

async function unknownField(res: Promise<unknown>, path: string, url: string): Promise<void> {
  const err = await res;
  expect(err, url).toBeInstanceOf(HttpError);
  expect((err as HttpError).body.statusCode, url).toBe(400);
  expect(errorsOf(err)?.[0] ?? { message: (err as HttpError).body.message }, url).toMatchObject({
    message: `Unknown field "${path}"`,
  });
}

beforeAll(async () => {
  await prepareFixtures();
  ({ HiddenAccount, HiddenOwner } = await import("./fixtures/hidden-fields.as"));
});

describe("hasField hides a field from every gated position", () => {
  const HIDDEN_CASES: Array<[string, string]> = [
    ["password=abc", "password"],
    ["password~=/^a/", "password"],
    ["name=x^password=abc", "password"],
    ["!(password=abc)", "password"],
    ["(name=x^(points>1&password=abc))", "password"],
    ["$exists=password", "password"],
    ["$!exists=lockedAt", "lockedAt"],
    ["profile.bio=x", "profile.bio"],
    ["$sort=password", "password"],
    ["$sort=-lockedAt", "lockedAt"],
    ["$select=name,password", "password"],
    ["$select=-password", "password"],
    ["$select=profile", "profile"],
    ["$select=password,count(*):n&$groupBy=password", "password"],
    ["$select=name,sum(lockedAt):s&$groupBy=name", "lockedAt"],
    ["$select=name,count(*):n&$groupBy=name&$having=password>1", "password"],
    ["$select=bucket(lockedAt,day):d,count(*):n&$groupBy=d", "lockedAt"],
    ["$select=pin,count(*):n&$groupBy=pin", "pin"],
    ["owner.name=x", "owner.name"],
    ["$sort=owner", "owner"],
  ];

  it.each(HIDDEN_CASES)("/query?%s → Unknown field", async (qs, path) => {
    const { controller, adapter } = bind();
    await unknownField(controller.query(`?${qs}`), path, qs);
    expect(adapter.calls.some((c) => c.method === "findMany" || c.method === "aggregate")).toBe(
      false,
    );
  });

  it("the same field is answered like one that does not exist, on every read endpoint", async () => {
    const { controller } = bind();
    const hidden = await controller.pages("?password=abc");
    const missing = await controller.pages("?nope=abc");
    expect(errorsOf(hidden)).toEqual([{ path: "password", message: 'Unknown field "password"' }]);
    expect(errorsOf(missing)).toEqual([{ path: "nope", message: 'Unknown field "nope"' }]);
    await unknownField(controller.getOne("1", "?$select=password"), "password", "one/:id");
    await unknownField(controller.geo("?$center=0,0&$sort=password" as any), "password", "geo");
  });

  it("a hidden relation in $with is an unknown relation, and is not listed", async () => {
    const { controller } = bind();
    const res = await controller.query("?$with=owner");
    expect(res).toBeInstanceOf(HttpError);
    expect((res as HttpError).body.message).toBe(
      'Unknown relation "owner" in $with. Available relations: (none)',
    );
  });

  it("the $search fallback never matches on a hidden searchable field", async () => {
    const { controller, adapter } = bind();
    await controller.query("?$search=abc");
    const sent = adapter.calls.find((c) => c.method === "findMany")!.args[0];
    expect(JSON.stringify(sent.filter)).toContain('"name"');
    expect(JSON.stringify(sent.filter)).not.toContain("password");
  });

  it("visible fields in the same positions still pass", async () => {
    const { controller } = bind();
    for (const qs of [
      "name=abc",
      "name=x^points>1",
      "$exists=name",
      "$sort=-points",
      "$select=name,points",
      "$select=-points",
      "$select=name,count(*):n&$groupBy=name&$having=n>1",
      "$select=name,sum(points):s&$groupBy=name",
      "$search=abc",
    ]) {
      expect(await controller.query(`?${qs}`), qs).not.toBeInstanceOf(HttpError);
    }
  });
});
