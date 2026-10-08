/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import type { TSerializeOptions } from "@atscript/typescript/utils";
import { MoostHttp } from "@moostjs/event-http";
import {
  Moost,
  Controller,
  ImportController,
  Injectable,
  MoostInit,
  clearGlobalWooks,
  getMoostInfact,
} from "moost";

import { AsDbController } from "../as-db.controller";
import { AsReadableController } from "../as-readable.controller";
import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { assertExposed } from "../assert-exposed";
import { clearDbSpaces } from "../db-space-registry";
import { TableController } from "../decorators";
import { DbDecorations } from "../decorations/db-decorations.decorator";
import { designTimeHttpPath } from "../http-path-design-time";
import { provideTestDbSpace } from "../testing";
import { publishDbHttpPaths } from "../http-path";
import { createMockApp, createMockReadable, prepareFixtures } from "./test-utils";

/**
 * FW-21: the value-help `db.http.path` is derived per app from each
 * controller's OWN bound route after registration (never from the ambient
 * prefix of whichever controller is being bound), with a canonical rule for
 * models served on several routes.
 */

await prepareFixtures();
const {
  HpTicket,
  HpPath,
  HpMembership,
  HpIssue,
  HpDoc,
  HpTag,
  HpTagUse,
  HpScoped,
  HpTicketDecorations,
} = (await import("./fixtures/http-path.as")) as Record<string, any>;
const ALL = [HpTicket, HpPath, HpMembership, HpIssue, HpDoc, HpTag, HpTagUse, HpScoped];
const KEY = "db.http.path";

@TableController(HpTicket)
class Ticket extends AsDbController {}

@TableController(HpPath)
class Path extends AsDbController {
  constructor(app: Moost, tickets: Ticket) {
    super(app);
    this.tickets = tickets;
  }
  readonly tickets: Ticket;
}

@TableController(HpIssue)
class Issue extends AsDbController {}

@TableController(HpMembership)
class Membership extends AsDbController {}

/** The shared controllers (DI singletons are reset in `beforeEach`). */
const defs = () => ({ Ticket, Path, Issue, Membership });

async function boot(
  controllers: unknown[],
  opts: { globalPrefix?: string; setup?: (app: Moost) => void } = {},
) {
  const warnings: string[] = [];
  const app = new Moost({ globalPrefix: opts.globalPrefix });
  const http = new MoostHttp();
  app.adapter(http);
  const real = app.getLogger.bind(app);
  vi.spyOn(app, "getLogger").mockImplementation(((topic?: string) =>
    topic === "moost-db"
      ? {
          warn: (m: unknown) => warnings.push(String(m)),
          info() {},
          error() {},
          log() {},
          debug() {},
        }
      : real(topic)) as never);
  opts.setup?.(app);
  app.registerControllers(...(controllers as never[]));
  await app.init();
  const get = async (path: string) => {
    const res = await http.request(path);
    const text = await res!.text();
    return { status: res!.status, body: text ? JSON.parse(text) : undefined, res: res! };
  };
  return { app, http, get, warnings };
}

const refPath = (meta: any, prop: string) => meta.type.type.props[prop].ref.type.metadata[KEY];

beforeEach(() => {
  clearGlobalWooks(); // MoostHttp routes live in a process-wide router
  getMoostInfact()._cleanup();
  clearDbSpaces();
  provideTestDbSpace(ALL);
});

