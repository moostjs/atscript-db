import { describe, it, expect } from "vite-plus/test";

import { syncIndexesImpl } from "../mongo-schema-sync";

// Per-index error isolation: a failing createIndex/dropIndex (e.g. a unique
// index over duplicate data → E11000) must not abort the remaining index
// maintenance for the collection. All operations are attempted; failures are
// rethrown as a single aggregate error at the end.
describe("syncIndexesImpl per-index error isolation", () => {
  function makeHost(collection: Record<string, unknown>) {
    return {
      ensureCollectionExists: async () => {},
      _log: () => {},
      _table: {
        indexes: new Map([
          [
            "atscript__unique__by_code",
            {
              key: "atscript__unique__by_code",
              name: "by_code",
              type: "unique",
              fields: [{ name: "code" }],
            },
          ],
          [
            "atscript__plain__by_x",
            { key: "atscript__plain__by_x", name: "by_x", type: "plain", fields: [{ name: "x" }] },
          ],
        ]),
      },
      _mongoIndexes: new Map(),
      collection: {
        listSearchIndexes: () => {
          // standalone MongoDB — Atlas block is skipped gracefully
          throw new Error("not supported");
        },
        ...collection,
      },
    } as any;
  }

  it("continues creating other indexes after a failing createIndex and throws one aggregate error", async () => {
    const created: string[] = [];
    const host = makeHost({
      listIndexes: () => ({ toArray: async () => [] }),
      createIndex: async (_fields: unknown, opts: { name: string; unique?: boolean }) => {
        if (opts.unique) {
          throw new Error("E11000 duplicate key error");
        }
        created.push(opts.name);
      },
      dropIndex: async () => {},
    });

    await expect(syncIndexesImpl(host)).rejects.toThrow(
      /index sync failed .*atscript__unique__by_code.*E11000/,
    );
    // The plain index was still created despite the earlier unique failure
    expect(created).toContain("atscript__plain__by_x");
  });

  it("continues dropping stale indexes after a failing dropIndex", async () => {
    const dropped: string[] = [];
    const host = makeHost({
      listIndexes: () => ({
        toArray: async () => [
          { name: "atscript__stale__one", key: { a: 1 } },
          { name: "atscript__stale__two", key: { b: 1 } },
        ],
      }),
      createIndex: async () => {},
      dropIndex: async (name: string) => {
        if (name === "atscript__stale__one") {
          throw new Error("drop failed");
        }
        dropped.push(name);
      },
    });

    await expect(syncIndexesImpl(host)).rejects.toThrow(/index sync failed .*atscript__stale__one/);
    expect(dropped).toContain("atscript__stale__two");
  });
});
