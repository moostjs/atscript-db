import { describe, it, expect, beforeAll } from "vite-plus/test";
import { ValidatorError } from "@atscript/typescript/utils";
import type { FilterExpr } from "@uniqu/core";

import { AtscriptDbTable } from "../table/db-table";
import { DbSpace } from "../table/db-space";
import { BaseDbAdapter } from "../base-adapter";
import { DepthLimitExceededError } from "../db-error";
import { prepareFixtures } from "./test-utils";
import type {
  DbQuery,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "../types";

let DeepZero: any;
let DeepTwo: any;
let DeepTwoChild: any;
let DeepTwoGrandchild: any;
let DeepTwoGreatGrandchild: any;
let DeepZeroChild: any;
let ImplicitDefault: any;
let ImplicitDefaultChild: any;

class InMemoryAdapter extends BaseDbAdapter {
  private _store: Array<Record<string, unknown>> = [];
  private _nextId = 1;

  // Report native FK support so the generic layer skips application-level FK
  // validation — the fixture's nested chains insert grandchildren before the
  // middle child exists at validation time, which would otherwise spuriously
  // fail before the depth check was even consulted.
  supportsNativeForeignKeys(): boolean {
    return true;
  }

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    const id = (data.id as number) ?? this._nextId++;
    this._store.push({ ...data, id });
    return { insertedId: id };
  }
  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    const ids: number[] = [];
    for (const item of data) {
      const result = await this.insertOne(item);
      ids.push(result.insertedId as number);
    }
    return { insertedCount: ids.length, insertedIds: ids };
  }
  async replaceOne(_f: FilterExpr, _d: Record<string, unknown>): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async updateOne(_f: FilterExpr, _d: Record<string, unknown>): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async deleteOne(_f: FilterExpr): Promise<TDbDeleteResult> {
    return { deletedCount: 0 };
  }
  async findOne(_q: DbQuery): Promise<Record<string, unknown> | null> {
    return null;
  }
  async findMany(_q: DbQuery): Promise<Array<Record<string, unknown>>> {
    return this._store;
  }
  async count(_q: DbQuery): Promise<number> {
    return this._store.length;
  }
  async updateMany(_f: FilterExpr, _d: Record<string, unknown>): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async replaceMany(_f: FilterExpr, _d: Record<string, unknown>): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async deleteMany(_f: FilterExpr): Promise<TDbDeleteResult> {
    return { deletedCount: 0 };
  }
  async syncIndexes(): Promise<void> {}
  async ensureTable(): Promise<void> {}
}