describe("construction never stamps; the path comes from the controller's own route", () => {
  it("a controller first constructed as another's dependency is published right after init", async () => {
    const D = defs();
    const { get } = await boot(
      [
        ["db/paths", D.Path],
        ["db/tickets", D.Ticket],
        ["db/issues", D.Issue],
      ],
      { globalPrefix: "api" },
    );
    expect(HpTicket.metadata.get(KEY)).toBe("/api/db/tickets");
    expect(HpPath.metadata.get(KEY)).toBe("/api/db/paths");
    const meta = (await get("/api/db/issues/meta")).body;
    expect(refPath(meta, "activeTicketKey")).toBe("/api/db/tickets");
    expect(refPath(meta, "path")).toBe("/api/db/paths");
  });

  it("registration order does not matter", async () => {
    const D = defs();
    const { get } = await boot(
      [
        ["db/issues", D.Issue],
        ["db/tickets", D.Ticket],
        ["db/paths", D.Path],
      ],
      { globalPrefix: "api" },
    );
    expect(HpTicket.metadata.get(KEY)).toBe("/api/db/tickets");
    const meta = (await get("/api/db/issues/meta")).body;
    expect(refPath(meta, "activeTicketKey")).toBe("/api/db/tickets");
  });

  it("composes tuples, groups, import prefixes and a trailing-slash global prefix", async () => {
    const D = defs();
    @Controller("db")
    @ImportController("my", D.Ticket)
    class Group {}

    await boot([Group, ["x", D.Membership]], { globalPrefix: "/api/" });
    expect(HpTicket.metadata.get(KEY)).toBe("/api/db/my");
    expect(HpMembership.metadata.get(KEY)).toBe("/api/x");
  });
});

