import { describe, it, expect, vi, beforeAll, beforeEach } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import { Client } from "../client";
import { ClientError } from "../client-error";

let UserType: TAtscriptAnnotatedType;
let serializedMeta: Record<string, unknown>;

beforeAll(async () => {
  const fixtures = await import("./fixtures/test-table.as");
  UserType = fixtures.User as unknown as TAtscriptAnnotatedType;
  serializedMeta = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    readOnly: false,
    relations: [],
    fields: {
      id: { sortable: true, filterable: true },
      name: { sortable: false, filterable: true },
    },
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

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/meta")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(serializedMeta),
      });
    }
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
    });
  });
}

describe("Client", () => {
  let fetchFn: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchFn = mockFetch([]);
  });

  // ── Construction ───────────────────────────────────────────────────────

  it("constructs with path and options", () => {
    const client = new Client("/api/users", { fetch: fetchFn });
    expect(client).toBeInstanceOf(Client);
  });

  it("strips trailing slash from path", async () => {
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.query();
    expect(fetchFn).toHaveBeenCalledWith("/api/users/query", expect.anything());
  });

  it("prepends baseUrl", async () => {
    const client = new Client("/api/users", {
      fetch: fetchFn,
      baseUrl: "https://example.com",
    });
    await client.query();
    expect(fetchFn).toHaveBeenCalledWith("https://example.com/api/users/query", expect.anything());
  });

  // ── Headers ────────────────────────────────────────────────────────────

  it("passes static headers", async () => {
    const client = new Client("/api/users", {
      fetch: fetchFn,
      headers: { Authorization: "Bearer token123" },
    });
    await client.query();
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token123");
  });

  it("calls async header factory", async () => {
    const client = new Client("/api/users", {
      fetch: fetchFn,
      headers: async () => ({ "X-Custom": "dynamic" }),
    });
    await client.query();
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Custom"]).toBe("dynamic");
  });

  // ── query (GET /query) ─────────────────────────────────────────────────

  it("query sends GET /query", async () => {
    fetchFn = mockFetch([{ id: 1, name: "Alice" }]);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.query();
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/users/query",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual([{ id: 1, name: "Alice" }]);
  });

  it("query with filter builds query string", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.query({ filter: { status: "active" } });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("status=active");
  });

  it("query with controls", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.query({
      controls: { $limit: 10, $skip: 20, $sort: { name: 1 } },
    });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$sort=name");
    expect(url).toContain("$limit=10");
    expect(url).toContain("$skip=20");
  });

  it("query with $search passes control through", async () => {
    fetchFn = mockFetch([{ id: 1, title: "matching" }]);
    const client = new Client("/api/posts", { fetch: fetchFn });
    await client.query({
      controls: { $search: "hello", $index: "title_idx" } as any,
    });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$search=hello");
    expect(url).toContain("$index=title_idx");
  });

  // ── count (GET /query with $count) ─────────────────────────────────────

  it("count sends $count control", async () => {
    fetchFn = mockFetch(42);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.count({ filter: { active: true } });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$count");
    expect(url).toContain("active=true");
    expect(result).toBe(42);
  });

  // ── aggregate (GET /query with $groupBy) ───────────────────────────────

  it("aggregate sends groupBy query", async () => {
    fetchFn = mockFetch([{ status: "active", count_star: 5 }]);
    const client = new Client("/api/orders", { fetch: fetchFn });
    const result = await client.aggregate({
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "total" }],
      },
    } as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$groupBy=status");
    expect(result).toEqual([{ status: "active", count_star: 5 }]);
  });

  // ── pages (GET /pages) ─────────────────────────────────────────────────

  it("pages sends GET /pages with $page and $size", async () => {
    const response = {
      data: [{ id: 1 }],
      page: 2,
      itemsPerPage: 5,
      pages: 10,
      count: 50,
    };
    fetchFn = mockFetch(response);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.pages(undefined, 2, 5);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("pages");
    expect(url).toContain("$page=2");
    expect(url).toContain("$size=5");
    expect(result.page).toBe(2);
    expect(result.count).toBe(50);
  });

  it("pages defaults to page 1, size 10", async () => {
    fetchFn = mockFetch({ data: [], page: 1, itemsPerPage: 10, pages: 0, count: 0 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.pages();
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$page=1");
    expect(url).toContain("$size=10");
  });

  it("pages with filter", async () => {
    fetchFn = mockFetch({ data: [], page: 1, itemsPerPage: 10, pages: 0, count: 0 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.pages({ filter: { active: true } });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("active=true");
    expect(url).toContain("$page=1");
  });

  // ── one (GET /one/:id) ─────────────────────────────────────────────────

  it("one with scalar id sends GET /one/:id", async () => {
    fetchFn = mockFetch({ id: "abc", name: "Alice" });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.one("abc" as any);
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/users/one/abc",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual({ id: "abc", name: "Alice" });
  });

  it("one with composite key sends GET /one?k1=v1&k2=v2", async () => {
    fetchFn = mockFetch({ tenantId: "t1", userId: "u1" });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.one({ tenantId: "t1", userId: "u1" } as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("tenantId=t1");
    expect(url).toContain("userId=u1");
  });

  it("one returns null on 404", async () => {
    fetchFn = mockFetch({ message: "Not found", statusCode: 404 }, 404);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.one("nonexistent" as any);
    expect(result).toBeNull();
  });

  // ── insert (POST /) ────────────────────────────────────────────────────

  it("insert single sends POST with JSON body", async () => {
    fetchFn = mockFetch({ insertedId: "abc" });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.insert({ name: "Alice", status: "active" });
    const writeCalls = fetchFn.mock.calls.filter(
      (c: string[]) => !(c[0] as string).endsWith("/meta"),
    );
    expect(writeCalls[0][1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Alice", status: "active" }),
      }),
    );
    expect(result.insertedId).toBe("abc");
  });

  it("insert array sends POST with array body", async () => {
    fetchFn = mockFetch({ insertedCount: 2, insertedIds: ["a", "b"] });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.insert([
      { name: "A", status: "active" },
      { name: "B", status: "active" },
    ]);
    expect(result.insertedCount).toBe(2);
    const writeCalls = fetchFn.mock.calls.filter(
      (c: string[]) => !(c[0] as string).endsWith("/meta"),
    );
    expect(JSON.parse(writeCalls[0][1].body as string)).toEqual([
      { name: "A", status: "active" },
      { name: "B", status: "active" },
    ]);
  });

  // ── update (PATCH /) ───────────────────────────────────────────────────

  it("update single sends PATCH with JSON body", async () => {
    fetchFn = mockFetch({ matchedCount: 1, modifiedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.update({ id: 1, name: "Updated" } as any);
    const writeCalls = fetchFn.mock.calls.filter(
      (c: string[]) => !(c[0] as string).endsWith("/meta"),
    );
    expect(writeCalls[0][1]).toEqual(expect.objectContaining({ method: "PATCH" }));
    expect(result.modifiedCount).toBe(1);
  });

  it("update array sends PATCH with array body", async () => {
    fetchFn = mockFetch({ matchedCount: 2, modifiedCount: 2 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.update([{ id: 1 }, { id: 2 }] as any);
    const writeCalls = fetchFn.mock.calls.filter(
      (c: string[]) => !(c[0] as string).endsWith("/meta"),
    );
    expect(writeCalls[0][1].method).toBe("PATCH");
    expect(JSON.parse(writeCalls[0][1].body as string)).toHaveLength(2);
  });

  // ── replace (PUT /) ────────────────────────────────────────────────────

  it("replace sends PUT", async () => {
    fetchFn = mockFetch({ matchedCount: 1, modifiedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.replace({ id: 1, name: "Full", status: "active" } as any);
    const writeCalls = fetchFn.mock.calls.filter(
      (c: string[]) => !(c[0] as string).endsWith("/meta"),
    );
    expect(writeCalls[0][1]).toEqual(expect.objectContaining({ method: "PUT" }));
  });

  // ── remove (DELETE /:id) ───────────────────────────────────────────────

  it("remove with scalar id sends DELETE /:id", async () => {
    fetchFn = mockFetch({ deletedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.remove("abc" as any);
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/users/abc",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result.deletedCount).toBe(1);
  });

  it("remove with composite key sends DELETE with query params", async () => {
    fetchFn = mockFetch({ deletedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.remove({ tenantId: "t1", userId: "u1" } as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("tenantId=t1");
    expect(url).toContain("userId=u1");
  });

  // ── meta (GET /meta) ──────────────────────────────────────────────────

  it("meta sends GET /meta and caches result", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/users", { fetch: fetchFn });

    const result1 = await client.meta();
    const result2 = await client.meta();

    const metaCalls = fetchFn.mock.calls.filter((c: string[]) =>
      (c[0] as string).endsWith("/meta"),
    );
    expect(metaCalls).toHaveLength(1);
    expect(result1).toEqual(serializedMeta);
    expect(result2).toBe(result1);
  });

  // ── Error Handling ─────────────────────────────────────────────────────

  it("throws ClientError on non-2xx response", async () => {
    fetchFn = mockFetch(
      {
        message: "Validation failed",
        statusCode: 400,
        errors: [{ path: "name", message: "required" }],
      },
      400,
    );
    const client = new Client("/api/users", { fetch: fetchFn });

    await expect(client.query()).rejects.toThrow(ClientError);
  });

  it("throws ClientError with statusText on non-JSON error", async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: () => Promise.reject(new Error("not json")),
    });
    const client = new Client("/api/users", { fetch: fn });
    await expect(client.query()).rejects.toThrow("Bad Gateway");
  });

  // ── URL encoding ───────────────────────────────────────────────────────

  it("encodes special characters in scalar id", async () => {
    fetchFn = mockFetch({ id: "a/b" });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.one("a/b" as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("one/a%2Fb");
  });

  it("encodes special characters in remove scalar id", async () => {
    fetchFn = mockFetch({ deletedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.remove("a/b" as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("a%2Fb");
  });

  // ── Content-Type ───────────────────────────────────────────────────────

  it("does not set Content-Type for GET requests", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.query();
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("sets Content-Type: application/json for POST", async () => {
    fetchFn = mockFetch({ insertedId: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.insert({ name: "test", status: "active" });
    const writeCalls = fetchFn.mock.calls.filter(
      (c: string[]) => !(c[0] as string).endsWith("/meta"),
    );
    expect((writeCalls[0][1].headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  // ── Client-side validation ─────────────────────────────────────────────

  it("accepts valid insert data (id optional due to @db.default.increment)", async () => {
    fetchFn = mockFetch({ insertedId: "abc" });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.insert({ name: "Alice", status: "active" });
    expect(result.insertedId).toBe("abc");
  });

  it("rejects insert with invalid data", async () => {
    fetchFn = mockFetch({ insertedId: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await expect(client.insert({ name: 123 } as any)).rejects.toThrow();
  });

  it("getValidator exposes flatMap and navFields", async () => {
    const client = new Client("/api/users", { fetch: fetchFn });
    const validator = await client.getValidator();
    expect(validator.flatMap).toBeInstanceOf(Map);
    expect(validator.flatMap.has("name")).toBe(true);
    expect(validator.navFields).toBeDefined();
    const idType = validator.flatMap.get("id");
    expect(idType?.metadata?.has("meta.id")).toBe(true);
    expect(idType?.metadata?.has("db.default.increment")).toBe(true);
  });
});