describe("AtscriptDbTable — @db.depth.limit enforcement", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const mod = await import("./fixtures/depth-limit.as");
    DeepZero = mod.DeepZero;
    DeepZeroChild = mod.DeepZeroChild;
    DeepTwo = mod.DeepTwo;
    DeepTwoChild = mod.DeepTwoChild;
    DeepTwoGrandchild = mod.DeepTwoGrandchild;
    DeepTwoGreatGrandchild = mod.DeepTwoGreatGrandchild;
    ImplicitDefault = mod.ImplicitDefault;
    ImplicitDefaultChild = mod.ImplicitDefaultChild;
  });

  function newSpace(): DbSpace {
    const space = new DbSpace(() => new InMemoryAdapter());
    // Prime all tables so the write resolver can reach them.
    space.getTable(DeepZero);
    space.getTable(DeepZeroChild);
    space.getTable(DeepTwo);
    space.getTable(DeepTwoChild);
    space.getTable(DeepTwoGrandchild);
    space.getTable(DeepTwoGreatGrandchild);
    space.getTable(ImplicitDefault);
    space.getTable(ImplicitDefaultChild);
    return space;
  }

  it("accepts flat payloads regardless of declared depth", async () => {
    const space = newSpace();
    const zero = space.getTable(DeepZero) as AtscriptDbTable;
    const two = space.getTable(DeepTwo) as AtscriptDbTable;
    const implicit = space.getTable(ImplicitDefault) as AtscriptDbTable;

    await expect(zero.insertOne({ name: "a" })).resolves.toMatchObject({ insertedId: 1 });
    await expect(two.insertOne({ name: "b" })).resolves.toMatchObject({ insertedId: 1 });
    await expect(implicit.insertOne({ name: "c" })).resolves.toMatchObject({ insertedId: 1 });
  });

  it("rejects any nested children on @db.depth.limit 0", async () => {
    const space = newSpace();
    const zero = space.getTable(DeepZero) as AtscriptDbTable;
    await expect(zero.insertOne({ name: "a", children: [{ title: "x" }] })).rejects.toBeInstanceOf(
      DepthLimitExceededError,
    );
  });

  it("rejects any nested children on unannotated table (breaking change path)", async () => {
    const space = newSpace();
    const implicit = space.getTable(ImplicitDefault) as AtscriptDbTable;
    try {
      await implicit.insertOne({ name: "a", children: [{ title: "x" }] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DepthLimitExceededError);
      const e = err as DepthLimitExceededError;
      expect(e.declared).toBe(0);
      expect(e.actual).toBe(1);
      expect(e.field).toBe("children");
    }
  });

  it("accepts one level of nesting on @db.depth.limit 2", async () => {
    const space = newSpace();
    const two = space.getTable(DeepTwo) as AtscriptDbTable;
    // Don't care about insert success past the depth check — the test is about the check.
    const p = two.insertOne({ name: "a", children: [{ title: "x" }] });
    // Depth check passes; downstream write may or may not succeed via the mock.
    await expect(p).resolves.toBeDefined();
  });

  it("accepts two levels of nesting on @db.depth.limit 2", async () => {
    const space = newSpace();
    const two = space.getTable(DeepTwo) as AtscriptDbTable;
    const p = two.insertOne({
      name: "a",
      children: [{ title: "x", grandchildren: [{ label: "y" }] }],
    });
    await expect(p).resolves.toBeDefined();
  });

  it("rejects three levels of nesting on @db.depth.limit 2 (depth+1)", async () => {
    const space = newSpace();
    const two = space.getTable(DeepTwo) as AtscriptDbTable;
    try {
      await two.insertOne({
        name: "a",
        children: [
          {
            title: "x",
            grandchildren: [
              {
                label: "y",
                greatgrandchildren: [{ tag: "z" }],
              },
            ],
          },
        ],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DepthLimitExceededError);
      const e = err as DepthLimitExceededError;
      expect(e.declared).toBe(2);
      expect(e.actual).toBe(3);
      expect(e.field).toBe("children[0].grandchildren[0].greatgrandchildren");
    }
  });

  it("reports the offending field path in the error", async () => {
    const space = newSpace();
    const zero = space.getTable(DeepZero) as AtscriptDbTable;
    try {
      await zero.insertMany([{ name: "a" }, { name: "b", children: [{ title: "x" }] }]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DepthLimitExceededError);
      const e = err as DepthLimitExceededError;
      expect(e.field).toBe("[1].children");
      expect(e.declared).toBe(0);
      expect(e.actual).toBe(1);
    }
  });

  // ── Regression: null / non-object payloads must produce ValidatorError ──
  // (previously crashed with TypeError in `_enforceDeclaredInsertDepth`).
  it("rejects null insert payload with ValidatorError (regression)", async () => {
    const space = newSpace();
    const zero = space.getTable(DeepZero) as AtscriptDbTable;
    await expect(zero.insertOne(null as unknown as Record<string, unknown>)).rejects.toBeInstanceOf(
      ValidatorError,
    );
  });

  it("rejects non-object batch items with ValidatorError and batch index prefix", async () => {
    const space = newSpace();
    const zero = space.getTable(DeepZero) as AtscriptDbTable;
    try {
      await zero.insertMany([{ name: "ok" }, "nope" as unknown as Record<string, unknown>]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidatorError);
      const e = err as ValidatorError;
      expect(e.errors[0]?.path.startsWith("[1]")).toBe(true);
    }
  });

  // ── Depth gate must also apply to replace ──
  it("rejects nested children on bulkReplace when @db.depth.limit 0", async () => {
    const space = newSpace();
    const zero = space.getTable(DeepZero) as AtscriptDbTable;
    await expect(
      zero.bulkReplace([{ id: 1, name: "a", children: [{ title: "x" }] }]),
    ).rejects.toBeInstanceOf(DepthLimitExceededError);
  });

  // ── Depth gate must also apply to patch (nav $insert op) ──
  it("rejects nested $insert on bulkUpdate when @db.depth.limit 0", async () => {
    const space = newSpace();
    const zero = space.getTable(DeepZero) as AtscriptDbTable;
    await expect(
      zero.bulkUpdate([{ id: 1, children: { $insert: [{ title: "x" }] } }]),
    ).rejects.toBeInstanceOf(DepthLimitExceededError);
  });

  it("accepts one-level $insert on bulkUpdate when @db.depth.limit 2", async () => {
    const space = newSpace();
    const two = space.getTable(DeepTwo) as AtscriptDbTable;
    const p = two.bulkUpdate([{ id: 1, children: { $insert: [{ title: "x" }] } }]);
    await expect(p).resolves.toBeDefined();
  });

  it("rejects three-level nested $insert on bulkUpdate when @db.depth.limit 2", async () => {
    const space = newSpace();
    const two = space.getTable(DeepTwo) as AtscriptDbTable;
    try {
      await two.bulkUpdate([
        {
          id: 1,
          children: {
            $insert: [
              {
                title: "x",
                grandchildren: {
                  $insert: [
                    {
                      label: "y",
                      greatgrandchildren: { $insert: [{ tag: "z" }] },
                    },
                  ],
                },
              },
            ],
          },
        },
      ]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DepthLimitExceededError);
      const e = err as DepthLimitExceededError;
      expect(e.declared).toBe(2);
      expect(e.actual).toBe(3);
    }
  });
});
