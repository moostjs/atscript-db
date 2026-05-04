import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type { TDbActionInfo } from "@atscript/db";

import { Client } from "../client";
import { ActionNotFoundError, ActionUnsupportedError, ClientError } from "../client-error";

let UserType: TAtscriptAnnotatedType;
let baseMeta: Record<string, unknown>;

beforeAll(async () => {
  const fixtures = await import("./fixtures/test-table.as");
  UserType = fixtures.User as unknown as TAtscriptAnnotatedType;
  baseMeta = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
    type: serializeAnnotatedType(UserType, {
      processAnnotation: ({ key, value }) => {
        if (key.startsWith("meta.") || key.startsWith("expect.") || key.startsWith("db.rel.")) {
          return { key, value };
        }
        if (key === "db.json" || key === "db.patch.strategy" || key.startsWith("db.default")) {
          return { key, value };
        }
        if (key.startsWith("db.")) return undefined;
        return { key, value };
      },
    }),
  };
});

function metaWith(actions: TDbActionInfo[]): Record<string, unknown> {
  return { ...baseMeta, actions };
}

function fetchWith(actions: TDbActionInfo[], actionResponse: unknown = { message: "ok" }) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/meta")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(metaWith(actions)),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map() as unknown as Headers,
      json: () => Promise.resolve(actionResponse),
    });
  });
}

