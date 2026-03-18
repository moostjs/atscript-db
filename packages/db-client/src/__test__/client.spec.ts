import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Client } from "../client";
import { ClientError } from "../client-error";

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
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
    await client.findMany();
    expect(fetchFn).toHaveBeenCalledWith("/api/users/query", expect.anything());
  });

  it("prepends baseUrl", async () => {
    const client = new Client("/api/users", {
      fetch: fetchFn,
      baseUrl: "https://example.com",
    });
    await client.findMany();
    expect(fetchFn).toHaveBeenCalledWith("https://example.com/api/users/query", expect.anything());
  });

  // ── Headers ────────────────────────────────────────────────────────────

  it("passes static headers", async () => {
    const client = new Client("/api/users", {
      fetch: fetchFn,
      headers: { Authorization: "Bearer token123" },
    });
    await client.findMany();
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token123");
  });

  it("calls async header factory", async () => {
    const client = new Client("/api/users", {
      fetch: fetchFn,
      headers: async () => ({ "X-Custom": "dynamic" }),
    });
    await client.findMany();
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Custom"]).toBe("dynamic");
  });

  // ── findMany ───────────────────────────────────────────────────────────

  it("findMany sends GET /query", async () => {
    fetchFn = mockFetch([{ id: 1, name: "Alice" }]);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.findMany();
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/users/query",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual([{ id: 1, name: "Alice" }]);
  });

  it("findMany with filter builds query string", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.findMany({ filter: { status: "active" } });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("status=active");
  });

  it("findMany with controls", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.findMany({
      controls: { $limit: 10, $skip: 20, $sort: { name: 1 } },
    });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$sort=name");
    expect(url).toContain("$limit=10");
    expect(url).toContain("$skip=20");
  });

  // ── findOne ────────────────────────────────────────────────────────────

  it("findOne sends GET /query with $limit=1", async () => {
    fetchFn = mockFetch([{ id: 1 }]);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.findOne({ filter: { id: 1 } });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$limit=1");
    expect(result).toEqual({ id: 1 });
  });

  it("findOne returns null when empty", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.findOne({ filter: { id: 999 } });
    expect(result).toBeNull();
  });

  // ── findById ───────────────────────────────────────────────────────────

  it("findById with scalar id sends GET /one/:id", async () => {
    fetchFn = mockFetch({ id: "abc", name: "Alice" });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.findById("abc" as any);
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/users/one/abc",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual({ id: "abc", name: "Alice" });
  });

  it("findById with composite key sends GET /one?field1=val1&field2=val2", async () => {
    fetchFn = mockFetch({ tenantId: "t1", userId: "u1" });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.findById({ tenantId: "t1", userId: "u1" } as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("tenantId=t1");
    expect(url).toContain("userId=u1");
  });

  it("findById returns null on 404", async () => {
    fetchFn = mockFetch({ message: "Not found", statusCode: 404 }, 404);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.findById("nonexistent" as any);
    expect(result).toBeNull();
  });

  // ── count ──────────────────────────────────────────────────────────────

  it("count sends $count control", async () => {
    fetchFn = mockFetch(42);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.count({ filter: { active: true } });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$count");
    expect(result).toBe(42);
  });

  // ── findManyWithCount ──────────────────────────────────────────────────

  it("findManyWithCount uses pages endpoint", async () => {
    fetchFn = mockFetch({
      data: [{ id: 1 }],
      page: 1,
      itemsPerPage: 10,
      pages: 5,
      count: 42,
    });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.findManyWithCount({
      controls: { $limit: 10, $skip: 0 },
    });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("pages");
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.count).toBe(42);
  });

  // ── pages ──────────────────────────────────────────────────────────────

  it("pages sends GET /pages", async () => {
    const response = {
      data: [{ id: 1 }],
      page: 2,
      itemsPerPage: 5,
      pages: 10,
      count: 50,
    };
    fetchFn = mockFetch(response);
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.pages({
      controls: { $page: 2, $size: 5 } as any,
    });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("pages");
    expect(result.page).toBe(2);
    expect(result.count).toBe(50);
  });

  // ── search ─────────────────────────────────────────────────────────────

  it("search sends $search control", async () => {
    fetchFn = mockFetch([{ id: 1, title: "matching" }]);
    const client = new Client("/api/posts", { fetch: fetchFn });
    await client.search("hello");
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$search=hello");
  });

  it("search with indexName sends $index", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/posts", { fetch: fetchFn });
    await client.search("hello", undefined, "title_idx");
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$search=hello");
    expect(url).toContain("$index=title_idx");
  });

  // ── aggregate ──────────────────────────────────────────────────────────

  it("aggregate sends groupBy query", async () => {
    fetchFn = mockFetch([{ status: "active", count_star: 5 }]);
    const client = new Client("/api/orders", { fetch: fetchFn });
    const result = await client.aggregate({
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "total" }],
      },
    });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("$groupBy=status");
    expect(result).toEqual([{ status: "active", count_star: 5 }]);
  });

  // ── insertOne ──────────────────────────────────────────────────────────

  it("insertOne sends POST with JSON body", async () => {
    fetchFn = mockFetch({ insertedId: "abc" });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.insertOne({ name: "Alice" });
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/users",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Alice" }),
      }),
    );
    expect(result.insertedId).toBe("abc");
  });

  // ── insertMany ─────────────────────────────────────────────────────────

  it("insertMany sends POST with array body", async () => {
    fetchFn = mockFetch({ insertedCount: 2, insertedIds: ["a", "b"] });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.insertMany([{ name: "A" }, { name: "B" }]);
    expect(result.insertedCount).toBe(2);
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual([{ name: "A" }, { name: "B" }]);
  });

  // ── updateOne ──────────────────────────────────────────────────────────

  it("updateOne sends PATCH with JSON body", async () => {
    fetchFn = mockFetch({ matchedCount: 1, modifiedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.updateOne({ id: 1, name: "Updated" } as any);
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/users",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(result.modifiedCount).toBe(1);
  });

  // ── bulkUpdate ─────────────────────────────────────────────────────────

  it("bulkUpdate sends PATCH with array body", async () => {
    fetchFn = mockFetch({ matchedCount: 2, modifiedCount: 2 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.bulkUpdate([{ id: 1 }, { id: 2 }] as any);
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toHaveLength(2);
  });

  // ── replaceOne ─────────────────────────────────────────────────────────

  it("replaceOne sends PUT", async () => {
    fetchFn = mockFetch({ matchedCount: 1, modifiedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.replaceOne({ id: 1, name: "Full" } as any);
    expect(fetchFn).toHaveBeenCalledWith("/api/users", expect.objectContaining({ method: "PUT" }));
  });

  // ── deleteOne ──────────────────────────────────────────────────────────

  it("deleteOne with scalar id sends DELETE /:id", async () => {
    fetchFn = mockFetch({ deletedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    const result = await client.deleteOne("abc" as any);
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/users/abc",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(result.deletedCount).toBe(1);
  });

  it("deleteOne with composite key sends DELETE with query params", async () => {
    fetchFn = mockFetch({ deletedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.deleteOne({ tenantId: "t1", userId: "u1" } as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("tenantId=t1");
    expect(url).toContain("userId=u1");
  });

  // ── meta ───────────────────────────────────────────────────────────────

  it("meta sends GET /meta and caches result", async () => {
    const metaBody = {
      searchable: true,
      vectorSearchable: false,
      searchIndexes: [],
      primaryKeys: ["id"],
      readOnly: false,
      relations: [],
      fields: { id: { sortable: true, filterable: true } },
      type: {},
    };
    fetchFn = mockFetch(metaBody);
    const client = new Client("/api/users", { fetch: fetchFn });

    const result1 = await client.meta();
    const result2 = await client.meta();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result1).toEqual(metaBody);
    expect(result2).toBe(result1); // same reference — cached
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

    await expect(client.insertOne({})).rejects.toThrow(ClientError);
    try {
      await client.insertOne({});
    } catch (e) {
      const err = e as ClientError;
      expect(err.status).toBe(400);
      expect(err.body.message).toBe("Validation failed");
      expect(err.errors).toHaveLength(1);
      expect(err.errors[0].path).toBe("name");
    }
  });

  it("throws ClientError with statusText on non-JSON error", async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: () => Promise.reject(new Error("not json")),
    });
    const client = new Client("/api/users", { fetch: fn });
    await expect(client.findMany()).rejects.toThrow("Bad Gateway");
  });

  // ── URL encoding ───────────────────────────────────────────────────────

  it("encodes special characters in scalar id", async () => {
    fetchFn = mockFetch({ id: "a/b" });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.findById("a/b" as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("one/a%2Fb");
  });

  it("encodes special characters in deleteOne scalar id", async () => {
    fetchFn = mockFetch({ deletedCount: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.deleteOne("a/b" as any);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("a%2Fb");
  });

  // ── Content-Type ───────────────────────────────────────────────────────

  it("does not set Content-Type for GET requests", async () => {
    fetchFn = mockFetch([]);
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.findMany();
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("sets Content-Type: application/json for POST", async () => {
    fetchFn = mockFetch({ insertedId: 1 });
    const client = new Client("/api/users", { fetch: fetchFn });
    await client.insertOne({ name: "test" });
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
