import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import type { AtscriptDbTable } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { Authenticate, HttpError, MoostHttp, defineAuthGuard } from "@moostjs/event-http";
import {
  Intercept,
  Moost,
  TInterceptorPriority,
  clearGlobalWooks,
  defineBeforeInterceptor,
  getMoostInfact,
  getMoostMate,
} from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { prepareFixtures } from "./test-utils";

// A table controller subclass with its own class-level `@Authenticate` /
// `@Intercept` keeps the base controller's validation-error transform (moost
// >= 0.7.2 adds class-level interceptors up along `extends` under `@Inherit`,
// which `@TableController` applies): an invalid write answers a structured
// 400, not a 500, while the guard still runs.

let SgUser: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ SgUser } = await import("./fixtures/security-gates.as"));
});

beforeEach(() => {
  clearGlobalWooks();
  getMoostInfact()._cleanup();
});

const guard = defineAuthGuard({ bearer: { format: "JWT" } }, (transports) => {
  if (transports.bearer !== "good") throw new HttpError(401, "bad token");
});

let seen: string[] = [];
const audit = defineBeforeInterceptor(() => {
  seen.push("audit");
}, TInterceptorPriority.INTERCEPTOR);

/** A fresh subclass per boot: `@TableController` decorates it once. */
function usersController() {
  @Authenticate(guard)
  @Intercept(audit)
  class UsersController extends AsDbController {}
  return UsersController;
}

async function usersTable(): Promise<AtscriptDbTable<any>> {
  const db = createAdapter();
  const table = db.getTable(SgUser) as any;
  await db.getAdapter(SgUser).ensureTable();
  return table;
}

async function boot() {
  const UsersController = usersController();
  TableController((await usersTable()) as never, "users")(UsersController);
  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(UsersController);
  await app.init();
  const post = async (body: unknown, token = "good") => {
    const res = (await http.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }))!;
    return { status: res.status, body: (await res.json()) as any };
  };
  return { post, UsersController };
}

describe("TableController subclass with a class-level @Authenticate / @Intercept", () => {
  it("keeps the base's validation-error transform next to its own interceptors", async () => {
    const { UsersController } = await boot();
    const interceptors = (getMoostMate().read(UsersController) as any).interceptors as Array<{
      handler: unknown;
      priority: number;
    }>;
    const priorities = interceptors.map((i) => i.priority);
    // the base's BEFORE_ALL transform, the guard and the subclass's own interceptor
    expect(priorities).toContain(TInterceptorPriority.BEFORE_ALL);
    expect(priorities).toContain(TInterceptorPriority.GUARD);
    expect(priorities).toContain(TInterceptorPriority.INTERCEPTOR);
    const transform = interceptors.find((i) => i.priority === TInterceptorPriority.BEFORE_ALL);
    expect(typeof (transform?.handler as { error?: unknown })?.error).toBe("function");
  });

  it("an invalid write answers the structured 400 while the guard runs", async () => {
    const { post } = await boot();
    seen = [];
    const invalid = await post({ id: 1 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "name" })]),
    );
    expect(seen).toEqual(["audit"]);

    const denied = await post({ id: 2, name: "n" }, "bad");
    expect(denied.status).toBe(401);

    const ok = await post({ id: 3, name: "n" });
    expect(ok.status).toBe(201);
  });
});
