import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { ValidatorError } from "@atscript/typescript/utils";
import {
  Moost,
  getMoostInfact,
  Label,
  definePipeFn,
  TPipePriority,
  defineInterceptor,
  defineBeforeInterceptor,
  TInterceptorPriority,
} from "moost";
import { MoostHttp, Post } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { DbActionRow, DbActionRows } from "../actions/db-action-row.decorator";
import { InputForm } from "../actions/db-action-input-form.decorator";
import { validationErrorTransform } from "../validation-interceptor";

/**
 * Regression coverage for SECURITY_REPORT.md Finding 3 (`Validator-error
 * envelope is HTTP 500 instead of 400 on multiple paths`). Asserts the
 * documented contract: a `ValidatorError` thrown anywhere in the write /
 * action / id-validation pipelines must surface as a structured HTTP 400
 * (via the `validationErrorTransform` interceptor stamped on
 * `AsReadableController` and inherited by `AsDbReadableController` /
 * `AsDbController`), not bubble as a generic 500.
 *
 * Three paths covered (sub-cases of Finding 3):
 *
 *   3a. `@db.json` column inner-shape validation — `ValidatorError` thrown
 *       by `validateBatch` (or any deeper nested-shape validator) inside
 *       `insertOne` / `bulkUpdate` reaches the catch.
 *   3b. Action `@InputForm` payload validation — `ValidatorError` thrown
 *       from a global `validatorPipe()` during arg-resolve (matches the
 *       atscript-ui `applyGlobalPipes(validatorPipe())` setup), or thrown
 *       from inside the action handler itself.
 *   3c. Identifier strict-mode rejection — `ValidatorError` thrown from
 *       `validateMultiId` / `validateSingleId` via the `dbActionIdsSlot` /
 *       `dbActionIdSlot` cached resolver wired by `@DbActionIDs` /
 *       `@DbActionID`.
 *
 * All three exercise the full Moost pipeline via `MoostHttp.request()`, so
 * the interceptor stack runs end-to-end and assertions match the wire-shape
 * a real HTTP client would observe.
 *
 * Negative-control verified: temporarily disabling
 * `@UseValidationErrorTransform()` on `AsReadableController` flips every
 * test to receive HTTP 500 — confirming the assertions hinge on the
 * interceptor and would catch any future regression of the contract.
 */

let TABLE_SEQ = 0;

function makeMockTable(overrides: Record<string, any> = {}) {
  const validator = {
    validate: vi.fn().mockReturnValue(true),
    errors: [] as Array<{ path: string; message: string }>,
  };
  // Unique tableName per call so each test gets a distinct Moost route
  // prefix — avoids `@prostojs/router` route-collision warnings emitted on
  // re-registration, which surface as `__DYE_YELLOW__` undefined refs in
  // unbuilt node_modules under Vitest.
  TABLE_SEQ++;
  const tableName = (overrides.tableName as string | undefined) ?? `items_${TABLE_SEQ}`;
  delete overrides.tableName;
  return {
    tableName,
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap: new Map([
      ["", {} as any],
      ["id", {} as any],
      ["name", {} as any],
      ["data", { metadata: new Map([["db.json", true]]) } as any],
    ]),
    primaryKeys: ["id"],
    preferredId: ["id"],
    identifications: [{ fields: ["id"], source: "primaryKey" }],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors: [
      { path: "id", ignored: false, isIndexed: true, designType: "string" },
      { path: "name", ignored: false, isIndexed: false, designType: "string" },
      { path: "data", ignored: false, isIndexed: false, designType: "object" },
    ],
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    getValidator: vi.fn().mockReturnValue(validator),
    resolveIdFilter: vi.fn().mockImplementation((id: unknown) => ({ id })),
    findMany: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    insertOne: vi.fn().mockResolvedValue({ insertedId: "1" }),
    insertMany: vi.fn().mockResolvedValue({ insertedCount: 0, insertedIds: [] }),
    replaceOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    bulkReplace: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    bulkUpdate: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    ...overrides,
  } as any;
}

async function buildApp(
  controllerCtor: any,
  opts: {
    pipes?: ReturnType<typeof definePipeFn>[];
    interceptors?: ReturnType<typeof defineInterceptor>[];
  } = {},
) {
  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  if (opts.pipes && opts.pipes.length > 0) {
    app.applyGlobalPipes(...opts.pipes);
  }
  if (opts.interceptors && opts.interceptors.length > 0) {
    app.applyGlobalInterceptors(...opts.interceptors);
  }
  app.registerControllers(controllerCtor);
  await app.init();
  return { app, http };
}

/**
 * Mirrors `@atscript/moost-validator`'s `validatorPipe()`: looks at
 * `metas.targetMeta.atscript_type` (stamped by `@InputForm`) and runs the
 * type's `.validator().validate(value)`. Throws `ValidatorError` on failure.
 *
 * Registered via `applyGlobalPipes(...)` on the demo's main.ts — exact same
 * lifecycle position as the real pipe, so this exercises the same
 * arg-resolve → throw → interceptor `error` path the bug report describes.
 */
