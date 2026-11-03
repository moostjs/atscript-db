/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { HttpError, MoostHttp } from "@moostjs/event-http";
import { Inherit, Moost, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import type { TDbRequestContext } from "../as-readable.controller";
import { TableController } from "../decorators";
import { prepareFixtures } from "./test-utils";

/**
 * `POST /` with `Prefer: return=representation` (since 0.1.168) answers the
 * stored row as `row` — what `GET /one/<id>` answers the caller: defaults
 * applied, the read projection and the read overlay honoured — plus
 * `Preference-Applied`.
 */

let IrepNote: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ IrepNote } = await import("./fixtures/insert-representation.as"));
});

let SEQ = 0;

async function boot(
  opts: {
    overlay?: object;
    denyRead?: boolean;
    optIn?: boolean;
    failRead?: boolean;
    ids?: unknown[];
  } = {},
) {
  getMoostInfact()._cleanup();
  const notes = createAdapter().getTable(IrepNote);
  const prefix = `irep${++SEQ}`;
  const endpoints: string[] = [];

  @TableController(notes, prefix)
  @Inherit()
  class Notes extends AsDbController {
    protected override transformProjection(projection?: any): any {
      return projection ?? { secret: 0 };
    }

    protected prepareRequest(ctx: TDbRequestContext) {
      endpoints.push(ctx.endpoint);
      if (opts.denyRead && ctx.endpoint === "one") throw new HttpError(403, "no read");
    }

    transformOne(filter: any) {
      if (opts.failRead) throw new Error("read store down");
      return opts.overlay ? { ...filter, ...opts.overlay } : filter;
    }

    protected override returnRepresentation(): boolean {
      return opts.optIn !== false;
    }

    protected override resolveRowIds(ids: readonly any[]) {
      opts.ids?.push(...ids);
      return ids as any;
    }
  }

  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(Notes);
  await app.init();
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = (await http.request(`/${prefix}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }))!;
    return {
      status: res.status,
      applied: res.headers.get("preference-applied"),
      body: (await res.json()) as any,
    };
  };
  return { post, notes, endpoints };
}

const NOTE = { id: 1, title: "a", secret: "s", tenant: "t1" };

describe("POST / with Prefer: return=representation — opt-in", () => {
  it("a controller that does not opt in ignores the preference", async () => {
    const { post, endpoints } = await boot({ optIn: false });
    const res = await post(NOTE, { prefer: "return=representation" });
    expect(res.body).toEqual({ insertedId: 1 });
    expect(res.applied).toBeNull();
    expect(endpoints).toEqual(["insert"]);
  });

  it("is off on a plain AsDbController", () => {
    expect((AsDbController.prototype as any).returnRepresentation()).toBe(false);
  });

  it("a failing read-back answers the plain insert result, not a 500", async () => {
    const { post, notes } = await boot({ failRead: true });
    const res = await post(NOTE, { prefer: "return=representation" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ insertedId: 1 });
    expect(await notes.count({ filter: {}, controls: {} })).toBe(1);
  });

  it("resolveRowIds gets the id as GET /one/:id passes it (string form)", async () => {
    const ids: unknown[] = [];
    const { post } = await boot({ ids });
    await post(NOTE, { prefer: "return=representation" });
    expect(ids).toEqual(["1"]);
  });
});

describe("POST / with Prefer: return=representation", () => {
  it("answers the stored row as GET /one would, and Preference-Applied", async () => {
    const { post, endpoints } = await boot();
    const res = await post(NOTE, { prefer: "return=representation" });
    expect(res.status).toBe(201);
    expect(res.applied).toBe("return=representation");
    expect(res.body).toEqual({
      insertedId: 1,
      row: { id: 1, title: "a", status: "draft", tenant: "t1" },
    });
    expect(endpoints).toEqual(["insert", "one"]);
  });

  it("accepts the preference among others", async () => {
    const { post } = await boot();
    const res = await post(NOTE, { prefer: 'handling=lenient, return="representation"' });
    expect(res.body.row).toMatchObject({ id: 1, status: "draft" });
  });

  it("without the header: the plain result, no second prepareRequest", async () => {
    const { post, endpoints } = await boot();
    const res = await post(NOTE);
    expect(res.body).toEqual({ insertedId: 1 });
    expect(res.applied).toBeNull();
    expect(endpoints).toEqual(["insert"]);
    expect((await post({ ...NOTE, id: 2 }, { prefer: "return=minimal" })).body).toEqual({
      insertedId: 2,
    });
  });

  it("a row outside the read overlay, or no read grant: the insert stands, no row", async () => {
    const outside = await boot({ overlay: { tenant: "t2" } });
    const a = await outside.post(NOTE, { prefer: "return=representation" });
    expect(a.status).toBe(201);
    expect(a.body).toEqual({ insertedId: 1 });
    expect(a.applied).toBeNull();
    expect(await outside.notes.count({ filter: {}, controls: {} })).toBe(1);

    const denied = await boot({ denyRead: true });
    const b = await denied.post(NOTE, { prefer: "return=representation" });
    expect(b.status).toBe(201);
    expect(b.body).toEqual({ insertedId: 1 });
  });

  it("an array body ignores the preference", async () => {
    const { post } = await boot();
    const res = await post([NOTE, { ...NOTE, id: 2 }], { prefer: "return=representation" });
    expect(res.body).toMatchObject({ insertedCount: 2 });
    expect(res.body.row).toBeUndefined();
    expect(res.applied).toBeNull();
  });
});
