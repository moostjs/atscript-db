/* eslint-disable unicorn/consistent-function-scoping */
import { describe, it, expect, vi } from "vite-plus/test";
import { current } from "@wooksjs/event-core";

import { dbActionRowSlot, dbActionRowsSlot } from "../actions/row-cache";
import {
  bindController,
  runInActionCtx,
  setBoundTable,
  setupActionMeta,
} from "./actions-test-utils";

/**
 * `@DbActionRow*` row-cache projection narrowing — the row(s) injected into
 * the handler MUST contain only the action's effective field set
 * (`requiredFields` or tracked deps + preferred-id + submitted identifier
 * fields). This test exercises the wook directly without spinning up a
 * full Moost HTTP runtime.
 */

interface SpyTable {
  primaryKeys: readonly string[];
  preferredId: readonly string[];
  fieldDescriptors: ReadonlyArray<{ path: string; designType: string }>;
  getIdentifications: () => readonly { fields: readonly string[]; source: string }[];
  findOne: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
}

function spyTable(opts: {
  preferredId?: string[];
  primaryKeys?: string[];
  fields?: string[];
  rows?: Record<string, unknown>[];
  rowsForFilter?: (filter: unknown) => Record<string, unknown> | undefined;
}): SpyTable {
  const primaryKeys = opts.primaryKeys ?? ["id"];
  const preferredId = opts.preferredId ?? primaryKeys;
  const fieldDescriptors = (opts.fields ?? primaryKeys).map((p) => ({
    path: p,
    designType: "string",
  }));
  return {
    primaryKeys,
    preferredId,
    fieldDescriptors,
    getIdentifications: () => [{ fields: [...primaryKeys], source: "primaryKey" }],
    findOne: vi.fn().mockImplementation((q: { filter: Record<string, unknown> }) => {
      if (opts.rowsForFilter) return Promise.resolve(opts.rowsForFilter(q.filter) ?? null);
      return Promise.resolve(opts.rows?.[0] ?? null);
    }),
    findMany: vi.fn().mockResolvedValue(opts.rows ?? []),
  };
}