describe("several controllers over one model", () => {
  it("(a) canonical: true wins regardless of order", async () => {
    for (const order of [0, 1]) {
      getMoostInfact()._cleanup();
      clearGlobalWooks();
      @TableController(HpTicket, { canonical: true })
      class A1 extends AsDbController {}
      @TableController(HpTicket)
      class B1 extends AsDbController {}
      @TableController(HpIssue)
      class Issue1 extends AsDbController {}
      const { A, B, Issue } = { A: A1, B: B1, Issue: Issue1 };
      const list: unknown[] = [
        ["db/a", A],
        ["db/b", B],
        ["db/issues", Issue],
      ];
      if (order) list.reverse();
      const { get, warnings } = await boot(list);
      expect(refPath((await get("/db/issues/meta")).body, "activeTicketKey")).toBe("/db/a");
      expect(HpTicket.metadata.get(KEY)).toBe("/db/a");
      expect(warnings).toEqual([]);
    }
  });

  it("(b) canonical: false excludes a mount", async () => {
    @TableController(HpTicket, { canonical: false })
    class A2 extends AsDbController {}
    @TableController(HpTicket)
    class B2 extends AsDbController {}
    @TableController(HpIssue)
    class Issue2 extends AsDbController {}
    const { A, B, Issue } = { A: A2, B: B2, Issue: Issue2 };
    const { get, warnings } = await boot([
      ["db/a", A],
      ["db/b", B],
      ["db/issues", Issue],
    ]);
    expect(refPath((await get("/db/issues/meta")).body, "activeTicketKey")).toBe("/db/b");
    expect(warnings).toEqual([]);
  });

  it("(c) the annotation-derived mount beats an explicit-prefix mount", async () => {
    @TableController(HpDoc)
    class Docs extends AsDbController {}
    @TableController(HpDoc, "public-docs")
    class PublicDocs extends AsDbController {}
    const { get, warnings } = await boot([Docs, PublicDocs]);
    expect(HpDoc.metadata.get(KEY)).toBe("/hp-documents");
    expect((await get("/hp-documents/meta")).body.type.metadata[KEY]).toBe("/hp-documents");
    expect((await get("/public-docs/meta")).body.type.metadata[KEY]).toBe("/public-docs");
    expect(designTimeHttpPath(HpDoc)).toBe("hp-documents");
    expect(warnings).toEqual([]);
  });

  it("(d) two explicit mounts are ambiguous: one warning naming both, no path, mirror deleted", async () => {
    @TableController(HpTicket)
    class A3 extends AsDbController {}
    @TableController(HpTicket)
    class B3 extends AsDbController {}
    @TableController(HpIssue)
    class Issue3 extends AsDbController {}
    const { A, B, Issue } = { A: A3, B: B3, Issue: Issue3 };
    const { get, warnings } = await boot([
      ["db/a", A],
      ["db/b", B],
      ["db/issues", Issue],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Model "HpTicket"');
    expect(warnings[0]).toContain("at /db/a");
    expect(warnings[0]).toContain("at /db/b");
    expect(refPath((await get("/db/issues/meta")).body, "activeTicketKey")).toBeUndefined();
    expect(HpTicket.metadata.has(KEY)).toBe(false);
    // asking again does not warn again
    await get("/db/issues/meta");
    expect(warnings).toHaveLength(1);
  });

  it("(e) the same class imported twice is ambiguous", async () => {
    @TableController(HpTicket)
    class A4 extends AsDbController {}
    const { A } = { A: A4 };
    @Controller("one")
    @ImportController(A)
    class G1 {}
    @Controller("two")
    @ImportController(A)
    class G2 {}
    const { warnings } = await boot([G1, G2]);
    expect(warnings).toHaveLength(1);
    expect(HpTicket.metadata.has(KEY)).toBe(false);
  });

  it("(f) several canonical: true mounts on different routes give the conflict warning", async () => {
    @TableController(HpTicket, { canonical: true })
    class A5 extends AsDbController {}
    @TableController(HpTicket, { canonical: true })
    class B5 extends AsDbController {}
    const { A, B } = { A: A5, B: B5 };
    const { warnings } = await boot([
      ["db/a", A],
      ["db/b", B],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("has several canonical mounts");
    expect(HpTicket.metadata.has(KEY)).toBe(false);
  });

  it("(g) a parametric mount never publishes: the plain mount wins silently", async () => {
    @TableController(HpTicket)
    class A6 extends AsDbController {}
    @TableController(HpTicket)
    class B6 extends AsDbController {}
    const { A, B } = { A: A6, B: B6 };
    const { get, warnings } = await boot([
      ["db/:tenant/a", A],
      ["db/b", B],
    ]);
    expect(HpTicket.metadata.get(KEY)).toBe("/db/b");
    expect(warnings).toEqual([]);
    // the parametric mount's own root is left alone (canonical value)
    const meta = (await get("/db/x/a/meta")).body;
    expect(meta.type.metadata[KEY]).toBe("/db/b");
  });

  it("(g2) a model mounted only under a parametric route is unpublished, silently", async () => {
    @TableController(HpScoped)
    class Scoped extends AsDbController {}
    const { warnings } = await boot([["db/:tenant/s", Scoped]]);
    expect(HpScoped.metadata.has(KEY)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("(h) a value-help controller takes { canonical } through its constructor", async () => {
    @Controller("dicts/a")
    class DictA extends AsJsonValueHelpController {
      constructor(app: Moost) {
        super(HpTag, [], app, "tags-a", { canonical: true });
      }
    }
    @Controller("dicts/b")
    class DictB extends AsJsonValueHelpController {
      constructor(app: Moost) {
        super(HpTag, [], app, "tags-b");
      }
    }
    @TableController(HpTagUse)
    class Use extends AsDbController {}
    const { get, warnings } = await boot([DictA, DictB, ["db/uses", Use]]);
    expect(HpTag.metadata.get(KEY)).toBe("/dicts/a");
    expect(refPath((await get("/db/uses/meta")).body, "tag")).toBe("/dicts/a");
    expect(warnings).toEqual([]);
  });
});

describe("ctor → model records are per app", () => {
  it("another app constructing the same controller class for a different model does not unpublish this app's path", async () => {
    let model: any = HpTag;
    @Controller("dicts/x")
    class Dict extends AsJsonValueHelpController {
      constructor(app: Moost) {
        super(model, [], app, "dict-x");
      }
    }
    const { app, warnings } = await boot([Dict]);
    expect(HpTag.metadata.get(KEY)).toBe("/dicts/x");

    // a second app builds the SAME class for another model
    model = HpPath;
    const other = new Moost();
    new Dict(other);

    publishDbHttpPaths(app);
    expect(HpTag.metadata.get(KEY)).toBe("/dicts/x");
    expect(warnings).toEqual([]);
  });
});

describe("a controller's own /meta root", () => {
  it("is its own mount; references use the canonical path; the canonical response is stable", async () => {
    @TableController(HpTicket, { canonical: true })
    class Main extends AsDbController {}
    @TableController(HpTicket)
    class Archive extends AsDbController {}
    const { get } = await boot([
      ["db/main", Main],
      ["db/archive", Archive],
    ]);
    const archive = (await get("/db/archive/meta")).body;
    expect(archive.type.metadata[KEY]).toBe("/db/archive");
    // self-reference FK target → canonical, not the request's mount
    expect(refPath(archive, "parent")).toBe("/db/main");
    expect((await get("/db/main/meta")).body.type.metadata[KEY]).toBe("/db/main");
  });

  it("the cached canonical envelope is the same object across requests", async () => {
    const D = defs();
    await boot([["db/t", D.Ticket]]);
    const inst = (await import("moost")).getMoostInfact();
    const ctrl = (await (inst as any).get(D.Ticket)) as AsDbController;
    // direct calls (no event context) hand the cached envelope back untouched
    expect(await ctrl.meta()).toBe(await ctrl.meta());
  });
});

describe("apps", () => {
  it("alternating between two live apps' scopes rebuilds the caches each time", async () => {
    // moost's DI hands every request the latest app, so the app switch is driven
    // through the `currentApp()` seam with two published mock apps.
    class Switch extends AsDbController {
      current!: Moost;
      protected override async currentApp() {
        return this.current;
      }
    }
    const mk = (prefix: string) => {
      const app = createMockApp();
      app.getControllersOverview = () => [
        { type: Switch, computedPrefix: prefix, meta: {}, handlers: [] },
      ];
      return app as Moost;
    };
    const appA = mk("a/tickets");
    const appB = mk("b/tickets");
    const ctrl = new Switch(
      appA,
      createMockReadable(
        { tableName: "t", type: HpTicket, fieldDescriptors: [] },
        { fields: [] },
      ) as never,
    );
    const rootPath = async (app: Moost) => {
      ctrl.current = app;
      return ((await ctrl.meta()).type as any).metadata[KEY];
    };
    expect(await rootPath(appA)).toBe("/a/tickets");
    expect(await rootPath(appB)).toBe("/b/tickets");
    expect(await rootPath(appA)).toBe("/a/tickets");
  });

  it("sequential apps: a model the next app does not serve is restored to its design-time value", async () => {
    const D = defs();
    await boot([["db/t", D.Ticket]]);
    expect(HpTicket.metadata.get(KEY)).toBe("/db/t");
    getMoostInfact()._cleanup();
    @TableController(HpPath)
    class Other extends AsDbController {}
    await boot([["db/o", Other]]);
    expect(HpTicket.metadata.has(KEY)).toBe(false);
    expect(HpPath.metadata.get(KEY)).toBe("/db/o");
  });

  it("re-decoration after an earlier app does not double the prefix", async () => {
    @TableController(HpDoc)
    class First extends AsDbController {}
    await boot([First], { globalPrefix: "api" });
    expect(HpDoc.metadata.get(KEY)).toBe("/api/hp-documents");
    getMoostInfact()._cleanup();
    @TableController(HpDoc)
    class Second extends AsDbController {}
    const { get } = await boot([Second], { globalPrefix: "api" });
    const res = await get("/api/hp-documents/meta");
    expect(res.status).toBe(200);
    expect(res.body.type.metadata[KEY]).toBe("/api/hp-documents");
  });
});

describe("caches follow the scope they were built for", () => {
  it("/meta, /meta/form and decorations rebuild when the app scope changes", async () => {
    const { makeApp, fakeOverview } = await import("./actions-test-utils");
    const { createMockReadable } = await import("./test-utils");
    const type = HpTicket;
    class C extends AsDbController {}
    const ctx = makeApp();
    const overview = (prefix: string) => ({
      ...(fakeOverview(C, []) as object),
      computedPrefix: prefix,
    });
    ctx.setOverview([overview("p1")]);
    const ctrl = new C(
      ctx.app,
      createMockReadable({ tableName: "t", type, fieldDescriptors: [] }, { fields: [] }) as never,
    );
    expect((await ctrl.meta()).type.metadata?.[KEY]).toBe("/p1");
    ctx.setOverview([overview("p2")]);
    // same scope until something rebuilds it …
    expect((await ctrl.meta()).type.metadata?.[KEY]).toBe("/p1");
    // … a new controller → model pair does
    class Other extends AsDbController {}
    new Other(
      ctx.app,
      createMockReadable(
        { tableName: "u", type: HpPath, fieldDescriptors: [] },
        { fields: [] },
      ) as never,
    );
    expect((await ctrl.meta()).type.metadata?.[KEY]).toBe("/p2");
  });
});

describe("decorations are never served stale", () => {
  it("a decoration serialized before publish or under another scope is rebuilt", async () => {
    const { makeApp, fakeOverview } = await import("./actions-test-utils");
    @DbDecorations(HpTicketDecorations, { requires: {} } as never)
    class D extends AsDbController {
      serving?: Moost;
      protected override async currentApp() {
        return this.serving ?? this.app;
      }
    }
    const relatedPath = (meta: any) => meta.decorations.type.props.related.ref.type.metadata[KEY];
    const ctx = makeApp();
    const overview = (prefix: string) => ({
      ...(fakeOverview(D, []) as object),
      computedPrefix: prefix,
    });
    ctx.setOverview([overview("pre")]);
    const ctrl = new D(
      ctx.app,
      createMockReadable(
        { tableName: "t", type: HpTicket, fieldDescriptors: [] },
        { fields: [] },
      ) as never,
    );
    // built lazily, before any publish
    expect(relatedPath(await ctrl.meta())).toBe("/pre");
    // the mount changes and the app publishes: no pre-binding URL survives
    ctx.setOverview([overview("post")]);
    publishDbHttpPaths(ctx.app);
    expect(relatedPath(await ctrl.meta())).toBe("/post");
    // another app's scope rebuilds the shared decoration memo too
    const other = makeApp();
    other.setOverview([overview("other")]);
    ctrl.serving = other.app;
    expect(relatedPath(await ctrl.meta())).toBe("/other");
  });
});

describe("/meta/form follows the app scope", () => {
  it("rebuilds the cached form schema when the serving app's scope changes", async () => {
    const { fakeOverview, idMate, inputFormMate } = await import("./actions-test-utils");
    class FormCtrl extends AsReadableController {
      current!: Moost;
      protected hasField(): boolean {
        return true;
      }
      protected override async currentApp() {
        return this.current;
      }
    }
    const handler = {
      method: "approve",
      httpMethod: "POST" as const,
      path: "/x/actions/approve",
      action: { name: "approve", opts: { label: "Approve" } },
      paramMates: [idMate(), inputFormMate(HpIssue)],
    };
    const mk = (prefix: string) => {
      const app = createMockApp();
      app.getControllersOverview = () => [
        { ...(fakeOverview(FormCtrl, [handler]) as object), computedPrefix: prefix },
      ];
      return app as Moost;
    };
    const appA = mk("a/tickets");
    const appB = mk("b/tickets");
    const ctrl = new FormCtrl(HpTicket, "tickets", appA);
    const pathIn = async (app: Moost) => {
      ctrl.current = app;
      const form = (await ctrl.metaForm("HpIssue")) as any;
      return form.type.props.activeTicketKey.ref.type.metadata[KEY];
    };
    expect(await pathIn(appA)).toBe("/a/tickets");
    expect(await pathIn(appB)).toBe("/b/tickets");
    expect(await pathIn(appA)).toBe("/a/tickets");
  });
});

describe("FOR_EVENT controllers", () => {
  it("bind without error and are published with the SINGLETON ones", async () => {
    @TableController(HpPath)
    @Injectable("FOR_EVENT")
    class PerEvent extends AsDbController {}
    const D = defs();
    const { get } = await boot([
      ["db/p", PerEvent],
      ["db/t", D.Ticket],
      ["db/i", D.Issue],
    ]);
    expect(HpPath.metadata.get(KEY)).toBe("/db/p");
    expect(refPath((await get("/db/i/meta")).body, "path")).toBe("/db/p");
    expect((await get("/db/p/meta")).status).toBe(200);
  });

  it("a FOR_EVENT-only app publishes on first construction or first /meta", async () => {
    @TableController(HpPath)
    @Injectable("FOR_EVENT")
    class PerEvent extends AsDbController {}
    const { get } = await boot([["db/p", PerEvent]]);
    const res = await get("/db/p/meta");
    expect(res.body.type.metadata[KEY]).toBe("/db/p");
    expect(HpPath.metadata.get(KEY)).toBe("/db/p");
  });
});

describe("design-time hint and assertExposed", () => {
  it("assertExposed does not count another app's mirrored path", async () => {
    const D = defs();
    await boot([["db/t", D.Ticket]]);
    // HpTicket now carries a mirrored path, but never declared one
    const logger = { warn: vi.fn() };
    const missing = assertExposed(
      { getControllersOverview: () => [] } as never,
      [HpTicket, HpDoc],
      {
        logger,
      },
    );
    expect(missing).toEqual([HpDoc]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("serialization options", () => {
  it("a getSerializeOptions that strips the key leaves it out at the root and in refs", async () => {
    @TableController(HpIssue)
    class Issue extends AsDbController {
      protected override getSerializeOptions(): TSerializeOptions {
        const base = super.getSerializeOptions();
        return { ...base, ignoreAnnotations: [KEY] };
      }
    }
    const D = defs();
    const { get } = await boot([
      ["db/i", Issue],
      ["db/t", D.Ticket],
    ]);
    const meta = (await get("/db/i/meta")).body;
    expect(meta.type.metadata[KEY]).toBeUndefined();
    expect(refPath(meta, "activeTicketKey")).toBeUndefined();
  });

  it("a subclass annotationOverrides is composed and wins for the same key", async () => {
    @TableController(HpIssue)
    class Issue extends AsDbController {
      protected override getSerializeOptions(): TSerializeOptions {
        return {
          ...super.getSerializeOptions(),
          annotationOverrides: (t) => (t === HpTicket ? { [KEY]: "/custom" } : undefined),
        };
      }
    }
    const D = defs();
    const { get } = await boot([
      ["db/i", Issue],
      ["db/t", D.Ticket],
    ]);
    expect(refPath((await get("/db/i/meta")).body, "activeTicketKey")).toBe("/custom");
    expect(HpTicket.metadata.get(KEY)).toBe("/db/t");
  });

  it("serialization never mutates runtime metadata", async () => {
    class Switch extends AsDbController {
      current!: Moost;
      protected override async currentApp() {
        return this.current;
      }
    }
    const mk = (prefix: string) => {
      const app = createMockApp();
      app.getControllersOverview = () => [
        { type: Switch, computedPrefix: prefix, meta: {}, handlers: [] },
      ];
      return app as Moost;
    };
    const appA = mk("a/t");
    const appB = mk("b/t");
    const ctrl = new Switch(
      appA,
      createMockReadable(
        { tableName: "t", type: HpTicket, fieldDescriptors: [] },
        { fields: [] },
      ) as never,
    );
    publishDbHttpPaths(appA);
    publishDbHttpPaths(appB); // last published wins the compat mirror
    expect(HpTicket.metadata.get(KEY)).toBe("/b/t");
    ctrl.current = appA;
    expect(((await ctrl.meta()).type as any).metadata[KEY]).toBe("/a/t");
    expect(HpTicket.metadata.get(KEY)).toBe("/b/t");
  });
});

describe("init ordering", () => {
  it("a user @MoostInit at priority 0 already sees the canonical mirror", async () => {
    let seen: unknown;
    const D = defs();
    @Controller("hooks")
    class Hooks {
      @MoostInit()
      read() {
        seen = HpTicket.metadata.get(KEY);
      }
    }
    await boot([["db/t", D.Ticket], Hooks]);
    expect(seen).toBe("/db/t");
  });
});