describe("Client.action — backend processor", () => {
  it("POSTs the object-shaped ID as a JSON body to the resolved path", async () => {
    const fetchFn = fetchWith([
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/api/users/actions/block",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    const result = await c.action("block", { id: "abc123" });

    expect(result).toEqual({ message: "ok" });
    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(postCall[0]).toBe("/api/users/actions/block");
    const init = postCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ ids: { id: "abc123" } });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("POSTs the composite ID object", async () => {
    const fetchFn = fetchWith([
      {
        name: "promote",
        label: "Promote",
        level: "row",
        processor: "backend",
        value: "/api/members/actions/promote",
      },
    ]);
    const c = new Client("/api/members", { fetch: fetchFn });
    await c.action("promote", { tenantId: "acme", userId: "u1" });

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({
      ids: {
        tenantId: "acme",
        userId: "u1",
      },
    });
  });

  it("throws TypeError when a single object is passed to a level: 'rows' action", async () => {
    const fetchFn = fetchWith([
      {
        name: "lock",
        label: "Lock",
        level: "rows",
        processor: "backend",
        value: "/api/users/actions/lock",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    // Server contract: rows-level requires an explicit array of identifier
    // objects. Single objects are not auto-wrapped; consumers must pass `[{...}]`.
    await expect(c.action("lock", { id: "abc" } as never)).rejects.toBeInstanceOf(TypeError);
  });

  it("throws TypeError when a non-object is passed to a level: 'row' action", async () => {
    const fetchFn = fetchWith([
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/api/users/actions/block",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await expect(c.action("block", "abc" as never)).rejects.toBeInstanceOf(TypeError);
    await expect(c.action("block", 42 as never)).rejects.toBeInstanceOf(TypeError);
    await expect(c.action("block", null as never)).rejects.toBeInstanceOf(TypeError);
  });

  it("passes an array ID through unchanged for level: 'rows'", async () => {
    const fetchFn = fetchWith([
      {
        name: "lock",
        label: "Lock",
        level: "rows",
        processor: "backend",
        value: "/api/users/actions/lock",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await c.action("lock", [{ id: "a" }, { id: "b" }, { id: "c" }]);

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({
      ids: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
  });

  it("sends no body for level: 'table' with no input", async () => {
    const fetchFn = fetchWith([
      {
        name: "refresh",
        label: "Refresh",
        level: "table",
        processor: "backend",
        value: "/api/users/actions/refresh",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await c.action("refresh");

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    const init = postCall[1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("wraps `input` in the envelope on a row-level action with @InputForm", async () => {
    const fetchFn = fetchWith([
      {
        name: "approve",
        label: "Approve",
        level: "row",
        processor: "backend",
        value: "/api/orders/actions/approve",
        inputForm: "CommentForm",
      },
    ]);
    const c = new Client("/api/orders", { fetch: fetchFn });
    await c.action("approve", { id: "o1" }, { note: "looks good" });

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({
      ids: { id: "o1" },
      input: { note: "looks good" },
    });
  });

  it("sends only `input` for a table-level action with @InputForm and no ID", async () => {
    const fetchFn = fetchWith([
      {
        name: "broadcast",
        label: "Broadcast",
        level: "table",
        processor: "backend",
        value: "/api/users/actions/broadcast",
        inputForm: "MessageForm",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await c.action("broadcast", undefined, { message: "hi" });

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({
      input: { message: "hi" },
    });
  });

  it("prepends baseUrl to the action's value path", async () => {
    const fetchFn = fetchWith([
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/api/users/actions/block",
      },
    ]);
    const c = new Client("/api/users", {
      fetch: fetchFn,
      baseUrl: "https://example.com",
    });
    await c.action("block", { id: "abc" });
    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(postCall[0]).toBe("https://example.com/api/users/actions/block");
  });

  it("propagates server errors as ClientError", async () => {
    const errBody = { statusCode: 400, message: "bad ID", errors: [] };
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/meta")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () =>
            Promise.resolve(
              metaWith([
                {
                  name: "block",
                  label: "Block",
                  level: "row",
                  processor: "backend",
                  value: "/api/users/actions/block",
                },
              ]),
            ),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: () => Promise.resolve(errBody),
      });
    });
    const c = new Client("/api/users", { fetch: fetchFn });
    await expect(c.action("block", { id: "abc" })).rejects.toBeInstanceOf(ClientError);
  });
});

describe("Client.action — navigate processor", () => {
  it("substitutes $1 with the URL-encoded preferred-id value and calls the navigate hook (level: 'row')", async () => {
    const fetchFn = fetchWith([
      {
        name: "edit",
        label: "Edit",
        level: "row",
        processor: "navigate",
        value: "/users/$1/edit",
      },
    ]);
    const navigate = vi.fn();
    const c = new Client("/api/users", { fetch: fetchFn, navigate });
    await c.action("edit", { id: "abc/123" });
    expect(navigate).toHaveBeenCalledWith("/users/abc%2F123/edit");
  });

  it("joins compound preferred-id values with `/` in preferredId field order, not object-key insertion order", async () => {
    // Override preferredId on the meta to a compound shape; submit the object
    // with keys in REVERSE order to lock in that the join walks
    // `meta.preferredId`, not `Object.values(id)`.
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/meta")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () =>
            Promise.resolve({
              ...baseMeta,
              primaryKeys: ["tenantId", "userId"],
              preferredId: ["tenantId", "userId"],
              actions: [
                {
                  name: "edit",
                  label: "Edit",
                  level: "row",
                  processor: "navigate",
                  value: "/members/$1/edit",
                } as TDbActionInfo,
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => ({}) });
    });
    const navigate = vi.fn();
    const c = new Client("/api/members", { fetch: fetchFn, navigate });
    // Object keys deliberately in reverse declaration order.
    await c.action("edit", { userId: "jane", tenantId: "acme/co" });
    expect(navigate).toHaveBeenCalledWith("/members/acme%2Fco/jane/edit");
  });

  it("renders a missing preferredId field as an empty URL segment (NOT literal 'undefined')", async () => {
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/meta")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () =>
            Promise.resolve({
              ...baseMeta,
              primaryKeys: ["tenantId", "userId"],
              preferredId: ["tenantId", "userId"],
              actions: [
                {
                  name: "edit",
                  label: "Edit",
                  level: "row",
                  processor: "navigate",
                  value: "/members/$1/edit",
                } as TDbActionInfo,
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => ({}) });
    });
    const navigate = vi.fn();
    const c = new Client("/api/members", { fetch: fetchFn, navigate });
    await c.action("edit", { tenantId: "acme" } as unknown as Record<string, unknown>);
    expect(navigate).toHaveBeenCalledWith("/members/acme//edit");
  });

  it("navigates to value verbatim for level: 'table' (no substitution)", async () => {
    const fetchFn = fetchWith([
      {
        name: "report",
        label: "Report",
        level: "table",
        processor: "navigate",
        value: "/reports/users",
      },
    ]);
    const navigate = vi.fn();
    const c = new Client("/api/users", { fetch: fetchFn, navigate });
    await c.action("report");
    expect(navigate).toHaveBeenCalledWith("/reports/users");
  });

  it("throws ActionUnsupportedError when no navigate option is supplied and no browser is available", async () => {
    const fetchFn = fetchWith([
      {
        name: "edit",
        label: "Edit",
        level: "row",
        processor: "navigate",
        value: "/users/$1/edit",
      },
    ]);
    // Stash and remove globalThis.location to simulate non-browser env.
    const originalLocation = (globalThis as { location?: unknown }).location;
    delete (globalThis as { location?: unknown }).location;
    try {
      const c = new Client("/api/users", { fetch: fetchFn });
      await expect(c.action("edit", { id: "abc" })).rejects.toBeInstanceOf(ActionUnsupportedError);
    } finally {
      if (originalLocation !== undefined) {
        (globalThis as { location?: unknown }).location = originalLocation;
      }
    }
  });
});

describe("Client.action — custom processor", () => {
  it("throws ActionUnsupportedError; clients must dispatch custom actions themselves", async () => {
    const fetchFn = fetchWith([
      {
        name: "exportCsv",
        label: "Export",
        level: "table",
        processor: "custom",
        value: "exportCsv",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await expect(c.action("exportCsv")).rejects.toBeInstanceOf(ActionUnsupportedError);
  });
});

describe("Client.action — unknown action", () => {
  it("throws ActionNotFoundError", async () => {
    const fetchFn = fetchWith([]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await expect(c.action("missing")).rejects.toBeInstanceOf(ActionNotFoundError);
  });
});

describe("Client.getActionForm — form-schema lookup", () => {
  function fetchWithForm(actions: TDbActionInfo[], formSchema: unknown) {
    return vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/meta")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve(metaWith(actions)),
        });
      }
      if (url.includes("/meta/form/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve(formSchema),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({}),
      });
    });
  }

  it("returns null for actions with no inputForm declared", async () => {
    const fetchFn = fetchWithForm(
      [
        {
          name: "block",
          label: "Block",
          level: "row",
          processor: "backend",
          value: "/api/users/actions/block",
        },
      ],
      null,
    );
    const c = new Client("/api/users", { fetch: fetchFn });
    const form = await c.getActionForm("block");
    expect(form).toBeNull();
    // No /meta/form/* request should have been made.
    expect(
      fetchFn.mock.calls.some((call: unknown[]) => String(call[0]).includes("/meta/form/")),
    ).toBe(false);
  });

  it("returns null when the action does not exist on /meta", async () => {
    const fetchFn = fetchWithForm([], null);
    const c = new Client("/api/users", { fetch: fetchFn });
    const form = await c.getActionForm("missing");
    expect(form).toBeNull();
  });

  it("fetches /meta/form/:name and deserializes the schema", async () => {
    const formSchema = serializeAnnotatedType(UserType, {});
    const fetchFn = fetchWithForm(
      [
        {
          name: "approve",
          label: "Approve",
          level: "row",
          processor: "backend",
          value: "/api/orders/actions/approve",
          inputForm: "User",
        },
      ],
      formSchema,
    );
    const c = new Client("/api/orders", { fetch: fetchFn });
    const form = await c.getActionForm("approve");
    expect(form).toBeTruthy();
    const formCall = fetchFn.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("/meta/form/"),
    )!;
    expect(formCall[0]).toBe("/api/orders/meta/form/User");
  });

  it("caches the deserialized schema across calls", async () => {
    const formSchema = serializeAnnotatedType(UserType, {});
    const fetchFn = fetchWithForm(
      [
        {
          name: "approve",
          label: "Approve",
          level: "row",
          processor: "backend",
          value: "/api/orders/actions/approve",
          inputForm: "User",
        },
      ],
      formSchema,
    );
    const c = new Client("/api/orders", { fetch: fetchFn });
    const a = await c.getActionForm("approve");
    const b = await c.getActionForm("approve");
    expect(a).toBe(b);
    const formCalls = fetchFn.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("/meta/form/"),
    );
    expect(formCalls).toHaveLength(1);
  });
});
