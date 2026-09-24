import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { BucketUnit } from "@atscript/db";
import { BUCKET_UNITS } from "@uniqu/core";
import { HttpError } from "@moostjs/event-http";
import { current } from "@wooksjs/event-core";
import { setControllerContext } from "moost";

import { AsDbController } from "../as-db.controller";
import { dbActionIdSlot } from "../actions/id-cache";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, errorsOf, prepareFixtures } from "./test-utils";
import { runInActionCtx } from "./actions-test-utils";

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
let HiddenCode: any;
let HiddenSlug: any;

/** Binds `Ctrl` over `type` (default: the scoped HiddenAccount controller), seeding `rows`. */
function bind(
  type: any = HiddenAccount,
  Ctrl: new (...args: any[]) => AsDbController = ScopedController,
  rows: Array<Record<string, unknown>> = [],
) {
  const adapters: MockAdapter[] = [];
  const db = new DbSpace(() => {
    const a = new BucketAdapter();
    adapters.push(a);
    return a;
  });
  db.getTable(HiddenOwner);
  const table = db.getTable(type);
  const controller = new Ctrl(makeApp(), table as any);
  const adapter = adapters[adapters.length - 1]!;
  adapter.store.set(
    table.tableName,
    rows.map((row) => ({ ...row })),
  );
  return { controller, adapter, table };
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
  ({ HiddenAccount, HiddenOwner, HiddenCode, HiddenSlug } =
    await import("./fixtures/hidden-fields.as"));
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

// ── Since 0.1.134: hidden names never leak through hints or identity ───────

/** Hides unique-key fields (`code`, `secret`, preferredId `slug`) and one object leaf. */
const HIDDEN_PATHS = new Set(["code", "secret", "slug", "contact.phone"]);

class HidingController extends AsDbController {
  protected override hasField(path: string): boolean {
    return super.hasField(path) && !HIDDEN_PATHS.has(path);
  }
}

/** Also hides the last visible leaf of `contact`. */
class AllLeavesHiddenController extends AsDbController {
  protected override hasField(path: string): boolean {
    return super.hasField(path) && !HIDDEN_PATHS.has(path) && path !== "contact.email";
  }
}

const ROW = {
  id: 1,
  code: "C-ALPHA",
  tenant: "t1",
  secret: "S-1",
  serial: "SER-1",
  title: "Alpha",
  contact: { email: "a@x", phone: "555" },
};
const SLUG_ROW = { id: 1, slug: "alpha", title: "Alpha" };

/** Awaits a result or a rejection — the HTTP layer renders both alike. */
async function outcome(pending: () => Promise<unknown>): Promise<unknown> {
  try {
    return await pending();
  } catch (error) {
    return error;
  }
}

/** Status + rendered body, with the probed name normalized — "hidden = nonexistent" byte for byte. */
function rendered(res: unknown, name?: string): string {
  expect(res).toBeInstanceOf(HttpError);
  const json = JSON.stringify((res as HttpError).body);
  return name ? json.split(name).join("<field>") : json;
}

describe("the nested-object hint lists visible leaves only", () => {
  it.each([
    "$sort=contact",
    "contact=x",
    "$exists=contact",
    "$select=contact,count(*):n&$groupBy=contact",
  ])("/query?%s never names a hidden sibling", async (qs) => {
    const { controller } = bind(HiddenCode, HidingController, [ROW]);
    const res = await controller.query(`?${qs}`);
    expect(errorsOf(res)).toEqual([
      {
        path: "contact",
        message:
          '"contact" is a nested object — filter or sort on one of its leaves (contact.email)',
      },
    ]);
    expect(JSON.stringify((res as HttpError).body)).not.toContain("phone");
  });

  it.each(["$sort=%s", "%s=x", "$exists=%s", "$select=%s,count(*):n&$groupBy=%s"])(
    "a parent whose every leaf is hidden answers like a nonexistent path (%s)",
    async (template) => {
      const { controller } = bind(HiddenCode, AllLeavesHiddenController, [ROW]);
      const hidden = await controller.query(`?${template.replaceAll("%s", "contact")}`);
      const missing = await controller.query(`?${template.replaceAll("%s", "nope")}`);
      expect(rendered(hidden, "contact")).toBe(rendered(missing, "nope"));
      expect(errorsOf(hidden)).toEqual([{ path: "contact", message: 'Unknown field "contact"' }]);
    },
  );

  it("an unscoped controller still lists every leaf", async () => {
    const { controller } = bind(HiddenCode, AsDbController, [ROW]);
    const res = await controller.query("?$sort=contact");
    expect(errorsOf(res)[0]!.message).toContain("(contact.email, contact.phone)");
  });
});

describe("a unique key over a hidden field is not an identification", () => {
  it("GET /one/:id — a hidden unique value answers like a missing one (no existence oracle)", async () => {
    const { controller, adapter } = bind(HiddenCode, HidingController, [ROW]);
    const hit = await controller.getOne("C-ALPHA", "");
    const miss = await controller.getOne("C-NOPE", "");
    expect((hit as HttpError).body.statusCode).toBe(404);
    expect(rendered(hit)).toBe(rendered(miss));
    // Only the visible unique key is tried — never the hidden `code`.
    expect(JSON.stringify(adapter.calls)).not.toContain('"code"');
  });

  it("GET /one/:id — a visible unique key still resolves", async () => {
    const { controller } = bind(HiddenCode, HidingController, [ROW]);
    expect(await controller.getOne("SER-1", "")).toMatchObject({ id: 1 });
  });

  it("GET /one/:id — the same lookup resolves when the field is visible (control)", async () => {
    const { controller } = bind(HiddenCode, AsDbController, [ROW]);
    expect(await controller.getOne("C-ALPHA", "")).toMatchObject({ id: 1 });
  });

  it.each([
    [{ code: "C-ALPHA" }, "?code=C-ALPHA"],
    [{ code: "C-NOPE" }, "?code=C-NOPE"],
    [{ tenant: "t1", secret: "S-1" }, "?tenant=t1&secret=S-1"],
  ])("GET /one?… — %j answers exactly like ?nope=x", async (query, url) => {
    const { controller, adapter } = bind(HiddenCode, HidingController, [ROW]);
    const hidden = await controller.getOneComposite(query as Record<string, string>, url);
    const missing = await controller.getOneComposite({ nope: "x" }, "?nope=x");
    expect(rendered(hidden)).toBe(rendered(missing));
    expect((hidden as HttpError).body).toMatchObject({
      statusCode: 400,
      message: "Query params do not match any primary key or unique index",
    });
    expect(adapter.calls.some((c) => c.method === "findOne")).toBe(false);
  });

  it("GET /one?… — a visible unique key still resolves", async () => {
    const { controller } = bind(HiddenCode, HidingController, [ROW]);
    expect(await controller.getOneComposite({ serial: "SER-1" }, "?serial=SER-1")).toMatchObject({
      id: 1,
    });
  });

  it("preferredId is always addressable, even when hasField hides it", async () => {
    const { controller } = bind(HiddenSlug, HidingController, [SLUG_ROW]);
    expect(await controller.getOne("alpha", "")).toMatchObject({ id: 1 });
    expect(await controller.getOneComposite({ slug: "alpha" }, "?slug=alpha")).toMatchObject({
      id: 1,
    });
  });

  it("DELETE /:id — a hidden unique value deletes nothing and answers like a missing one", async () => {
    const { controller, adapter, table } = bind(HiddenCode, HidingController, [ROW]);
    const hit = await outcome(() => controller.remove("C-ALPHA"));
    const miss = await outcome(() => controller.remove("C-NOPE"));
    expect((hit as HttpError).body.statusCode).toBe(404);
    expect(rendered(hit)).toBe(rendered(miss));
    expect(adapter.store.get(table.tableName)).toHaveLength(1);
    expect(JSON.stringify(adapter.calls)).not.toContain('"code"');
  });

  it("DELETE /?… — a hidden unique key answers like ?nope=x", async () => {
    const { controller } = bind(HiddenCode, HidingController, [ROW]);
    const hit = await outcome(() => controller.removeComposite({ code: "C-ALPHA" }));
    const missing = await outcome(() => controller.removeComposite({ nope: "x" }));
    expect(rendered(hit)).toBe(rendered(missing));
  });

  it("DELETE /:id — PK and visible unique keys still delete", async () => {
    const { controller, adapter, table } = bind(HiddenCode, HidingController, [ROW]);
    expect(await controller.remove("SER-1")).toEqual({ deletedCount: 1 });
    expect(adapter.store.get(table.tableName)).toHaveLength(0);
  });

  it("PATCH / — a PK-less body never identifies its row through a hidden unique key", async () => {
    const { controller, adapter } = bind(HiddenCode, HidingController, [ROW]);
    const hit = await outcome(() => controller.update({ code: "C-ALPHA", title: "X" }));
    const miss = await outcome(() => controller.update({ code: "C-NOPE", title: "X" }));
    expect(hit).toBeInstanceOf(Error);
    expect(JSON.stringify(hit)).toBe(JSON.stringify(miss).split("C-NOPE").join("C-ALPHA"));
    expect(adapter.calls.some((c) => c.method === "updateOne")).toBe(false);
    // A visible unique key still identifies the row.
    await controller.update({ serial: "SER-1", title: "X" });
    expect(adapter.calls.find((c) => c.method === "updateOne")!.args[0]).toEqual({
      serial: "SER-1",
    });
  });

  it("an action id through a hidden unique key is rejected like an unknown shape, which lists visible keys only", async () => {
    const { controller } = bind(HiddenCode, HidingController, [ROW]);
    const load = (body: string) =>
      runInActionCtx(body, async () => {
        setControllerContext(controller as never, "query", "/c/act");
        return outcome(() => current().get(dbActionIdSlot));
      });
    const hidden = await load('{"ids":{"code":"C-ALPHA"}}');
    const missing = await load('{"ids":{"nope":"x"}}');
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
    expect((hidden as Error).message).toContain("[id], [serial]");
    expect((hidden as Error).message).not.toMatch(/code|secret/);
    expect(await load('{"ids":{"serial":"SER-1"}}')).toEqual({ serial: "SER-1" });
  });

  it("idSource is one stable object per visibility outcome (per-source caches hit)", () => {
    const { controller } = bind(HiddenCode, HidingController);
    expect(controller.idSource).toBe(controller.idSource);
    expect(controller.idSource.identifications.map((i) => i.fields)).toEqual([["id"], ["serial"]]);
    // Nothing hidden → the readable itself.
    const plain = bind(HiddenCode, AsDbController);
    expect(plain.controller.idSource).toBe(plain.table);
  });
});
