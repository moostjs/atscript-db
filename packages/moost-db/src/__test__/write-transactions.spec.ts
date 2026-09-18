import { describe, it, expect, vi, beforeAll, beforeEach } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";
import type { TDbRemoveGuardContext, TDbWriteGuardContext } from "@atscript/db";
import { HttpError, MoostHttp } from "@moostjs/event-http";
import { Moost, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp, createMockReadable, errorsOf, prepareFixtures } from "./test-utils";

/**
 * Write pipeline (since 0.1.128):
 *
 *   shape gate (400) → onWrite / onRemove (outside any transaction)
 *     → table op — the TABLE's transaction: validate → guard (only when
 *       guardWrite / guardRemove is overridden) → re-validate → write
 *     → 404 / 409 disambiguation after the table call
 *
 * The controller forwards its overridden guard as the table's `guard` write
 * option and nothing else: no controller-side validation, defaults or
 * transaction. Built-in failures are thrown as `HttpError`.
 */

async function expectHttpError(p: Promise<unknown>, statusCode: number): Promise<HttpError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).body.statusCode).toBe(statusCode);
  return err as HttpError;
}

type GuardFn = (ctx: TDbWriteGuardContext<any>) => void | Promise<void>;
type RemoveGuardFn = (ctx: TDbRemoveGuardContext<any>) => void | Promise<void>;

class GuardedController extends AsDbController {
  guardImpl: GuardFn = () => {};
  protected override guardWrite(ctx: TDbWriteGuardContext<any>): void | Promise<void> {
    return this.guardImpl(ctx);
  }
}

class RemoveGuardedController extends AsDbController {
  removeGuardImpl: RemoveGuardFn = () => {};
  protected override guardRemove(ctx: TDbRemoveGuardContext<any>): void | Promise<void> {
    return this.removeGuardImpl(ctx);
  }
}

const versioned = (overrides: Record<string, unknown> = {}) =>
  createMockReadable(
    { versionColumn: "version", ...overrides },
    { fields: ["id", "name", "status", "version"] },
  );

/** The trailing options argument of the last call of a mock write method. */
const optsOf = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.at(-1)?.[1];

// ── Wiring (mock table) ──────────────────────────────────────────────────────

describe("no guard override — the table is called exactly as before", () => {
  it("passes the body through with no options: no adapter access, no validation, no guard", async () => {
    const table = versioned();
    const controller = new AsDbController(createMockApp(), table);
    expect(await controller.insert({ name: "a" })).toEqual({ insertedId: "1" });
    expect(table.insertOne).toHaveBeenCalledWith({ name: "a" });
    expect(table.insertOne.mock.calls[0]).toHaveLength(1);
    expect(table.getAdapter).not.toHaveBeenCalled();
    expect(table.validator.validate).not.toHaveBeenCalled();
    await controller.update({ id: "1", name: "x" });
    expect(table.updateOne.mock.calls[0]).toHaveLength(1);
    await controller.remove("1");
    expect(table.deleteOne).toHaveBeenCalledWith("1");
    expect(table.deleteOne.mock.calls[0]).toHaveLength(1);
  });

  it("throws (not returns) the built-in HttpErrors: 500 Not saved / 404 / 400", async () => {
    const table = versioned({ deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }) });
    const controller = new AsDbController(createMockApp(), table);
    vi.spyOn(controller as any, "onWrite").mockReturnValue(undefined);
    const err = await expectHttpError(controller.insert({ name: "a" }), 500);
    expect(err.message).toBe("Not saved");
    await expectHttpError(controller.remove("nope"), 404);
    await expectHttpError(controller.removeComposite({ unknown: "x" }), 400);
  });

  it("onWrite returning an Error instance throws that error (was: passed on as data)", async () => {
    const table = versioned();
    const controller = new AsDbController(createMockApp(), table);
    vi.spyOn(controller as any, "onWrite").mockReturnValue(new HttpError(422, "nope"));
    await expectHttpError(controller.insert({ name: "a" }), 422);
    expect(table.insertOne).not.toHaveBeenCalled();
  });

  it("onRemove returning an Error instance throws that error", async () => {
    const table = versioned();
    const controller = new AsDbController(createMockApp(), table);
    vi.spyOn(controller as any, "onRemove").mockReturnValue(new HttpError(403));
    await expectHttpError(controller.remove("1"), 403);
    expect(table.deleteOne).not.toHaveBeenCalled();
  });

  // WHY: the shape gate covers the raw body; `onWrite` may return anything, so
  // its output is gated again — a hook that stops producing a saveable
  // payload is a server error, like returning `undefined`.
  it("onWrite returning a non-object, or the wrong single/many shape, is a 500 Not saved", async () => {
    const table = versioned();
    const controller = new AsDbController(createMockApp(), table);
    const cases: unknown[] = ["x", 42, null, [{ name: "a" }]];
    for (const returned of cases) {
      vi.spyOn(controller as any, "onWrite").mockReturnValue(returned);
      const err = await expectHttpError(controller.insert({ name: "a" }), 500);
      expect(err.message).toBe("Not saved");
    }
    vi.spyOn(controller as any, "onWrite").mockReturnValue({ name: "a" }); // object for a *Many action
    await expectHttpError(controller.insert([{ name: "a" }]), 500);
    vi.spyOn(controller as any, "onWrite").mockReturnValue([{ name: "a" }, 5]);
    await expectHttpError(controller.insert([{ name: "a" }]), 500);
    expect(table.insertOne).not.toHaveBeenCalled();
    expect(table.insertMany).not.toHaveBeenCalled();
  });
});

