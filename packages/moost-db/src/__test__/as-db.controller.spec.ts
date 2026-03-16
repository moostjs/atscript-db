import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { ValidatorError } from "@atscript/typescript/utils";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

// ── Mock table ──────────────────────────────────────────────────────────────

function createMockTable(overrides: Record<string, any> = {}) {
  const mockValidator = {
    validate: vi.fn().mockReturnValue(true),
    errors: [],
  };

  return {
    tableName: "test_table",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap: new Map([
      ["", {} as any],
      ["id", {} as any],
      ["name", {} as any],
      ["email", {} as any],
      ["status", {} as any],
      ["amount", {} as any],
      ["region", {} as any],
      ["total", {} as any],
    ]),
    primaryKeys: ["id"],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    getValidator: vi.fn().mockReturnValue(mockValidator),
    findMany: vi.fn().mockResolvedValue([{ id: "1", name: "Alice" }]),
    findOne: vi.fn().mockResolvedValue({ id: "1", name: "Alice" }),
    findById: vi.fn().mockResolvedValue({ id: "1", name: "Alice" }),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [{ id: "1", name: "Alice" }], count: 1 }),
    search: vi.fn().mockResolvedValue([{ id: "1", name: "Alice" }]),
    searchWithCount: vi.fn().mockResolvedValue({ data: [{ id: "1", name: "Alice" }], count: 1 }),
    count: vi.fn().mockResolvedValue(42),
    aggregate: vi.fn().mockResolvedValue([{ status: "active", total: 100 }]),
    insertOne: vi.fn().mockResolvedValue({ insertedId: "1" }),
    insertMany: vi.fn().mockResolvedValue({ insertedCount: 2, insertedIds: ["1", "2"] }),
    replaceOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    bulkReplace: vi.fn().mockResolvedValue({ matchedCount: 2, modifiedCount: 2 }),
    bulkUpdate: vi.fn().mockResolvedValue({ matchedCount: 2, modifiedCount: 2 }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    ...overrides,
  } as any;
}

// ── Mock app ──────────────────────────────────────────────────────────────

function createMockApp() {
  return {
    getLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  } as any;
}

// ── Helper: construct controller bypassing DI decorators ─────────────────

