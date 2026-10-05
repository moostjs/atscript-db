import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

import { DbError } from "../db-error";
import { DbSpace } from "../table/db-space";
import { MockAdapter, prepareFixtures } from "./test-utils";

/** `DbSpace.close()` / `Symbol.asyncDispose` (since 0.1.148). */

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/insert-ignore.as");
});

class DisposableAdapter extends MockAdapter {
  static log: string[] = [];
  disposed = 0;
  failWith?: Error;
  override async dropTableByName(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed++;
    DisposableAdapter.log.push("adapter");
    if (this.failWith) throw this.failWith;
  }
}

describe("DbSpace.close", () => {
  it("is idempotent: every call returns the same promise and the hook runs once", async () => {
    const onClose = vi.fn();
    const space = new DbSpace(() => new MockAdapter(), { onClose });
    expect(space.closed).toBe(false);
    const first = space.close();
    expect(space.close()).toBe(first);
    await first;
    await space.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(space.closed).toBe(true);
  });

  it("disposes every adapter (tables, views, admin) before the onClose hook", async () => {
    DisposableAdapter.log = [];
    const adapters: DisposableAdapter[] = [];
    const space = new DbSpace(
      () => {
        const a = new DisposableAdapter();
        adapters.push(a);
        return a;
      },
      { onClose: () => void DisposableAdapter.log.push("hook") },
    );
    space.getTable(fx.IgOrg);
    space.getTable(fx.IgItem);
    await space.dropTableByName("x"); // creates the admin adapter
    expect(adapters).toHaveLength(3);
    await space.close();
    expect(adapters.map((a) => a.disposed)).toEqual([1, 1, 1]);
    expect(DisposableAdapter.log).toEqual(["adapter", "adapter", "adapter", "hook"]);
  });

  it("attempts every step and aggregates failures", async () => {
    const adapters: DisposableAdapter[] = [];
    const space = new DbSpace(
      () => {
        const a = new DisposableAdapter();
        adapters.push(a);
        return a;
      },
      {
        onClose: () => {
          throw new Error("hook failed");
        },
      },
    );
    space.getTable(fx.IgOrg);
    space.getTable(fx.IgItem);
    adapters[0]!.failWith = new Error("first failed");
    const err = await space.close().catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "first failed",
      "hook failed",
    ]);
    expect(adapters[1]!.disposed).toBe(1);
    // the failed close stays closed and idempotent
    await expect(space.close()).rejects.toBe(err);
  });

  it("get / getTable / getView / getAdapter throw SPACE_CLOSED afterwards", async () => {
    const space = new DbSpace(() => new MockAdapter());
    space.getTable(fx.IgOrg);
    await space.close();
    for (const call of [
      () => space.get(fx.IgOrg),
      () => space.getTable(fx.IgOrg),
      () => space.getView(fx.IgOrg),
      () => space.getAdapter(fx.IgOrg),
    ]) {
      expect(call).toThrow(DbError);
      try {
        call();
      } catch (error) {
        expect((error as DbError).code).toBe("SPACE_CLOSED");
      }
    }
    await expect(space.getReferencingForeignKeys("x")).rejects.toMatchObject({
      code: "SPACE_CLOSED",
    });
  });

  it("operations on an existing table handle throw SPACE_CLOSED", async () => {
    const space = new DbSpace(() => new MockAdapter());
    const table = space.getTable(fx.IgOrg);
    await table.findMany({ filter: {}, controls: {} });
    await space.close();
    await expect(table.findMany({ filter: {}, controls: {} })).rejects.toMatchObject({
      code: "SPACE_CLOSED",
    });
    await expect(table.insertOne({ id: 1, name: "x" } as any)).rejects.toMatchObject({
      code: "SPACE_CLOSED",
    });
  });

  it("supports `await using` through Symbol.asyncDispose", async () => {
    const onClose = vi.fn();
    const space = new DbSpace(() => new MockAdapter(), { onClose });
    await (space as any)[Symbol.asyncDispose]();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(space.closed).toBe(true);
  });

  it("works for adapters without a dispose hook", async () => {
    const space = new DbSpace(() => new MockAdapter());
    space.getTable(fx.IgOrg);
    await expect(space.close()).resolves.toBeUndefined();
  });
});