describe("shape gate (unconditional, before any hook)", () => {
  const cases: Array<[string, unknown, string]> = [
    ["null", null, ""],
    ["a string", "x", ""],
    ["a number", 42, ""],
    ["an array with a primitive", [1], "[0]"],
    ["an array with a non-object item", [{}, 5], "[1]"],
    ["an array with null", [{ id: 1 }, null], "[1]"],
  ];
  for (const [label, body, path] of cases) {
    it(`rejects ${label} with the validator envelope at path "${path}" and never calls onWrite`, async () => {
      const controller = new AsDbController(createMockApp(), versioned());
      const onWrite = vi.spyOn(controller as any, "onWrite");
      for (const call of [
        () => controller.insert(body),
        () => controller.replace(body),
        () => controller.update(body),
      ]) {
        const err = await expectHttpError(call(), 400);
        expect(err.body).toMatchObject({
          message: "Expected an object",
          statusCode: 400,
          errors: [{ path, message: "Expected an object" }],
        });
      }
      expect(onWrite).not.toHaveBeenCalled();
    });
  }

  it("accepts an empty array and a plain object", async () => {
    const controller = new AsDbController(createMockApp(), versioned());
    await expect(controller.insert([])).resolves.toBeDefined();
    await expect(controller.insert({})).resolves.toBeDefined();
  });
});