function createController(tableOverrides: Record<string, any> = {}) {
  const table = createMockTable(tableOverrides);
  const app = createMockApp();
  // Construct directly — @Inject is a no-op at runtime without Moost DI
  const controller = new AsDbController(table, app);
  return { controller, table, app };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("AsDbController", () => {
  let controller: AsDbController;
  let table: ReturnType<typeof createMockTable>;

  beforeEach(() => {
    const ctx = createController();
    controller = ctx.controller;
    table = ctx.table;
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should set up logger with table name", () => {
      const app = createMockApp();
      const t = createMockTable();
      new AsDbController(t, app);
      expect(app.getLogger).toHaveBeenCalledWith("db [test_table]");
    });
  });

  // ── GET /query ──────────────────────────────────────────────────────

  describe("query", () => {
    it("should call table.findMany for basic query", async () => {
      const result = await controller.query("/query?");
      expect(table.findMany).toHaveBeenCalled();
      expect(result).toEqual([{ id: "1", name: "Alice" }]);
    });

    it("should apply default limit of 1000", async () => {
      await controller.query("/query?");
      const call = table.findMany.mock.calls[0][0];
      expect(call.controls.$limit).toBe(1000);
    });

    it("should respect explicit limit", async () => {
      await controller.query("/query?$limit=50");
      const call = table.findMany.mock.calls[0][0];
      expect(call.controls.$limit).toBe(50);
    });

    it("should call table.count when $count is set", async () => {
      const result = await controller.query("/query?$count=true");
      expect(table.count).toHaveBeenCalled();
      expect(result).toBe(42);
    });

    it("should call table.search when $search is set and searchable", async () => {
      table.isSearchable.mockReturnValue(true);
      await controller.query("/query?$search=hello");
      expect(table.search).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({ filter: {} }),
        undefined,
      );
    });

    it("should pass $index to search", async () => {
      table.isSearchable.mockReturnValue(true);
      await controller.query("/query?$search=hello&$index=myIndex");
      expect(table.search).toHaveBeenCalledWith("hello", expect.any(Object), "myIndex");
    });

    it("should fall back to findMany when not searchable", async () => {
      table.isSearchable.mockReturnValue(false);
      await controller.query("/query?$search=hello");
      expect(table.search).not.toHaveBeenCalled();
      expect(table.findMany).toHaveBeenCalled();
    });

    it("should parse filter from URL", async () => {
      await controller.query("/query?name=Alice");
      const call = table.findMany.mock.calls[0][0];
      expect(call.filter).toEqual({ name: "Alice" });
    });

    it("should parse sort from URL", async () => {
      await controller.query("/query?$sort=name");
      const call = table.findMany.mock.calls[0][0];
      expect(call.controls.$sort).toEqual({ name: 1 });
    });

    it("should parse hex strings (e.g. ObjectId) in filter values without error", async () => {
      const result = await controller.query("/query?id=69aca32e434504011457636c");
      expect(result).not.toBeInstanceOf(HttpError);
      const call = table.findMany.mock.calls[0][0];
      expect(call.filter).toEqual({ id: "69aca32e434504011457636c" });
    });
  });

  // ── GET /query (aggregate) ──────────────────────────────────────────

  describe("query (aggregate)", () => {
    it("should call readable.aggregate when $groupBy is present", async () => {
      const result = await controller.query(
        "/query?$groupBy=status&$select=status,sum(amount):total",
      );
      expect(table.aggregate).toHaveBeenCalled();
      expect(table.findMany).not.toHaveBeenCalled();
      expect(result).toEqual([{ status: "active", total: 100 }]);
    });

    it("should return 400 when $groupBy and $with are combined", async () => {
      const ctx = createController({ relations: new Map([["tags", {}]]) });
      const result = await ctx.controller.query("/query?$groupBy=status&$with=tags");
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(400);
      expect((result as HttpError).body.message).toContain("$with");
      expect(ctx.table.aggregate).not.toHaveBeenCalled();
    });

    it("should pass $count through to aggregate", async () => {
      await controller.query("/query?$groupBy=status&$count=true");
      expect(table.aggregate).toHaveBeenCalled();
      const call = table.aggregate.mock.calls[0][0];
      expect(call.controls.$count).toBe(true);
    });

    it("should apply filter to aggregate query", async () => {
      await controller.query("/query?status=active&$groupBy=region");
      const call = table.aggregate.mock.calls[0][0];
      expect(call.filter).toEqual({ status: "active" });
    });

    it("should pass sort through to aggregate", async () => {
      await controller.query("/query?$groupBy=status&$select=status,sum(amount):total&$sort=total");
      const call = table.aggregate.mock.calls[0][0];
      expect(call.controls.$sort).toEqual({ total: 1 });
    });

    it("should pass pagination controls through to aggregate", async () => {
      await controller.query("/query?$groupBy=status&$skip=10&$limit=5");
      const call = table.aggregate.mock.calls[0][0];
      expect(call.controls.$skip).toBe(10);
      expect(call.controls.$limit).toBe(5);
    });

    it("should apply transformFilter to aggregate query", async () => {
      const ctx = createController();
      vi.spyOn(ctx.controller as any, "transformFilter").mockReturnValue({ tenant: "abc" });
      await ctx.controller.query("/query?$groupBy=status");
      const call = ctx.table.aggregate.mock.calls[0][0];
      expect(call.filter).toEqual({ tenant: "abc" });
    });
  });

  // ── GET /pages ──────────────────────────────────────────────────────

  describe("pages", () => {
    it("should call table.findManyWithCount", async () => {
      const result = await controller.pages("/pages?");
      expect(table.findManyWithCount).toHaveBeenCalled();
      expect(result).toEqual({
        data: [{ id: "1", name: "Alice" }],
        page: 1,
        itemsPerPage: 10,
        pages: 1,
        count: 1,
      });
    });

    it("should respect $page and $size", async () => {
      table.findManyWithCount.mockResolvedValue({
        data: [{ id: "2", name: "Bob" }],
        count: 50,
      });
      const result = (await controller.pages("/pages?$page=3&$size=5")) as any;
      expect(result.page).toBe(3);
      expect(result.itemsPerPage).toBe(5);
      expect(result.pages).toBe(10);
      expect(result.count).toBe(50);
      // Check skip/limit passed to table
      const call = table.findManyWithCount.mock.calls[0][0];
      expect(call.controls.$skip).toBe(10); // (3-1)*5
      expect(call.controls.$limit).toBe(5);
    });

    it("should use searchWithCount when $search and searchable", async () => {
      table.isSearchable.mockReturnValue(true);
      await controller.pages("/pages?$search=hello");
      expect(table.searchWithCount).toHaveBeenCalledWith("hello", expect.any(Object), undefined);
      expect(table.findManyWithCount).not.toHaveBeenCalled();
    });

    it("should default page to 1 and size to 10", async () => {
      await controller.pages("/pages?");
      const call = table.findManyWithCount.mock.calls[0][0];
      expect(call.controls.$skip).toBe(0);
      expect(call.controls.$limit).toBe(10);
    });
  });

  // ── GET /one/:id ──────────────────────────────────────────────────

  describe("getOne", () => {
    it("should call table.findById with id", async () => {
      const result = await controller.getOne("123", "/one/123?");
      expect(table.findById).toHaveBeenCalledWith("123", expect.any(Object));
      expect(result).toEqual({ id: "1", name: "Alice" });
    });

    it("should return 404 when not found", async () => {
      table.findById.mockResolvedValue(null);
      const result = await controller.getOne("999", "/one/999?");
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(404);
    });

    it("should reject filtering on one endpoint", async () => {
      const result = await controller.getOne("123", "/one/123?name=Alice");
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(400);
    });
  });

  // ── GET /one (composite key) ──────────────────────────────────────

  describe("getOneComposite", () => {
    it("should call findById with composite PK object from query", async () => {
      const ctx = createController({ primaryKeys: ["taskId", "tagId"] });
      const result = await ctx.controller.getOneComposite(
        { taskId: "5", tagId: "1" },
        "/one?taskId=5&tagId=1",
      );
      expect(ctx.table.findById).toHaveBeenCalledWith(
        { taskId: "5", tagId: "1" },
        expect.any(Object),
      );
      expect(result).toEqual({ id: "1", name: "Alice" });
    });

    it("should call findById via compound unique index", async () => {
      const ctx = createController({
        indexes: new Map([
          [
            "email_tenant",
            {
              key: "email_tenant",
              name: "email_tenant",
              type: "unique",
              fields: [
                { name: "email", sort: "asc" },
                { name: "tenantId", sort: "asc" },
              ],
            },
          ],
        ]),
      });
      const result = await ctx.controller.getOneComposite(
        { email: "alice", tenantId: "T1" },
        "/one?email=alice&tenantId=T1",
      );
      expect(ctx.table.findById).toHaveBeenCalledWith(
        { email: "alice", tenantId: "T1" },
        expect.any(Object),
      );
      expect(result).toEqual({ id: "1", name: "Alice" });
    });

    it("should return 400 when query params match no composite key or unique index", async () => {
      const ctx = createController({ primaryKeys: ["taskId", "tagId"] });
      const result = await ctx.controller.getOneComposite({ taskId: "5" }, "/one?taskId=5");
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(400);
    });

    it("should return 400 when no composite PK and no compound unique indexes", async () => {
      const result = await controller.getOneComposite({ id: "123" }, "/one?id=123");
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(400);
    });

    it("should return 404 when not found", async () => {
      const ctx = createController({
        primaryKeys: ["taskId", "tagId"],
        findById: vi.fn().mockResolvedValue(null),
      });
      const result = await ctx.controller.getOneComposite(
        { taskId: "5", tagId: "99" },
        "/one?taskId=5&tagId=99",
      );
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(404);
    });
  });

  // ── POST / ────────────────────────────────────────────────────────

  describe("insert", () => {
    it("should insert a single record", async () => {
      const result = await controller.insert({ name: "Bob" });
      expect(table.insertOne).toHaveBeenCalledWith({ name: "Bob" });
      expect(result).toEqual({ insertedId: "1" });
    });

    it("should insert many records", async () => {
      const result = await controller.insert([{ name: "A" }, { name: "B" }]);
      expect(table.insertMany).toHaveBeenCalledWith([{ name: "A" }, { name: "B" }]);
      expect(result).toEqual({ insertedCount: 2, insertedIds: ["1", "2"] });
    });

    it("should use insertMany for single-item array", async () => {
      table.insertMany.mockResolvedValue({ insertedCount: 1, insertedIds: ["1"] });
      const result = await controller.insert([{ name: "Solo" }]);
      expect(table.insertMany).toHaveBeenCalledWith([{ name: "Solo" }]);
      expect(table.insertOne).not.toHaveBeenCalled();
      expect(result).toEqual({ insertedCount: 1, insertedIds: ["1"] });
    });

    it("should propagate ValidatorError from table", async () => {
      table.insertOne.mockRejectedValue(
        new ValidatorError([{ path: "name", message: "required" }]),
      );
      await expect(controller.insert({ bad: true })).rejects.toBeInstanceOf(ValidatorError);
    });

    it("should call onWrite hook", async () => {
      const ctx = createController();
      const spy = vi.spyOn(ctx.controller as any, "onWrite");
      await ctx.controller.insert({ name: "Test" });
      expect(spy).toHaveBeenCalledWith("insert", { name: "Test" });
    });

    it("should return 500 when onWrite returns undefined", async () => {
      const ctx = createController();
      vi.spyOn(ctx.controller as any, "onWrite").mockReturnValue(undefined);
      const result = await ctx.controller.insert({ name: "Test" });
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(500);
    });
  });

  // ── PUT / ─────────────────────────────────────────────────────────

  describe("replace", () => {
    it("should call table.replaceOne", async () => {
      const result = await controller.replace({ id: "1", name: "Updated" });
      expect(table.replaceOne).toHaveBeenCalledWith({ id: "1", name: "Updated" });
      expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    });

    it("should propagate ValidatorError from table", async () => {
      table.replaceOne.mockRejectedValue(new ValidatorError([{ path: "id", message: "required" }]));
      await expect(controller.replace({ bad: true })).rejects.toBeInstanceOf(ValidatorError);
    });
  });

  // ── PUT / (batch) ────────────────────────────────────────────────

  describe("replace (batch)", () => {
    it("should call table.bulkReplace for array payload", async () => {
      const payload = [
        { id: "1", name: "A" },
        { id: "2", name: "B" },
      ];
      const result = await controller.replace(payload);
      expect(table.bulkReplace).toHaveBeenCalledWith(payload);
      expect(table.replaceOne).not.toHaveBeenCalled();
      expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    });

    it("should call onWrite with replaceMany action for array", async () => {
      const ctx = createController();
      const spy = vi.spyOn(ctx.controller as any, "onWrite");
      const payload = [{ id: "1", name: "A" }];
      await ctx.controller.replace(payload);
      expect(spy).toHaveBeenCalledWith("replaceMany", payload);
    });

    it("should return 500 when onWrite returns undefined for array", async () => {
      const ctx = createController();
      vi.spyOn(ctx.controller as any, "onWrite").mockReturnValue(undefined);
      const result = await ctx.controller.replace([{ id: "1", name: "A" }]);
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(500);
    });
  });

  // ── PATCH / ───────────────────────────────────────────────────────

  describe("update", () => {
    it("should call table.updateOne", async () => {
      const result = await controller.update({ id: "1", name: "Patched" });
      expect(table.updateOne).toHaveBeenCalledWith({ id: "1", name: "Patched" });
      expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    });
  });

  // ── PATCH / (batch) ────────────────────────────────────────────────

  describe("update (batch)", () => {
    it("should call table.bulkUpdate for array payload", async () => {
      const payload = [
        { id: "1", name: "X" },
        { id: "2", name: "Y" },
      ];
      const result = await controller.update(payload);
      expect(table.bulkUpdate).toHaveBeenCalledWith(payload);
      expect(table.updateOne).not.toHaveBeenCalled();
      expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    });

    it("should call onWrite with updateMany action for array", async () => {
      const ctx = createController();
      const spy = vi.spyOn(ctx.controller as any, "onWrite");
      const payload = [{ id: "1", name: "X" }];
      await ctx.controller.update(payload);
      expect(spy).toHaveBeenCalledWith("updateMany", payload);
    });

    it("should return 500 when onWrite returns undefined for array", async () => {
      const ctx = createController();
      vi.spyOn(ctx.controller as any, "onWrite").mockReturnValue(undefined);
      const result = await ctx.controller.update([{ id: "1", name: "X" }]);
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(500);
    });
  });

  // ── DELETE /:id ───────────────────────────────────────────────────

  describe("remove", () => {
    it("should call table.deleteOne", async () => {
      const result = await controller.remove("123");
      expect(table.deleteOne).toHaveBeenCalledWith("123");
      expect(result).toEqual({ deletedCount: 1 });
    });

    it("should return 404 when nothing deleted", async () => {
      table.deleteOne.mockResolvedValue({ deletedCount: 0 });
      const result = await controller.remove("999");
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(404);
    });

    it("should return 500 when onRemove returns undefined", async () => {
      const ctx = createController();
      vi.spyOn(ctx.controller as any, "onRemove").mockReturnValue(undefined);
      const result = await ctx.controller.remove("123");
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(500);
    });
  });

  // ── DELETE / (composite key) ───────────────────────────────────────

  describe("removeComposite", () => {
    it("should delete by composite PK from query params", async () => {
      const ctx = createController({ primaryKeys: ["taskId", "tagId"] });
      const result = await ctx.controller.removeComposite({ taskId: "5", tagId: "1" });
      expect(ctx.table.deleteOne).toHaveBeenCalledWith({ taskId: "5", tagId: "1" });
      expect(result).toEqual({ deletedCount: 1 });
    });

    it("should delete by compound unique index from query params", async () => {
      const ctx = createController({
        indexes: new Map([
          [
            "email_tenant",
            {
              key: "email_tenant",
              name: "email_tenant",
              type: "unique",
              fields: [
                { name: "email", sort: "asc" },
                { name: "tenantId", sort: "asc" },
              ],
            },
          ],
        ]),
      });
      const result = await ctx.controller.removeComposite({ email: "alice", tenantId: "T1" });
      expect(ctx.table.deleteOne).toHaveBeenCalledWith({ email: "alice", tenantId: "T1" });
      expect(result).toEqual({ deletedCount: 1 });
    });

    it("should return 400 when query params match no composite key or unique index", async () => {
      const ctx = createController({ primaryKeys: ["taskId", "tagId"] });
      const result = await ctx.controller.removeComposite({ taskId: "5" });
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(400);
    });

    it("should return 400 when no composite PK and no compound unique indexes", async () => {
      const result = await controller.removeComposite({ id: "123" });
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(400);
    });

    it("should return 404 when nothing deleted", async () => {
      const ctx = createController({
        primaryKeys: ["taskId", "tagId"],
        deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      });
      const result = await ctx.controller.removeComposite({ taskId: "5", tagId: "1" });
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(404);
    });

    it("should call onRemove hook with id object", async () => {
      const ctx = createController({ primaryKeys: ["taskId", "tagId"] });
      const spy = vi.spyOn(ctx.controller as any, "onRemove");
      await ctx.controller.removeComposite({ taskId: "5", tagId: "1" });
      expect(spy).toHaveBeenCalledWith({ taskId: "5", tagId: "1" });
    });
  });

  // ── GET /meta ─────────────────────────────────────────────────────

  describe("meta", () => {
    it("should return table metadata", () => {
      const result = controller.meta();
      expect(result.searchable).toBe(false);
      expect(result.vectorSearchable).toBe(false);
      expect(result.searchIndexes).toEqual([]);
      expect(result.type).toBeDefined();
      expect(result.type.$v).toBe(1);
    });
  });

  // ── Hook overrides ────────────────────────────────────────────────

  describe("hooks", () => {
    it("should allow transformFilter override", async () => {
      const ctx = createController();
      vi.spyOn(ctx.controller as any, "transformFilter").mockReturnValue({ tenant: "abc" });
      await ctx.controller.query("/query?name=Alice");
      const call = ctx.table.findMany.mock.calls[0][0];
      expect(call.filter).toEqual({ tenant: "abc" });
    });

    it("should allow transformProjection override", async () => {
      const ctx = createController();
      const spy = vi
        .spyOn(ctx.controller as any, "transformProjection")
        .mockReturnValue(["id", "name"]);
      await ctx.controller.query("/query?");
      expect(spy).toHaveBeenCalled();
      const call = ctx.table.findMany.mock.calls[0][0];
      expect(call.controls.$select).toEqual(["id", "name"]);
    });
  });
});
