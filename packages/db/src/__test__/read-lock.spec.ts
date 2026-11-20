import { describe, it, expect, beforeAll } from "vite-plus/test";

import { ALL_ISOLATION_LEVELS, DbError, DbSpace, type TDbErrorEntry } from "../index";
import type { DbQuery, TDbIsolationLevel, TTransactionOptions } from "../types";
import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * Locking reads (`findOne` / `findMany` / `findById` with `{ lock }`) and
 * `withTransaction(fn, { isolation })` — the engine-agnostic rules (since
 * 0.1.162). Adapter rendering is covered per adapter.
 */

let fx: typeof import("./fixtures/paging-tiebreak.as");

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/paging-tiebreak.as");
});

/** A mock with real transaction state, read locks and every isolation level. */
class LockingAdapter extends MockAdapter {
  readonly begins: Array<TTransactionOptions | undefined> = [];

  override supportsReadLocks(): boolean {
    return true;
  }

  override isolationLevels(): ReadonlySet<TDbIsolationLevel> {
    return ALL_ISOLATION_LEVELS;
  }

  protected override async _beginTransaction(opts?: TTransactionOptions): Promise<unknown> {
    this.begins.push(opts);
    return { tx: this.begins.length };
  }
}

/** A {@link LockingAdapter} whose transactions always run serializable (as SQLite's, memory's). */
class SerializableAdapter extends LockingAdapter {
  protected override _inherentIsolation(): TDbIsolationLevel {
    return "serializable";
  }
}

function setup(make: () => MockAdapter = () => new LockingAdapter()) {
  let last: MockAdapter | undefined;
  const space = new DbSpace(() => (last = make()));
  const table = space.getTable(fx.TbItem);
  return { space, table, adapter: () => last as LockingAdapter };
}

const sentQuery = (adapter: MockAdapter, method: "findOne" | "findMany"): DbQuery =>
  adapter.calls.findLast((c) => c.method === method)!.args[0] as DbQuery;

async function rejects(
  promise: Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<DbError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe(code);
  if (message) expect((error as DbError).message).toMatch(message);
  return error as DbError;
}

describe("locking reads", () => {
  it("passes the resolved lock on DbQuery.lock (default wait: block)", async () => {
    const { table, adapter } = setup();
    await adapter().withTransaction(async () => {
      await table.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" });
      expect(sentQuery(adapter(), "findOne").lock).toEqual({ mode: "update", wait: "block" });
      await table.findMany(
        { filter: {}, controls: { $sort: { id: 1 } } },
        { lock: "share", wait: "skipLocked" },
      );
      expect(sentQuery(adapter(), "findMany").lock).toEqual({ mode: "share", wait: "skipLocked" });
      await table.findById(1, { lock: "update", wait: "nowait" });
      expect(sentQuery(adapter(), "findOne").lock).toEqual({ mode: "update", wait: "nowait" });
    });
  });

  it("a plain read carries no lock", async () => {
    const { table, adapter } = setup();
    await table.findOne({ filter: { id: 1 }, controls: {} });
    await table.findMany({ filter: {}, controls: {} }, {});
    await table.findById(1);
    for (const call of adapter().calls) {
      expect((call.args[0] as DbQuery).lock).toBeUndefined();
    }
  });

  it("requires a withTransaction scope of the table's adapter", async () => {
    const { table } = setup();
    await rejects(
      table.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" }),
      "INVALID_QUERY",
      /requires a transaction/,
    );
    await rejects(table.findById(1, { lock: "share" }), "INVALID_QUERY", /requires a transaction/);
  });

  it("another adapter family's transaction does not count", async () => {
    const { table } = setup();
    const foreign = new (class extends LockingAdapter {
      protected override _transactionOwner(): unknown {
        return "foreign";
      }
    })();
    await rejects(
      foreign.withTransaction(() =>
        table.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" }),
      ),
      "INVALID_QUERY",
    );
  });

  it("a pass-through scope (no transaction primitives) counts", async () => {
    const { table, adapter } = setup(
      () =>
        new (class extends MockAdapter {
          override supportsReadLocks(): boolean {
            return true;
          }
        })(),
    );
    await adapter().withTransaction(async () => {
      expect(adapter().isInTransaction()).toBe(false);
      expect(adapter().inTransactionScope()).toBe(true);
      await table.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" });
    });
  });

  it("an adapter without supportsReadLocks() throws LOCK_NOT_SUPPORTED", async () => {
    const { table, adapter } = setup(() => new MockAdapter());
    await rejects(
      adapter().withTransaction(() =>
        table.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" }),
      ),
      "LOCK_NOT_SUPPORTED",
    );
  });

  it("rejects views, grouped / aggregate / $count reads", async () => {
    const { space, table, adapter } = setup();
    const view = space.getView(fx.TbItemKeyed);
    await adapter().withTransaction(async () => {
      await rejects(
        view.findMany({ filter: {}, controls: {} }, { lock: "update" }),
        "INVALID_QUERY",
        /tables only/,
      );
      await rejects(
        table.findMany({ filter: {}, controls: { $groupBy: ["category"] } } as any, {
          lock: "update",
        }),
        "INVALID_QUERY",
        /group, aggregate/,
      );
      await rejects(
        table.findMany(
          {
            filter: {},
            controls: { $select: [{ $fn: "sum", $field: "amount", $as: "total" }] },
          } as any,
          { lock: "update" },
        ),
        "INVALID_QUERY",
      );
      await rejects(
        table.findMany({ filter: {}, controls: { $count: true } } as any, { lock: "update" }),
        "INVALID_QUERY",
      );
    });
  });

  it("validates lock / wait values", async () => {
    const { table, adapter } = setup();
    await adapter().withTransaction(async () => {
      const q = { filter: {}, controls: {} };
      await rejects(table.findMany(q, { lock: "exclusive" as any }), "INVALID_QUERY", /lock mode/);
      await rejects(
        table.findMany(q, { lock: "update", wait: "forever" as any }),
        "INVALID_QUERY",
        /lock wait/,
      );
      await rejects(table.findMany(q, { wait: "nowait" }), "INVALID_QUERY", /requires `lock`/);
    });
  });

  it("findById with a misplaced lock fails even when the id resolves to nothing", async () => {
    const { table } = setup();
    await rejects(table.findById({} as any, { lock: "update" }), "INVALID_QUERY");
  });
});