describe("guardWrite overridden — forwarded as the table's `guard` option", () => {
  it("every write method receives { guard } and the guard delegates to guardWrite with the table's ctx", async () => {
    const table = versioned();
    const controller = new GuardedController(createMockApp(), table);
    const seen: TDbWriteGuardContext<any>[] = [];
    controller.guardImpl = (ctx) => {
      seen.push(ctx);
    };
    await controller.insert({ name: "a" });
    await controller.insert([{ name: "a" }]);
    await controller.replace({ id: "1", name: "a" });
    await controller.replace([{ id: "1", name: "a" }]);
    await controller.update({ id: "1", name: "a" });
    await controller.update([{ id: "1", name: "a" }]);
    const ctx = {
      action: "insert",
      rows: [{ name: "a" }],
      expectedVersions: [undefined],
    } as unknown as TDbWriteGuardContext<any>;
    for (const fn of [
      table.insertOne,
      table.insertMany,
      table.replaceOne,
      table.bulkReplace,
      table.updateOne,
      table.bulkUpdate,
    ]) {
      const opts = optsOf(fn) as { guard: GuardFn };
      expect(typeof opts.guard).toBe("function");
      await opts.guard(ctx); // what the table does inside its transaction
    }
    expect(seen).toHaveLength(6);
    expect(seen.every((c) => c === ctx)).toBe(true); // the very ctx object the table built
    expect(table.getAdapter).not.toHaveBeenCalled(); // no controller-side transaction
    expect(table.validator.validate).not.toHaveBeenCalled(); // no controller-side validation
  });

  it("a guard throw propagates unchanged from the table call", async () => {
    const boom = new HttpError(403, "forbidden");
    const table = versioned({
      insertOne: vi.fn(async (_row: unknown, opts: { guard: GuardFn }) => {
        await opts.guard({ action: "insert", rows: [], expectedVersions: [] } as never);
        return { insertedId: "1" };
      }),
    });
    const controller = new GuardedController(createMockApp(), table);
    controller.guardImpl = () => {
      throw boom;
    };
    const err = await expectHttpError(controller.insert({ name: "a" }), 403);
    expect(err).toBe(boom);
  });

  it("PATCH: version is lifted to $cas before the table call; the disambiguation findOne runs after it", async () => {
    const order: string[] = [];
    const table = versioned({
      updateOne: vi.fn(async () => {
        order.push("updateOne");
        return { matchedCount: 0, modifiedCount: 0 };
      }),
      findOne: vi.fn(async () => {
        order.push("findOne");
        return { id: "u1", version: 6 };
      }),
    });
    const controller = new GuardedController(createMockApp(), table);
    const err = await expectHttpError(controller.update({ id: "u1", name: "n", version: 4 }), 409);
    expect((err.body as unknown as Record<string, unknown>).currentVersion).toBe(6);
    expect(table.updateOne.mock.calls[0]![0]).toEqual({
      id: "u1",
      name: "n",
      $cas: { version: 4 },
    });
    expect(order).toEqual(["updateOne", "findOne"]);
  });

  it("$cas on a non-versioned table reaches the table, which rejects it (DbError → 400 via the interceptor)", async () => {
    const table = createMockReadable({
      updateOne: vi.fn(async () => {
        throw new DbError("INVALID_QUERY", [{ path: "$cas", message: "no version column" }]);
      }),
    });
    const controller = new GuardedController(createMockApp(), table);
    await expect(controller.update({ id: "u1", $cas: { version: 1 } })).rejects.toBeInstanceOf(
      DbError,
    );
  });
});

describe("CAS reconciliation (shared reconcileCas)", () => {
  it("version + differing $cas → 400 at $cas; bulk → [i].$cas", async () => {
    const table = versioned();
    const controller = new AsDbController(createMockApp(), table);
    const single = await expectHttpError(
      controller.update({ id: "u1", version: 4, $cas: { version: 3 } }),
      400,
    );
    expect(errorsOf(single)).toEqual([
      { path: "$cas", message: 'Ambiguous version: "version" and "$cas.version" differ' },
    ]);
    const bulk = await expectHttpError(
      controller.replace([
        { id: "u1", name: "a" },
        { id: "u2", name: "b", version: 4, $cas: { version: 3 } },
      ]),
      400,
    );
    expect(errorsOf(bulk)[0]!.path).toBe("[1].$cas");
    expect(table.updateOne).not.toHaveBeenCalled();
    expect(table.bulkReplace).not.toHaveBeenCalled();
  });

  // WHY (review nit): a malformed `$cas` beside `version` used to be reported
  // as "ambiguous"; the shape check runs first and keeps separateCas's message.
  it("a malformed $cas beside version reports the separateCas message, not 'ambiguous'", async () => {
    const controller = new AsDbController(createMockApp(), versioned());
    const err = await expectHttpError(
      controller.update({ id: "u1", version: 4, $cas: { v: 4 } }),
      400,
    );
    expect(errorsOf(err)).toEqual([
      {
        path: "$cas.v",
        message: '$cas operator: key "v" does not match version column "version"',
      },
    ]);
    const bad = await expectHttpError(controller.update({ id: "u1", $cas: "x" }), 400);
    expect(errorsOf(bad)[0]!.message).toBe("$cas operator: must be a plain object");
  });
});

