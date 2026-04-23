import { describe, it, expect, beforeAll } from "vite-plus/test";
import type { FilterExpr } from "@uniqu/core";

import { AtscriptDbTable } from "../table/db-table";
import { DbSpace } from "../table/db-space";
import { BaseDbAdapter } from "../base-adapter";
import { DeepInsertDepthExceededError } from "../db-error";
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

describe("AtscriptDbTable — @db.deep.insert enforcement", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const mod = await import("./fixtures/deep-insert.as");
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

  it("rejects any nested children on @db.deep.insert 0", async () => {
    const space = newSpace();
    const zero = space.getTable(DeepZero) as AtscriptDbTable;
    await expect(zero.insertOne({ name: "a", children: [{ title: "x" }] })).rejects.toBeInstanceOf(
      DeepInsertDepthExceededError,
    );
  });

  it("rejects any nested children on unannotated table (breaking change path)", async () => {
    const space = newSpace();
    const implicit = space.getTable(ImplicitDefault) as AtscriptDbTable;
    try {
      await implicit.insertOne({ name: "a", children: [{ title: "x" }] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DeepInsertDepthExceededError);
      const e = err as DeepInsertDepthExceededError;
      expect(e.declared).toBe(0);
      expect(e.actual).toBe(1);
      expect(e.field).toBe("children");
    }
  });

  it("accepts one level of nesting on @db.deep.insert 2", async () => {
    const space = newSpace();
    const two = space.getTable(DeepTwo) as AtscriptDbTable;
    // Don't care about insert success past the depth check — the test is about the check.
    const p = two.insertOne({ name: "a", children: [{ title: "x" }] });
    // Depth check passes; downstream write may or may not succeed via the mock.
    await expect(p).resolves.toBeDefined();
  });

  it("accepts two levels of nesting on @db.deep.insert 2", async () => {
    const space = newSpace();
    const two = space.getTable(DeepTwo) as AtscriptDbTable;
    const p = two.insertOne({
      name: "a",
      children: [{ title: "x", grandchildren: [{ label: "y" }] }],
    });
    await expect(p).resolves.toBeDefined();
  });

  it("rejects three levels of nesting on @db.deep.insert 2 (depth+1)", async () => {
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
      expect(err).toBeInstanceOf(DeepInsertDepthExceededError);
      const e = err as DeepInsertDepthExceededError;
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
      expect(err).toBeInstanceOf(DeepInsertDepthExceededError);
      const e = err as DeepInsertDepthExceededError;
      expect(e.field).toBe("[1].children");
      expect(e.declared).toBe(0);
      expect(e.actual).toBe(1);
    }
  });
});
