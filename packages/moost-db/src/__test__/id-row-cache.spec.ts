import { describe, expect, it, vi } from "vite-plus/test";
import { current } from "@wooksjs/event-core";

import { dbActionRowsSlot } from "../actions/row-cache";
import { runInActionCtx, setBoundTable } from "./actions-test-utils";

describe("cached ID row wook", () => {
  it("fetches mixed identifier shapes through deduped $or and preserves request order", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "1", email: "a@example.com" },
      { id: "2", email: "b@example.com" },
    ]);
    const table = {
      primaryKeys: ["id"],
      fieldDescriptors: [
        { path: "id", designType: "string" },
        { path: "email", designType: "string" },
      ],
      identifications: [
        { fields: ["id"], source: "primaryKey" as const },
        { fields: ["email"], source: "email" },
      ],
      findOne: vi.fn(),
      findMany,
    };

    await runInActionCtx(
      '[{"email":"b@example.com"},{"id":"1"},{"email":"b@example.com"}]',
      async () => {
        setBoundTable(table);
        const rows = await current().get(dbActionRowsSlot);
        const arg = findMany.mock.calls[0][0] as {
          filter: unknown;
          controls: { $select: string[] };
        };
        expect(arg.filter).toEqual({ $or: [{ email: "b@example.com" }, { id: "1" }] });
        expect(new Set(arg.controls.$select)).toEqual(new Set(["email", "id"]));
        expect(rows).toEqual([
          { id: "2", email: "b@example.com" },
          { id: "1", email: "a@example.com" },
          { id: "2", email: "b@example.com" },
        ]);
      },
    );
  });

  it("uses logical names for a unique-index field carrying @db.column physical mapping", async () => {
    // Prop `slug: string` with `@db.column "url_slug"`. Identification list
    // emits the logical name; the row-cache MUST use the logical name in
    // both the $or clause and the fetch projection.
    const findMany = vi.fn().mockResolvedValue([{ id: "1", slug: "alpha" }]);
    const table = {
      primaryKeys: ["id"],
      fieldDescriptors: [
        { path: "id", designType: "string" },
        { path: "slug", designType: "string" },
      ],
      identifications: [
        { fields: ["id"], source: "primaryKey" as const },
        { fields: ["slug"], source: "by_slug" },
      ],
      findOne: vi.fn(),
      findMany,
    };

    await runInActionCtx('[{"slug":"alpha"}]', async () => {
      setBoundTable(table);
      const rows = await current().get(dbActionRowsSlot);
      const arg = findMany.mock.calls[0][0] as {
        filter: unknown;
        controls: { $select: string[] };
      };
      expect(arg.filter).toEqual({ $or: [{ slug: "alpha" }] });
      // Effective projection unions the readable's preferredId (here =
      // primaryKeys = ['id']) with the submitted identifier-shape field.
      expect(new Set(arg.controls.$select)).toEqual(new Set(["id", "slug"]));
      expect(rows).toEqual([{ id: "1", slug: "alpha" }]);
    });
  });

  it("dedups identical identifiers in the request but preserves duplicate slots in the result", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "1", name: "Alpha" }]);
    const table = {
      primaryKeys: ["id"],
      fieldDescriptors: [
        { path: "id", designType: "string" },
        { path: "name", designType: "string" },
      ],
      identifications: [{ fields: ["id"], source: "primaryKey" as const }],
      findOne: vi.fn(),
      findMany,
    };

    await runInActionCtx('[{"id":"1"},{"id":"1"},{"id":"1"}]', async () => {
      setBoundTable(table);
      const rows = (await current().get(dbActionRowsSlot)) as Array<
        Record<string, unknown> | undefined
      >;
      const callArg = findMany.mock.calls[0][0] as { filter: { $or: unknown[] } };
      expect(callArg.filter.$or).toHaveLength(1);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({ id: "1", name: "Alpha" });
      expect(rows[1]).toBe(rows[0]);
      expect(rows[2]).toBe(rows[0]);
    });
  });

  it("retains an undefined gap at the index of an unmatched identifier", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "1", name: "Alpha" },
      { id: "3", name: "Charlie" },
    ]);
    const table = {
      primaryKeys: ["id"],
      fieldDescriptors: [
        { path: "id", designType: "string" },
        { path: "name", designType: "string" },
      ],
      identifications: [{ fields: ["id"], source: "primaryKey" as const }],
      findOne: vi.fn(),
      findMany,
    };

    await runInActionCtx('[{"id":"1"},{"id":"2"},{"id":"3"}]', async () => {
      setBoundTable(table);
      const rows = (await current().get(dbActionRowsSlot)) as Array<
        Record<string, unknown> | undefined
      >;
      expect(rows).toEqual([{ id: "1", name: "Alpha" }, undefined, { id: "3", name: "Charlie" }]);
    });
  });
});