describe("withTransaction isolation", () => {
  it("hands the level to _beginTransaction of the outermost call", async () => {
    const { adapter } = setup();
    await adapter().withTransaction(async () => {}, { isolation: "serializable" });
    await adapter().withTransaction(async () => {});
    expect(adapter().begins).toEqual([{ isolation: "serializable" }, undefined]);
  });

  it("a nested call joins when the open transaction is at least as strict", async () => {
    const { adapter } = setup();
    await adapter().withTransaction(
      async () => {
        await adapter().withTransaction(async () => {}, { isolation: "read committed" });
        await adapter().withTransaction(async () => {}, { isolation: "repeatable read" });
        await adapter().withTransaction(async () => {});
      },
      { isolation: "repeatable read" },
    );
    expect(adapter().begins).toHaveLength(1);
  });

  it("a nested call asking for a stricter level (or any level under the engine default) throws INVALID_QUERY", async () => {
    const { adapter } = setup();
    await rejects(
      adapter().withTransaction(
        () => adapter().withTransaction(async () => {}, { isolation: "serializable" }),
        { isolation: "read committed" },
      ),
      "INVALID_QUERY",
      /outermost/,
    );
    await rejects(
      adapter().withTransaction(() =>
        adapter().withTransaction(async () => {}, { isolation: "read committed" }),
      ),
      "INVALID_QUERY",
      /engine default/,
    );
  });

  it("an adapter with an inherent level satisfies every nested request", async () => {
    const { adapter } = setup(() => new SerializableAdapter());
    await adapter().withTransaction(() =>
      adapter().withTransaction(async () => {}, { isolation: "serializable" }),
    );
  });

  it("unknown level → INVALID_QUERY; unsupported level → ISOLATION_NOT_SUPPORTED", async () => {
    const { adapter } = setup();
    await rejects(
      adapter().withTransaction(async () => {}, { isolation: "snapshot" as any }),
      "INVALID_QUERY",
    );
    const plain = setup(() => new MockAdapter());
    await rejects(
      plain.adapter().withTransaction(async () => {}, { isolation: "read committed" }),
      "ISOLATION_NOT_SUPPORTED",
    );
    expect(adapter().begins).toEqual([]);
  });

  it("a failed 'atLeast' join codes its entry ISOLATION_MISMATCH (default and explicit join)", async () => {
    const { adapter } = setup();
    for (const join of [undefined, "atLeast"] as const) {
      const entry = await mismatch(
        adapter().withTransaction(
          () => adapter().withTransaction(async () => {}, { isolation: "serializable", join }),
          { isolation: "read committed" },
        ),
      );
      expect(entry).toMatchObject({
        path: "isolation",
        code: "ISOLATION_MISMATCH",
        params: { requested: "serializable", open: "read committed", join: "atLeast" },
      });
    }
    // Under the engine default the open level is unknown — `null`, not a guess.
    const entry = await mismatch(
      adapter().withTransaction(() =>
        adapter().withTransaction(async () => {}, { isolation: "read committed" }),
      ),
    );
    expect(entry.params).toEqual({ requested: "read committed", open: null, join: "atLeast" });
  });
});