describe("@DbActionRow projection — 'row' level", () => {
  it("requiredFields declared → projection = requiredFields ∪ preferredId ∪ identifier-shape fields", async () => {
    const table = spyTable({
      preferredId: ["id"],
      fields: ["id", "state", "extraField", "description"],
      rows: [
        {
          id: "a",
          state: "pending",
          extraField: "x",
          description: "hidden",
        },
      ],
    });
    class Ctrl {
      ship(): void {}
    }
    setupActionMeta(
      Ctrl,
      "ship",
      {
        name: "ship",
        opts: {
          disabled: () => [false],
          requiredFields: ["state", "extraField"],
        },
      },
      ["id"],
    );

    await runInActionCtx('{"id":"a"}', async () => {
      bindController(new Ctrl(), "ship");
      setBoundTable(table);
      await current().get(dbActionRowSlot);
    });

    const arg = table.findOne.mock.calls[0][0] as {
      filter: unknown;
      controls: { $select: string[] };
    };
    expect(arg.filter).toEqual({ id: "a" });
    expect(new Set(arg.controls.$select)).toEqual(new Set(["id", "state", "extraField"]));
    expect(arg.controls.$select).not.toContain("description");
  });

  it("requiredFields absent → projection = preferredId ∪ identifier-shape fields only (no widening)", async () => {
    const table = spyTable({
      preferredId: ["id"],
      fields: ["id", "state", "description"],
      rows: [{ id: "a", state: "pending", description: "hidden" }],
    });
    class Ctrl {
      ship(): void {}
    }
    // Action without `requiredFields` and without `disabled` — no widening.
    setupActionMeta(Ctrl, "ship", { name: "ship", opts: {} }, ["id"]);

    await runInActionCtx('{"id":"a"}', async () => {
      bindController(new Ctrl(), "ship");
      setBoundTable(table);
      await current().get(dbActionRowSlot);
    });

    const arg = table.findOne.mock.calls[0][0] as {
      filter: unknown;
      controls: { $select: string[] };
    };
    expect(new Set(arg.controls.$select)).toEqual(new Set(["id"]));
  });

  it("zero deps + zero requiredFields → preferred-id-only when addressed by preferred-id", async () => {
    const table = spyTable({
      preferredId: ["id"],
      fields: ["id", "name"],
      rows: [{ id: "a" }],
    });
    class Ctrl {
      open(): void {}
    }
    setupActionMeta(Ctrl, "open", { name: "open" }, ["id"]);

    await runInActionCtx('{"id":"a"}', async () => {
      bindController(new Ctrl(), "open");
      setBoundTable(table);
      await current().get(dbActionRowSlot);
    });

    const arg = table.findOne.mock.calls[0][0] as { controls: { $select: string[] } };
    expect(new Set(arg.controls.$select)).toEqual(new Set(["id"]));
  });

  it("zero deps + zero requiredFields → preferredId ∪ identifier-shape when addressed by another unique index", async () => {
    const findOne = vi.fn().mockResolvedValue({ id: "1", slug: "alpha" });
    const table = {
      primaryKeys: ["id"],
      preferredId: ["id"],
      fieldDescriptors: [
        { path: "id", designType: "string" },
        { path: "slug", designType: "string" },
      ],
      getIdentifications: () => [
        { fields: ["id"], source: "primaryKey" as const },
        { fields: ["slug"], source: "by_slug" },
      ],
      findOne,
      findMany: vi.fn(),
    };
    class Ctrl {
      open(): void {}
    }
    setupActionMeta(Ctrl, "open", { name: "open" }, ["id"]);

    await runInActionCtx('{"slug":"alpha"}', async () => {
      bindController(new Ctrl(), "open");
      setBoundTable(table);
      await current().get(dbActionRowSlot);
    });

    const arg = findOne.mock.calls[0][0] as { controls: { $select: string[] } };
    expect(new Set(arg.controls.$select)).toEqual(new Set(["id", "slug"]));
  });

  it("row-level uses findOne with an object filter, NOT findById", async () => {
    const table = spyTable({
      preferredId: ["id"],
      rows: [{ id: "a" }],
    });
    class Ctrl {
      open(): void {}
    }
    setupActionMeta(Ctrl, "open", { name: "open" }, ["id"]);

    await runInActionCtx('{"id":"a"}', async () => {
      bindController(new Ctrl(), "open");
      setBoundTable(table);
      await current().get(dbActionRowSlot);
    });

    expect(table.findOne).toHaveBeenCalledTimes(1);
    expect((table as unknown as { findById?: unknown }).findById).toBeUndefined();
  });
});

describe("@DbActionRow projection — 'rows' level", () => {
  it("mixed identifier shapes widen projection to every submitted identifier field set", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "1", email: "a@example.com", state: "pending" },
      { id: "2", email: "b@example.com", state: "active" },
    ]);
    const table = {
      primaryKeys: ["id"],
      preferredId: ["id"],
      fieldDescriptors: [
        { path: "id", designType: "string" },
        { path: "email", designType: "string" },
        { path: "state", designType: "string" },
      ],
      getIdentifications: () => [
        { fields: ["id"], source: "primaryKey" as const },
        { fields: ["email"], source: "by_email" },
      ],
      findOne: vi.fn(),
      findMany,
    };
    class Ctrl {
      archive(): void {}
    }
    setupActionMeta(Ctrl, "archive", { name: "archive", opts: { requiredFields: ["state"] } }, [
      "ids",
    ]);

    await runInActionCtx('[{"id":"1"},{"email":"b@example.com"}]', async () => {
      bindController(new Ctrl(), "archive");
      setBoundTable(table);
      await current().get(dbActionRowsSlot);
    });

    const arg = findMany.mock.calls[0][0] as {
      filter: unknown;
      controls: { $select: string[] };
    };
    expect(arg.filter).toEqual({ $or: [{ id: "1" }, { email: "b@example.com" }] });
    expect(new Set(arg.controls.$select)).toEqual(new Set(["id", "email", "state"]));
  });
});
