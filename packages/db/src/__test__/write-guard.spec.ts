import { ValidatorError } from "@atscript/typescript/utils";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import type { DbQuery, TDbRemoveGuardContext, TDbWriteGuardContext } from "../types";
import type { FilterExpr } from "@uniqu/core";

import { MockAdapter, prepareFixtures } from "./test-utils";

let GuardedRow: any;

/**
 * Table-level write guards (since 0.1.128): `insertOne/Many`, `replaceOne` /
 * `bulkReplace`, `updateOne` / `bulkUpdate` take `{ guard }` and `deleteOne`
 * takes `{ guard }` too. The table invokes the guard exactly once, inside
 * its own transaction, after `undefined`-pruning + defaults + validation and
 * before encryption / the nested phases; rows may be enriched in place and
 * are validated again; a throw rolls the transaction back and propagates
 * unchanged.
 */

/** Records the transaction primitives and every adapter write in one ordered log. */
class TxAdapter extends MockAdapter {
  readonly order: string[] = [];
  protected override async _beginTransaction(): Promise<unknown> {
    this.order.push("begin");
    return "tx";
  }
  protected override async _commitTransaction(): Promise<void> {
    this.order.push("commit");
  }
  protected override async _rollbackTransaction(): Promise<void> {
    this.order.push("rollback");
  }
  override async insertMany(data: Array<Record<string, unknown>>) {
    this.order.push("insertMany");
    return super.insertMany(data);
  }
  override async replaceOne(filter: FilterExpr, data: Record<string, unknown>) {
    this.order.push("replaceOne");
    return super.replaceOne(filter, data);
  }
  readonly casPredicates: unknown[] = [];
  override async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: any,
    expectedVersion?: number,
  ) {
    this.order.push("updateOne");
    this.casPredicates.push(expectedVersion);
    return super.updateOne(filter, data, ops);
  }
  override async deleteOne(filter: FilterExpr) {
    this.order.push("deleteOne");
    return super.deleteOne(filter);
  }
  override async findOne(query: DbQuery) {
    this.order.push("findOne");
    return super.findOne(query);
  }
}

