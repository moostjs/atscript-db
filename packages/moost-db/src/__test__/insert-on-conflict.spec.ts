import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbError, type DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { clearDbSpaces, closeDbSpaces, provideDbSpace } from "../db-space-registry";
import { createMockApp as makeApp, httpReplyFor, prepareFixtures } from "./test-utils";

/** `POST /?$onConflict=ignore` (since 0.1.148) and `closeDbSpaces()`. */

let IocItem: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ IocItem } = await import("./fixtures/insert-on-conflict.as"));
});

async function setup(
  ctrl: new (
    app: ReturnType<typeof makeApp>,
    table: never,
  ) => AsDbController = AsDbController as never,
) {
  const db = createAdapter();
  db.getTable(IocItem);
  await db.getAdapter(IocItem).ensureTable();
  await db.getAdapter(IocItem).syncIndexes();
  const table = db.getTable(IocItem) as any;
  await table.insertMany([{ id: 1, sku: "a", qty: 1 }]);
  return { db, table, controller: new ctrl(makeApp(), table as never) };
}

const row = (id: number, sku: string) => ({ id, sku, qty: 1 });

async function status(p: Promise<unknown>): Promise<number | undefined> {
  const r = await p.then(
    (v) => v,
    (e: unknown) => e,
  );
  return r instanceof HttpError ? r.body.statusCode : undefined;
}

describe("POST ?$onConflict=ignore", () => {
  it("array body: { insertedCount, insertedIds, inserted, conflicts }", async () => {
    const { controller, table } = await setup();
    const result = await controller.insert(
      [row(1, "dup"), row(2, "b"), row(3, "a")],
      "/items?$onConflict=ignore",
    );
    expect(result).toEqual({
      insertedCount: 1,
      insertedIds: [2],
      inserted: [1],
      conflicts: [0, 2],
    });
    expect(await table.count({ filter: {}, controls: {} })).toBe(2);
  });

  it("object body: { insertedId, conflict } / { conflict: true }", async () => {
    const { controller } = await setup();
    expect(await controller.insert(row(2, "b"), "?$onConflict=ignore")).toEqual({
      insertedId: 2,
      conflict: false,
    });
    expect(await controller.insert(row(3, "a"), "?$onConflict=ignore")).toEqual({
      conflict: true,
    });
  });

  it("without the control (or with $onConflict=error) a duplicate is still CONFLICT", async () => {
    const { controller } = await setup();
    await expect(controller.insert(row(2, "a"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(controller.insert(row(2, "a"), "?$onConflict=error")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await controller.insert(row(2, "b"))).toEqual({ insertedId: 2 });
  });

  it("a bad value and any other $ control answer 400", async () => {
    const { controller } = await setup();
    expect(await status(controller.insert(row(2, "b"), "?$onConflict=skip"))).toBe(400);
    expect(await status(controller.insert(row(2, "b"), "?$limit=1"))).toBe(400);
    // a malformed %-escape is the client's fault too, never a 500
    expect(await status(controller.insert(row(2, "b"), "?$onConflict=%E0%A4%A"))).toBe(400);
    expect(await status(controller.insert(row(2, "b"), "?$%E0%A4%A=1"))).toBe(400);
    expect(await status(controller.insert(row(2, "b"), "?$onConflict=ignore&$select=id"))).toBe(
      400,
    );
  });

  it("prepareRequest sees the mode and can refuse it", async () => {
    const seen: Array<TDbRequestContext["onConflict"]> = [];
    class Ctrl extends AsDbController {
      protected prepareRequest(ctx: TDbRequestContext) {
        seen.push(ctx.onConflict);
        if (ctx.onConflict === "ignore" && this.refuse) throw new HttpError(403, "no ignore");
      }
      refuse = false;
    }
    const { controller } = await setup(Ctrl);
    await controller.insert(row(2, "b"), "?$onConflict=ignore");
    await controller.insert(row(3, "c"));
    expect(seen).toEqual(["ignore", undefined]);
    (controller as unknown as { refuse: boolean }).refuse = true;
    expect(await status(controller.insert(row(4, "d"), "?$onConflict=ignore"))).toBe(403);
  });

  it("guardWrite and checkWrite still run with the mode", async () => {
    const guards: number[] = [];
    class Ctrl extends AsDbController {
      protected override guardWrite(ctx: { rows: unknown[] }) {
        guards.push(ctx.rows.length);
      }
    }
    const { controller } = await setup(Ctrl);
    await controller.insert([row(1, "a"), row(2, "b")], "?$onConflict=ignore");
    expect(guards).toEqual([2]);
  });

  it("/meta lists the onConflict control under crud.insert for adapters that support it", async () => {
    const { controller } = await setup();
    expect((await controller.meta()).crud.insert).toEqual(["onConflict"]);
  });
});

describe("DbError → HTTP status", () => {
  it("SPACE_CLOSED is 503, ON_CONFLICT_NOT_SUPPORTED stays 400", () => {
    expect(
      httpReplyFor(new DbError("SPACE_CLOSED", [{ path: "", message: "m" }])).body.statusCode,
    ).toBe(503);
    expect(
      httpReplyFor(new DbError("ON_CONFLICT_NOT_SUPPORTED", [{ path: "", message: "m" }])).body
        .statusCode,
    ).toBe(400);
  });
});

describe("closeDbSpaces()", () => {
  it("closes every distinct registered space once and clears the registry", async () => {
    clearDbSpaces();
    const a = createAdapter();
    const b = createAdapter();
    provideDbSpace(a);
    provideDbSpace(a, "alias");
    provideDbSpace(b, "other");
    await closeDbSpaces();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    const c = createAdapter();
    provideDbSpace(c);
    await closeDbSpaces();
    expect(c.closed).toBe(true);
    // registry cleared: nothing left to close
    await closeDbSpaces();
  });

  it("attempts every space and aggregates failures", async () => {
    clearDbSpaces();
    const ok = createAdapter();
    const bad: DbSpace = createAdapter();
    (bad as unknown as { close: () => Promise<void> }).close = () =>
      Promise.reject(new Error("boom"));
    provideDbSpace(bad, "bad");
    provideDbSpace(ok, "ok");
    const err = await closeDbSpaces().catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual(["boom"]);
    expect(ok.closed).toBe(true);
  });
});
