import { describe, it, expect, vi } from "vite-plus/test";
import type { FilterExpr } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import type { ValueHelpSelect } from "../as-value-help.controller";
import { makeValueHelpType } from "./actions-test-utils";

/**
 * Value-help scoping seams (since 0.1.143): `transformFilter` (row overlay on
 * `/query` / `/pages`, and `/one` rows in memory), `transformProjection`
 * (returned columns) and `hasField` (a hidden field answers like an unknown
 * one and never matches `$search`) — the same seams as the DB controllers,
 * so a permission layer needs no per-subclass boilerplate.
 */

type Doc = { id: number; owner: string; label: string; secret: string };

const ROWS: Doc[] = [
  { id: 1, owner: "u1", label: "Alpha", secret: "s1" },
  { id: 2, owner: "u2", label: "Beta", secret: "needle" },
  { id: 3, owner: "u1", label: "Gamma", secret: "s3" },
];

function makeApp() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };
  return { getLogger: vi.fn().mockReturnValue(logger) } as any;
}

function docType() {
  return makeValueHelpType({
    props: {
      id: { designType: "number", annotations: { "meta.id": true } },
      owner: { designType: "string" },
      label: { designType: "string", annotations: { "ui.dict.searchable": true } },
      secret: { designType: "string", annotations: { "ui.dict.searchable": true } },
    },
  });
}

class ScopedHelp extends AsJsonValueHelpController<any, Doc> {
  protected override async transformFilter(filter: FilterExpr): Promise<FilterExpr> {
    return { $and: [filter, { owner: "u1" }] } as FilterExpr;
  }
  protected override transformProjection(
    select: ValueHelpSelect<Doc> | undefined,
  ): ValueHelpSelect<Doc> | undefined {
    return select ?? { secret: 0 };
  }
  protected override hasField(path: string): boolean {
    return path !== "secret" && super.hasField(path);
  }
}

const scoped = () => new ScopedHelp(docType(), ROWS, makeApp());

function status(res: unknown): number | undefined {
  return res instanceof HttpError ? res.body.statusCode : undefined;
}

describe("value-help transformFilter", () => {
  it("is ANDed into /query and /pages", async () => {
    const ctrl = scoped();
    expect(((await ctrl.runQuery("")) as Doc[]).map((r) => r.id)).toEqual([1, 3]);
    expect(((await ctrl.runQuery("?label='Beta'")) as Doc[]).map((r) => r.id)).toEqual([]);
    const pages = (await ctrl.runPages("?$size=1")) as { data: Doc[]; count: number };
    expect(pages.count).toBe(2);
    expect(pages.data.map((r) => r.id)).toEqual([1]);
  });

  it("/one: a row outside the overlay answers exactly like a missing one", async () => {
    const ctrl = scoped();
    const foreign = await ctrl.runGetOne("2");
    const missing = await ctrl.runGetOne("99");
    expect(status(foreign)).toBe(404);
    expect(foreign).toEqual(missing);
    expect(await ctrl.runGetOneComposite({ id: "2" })).toEqual(missing);
  });
});

describe("value-help transformProjection", () => {
  it("restricts the columns of /query, /pages and /one", async () => {
    const ctrl = scoped();
    for (const row of (await ctrl.runQuery("")) as Doc[]) {
      expect(row).not.toHaveProperty("secret");
    }
    const pages = (await ctrl.runPages("")) as { data: Doc[] };
    expect(pages.data[0]).not.toHaveProperty("secret");
    expect(await ctrl.runGetOne("1")).toEqual({ id: 1, owner: "u1", label: "Alpha" });
    expect(await ctrl.runGetOneComposite({ id: "3" })).toEqual({
      id: 3,
      owner: "u1",
      label: "Gamma",
    });
  });
});

describe("value-help hasField", () => {
  it.each([["secret='s1'"], ["$sort=secret"], ["$select=label,secret"]])(
    "a hidden field in ?%s answers like an unknown one",
    async (qs) => {
      const ctrl = scoped();
      const hidden = await ctrl.runQuery(`?${qs}`);
      const unknown = await ctrl.runQuery(`?${qs.replace("secret", "nope")}`);
      expect(status(hidden)).toBe(400);
      expect((hidden as HttpError).body.message).toBe('Unknown field "secret"');
      expect((unknown as HttpError).body.message).toBe('Unknown field "nope"');
    },
  );

  it("a hidden searchable field never matches $search", async () => {
    const ctrl = scoped();
    expect(await ctrl.runQuery("?$search=needle")).toEqual([]);
    expect(((await ctrl.runQuery("?$search=gam")) as Doc[]).map((r) => r.id)).toEqual([3]);
    // Unscoped: the same search does match through `secret`.
    const plain = new AsJsonValueHelpController<any, Doc>(docType(), ROWS, makeApp());
    expect(((await plain.runQuery("?$search=needle")) as Doc[]).map((r) => r.id)).toEqual([2]);
  });
});

describe("defaults", () => {
  it("identity hooks leave every route unscoped", async () => {
    const ctrl = new AsJsonValueHelpController<any, Doc>(docType(), ROWS, makeApp());
    expect(await ctrl.runQuery("")).toEqual(ROWS);
    expect(await ctrl.runGetOne("2")).toEqual(ROWS[1]);
  });
});

describe("value-help prepareRequest", () => {
  it("runs first on /query, /pages and /one (before hasField / the hooks); a throw aborts", async () => {
    const seen: string[] = [];
    class Prepared extends ScopedHelp {
      protected prepareRequest(ctx: { endpoint: string }): void {
        seen.push(`prepare:${ctx.endpoint}`);
        if (ctx.endpoint === "pages") throw new HttpError(403);
      }
      protected override hasField(path: string): boolean {
        seen.push("hasField");
        return super.hasField(path);
      }
    }
    const ctrl = new Prepared(docType(), ROWS, makeApp());
    await ctrl.runQuery("?label='Alpha'");
    expect(seen[0]).toBe("prepare:query");
    expect(seen).toContain("hasField");
    seen.length = 0;
    await ctrl.runGetOne("1");
    await ctrl.runGetOneComposite({ id: "1" });
    expect(seen).toEqual(["prepare:one", "prepare:one"]);
    await expect(ctrl.runPages("")).rejects.toMatchObject({ body: { statusCode: 403 } });
  });
});