function makeAtscriptInputFormPipe() {
  return definePipeFn<any>((value, metas, _level) => {
    const atType = (metas?.targetMeta as { atscript_type?: any } | undefined)?.atscript_type;
    if (atType && typeof atType.validator === "function") {
      const validator = atType.validator();
      validator.validate(value);
    }
    return value;
  }, TPipePriority.VALIDATE);
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

beforeEach(() => {
  // The DI cache keys SINGLETON instances by class — reset between tests.
  getMoostInfact()._cleanup();
});

describe("Finding 3a — @db.json column inner-shape ValidatorError surfaces as HTTP 400", () => {
  it("POST inner-validation failure returns structured 400", async () => {
    const table = makeMockTable();
    table.insertOne.mockRejectedValue(
      new ValidatorError([
        {
          path: "data.appearance",
          message: "Value does not match any of the allowed types",
        },
      ]),
    );

    @TableController(table)
    class ItemsControllerA extends AsDbController {}

    const { http } = await buildApp(ItemsControllerA);
    const res = await http.request(`/${table.tableName}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", data: { appearance: "bogus" } }),
    });
    const { status, body } = await readJson(res);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      errors: [{ path: "data.appearance" }],
    });
  });

  it("PATCH inner-validation failure returns structured 400", async () => {
    const table = makeMockTable();
    table.bulkUpdate.mockRejectedValue(
      new ValidatorError([{ path: "data.theme", message: "Invalid theme value" }]),
    );

    @TableController(table)
    class ItemsControllerB extends AsDbController {}

    const { http } = await buildApp(ItemsControllerB);
    const res = await http.request(`/${table.tableName}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ id: "1", data: { theme: "bogus" } }]),
    });
    const { status, body } = await readJson(res);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      errors: [{ path: "data.theme" }],
    });
  });
});