/** The single entry of the `INVALID_QUERY` a failed nested `join` check throws. */
async function mismatch(promise: Promise<unknown>): Promise<TDbErrorEntry> {
  const { errors } = await rejects(promise, "INVALID_QUERY");
  expect(errors).toHaveLength(1);
  return errors[0]!;
}

/**
 * `withTransaction(fn, { isolation, join: 'same' })` (since 0.1.177): a nested
 * call joins only a transaction whose OUTERMOST call asked for exactly that
 * level. The rule compares requested levels, never the level the engine runs
 * at, so a mock with an inherent level (SQLite, memory) answers like any other
 * adapter — the point of the option: a test on those adapters catches an
 * outer call opened at the wrong level.
 */
describe("withTransaction join: 'same'", () => {
  const RC = { isolation: "read committed", join: "same" } as const;

  it("an outermost 'same' call opens the transaction at its level, like without join", async () => {
    const { adapter } = setup();
    await adapter().withTransaction(async () => {}, RC);
    expect(adapter().begins).toEqual([{ isolation: "read committed" }]);
  });

  // The same answers with and without an inherent level: 'same' compares
  // requested levels, never the level the engine runs at.
  describe.each([
    ["no inherent level", () => new LockingAdapter()],
    ["an inherent serializable level", () => new SerializableAdapter()],
  ])("on an adapter with %s", (_label, make) => {
    it("a nested 'same' call joins a transaction opened at the same level", async () => {
      const { adapter } = setup(make);
      const result = await adapter().withTransaction(
        () => adapter().withTransaction(async () => 42, RC),
        { isolation: "read committed" },
      );
      expect(result).toBe(42);
      expect(adapter().begins).toHaveLength(1);
    });

    it.each([
      // a stricter outer level — 'atLeast' would join
      ["repeatable read", "read committed"],
      // a weaker outer level
      ["read committed", "serializable"],
      // no outer level — the engine default is not "the same" as any level
      [undefined, "read committed"],
    ] as const)(
      "outer %s, nested %s with 'same' → ISOLATION_MISMATCH",
      async (outer, requested) => {
        const { adapter } = setup(make);
        const entry = await mismatch(
          adapter().withTransaction(
            () => adapter().withTransaction(async () => {}, { isolation: requested, join: "same" }),
            outer && { isolation: outer },
          ),
        );
        expect(entry).toMatchObject({ path: "isolation", code: "ISOLATION_MISMATCH" });
        expect(entry.params).toEqual({ requested, open: outer ?? null, join: "same" });
      },
    );
  });

  it("compares against the OUTERMOST call, not an intermediate nested request", async () => {
    const { adapter } = setup();
    // The middle call asks read committed and joins under 'atLeast'; the
    // transaction still runs at what the outermost call opened it with.
    const entry = await mismatch(
      adapter().withTransaction(
        () =>
          adapter().withTransaction(() => adapter().withTransaction(async () => {}, RC), {
            isolation: "read committed",
          }),
        { isolation: "repeatable read" },
      ),
    );
    expect(entry.params).toMatchObject({ open: "repeatable read" });
  });

  it("the portability case: on an inherent level 'atLeast' joins where 'same' throws", async () => {
    const { adapter } = setup(() => new SerializableAdapter());
    // the inherent serializable level satisfies read committed under no outer level…
    await adapter().withTransaction(() =>
      adapter().withTransaction(async () => {}, { isolation: "read committed" }),
    );
    // …while 'same' sees that the outer call asked for none
    const entry = await mismatch(
      adapter().withTransaction(() => adapter().withTransaction(async () => {}, RC)),
    );
    expect(entry.message).toMatch(/without a level/);
  });

  it("join without isolation, or an unknown join, is INVALID_QUERY before any transaction opens", async () => {
    const { adapter } = setup();
    await rejects(
      adapter().withTransaction(async () => {}, { join: "same" }),
      "INVALID_QUERY",
      /requires `isolation`/,
    );
    await rejects(
      adapter().withTransaction(async () => {}, {
        isolation: "read committed",
        join: "exact" as any,
      }),
      "INVALID_QUERY",
      /Unknown join mode/,
    );
    expect(adapter().begins).toEqual([]);
    // Nested: validated the same way (no silent join).
    await rejects(
      adapter().withTransaction(() => adapter().withTransaction(async () => {}, { join: "same" }), {
        isolation: "read committed",
      }),
      "INVALID_QUERY",
      /requires `isolation`/,
    );
  });
});