describe("guardRemove overridden", () => {
  it("DELETE /:id and DELETE /?composite forward { guard } to deleteOne; 404 after the table call", async () => {
    const table = versioned();
    const controller = new RemoveGuardedController(createMockApp(), table);
    let seen: TDbRemoveGuardContext<any> | undefined;
    controller.removeGuardImpl = (ctx) => {
      seen = ctx;
    };
    await controller.remove("5");
    expect(table.deleteOne.mock.calls[0]![0]).toBe("5");
    const opts = optsOf(table.deleteOne) as { guard: RemoveGuardFn };
    const ctx = { id: "5", filter: { id: "5" }, current: async () => null };
    await opts.guard(ctx as never);
    expect(seen).toBe(ctx);

    table.primaryKeys = ["taskId", "tagId"];
    table.identifications = [{ fields: ["taskId", "tagId"], source: "primaryKey" }];
    await controller.removeComposite({ taskId: "5", tagId: "1" });
    expect(table.deleteOne.mock.calls[1]![0]).toEqual({ taskId: "5", tagId: "1" });
    expect(typeof (optsOf(table.deleteOne) as { guard: unknown }).guard).toBe("function");

    table.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    await expectHttpError(controller.remove("5"), 404);
  });
});

describe("withTransaction helper", () => {
  it("delegates to the table's adapter", async () => {
    const table = versioned();
    const controller = new AsDbController(createMockApp(), table);
    const r = await (controller as any).withTransaction(async () => {
      table.order.push("fn");
      return 42;
    });
    expect(r).toBe(42);
    expect(table.order).toEqual(["begin", "fn", "commit"]);
  });
});

// ── End to end: a real AtscriptDbTable over the core MockAdapter ────────────

/** Records the transaction primitives and adapter writes in one ordered log. */
class TxAdapter extends MockAdapter {
  readonly order: string[] = [];
  protected override async _beginTransaction(): Promise<unknown> {
    this.order.push("begin");
    return "tx";
  }
  protected override async _commitTransaction(): Promise<void> {
    this.order.push("commit");
  }
  protected override async _rollbackTransaction(): Promise<void> {
    this.order.push("rollback");
  }
  override async insertMany(data: Array<Record<string, unknown>>) {
    this.order.push("insertMany");
    return super.insertMany(data);
  }
  override async updateOne(filter: any, data: Record<string, unknown>, ops?: any) {
    this.order.push("updateOne");
    return super.updateOne(filter, data, ops);
  }
  override async deleteOne(filter: any) {
    this.order.push("deleteOne");
    return super.deleteOne(filter);
  }
}

let GuardedItem: any;
let TABLE_SEQ = 0;

function realTable() {
  const adapter = new TxAdapter();
  const space = new DbSpace(() => adapter);
  const table = space.getTable(GuardedItem);
  return { adapter, table };
}

async function buildApp(controllerCtor: any) {
  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(controllerCtor);
  await app.init();
  return http;
}