describe("Finding 3b — Action @InputForm payload ValidatorError surfaces as HTTP 400", () => {
  // Stub `.as`-compiled form type: validator throws `ValidatorError` when
  // `value.reason` isn't a string. Mirrors what `@InputForm(SuspendInput)` +
  // `validatorPipe()` produces in atscript-ui.
  const SuspendInput = {
    __is_atscript_annotated_type: true as const,
    name: "SuspendInput",
    validator: () => ({
      validate(value: unknown) {
        const v = value as { reason?: unknown };
        if (typeof v?.reason !== "string") {
          throw new ValidatorError([{ path: "reason", message: "Expected string" }]);
        }
        return true;
      },
    }),
  };

  it("rejects POST with bad @InputForm input as structured 400 (handler throws)", async () => {
    const table = makeMockTable();

    @TableController(table)
    class ItemsControllerC extends AsDbController {
      @Post("actions/suspend")
      @DbAction("suspend", { label: "Suspend" })
      @Label("Suspend")
      async suspend(
        @DbActionIDs() _ids: Array<Record<string, unknown>>,
        @InputForm(SuspendInput as any) _input: unknown,
      ): Promise<unknown> {
        // Simulate the action handler running validation explicitly and
        // throwing `ValidatorError` — same shape as a moost validator pipe
        // would produce when the @InputForm payload fails its strict shape.
        throw new ValidatorError([{ path: "reason", message: "Expected string, got number" }]);
      }
    }

    const { http } = await buildApp(ItemsControllerC);
    const res = await http.request(`/${table.tableName}/actions/suspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [{ id: "1" }], input: { reason: 42 } }),
    });
    const { status, body } = await readJson(res);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      errors: [{ path: "reason" }],
    });
  });

  it("rejects POST with bad @InputForm input as structured 400 (global validator pipe throws)", async () => {
    // Reproduces atscript-ui's exact setup: `app.applyGlobalPipes(validatorPipe())`
    // throws `ValidatorError` from arg-resolve when @InputForm value fails.
    const table = makeMockTable();

    @TableController(table)
    class ItemsControllerCC extends AsDbController {
      @Post("actions/suspend")
      @DbAction("suspend", { label: "Suspend" })
      @Label("Suspend")
      async suspend(
        @DbActionIDs() _ids: Array<Record<string, unknown>>,
        @InputForm(SuspendInput as any) _input: unknown,
      ): Promise<unknown> {
        return { ok: true };
      }
    }

    const { http } = await buildApp(ItemsControllerCC, {
      pipes: [makeAtscriptInputFormPipe()],
    });
    const res = await http.request(`/${table.tableName}/actions/suspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [{ id: "1" }], input: { reason: 42 } }),
    });
    const { status, body } = await readJson(res);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      errors: [{ path: "reason" }],
    });
  });

  it("rejects POST with bad @InputForm input as 400 even with BEFORE_ALL global interceptors (audit/latency-style)", async () => {
    // The bug report's environment also registers audit + latency interceptors
    // at BEFORE_ALL priority. Ensure they don't shadow the catch.
    const table = makeMockTable();

    @TableController(table)
    class ItemsControllerCD extends AsDbController {
      @Post("actions/suspend")
      @DbAction("suspend", { label: "Suspend" })
      @Label("Suspend")
      async suspend(
        @DbActionIDs() _ids: Array<Record<string, unknown>>,
        @InputForm(SuspendInput as any) _input: unknown,
      ): Promise<unknown> {
        return { ok: true };
      }
    }

    const auditLike = defineInterceptor(
      {
        after() {},
        error() {},
      },
      TInterceptorPriority.BEFORE_ALL,
    );
    const latencyLike = defineBeforeInterceptor(async () => {
      // no-op delay stand-in
    }, TInterceptorPriority.BEFORE_ALL);

    const { http } = await buildApp(ItemsControllerCD, {
      pipes: [makeAtscriptInputFormPipe()],
      interceptors: [auditLike, latencyLike],
    });
    const res = await http.request(`/${table.tableName}/actions/suspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [{ id: "1" }], input: { reason: 42 } }),
    });
    const { status, body } = await readJson(res);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      statusCode: 400,
      errors: [{ path: "reason" }],
    });
  });
});

describe("Finding 3c — Identifier strict-mode ValidatorError surfaces as HTTP 400", () => {
  it("POST action with `ids` containing unknown field returns structured 400", async () => {
    const table = makeMockTable();

    @TableController(table)
    class ItemsControllerD extends AsDbController {
      @Post("actions/suspend")
      @DbAction("suspend", { label: "Suspend" })
      @Label("Suspend")
      async suspend(@DbActionIDs() _ids: Array<Record<string, unknown>>): Promise<unknown> {
        return { ok: true };
      }
    }

    const { http } = await buildApp(ItemsControllerD);
    const res = await http.request(`/${table.tableName}/actions/suspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [{ id: "1", "; DROP TABLE users; --": 1 }] }),
    });
    const { status, body } = await readJson(res);

    expect(status).toBe(400);
    expect(body).toMatchObject({ statusCode: 400 });
    expect(Array.isArray((body as any).errors)).toBe(true);
  });

  it("POST action with bare-scalar `ids` returns structured 400", async () => {
    const table = makeMockTable();

    @TableController(table)
    class ItemsControllerE extends AsDbController {
      @Post("actions/suspend")
      @DbAction("suspend", { label: "Suspend" })
      @Label("Suspend")
      async suspend(@DbActionIDs() _ids: Array<Record<string, unknown>>): Promise<unknown> {
        return { ok: true };
      }
    }

    const { http } = await buildApp(ItemsControllerE);
    const res = await http.request(`/${table.tableName}/actions/suspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: "alice" }),
    });
    const { status, body } = await readJson(res);

    expect(status).toBe(400);
    expect(body).toMatchObject({ statusCode: 400 });
    expect(Array.isArray((body as any).errors)).toBe(true);
  });
});

/**
 * Finding 3c — gate-interceptor before-time throw. With `disabled: fn` +
 * `@DbActionRow*`, `buildGateInterceptor` runs at AFTER_GUARD=3 and its
 * `before` resolves the IDs slot, which throws `ValidatorError` on bad
 * shape. Moost registers each interceptor's `error` callback inside the
 * same loop as its `before` — so a throw at priority N skips registration
 * of error handlers at priority > N. Hence `validationErrorTransform`
 * must be at `BEFORE_ALL`, not `CATCH_ERROR`. Reverting the priority
 * flips both tests below to HTTP 500.
 */
describe("Finding 3c — gate-interceptor before-time throw", () => {
  const gateOpts = { label: "x", disabled: () => [false], requiredFields: ["id"] };

  async function runGate(controllerCtor: any, table: any, path: string, body: unknown) {
    const { http } = await buildApp(controllerCtor, {
      interceptors: [validationErrorTransform()],
    });
    const res = await http.request(`/${table.tableName}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return readJson(res);
  }

  function expect400Envelope(result: { status: number; body: any }) {
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ statusCode: 400 });
    expect(Array.isArray(result.body?.errors)).toBe(true);
  }

  it("@DbActionRows + disabled: bad-shape `ids` surfaces as HTTP 400", async () => {
    const table = makeMockTable();
    @TableController(table)
    class C extends AsDbController {
      @Post("actions/suspend")
      @DbAction("suspend", gateOpts)
      async suspend(
        @DbActionIDs() _ids: Array<Record<string, unknown>>,
        @DbActionRows() _rows: unknown[],
      ): Promise<unknown> {
        return { ok: true };
      }
    }
    expect400Envelope(await runGate(C, table, "actions/suspend", { ids: "alice" }));
  });

  it("@DbActionRow + disabled: bad-shape `id` surfaces as HTTP 400", async () => {
    const table = makeMockTable();
    @TableController(table)
    class C extends AsDbController {
      @Post("actions/archive")
      @DbAction("archive", gateOpts)
      async archive(
        @DbActionID() _id: Record<string, unknown>,
        @DbActionRow() _row: unknown,
      ): Promise<unknown> {
        return { ok: true };
      }
    }
    expect400Envelope(
      await runGate(C, table, "actions/archive", {
        id: { id: "1", "; DROP TABLE users; --": 1 },
      }),
    );
  });
});