describe("table write guards", () => {
  let adapter: TxAdapter;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ GuardedRow } = await import("./fixtures/write-guard.as"));
  });

  beforeEach(() => {
    adapter = new TxAdapter();
    table = new AtscriptDbTable(GuardedRow, adapter);
  });

  const argsOf = (method: string) => adapter.calls.filter((c) => c.method === method);

  describe("insert", () => {
    it("runs once, inside the transaction, after defaults + validation and before the adapter write", async () => {
      const validate = vi.spyOn(table.getValidator("insert"), "validate");
      let seen: TDbWriteGuardContext<any> | undefined;
      const guard = vi.fn((ctx: TDbWriteGuardContext<any>) => {
        adapter.order.push("guard");
        seen = ctx;
        expect(validate).toHaveBeenCalledTimes(1); // validated before the guard
        ctx.rows[0].name = "enriched";
      });
      await table.insertOne({ name: "a", note: undefined } as any, { guard });
      expect(guard).toHaveBeenCalledTimes(1);
      expect(adapter.order).toEqual(["begin", "guard", "insertMany", "commit"]);
      expect(seen!.action).toBe("insert");
      expect(seen!.rows).toEqual([{ name: "enriched", status: "todo" }]); // defaults applied, `note` pruned
      expect(seen!.rows[0]).not.toHaveProperty("note");
      expect(seen!.expectedVersions).toEqual([undefined]);
      // Re-validated after the guard, with the enrichment visible.
      expect(validate).toHaveBeenCalledTimes(2);
      expect(validate.mock.calls[1]![0]).toMatchObject({ name: "enriched" });
      expect(argsOf("insertMany")[0]!.args[0][0]).toMatchObject({
        name: "enriched",
        status: "todo",
      });
    });

    it("insertMany: one call for the whole batch, action 'insertMany'", async () => {
      const guard = vi.fn((ctx: TDbWriteGuardContext<any>) => {
        expect(ctx.action).toBe("insertMany");
        expect(ctx.rows).toHaveLength(3);
        expect(ctx.expectedVersions).toEqual([undefined, undefined, undefined]);
      });
      await table.insertMany([{ name: "a" }, { name: "b" }, { name: "c" }] as any[], { guard });
      expect(guard).toHaveBeenCalledTimes(1);
      expect(adapter.order).toEqual(["begin", "insertMany", "commit"]);
    });

    it("without a guard the rows are validated once and no guard-related work happens", async () => {
      const validate = vi.spyOn(table.getValidator("insert"), "validate");
      await table.insertOne({ name: "a" } as any);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(adapter.order).toEqual(["begin", "insertMany", "commit"]);
    });

    it("an enrichment that makes a row invalid fails the re-validation → rollback, adapter never called", async () => {
      await expect(
        table.insertOne({ name: "a" } as any, {
          guard: (ctx: TDbWriteGuardContext<any>) => {
            ctx.rows[0].name = 42;
          },
        }),
      ).rejects.toBeInstanceOf(ValidatorError);
      expect(adapter.order).toEqual(["begin", "rollback"]);
      expect(argsOf("insertMany")).toHaveLength(0);
    });

    it("a throwing guard rolls the transaction back and the SAME error propagates", async () => {
      const boom = new Error("guard says no");
      const err = await table
        .insertOne({ name: "a" } as any, { guard: () => Promise.reject(boom) })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBe(boom);
      expect(adapter.order).toEqual(["begin", "rollback"]);
      expect(argsOf("insertMany")).toHaveLength(0);
    });

    it("current(i) is null for a row without an identifying key (never throws)", async () => {
      let pre: unknown = "unset";
      await table.insertOne({ name: "a" } as any, {
        guard: async (ctx) => {
          pre = await ctx.current(0);
        },
      });
      expect(pre).toBeNull();
      expect(adapter.order).toEqual(["begin", "insertMany", "commit"]);
    });
  });

  describe("update", () => {
    beforeEach(async () => {
      await table.insertOne({ id: 1, name: "old" } as any);
      adapter.order.length = 0;
    });

    it("updateOne: rows carry the identifying key with $cas removed; expectedVersions from $cas; action 'update'", async () => {
      let seen: TDbWriteGuardContext<any> | undefined;
      await table.updateOne({ id: 1, name: "new", $cas: { version: 3 } } as any, {
        guard: (ctx) => {
          adapter.order.push("guard");
          seen = ctx;
        },
      });
      expect(seen!.action).toBe("update");
      expect(seen!.rows).toEqual([{ id: 1, name: "new" }]);
      expect(seen!.expectedVersions).toEqual([3]);
      expect(adapter.order).toEqual(["begin", "guard", "updateOne", "commit"]);
      expect(adapter.casPredicates).toEqual([3]); // the CAS predicate still reaches the adapter
    });

    it("bulkUpdate: per-item expectedVersions, action 'updateMany', one guard call", async () => {
      const guard = vi.fn((ctx: TDbWriteGuardContext<any>) => {
        expect(ctx.action).toBe("updateMany");
        expect(ctx.rows).toEqual([{ id: 1, name: "x" }, { id: 2 }]);
        expect(ctx.expectedVersions).toEqual([5, undefined]);
      });
      await table.bulkUpdate([{ id: 1, name: "x", $cas: { version: 5 } }, { id: 2 }] as any[], {
        guard,
      });
      expect(guard).toHaveBeenCalledTimes(1);
    });

    it("current(i) reads the memoised pre-image inside the transaction", async () => {
      let pre: unknown;
      await table.updateOne({ id: 1, name: "new" } as any, {
        guard: async (ctx) => {
          pre = await ctx.current(0);
          await ctx.current(0); // memoised
          adapter.order.push("guard-done");
        },
      });
      expect(pre).toMatchObject({ id: 1, name: "old", status: "todo" });
      expect(adapter.order).toEqual(["begin", "findOne", "guard-done", "updateOne", "commit"]);
    });

    it("a guard throw leaves the row untouched", async () => {
      await expect(
        table.updateOne({ id: 1, name: "new" } as any, {
          guard: () => {
            throw new Error("nope");
          },
        }),
      ).rejects.toThrow("nope");
      expect(adapter.order).toEqual(["begin", "rollback"]);
      expect(argsOf("updateOne")).toHaveLength(0);
    });
  });

  describe("replace", () => {
    it("replaceOne / bulkReplace: defaults applied, $cas separated, actions 'replace' / 'replaceMany'", async () => {
      const seen: TDbWriteGuardContext<any>[] = [];
      const guard = (ctx: TDbWriteGuardContext<any>) => {
        seen.push(ctx);
      };
      await table.replaceOne({ id: 1, name: "a", $cas: { version: 2 } } as any, { guard });
      await table.bulkReplace([{ id: 2, name: "b", status: "done" }] as any[], { guard });
      expect(seen[0]!.action).toBe("replace");
      expect(seen[0]!.rows).toEqual([{ id: 1, name: "a", status: "todo" }]);
      expect(seen[0]!.expectedVersions).toEqual([2]);
      expect(seen[1]!.action).toBe("replaceMany");
      expect(seen[1]!.rows).toEqual([{ id: 2, name: "b", status: "done" }]);
      expect(seen[1]!.expectedVersions).toEqual([undefined]);
      expect(adapter.order).toEqual([
        "begin",
        "replaceOne",
        "commit",
        "begin",
        "replaceOne",
        "commit",
      ]);
    });
  });

  describe("delete", () => {
    beforeEach(async () => {
      await table.insertOne({ id: 1, name: "row" } as any);
      adapter.order.length = 0;
    });

    it("runs inside a transaction before the delete with id / filter / current()", async () => {
      let seen: TDbRemoveGuardContext<any> | undefined;
      const result = await table.deleteOne(1 as never, {
        guard: async (ctx) => {
          adapter.order.push("guard");
          seen = ctx;
          expect(await ctx.current()).toMatchObject({ id: 1, name: "row" });
          await ctx.current(); // memoised
        },
      });
      expect(result).toEqual({ deletedCount: 1 });
      expect(seen!.id).toBe(1);
      expect(seen!.filter).toEqual({ id: 1 });
      expect(adapter.order).toEqual(["begin", "guard", "findOne", "deleteOne", "commit"]);
    });

    it("a guard throw rolls back and the row survives", async () => {
      await expect(
        table.deleteOne(1 as never, {
          guard: () => {
            throw new Error("keep it");
          },
        }),
      ).rejects.toThrow("keep it");
      expect(adapter.order).toEqual(["begin", "rollback"]);
      expect(await table.findOne({ filter: { id: 1 }, controls: {} })).toMatchObject({ id: 1 });
    });

    it("an id that resolves to no filter answers { deletedCount: 0 } without calling the guard", async () => {
      const guard = vi.fn();
      expect(await table.deleteOne({ nope: 1 } as never, { guard })).toEqual({ deletedCount: 0 });
      expect(guard).not.toHaveBeenCalled();
      expect(adapter.order).toEqual([]);
    });

    it("without a guard (and without cascade) no transaction is opened", async () => {
      await table.deleteOne(1 as never);
      expect(adapter.order).toEqual(["deleteOne"]);
    });
  });
});