async function readJson(res: Response | null) {
  if (!res) return { status: 0, body: null };
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

describe("through a real table (guard inside the table's transaction)", () => {
  beforeAll(async () => {
    await prepareFixtures();
    ({ GuardedItem } = await import("./fixtures/guarded.as"));
  });

  beforeEach(() => {
    getMoostInfact()._cleanup();
  });

  it("POST: begin → guard (defaults applied, enrichment kept) → insert → commit", async () => {
    const { adapter, table } = realTable();
    const controller = new GuardedController(createMockApp(), table as any);
    let seen: TDbWriteGuardContext<any> | undefined;
    controller.guardImpl = (ctx) => {
      adapter.order.push("guard");
      seen = ctx;
      ctx.rows[0].name = "enriched";
    };
    await controller.insert({ name: "a" });
    expect(adapter.order).toEqual(["begin", "guard", "insertMany", "commit"]);
    expect(seen!.action).toBe("insert");
    expect(seen!.rows).toEqual([{ name: "enriched", status: "todo" }]);
    const written = adapter.calls.find((c) => c.method === "insertMany")!.args[0][0];
    expect(written).toMatchObject({ name: "enriched", status: "todo" });
  });

  it("PATCH: guard sees $cas stripped + expectedVersions and the pre-image via current(i)", async () => {
    const { adapter, table } = realTable();
    await table.insertOne({ id: 1, name: "old" } as any);
    adapter.order.length = 0;
    const controller = new GuardedController(createMockApp(), table as any);
    let pre: unknown;
    let seen: TDbWriteGuardContext<any> | undefined;
    controller.guardImpl = async (ctx) => {
      seen = ctx;
      pre = await ctx.current(0);
    };
    await controller.update({ id: 1, name: "new", version: 3 });
    expect(seen!.action).toBe("update");
    expect(seen!.rows).toEqual([{ id: 1, name: "new" }]);
    expect(seen!.expectedVersions).toEqual([3]);
    expect(pre).toMatchObject({ id: 1, name: "old" });
    expect(adapter.order[0]).toBe("begin");
    expect(adapter.order.at(-1)).toBe("commit");
  });

  it("DELETE: guardRemove runs inside the transaction with current(); a throw rolls back", async () => {
    const { adapter, table } = realTable();
    await table.insertOne({ id: 1, name: "row" } as any);
    adapter.order.length = 0;
    const controller = new RemoveGuardedController(createMockApp(), table as any);
    controller.removeGuardImpl = async (ctx) => {
      adapter.order.push("guard");
      expect(ctx.id).toBe(1);
      expect(await ctx.current()).toMatchObject({ id: 1, name: "row" });
      throw new HttpError(409, "keep it");
    };
    // The core MockAdapter does not coerce ids (real adapters do via prepareId): pass the number.
    await expectHttpError(controller.remove(1 as never), 409);
    expect(adapter.order).toEqual(["begin", "guard", "rollback"]);
    expect(await table.findOne({ filter: { id: 1 }, controls: {} } as any)).toMatchObject({
      id: 1,
    });
  });

  // Each wire test binds the same fixture type under its own explicit prefix
  // (`_resolveHttpPath` stamps `db.http.path` on the type, which would
  // otherwise leak the first prefix into the second controller).
  it("wire: a thrown guard HttpError(403) renders as 403 and the table rolled back", async () => {
    const { adapter, table } = realTable();
    const prefix = `guarded_wire_${++TABLE_SEQ}`;

    @TableController(table as any, { prefix })
    class C extends AsDbController {
      protected override guardWrite(): void {
        adapter.order.push("guard");
        throw new HttpError(403, "guard says no");
      }
    }

    const http = await buildApp(C);
    const res = await http.request(`/${prefix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a" }),
    });
    const { status, body } = await readJson(res);
    expect(status).toBe(403);
    expect(body).toMatchObject({ statusCode: 403, message: "guard says no" });
    expect(adapter.order).toEqual(["begin", "guard", "rollback"]);
    expect(adapter.calls.find((c) => c.method === "insertMany")).toBeUndefined();
  });

  it("wire: the shape gate renders the 400 validator envelope", async () => {
    const { table } = realTable();
    const prefix = `shape_wire_${++TABLE_SEQ}`;

    @TableController(table as any, { prefix })
    class C extends AsDbController {}

    const http = await buildApp(C);
    const res = await http.request(`/${prefix}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ id: 1 }, "x"]),
    });
    const { status, body } = await readJson(res);
    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      message: "Expected an object",
      errors: [{ path: "[1]", message: "Expected an object" }],
    });
  });
});
